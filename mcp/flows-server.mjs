#!/usr/bin/env node
// Dual-mode driver for the boop-watch flow API.
//
//   node mcp/flows-server.mjs            -> stdio MCP server (for Claude Code)
//   node mcp/flows-server.mjs <cmd> ...  -> one-shot CLI (for quick iteration)
//
// The MCP server is registered in .mcp.json and becomes available to Claude
// Code after a restart (MCP config is read at startup). The CLI needs no
// restart, so it's the way to drive flows within a live session.

import { flows, schedules, cfg } from './flows-client.mjs'

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
      out(
        list
          .map((f) => `#${f.id}  ${f.enabled === false ? '[OFF]  ' : ''}${f.name}${f.description ? ' — ' + f.description : ''}`)
          .join('\n') || '(no flows)',
      )
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
    case 'enable':
    case 'disable': {
      // Automation switch: disabled flows are skipped by schedules and ignored
      // by event triggers; manual `run` still works.
      const { flow } = await flows.save(rest[0], { enabled: cmd === 'enable' })
      out(`#${flow.id}  ${flow.name}  automation ${flow.enabled ? 'on' : 'off'}`)
      return
    }
    case 'run': {
      const dryRun = !rest.includes('--live')
      const { report } = await flows.run(rest[0], dryRun)
      out(report)
      return
    }
    case 'runs': {
      const { runs } = await flows.runs(rest[0] ? Number(rest[0]) : 100)
      out(
        runs
          .map((r) => {
            const head = `${r.ok ? 'ok ' : 'ERR'} ${r.dry_run ? '[dry] ' : ''}${r.flow_name}  (${r.duration_ms}ms)  ${r.started_at}`
            const lines = r.activity.map((a) => `    · ${a.node}: ${a.notes.join(' | ') || a.error || ''}`)
            return [head, ...lines].join('\n')
          })
          .join('\n') || '(no runs)',
      )
      return
    }
    case 'schedules': {
      const { schedules: list } = await schedules.list()
      out(
        list
          .map(
            (s) =>
              `#${s.id}  flow ${s.flow_id}${s.flow_name ? ` (${s.flow_name})` : ''}  ${s.kind} ${JSON.stringify(s.spec)}  ${s.dry_run ? 'dry' : 'LIVE'}  ${s.enabled ? 'on' : 'off'}  next=${s.next_run ?? '—'}`,
          )
          .join('\n') || '(no schedules)',
      )
      return
    }
    case 'schedule-get':
      out(await schedules.get(rest[0]))
      return
    case 'schedule-create': {
      // schedule-create <flowId> <kind> <specJson> [--live] [--disabled]
      const [flowId, kind, specJson] = rest
      out(
        await schedules.create({
          flowId: Number(flowId),
          kind,
          spec: JSON.parse(specJson),
          dryRun: !rest.includes('--live'),
          enabled: !rest.includes('--disabled'),
        }),
      )
      return
    }
    case 'schedule-update':
      // schedule-update <id> <patchJson>
      out(await schedules.update(rest[0], JSON.parse(rest[1])))
      return
    case 'schedule-run':
      out(await schedules.run(rest[0]))
      return
    case 'schedule-delete':
      out(await schedules.remove(rest[0]))
      return
    case 'whoami':
      out({ ...cfg(), token: cfg().token ? '(set)' : '', secret: cfg().secret ? '(set)' : '' })
      return
    default:
      out(
        'commands:\n' +
          '  node-types | list | get <id> | create <name> [desc] | save <id> <graph.json> | run <id> [--live] | delete <id>\n' +
          '  enable <id> | disable <id>   (automation switch: schedules + event triggers; manual runs unaffected)\n' +
          '  runs [limit]\n' +
          '  schedules | schedule-get <id> | schedule-create <flowId> <kind> <specJson> [--live] [--disabled] | schedule-update <id> <patchJson> | schedule-run <id> | schedule-delete <id>\n' +
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
      description: 'Update a flow. Pass graph as {nodes,edges}; name/description optional. enabled=false turns automation off (schedules skip it, event triggers ignore it; manual runs still work). The server validates the graph (unknown node types / bad edges / cycles are rejected).',
      inputSchema: {
        id: z.number().int(),
        name: z.string().optional(),
        description: z.string().optional(),
        graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }).optional(),
        enabled: z.boolean().optional(),
      },
    },
    wrap(({ id, name, description, graph, enabled }) => {
      const patch = {}
      if (name !== undefined) patch.name = name
      if (description !== undefined) patch.description = description
      if (graph !== undefined) patch.graph = graph
      if (enabled !== undefined) patch.enabled = enabled
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
  server.registerTool(
    'list_runs',
    {
      description:
        'Read the rolling flow activity log (most recent first): one entry per run (editor, scheduler, or MCP) with ok/dry/duration and the distilled per-node notes.',
      inputSchema: { limit: z.number().int().optional() },
    },
    wrap(({ limit }) => flows.runs(limit ?? 100)),
  )

  // --- Schedules ---
  const specSchema = z
    .object({})
    .passthrough()
    .describe(
      "cadence spec by kind: interval {every,unit:'minutes'|'hours'} | daily {at:'HH:MM'} | weekly {day:'sun'..'sat',at} | once {runAt:ISO}",
    )
  server.registerTool(
    'list_schedules',
    { description: 'List scheduled flow runs (id, flow, kind/spec, dry/live, enabled, next_run).', inputSchema: {} },
    wrap(() => schedules.list()),
  )
  server.registerTool(
    'create_schedule',
    {
      description:
        'Schedule a flow to run. kind is interval|daily|weekly|once; spec shape depends on kind. dryRun defaults true, enabled defaults true.',
      inputSchema: {
        flowId: z.number().int(),
        kind: z.enum(['interval', 'daily', 'weekly', 'once']),
        spec: specSchema,
        name: z.string().optional(),
        dryRun: z.boolean().optional(),
        enabled: z.boolean().optional(),
      },
    },
    wrap(({ flowId, kind, spec, name, dryRun, enabled }) =>
      schedules.create({ flowId, kind, spec, name, dryRun, enabled }),
    ),
  )
  server.registerTool(
    'update_schedule',
    {
      description: 'Update a schedule. Any field optional; kind+spec change together. Recomputes next_run.',
      inputSchema: {
        id: z.number().int(),
        flowId: z.number().int().optional(),
        kind: z.enum(['interval', 'daily', 'weekly', 'once']).optional(),
        spec: specSchema.optional(),
        name: z.string().nullable().optional(),
        dryRun: z.boolean().optional(),
        enabled: z.boolean().optional(),
      },
    },
    wrap(({ id, ...patch }) => schedules.update(id, patch)),
  )
  server.registerTool(
    'delete_schedule',
    { description: 'Delete a schedule by id.', inputSchema: { id: z.number().int() } },
    wrap(({ id }) => schedules.remove(id)),
  )
  server.registerTool(
    'run_schedule',
    {
      description: "Run a schedule's flow now (uses its dry/live mode) without altering its cadence.",
      inputSchema: { id: z.number().int() },
    },
    wrap(({ id }) => schedules.run(id)),
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
