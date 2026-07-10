#!/usr/bin/env node
// Dual-mode driver for the boop-watch suggestions API.
//
//   node mcp/suggestions-server.mjs            -> stdio MCP server (Claude Code)
//   node mcp/suggestions-server.mjs <cmd> ...  -> one-shot CLI (quick iteration)
//
// The MCP server is registered in .mcp.json as `boop-suggestions` and becomes
// available to Claude Code after a restart (MCP config is read at startup). The
// CLI needs no restart, so it's the way to triage suggestions within a live
// session. Auth/config are shared with the flow driver (see mcp/README.md).

import { suggestions, groups } from './suggestions-client.mjs'
import { cfg } from './flows-client.mjs'

const STATUSES = ['unread', 'todo', 'working', 'staged', 'done']

// One-line summary of a suggestion for list output.
function line(s) {
  const tags = []
  if (s.duplicate_of) tags.push(`dup#${s.duplicate_of}`)
  if (s.group_id) tags.push(`grp#${s.group_id}`)
  const tag = tags.length ? ` {${tags.join(',')}}` : ''
  const head = s.title ? `${s.title} — ` : ''
  const body = String(s.body).replace(/\s+/g, ' ').slice(0, 80)
  return `#${s.id} [${s.status}]${tag} ${head}${body}${body.length >= 80 ? '…' : ''}  (${s.email ?? s.user_id})`
}

// `none`/`null`/`-` clear a nullable field; otherwise pass through.
const asNullable = (v) => (v === 'none' || v === 'null' || v === '-' ? null : v)
const asRef = (v) => (asNullable(v) === null ? null : Number(v))

// --------------------------------------------------------------------------
// CLI mode
// --------------------------------------------------------------------------
async function cli(argv) {
  const [cmd, ...rest] = argv
  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  switch (cmd) {
    case 'list': {
      const { suggestions: rows } = await suggestions.list()
      const filter = STATUSES.includes(rest[0]) ? rest[0] : null
      const shown = filter ? rows.filter((r) => r.status === filter) : rows
      out(shown.map(line).join('\n') || '(no suggestions)')
      return
    }
    case 'get':
      out((await suggestions.list()).suggestions.find((r) => r.id === Number(rest[0])) ?? '(not found)')
      return
    case 'status':
      out((await suggestions.update(rest[0], { status: rest[1] })).suggestion)
      return
    case 'title':
      out((await suggestions.update(rest[0], { title: asNullable(rest.slice(1).join(' ')) })).suggestion)
      return
    case 'note':
      out((await suggestions.update(rest[0], { notes: asNullable(rest.slice(1).join(' ')) })).suggestion)
      return
    case 'dup':
      out((await suggestions.update(rest[0], { duplicate_of: asRef(rest[1]) })).suggestion)
      return
    case 'group':
      out((await suggestions.update(rest[0], { group_id: asRef(rest[1]) })).suggestion)
      return
    case 'delete':
      out(await suggestions.remove(rest[0]))
      return
    case 'groups': {
      const { groups: list } = await groups.list()
      out(
        list
          .map((g) => `#${g.id}  ${g.title}${g.description ? ' — ' + g.description.replace(/\s+/g, ' ') : ''}`)
          .join('\n') || '(no groups)',
      )
      return
    }
    case 'group-new':
      out((await groups.create(rest[0], rest.slice(1).join(' ') || null)).group)
      return
    case 'group-edit':
      // group-edit <id> <patchJson>  e.g. '{"title":"…","description":"…"}'
      out((await groups.update(rest[0], JSON.parse(rest[1]))).group)
      return
    case 'group-delete':
      out(await groups.remove(rest[0]))
      return
    case 'whoami':
      out({ ...cfg(), token: cfg().token ? '(set)' : '', secret: cfg().secret ? '(set)' : '' })
      return
    default:
      out(
        'commands:\n' +
          '  list [status] | get <id>\n' +
          '  status <id> <unread|todo|working|staged|done>\n' +
          '  title <id> <text…|none> | note <id> <text…|none>\n' +
          '  dup <id> <canonicalId|none> | group <id> <groupId|none> | delete <id>\n' +
          '  groups | group-new <title> [description…] | group-edit <id> <patchJson> | group-delete <id>\n' +
          '  whoami',
      )
      process.exit(cmd ? 1 : 0)
  }
}

