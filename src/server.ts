/**
 * Fractal — Multi-project MCP Server for fractal narrative management
 *
 * Remote MCP server that Claude.ai connects to as a custom connector.
 * Streamable HTTP transport over Fastify.
 *
 * Architecture:
 *   Claude.ai  -->  HTTPS (reverse proxy)  -->  HTTP (this server, port 3001)
 *
 * Supports multiple independent projects under FRACTAL_PROJECTS_ROOT.
 * Every tool (except list_projects and list_templates) takes a `project` parameter.
 * Each project has its own git repo with automatic commits on writes.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import * as store from "./store.js";
import { ensureGitRepo, autoCommit, sessionCommit } from "./git.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const SESSION_TTL_MS = parseInt(process.env["SESSION_TTL_MS"] ?? String(30 * 60 * 1000), 10);
const REAPER_INTERVAL_MS = parseInt(process.env["REAPER_INTERVAL_MS"] ?? "60000", 10);

// Auth / OIDC config (all optional — unset = auth disabled)
const OIDC_ISSUER_URL = process.env["OIDC_ISSUER_URL"] ?? null;
const OIDC_AUDIENCE = process.env["OIDC_AUDIENCE"] ?? null;
const FRACTAL_PUBLIC_URL = process.env["FRACTAL_PUBLIC_URL"] ?? null;
const OIDC_CLIENT_ID = process.env["OIDC_CLIENT_ID"] ?? null;
const OIDC_CLIENT_SECRET = process.env["OIDC_CLIENT_SECRET"] ?? null;

// ---------------------------------------------------------------------------
// OIDC / Auth
// ---------------------------------------------------------------------------

interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let oidcConfig: OidcConfig | null = null;
let jwksKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;

async function initializeOidc(): Promise<void> {
  if (!OIDC_ISSUER_URL) {
    console.log("[auth] OIDC_ISSUER_URL not set — authentication disabled");
    return;
  }

  // Attempt OIDC discovery
  const discoveryUrls = [
    `${OIDC_ISSUER_URL}/.well-known/openid-configuration`,
    `${OIDC_ISSUER_URL}/webman/sso/.well-known/openid-configuration`,
  ];

  for (const url of discoveryUrls) {
    try {
      console.log(`[auth] Trying OIDC discovery: ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const d = (await res.json()) as Record<string, unknown>;
        oidcConfig = {
          issuer: (d.issuer as string) || OIDC_ISSUER_URL,
          authorization_endpoint: d.authorization_endpoint as string,
          token_endpoint: d.token_endpoint as string,
          jwks_uri: d.jwks_uri as string,
        };
        console.log("[auth] OIDC discovery succeeded");
        break;
      }
    } catch (err) {
      console.warn(`[auth] Discovery failed for ${url}:`, err instanceof Error ? err.message : err);
    }
  }

  // Fall back to well-known Synology paths
  if (!oidcConfig) {
    oidcConfig = {
      issuer: OIDC_ISSUER_URL,
      authorization_endpoint: `${OIDC_ISSUER_URL}/webman/sso/SSOOauth.cgi`,
      token_endpoint: `${OIDC_ISSUER_URL}/webman/sso/SSOAccessToken.cgi`,
      jwks_uri: `${OIDC_ISSUER_URL}/webman/sso/openid-jwks.json`,
    };
    console.log("[auth] Using fallback Synology OIDC endpoints");
  }

  jwksKeySet = createRemoteJWKSet(new URL(oidcConfig.jwks_uri), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    timeoutDuration: 10_000,
  });

  console.log(`[auth] Issuer:   ${oidcConfig.issuer}`);
  console.log(`[auth] Auth:     ${oidcConfig.authorization_endpoint}`);
  console.log(`[auth] Token:    ${oidcConfig.token_endpoint}`);
  console.log(`[auth] JWKS:     ${oidcConfig.jwks_uri}`);
}

// ---------------------------------------------------------------------------
// Bounded event store (replaces SDK's InMemoryEventStore)
// ---------------------------------------------------------------------------

class BoundedEventStore implements EventStore {
  private events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private readonly maxEvents: number;

  constructor(maxEvents = 200) {
    this.maxEvents = maxEvents;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.events.set(eventId, { streamId, message });
    if (this.events.size > this.maxEvents) {
      const oldest = this.events.keys().next().value;
      if (oldest) this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) return "";
    const streamId = lastEventId.split("_")[0] ?? "";
    if (!streamId) return "";
    let found = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eid, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eid === lastEventId) { found = true; continue; }
      if (found) await send(eid, message);
    }
    return streamId;
  }
}

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

async function createMcpServer(): Promise<McpServer> {
  // Build dynamic instructions with current project inventory
  const projects = await store.listProjects();
  const projectLines = projects.length > 0
    ? projects.map((p) => `  - ${p.id}: "${p.title}" (${p.status})`).join("\n")
    : "  (none — use create_project to start one)";

  const instructions = [
    "Fractal is a structured narrative authoring server.",
    "Use get_context as the primary read tool — it returns any combination of project data in one call.",
    "All tools except list_projects and list_templates require a 'project' parameter.",
    "",
    "Current projects:",
    projectLines,
  ].join("\n");

  const server = new McpServer(
    { name: "fractal", version: "1.1.0" },
    { instructions },
  );

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

  server.registerTool("get_template", {
    title: "Get Template",
    description:
      "Returns the full contents of a project template — canon types, themes, " +
      "and the guide text. Use this to consult a template's writing guidelines " +
      "while working on a project.",
    inputSchema: {
      template_id: z.string().describe("Template ID, e.g. 'fiction-default', 'worldbuilding', 'litrpg', 'fanfic'. Use list_templates to see options."),
    },
  }, async ({ template_id }) => {
    logToolCall("get_template", { template_id });
    const template = await store.loadTemplate(template_id);
    return jsonResult(template);
  });

  server.registerTool("update_template", {
    title: "Update Template",
    description:
      "Create or update a project template. Provide the full template object — " +
      "id, name, description, canon_types, themes, and guide. " +
      "Changes take effect on the next create_project or apply_template call.",
    inputSchema: {
      template_id: z.string().describe("Template ID (used as filename, e.g. 'my-template')"),
      name: z.string().describe("Display name, e.g. 'My Custom Template'"),
      description: z.string().describe("One-line description of what this template is for"),
      canon_types: z.array(z.object({
        id: z.string().describe("Canon type ID, e.g. 'characters', 'factions'"),
        label: z.string().describe("Display label"),
        description: z.string().describe("What belongs in this canon type"),
      })).describe("Canon types this template provides"),
      themes: z.array(z.string()).optional().describe("Seed themes for projects using this template"),
      guide: z.string().optional().describe("Markdown guide text — writing conventions, what to track per canon type"),
    },
  }, async ({ template_id, name, description, canon_types, themes, guide }) => {
    logToolCall("update_template", { template_id });
    const template: store.ProjectTemplate = {
      id: template_id,
      name,
      description,
      canon_types,
      themes: themes ?? [],
      guide: guide ?? null,
    };
    await store.saveTemplate(template);
    return textResult(`Template "${template_id}" saved with ${canon_types.length} canon types.`);
  });

  server.registerTool("apply_template", {
    title: "Apply Template",
    description:
      "Apply (or re-apply) a template to an existing project. Creates any missing " +
      "canon directories, merges new canon types into project.json, and writes/overwrites " +
      "GUIDE.md. Existing canon entries and prose are never deleted.",
    inputSchema: {
      project: projectParam,
      template_id: z.string().describe("Template ID to apply"),
    },
  }, async ({ project, template_id }) => {
    logToolCall("apply_template", { project, template_id });
    const template = await store.loadTemplate(template_id);
    const result = await store.applyTemplateToProject(project, template);
    if (result.changed_files.length > 0) {
      try {
        await autoCommit(result.root, result.changed_files, `[auto] apply template: ${template_id}`);
      } catch (err) {
        console.error(`[git-warning] Auto-commit failed:`, err instanceof Error ? err.message : err);
      }
    }
    return jsonResult({
      template_id,
      created_dirs: result.created_dirs,
      guide_updated: result.guide_updated,
      message: result.created_dirs.length > 0
        ? `Applied "${template_id}": created ${result.created_dirs.join(", ")}${result.guide_updated ? ", updated GUIDE.md" : ""}`
        : `Applied "${template_id}": all canon dirs already exist${result.guide_updated ? ", updated GUIDE.md" : ""}`,
    });
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


  server.registerTool("get_context", {
    title: "Get Context",
    description:
      "Primary read tool — returns any combination of project data in one call. " +
      "Pass a shopping list of what you need via the include object. " +
      "Partial failure — missing items go to errors, everything else returns normally.",
    inputSchema: {
      project: projectParam,
      include: z.object({
        canon: z.array(z.string()).optional().describe("Canon IDs to load, e.g. ['unit-7', 'the-bakery']. Type is inferred by scanning canon directories."),
        scratch: z.array(z.string()).optional().describe("Scratch filenames, e.g. ['voice-codex.md']"),
        parts: z.array(z.string()).optional().describe("Part IDs, e.g. ['part-01']"),
        chapter_meta: z.array(z.string()).optional().describe("Chapter refs, e.g. ['part-01/chapter-03']"),
        chapter_prose: z.array(z.string()).optional().describe("Full chapter prose refs, e.g. ['part-01/chapter-03']. Returns {prose, version}."),
        beats: z.array(z.string()).optional().describe("Beat refs, e.g. ['part-01/chapter-03:b01']"),
        beat_variants: z.array(z.string()).optional().describe("Beat refs for variant listing, e.g. ['part-01/chapter-03:b03']"),
        dirty_nodes: z.boolean().optional().describe("Include all dirty/conflict nodes"),
        project_meta: z.boolean().optional().describe("Include top-level project metadata (enriched with canon_types_active and has_guide)"),
        guide: z.boolean().optional().describe("Include GUIDE.md content from project root"),
        notes: z.object({
          scope: z.string().optional().describe("Scope filter: 'part-01', 'part-01/chapter-03', or 'part-01/chapter-03:b02'. Omit to scan entire project."),
          type: z.enum(["note", "dev", "line", "continuity", "query", "flag"]).optional().describe("Filter by annotation type"),
          author: z.string().optional().describe("Filter by author, e.g. 'human' or 'claude'"),
        }).optional().describe("Include inline annotations. Pass {} for all, or add scope/type/author filters."),
        scratch_index: z.boolean().optional().describe("Include the scratch folder index (scratch.json)"),
        canon_list: z.union([z.boolean(), z.string()]).optional().describe("true = list canon types; string = list entries within that type, e.g. 'characters'"),
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
    description: "Pick one variant of a beat as the winner, archive the rest to scratch. Use get_context with beat_variants include first to see all variants and decide which to keep.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      keep_index: z.number().describe("Zero-based index of the variant to keep (from get_context beat_variants)"),
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

  server.registerTool("mark_node", {
    title: "Mark Node",
    description: "Set a node's dirty/clean status. Use status='dirty' with a reason to flag a node for review, or status='clean' to clear it.",
    inputSchema: {
      project: projectParam,
      node_ref: z.string().describe("Node reference, e.g. 'part-01', 'part-01/chapter-02', 'part-01/chapter-02:b03'"),
      status: z.enum(["dirty", "clean"]).describe("'dirty' to flag for review, 'clean' to clear"),
      reason: z.string().optional().describe("Why this node is dirty (required when status='dirty', ignored when 'clean')"),
    },
  }, async ({ project, node_ref, status, reason }) => {
    logToolCall("mark_node", { project, node_ref, status, reason });
    try {
      if (status === "dirty" && !reason) {
        throw new Error("reason is required when marking a node dirty");
      }
      const root = store.projectRoot(project);
      if (status === "dirty") {
        const results = await withCommit(
          root,
          () => store.markDirty(project, node_ref, reason!),
          `Marked ${node_ref} dirty (${reason})`
        );
        return jsonResult(results);
      } else {
        const results = await withCommit(
          root,
          () => store.markClean(project, node_ref),
          `Marked ${node_ref} clean`
        );
        return jsonResult(results);
      }
    } catch (err) {
      logToolError("mark_node", err);
      throw err;
    }
  });


  server.registerTool("update_canon", {
    title: "Update Canon",
    description: "Create or rewrite a canon file (character, location, etc.).",
    inputSchema: {
      project: projectParam,
      type: z.string().describe("Canon type directory name, e.g. 'characters', 'locations', 'factions'. Use get_context with canon_list: true to see active types."),
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

  server.registerTool("add_note", {
    title: "Add Note",
    description:
      "Insert an inline annotation in a chapter's prose, anchored after a specific line number. " +
      "Author is automatically set to 'claude'. The annotation is an HTML comment invisible in rendered markdown. " +
      "Optionally pass a version token (from a previous add_note or get_context notes) for line-number translation if the file changed.",
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
        "Version token from a previous add_note or get_context notes response. If the file changed since this version, line numbers are translated automatically. Omit on first insert."
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

  server.registerTool("resolve_notes", {
    title: "Resolve Notes",
    description:
      "Batch-remove multiple inline annotations from prose files after they've been addressed. " +
      "Pass note IDs from get_context with notes include.",
    inputSchema: {
      project: projectParam,
      note_ids: z.array(z.string()).describe(
        "Note IDs to resolve, e.g. ['part-01/chapter-03:b02:n47']. Get these from get_context with notes include."
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

interface SessionInfo {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  createdAt: number;
}

const sessions = new Map<string, SessionInfo>();

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
  allowedHeaders: ["Content-Type", "Accept", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
  exposedHeaders: ["mcp-session-id"],
});

// --- CORS on raw/hijacked responses + JWT auth ---
app.addHook("onRequest", async (request, reply) => {
  // CORS headers must apply to all responses, including 401
  const origin = request.headers.origin;
  if (origin) {
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version");
    reply.raw.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  }

  // Skip auth if not configured
  if (!oidcConfig || !jwksKeySet) return;

  // Exempt routes
  if (request.method === "OPTIONS") return;
  if (request.url.startsWith("/.well-known/")) return;
  if (request.url === "/health" || request.url === "/help") return;
  if (request.url === "/oauth/register") return;

  // Extract Bearer token
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const meta = FRACTAL_PUBLIC_URL
      ? ` resource_metadata="${FRACTAL_PUBLIC_URL}/.well-known/oauth-protected-resource"`
      : "";
    reply.header("WWW-Authenticate", `Bearer${meta}`);
    return reply.code(401).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized: missing Bearer token" },
      id: null,
    });
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, jwksKeySet, {
      issuer: oidcConfig.issuer,
      audience: OIDC_AUDIENCE || undefined,
      clockTolerance: 60,
    });

    // Attach AuthInfo to raw request — SDK reads req.auth in streamableHttp.js
    (request.raw as IncomingMessage & { auth?: AuthInfo }).auth = {
      token,
      clientId: (payload.azp as string) ?? (payload.client_id as string) ?? "unknown",
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
      expiresAt: payload.exp,
      extra: { sub: payload.sub, username: payload.preferred_username ?? payload.sub },
    };
  } catch (err) {
    request.log.warn(`[auth] JWT verification failed: ${err instanceof Error ? err.message : err}`);
    reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return reply.code(401).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized: invalid token" },
      id: null,
    });
  }
});

// --- Health check ---
app.get("/health", async () => {
  const projects = await store.listProjects();
  const mem = process.memoryUsage();
  return {
    status: "ok",
    sessions: {
      active: sessions.size,
      ttl_ms: SESSION_TTL_MS,
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    projects_root: store.getProjectsRoot(),
    test_projects_root: store.getTestProjectsRoot(),
    projects,
  };
});

// --- Help endpoint ---
app.get("/help", async () => {
  return {
    name: "Fractal",
    description: "Fractal narrative MCP server (multi-project)",
    projects_root: store.getProjectsRoot(),
    note: "All tools except list_projects and list_templates require a 'project' parameter.",
    tools: {
      management: {
        list_projects: "List all available projects (id, title, status).",
        create_project: "Bootstrap a new project with all directories and starter files. Accepts optional template param.",
        create_part: "Create a new part directory with part.json, add to project parts list.",
        create_chapter: "Create a new chapter (.md + .meta.json) inside a part, add to part chapters list.",
        list_templates: "List available project templates (id, name, description).",
        get_template: "Returns full template contents — canon types, themes, and guide text.",
        update_template: "Create or update a template. Provide id, name, description, canon_types, themes, guide.",
        apply_template: "Apply a template to an existing project — adds missing canon dirs, updates GUIDE.md.",
      },
      read: {
        get_context: "Primary read tool — returns any combination of project data in one call. Supports: project_meta, parts, chapter_meta, chapter_prose (with version), beats, beat_variants, canon, scratch, scratch_index, dirty_nodes, notes, canon_list, guide.",
        search: "Full-text search across prose, canon, and scratch files.",
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
        mark_node: "Set dirty/clean status on a node. status='dirty' requires a reason.",
        update_canon: "Create or rewrite a canon file (character, location, etc.).",
        add_scratch: "Add a new file to the scratch folder.",
        promote_scratch: "Move scratch content into a beat in the narrative structure.",
      },
      annotations: {
        add_note: "Insert annotation after a line number. Optionally pass version for line translation. Author: claude.",
        resolve_notes: "Batch-remove one or more annotations by ID.",
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

// --- OAuth Protected Resource Metadata (RFC 9728) ---
app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
  if (!oidcConfig || !FRACTAL_PUBLIC_URL) {
    return reply.code(404).send({ error: "Auth not configured" });
  }
  return {
    resource: `${FRACTAL_PUBLIC_URL}/mcp`,
    authorization_servers: [oidcConfig.issuer],
    scopes_supported: [],
  };
});

// --- OAuth Authorization Server Metadata (RFC 8414) ---
app.get("/.well-known/oauth-authorization-server", async (_request, reply) => {
  if (!oidcConfig) {
    return reply.code(404).send({ error: "Auth not configured" });
  }
  const meta: Record<string, unknown> = {
    issuer: oidcConfig.issuer,
    authorization_endpoint: oidcConfig.authorization_endpoint,
    token_endpoint: oidcConfig.token_endpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
  // Advertise DCR endpoint so Claude.ai (or any MCP client) can obtain credentials
  if (OIDC_CLIENT_ID && FRACTAL_PUBLIC_URL) {
    meta.registration_endpoint = `${FRACTAL_PUBLIC_URL}/oauth/register`;
  }
  return meta;
});

// --- Dynamic Client Registration (RFC 7591) — passthrough to pre-configured creds ---
app.post("/oauth/register", async (request, reply) => {
  if (!OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !oidcConfig) {
    return reply.code(404).send({ error: "Client registration not configured" });
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const redirectUris = (body.redirect_uris as string[] | undefined) ?? [];

  // RFC 7591 response — hand back the pre-configured Synology SSO credentials
  return reply.code(201).send({
    client_id: OIDC_CLIENT_ID,
    client_secret: OIDC_CLIENT_SECRET,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0, // never expires
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: (body.client_name as string) ?? "MCP Client",
    scope: (body.scope as string) ?? "openid",
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint — POST /mcp
// ---------------------------------------------------------------------------

app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId && sessions.has(sessionId)) {
      const info = sessions.get(sessionId)!;
      info.lastActivity = Date.now();
      await info.transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack();
    }

    if (!sessionId && isInitializeRequest(request.body)) {
      const eventStore = new BoundedEventStore();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          const now = Date.now();
          sessions.set(sid, { transport, lastActivity: now, createdAt: now });
          request.log.info(`Session initialized: ${sid} (active: ${sessions.size})`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
          console.log(`Session closed: ${sid} (active: ${sessions.size})`);
        }
      };

      const server = await createMcpServer();
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

  if (!sessionId || !sessions.has(sessionId)) {
    reply.code(400).send("Invalid or missing session ID");
    return;
  }

  const info = sessions.get(sessionId)!;
  info.lastActivity = Date.now();
  await info.transport.handleRequest(request.raw, reply.raw);
  return reply.hijack();
});

// ---------------------------------------------------------------------------
// MCP endpoint — DELETE /mcp
// ---------------------------------------------------------------------------

app.delete("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    reply.code(400).send("Invalid or missing session ID");
    return;
  }

  request.log.info(`Session termination requested: ${sessionId}`);
  const info = sessions.get(sessionId)!;
  await info.transport.handleRequest(request.raw, reply.raw);
  return reply.hijack();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  try {
    await initializeOidc();

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

    // Session idle reaper
    reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, info] of sessions) {
        if (now - info.lastActivity > SESSION_TTL_MS) {
          console.log(`Reaping idle session ${sid} (idle ${Math.round((now - info.lastActivity) / 1000)}s)`);
          info.transport.close().catch(err =>
            console.error(`Error closing idle session ${sid}:`, err)
          );
        }
      }
    }, REAPER_INTERVAL_MS);

    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\nFractal MCP server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Health check: http://localhost:${PORT}/health`);
    console.log(`  Help:         http://localhost:${PORT}/help`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Projects:     ${projectsRoot}`);
    console.log(`  Test:         ${testRoot}`);
    console.log(`  Session TTL:  ${SESSION_TTL_MS / 1000}s (reaper every ${REAPER_INTERVAL_MS / 1000}s)`);
    console.log(`  Auth:         ${oidcConfig ? `enabled (issuer: ${oidcConfig.issuer})` : "disabled"}`);
    console.log(`  Loaded:       ${projects.map((p) => p.id).join(", ") || "(none)"}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

let reaperInterval: ReturnType<typeof setInterval>;

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  clearInterval(reaperInterval);
  for (const [sid, info] of sessions) {
    try {
      await info.transport.close();
    } catch (err) {
      console.error(`Error closing session ${sid}:`, err);
    }
  }
  sessions.clear();
  process.exit(0);
});

main();
