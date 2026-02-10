/**
 * Fractal — Multi-project MCP Server for fractal narrative management
 *
 * Remote MCP server that Claude.ai connects to as a custom connector.
 * Streamable HTTP transport over Fastify.
 *
 * Architecture:
 *   Claude.ai  -->  HTTPS (reverse proxy)  -->  HTTP (this server, port 3001)
 *
 * Supports multiple independent projects under FRINGE_PROJECTS_ROOT.
 * Every tool (except hello and list_projects) takes a `project` parameter.
 * Each project has its own git repo with automatic commits on writes.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyRequest, FastifyReply } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import * as store from "./store.js";
import { ensureGitRepo, autoCommit, sessionCommit } from "./git.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

const projectParam = z.string().describe(
  "Project identifier (directory name under projects/), e.g. 'rust-and-flour'"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

async function withCommit<T extends store.WriteResult | store.WriteResult[]>(
  root: string,
  fn: () => Promise<T>,
  commitMessage: string
): Promise<T> {
  const result = await fn();
  const results = Array.isArray(result) ? result : [result];
  const files = results.map((r) => r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path);
  try {
    await autoCommit(root, files, commitMessage);
  } catch (err) {
    console.error(`[git-warning] Auto-commit failed for "${commitMessage}":`,
      err instanceof Error ? err.message : err);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool-level logging
// ---------------------------------------------------------------------------

function logToolCall(toolName: string, args: Record<string, unknown>) {
  const argSummary = Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const val = s && s.length > 80 ? s.slice(0, 80) + "…" : s;
      return `${k}=${val}`;
    })
    .join(", ");
  console.log(`[tool] ${toolName}(${argSummary})`);
}

function logToolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[tool-error] ${toolName}: ${message}`);
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "fractal",
    version: "1.0.0",
  });

  // ===== HELLO =====

  server.registerTool("hello", {
    title: "Hello",
    description: "Say hello. Use this to verify the MCP connector is working.",
    inputSchema: {
      name: z.string().optional().describe("Who to greet"),
    },
  }, async ({ name }) => {
    const who = name ?? "Captain";
    return textResult(`Hello from Fractal, ${who}! The connector is alive.`);
  });

  // ===== PROJECT MANAGEMENT =====

  server.registerTool("list_projects", {
    title: "List Projects",
    description: "List all available projects.",
    inputSchema: {},
  }, async () => {
    const projects = await store.listProjects();
    if (projects.length === 0) {
      return textResult("No projects found. Use create_project to start one.");
    }
    return jsonResult(projects);
  });

  server.registerTool("create_project", {
    title: "Create Project",
    description:
      "Bootstrap a new empty project with all required directories and starter files, plus git init. " +
      "Optionally pass a template to configure canon types and project guide. " +
      "Use list_templates to see available templates. Without a template, defaults to characters + locations.",
    inputSchema: {
      project: projectParam,
      title: z.string().describe("Display title for the project"),
      template: z.string().optional().describe(
        "Template ID for project setup, e.g. 'fiction-default', 'worldbuilding', 'litrpg', 'fanfic'. " +
        "Use list_templates to see available options. If omitted, uses default (characters + locations)."
      ),
    },
  }, async ({ project, title, template: templateId }) => {
    logToolCall("create_project", { project, title, template: templateId });
    try {
      let tmpl: store.ProjectTemplate | undefined;
      if (templateId) {
        tmpl = await store.loadTemplate(templateId);
      }
      const root = await store.ensureProjectStructure(project, title, tmpl);
      await ensureGitRepo(root);
      return jsonResult({
        project,
        root,
        template: templateId ?? "default",
        description: `Created project "${title}" at ${root}`,
      });
    } catch (err) {
      logToolError("create_project", err);
      throw err;
    }
  });

  server.registerTool("list_templates", {
    title: "List Templates",
    description:
      "List available project templates. Templates define which canon types " +
      "(characters, locations, factions, systems, etc.) a project starts with.",
    inputSchema: {},
  }, async () => {
    const templates = await store.listTemplates();
    if (templates.length === 0) {
      return textResult("No templates found. Projects will use the default setup (characters + locations).");
    }
    return jsonResult(templates);
  });

  server.registerTool("create_part", {
    title: "Create Part",
    description: "Create a new part directory with part.json and add it to the project's parts list. Must be called BEFORE create_chapter for this part. Workflow: create_part → create_chapter → add_beat → write_beat_prose.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      title: z.string().describe("Display title for the part"),
      summary: z.string().optional().describe("Part summary"),
      arc: z.string().optional().describe("Arc description for this part"),
    },
  }, async ({ project, part_id, title, summary, arc }) => {
    logToolCall("create_part", { project, part_id, title });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.createPart(project, part_id, title, summary ?? "", arc ?? ""),
        `Created part ${part_id}: ${title}`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("create_part", err);
      throw err;
    }
  });

  server.registerTool("create_chapter", {
    title: "Create Chapter",
    description: "Create a new chapter (prose .md + .meta.json) inside a part and add it to the part's chapters list. The part must already exist (use create_part first). The chapter starts empty — use add_beat to define beats, then write_beat_prose to fill them.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-01'"),
      title: z.string().describe("Chapter title"),
      summary: z.string().optional().describe("Chapter summary"),
      pov: z.string().optional().describe("POV character id"),
      location: z.string().optional().describe("Location id"),
      timeline_position: z.string().optional().describe("Timeline position, e.g. '1996-09-14'"),
    },
  }, async ({ project, part_id, chapter_id, title, summary, pov, location, timeline_position }) => {
    logToolCall("create_chapter", { project, part_id, chapter_id, title });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.createChapter(project, part_id, chapter_id, title, summary ?? "", pov ?? "", location ?? "", timeline_position ?? ""),
        `Created chapter ${part_id}/${chapter_id}: ${title}`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("create_chapter", err);
      throw err;
    }
  });

  // =================================================================
  // READ OPERATIONS
  // =================================================================

  server.registerTool("get_project", {
    title: "Get Project",
    description: "Returns the top-level project.json — title, logline, status, themes, parts list, canon types.",
    inputSchema: {
      project: projectParam,
    },
  }, async ({ project }) => {
    const data = await store.getProject(project);
    const canonTypesActive = await store.listCanonTypes(project);
    const root = store.projectRoot(project);
    const hasGuide = existsSync(join(root, "GUIDE.md"));
    return jsonResult({
      ...data,
      canon_types_active: canonTypesActive,
      has_guide: hasGuide,
    });
  });

  server.registerTool("get_part", {
    title: "Get Part",
    description: "Returns a part's metadata — title, summary, arc, status, chapter list.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
    },
  }, async ({ project, part_id }) => {
    const data = await store.getPart(project, part_id);
    return jsonResult(data);
  });

  server.registerTool("get_chapter_meta", {
    title: "Get Chapter Meta",
    description: "Returns a chapter's metadata — title, summary, POV, location, timeline position, beat index with statuses and summaries.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-01'"),
    },
  }, async ({ project, part_id, chapter_id }) => {
    const data = await store.getChapterMeta(project, part_id, chapter_id);
    return jsonResult(data);
  });

  server.registerTool("get_chapter_prose", {
    title: "Get Chapter Prose",
    description: "Returns the full markdown prose of a chapter, including beat markers.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-01'"),
    },
  }, async ({ project, part_id, chapter_id }) => {
    const data = await store.getChapterProse(project, part_id, chapter_id);
    const root = store.projectRoot(project);
    const relPath = `parts/${part_id}/${chapter_id}.md`;
    const { getFileVersion } = await import("./git.js");
    const version = await getFileVersion(root, relPath);
    return jsonResult({ prose: data, version });
  });

  server.registerTool("get_beat_prose", {
    title: "Get Beat Prose",
    description: "Extracts just one beat's prose from a chapter file.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier, e.g. 'b01'"),
    },
  }, async ({ project, part_id, chapter_id, beat_id }) => {
    const data = await store.getBeatProse(project, part_id, chapter_id, beat_id);
    return jsonResult(data);
  });

  server.registerTool("get_beat_variants", {
    title: "Get Beat Variants",
    description: "Returns all prose blocks for a given beat ID in a chapter. If a beat has multiple variant blocks (from append mode), this returns all of them in document order.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier, e.g. 'b01'"),
    },
  }, async ({ project, part_id, chapter_id, beat_id }) => {
    const data = await store.getBeatVariants(project, part_id, chapter_id, beat_id);
    return jsonResult(data);
  });

  server.registerTool("get_canon", {
    title: "Get Canon",
    description: "Returns a canon file (character, location, etc.) and its metadata sidecar.",
    inputSchema: {
      project: projectParam,
      type: z.string().describe("Canon type directory name, e.g. 'characters', 'locations', 'factions'. Use get_project to see active types."),
      id: z.string().describe("Canon entry id, e.g. 'unit-7', 'the-bakery'"),
    },
  }, async ({ project, type, id }) => {
    const data = await store.getCanon(project, type, id);
    return jsonResult(data);
  });

  server.registerTool("list_canon", {
    title: "List Canon",
    description: "Lists all canon entries of a given type.",
    inputSchema: {
      project: projectParam,
      type: z.string().describe("Canon type directory name, e.g. 'characters', 'locations', 'factions'. Use get_project to see active types."),
    },
  }, async ({ project, type }) => {
    const entries = await store.listCanon(project, type);
    return jsonResult(entries);
  });

  server.registerTool("get_scratch_index", {
    title: "Get Scratch Index",
    description: "Returns the scratch folder index — loose scenes, dialogue riffs, ideas that don't have a home yet.",
    inputSchema: {
      project: projectParam,
    },
  }, async ({ project }) => {
    const data = await store.getScratchIndex(project);
    return jsonResult(data);
  });

  server.registerTool("get_scratch", {
    title: "Get Scratch",
    description: "Returns the content of a scratch file.",
    inputSchema: {
      project: projectParam,
      filename: z.string().describe("Scratch filename, e.g. 'unit7-dream-sequence.md'"),
    },
  }, async ({ project, filename }) => {
    const data = await store.getScratch(project, filename);
    return textResult(data);
  });

  server.registerTool("search", {
    title: "Search",
    description: "Full-text search across prose, canon, and scratch files. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      project: projectParam,
      query: z.string().describe("Search query (case-insensitive)"),
      scope: z.enum(["prose", "canon", "scratch"]).optional().describe("Limit search to a specific scope"),
    },
  }, async ({ project, query, scope }) => {
    const results = await store.search(project, query, scope);
    if (results.length === 0) {
      return textResult(`No results for "${query}"`);
    }
    const formatted = results
      .slice(0, 50)
      .map((r) => `${r.file}:${r.line}: ${r.text}`)
      .join("\n");
    return textResult(`${results.length} result(s) for "${query}":\n\n${formatted}`);
  });

  server.registerTool("get_dirty_nodes", {
    title: "Get Dirty Nodes",
    description: "Returns all nodes with status 'dirty' or 'conflict', with reasons. Use this to triage what needs review.",
    inputSchema: {
      project: projectParam,
    },
  }, async ({ project }) => {
    const nodes = await store.getDirtyNodes(project);
    if (nodes.length === 0) {
      return textResult("All clean. No dirty or conflicted nodes.");
    }
    return jsonResult(nodes);
  });

  server.registerTool("get_context", {
    title: "Get Context",
    description:
      "Batch read that returns a bundle of project data in one call. " +
      "Pass a shopping list of canon IDs, beat refs, scratch filenames, etc. " +
      "Use this instead of multiple individual get_ calls. " +
      "Partial failure — missing items go to errors, everything else returns normally.",
    inputSchema: {
      project: projectParam,
      include: z.object({
        canon: z.array(z.string()).optional().describe("Canon IDs to load, e.g. ['unit-7', 'the-bakery']. Type is inferred by scanning canon directories."),
        scratch: z.array(z.string()).optional().describe("Scratch filenames, e.g. ['voice-codex.md']"),
        parts: z.array(z.string()).optional().describe("Part IDs, e.g. ['part-01']"),
        chapter_meta: z.array(z.string()).optional().describe("Chapter refs, e.g. ['part-01/chapter-03']"),
        chapter_prose: z.array(z.string()).optional().describe("Full chapter prose refs, e.g. ['part-01/chapter-03']"),
        beats: z.array(z.string()).optional().describe("Beat refs, e.g. ['part-01/chapter-03:b01']"),
        beat_variants: z.array(z.string()).optional().describe("Beat refs for variant listing, e.g. ['part-01/chapter-03:b03']"),
        dirty_nodes: z.boolean().optional().describe("Include all dirty/conflict nodes"),
        project_meta: z.boolean().optional().describe("Include top-level project metadata"),
        guide: z.boolean().optional().describe("Include GUIDE.md content from project root"),
      }).describe("What to include. Every key is optional. Request exactly what you need."),
    },
  }, async ({ project, include }) => {
    const data = await store.getContext(project, include);
    return jsonResult(data);
  });

  // =================================================================
  // WRITE OPERATIONS
  // =================================================================

  server.registerTool("update_project", {
    title: "Update Project",
    description: "Update top-level project metadata. Provide only the fields you want to change — others are preserved.",
    inputSchema: {
      project: projectParam,
      patch: z.object({
        title: z.string().optional().describe("Project title"),
        subtitle: z.string().nullable().optional().describe("Project subtitle"),
        logline: z.string().optional().describe("One-sentence story summary"),
        status: z.string().optional().describe("e.g. 'planning', 'in-progress', 'complete'"),
        themes: z.array(z.string()).optional().describe("Thematic threads being tracked"),
        parts: z.array(z.string()).optional().describe("Ordered part IDs, e.g. ['part-01', 'part-02']"),
        canon_types: z.array(z.object({
          id: z.string().describe("Canon type directory name, e.g. 'factions'"),
          label: z.string().describe("Display label, e.g. 'Factions'"),
          description: z.string().describe("What this canon type contains"),
        })).optional().describe("Canon type definitions. Updates metadata only — use update_canon with the new type to create entries."),
      }).describe("Fields to update in project.json. Only include fields you want to change."),
    },
  }, async ({ project, patch }) => {
    logToolCall("update_project", { project, keys: Object.keys(patch) });
    try {
      const root = store.projectRoot(project);
      const result = await withCommit(
        root,
        () => store.updateProject(project, patch),
        `Updated project: ${Object.keys(patch).join(", ")}`
      );
      return jsonResult(result);
    } catch (err) {
      logToolError("update_project", err);
      throw err;
    }
  });

  server.registerTool("update_part", {
    title: "Update Part",
    description: "Update an existing part's metadata. The part must already exist — use create_part for new parts, not update_part. Provide only the fields you want to change.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      patch: z.object({
        title: z.string().optional().describe("Part title"),
        summary: z.string().optional().describe("Part summary"),
        arc: z.string().optional().describe("Arc description"),
        status: z.string().optional().describe("'planning', 'clean', 'dirty', 'conflict'"),
        chapters: z.array(z.string()).optional().describe("Ordered chapter IDs"),
      }).describe("Fields to update in part.json. Only include fields you want to change."),
    },
  }, async ({ project, part_id, patch }) => {
    logToolCall("update_part", { project, part_id, keys: Object.keys(patch) });
    try {
      const root = store.projectRoot(project);
      const result = await withCommit(
        root,
        () => store.updatePart(project, part_id, patch),
        `Updated ${part_id}: ${Object.keys(patch).join(", ")}`
      );
      return jsonResult(result);
    } catch (err) {
      logToolError("update_part", err);
      throw err;
    }
  });

  server.registerTool("update_chapter_meta", {
    title: "Update Chapter Meta",
    description: "Update a chapter's metadata. The chapter must already exist — use create_chapter first. When updating beats, provide an array with just the beats to change (matched by id); unlisted beats are untouched.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      patch: z.object({
        title: z.string().optional().describe("Chapter title"),
        summary: z.string().optional().describe("Chapter summary"),
        pov: z.string().optional().describe("POV character id"),
        location: z.string().optional().describe("Location id"),
        timeline_position: z.string().optional().describe("e.g. '1996-09-14'"),
        status: z.string().optional().describe("'planning', 'clean', 'dirty', 'conflict'"),
        beats: z.array(z.object({
          id: z.string().describe("Beat identifier, e.g. 'b01'"),
          label: z.string().optional().describe("Short beat label"),
          summary: z.string().optional().describe("Beat summary"),
          status: z.string().optional().describe("'planned', 'written', 'dirty', 'conflict'"),
          dirty_reason: z.string().nullable().optional().describe("Why this beat needs review"),
          characters: z.array(z.string()).optional().describe("Character IDs"),
          depends_on: z.array(z.string()).optional().describe("e.g. ['chapter-01:b02']"),
          depended_by: z.array(z.string()).optional().describe("Beat refs that depend on this"),
        })).optional().describe("Beats to merge by ID. Unlisted beats are untouched."),
      }).describe("Fields to update. Only include fields you want to change."),
    },
  }, async ({ project, part_id, chapter_id, patch }) => {
    logToolCall("update_chapter_meta", { project, part_id, chapter_id, keys: Object.keys(patch) });
    try {
      const root = store.projectRoot(project);
      const result = await withCommit(
        root,
        () => store.updateChapterMeta(project, part_id, chapter_id, patch as Partial<store.ChapterMeta>),
        `Updated ${part_id}/${chapter_id} meta: ${Object.keys(patch).join(", ")}`
      );
      return jsonResult(result);
    } catch (err) {
      logToolError("update_chapter_meta", err);
      throw err;
    }
  });

  server.registerTool("write_beat_prose", {
    title: "Write Beat Prose",
    description: "Insert or replace the prose content for a specific beat in a chapter. The beat must already exist (use add_beat first). With append=true, adds a new variant block after the existing one(s) instead of replacing.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      content: z.string().describe("The prose content for this beat"),
      append: z.boolean().optional().describe(
        "If true, append as a new variant block after existing block(s) for this beat. " +
        "If false (default), replace the first existing block."
      ),
    },
  }, async ({ project, part_id, chapter_id, beat_id, content, append }) => {
    logToolCall("write_beat_prose", { project, part_id, chapter_id, beat_id, append, content });
    try {
      const root = store.projectRoot(project);
      const result = await withCommit(
        root,
        () => store.writeBeatProse(project, part_id, chapter_id, beat_id, content, append ?? false),
        `${append ? "Appended variant to" : "Updated"} ${part_id}/${chapter_id} beat ${beat_id} prose`
      );
      return jsonResult(result);
    } catch (err) {
      logToolError("write_beat_prose", err);
      throw err;
    }
  });

  server.registerTool("edit_beat_prose", {
    title: "Edit Beat Prose",
    description:
      "Surgical string replacement within a beat's prose. " +
      "Supports multiple ordered find/replace pairs, applied atomically — if any edit fails, none are applied. " +
      "Use this instead of write_beat_prose when changing words or sentences rather than rewriting the whole beat.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      edits: z.array(z.object({
        old_str: z.string().describe("Exact text to find (must match exactly once within the beat)"),
        new_str: z.string().describe("Replacement text (empty string = deletion)"),
      })).describe("Ordered list of find/replace pairs. Applied sequentially — edit 2 sees the result of edit 1."),
      variant_index: z.number().optional().describe("Which variant to edit (default: 0 = first/only block)"),
    },
  }, async ({ project, part_id, chapter_id, beat_id, edits, variant_index }) => {
    logToolCall("edit_beat_prose", { project, part_id, chapter_id, beat_id, edits_count: edits.length });
    try {
      const root = store.projectRoot(project);
      const outcome = await store.editBeatProse(
        project, part_id, chapter_id, beat_id, edits, variant_index ?? 0
      );
      const files = [outcome.result.path.startsWith(root)
        ? outcome.result.path.slice(root.length + 1) : outcome.result.path];
      try {
        await autoCommit(root, files,
          `Edited ${part_id}/${chapter_id}:${beat_id} (${outcome.edits_applied} edits)`);
      } catch (err) {
        console.error(`[git-warning] Auto-commit failed:`, err instanceof Error ? err.message : err);
      }
      return jsonResult(outcome);
    } catch (err) {
      logToolError("edit_beat_prose", err);
      throw err;
    }
  });

  server.registerTool("add_beat", {
    title: "Add Beat",
    description: "Add a new beat to a chapter's structure (both the markdown marker and the meta entry). The chapter must already exist — use create_chapter first. After adding, use write_beat_prose to write its content.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat: z.object({
        id: z.string().describe("Beat identifier, e.g. 'b01'"),
        label: z.string().describe("Short label, e.g. 'Unit 7 opens the bakery'"),
        summary: z.string().describe("What happens in this beat"),
        status: z.string().optional().describe("Default: 'planned'. Values: 'planned', 'written', 'dirty', 'conflict'"),
        dirty_reason: z.string().nullable().optional().describe("Reason if dirty. Usually null for new beats."),
        characters: z.array(z.string()).optional().describe("Character IDs, e.g. ['unit-7', 'marguerite']"),
        depends_on: z.array(z.string()).optional().describe("Beat refs this depends on, e.g. ['chapter-01:b02']"),
        depended_by: z.array(z.string()).optional().describe("Beat refs that depend on this"),
      }).describe("Beat definition. Required: id, label, summary. Others have sensible defaults."),
      after_beat_id: z.string().optional().describe("Insert after this beat ID. If omitted, appends to end."),
    },
  }, async ({ project, part_id, chapter_id, beat, after_beat_id }) => {
    logToolCall("add_beat", { project, part_id, chapter_id, beat_id: beat.id, after_beat_id });
    try {
      const beatDef: store.BeatMeta = {
        id: beat.id,
        label: beat.label,
        summary: beat.summary,
        status: beat.status ?? "planned",
        dirty_reason: beat.dirty_reason ?? null,
        characters: beat.characters ?? [],
        depends_on: beat.depends_on ?? [],
        depended_by: beat.depended_by ?? [],
      };
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.addBeat(project, part_id, chapter_id, beatDef, after_beat_id),
        `Added beat ${beatDef.id} to ${part_id}/${chapter_id}`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("add_beat", err);
      throw err;
    }
  });

  server.registerTool("remove_beat", {
    title: "Remove Beat",
    description: "Remove a beat from a chapter. All prose blocks (including variants) are moved to scratch for safekeeping.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier to remove"),
    },
  }, async ({ project, part_id, chapter_id, beat_id }) => {
    logToolCall("remove_beat", { project, part_id, chapter_id, beat_id });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.removeBeat(project, part_id, chapter_id, beat_id),
        `Removed beat ${beat_id} from ${part_id}/${chapter_id} (prose → scratch)`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("remove_beat", err);
      throw err;
    }
  });

  server.registerTool("select_beat_variant", {
    title: "Select Beat Variant",
    description: "Pick one variant of a beat as the winner, archive the rest to scratch. Use get_beat_variants first to see all variants and decide which to keep.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      keep_index: z.number().describe("Zero-based index of the variant to keep (from get_beat_variants)"),
    },
  }, async ({ project, part_id, chapter_id, beat_id, keep_index }) => {
    logToolCall("select_beat_variant", { project, part_id, chapter_id, beat_id, keep_index });
    try {
      const root = store.projectRoot(project);
      const outcome = await store.selectBeatVariant(project, part_id, chapter_id, beat_id, keep_index);
      // Manual commit since outcome has fields beyond WriteResult[]
      const files = outcome.results.map((r) =>
        r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path
      );
      if (files.length > 0) {
        try {
          await autoCommit(root, files, `Selected variant ${keep_index} for ${part_id}/${chapter_id}:${beat_id}`);
        } catch (err) {
          console.error(`[git-warning] Auto-commit failed:`, err instanceof Error ? err.message : err);
        }
      }
      return jsonResult({ kept: outcome.kept, archived: outcome.archived, files: outcome.results });
    } catch (err) {
      logToolError("select_beat_variant", err);
      throw err;
    }
  });

  server.registerTool("reorder_beats", {
    title: "Reorder Beats",
    description: "Reorder beats within a chapter. Provide the complete new ordering of beat IDs. Both the meta and prose files are updated. Variant blocks for each beat stay grouped in their original internal order.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_order: z.array(z.string()).describe("Complete list of beat IDs in the desired new order. Must contain every beat ID exactly once."),
    },
  }, async ({ project, part_id, chapter_id, beat_order }) => {
    logToolCall("reorder_beats", { project, part_id, chapter_id, beat_order });
    try {
      const root = store.projectRoot(project);
      const outcome = await store.reorderBeats(project, part_id, chapter_id, beat_order);
      // Manual commit since outcome has fields beyond WriteResult[]
      const files = outcome.results.map((r) =>
        r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path
      );
      try {
        await autoCommit(root, files, `Reordered beats in ${part_id}/${chapter_id}: ${beat_order.join(", ")}`);
      } catch (err) {
        console.error(`[git-warning] Auto-commit failed:`, err instanceof Error ? err.message : err);
      }
      return jsonResult({ previous_order: outcome.previous_order, new_order: outcome.new_order, files: outcome.results });
    } catch (err) {
      logToolError("reorder_beats", err);
      throw err;
    }
  });

  server.registerTool("mark_dirty", {
    title: "Mark Dirty",
    description: "Flag a node (part, chapter, or beat) as needing review due to upstream changes.",
    inputSchema: {
      project: projectParam,
      node_ref: z.string().describe("Node reference, e.g. 'part-01', 'part-01/chapter-02', 'part-01/chapter-02:b03'"),
      reason: z.string().describe("Why this node is dirty, e.g. 'marguerite.md canon updated: backstory changed'"),
    },
  }, async ({ project, node_ref, reason }) => {
    logToolCall("mark_dirty", { project, node_ref, reason });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.markDirty(project, node_ref, reason),
        `Marked ${node_ref} dirty (${reason})`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("mark_dirty", err);
      throw err;
    }
  });

  server.registerTool("mark_clean", {
    title: "Mark Clean",
    description: "Clear dirty status after reviewing a node.",
    inputSchema: {
      project: projectParam,
      node_ref: z.string().describe("Node reference to mark clean"),
    },
  }, async ({ project, node_ref }) => {
    logToolCall("mark_clean", { project, node_ref });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.markClean(project, node_ref),
        `Marked ${node_ref} clean`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("mark_clean", err);
      throw err;
    }
  });

  server.registerTool("update_canon", {
    title: "Update Canon",
    description: "Create or rewrite a canon file (character, location, etc.).",
    inputSchema: {
      project: projectParam,
      type: z.string().describe("Canon type directory name, e.g. 'characters', 'locations', 'factions'. Use get_project to see active types."),
      id: z.string().describe("Canon entry id"),
      content: z.string().describe("Full markdown content for the canon file"),
      meta: z.object({
        id: z.string().optional().describe("Canon entry id"),
        type: z.string().optional().describe("e.g. 'character', 'location'"),
        role: z.string().optional().describe("e.g. 'protagonist', 'mentor', 'antagonist'"),
        appears_in: z.array(z.string()).optional().describe("Beat refs, e.g. ['part-01/chapter-01:b01']"),
        last_updated: z.string().optional().describe("ISO timestamp"),
        updated_by: z.string().optional().describe("e.g. 'claude-conversation'"),
      }).passthrough().optional().describe("Optional metadata for the .meta.json sidecar"),
    },
  }, async ({ project, type, id, content, meta }) => {
    logToolCall("update_canon", { project, type, id });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.updateCanon(project, type, id, content, meta),
        `Canon update: ${type}/${id}.md`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("update_canon", err);
      throw err;
    }
  });

  server.registerTool("add_scratch", {
    title: "Add Scratch",
    description: "Add a new file to the scratch folder (loose scenes, ideas, dialogue riffs).",
    inputSchema: {
      project: projectParam,
      filename: z.string().describe("Filename for the scratch file, e.g. 'unit7-dream-sequence.md'"),
      content: z.string().describe("Content of the scratch file"),
      note: z.string().describe("Note about what this is and where it might go"),
      characters: z.array(z.string()).optional().describe("Characters involved"),
      mood: z.string().optional().describe("Mood/tone description"),
      potential_placement: z.string().optional().describe("Where this might end up, e.g. 'part-01/chapter-04'"),
    },
  }, async ({ project, filename, content, note, characters, mood, potential_placement }) => {
    logToolCall("add_scratch", { project, filename, note });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.addScratch(project, filename, content, note, characters ?? [], mood ?? "", potential_placement ?? null),
        `Added scratch: ${filename}`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("add_scratch", err);
      throw err;
    }
  });

  server.registerTool("promote_scratch", {
    title: "Promote Scratch",
    description: "Move a scratch file's content into a beat in the narrative structure.",
    inputSchema: {
      project: projectParam,
      filename: z.string().describe("Scratch filename to promote"),
      target_part_id: z.string().describe("Target part identifier"),
      target_chapter_id: z.string().describe("Target chapter identifier"),
      target_beat_id: z.string().describe("Target beat identifier"),
    },
  }, async ({ project, filename, target_part_id, target_chapter_id, target_beat_id }) => {
    logToolCall("promote_scratch", { project, filename, target_part_id, target_chapter_id, target_beat_id });
    try {
      const root = store.projectRoot(project);
      const results = await withCommit(
        root,
        () => store.promoteScratch(project, filename, target_part_id, target_chapter_id, target_beat_id),
        `Promoted scratch/${filename} → ${target_part_id}/${target_chapter_id}:${target_beat_id}`
      );
      return jsonResult(results);
    } catch (err) {
      logToolError("promote_scratch", err);
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Annotation tools
  // -----------------------------------------------------------------------

  server.registerTool("get_notes", {
    title: "Get Notes",
    description:
      "Scan prose files for inline annotations (@note, @dev, @line, @continuity, @query, @flag). " +
      "Returns structured notes with location context and surrounding prose lines, plus a summary with counts by type and author. " +
      "Scope can be a part, chapter, or beat reference to narrow the scan.",
    inputSchema: {
      project: projectParam,
      scope: z.string().optional().describe(
        "Scope filter: 'part-01' (all chapters in part), 'part-01/chapter-03' (one chapter), or 'part-01/chapter-03:b02' (one beat). Omit to scan entire project."
      ),
      type: z.enum(["note", "dev", "line", "continuity", "query", "flag"]).optional().describe(
        "Filter by annotation type"
      ),
      author: z.enum(["human", "claude"]).optional().describe(
        "Filter by author"
      ),
    },
  }, async ({ project, scope, type, author }) => {
    const data = await store.getAnnotations(project, scope, type, author);
    if (data.notes.length === 0) {
      return textResult("No annotations found" + (scope ? ` in ${scope}` : "") + ".");
    }
    return jsonResult(data);
  });

  server.registerTool("add_note", {
    title: "Add Note",
    description:
      "Insert an inline annotation in a chapter's prose, anchored after a specific line number. " +
      "Author is automatically set to 'claude'. The annotation is an HTML comment invisible in rendered markdown. " +
      "Optionally pass a version token (from get_notes or a previous add_note) for line-number translation if the file changed.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-03'"),
      line_number: z.number().describe("Line number to insert annotation after (1-based)"),
      type: z.enum(["note", "dev", "line", "continuity", "query", "flag"]).describe(
        "Annotation type: 'note' (general), 'dev' (structural), 'line' (prose craft), 'continuity' (consistency), 'query' (question), 'flag' (wordless marker)"
      ),
      message: z.string().optional().describe(
        "The annotation message. Required for all types except 'flag'."
      ),
      version: z.string().optional().describe(
        "Version token from get_notes or previous add_note. If the file changed since this version, line numbers are translated automatically. Omit on first insert."
      ),
    },
  }, async ({ project, part_id, chapter_id, line_number, type, message, version }) => {
    logToolCall("add_note", { project, part_id, chapter_id, line_number, type });
    try {
      if (type !== "flag" && !message) {
        throw new Error(`Message is required for @${type} annotations.`);
      }
      const root = store.projectRoot(project);
      const result = await store.insertAnnotation(
        project, part_id, chapter_id, line_number,
        type as "note" | "dev" | "line" | "continuity" | "query" | "flag",
        message ?? null, "claude", version
      );

      // Commit the modified file
      const relPath = result.path.startsWith(root)
        ? result.path.slice(root.length + 1)
        : result.path;
      try {
        await autoCommit(root, [relPath],
          `Added @${type}(claude) annotation to ${part_id}/${chapter_id}`);
      } catch (err) {
        console.error(`[git-warning] Auto-commit failed:`,
          err instanceof Error ? err.message : err);
      }

      // Get post-commit version
      const { getFileVersion } = await import("./git.js");
      const newVersion = await getFileVersion(root, relPath);

      return jsonResult({
        id: result.id,
        inserted_after_line: result.inserted_after_line,
        location: `${part_id}/${chapter_id}`,
        version: newVersion,
      });
    } catch (err) {
      logToolError("add_note", err);
      throw err;
    }
  });

  server.registerTool("resolve_note", {
    title: "Resolve Note",
    description:
      "Remove a single inline annotation from a prose file after it's been addressed. " +
      "Pass the note ID from get_notes. The annotation line is deleted from the markdown. Git remembers it. " +
      "Note: resolving one note shifts line numbers, making other note IDs from the same get_notes call stale. " +
      "Either batch-resolve with resolve_notes, or re-read with get_notes between individual resolves.",
    inputSchema: {
      project: projectParam,
      note_id: z.string().describe(
        "Note ID to resolve, e.g. 'part-01/chapter-03:b02:n47'. Get this from get_notes."
      ),
    },
  }, async ({ project, note_id }) => {
    logToolCall("resolve_note", { project, note_id });
    try {
      const root = store.projectRoot(project);
      const results = await store.removeAnnotationLines(project, [note_id]);
      const files = results.map((r) =>
        r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path
      );
      if (files.length > 0) {
        try {
          await autoCommit(root, files, `Resolved annotation ${note_id}`);
        } catch (err) {
          console.error(`[git-warning] Auto-commit failed:`,
            err instanceof Error ? err.message : err);
        }
      }
      return jsonResult({ resolved: 1, note_id });
    } catch (err) {
      logToolError("resolve_note", err);
      throw err;
    }
  });

  server.registerTool("resolve_notes", {
    title: "Resolve Notes",
    description:
      "Batch-remove multiple inline annotations from prose files after they've been addressed. " +
      "Pass note IDs from get_notes.",
    inputSchema: {
      project: projectParam,
      note_ids: z.array(z.string()).describe(
        "Note IDs to resolve, e.g. ['part-01/chapter-03:b02:n47']. Get these from get_notes."
      ),
    },
  }, async ({ project, note_ids }) => {
    logToolCall("resolve_notes", { project, count: note_ids.length });
    try {
      if (note_ids.length === 0) {
        return textResult("No note IDs provided. Nothing to resolve.");
      }
      const root = store.projectRoot(project);
      const results = await store.removeAnnotationLines(project, note_ids);
      const files = results.map((r) =>
        r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path
      );
      if (files.length > 0) {
        try {
          await autoCommit(root, files,
            `Resolved ${note_ids.length} annotation(s)`);
        } catch (err) {
          console.error(`[git-warning] Auto-commit failed:`,
            err instanceof Error ? err.message : err);
        }
      }
      return jsonResult({ resolved: note_ids.length, files_modified: results.length });
    } catch (err) {
      logToolError("resolve_notes", err);
      throw err;
    }
  });

  // -----------------------------------------------------------------------
  // Session tools
  // -----------------------------------------------------------------------

  server.registerTool("session_summary", {
    title: "Session Summary",
    description: "Create a session-level git commit summarizing what was done in this working session.",
    inputSchema: {
      project: projectParam,
      message: z.string().describe("Summary of what was accomplished in this session"),
    },
  }, async ({ project, message }) => {
    logToolCall("session_summary", { project, message });
    try {
      const root = store.projectRoot(project);
      const hash = await sessionCommit(root, message);
      if (hash) {
        return textResult(`Session commit created: ${hash} — ${message}`);
      }
      return textResult("Nothing to commit — no changes since last commit.");
    } catch (err) {
      logToolError("session_summary", err);
      throw err;
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------

const app = Fastify({ logger: true });

// --- JSON body parser (lenient for empty DELETE bodies) ---
app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  try {
    done(null, body ? JSON.parse(body as string) : null);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// --- CORS ---
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
  exposedHeaders: ["mcp-session-id"],
});

// --- CORS on raw/hijacked responses ---
app.addHook("onRequest", (request, reply, done) => {
  const origin = request.headers.origin;
  if (origin) {
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id, Last-Event-ID, mcp-protocol-version");
    reply.raw.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  }
  done();
});

// --- Health check ---
app.get("/health", async () => {
  const projects = await store.listProjects();
  return { status: "ok", projects_root: store.getProjectsRoot(), test_projects_root: store.getTestProjectsRoot(), projects };
});

// --- Help endpoint ---
app.get("/help", async () => {
  return {
    name: "Fractal",
    description: "Fractal narrative MCP server (multi-project)",
    projects_root: store.getProjectsRoot(),
    note: "All tools except hello and list_projects require a 'project' parameter.",
    tools: {
      management: {
        hello: "Proof-of-life greeting to verify the connector is working.",
        list_projects: "List all available projects (id, title, status).",
        create_project: "Bootstrap a new project with all directories and starter files.",
        create_part: "Create a new part directory with part.json, add to project parts list.",
        create_chapter: "Create a new chapter (.md + .meta.json) inside a part, add to part chapters list.",
      },
      read: {
        get_project: "Top-level project metadata: title, logline, status, themes, parts list.",
        get_part: "Part metadata: title, summary, arc, status, chapter list.",
        get_chapter_meta: "Chapter metadata: title, summary, POV, location, timeline, beat index with statuses.",
        get_chapter_prose: "Full markdown prose of a chapter, including beat markers and variants. Returns {prose, version}.",
        get_beat_prose: "Extract a single beat's prose (first block only if variants exist).",
        get_beat_variants: "Returns all prose blocks (variants) for a beat ID, in document order.",
        get_canon: "A canon file (character, location) and its metadata sidecar.",
        list_canon: "List all canon entries of a given type (characters, locations).",
        get_scratch_index: "Index of the scratch folder — loose scenes, dialogue, ideas.",
        get_scratch: "Content of a specific scratch file.",
        search: "Full-text search across prose, canon, and scratch files.",
        get_dirty_nodes: "All nodes flagged dirty or conflict, with reasons. Use for triage.",
        get_context: "Batch read — canon, scratch, parts, chapters, beats, variants, dirty nodes in one call.",
      },
      write: {
        update_project: "Patch top-level project metadata.",
        update_part: "Patch a part's metadata (title, summary, arc, status, chapters).",
        update_chapter_meta: "Patch chapter metadata — beat summaries, status, dependencies.",
        write_beat_prose: "Insert or replace prose for a beat. With append=true, adds a variant block.",
        edit_beat_prose: "Surgical str_replace within a beat's prose. Atomic, ordered edits.",
        add_beat: "Add a new beat to a chapter (markdown marker + meta entry).",
        remove_beat: "Remove a beat (all variant blocks) from a chapter. Prose moved to scratch.",
        select_beat_variant: "Keep one variant of a beat, archive the rest to scratch.",
        reorder_beats: "Reorder beats within a chapter (meta and prose). Variants stay grouped.",
        mark_dirty: "Flag a node as needing review, with a reason.",
        mark_clean: "Clear dirty status after reviewing a node.",
        update_canon: "Create or rewrite a canon file (character, location, etc.).",
        add_scratch: "Add a new file to the scratch folder.",
        promote_scratch: "Move scratch content into a beat in the narrative structure.",
      },
      annotations: {
        get_notes: "Scan prose for inline annotations. Filter by scope, type, author. Returns version hashes.",
        add_note: "Insert annotation after a line number. Optionally pass version for line translation. Author: claude.",
        resolve_note: "Remove a single annotation after it's been addressed.",
        resolve_notes: "Batch-remove multiple annotations.",
      },
      session: {
        session_summary: "Create a session-level git commit summarizing the working session.",
      },
    },
    architecture: {
      structure: "projects/{project}/ — project.json, parts/{part}/chapter-NN.md + .meta.json, canon/, scratch/",
      beats: "HTML comments in markdown: <!-- beat:ID | label -->. Invisible in preview, parseable by tools.",
      versioning: "Every write auto-commits to the project's git repo with [auto] prefix.",
      ejectability: "Without this tool, each project is a folder of markdown files, JSON sidecars, and a git repo.",
    },
  };
});

// ---------------------------------------------------------------------------
// MCP endpoint — POST /mcp
// ---------------------------------------------------------------------------

app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId && transports[sessionId]) {
      const transport = transports[sessionId]!;
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack();
    }

    if (!sessionId && isInitializeRequest(request.body)) {
      const eventStore = new InMemoryEventStore();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport;
          request.log.info(`Session initialized: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          request.log.info(`Session closed: ${sid}`);
          delete transports[sid];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack();
    }

    reply.code(400).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  } catch (error) {
    request.log.error(error, "Error handling MCP POST request");
    if (!reply.raw.headersSent) {
      reply.code(500).send({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// MCP endpoint — GET /mcp
// ---------------------------------------------------------------------------

app.get("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    reply.code(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId]!;
  await transport.handleRequest(request.raw, reply.raw);
  return reply.hijack();
});

// ---------------------------------------------------------------------------
// MCP endpoint — DELETE /mcp
// ---------------------------------------------------------------------------

app.delete("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    reply.code(400).send("Invalid or missing session ID");
    return;
  }

  request.log.info(`Session termination requested: ${sessionId}`);
  const transport = transports[sessionId]!;
  await transport.handleRequest(request.raw, reply.raw);
  return reply.hijack();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  try {
    const projectsRoot = store.getProjectsRoot();
    const testRoot = store.getTestProjectsRoot();
    for (const dir of [projectsRoot, testRoot]) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }

    // Ensure git repos for all existing projects
    const projects = await store.listProjects();
    for (const p of projects) {
      await ensureGitRepo(store.projectRoot(p.id));
    }

    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\nFractal MCP server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Health check: http://localhost:${PORT}/health`);
    console.log(`  Help:         http://localhost:${PORT}/help`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Projects:     ${projectsRoot}`);
    console.log(`  Test:         ${testRoot}`);
    console.log(`  Loaded:       ${projects.map((p) => p.id).join(", ") || "(none)"}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid]!.close();
      delete transports[sid];
    } catch (err) {
      console.error(`Error closing session ${sid}:`, err);
    }
  }
  process.exit(0);
});

main();
