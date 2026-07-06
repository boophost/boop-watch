// Admin APIs for the /manage flow editor. Mounted behind requireAuth +
// requireAdmin in index.ts — flows can trigger external fetches and portal
// writes, so plain sign-up auth isn't enough.

import { Router } from 'express'
import { NODE_SPECS } from './flowNodes.js'
import { runFlow, validateGraph, FlowGraph } from './flowExecutor.js'
import type { RunReport, RunHooks } from './flowExecutor.js'
import { randomUUID } from 'node:crypto'
import {
  deriveInterface,
  validatePublish,
  componentToNodeSpec,
  type FlowComponentMeta,
} from './flowComponents.js'
import * as flowsDb from './flowsDb.js'
import { listPublishedComponents, parseComponent } from './flowsDb.js'
import type { FlowRunRow, RunActivity, ScheduleKind, ScheduleSpec, WeekDay } from './flowsDb.js'
import { computeNextRun, runScheduleNow } from './scheduler.js'
import { emitActivity, subscribeActivity } from './runEvents.js'
import { queueStats } from './httpQueue.js'

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

// The flow_runs id produced by the most recent runFlowAndRecord call, or null if
// logging failed. The scheduler reads this right after its run to stamp
// flow_schedules.last_run_id — safe because the flow lock serializes all runs.
let lastRecordedRunId: number | null = null
export function getLastRecordedRunId(): number | null {
  return lastRecordedRunId
}

