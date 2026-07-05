// Admin APIs for the /manage flow editor. Mounted behind requireAuth +
// requireAdmin in index.ts — flows can trigger external fetches and portal
// writes, so plain sign-up auth isn't enough.

import { Router } from 'express'
import { NODE_SPECS } from './flowNodes.js'
import { runFlow, validateGraph, FlowGraph } from './flowExecutor.js'
import * as flowsDb from './flowsDb.js'

export const flowRouter = Router()

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
// single admin; a second concurrent run is always a mistake.
let running = false

flowRouter.post('/api/flows/:id/run', async (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? flowsDb.getFlow(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  if (running) {
    res.status(409).json({ error: 'A flow is already running' })
    return
  }
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  running = true
  try {
    const report = await runFlow(JSON.parse(row.graph) as FlowGraph, dryRun)
    res.json({ report })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Run failed' })
  } finally {
    running = false
  }
})
