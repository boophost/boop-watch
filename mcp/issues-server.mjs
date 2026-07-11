#!/usr/bin/env node
// Dual-mode driver for GitHub Issues — the tracker for both boop-watch and link.
//
//   node mcp/issues-server.mjs            -> stdio MCP server (for Claude Code)
//   node mcp/issues-server.mjs <cmd> ...  -> one-shot CLI (for quick iteration)
//
// Unlike flows-server.mjs there's no HTTP client to mint a token against: this
// shells out to `gh`, which already holds credentials. Engineering work lives in
// per-repo issues; the org Project (boophost/projects/1) is the shared board.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const DEFAULT_REPO = process.env.ISSUES_REPO || 'boophost/boop-watch'
const PROJECT = process.env.ISSUES_PROJECT || 'boop'
const PROJECT_OWNER = process.env.ISSUES_PROJECT_OWNER || 'boophost'
const PROJECT_NUMBER = process.env.ISSUES_PROJECT_NUMBER || '1'

/** Run `gh` and return stdout. Surfaces gh's own stderr, which is the useful part. */
async function gh(args) {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim()
    throw new Error(`gh ${args.join(' ')} → ${msg}`)
  }
}

const issues = {
  async list({ repo = DEFAULT_REPO, state = 'open', label, limit = 50 } = {}) {
    const args = ['issue', 'list', '--repo', repo, '--state', state, '--limit', String(limit),
      '--json', 'number,title,state,labels,url,createdAt']
    if (label) args.push('--label', label)
    return JSON.parse((await gh(args)) || '[]')
  },

  async get({ repo = DEFAULT_REPO, number }) {
    return JSON.parse(
      await gh(['issue', 'view', String(number), '--repo', repo,
        '--json', 'number,title,body,state,labels,url,comments,createdAt']),
    )
  },

  async create({ repo = DEFAULT_REPO, title, body = '', labels = [] }) {
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body]
    for (const l of labels) args.push('--label', l)
    const url = await gh(args)
    return { url, number: Number(url.split('/').pop()) }
  },

  async comment({ repo = DEFAULT_REPO, number, body }) {
    return { url: await gh(['issue', 'comment', String(number), '--repo', repo, '--body', body]) }
  },

  async label({ repo = DEFAULT_REPO, number, add = [], remove = [] }) {
    const args = ['issue', 'edit', String(number), '--repo', repo]
    for (const l of add) args.push('--add-label', l)
    for (const l of remove) args.push('--remove-label', l)
    return { url: await gh(args) }
  },

  async close({ repo = DEFAULT_REPO, number, comment }) {
    const args = ['issue', 'close', String(number), '--repo', repo]
    if (comment) args.push('--comment', comment)
    return { closed: await gh(args) }
  },

  async reopen({ repo = DEFAULT_REPO, number }) {
    return { reopened: await gh(['issue', 'reopen', String(number), '--repo', repo]) }
  },

  /** Add an issue to the org Project board. Needs the `project` gh scope. */
  async addToProject({ repo = DEFAULT_REPO, number }) {
    const url = `https://github.com/${repo}/issues/${number}`
    return { added: await gh(['project', 'item-add', PROJECT_NUMBER, '--owner', PROJECT_OWNER, '--url', url]) }
  },
}

// --------------------------------------------------------------------------
// CLI mode
// --------------------------------------------------------------------------
async function cli(argv) {
  const [cmd, ...rest] = argv
  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  // `--repo x` anywhere; everything else is positional.
  const ri = rest.indexOf('--repo')
  const repo = ri >= 0 ? rest.splice(ri, 2)[1] : DEFAULT_REPO

  switch (cmd) {
    case 'list': {
      const li = rest.indexOf('--label')
      const label = li >= 0 ? rest.splice(li, 2)[1] : undefined
      const state = rest[0] || 'open'
      const list = await issues.list({ repo, state, label })
      out(
        list
          .map((i) => `#${i.number}  [${i.state}]  ${i.title}${i.labels.length ? '  {' + i.labels.map((l) => l.name).join(',') + '}' : ''}`)
          .join('\n') || '(no issues)',
      )
      return
    }
    case 'get':
      out(await issues.get({ repo, number: rest[0] }))
      return
    case 'create':
      // create <title> <body> [label...]
      out(await issues.create({ repo, title: rest[0], body: rest[1] ?? '', labels: rest.slice(2) }))
      return
    case 'comment':
      out(await issues.comment({ repo, number: rest[0], body: rest[1] }))
      return
    case 'label':
      // label <number> <add,add> [remove,remove]
      out(await issues.label({
        repo,
        number: rest[0],
        add: (rest[1] || '').split(',').filter(Boolean),
        remove: (rest[2] || '').split(',').filter(Boolean),
      }))
      return
    case 'close':
      out(await issues.close({ repo, number: rest[0], comment: rest[1] }))
      return
    case 'reopen':
      out(await issues.reopen({ repo, number: rest[0] }))
      return
    case 'project-add':
      out(await issues.addToProject({ repo, number: rest[0] }))
      return
    default:
      console.error(`usage: issues-server.mjs <list|get|create|comment|label|close|reopen|project-add> [--repo owner/name] ...
  (no args) -> run as an MCP stdio server
  default repo: ${DEFAULT_REPO}   project: ${PROJECT_OWNER}/${PROJECT}`)
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

  const server = new McpServer({ name: 'boop-issues', version: '1.0.0' })
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
  const wrap = (fn) => async (args) => {
    try {
      return text(await fn(args))
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }
    }
  }
  const repo = z.string().optional().describe(`owner/name; defaults to ${DEFAULT_REPO}. Use boophost/link for platform work.`)

  server.registerTool(
    'list_issues',
    {
      description: 'List issues. Suggestions from portal users carry the `suggestion` label.',
      inputSchema: { repo, state: z.enum(['open', 'closed', 'all']).optional(), label: z.string().optional(), limit: z.number().int().optional() },
    },
    wrap((a) => issues.list(a)),
  )
  server.registerTool(
    'get_issue',
    { description: 'Get one issue with its body, labels, and comments.', inputSchema: { repo, number: z.number().int() } },
    wrap((a) => issues.get(a)),
  )
  server.registerTool(
    'create_issue',
    { description: 'File an issue.', inputSchema: { repo, title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional() } },
    wrap((a) => issues.create(a)),
  )
  server.registerTool(
    'comment_issue',
    { description: 'Add a comment to an issue.', inputSchema: { repo, number: z.number().int(), body: z.string() } },
    wrap((a) => issues.comment(a)),
  )
  server.registerTool(
    'label_issue',
    { description: 'Add and/or remove labels on an issue.', inputSchema: { repo, number: z.number().int(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() } },
    wrap((a) => issues.label(a)),
  )
  server.registerTool(
    'close_issue',
    { description: 'Close an issue, optionally with a closing comment.', inputSchema: { repo, number: z.number().int(), comment: z.string().optional() } },
    wrap((a) => issues.close(a)),
  )
  server.registerTool(
    'reopen_issue',
    { description: 'Reopen a closed issue.', inputSchema: { repo, number: z.number().int() } },
    wrap((a) => issues.reopen(a)),
  )
  server.registerTool(
    'add_to_project',
    { description: `Add an issue to the org Project board (${PROJECT_OWNER}/${PROJECT}).`, inputSchema: { repo, number: z.number().int() } },
    wrap((a) => issues.addToProject(a)),
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
