# boop-watch MCP servers / CLIs

Local drivers so the project's surfaces can be operated from Claude Code (or a
shell) instead of clicking through a UI. There are three:

- **`boop-flows`** (`flows-server.mjs`) — author, inspect, and run flows.
- **`boop-issues`** (`issues-server.mjs`) — the **tracker**: list/file/label/close
  GitHub issues across `boophost/boop-watch` *and* `boophost/link`, and add them
  to the org Project board. This is where engineering work and user suggestions
  now live.
- **`boop-suggestions`** (`suggestions-server.mjs`) — the **pre-migration archive**
  of the SQLite suggestions board. Kept read-capable for history; new suggestions
  open GitHub issues instead, so reach for `boop-issues` for anything current.

`boop-flows` and `boop-suggestions` are **not** part of the app image — they run on
your workstation and talk to a deployment's REST API, and they **share the same
auth + `mcp/flows.env`** config (see Setup below). `boop-issues` needs no
`flows.env`: it shells out to `gh`, which already holds credentials (the Project
tools additionally need `gh auth refresh -s project`).

# Issues MCP server / CLI

```bash
node mcp/issues-server.mjs list                          # open issues on boop-watch
node mcp/issues-server.mjs list --label suggestion       # just the user suggestions
node mcp/issues-server.mjs list --repo boophost/link     # platform work
node mcp/issues-server.mjs list all                      # include closed
node mcp/issues-server.mjs get 199                       # body + labels + comments
node mcp/issues-server.mjs create "Title" "Body" bug p1  # trailing args are labels
node mcp/issues-server.mjs comment 199 "…"
node mcp/issues-server.mjs label 199 p0 p1               # add p0, remove p1
node mcp/issues-server.mjs close 199 "fixed in #204"
node mcp/issues-server.mjs project-add 199              # onto the org board
```

Override the defaults with `ISSUES_REPO` / `ISSUES_PROJECT_OWNER` /
`ISSUES_PROJECT_NUMBER`.

# Flow MCP server / CLI

A local driver for the admin flow API (`server/flowRoutes.ts`) so flows can be
authored, inspected, and run without clicking through the `/manage` editor.

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

# Suggestions MCP server / CLI

A driver for the admin suggestions API (`server/index.ts`) so portal user
suggestions can be triaged from Claude Code. It reuses the flow driver's auth and
`mcp/flows.env` (same setup as above). The user's suggestion text (`body`) is
**read-only** — everything else (kanban status, an admin `title`/`notes`,
duplicate links, and epic grouping) is editable.

## CLI (works in a live session — no restart)

```bash
node mcp/suggestions-server.mjs list                 # all suggestions, one line each
node mcp/suggestions-server.mjs list working          # filter by kanban column
node mcp/suggestions-server.mjs get 12                # one suggestion, full JSON
node mcp/suggestions-server.mjs status 12 working     # move across the board
node mcp/suggestions-server.mjs title 12 "OST rows shouldn't link out"
node mcp/suggestions-server.mjs note 12 "Fixed in #173; verify on staging"
node mcp/suggestions-server.mjs note 12 none          # clear notes (also: title … none)
node mcp/suggestions-server.mjs dup 15 12             # #15 is a duplicate of #12
node mcp/suggestions-server.mjs dup 15 none           # unlink the duplicate
node mcp/suggestions-server.mjs group 12 3            # attach #12 to epic #3
node mcp/suggestions-server.mjs group 12 none         # detach from its epic
node mcp/suggestions-server.mjs delete 12

# Epics — bundle related suggestions under one writeup.
node mcp/suggestions-server.mjs groups
node mcp/suggestions-server.mjs group-new "Navigation polish" "Back-button + page memory"
node mcp/suggestions-server.mjs group-edit 3 '{"description":"…"}'
node mcp/suggestions-server.mjs group-delete 3        # members are detached, not deleted
```

## MCP server (for Claude Code)

Registered in `.mcp.json` as `boop-suggestions` (available **after a restart**).
Tools: `list_suggestions`, `update_suggestion` (status/title/notes/duplicate/group
in one call), `mark_duplicate`, `assign_group`, `delete_suggestion`, and the epic
tools `list_groups`, `create_group`, `update_group`, `delete_group`.