// --------------------------------------------------------------------------
// MCP stdio server mode
// --------------------------------------------------------------------------
async function serve() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { z } = await import('zod')

  const server = new McpServer({ name: 'boop-suggestions', version: '1.0.0' })
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
  const wrap = (fn) => async (args) => {
    try {
      return text(await fn(args ?? {}))
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }
    }
  }

  server.registerTool(
    'list_suggestions',
    {
      description:
        'List portal user suggestions with their triage state, plus all epics. Each suggestion has: id, email, body (the user\'s verbatim words — read-only), status (unread|todo|working|staged|done kanban column), admin-authored title/notes, duplicate_of (canonical id), group_id (epic). Optionally filter by status.',
      inputSchema: { status: z.enum(['unread', 'todo', 'working', 'staged', 'done']).optional() },
    },
    wrap(async ({ status }) => {
      const data = await suggestions.list()
      return status ? { ...data, suggestions: data.suggestions.filter((s) => s.status === status) } : data
    }),
  )
  server.registerTool(
    'update_suggestion',
    {
      description:
        "Edit a suggestion's triage metadata. Any field is optional; only provided fields change. `body` is never editable. Set status to move it between kanban columns. title/notes are your triage writeup. Pass null for title/notes/duplicate_of/group_id to clear them.",
      inputSchema: {
        id: z.number().int(),
        status: z.enum(['unread', 'todo', 'working', 'staged', 'done']).optional(),
        title: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        duplicate_of: z.number().int().nullable().optional().describe('Canonical suggestion id this duplicates, or null to unlink'),
        group_id: z.number().int().nullable().optional().describe('Epic id to attach to, or null to detach'),
      },
    },
    wrap(({ id, ...patch }) => suggestions.update(id, patch)),
  )
  server.registerTool(
    'mark_duplicate',
    {
      description: 'Mark a suggestion as a duplicate of a canonical one (convenience for update_suggestion). Pass canonicalId=null to clear the duplicate link.',
      inputSchema: { id: z.number().int(), canonicalId: z.number().int().nullable() },
    },
    wrap(({ id, canonicalId }) => suggestions.update(id, { duplicate_of: canonicalId })),
  )
  server.registerTool(
    'assign_group',
    {
      description: 'Attach a suggestion to an epic (suggestion group), or pass groupId=null to detach it.',
      inputSchema: { id: z.number().int(), groupId: z.number().int().nullable() },
    },
    wrap(({ id, groupId }) => suggestions.update(id, { group_id: groupId })),
  )
  server.registerTool(
    'delete_suggestion',
    { description: 'Permanently delete a suggestion by id.', inputSchema: { id: z.number().int() } },
    wrap(({ id }) => suggestions.remove(id)),
  )

  // --- Epics (suggestion groups) ---
  server.registerTool(
    'list_groups',
    { description: 'List suggestion epics (id, title, description).', inputSchema: {} },
    wrap(() => groups.list()),
  )
  server.registerTool(
    'create_group',
    {
      description: 'Create an epic that related suggestions can be grouped under. Then use assign_group to add members.',
      inputSchema: { title: z.string(), description: z.string().optional() },
    },
    wrap(({ title, description }) => groups.create(title, description)),
  )
  server.registerTool(
    'update_group',
    {
      description: 'Rename an epic or rewrite its description.',
      inputSchema: { id: z.number().int(), title: z.string().optional(), description: z.string().nullable().optional() },
    },
    wrap(({ id, ...patch }) => groups.update(id, patch)),
  )
  server.registerTool(
    'delete_group',
    { description: 'Delete an epic. Its member suggestions are detached (group_id cleared), not deleted.', inputSchema: { id: z.number().int() } },
    wrap(({ id }) => groups.remove(id)),
  )

  await server.connect(new StdioServerTransport())
}

const args = process.argv.slice(2)
if (args.length > 0) {
  cli(args).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
} else {
  serve().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
