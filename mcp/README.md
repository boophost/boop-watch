# Flow MCP server / CLI

A local driver for the admin flow API (`server/flowRoutes.ts`) so flows can be
authored, inspected, and run without clicking through the `/manage` editor. It is
**not** part of the app image — it runs on your workstation and talks to a
deployment's REST API.

## Setup

1. Port-forward the staging backend (the flow API is admin-only):

   ```bash
   kubectl -n link-apps port-forward deploy/boop-watch-dev 8080:3000
   ```

2. Provide an admin credential in `mcp/flows.env` (gitignored), using secrets
   from your own deployment:

   ```bash
   BOOP_JWT_SECRET=<your deployment's JWT secret>
   BOOP_ADMIN_EMAIL=<an email allowed by your deployment's ADMIN_EMAILS>
   ```

   Alternatively, set `BOOP_TOKEN=<a real Supabase access token>` instead of
   `BOOP_JWT_SECRET` and `BOOP_ADMIN_EMAIL`. Homelab minting recipes live in the
   private [`boophost/boop-watch-ops`](https://github.com/boophost/boop-watch-ops)
   runbook (`mcp-credentials.md`).

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
node mcp/flows-server.mjs runs                          # activity log (recent runs)

# Schedules — run a flow on a repeat or once. kind/spec:
#   interval {every,unit:'minutes'|'hours'} | daily {at:'HH:MM'}
#   weekly {day:'sun'..'sat',at} | once {runAt:ISO}. Default dry-run.
node mcp/flows-server.mjs schedules
node mcp/flows-server.mjs schedule-create 2 interval '{"every":30,"unit":"minutes"}'
node mcp/flows-server.mjs schedule-create 2 weekly '{"day":"sun","at":"03:00"}' --live
node mcp/flows-server.mjs schedule-run 5                # run its flow now
node mcp/flows-server.mjs schedule-update 5 '{"enabled":false}'
node mcp/flows-server.mjs schedule-delete 5
```

## MCP server (for Claude Code)

Registered in `.mcp.json` as `boop-flows`. Claude Code reads MCP config at
startup, so it becomes available **after a restart**. Tools: `node_types`,
`list_flows`, `get_flow`, `create_flow`, `save_flow`, `delete_flow`, `run_flow`,
`list_runs` (activity log), and the scheduler: `list_schedules`,
`create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`.
