#!/usr/bin/env node
// Dual-mode driver for the boop-watch flow API.
//
//   node mcp/flows-server.mjs            -> stdio MCP server (for Claude Code)
//   node mcp/flows-server.mjs <cmd> ...  -> one-shot CLI (for quick iteration)
//
// The MCP server is registered in .mcp.json and becomes available to Claude
// Code after a restart (MCP config is read at startup). The CLI needs no
// restart, so it's the way to drive flows within a live session.

import { flows, cfg } from './flows-client.mjs'

// --------------------------------------------------------------------------
// CLI mode
// --------------------------------------------------------------------------
async function cli(argv) {
  const [cmd, ...rest] = argv
  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  switch (cmd) {
    case 'node-types': {
      const { nodeTypes } = await flows.nodeTypes()
      out(nodeTypes.map((n) => `${n.type}  [${n.category}]  ${n.label}`).join('\n'))
      return
    }
    case 'list': {
      const { flows: list } = await flows.list()
      out(list.map((f) => `#${f.id}  ${f.name}${f.description ? ' — ' + f.description : ''}`).join('\n') || '(no flows)')
      return
    }
    case 'get':
      out(await flows.get(rest[0]))
      return
    case 'create':
      out(await flows.create(rest[0], rest[1]))
      return
    case 'save': {
      // save <id> <graph.json>  — reads the graph document from a file.
      const fs = await import('node:fs')
      const graph = JSON.parse(fs.readFileSync(rest[1], 'utf8'))
      out(await flows.save(rest[0], { graph }))
      return
    }
    case 'delete':
      out(await flows.remove(rest[0]))
      return
    case 'run': {
      const dryRun = !rest.includes('--live')
      const { report } = await flows.run(rest[0], dryRun)
      out(report)
      return
    }
    case 'whoami':
      out({ ...cfg(), token: cfg().token ? '(set)' : '', secret: cfg().secret ? '(set)' : '' })
      return
    default:
      out('commands: node-types | list | get <id> | create <name> [desc] | save <id> <graph.json> | run <id> [--live] | delete <id> | whoami')
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

  const server = new McpServer({ name: 'boop-flows', version: '1.0.0' })
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
  const wrap = (fn) => async (args) => {
    try {
      return text(await fn(args))
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }
    }
  }

  server.registerTool(
    'node_types',
    { description: 'List every flow node spec (type, category, inputs/outputs, config fields).', inputSchema: {} },
    wrap(() => flows.nodeTypes()),
  )
  server.registerTool(
    'list_flows',
    { description: 'List saved flows (id, name, description).', inputSchema: {} },
    wrap(() => flows.list()),
  )
  server.registerTool(
    'get_flow',
    { description: 'Get one flow including its full graph ({nodes, edges}).', inputSchema: { id: z.number().int() } },
    wrap(({ id }) => flows.get(id)),
  )
  server.registerTool(
    'create_flow',
    { description: 'Create a new (empty) flow.', inputSchema: { name: z.string(), description: z.string().optional() } },
    wrap(({ name, description }) => flows.create(name, description)),
  )
  server.registerTool(
    'save_flow',
    {
      description: 'Update a flow. Pass graph as {nodes,edges}; name/description optional. The server validates the graph (unknown node types / bad edges / cycles are rejected).',
      inputSchema: {
        id: z.number().int(),
        name: z.string().optional(),
        description: z.string().optional(),
        graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }).optional(),
      },
    },
    wrap(({ id, name, description, graph }) => {
      const patch = {}
      if (name !== undefined) patch.name = name
      if (description !== undefined) patch.description = description
      if (graph !== undefined) patch.graph = graph
      return flows.save(id, patch)
    }),
  )
  server.registerTool(
    'delete_flow',
    { description: 'Delete a flow by id.', inputSchema: { id: z.number().int() } },
    wrap(({ id }) => flows.remove(id)),
  )
  server.registerTool(
    'run_flow',
    {
      description: 'Run a flow and return its per-node report. dryRun defaults true (sinks take no side effects). Set dryRun=false to actually send magnets / write files / import.',
      inputSchema: { id: z.number().int(), dryRun: z.boolean().optional() },
    },
    wrap(({ id, dryRun }) => flows.run(id, dryRun !== false)),
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
