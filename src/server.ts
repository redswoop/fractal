/**
 * Fringe — MCP Server for fractal narrative management
 *
 * Remote MCP server that Claude.ai connects to as a custom connector.
 * Streamable HTTP transport over Fastify.
 *
 * Architecture:
 *   Claude.ai  -->  HTTPS (reverse proxy)  -->  HTTP (this server, port 3001)
 *
 * Tools implement the full read/write interface defined in claude.md,
 * with automatic git commits on every write operation.
 */

import { randomUUID } from "node:crypto";
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
// Helper: wrap write operations with auto-commit
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

async function withCommit<T extends store.WriteResult | store.WriteResult[]>(
  fn: () => Promise<T>,
  commitMessage: string
): Promise<T> {
  const result = await fn();
  const results = Array.isArray(result) ? result : [result];
  const root = store.getProjectRoot();
  const files = results.map((r) => r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path);
  await autoCommit(files, commitMessage);
  return result;
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "fringe",
    version: "1.0.0",
  });

  // ===== HELLO (proof of life) =====

  server.registerTool("hello", {
    title: "Hello",
    description: "Say hello. Use this to verify the MCP connector is working.",
    inputSchema: {
      name: z.string().optional().describe("Who to greet"),
    },
  }, async ({ name }) => {
    const who = name ?? "Captain";
    return textResult(`Hello from Fringe, ${who}! The connector is alive and the velvet-bond project is loaded.`);
  });

  // =================================================================
  // READ OPERATIONS
  // =================================================================

  server.registerTool("get_project", {
    title: "Get Project",
    description: "Returns the top-level project.json — title, logline, status, themes, parts list.",
    inputSchema: {},
  }, async () => {
    const data = await store.getProject();
    return jsonResult(data);
  });

  server.registerTool("get_part", {
    title: "Get Part",
    description: "Returns a part's metadata — title, summary, arc, status, chapter list.",
    inputSchema: {
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
    },
  }, async ({ part_id }) => {
    const data = await store.getPart(part_id);
    return jsonResult(data);
  });

  server.registerTool("get_chapter_meta", {
    title: "Get Chapter Meta",
    description: "Returns a chapter's metadata — title, summary, POV, location, timeline position, beat index with statuses and summaries.",
    inputSchema: {
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-01'"),
    },
  }, async ({ part_id, chapter_id }) => {
    const data = await store.getChapterMeta(part_id, chapter_id);
    return jsonResult(data);
  });

  server.registerTool("get_chapter_prose", {
    title: "Get Chapter Prose",
    description: "Returns the full markdown prose of a chapter, including beat markers.",
    inputSchema: {
      part_id: z.string().describe("Part identifier, e.g. 'part-01'"),
      chapter_id: z.string().describe("Chapter identifier, e.g. 'chapter-01'"),
    },
  }, async ({ part_id, chapter_id }) => {
    const data = await store.getChapterProse(part_id, chapter_id);
    return textResult(data);
  });

  server.registerTool("get_beat_prose", {
    title: "Get Beat Prose",
    description: "Extracts just one beat's prose from a chapter file.",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier, e.g. 'b01'"),
    },
  }, async ({ part_id, chapter_id, beat_id }) => {
    const data = await store.getBeatProse(part_id, chapter_id, beat_id);
    return jsonResult(data);
  });

  server.registerTool("get_canon", {
    title: "Get Canon",
    description: "Returns a canon file (character, location, etc.) and its metadata sidecar.",
    inputSchema: {
      type: z.string().describe("Canon type: 'characters', 'locations'"),
      id: z.string().describe("Canon entry id, e.g. 'emmy', 'the-gallery'"),
    },
  }, async ({ type, id }) => {
    const data = await store.getCanon(type, id);
    return jsonResult(data);
  });

  server.registerTool("list_canon", {
    title: "List Canon",
    description: "Lists all canon entries of a given type.",
    inputSchema: {
      type: z.string().describe("Canon type: 'characters', 'locations'"),
    },
  }, async ({ type }) => {
    const entries = await store.listCanon(type);
    return jsonResult(entries);
  });

  server.registerTool("get_scratch_index", {
    title: "Get Scratch Index",
    description: "Returns the scratch folder index — loose scenes, dialogue riffs, ideas that don't have a home yet.",
    inputSchema: {},
  }, async () => {
    const data = await store.getScratchIndex();
    return jsonResult(data);
  });

  server.registerTool("get_scratch", {
    title: "Get Scratch",
    description: "Returns the content of a scratch file.",
    inputSchema: {
      filename: z.string().describe("Scratch filename, e.g. 'emmy-rooftop-scene.md'"),
    },
  }, async ({ filename }) => {
    const data = await store.getScratch(filename);
    return textResult(data);
  });

  server.registerTool("search", {
    title: "Search",
    description: "Full-text search across prose, canon, and scratch files. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      query: z.string().describe("Search query (case-insensitive)"),
      scope: z.enum(["prose", "canon", "scratch"]).optional().describe("Limit search to a specific scope"),
    },
  }, async ({ query, scope }) => {
    const results = await store.search(query, scope);
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
    inputSchema: {},
  }, async () => {
    const nodes = await store.getDirtyNodes();
    if (nodes.length === 0) {
      return textResult("All clean. No dirty or conflicted nodes.");
    }
    return jsonResult(nodes);
  });

  // =================================================================
  // WRITE OPERATIONS
  // =================================================================

  server.registerTool("update_project", {
    title: "Update Project",
    description: "Update top-level project metadata (title, logline, status, themes, parts list).",
    inputSchema: {
      patch: z.string().describe("JSON string of fields to update in project.json"),
    },
  }, async ({ patch }) => {
    const patchObj = JSON.parse(patch);
    const result = await withCommit(
      () => store.updateProject(patchObj),
      `Updated project: ${Object.keys(patchObj).join(", ")}`
    );
    return jsonResult(result);
  });

  server.registerTool("update_part", {
    title: "Update Part",
    description: "Update a part's metadata (title, summary, arc, status, chapters list).",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      patch: z.string().describe("JSON string of fields to update in part.json"),
    },
  }, async ({ part_id, patch }) => {
    const patchObj = JSON.parse(patch);
    const result = await withCommit(
      () => store.updatePart(part_id, patchObj),
      `Updated ${part_id}: ${Object.keys(patchObj).join(", ")}`
    );
    return jsonResult(result);
  });

  server.registerTool("update_chapter_meta", {
    title: "Update Chapter Meta",
    description: "Update a chapter's metadata — beat summaries, status, dependencies, or chapter-level fields.",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      patch: z.string().describe("JSON string of fields to update in chapter meta"),
    },
  }, async ({ part_id, chapter_id, patch }) => {
    const patchObj = JSON.parse(patch);
    const result = await withCommit(
      () => store.updateChapterMeta(part_id, chapter_id, patchObj),
      `Updated ${part_id}/${chapter_id} meta: ${Object.keys(patchObj).join(", ")}`
    );
    return jsonResult(result);
  });

  server.registerTool("write_beat_prose", {
    title: "Write Beat Prose",
    description: "Insert or replace the prose content for a specific beat in a chapter.",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier"),
      content: z.string().describe("The prose content for this beat"),
    },
  }, async ({ part_id, chapter_id, beat_id, content }) => {
    const result = await withCommit(
      () => store.writeBeatProse(part_id, chapter_id, beat_id, content),
      `Updated ${part_id}/${chapter_id} beat ${beat_id} prose`
    );
    return jsonResult(result);
  });

  server.registerTool("add_beat", {
    title: "Add Beat",
    description: "Add a new beat to a chapter's structure (both the markdown marker and the meta entry).",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat: z.string().describe("JSON string of the beat definition (id, label, summary, status, characters, depends_on, depended_by)"),
      after_beat_id: z.string().optional().describe("Insert after this beat ID. If omitted, appends to end."),
    },
  }, async ({ part_id, chapter_id, beat, after_beat_id }) => {
    const beatDef = JSON.parse(beat);
    const results = await withCommit(
      () => store.addBeat(part_id, chapter_id, beatDef, after_beat_id),
      `Added beat ${beatDef.id} to ${part_id}/${chapter_id}`
    );
    return jsonResult(results);
  });

  server.registerTool("remove_beat", {
    title: "Remove Beat",
    description: "Remove a beat from a chapter. Prose is moved to scratch for safekeeping.",
    inputSchema: {
      part_id: z.string().describe("Part identifier"),
      chapter_id: z.string().describe("Chapter identifier"),
      beat_id: z.string().describe("Beat identifier to remove"),
    },
  }, async ({ part_id, chapter_id, beat_id }) => {
    const results = await withCommit(
      () => store.removeBeat(part_id, chapter_id, beat_id),
      `Removed beat ${beat_id} from ${part_id}/${chapter_id} (prose → scratch)`
    );
    return jsonResult(results);
  });

  server.registerTool("mark_dirty", {
    title: "Mark Dirty",
    description: "Flag a node (part, chapter, or beat) as needing review due to upstream changes.",
    inputSchema: {
      node_ref: z.string().describe("Node reference, e.g. 'part-01', 'part-01/chapter-02', 'part-01/chapter-02:b03'"),
      reason: z.string().describe("Why this node is dirty, e.g. 'emmy.md canon updated: tattoo backstory changed'"),
    },
  }, async ({ node_ref, reason }) => {
    const results = await withCommit(
      () => store.markDirty(node_ref, reason),
      `Marked ${node_ref} dirty (${reason})`
    );
    return jsonResult(results);
  });

  server.registerTool("mark_clean", {
    title: "Mark Clean",
    description: "Clear dirty status after reviewing a node.",
    inputSchema: {
      node_ref: z.string().describe("Node reference to mark clean"),
    },
  }, async ({ node_ref }) => {
    const results = await withCommit(
      () => store.markClean(node_ref),
      `Marked ${node_ref} clean`
    );
    return jsonResult(results);
  });

  server.registerTool("update_canon", {
    title: "Update Canon",
    description: "Create or rewrite a canon file (character, location, etc.).",
    inputSchema: {
      type: z.string().describe("Canon type: 'characters', 'locations'"),
      id: z.string().describe("Canon entry id"),
      content: z.string().describe("Full markdown content for the canon file"),
      meta: z.string().optional().describe("Optional JSON string of metadata for the sidecar"),
    },
  }, async ({ type, id, content, meta }) => {
    const metaObj = meta ? JSON.parse(meta) : undefined;
    const results = await withCommit(
      () => store.updateCanon(type, id, content, metaObj),
      `Canon update: ${type}/${id}.md`
    );
    return jsonResult(results);
  });

  server.registerTool("add_scratch", {
    title: "Add Scratch",
    description: "Add a new file to the scratch folder (loose scenes, ideas, dialogue riffs).",
    inputSchema: {
      filename: z.string().describe("Filename for the scratch file, e.g. 'emmy-bar-scene.md'"),
      content: z.string().describe("Content of the scratch file"),
      note: z.string().describe("Note about what this is and where it might go"),
      characters: z.array(z.string()).optional().describe("Characters involved"),
      mood: z.string().optional().describe("Mood/tone description"),
      potential_placement: z.string().optional().describe("Where this might end up, e.g. 'part-01/chapter-04'"),
    },
  }, async ({ filename, content, note, characters, mood, potential_placement }) => {
    const results = await withCommit(
      () => store.addScratch(filename, content, note, characters ?? [], mood ?? "", potential_placement ?? null),
      `Added scratch: ${filename}`
    );
    return jsonResult(results);
  });

  server.registerTool("promote_scratch", {
    title: "Promote Scratch",
    description: "Move a scratch file's content into a beat in the narrative structure.",
    inputSchema: {
      filename: z.string().describe("Scratch filename to promote"),
      target_part_id: z.string().describe("Target part identifier"),
      target_chapter_id: z.string().describe("Target chapter identifier"),
      target_beat_id: z.string().describe("Target beat identifier"),
    },
  }, async ({ filename, target_part_id, target_chapter_id, target_beat_id }) => {
    const results = await withCommit(
      () => store.promoteScratch(filename, target_part_id, target_chapter_id, target_beat_id),
      `Promoted scratch/${filename} → ${target_part_id}/${target_chapter_id}:${target_beat_id}`
    );
    return jsonResult(results);
  });

  server.registerTool("session_summary", {
    title: "Session Summary",
    description: "Create a session-level git commit summarizing what was done in this working session.",
    inputSchema: {
      message: z.string().describe("Summary of what was accomplished in this session"),
    },
  }, async ({ message }) => {
    const hash = await sessionCommit(message);
    if (hash) {
      return textResult(`Session commit created: ${hash} — ${message}`);
    }
    return textResult("Nothing to commit — no changes since last commit.");
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
  return { status: "ok", project: "velvet-bond" };
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
    await ensureGitRepo();

    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\nFringe MCP server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Health check: http://localhost:${PORT}/health`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`  Project root: ${store.getProjectRoot()}\n`);
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