// Run a graph and log it to the rolling activity feed. Shared by the flow-run
// route, the scheduler, and the per-series re-search action so all show up in the
// Activity tab. Also broadcasts lifecycle events on the run bus (runEvents.ts) so
// the Activity page can watch the run live. Logging never fails the run.
export async function runFlowAndRecord(
  graph: FlowGraph,
  opts: { dryRun: boolean; flowId: number | null; flowName: string },
  hooks?: RunHooks,
): Promise<RunReport> {
  const runToken = randomUUID()
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  emitActivity({
    type: 'start',
    runToken,
    flowId: opts.flowId,
    flowName: opts.flowName,
    dryRun: opts.dryRun,
    startedAt: new Date().toISOString(),
  })
  // Broadcast each node globally in addition to invoking any caller hooks (the
  // editor's own live stream).
  const wrapped: RunHooks = {
    onNodeStart: (nodeId) => {
      emitActivity({ type: 'node-start', runToken, nodeId })
      hooks?.onNodeStart?.(nodeId)
    },
    onNodeDone: (nodeId, nodeReport) => {
      const type = typeById.get(nodeId) ?? nodeId
      emitActivity({
        type: 'node',
        runToken,
        nodeId,
        node: NODE_LABELS.get(type) ?? type,
        nodeType: type,
        status: nodeReport.status,
        notes: nodeReport.notes,
        ...(nodeReport.error ? { error: nodeReport.error } : {}),
      })
      hooks?.onNodeDone?.(nodeId, nodeReport)
    },
  }

  try {
    const report = await runFlow(graph, opts.dryRun, wrapped)
    lastRecordedRunId = null
    const activity = activityFromReport(graph, report)
    try {
      lastRecordedRunId = flowsDb.recordRun({
        flow_id: opts.flowId,
        flow_name: opts.flowName,
        dry_run: report.dryRun,
        ok: report.ok,
        error: report.error ?? null,
        started_at: report.startedAt,
        duration_ms: report.durationMs,
        activity,
      })
    } catch (logErr) {
      console.error('failed to record flow run', logErr)
    }
    const runRow: FlowRunRow = {
      id: lastRecordedRunId ?? -1,
      flow_id: opts.flowId,
      flow_name: opts.flowName,
      dry_run: report.dryRun,
      ok: report.ok,
      error: report.error ?? null,
      started_at: report.startedAt,
      duration_ms: Math.round(report.durationMs),
      activity,
    }
    emitActivity({ type: 'done', runToken, run: runRow })
    return report
  } catch (e) {
    emitActivity({ type: 'aborted', runToken, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
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

// Live snapshot of the outbound-request limiter (server/httpQueue.ts) — per-service
// in-flight/queued counts + lifetime totals for the Activity-tab queue strip.
flowRouter.get('/api/flows/queue', (_req, res) => {
  res.json({ queues: queueStats() })
})

// Live activity feed: an initial snapshot of recent runs, then a newline-delimited
// JSON stream of run lifecycle events (start / node / done / aborted) as they
// happen — from any source (editor, scheduler, MCP). A periodic ping keeps the
// connection alive through proxies. Consumed by the Activity page via fetch (not
// EventSource, so the admin Bearer token rides along).
flowRouter.get('/api/flows/runs/stream', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no') // ask proxies (nginx) not to buffer
  res.flushHeaders?.()
  const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n')
  send({ type: 'snapshot', runs: flowsDb.listRuns(100) })
  const unsubscribe = subscribeActivity(send)
  const ping = setInterval(() => send({ type: 'ping' }), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
    res.end()
  })
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

flowRouter.get('/api/flows/components', (_req, res) => {
  const specs = listPublishedComponents().flatMap(({ row, graph, meta }) => {
    const iface = deriveInterface(row.id, graph)
    if ('error' in iface) return []
    return [componentToNodeSpec(row.id, row.name, meta, iface)]
  })
  res.json({ components: specs })
})

flowRouter.get('/api/flows/:id/interface', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  const row = flowsDb.getFlow(id)
  if (!row) return res.status(404).json({ error: 'not found' })
  let graph: FlowGraph
  try {
    graph = JSON.parse(row.graph) as FlowGraph
  } catch {
    return res.status(500).json({ error: 'corrupt graph' })
  }
  const meta = parseComponent(row.component)
  const iface = deriveInterface(id, graph)
  if ('error' in iface) return res.status(400).json({ error: iface.error })
  res.json({ interface: iface, component: meta })
})

flowRouter.get('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? flowsDb.getFlow(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  res.json({ flow: { ...row, graph: JSON.parse(row.graph), component: parseComponent(row.component) } })
})

flowRouter.put('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const body = req.body as {
    name?: unknown
    description?: unknown
    graph?: unknown
    component?: unknown
  }
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
  if (body.component !== undefined) {
    patch.component = body.component as FlowComponentMeta | null
  }
  if (body.component !== undefined) {
    const component = body.component as FlowComponentMeta | null
    if (component?.published === true) {
      const existing = flowsDb.getFlow(id)
      if (!existing) {
        res.status(404).json({ error: 'Flow not found' })
        return
      }
      const graph = patch.graph ?? (JSON.parse(existing.graph) as FlowGraph)
      const publishErr = validatePublish(graph)
      if (publishErr) {
        res.status(400).json({ error: publishErr })
        return
      }
    }
  }
  const row = flowsDb.updateFlow(id, patch)
  if (!row) {
    res.status(404).json({ error: 'Flow not found' })
    return
  }
  res.json({ flow: { ...row, graph: JSON.parse(row.graph), component: parseComponent(row.component) } })
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

// Same as /run, but streams live per-node progress as newline-delimited JSON so
// the editor can paint each node the moment it finishes (a full library-import
// run is minutes of rate-limited work). Events: {type:'start',id} before a node
// runs, {type:'node',id,report} when it finishes, {type:'done',report} at the
// end (or {type:'error',error} if the run couldn't start). The MCP CLI keeps
// using the plain /run above.
flowRouter.post('/api/flows/:id/run/stream', async (req, res) => {
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
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no') // ask proxies (nginx) not to buffer
  res.flushHeaders?.()
  const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n')
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  try {
    const graph = JSON.parse(row.graph) as FlowGraph
    const report = await runFlowAndRecord(
      graph,
      { dryRun, flowId: row.id, flowName: row.name },
      {
        onNodeStart: (nodeId) => send({ type: 'start', id: nodeId }),
        onNodeDone: (nodeId, nodeReport) => send({ type: 'node', id: nodeId, report: nodeReport }),
      },
    )
    send({ type: 'done', report })
  } catch (e) {
    console.error(e)
    send({ type: 'error', error: e instanceof Error ? e.message : 'Run failed' })
  } finally {
    releaseFlowLock()
    res.end()
  }
})

// --- Schedules -----------------------------------------------------------
// CRUD + manual run for scheduled flow runs. Mounted (like the flow routes)
// behind requireAuth + requireAdmin via the /api/schedules gate in index.ts.
// The scheduler tick (server/scheduler.ts) fires these when next_run is due.

const KINDS: ScheduleKind[] = ['interval', 'daily', 'weekly', 'once']
const WEEK_DAYS: WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function validHHMM(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!m) return false
  return +m[1] >= 0 && +m[1] <= 23 && +m[2] >= 0 && +m[2] <= 59
}

// Validate a raw spec against its kind; returns an error string or null.
function specError(kind: ScheduleKind, raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'spec must be an object'
  const s = raw as Record<string, unknown>
  if (kind === 'interval') {
    if (typeof s.every !== 'number' || !Number.isFinite(s.every) || s.every < 1)
      return 'spec.every must be a positive number'
    if (s.unit !== 'minutes' && s.unit !== 'hours') return "spec.unit must be 'minutes' or 'hours'"
    return null
  }
  if (kind === 'daily') return validHHMM(s.at) ? null : 'spec.at must be HH:MM'
  if (kind === 'weekly') {
    if (!WEEK_DAYS.includes(s.day as WeekDay)) return 'spec.day must be sun..sat'
    return validHHMM(s.at) ? null : 'spec.at must be HH:MM'
  }
  // once
  if (!Number.isFinite(Date.parse(String(s.runAt)))) return 'spec.runAt must be an ISO datetime'
  return null
}

// Canonicalise a validated spec so only the expected fields are stored.
function normalizeSpec(kind: ScheduleKind, raw: Record<string, unknown>): ScheduleSpec {
  if (kind === 'interval')
    return { every: Math.floor(raw.every as number), unit: raw.unit as 'minutes' | 'hours' }
  if (kind === 'daily') return { at: raw.at as string }
  if (kind === 'weekly') return { day: raw.day as WeekDay, at: raw.at as string }
  return { runAt: new Date(Date.parse(String(raw.runAt))).toISOString() }
}

flowRouter.get('/api/schedules', (_req, res) => {
  res.json({ schedules: flowsDb.listSchedules() })
})

flowRouter.get('/api/schedules/:id', (req, res) => {
  const id = Number(req.params.id)
  const schedule = Number.isFinite(id) ? flowsDb.getSchedule(id) : undefined
  if (!schedule) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  res.json({ schedule })
})

flowRouter.post('/api/schedules', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const flowId = Number(body.flowId)
  if (!Number.isFinite(flowId) || !flowsDb.getFlow(flowId)) {
    res.status(400).json({ error: 'flowId must reference an existing flow' })
    return
  }
  const kind = body.kind as ScheduleKind
  if (!KINDS.includes(kind)) {
    res.status(400).json({ error: 'kind must be interval | daily | weekly | once' })
    return
  }
  const err = specError(kind, body.spec)
  if (err) {
    res.status(400).json({ error: err })
    return
  }
  const spec = normalizeSpec(kind, body.spec as Record<string, unknown>)
  const enabled = body.enabled === undefined ? true : !!body.enabled
  const dry_run = body.dryRun === undefined ? true : !!body.dryRun
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
  const next_run = enabled ? computeNextRun(kind, spec) : null
  const schedule = flowsDb.createSchedule({ flow_id: flowId, name, kind, spec, dry_run, enabled, next_run })
  res.json({ schedule })
})

