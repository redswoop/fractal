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
 * Every tool (except list_projects and template list/get/save) takes a `project` parameter.
 * Each project has its own git repo with automatic commits on writes.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { ensureGitRepo, autoCommit, sessionCommit, lastSessionSummary, getUncommittedFiles, getFileVersion } from "./git.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version as string;

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

async function shouldAutoCommit(root: string): Promise<boolean> {
  try {
    const projectJson = await readFile(join(root, "project.json"), "utf-8");
    const project = JSON.parse(projectJson) as { autoCommit?: boolean };
    return project.autoCommit ?? true;
  } catch {
    return true;
  }
}

async function commitFiles(root: string, paths: string[], message: string): Promise<void> {
  if (!(await shouldAutoCommit(root))) {
    return; // Skip commit if autoCommit is disabled
  }

  const files = paths.map((p) => p.startsWith(root) ? p.slice(root.length + 1) : p);
  try {
    await autoCommit(root, files, message);
  } catch (err) {
    console.error(`[git-warning] Auto-commit failed for "${message}":`,
      err instanceof Error ? err.message : err);
  }
}

async function withCommit<T extends store.WriteResult | store.WriteResult[]>(
  root: string,
  fn: () => Promise<T>,
  commitMessage: string
): Promise<T> {
  const result = await fn();
  const results = Array.isArray(result) ? result : [result];
  await commitFiles(root, results.map((r) => r.path), commitMessage);
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

function requireArgs(args: Record<string, unknown>, fields: string[], context: string): void {
  for (const field of fields) {
    if (args[field] === undefined || args[field] === null) {
      throw new Error(`${field} is required for ${context}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

async function createMcpServer(): Promise<McpServer> {
  // Build dynamic instructions with current project inventory + status
  const projects = await store.listProjects();

  let projectLines: string;
  if (projects.length === 0) {
    projectLines = "  (none — use create to start one)";
  } else {
    const lines: string[] = [];
    for (const p of projects) {
      let line = `  - ${p.id}: "${p.title}" (${p.status})`;

      // Enrich in-progress projects with status details
      if (p.status === "in-progress") {
        const details: string[] = [];
        try {
          const dirty = await store.getDirtyNodes(p.id);
          if (dirty.length > 0) details.push(`${dirty.length} dirty node${dirty.length > 1 ? "s" : ""}`);
        } catch { /* skip */ }
        try {
          const rl = await store.getRedlines(p.id);
          if (rl.redlines.length > 0) details.push(`${rl.redlines.length} open redline${rl.redlines.length > 1 ? "s" : ""}`);
        } catch { /* skip */ }
        try {
          const root = store.projectRoot(p.id);
          const session = await lastSessionSummary(root);
          if (session) details.push(`last session: ${session}`);
        } catch { /* skip */ }
        if (details.length > 0) line += `\n    ${details.join(", ")}`;
      }

      lines.push(line);
    }
    projectLines = lines.join("\n");
  }

  const instructions = [
    "Fractal is a structured narrative authoring server.",
    "Use get_context as the primary read tool — it returns any combination of project data in one call.",
    "All tools except list_projects and template (list/get/save actions) require a 'project' parameter.",
    "",
    "Markdown-first architecture: The .md file is the source of truth for all narrative content. " +
    "Beat markers include status: <!-- beat:ID [status] | label -->. " +
    "Full summaries live as <!-- summary: ... --> comments after beat markers, and <!-- chapter-summary: ... --> in the preamble. " +
    "The .meta.json sidecar is a navigation index only (characters, dirty_reason). " +
    "Summaries, labels, and status are always read from and written to the markdown file.",
    "",
    "Ejectability: Markdown is the source of truth for everything that matters for writing — prose, summaries, beat structure, canon. " +
    "If this tool vanishes, every file is still readable prose. " +
    "Meta sidecars (.meta.json) are navigation indexes only: characters, dirty_reason, appears_in, role, type. " +
    "Never put writing-relevant content only in meta. " +
    "Rule of thumb: if a human writing a scene would need it, it goes in the markdown. If only the tool needs it for queries, it goes in meta.",
    "",
    "Summary vs Notes distinction: " +
    "Summaries (in .md files as <!-- summary: ... --> comments) are scannable navigation (1-3 sentences, what happens + who's involved, never 'why'). " +
    "Notes (in separate .notes.md files) are dense planning workspace (500+ words typical) with psychology, themes, foreshadowing, research, uncommitted details. " +
    "Part notes (part-XX.notes.md) provide context for the whole part. Chapter notes (chapter-XX.notes.md) are chapter-specific. " +
    "Notes use # (h1) headers for sections and support lazy-loading like canon: " +
    "get_context returns topMatter + sections TOC; fetch specific sections via # notation (e.g. 'part-01#thematic-architecture'). " +
    "When writing prose, consult part_notes + chapter_notes via get_context first. When planning, write notes via write tool with target='part_notes' or 'chapter_notes'.",
    "",
    "Canon loading: Canon entries use ## sections for organization. " +
    "When sections exist, get_context returns only the top-matter (summary) plus a sections TOC. " +
    "Fetch specific sections on demand via # notation (e.g. 'emmy#voice-personality'). " +
    "This keeps context lean — load only the sections you need for the current scene.",
    "",
    "Redlines: Inline editorial marks in prose files (<!-- @type(author): message -->). " +
    "Long redlines are word-wrapped at ~80 columns for human readability — the parser handles multi-line comments transparently. " +
    "When get_context returns redlines, check the 'warnings' array: it surfaces corrupt markup " +
    "(e.g. unclosed redline comments, unparseable syntax) with line number, beat, and issue description. " +
    "If warnings appear, fix the markup in the prose file — the agent can use edit target=beat to repair it.",
    "",
    "Git commits: New projects default to autoCommit=false (session-based commits). " +
    "When you see uncommitted_count in list_projects or get_context, inform the user about pending changes. " +
    "If you just made those changes in this conversation, continue working. " +
    "If it's a new conversation or you didn't make them, ask: 'There are uncommitted changes. Want to commit them first, or continue?' " +
    "Use session_summary to commit accumulated changes with a meaningful message describing the work done. " +
    "Projects with autoCommit=true commit automatically (legacy behavior).",
    "",
    "Current projects:",
    projectLines,
  ].join("\n");

  const server = new McpServer(
    { name: "fractal", version: PKG_VERSION },
    { instructions },
  );

  // =========================================================================
  // list_projects — standalone entry point
  // =========================================================================

  server.registerTool("list_projects", {
    title: "List Projects",
    description: "List all available projects with status briefing. Includes uncommitted file count for all projects. In-progress projects also include dirty node count, open redline count, and last session summary.",
    inputSchema: {},
  }, async () => {
    const projects = await store.listProjects();
    if (projects.length === 0) {
      return textResult("No projects found. Use create to start one.");
    }

    const enriched = await Promise.all(projects.map(async (p) => {
      const extra: { dirty_nodes?: number; open_redlines?: number; last_session?: string; uncommitted_files?: string[]; uncommitted_count?: number } = {};

      // Always check for uncommitted files
      try {
        const root = store.projectRoot(p.id);
        const uncommittedFiles = await getUncommittedFiles(root);
        if (uncommittedFiles.length > 0) {
          extra.uncommitted_files = uncommittedFiles;
          extra.uncommitted_count = uncommittedFiles.length;
        }
      } catch { /* skip */ }

      // Only enrich in-progress projects with other details
      if (p.status === "in-progress") {
        try {
          const dirty = await store.getDirtyNodes(p.id);
          if (dirty.length > 0) extra.dirty_nodes = dirty.length;
        } catch { /* skip */ }
        try {
          const rl = await store.getRedlines(p.id);
          if (rl.redlines.length > 0) extra.open_redlines = rl.redlines.length;
        } catch { /* skip */ }
        try {
          const root = store.projectRoot(p.id);
          const session = await lastSessionSummary(root);
          if (session) extra.last_session = session;
        } catch { /* skip */ }
      }

      return { ...p, ...extra };
    }));

    return jsonResult(enriched);
  });

  // =========================================================================
  // template — consolidated from list/get/update/apply_template
  // =========================================================================

  server.registerTool("template", {
    title: "Template",
    description:
      "Manage project templates. action='list' lists available templates. " +
      "action='get' returns full template contents (canon types, themes, guide). " +
      "action='save' creates or updates a template. " +
      "action='apply' applies a template to an existing project (requires project param).",
    inputSchema: {
      action: z.enum(["list", "get", "save", "apply"]).describe("Operation to perform"),
      template_id: z.string().optional().describe("Template ID — required for get, save, apply"),
      project: projectParam.optional().describe("Project identifier — required for apply only"),
      name: z.string().optional().describe("Display name (save only)"),
      description: z.string().optional().describe("One-line description (save only)"),
      canon_types: z.array(z.object({
        id: z.string().describe("Canon type ID, e.g. 'characters', 'factions'"),
        label: z.string().describe("Display label"),
        description: z.string().describe("What belongs in this canon type"),
      })).optional().describe("Canon types (save only)"),
      themes: z.array(z.string()).optional().describe("Seed themes (save only)"),
      guide: z.string().optional().describe("Markdown guide text (save only)"),
    },
  }, async (args) => {
    logToolCall("template", { action: args.action, template_id: args.template_id, project: args.project });
    try {
      switch (args.action) {
        case "list": {
          const templates = await store.listTemplates();
          if (templates.length === 0) {
            return textResult("No templates found. Projects will use the default setup (characters + locations).");
          }
          return jsonResult(templates);
        }
        case "get": {
          if (!args.template_id) throw new Error("template_id is required for action='get'");
          const template = await store.loadTemplate(args.template_id);
          return jsonResult(template);
        }
        case "save": {
          requireArgs(args, ["template_id", "name", "description"], "action='save'");
          if (!args.canon_types || args.canon_types.length === 0) throw new Error("canon_types is required for action='save'");
          const template: store.ProjectTemplate = {
            id: args.template_id!,
            name: args.name!,
            description: args.description!,
            canon_types: args.canon_types,
            themes: args.themes ?? [],
            guide: args.guide ?? null,
          };
          await store.saveTemplate(template);
          return textResult(`Template "${args.template_id}" saved with ${args.canon_types.length} canon types.`);
        }
        case "apply": {
          if (!args.template_id) throw new Error("template_id is required for action='apply'");
          if (!args.project) throw new Error("project is required for action='apply'");
          const tmpl = await store.loadTemplate(args.template_id);
          const result = await store.applyTemplateToProject(args.project, tmpl);
          if (result.changed_files.length > 0) {
            await commitFiles(result.root, result.changed_files, `[auto] apply template: ${args.template_id}`);
          }
          return jsonResult({
            template_id: args.template_id,
            created_dirs: result.created_dirs,
            guide_updated: result.guide_updated,
            message: result.created_dirs.length > 0
              ? `Applied "${args.template_id}": created ${result.created_dirs.join(", ")}${result.guide_updated ? ", updated GUIDE.md" : ""}`
              : `Applied "${args.template_id}": all canon dirs already exist${result.guide_updated ? ", updated GUIDE.md" : ""}`,
          });
        }
      }
    } catch (err) {
      logToolError("template", err);
      throw err;
    }
  });

  // =========================================================================
  // get_context — primary read tool (now includes search)
  // =========================================================================

  server.registerTool("get_context", {
    title: "Get Context",
    description:
      "Primary read tool — returns any combination of project data in one call. " +
      "Pass a shopping list of what you need via the include object. " +
      "Partial failure — missing items go to errors, everything else returns normally.",
    inputSchema: {
      project: projectParam,
      include: z.object({
        canon: z.array(z.string()).optional().describe("Canon entry IDs to load. Returns summary (top-matter before first ## header) + sections TOC. Use # for sections: 'emmy#voice-personality'. Type is inferred by scanning canon directories."),
        scratch: z.array(z.string()).optional().describe("Scratch filenames, e.g. ['voice-codex.md']"),
        parts: z.array(z.string()).optional().describe("Part IDs, e.g. ['part-01']"),
        chapter_meta: z.array(z.string()).optional().describe("Chapter refs, e.g. ['part-01/chapter-03']"),
        chapter_prose: z.array(z.string()).optional().describe("Full chapter prose refs, e.g. ['part-01/chapter-03']. Returns {prose, version}."),
        beats: z.array(z.string()).optional().describe("Beat refs, e.g. ['part-01/chapter-03:b01']"),
        beat_variants: z.array(z.string()).optional().describe("Beat refs for variant listing, e.g. ['part-01/chapter-03:b03']"),
        dirty_nodes: z.boolean().optional().describe("Include all dirty/conflict nodes"),
        project_meta: z.boolean().optional().describe("Include top-level project metadata (enriched with canon_types_active, has_guide, uncommitted_files, and uncommitted_count)"),
        guide: z.boolean().optional().describe("Include GUIDE.md content from project root"),
        redlines: z.object({
          scope: z.string().optional().describe("Scope filter: 'part-01', 'part-01/chapter-03', or 'part-01/chapter-03:b02'. Omit to scan entire project."),
          type: z.enum(["note", "dev", "line", "continuity", "query", "flag"]).optional().describe("Filter by redline type"),
          author: z.string().optional().describe("Filter by author, e.g. 'human' or 'claude'"),
        }).optional().describe("Include inline redlines. Pass {} for all, or add scope/type/author filters."),
        scratch_index: z.boolean().optional().describe("Include the scratch folder index (scratch.json)"),
        canon_list: z.union([z.boolean(), z.string()]).optional().describe("true = list canon types; string = list entries within that type, e.g. 'characters'"),
        part_notes: z.array(z.string()).optional().describe("Part-level planning notes, e.g. ['part-01']. Returns structured object with topMatter + sections TOC when # sections exist. Use # notation for specific sections: 'part-01#thematic-architecture'. Returns raw string if no sections. Empty string if file doesn't exist."),
        chapter_notes: z.array(z.string()).optional().describe("Chapter-level planning notes, e.g. ['part-01/chapter-03']. Returns structured object with topMatter + sections TOC when # sections exist. Use # notation for specific sections: 'part-01/chapter-03#beat-b01'. Returns raw string if no sections. Empty string if file doesn't exist."),
        search: z.object({
          query: z.string().describe("Search query (case-insensitive)"),
          scope: z.enum(["prose", "canon", "scratch"]).optional().describe("Limit search to a specific scope"),
        }).optional().describe("Full-text search across prose, canon, and scratch files. Results added to response under 'search' key."),
      }).describe("What to include. Every key is optional. Request exactly what you need."),
    },
  }, async ({ project, include }) => {
    // Separate search from store-native includes
    const { search: searchOpts, ...storeInclude } = include;
    const data = await store.getContext(project, storeInclude) as Record<string, unknown>;

    // Enrich project_meta with uncommitted files if requested
    if (include.project_meta && data.project_meta) {
      try {
        const root = store.projectRoot(project);
        const uncommittedFiles = await getUncommittedFiles(root);
        (data.project_meta as Record<string, unknown>).uncommitted_files = uncommittedFiles;
        (data.project_meta as Record<string, unknown>).uncommitted_count = uncommittedFiles.length;
      } catch {
        // Skip if git check fails
      }
    }

    // Handle search if requested
    if (searchOpts) {
      const results = await store.search(project, searchOpts.query, searchOpts.scope);
      if (results.length === 0) {
        data.search = { results: [], message: `No results for "${searchOpts.query}"` };
      } else {
        const formatted = results
          .slice(0, 50)
          .map((r) => `${r.file}:${r.line}: ${r.text}`);
        data.search = { results: formatted, total: results.length, query: searchOpts.query };
      }
    }

    return jsonResult(data);
  });

  // =========================================================================
  // create — consolidated from create_project, create_part, create_chapter,
  //          add_beat, add_scratch, add_note
  // =========================================================================

  server.registerTool("create", {
    title: "Create",
    description:
      "Create a new entity. target='project' bootstraps a new project. " +
      "target='part' creates a part directory. target='chapter' creates a chapter. " +
      "target='beat' adds a beat to a chapter. target='scratch' adds a scratch file. " +
      "target='redline' inserts an inline redline.",
    inputSchema: {
      target: z.enum(["project", "part", "chapter", "beat", "scratch", "redline"]).describe("What to create"),
      project: projectParam.optional().describe("Project identifier — IS the new project id for target='project'; required for all targets"),
      title: z.string().optional().describe("Display title (project, part, chapter)"),
      template: z.string().optional().describe("Template ID for project setup (project only)"),
      part_id: z.string().optional().describe("Part identifier (part, chapter, beat, redline)"),
      chapter_id: z.string().optional().describe("Chapter identifier (chapter, beat, redline)"),
      summary: z.string().optional().describe("Summary (part, chapter)"),
      arc: z.string().optional().describe("Arc description (part only)"),
      pov: z.string().optional().describe("POV character id (chapter only)"),
      location: z.string().optional().describe("Location id (chapter only)"),
      timeline_position: z.string().optional().describe("Timeline position, e.g. '1996-09-14' (chapter only)"),
      beat: z.object({
        id: z.string().describe("Beat identifier, e.g. 'b01'"),
        label: z.string().describe("Short label, e.g. 'Unit 7 opens the bakery'"),
        summary: z.string().describe("Scannable description (1-3 sentences). What happens and who's involved. Never explain 'why' — that goes in notes. For written beats: describe the prose. For planned beats: expand the label into sentences."),
        status: z.string().optional().describe("Default: 'planned'. Values: 'planned', 'written', 'dirty', 'conflict'"),
        dirty_reason: z.string().nullable().optional().describe("Reason if dirty. Usually null for new beats."),
        characters: z.array(z.string()).optional().describe("Character IDs, e.g. ['unit-7', 'marguerite']"),
        depends_on: z.array(z.string()).optional().describe("Beat refs this depends on, e.g. ['chapter-01:b02']"),
        depended_by: z.array(z.string()).optional().describe("Beat refs that depend on this"),
      }).optional().describe("Beat definition (beat only). Required: id, label, summary."),
      after_beat_id: z.string().optional().describe("Insert after this beat ID (beat only). Omit to append."),
      filename: z.string().optional().describe("Scratch filename, e.g. 'unit7-dream-sequence.md' (scratch only)"),
      content: z.string().optional().describe("Content of the scratch file (scratch only)"),
      note: z.string().optional().describe("Note about what this is and where it might go (scratch only)"),
      characters: z.array(z.string()).optional().describe("Characters involved (scratch only)"),
      mood: z.string().optional().describe("Mood/tone description (scratch only)"),
      potential_placement: z.string().optional().describe("Where this might end up, e.g. 'part-01/chapter-04' (scratch only)"),
      line_number: z.number().optional().describe("Line number to insert redline after, 1-based (redline only)"),
      redline_type: z.enum(["note", "dev", "line", "continuity", "query", "flag"]).optional().describe(
        "Redline type (redline only): 'note' (general), 'dev' (structural), 'line' (prose craft), 'continuity' (consistency), 'query' (question), 'flag' (wordless marker)"
      ),
      message: z.string().optional().describe("Redline message (redline only, required except for 'flag')"),
      version: z.string().optional().describe("Version token for line-number translation if file changed (redline only)"),
    },
  }, async (args) => {
    const { target } = args;
    logToolCall("create", { target, project: args.project, part_id: args.part_id, chapter_id: args.chapter_id });
    try {
      switch (target) {
        case "project": {
          if (!args.project) throw new Error("project is required (the project ID to create)");
          if (!args.title) throw new Error("title is required for target='project'");
          let tmpl: store.ProjectTemplate | undefined;
          if (args.template) {
            tmpl = await store.loadTemplate(args.template);
          }
          const root = await store.ensureProjectStructure(args.project, args.title, tmpl);
          await ensureGitRepo(root);
          return jsonResult({
            project: args.project,
            root,
            template: args.template ?? "default",
            description: `Created project "${args.title}" at ${root}`,
          });
        }
        case "part": {
          requireArgs(args, ["project", "part_id", "title"], "target='part'");
          const root = store.projectRoot(args.project!);
          const results = await withCommit(
            root,
            () => store.createPart(args.project!, args.part_id!, args.title!, args.summary ?? "", args.arc ?? ""),
            `Created part ${args.part_id}: ${args.title}`
          );
          return jsonResult(results);
        }
        case "chapter": {
          requireArgs(args, ["project", "part_id", "chapter_id", "title"], "target='chapter'");
          const root = store.projectRoot(args.project!);
          const results = await withCommit(
            root,
            () => store.createChapter(args.project!, args.part_id!, args.chapter_id!, args.title!, args.summary ?? "", args.pov ?? "", args.location ?? "", args.timeline_position ?? ""),
            `Created chapter ${args.part_id}/${args.chapter_id}: ${args.title}`
          );
          return jsonResult(results);
        }
        case "beat": {
          requireArgs(args, ["project", "part_id", "chapter_id", "beat"], "target='beat'");
          const beat = args.beat!;
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
          const root = store.projectRoot(args.project!);
          const results = await withCommit(
            root,
            () => store.addBeat(args.project!, args.part_id!, args.chapter_id!, beatDef, args.after_beat_id),
            `Added beat ${beatDef.id} to ${args.part_id}/${args.chapter_id}`
          );
          return jsonResult(results);
        }
        case "scratch": {
          requireArgs(args, ["project", "filename", "note"], "target='scratch'");
          if (args.content === undefined) throw new Error("content is required for target='scratch'");
          const root = store.projectRoot(args.project!);
          const results = await withCommit(
            root,
            () => store.addScratch(args.project!, args.filename!, args.content!, args.note!, args.characters ?? [], args.mood ?? "", args.potential_placement ?? null),
            `Added scratch: ${args.filename}`
          );
          return jsonResult(results);
        }
        case "redline": {
          requireArgs(args, ["project", "part_id", "chapter_id", "redline_type"], "target='redline'");
          if (args.line_number == null) throw new Error("line_number is required for target='redline'");
          if (args.redline_type !== "flag" && !args.message) {
            throw new Error(`message is required for @${args.redline_type} redlines`);
          }
          const root = store.projectRoot(args.project!);
          const result = await store.insertRedline(
            args.project!, args.part_id!, args.chapter_id!, args.line_number,
            args.redline_type as "note" | "dev" | "line" | "continuity" | "query" | "flag",
            args.message ?? null, "claude", args.version
          );

          await commitFiles(root, [result.path], `Added @${args.redline_type}(claude) redline to ${args.part_id}/${args.chapter_id}`);

          // Get post-commit version
          const relPath = result.path.startsWith(root) ? result.path.slice(root.length + 1) : result.path;
          const newVersion = await getFileVersion(root, relPath);

          return jsonResult({
            id: result.id,
            inserted_after_line: result.inserted_after_line,
            location: `${args.part_id}/${args.chapter_id}`,
            version: newVersion,
          });
        }
      }
    } catch (err) {
      logToolError("create", err);
      throw err;
    }
  });

  // =========================================================================
  // update — consolidated from update_project, update_part,
  //          update_chapter_meta, mark_node
  // =========================================================================

  server.registerTool("update", {
    title: "Update",
    description:
      "Update metadata for an existing entity. target='project' patches project.json. " +
      "target='part' patches part metadata. target='chapter' patches chapter metadata " +
      "(including beats — provide array with just the beats to change, matched by id; unlisted beats untouched). " +
      "target='node' sets dirty/clean status on any node.",
    inputSchema: {
      target: z.enum(["project", "part", "chapter", "node"]).describe("What to update"),
      project: projectParam,
      part_id: z.string().optional().describe("Part identifier (part, chapter)"),
      chapter_id: z.string().optional().describe("Chapter identifier (chapter only)"),
      patch: z.object({
        title: z.string().optional().describe("Title (project, part, chapter)"),
        subtitle: z.string().nullable().optional().describe("Project subtitle"),
        logline: z.string().optional().describe("One-sentence story summary (project)"),
        status: z.string().optional().describe("Status string (project, part, chapter)"),
        themes: z.array(z.string()).optional().describe("Thematic threads (project)"),
        parts: z.array(z.string()).optional().describe("Ordered part IDs (project)"),
        canon_types: z.array(z.object({
          id: z.string().describe("Canon type directory name, e.g. 'factions'"),
          label: z.string().describe("Display label, e.g. 'Factions'"),
          description: z.string().describe("What this canon type contains"),
        })).optional().describe("Canon type definitions (project)"),
        summary: z.string().optional().describe("Summary (part, chapter)"),
        arc: z.string().optional().describe("Arc description (part)"),
        chapters: z.array(z.string()).optional().describe("Ordered chapter IDs (part)"),
        pov: z.string().optional().describe("POV character id (chapter)"),
        location: z.string().optional().describe("Location id (chapter)"),
        timeline_position: z.string().optional().describe("Timeline position (chapter)"),
        dirty_reason: z.string().nullable().optional().describe("Why this chapter needs review (chapter)"),
        beats: z.array(z.object({
          id: z.string().describe("Beat identifier, e.g. 'b01'"),
          label: z.string().optional().describe("Short beat label"),
          summary: z.string().optional().describe("Beat summary"),
          status: z.string().optional().describe("'planned', 'written', 'dirty', 'conflict'"),
          dirty_reason: z.string().nullable().optional().describe("Why this beat needs review"),
          characters: z.array(z.string()).optional().describe("Character IDs"),
          depends_on: z.array(z.string()).optional().describe("e.g. ['chapter-01:b02']"),
          depended_by: z.array(z.string()).optional().describe("Beat refs that depend on this"),
        })).optional().describe("Beats to merge by ID. Unlisted beats untouched. (chapter)"),
      }).optional().describe("Fields to update (project, part, chapter). Only include fields you want to change."),
      node_ref: z.string().optional().describe("Node reference for target='node', e.g. 'part-01', 'part-01/chapter-02', 'part-01/chapter-02:b03'"),
      mark: z.enum(["dirty", "clean"]).optional().describe("'dirty' to flag for review, 'clean' to clear (node only)"),
      reason: z.string().optional().describe("Why this node is dirty (node only, required when mark='dirty')"),
    },
  }, async (args) => {
    const { target, project } = args;
    logToolCall("update", { target, project, part_id: args.part_id, chapter_id: args.chapter_id, node_ref: args.node_ref });
    try {
      switch (target) {
        case "project": {
          if (!args.patch) throw new Error("patch is required for target='project'");
          const root = store.projectRoot(project);
          const result = await withCommit(
            root,
            () => store.updateProject(project, args.patch! as Partial<store.ProjectData>),
            `Updated project: ${Object.keys(args.patch).join(", ")}`
          );
          return jsonResult(result);
        }
        case "part": {
          if (!args.part_id) throw new Error("part_id is required for target='part'");
          if (!args.patch) throw new Error("patch is required for target='part'");
          const root = store.projectRoot(project);
          const result = await withCommit(
            root,
            () => store.updatePart(project, args.part_id!, args.patch! as Partial<store.PartData>),
            `Updated ${args.part_id}: ${Object.keys(args.patch).join(", ")}`
          );
          return jsonResult(result);
        }
        case "chapter": {
          requireArgs(args, ["part_id", "chapter_id", "patch"], "target='chapter'");
          const root = store.projectRoot(project);
          const result = await withCommit(
            root,
            () => store.updateChapterMeta(project, args.part_id!, args.chapter_id!, args.patch! as Partial<store.ChapterMeta>),
            `Updated ${args.part_id}/${args.chapter_id} meta: ${Object.keys(args.patch!).join(", ")}`
          );
          return jsonResult(result);
        }
        case "node": {
          if (!args.node_ref) throw new Error("node_ref is required for target='node'");
          if (!args.mark) throw new Error("mark is required for target='node'");
          if (args.mark === "dirty" && !args.reason) {
            throw new Error("reason is required when mark='dirty'");
          }
          const root = store.projectRoot(project);
          const commitMsg = args.mark === "dirty"
            ? `Marked ${args.node_ref} dirty (${args.reason})`
            : `Marked ${args.node_ref} clean`;
          const results = await withCommit(
            root,
            () => store.setNodeStatus(project, args.node_ref!, args.mark!, args.reason),
            commitMsg
          );
          return jsonResult(results);
        }
      }
    } catch (err) {
      logToolError("update", err);
      throw err;
    }
  });

  // =========================================================================
  // write — consolidated from write_beat_prose, update_canon, promote_scratch
  // =========================================================================

  server.registerTool("write", {
    title: "Write",
    description:
      "Write or replace content. target='beat' writes prose to a beat (or promotes scratch into it via source_scratch). " +
      "target='canon' creates or rewrites a canon entry. Use ## sections to organize — agents lazy-load via # notation. " +
      "target='part_notes' writes part-level planning notes (big-picture context, always relevant to all chapters in this part). " +
      "target='chapter_notes' writes chapter-specific planning notes (detailed planning, psychology, themes, research). " +
      "Notes use flexible markdown organization with proper headers — organize however makes sense for your thinking.",
    inputSchema: {
      target: z.enum(["beat", "canon", "part_notes", "chapter_notes"]).describe("What to write"),
      project: projectParam,
      content: z.string().optional().describe("The content to write. Required unless source_scratch is provided (beat only)."),
      part_id: z.string().optional().describe("Part identifier (beat, part_notes, chapter_notes)"),
      chapter_id: z.string().optional().describe("Chapter identifier (beat, chapter_notes)"),
      beat_id: z.string().optional().describe("Beat identifier (beat only)"),
      append: z.boolean().optional().describe("If true: for beats, append as a new variant block; for notes and canon, append content to the end of the existing file"),
      source_scratch: z.string().optional().describe("Scratch filename to promote into this beat instead of providing content (beat only)"),
      type: z.string().optional().describe("Canon type directory name, e.g. 'characters', 'locations', 'factions' (canon only)"),
      id: z.string().optional().describe("Canon entry id (canon only)"),
      meta: z.object({
        id: z.string().optional().describe("Canon entry id"),
        type: z.string().optional().describe("e.g. 'character', 'location'"),
        role: z.string().optional().describe("e.g. 'protagonist', 'mentor', 'antagonist'"),
        appears_in: z.array(z.string()).optional().describe("Beat refs, e.g. ['part-01/chapter-01:b01']"),
        last_updated: z.string().optional().describe("ISO timestamp"),
        updated_by: z.string().optional().describe("e.g. 'claude-conversation'"),
      }).passthrough().optional().describe("Navigation metadata sidecar (canon only). Index data only — role, appears_in, timestamps."),
    },
  }, async (args) => {
    const { target, project } = args;
    logToolCall("write", { target, project, part_id: args.part_id, chapter_id: args.chapter_id, beat_id: args.beat_id, source_scratch: args.source_scratch, type: args.type, id: args.id });
    try {
      switch (target) {
        case "beat": {
          requireArgs(args, ["part_id", "chapter_id", "beat_id"], "target='beat'");
          const root = store.projectRoot(project);

          if (args.source_scratch) {
            // Promote scratch into beat
            const results = await withCommit(
              root,
              () => store.promoteScratch(project, args.source_scratch!, args.part_id!, args.chapter_id!, args.beat_id!),
              `Promoted scratch/${args.source_scratch} → ${args.part_id}/${args.chapter_id}:${args.beat_id}`
            );
            return jsonResult(results);
          }

          if (args.content === undefined) throw new Error("content is required for target='beat' (or provide source_scratch)");
          const result = await withCommit(
            root,
            () => store.writeBeatProse(project, args.part_id!, args.chapter_id!, args.beat_id!, args.content!, args.append ?? false),
            `${args.append ? "Appended variant to" : "Updated"} ${args.part_id}/${args.chapter_id} beat ${args.beat_id} prose`
          );
          return jsonResult(result);
        }
        case "canon": {
          if (!args.type) throw new Error("type is required for target='canon'");
          if (!args.id) throw new Error("id is required for target='canon'");
          if (args.content === undefined) throw new Error("content is required for target='canon'");
          const root = store.projectRoot(project);
          const results = await withCommit(
            root,
            () => store.updateCanon(project, args.type!, args.id!, args.content!, args.meta, args.append ?? false),
            `${args.append ? "Appended to" : "Canon update:"} ${args.type}/${args.id}`
          );
          return jsonResult(results);
        }
        case "part_notes": {
          requireArgs(args, ["part_id"], "target='part_notes'");
          if (args.content === undefined) throw new Error("content is required for target='part_notes'");
          const root = store.projectRoot(project);
          const result = await withCommit(
            root,
            () => store.writePartNotes(project, args.part_id!, args.content!, args.append ?? false),
            `${args.append ? "Appended to" : "Updated"} part notes: ${args.part_id}`
          );
          return jsonResult(result);
        }
        case "chapter_notes": {
          requireArgs(args, ["part_id", "chapter_id"], "target='chapter_notes'");
          if (args.content === undefined) throw new Error("content is required for target='chapter_notes'");
          const root = store.projectRoot(project);
          const result = await withCommit(
            root,
            () => store.writeChapterNotes(project, args.part_id!, args.chapter_id!, args.content!, args.append ?? false),
            `${args.append ? "Appended to" : "Updated"} chapter notes: ${args.part_id}/${args.chapter_id}`
          );
          return jsonResult(result);
        }
      }
    } catch (err) {
      logToolError("write", err);
      throw err;
    }
  });

  // =========================================================================
  // edit — consolidated from edit_beat_prose, edit_canon
  // =========================================================================

  server.registerTool("edit", {
    title: "Edit",
    description:
      "Surgical string replacement within existing content. Supports multiple ordered " +
      "find/replace pairs, applied atomically — if any edit fails, none are applied. " +
      "Use instead of write when changing words or sentences rather than rewriting.",
    inputSchema: {
      target: z.enum(["beat", "canon", "part_notes", "chapter_notes"]).describe("What to edit"),
      project: projectParam,
      edits: z.array(z.object({
        old_str: z.string().describe("Exact text to find (must match exactly once)"),
        new_str: z.string().describe("Replacement text (empty string = deletion)"),
      })).describe("Ordered list of find/replace pairs. Applied sequentially — edit 2 sees the result of edit 1."),
      part_id: z.string().optional().describe("Part identifier (beat, part_notes, chapter_notes)"),
      chapter_id: z.string().optional().describe("Chapter identifier (beat, chapter_notes)"),
      beat_id: z.string().optional().describe("Beat identifier (beat only)"),
      variant_index: z.number().optional().describe("Which variant to edit, default 0 (beat only)"),
      type: z.string().optional().describe("Canon type directory name, e.g. 'characters' (canon only)"),
      id: z.string().optional().describe("Canon entry id (canon only)"),
    },
  }, async (args) => {
    const { target, project, edits } = args;
    logToolCall("edit", { target, project, edits_count: edits.length });
    try {
      const root = store.projectRoot(project);
      switch (target) {
        case "beat": {
          requireArgs(args, ["part_id", "chapter_id", "beat_id"], "target='beat'");
          const outcome = await store.editBeatProse(
            project, args.part_id!, args.chapter_id!, args.beat_id!, edits, args.variant_index ?? 0
          );
          await commitFiles(root, [outcome.result.path],
            `Edited ${args.part_id}/${args.chapter_id}:${args.beat_id} (${outcome.edits_applied} edits)`);
          return jsonResult(outcome);
        }
        case "canon": {
          if (!args.type) throw new Error("type is required for target='canon'");
          if (!args.id) throw new Error("id is required for target='canon'");
          const outcome = await store.editCanon(project, args.type, args.id, edits);
          await commitFiles(root, [outcome.result.path],
            `Edited canon/${args.type}/${args.id} (${outcome.edits_applied} edits)`);
          return jsonResult(outcome);
        }
        case "part_notes": {
          requireArgs(args, ["part_id"], "target='part_notes'");
          const outcome = await store.editPartNotes(project, args.part_id!, edits);
          await commitFiles(root, [outcome.result.path],
            `Edited part notes: ${args.part_id} (${outcome.edits_applied} edits)`);
          return jsonResult(outcome);
        }
        case "chapter_notes": {
          requireArgs(args, ["part_id", "chapter_id"], "target='chapter_notes'");
          const outcome = await store.editChapterNotes(project, args.part_id!, args.chapter_id!, edits);
          await commitFiles(root, [outcome.result.path],
            `Edited chapter notes: ${args.part_id}/${args.chapter_id} (${outcome.edits_applied} edits)`);
          return jsonResult(outcome);
        }
      }
    } catch (err) {
      logToolError("edit", err);
      throw err;
    }
  });

  // =========================================================================
  // remove — consolidated from remove_beat, resolve_notes
  // =========================================================================

  server.registerTool("remove", {
    title: "Remove",
    description:
      "Remove content. target='beat' removes a beat from a chapter (prose moved to scratch). " +
      "target='redlines' batch-removes inline redlines by ID after they've been addressed.",
    inputSchema: {
      target: z.enum(["beat", "redlines"]).describe("What to remove"),
      project: projectParam,
      part_id: z.string().optional().describe("Part identifier (beat only)"),
      chapter_id: z.string().optional().describe("Chapter identifier (beat only)"),
      beat_id: z.string().optional().describe("Beat identifier to remove (beat only)"),
      redline_ids: z.array(z.string()).optional().describe("Redline IDs to resolve (redlines only), e.g. ['part-01/chapter-03:b02:n47']. Get these from get_context with redlines include."),
    },
  }, async (args) => {
    const { target, project } = args;
    logToolCall("remove", { target, project });
    try {
      const root = store.projectRoot(project);
      switch (target) {
        case "beat": {
          requireArgs(args, ["part_id", "chapter_id", "beat_id"], "target='beat'");
          const results = await withCommit(
            root,
            () => store.removeBeat(project, args.part_id!, args.chapter_id!, args.beat_id!),
            `Removed beat ${args.beat_id} from ${args.part_id}/${args.chapter_id} (prose → scratch)`
          );
          return jsonResult(results);
        }
        case "redlines": {
          if (!args.redline_ids || args.redline_ids.length === 0) {
            return textResult("No redline IDs provided. Nothing to resolve.");
          }
          const results = await store.removeRedlineLines(project, args.redline_ids);
          if (results.length > 0) {
            await commitFiles(root, results.map((r) => r.path),
              `Resolved ${args.redline_ids.length} redline(s)`);
          }
          return jsonResult({ resolved: args.redline_ids.length, files_modified: results.length });
        }
      }
    } catch (err) {
      logToolError("remove", err);
      throw err;
    }
  });

  // =========================================================================
  // select_variant — specialized (renamed from select_beat_variant)
  // =========================================================================

  server.registerTool("select_variant", {
    title: "Select Variant",
    description: "Pick one variant of a beat as the winner, archive the rest to scratch. Use get_context with beat_variants include first to see all variants and decide which to keep.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      keep_index: z.number().describe("Zero-based index of the variant to keep (from get_context beat_variants)"),
    },
  }, async ({ project, part_id, chapter_id, beat_id, keep_index }) => {
    logToolCall("select_variant", { project, part_id, chapter_id, beat_id, keep_index });
    try {
      const root = store.projectRoot(project);
      const outcome = await store.selectBeatVariant(project, part_id, chapter_id, beat_id, keep_index);
      if (outcome.results.length > 0) {
        await commitFiles(root, outcome.results.map((r) => r.path),
          `Selected variant ${keep_index} for ${part_id}/${chapter_id}:${beat_id}`);
      }
      return jsonResult({ kept: outcome.kept, archived: outcome.archived, files: outcome.results });
    } catch (err) {
      logToolError("select_variant", err);
      throw err;
    }
  });

  // =========================================================================
  // reorder_beats — specialized (unchanged)
  // =========================================================================

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
      await commitFiles(root, outcome.results.map((r) => r.path),
        `Reordered beats in ${part_id}/${chapter_id}: ${beat_order.join(", ")}`);
      return jsonResult({ previous_order: outcome.previous_order, new_order: outcome.new_order, files: outcome.results });
    } catch (err) {
      logToolError("reorder_beats", err);
      throw err;
    }
  });

  // =========================================================================
  // session_summary — standalone git operation
  // =========================================================================

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

  // =========================================================================
  // refresh_summaries — migration from legacy meta to markdown-first
  // =========================================================================

  server.registerTool("refresh_summaries", {
    title: "Migrate Chapter to Markdown-First",
    description:
      "Migrate a chapter from legacy full-fat .meta.json to markdown-first format. " +
      "Moves summaries, labels, and status from JSON into the .md file as structured comments. " +
      "Slims the .meta.json to navigation-only data (characters, dirty_reason). " +
      "Safe to run multiple times — skips already-migrated chapters.",
    inputSchema: {
      project: projectParam,
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
    },
  }, async ({ project, part_id, chapter_id }) => {
    logToolCall("refresh_summaries", { project, part_id, chapter_id });
    try {
      const root = store.projectRoot(project);
      const paths = await store.migrateChapterToMarkdownFirst(project, part_id, chapter_id);
      if (paths.length === 0) {
        return textResult("Chapter is already in markdown-first format.");
      }
      await commitFiles(root, paths, `Migrated ${part_id}/${chapter_id} to markdown-first format`);
      return textResult(`Migrated ${part_id}/${chapter_id} to markdown-first format. Updated: ${paths.join(", ")}`);
    } catch (err) {
      logToolError("refresh_summaries", err);
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
    version: PKG_VERSION,
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
    description: "Fractal narrative MCP server — 12 consolidated tools (multi-project)",
    projects_root: store.getProjectsRoot(),
    note: "All tools except list_projects and template (list/get/save) require a 'project' parameter.",
    tools: {
      list_projects: "List all available projects with status briefing.",
      template: "Manage templates. action: list | get | save | apply. Only 'apply' needs a project param.",
      get_context: "Primary read tool — returns any combination of project data in one call, including search. Supports: project_meta, parts, chapter_meta, chapter_prose, beats, beat_variants, canon (with # section notation), scratch, scratch_index, dirty_nodes, redlines, canon_list, guide, search.",
      create: "Create entities. target: project | part | chapter | beat | scratch | redline.",
      update: "Update metadata. target: project | part | chapter | node (dirty/clean).",
      write: "Write/replace content. target: beat | canon | part_notes | chapter_notes. append=true to add content to end of notes/canon.",
      edit: "Surgical find/replace. target: beat | canon | part_notes | chapter_notes. Atomic ordered edits.",
      remove: "Remove content. target: beat (prose → scratch) | redlines (resolve redlines).",
      select_variant: "Keep one variant of a beat, archive the rest to scratch.",
      reorder_beats: "Reorder beats within a chapter. Meta and prose updated together.",
      session_summary: "Create a session-level git commit summarizing the working session.",
      refresh_summaries: "Migrate legacy meta to markdown-first format.",
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
          sessions.delete(sid);
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

async function gracefulShutdown() {
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
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

main();
