# Flow MCP server / CLI

A local driver for the admin flow API (`server/flowRoutes.ts`) so flows can be
authored, inspected, and run without clicking through the `/manage` editor. It is
**not** part of the app image — it runs on your workstation and talks to a
deployment's REST API.

## Setup

1. Port-forward the staging backend (the flow API is admin-only and LAN-scoped):

   ```bash
   kubectl -n link-apps port-forward deploy/boop-watch-dev 8080:3000
   ```

2. Provide an admin credential in `mcp/flows.env` (gitignored). The flow API
   accepts a `JWT_SECRET`-signed token; mint one by giving the server the same
   secret the deployment uses:

   ```bash
   # BOOP_API defaults to http://localhost:8080, BOOP_ADMIN_EMAIL to the default admin
   printf 'BOOP_JWT_SECRET=%s\n' \
     "$(kubectl -n link-apps exec deploy/boop-watch-dev -- printenv [REDACTED])" \
     >> mcp/flows.env
   ```

   Alternatively set `BOOP_TOKEN=<a real Supabase access token>`.

## CLI (works in a live session — no restart)

```bash
node mcp/flows-server.mjs whoami
node mcp/flows-server.mjs node-types
node mcp/flows-server.mjs list
node mcp/flows-server.mjs get 2
node mcp/flows-server.mjs create "My flow" "description"
node mcp/flows-server.mjs save 2 path/to/graph.json    # graph = {nodes, edges}
node mcp/flows-server.mjs run 2                         # dry run (no side effects)
node mcp/flows-server.mjs run 2 --live                  # real run
```

## MCP server (for Claude Code)

Registered in `.mcp.json` as `boop-flows`. Claude Code reads MCP config at
startup, so it becomes available **after a restart**. Tools: `node_types`,
`list_flows`, `get_flow`, `create_flow`, `save_flow`, `delete_flow`, `run_flow`.