flowRouter.put('/api/schedules/:id', (req, res) => {
  const id = Number(req.params.id)
  const existing = Number.isFinite(id) ? flowsDb.getSchedule(id) : undefined
  if (!existing) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Partial<flowsDb.ScheduleInput> = {}

  if (body.flowId !== undefined) {
    const fid = Number(body.flowId)
    if (!Number.isFinite(fid) || !flowsDb.getFlow(fid)) {
      res.status(400).json({ error: 'flowId must reference an existing flow' })
      return
    }
    patch.flow_id = fid
  }
  if (body.name !== undefined)
    patch.name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
  if (body.dryRun !== undefined) patch.dry_run = !!body.dryRun
  if (body.enabled !== undefined) patch.enabled = !!body.enabled

  // kind and spec move together — the spec shape is dictated by the kind.
  const cadenceChanged = body.kind !== undefined || body.spec !== undefined
  if (cadenceChanged) {
    const kind = (body.kind !== undefined ? body.kind : existing.kind) as ScheduleKind
    if (!KINDS.includes(kind)) {
      res.status(400).json({ error: 'kind must be interval | daily | weekly | once' })
      return
    }
    const rawSpec = body.spec !== undefined ? body.spec : existing.spec
    const err = specError(kind, rawSpec)
    if (err) {
      res.status(400).json({ error: err })
      return
    }
    patch.kind = kind
    patch.spec = normalizeSpec(kind, rawSpec as Record<string, unknown>)
  }

  // Recompute next_run whenever the cadence or the enabled flag changed.
  if (cadenceChanged || body.enabled !== undefined) {
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled
    const kind = patch.kind ?? existing.kind
    const spec = patch.spec ?? existing.spec
    patch.next_run = enabled ? computeNextRun(kind, spec) : null
  }

  const schedule = flowsDb.updateSchedule(id, patch)
  res.json({ schedule })
})

flowRouter.delete('/api/schedules/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || !flowsDb.deleteSchedule(id)) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  res.json({ ok: true })
})

flowRouter.post('/api/schedules/:id/run', async (req, res) => {
  const id = Number(req.params.id)
  const sched = Number.isFinite(id) ? flowsDb.getSchedule(id) : undefined
  if (!sched) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  if (!acquireFlowLock()) {
    res.status(409).json({ error: 'A flow is already running' })
    return
  }
  try {
    const report = await runScheduleNow(sched)
    res.json({ report })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Run failed' })
  } finally {
    releaseFlowLock()
  }
})
