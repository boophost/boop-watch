// Admin APIs for the /manage flow editor. Mounted behind requireAuth +
// requireAdmin in index.ts — flows can trigger external fetches and portal
// writes, so plain sign-up auth isn't enough.

import { Router } from 'express'
import { NODE_SPECS } from './flowNodes.js'
import { runFlow, validateGraph, FlowGraph } from './flowExecutor.js'
import type { RunReport } from './flowExecutor.js'
import * as flowsDb from './flowsDb.js'
import type { RunActivity } from './flowsDb.js'

export const flowRouter = Router()

const NODE_LABELS = new Map(NODE_SPECS.map((s) => [s.type, s.label]))

// Distil a run report into the activity feed: keep only nodes that actually
// said something (a note or an error), labelled for humans. Silent pass-through
// nodes are dropped so the log reads as events, not a graph dump.
function activityFromReport(graph: FlowGraph, report: RunReport): RunActivity[] {
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const activity: RunActivity[] = []
  for (const [nodeId, node] of Object.entries(report.nodes)) {
    if (node.notes.length === 0 && !node.error) continue
    const type = typeById.get(nodeId) ?? nodeId
    activity.push({
      node: NODE_LABELS.get(type) ?? type,
      type,
      status: node.status,
      notes: node.notes,
      ...(node.error ? { error: node.error } : {}),
    })
  }
  return activity
}

// Run a graph and log it to the rolling activity feed. Shared by the flow-run
// route and the per-series re-search action so both show up in the Activity tab.
// Logging never fails the run.
export async function runFlowAndRecord(
  graph: FlowGraph,
  opts: { dryRun: boolean; flowId: number | null; flowName: string },
): Promise<RunReport> {
  const report = await runFlow(graph, opts.dryRun)
  try {
    flowsDb.recordRun({
      flow_id: opts.flowId,
      flow_name: opts.flowName,
      dry_run: report.dryRun,
      ok: report.ok,
      error: report.error ?? null,
      started_at: report.startedAt,
      duration_ms: report.durationMs,
      activity: activityFromReport(graph, report),
    })
  } catch (logErr) {
    console.error('failed to record flow run', logErr)
  }
  return report
}

function parseGraph(raw: unknown): FlowGraph | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'graph must be an object' }
  const g = raw as Partial<FlowGraph>
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges))
    return { error: 'graph needs nodes[] and edges[]' }
  const graph: FlowGraph = { nodes: g.nodes, edges: g.edges }
  const invalid = validateGraph(graph)
  if (invalid) return { error: invalid }
  return graph
}

flowRouter.get('/api/flows/node-types', (_req, res) => {
  res.json({ nodeTypes: NODE_SPECS })
})

// Rolling activity log. Declared before the `/:id` route so "runs" isn't
// captured as an id.
flowRouter.get('/api/flows/runs', (req, res) => {
  const limit = Number(req.query.limit)
  res.json({ runs: flowsDb.listRuns(Number.isFinite(limit) ? limit : 100) })
})

flowRouter.get('/api/flows', (_req, res) => {
  res.json({ flows: flowsDb.listFlows() })
})

flowRouter.post('/api/flows', (req, res) => {
  const body = req.body as { name?: unknown; description?: unknown }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const description = typeof body.description === 'string' ? body.description : null
  const row = flowsDb.createFlow(name, description)
  res.status(201).json({ flow: { ...row, graph: JSON.parse(row.graph) } })
})

flowRouter.get('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? flowsDb.getFlow(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  res.json({ flow: { ...row, graph: JSON.parse(row.graph) } })
})

flowRouter.put('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const body = req.body as { name?: unknown; description?: unknown; graph?: unknown }
  const patch: Parameters<typeof flowsDb.updateFlow>[1] = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name must be a non-empty string' })
      return
    }
    patch.name = body.name.trim()
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description : null
  }
  if (body.graph !== undefined) {
    const parsed = parseGraph(body.graph)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    patch.graph = parsed
  }
  const row = flowsDb.updateFlow(id, patch)
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  res.json({ flow: { ...row, graph: JSON.parse(row.graph) } })
})

flowRouter.delete('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || !flowsDb.deleteFlow(id)) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  res.json({ ok: true })
})

// One run at a time — flows hit rate-limited upstreams (Jikan) and there is a
// single admin; a second concurrent run is always a mistake. Exported so the
// per-series re-search shares the same lock.
let running = false
export function acquireFlowLock(): boolean {
  if (running) return false
  running = true
  return true
}
export function releaseFlowLock(): void {
  running = false
}

flowRouter.post('/api/flows/:id/run', async (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? flowsDb.getFlow(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  if (!acquireFlowLock()) {
    res.status(409).json({ error: 'A flow is already running' })
    return
  }
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  try {
    const graph = JSON.parse(row.graph) as FlowGraph
    const report = await runFlowAndRecord(graph, { dryRun, flowId: row.id, flowName: row.name })
    res.json({ report })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Run failed' })
  } finally {
    releaseFlowLock()
  }
})
