/**
 * Fringe — Minimal MCP Server (Streamable HTTP)
 *
 * This is a remote MCP server that Claude.ai can connect to as a custom connector.
 * It uses the Streamable HTTP transport (the protocol Claude.ai custom connectors speak).
 *
 * Architecture:
 *   Claude.ai  -->  HTTPS (your reverse proxy)  -->  HTTP (this server, port 3001)
 *
 * The server never initiates contact. Claude makes HTTP requests, we respond.
 * Three HTTP methods on /mcp, per the MCP spec:
 *   POST   — Client sends JSON-RPC messages (tool calls, initialization)
 *   GET    — Client opens an SSE stream to receive responses/notifications
 *   DELETE — Client terminates its session
 *
 * Each Claude.ai conversation gets its own session (transport + server instance).
 * Sessions are tracked in a map and cleaned up on disconnect.
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh MCP server instance with our tools registered.
 * Each session gets its own server so tool state is isolated.
 * When you add more tools later (Framehouse, writing tools, etc.),
 * register them in this function.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "fringe",
    version: "1.0.0",
  });

  // ------ Tools ------

  // "hello" — the proof-of-life tool. Takes an optional name, returns a greeting.
  server.registerTool("hello", {
    title: "Hello",
    description: "Say hello. Use this to verify the MCP connector is working.",
    inputSchema: {
      name: z.string().optional().describe("Who to greet"),
    },
  }, async ({ name }) => {
    const who = name ?? "Captain";
    return {
      content: [
        {
          type: "text" as const,
          text: `Hello from your writing tool, ${who}! The connector is alive.`,
        },
      ],
    };
  });

  // Future tools go here:
  // server.registerTool("get_chapter", { ... }, async (args) => { ... });
  // server.registerTool("get_generation_status", { ... }, async (args) => { ... });

  return server;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Each Claude.ai conversation establishes a session identified by a UUID.
 * We store the transport for each session so subsequent requests on the same
 * session reuse the same transport (which is already connected to its server).
 */
const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------

const app = Fastify({ logger: true });

// --- JSON body parser ---
// Claude.ai sends DELETE with Content-Type: application/json but an empty body.
// Fastify's default JSON parser rejects empty bodies, so we replace it with
// a lenient one that treats empty bodies as null.
app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  try {
    done(null, body ? JSON.parse(body as string) : null);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// --- CORS ---
// Claude.ai makes cross-origin requests from https://claude.ai to our server.
// Without CORS headers, the browser blocks all responses.
await app.register(cors, {
  origin: true, // Reflect the request origin
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
  exposedHeaders: ["mcp-session-id"],
});

// --- CORS on raw responses ---
// Fastify's reply.hijack() skips the normal response pipeline, which means
// CORS headers set by @fastify/cors are never sent. Since the MCP SDK writes
// directly to reply.raw, we must set CORS headers on the raw response BEFORE
// handing off to the SDK.
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
// Hit this to verify the server is reachable before wiring up MCP in Claude.ai.
// curl https://mcp.yourdomain.com/health
app.get("/health", async () => {
  return { status: "ok" };
});

// ---------------------------------------------------------------------------
// MCP endpoint — POST /mcp
// ---------------------------------------------------------------------------
// This is where Claude sends JSON-RPC requests (initialize, tools/call, etc.).
// On first contact (initialize), we create a new transport + server.
// On subsequent requests, we look up the transport by session ID.

app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;

  try {
    // --- Existing session: reuse transport ---
    if (sessionId && transports[sessionId]) {
      const transport = transports[sessionId]!;
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack(); // Tell Fastify we've taken over the response
    }

    // --- New session: must be an initialize request ---
    if (!sessionId && isInitializeRequest(request.body)) {
      const eventStore = new InMemoryEventStore();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          // Store transport so future requests on this session find it
          transports[sid] = transport;
          request.log.info(`Session initialized: ${sid}`);
        },
      });

      // Clean up when the session closes
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          request.log.info(`Session closed: ${sid}`);
          delete transports[sid];
        }
      };

      // Wire up: server <-> transport, then handle the request
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      return reply.hijack();
    }

    // --- Bad request: no session and not an init ---
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
// Claude opens a GET request to establish an SSE stream for receiving
// responses and server-initiated notifications.

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
// Claude sends DELETE to cleanly terminate a session.

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
    // Bind to 0.0.0.0 so the NAS reverse proxy can reach us
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\nFringe MCP server listening on http://0.0.0.0:${PORT}`);
    console.log(`  Health check: http://localhost:${PORT}/health`);
    console.log(`  MCP endpoint: http://localhost:${PORT}/mcp\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown — close all active transports
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
