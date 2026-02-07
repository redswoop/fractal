# Fringe — MCP Connector

Minimal remote MCP server for Claude.ai custom connectors. One tool (`hello`), Streamable HTTP transport, ready to extend with writing tools and Framehouse integration.

## Quick start

```bash
# Dev mode (auto-reloads)
npm run dev

# Production
npm run build && npm start

# Or with PM2
npm run build && pm2 start ecosystem.config.js
```

## Verify it works

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Connect to Claude.ai

1. Deploy to your NAS behind HTTPS (see reverse proxy section below)
2. Verify: `curl https://mcp.yourdomain.com/health` returns `{"status":"ok"}`
3. In Claude.ai: click **+** → **Connectors** → **Add custom connector**
4. Enter `https://mcp.yourdomain.com/mcp` as the server URL
5. Enable the connector in a conversation
6. Ask Claude: *"Use the hello tool to say hi"*

## Reverse proxy setup (NAS-side)

The server runs plain HTTP on port 3001. HTTPS termination is handled by your NAS reverse proxy.

Example nginx config:

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Project structure

```
src/server.ts       — The entire MCP server (one file)
ecosystem.config.js — PM2 process manager config
```

## Tools

| Tool    | Description                          |
|---------|--------------------------------------|
| `hello` | Proof-of-life greeting. Takes optional `name` param. |

## Adding more tools

Edit `createMcpServer()` in `src/server.ts` and register additional tools:

```typescript
server.registerTool("get_chapter", {
  description: "Return chapter text",
  inputSchema: {
    chapter_id: z.string().describe("Chapter identifier"),
  },
}, async ({ chapter_id }) => {
  // your implementation
});
```
