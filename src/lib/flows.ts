// Types + typed client for the /manage flow editor APIs (server/flowRoutes.ts).
// The node-spec shapes mirror server/flowNodes.ts; the editor renders whatever
// specs the server reports, so new node types need no client changes.

import { fetchAuth } from './api'

export interface ConfigField {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'boolean' | 'password' | 'json' | 'color'
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  help?: string
}

/**
 * What travels over a port; omitted = base 'items'. Mirrors server/flowNodes.ts.
 * Two families: the *record* stream ('items' + its stage subtypes) and the
 * *value* ports (text/number/…). The record subtypes form a lineage under the
 * base 'items' so a wrong wire (a torrent into a file input) is caught, while
 * generic nodes still interoperate. Keep this in sync with server/flowNodes.ts.
 */
export type PortDataType =
  | 'items'
  | 'torrent'
  | 'release'
  | 'catalog'
  | 'file'
  | 'probed'
  | 'text'
  | 'number'
  | 'color'
  | 'url'
  | 'json'
  | 'embed'

export interface NodePort {
  id: string
  label: string
  dataType?: PortDataType
}

/** Record-family subtype lineage (child → parent). Base 'items' is the root of
 * every record type; value types are a separate family. Keep in sync with
 * server/flowNodes.ts. */
const RECORD_PARENT: Partial<Record<PortDataType, PortDataType>> = {
  torrent: 'items',
  release: 'items',
  catalog: 'items',
  file: 'items',
  probed: 'file',
}

const RECORD_TYPES: PortDataType[] = ['items', 'torrent', 'release', 'catalog', 'file', 'probed']
export const isRecordType = (t: PortDataType): boolean => RECORD_TYPES.includes(t)

/** Ancestor chain including self, nearest-first ('probed' → ['probed','file','items']). */
const recordLineage = (t: PortDataType): PortDataType[] => {
  const chain: PortDataType[] = [t]
  let p = RECORD_PARENT[t]
  while (p) {
    chain.push(p)
    p = RECORD_PARENT[p]
  }
  return chain
}

/** Nearest common ancestor of two record types (for propagation through merges). */
export const recordLCA = (a: PortDataType, b: PortDataType): PortDataType => {
  const bset = new Set(recordLineage(b))
  for (const t of recordLineage(a)) if (bset.has(t)) return t
  return 'items'
}

/** Extra value-source types a value target accepts besides its own — keep in
 * sync with PORT_ACCEPTS in server/flowNodes.ts. Record types are handled by
 * lineage (below), not this table. */
const PORT_ACCEPTS: Partial<Record<PortDataType, PortDataType[]>> = {
  text: ['number', 'url', 'color'],
  color: ['text'],
  url: ['text'],
  json: ['text', 'number', 'color', 'url', 'embed'],
  embed: ['json'],
}

export function portCompatible(source: PortDataType | undefined, target: PortDataType | undefined): boolean {
  const s = source ?? 'items'
  const t = target ?? 'items'
  if (s === t) return true
  const sRec = isRecordType(s)
  const tRec = isRecordType(t)
  if (sRec !== tRec) return false // record and value families never mix
  if (sRec) return recordLineage(s).includes(t) || recordLineage(t).includes(s)
  return (PORT_ACCEPTS[t] ?? []).includes(s)
}

const VALUE_TYPES: PortDataType[] = ['text', 'number', 'color', 'url', 'json', 'embed']

/** Ports that depend on a node's config — boundary nodes take their dataType
 * from config, transform.pick types its output. Mirrors the impls'
 * resolvePorts in server/flowNodes.ts; keep in sync. */
export function resolveNodePorts(
  spec: NodeSpec,
  config: Record<string, unknown>,
): { inputs: NodePort[]; outputs: NodePort[] } {
  const raw = String(config.dataType ?? '')
  const dt = VALUE_TYPES.includes(raw as PortDataType) ? (raw as PortDataType) : undefined
  if (spec.type === 'boundary.input') {
    return { inputs: spec.inputs, outputs: [{ id: 'items', label: 'items', dataType: dt }] }
  }
  if (spec.type === 'boundary.output') {
    return { inputs: [{ id: 'items', label: 'items', dataType: dt }], outputs: spec.outputs }
  }
  if (spec.type === 'transform.pick') {
    return { inputs: spec.inputs, outputs: [{ id: 'value', label: 'value', dataType: dt ?? 'json' }] }
  }
  return { inputs: spec.inputs, outputs: spec.outputs }
}

/** A port's declared record type is "fixed" (doesn't propagate) when it's a
 * value type or a concrete record subtype; base 'items'/undefined propagates. */
const isFixedType = (t: PortDataType | undefined): boolean => t !== undefined && t !== 'items'

/**
 * Blender-style type propagation over the record family. Generic nodes leave
 * their record ports as base 'items'; this traces the upstream subtype through
 * them so a 'probed' stream stays 'probed' all the way to the sink. Returns a
 * map of effective types keyed `${nodeId}:in|out:${portId}`, for socket/wire
 * colouring and connection validation. Value ports keep their declared type.
 * Mirrors propagateRecordTypes in server/flowExecutor.ts — keep in sync.
 */
export function propagateRecordTypes(
  graph: FlowGraph,
  portsFor: (node: FlowNodeData) => { inputs: NodePort[]; outputs: NodePort[] } | null,
): Map<string, PortDataType> {
  const resolved = new Map<string, { inputs: NodePort[]; outputs: NodePort[] }>()
  for (const node of graph.nodes) {
    const ports = portsFor(node)
    if (ports) resolved.set(node.id, ports)
  }
  const edges = graph.edges.filter((e) => resolved.has(e.source) && resolved.has(e.target))

  // Kahn topological order; nodes left over by a cycle are appended as-is.
  const indeg = new Map<string, number>([...resolved.keys()].map((id) => [id, 0]))
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift() as string
    order.push(id)
    for (const e of edges) {
      if (e.source !== id) continue
      const d = (indeg.get(e.target) ?? 0) - 1
      indeg.set(e.target, d)
      if (d === 0) queue.push(e.target)
    }
  }
  for (const id of resolved.keys()) if (!order.includes(id)) order.push(id)

  const eff = new Map<string, PortDataType>()
  const outType = (nodeId: string, portId: string): PortDataType => {
    const declared = resolved.get(nodeId)?.outputs.find((p) => p.id === portId)?.dataType
    return eff.get(`${nodeId}:out:${portId}`) ?? declared ?? 'items'
  }

  for (const id of order) {
    const ports = resolved.get(id)
    if (!ports) continue
    // Effective input per port = combined type of its inbound edges' sources.
    let mergedRecordIn: PortDataType | undefined
    for (const inp of ports.inputs) {
      let e: PortDataType | undefined
      for (const edge of edges) {
        if (edge.target !== id || edge.targetHandle !== inp.id) continue
        const st = outType(edge.source, edge.sourceHandle)
        e = e === undefined ? st : isRecordType(e) && isRecordType(st) ? recordLCA(e, st) : e
      }
      const effIn = e ?? inp.dataType ?? 'items'
      eff.set(`${id}:in:${inp.id}`, effIn)
      if (isRecordType(effIn) && (e !== undefined || isFixedType(inp.dataType))) {
        mergedRecordIn = mergedRecordIn === undefined ? effIn : recordLCA(mergedRecordIn, effIn)
      }
    }
    // Effective output: a fixed type stays; a propagating record port takes the
    // merged inbound record type (base 'items' if there were no record inputs).
    for (const out of ports.outputs) {
      const effOut = isFixedType(out.dataType) ? (out.dataType as PortDataType) : mergedRecordIn ?? 'items'
      eff.set(`${id}:out:${out.id}`, effOut)
    }
  }
  return eff
}

export type NodeCategory = 'trigger' | 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'value' | 'boundary'

export interface NodeSpec {
  type: string
  label: string
  category: NodeCategory
  description: string
  inputs: NodePort[]
  outputs: NodePort[]
  config: ConfigField[]
}

export interface FlowNodeData {
  id: string
  type: string
  position: { x: number; y: number }
  config: Record<string, unknown>
}

export interface FlowEdgeData {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface FlowGraph {
  nodes: FlowNodeData[]
  edges: FlowEdgeData[]
}

export interface ExposedParam {
  nodeId: string
  configKey: string
  label?: string
}

export interface FlowComponentMeta {
  published: boolean
  label: string
  description: string
  category: Exclude<NodeCategory, 'boundary'>
  exposedParams: ExposedParam[]
}

export interface ComponentInterface {
  flowId: number
  inputs: NodePort[]
  outputs: NodePort[]
  exposedParams: (ExposedParam & { kind: ConfigField['kind']; default?: unknown; options?: ConfigField['options'] })[]
}

export interface Flow {
  id: number
  name: string
  description: string | null
  graph: FlowGraph
  component: FlowComponentMeta | null
  created_at: string
  updated_at: string
}

export interface FlowSummary {
  id: number
  name: string
  description: string | null
  node_count: number
  published: boolean
  updated_at: string
}

export interface NodeReport {
  status: 'ok' | 'error' | 'skipped'
  durationMs: number
  counts: Record<string, number>
  samples: Record<string, Record<string, unknown>[]>
  notes: string[]
  error?: string
}

export interface RunReport {
  ok: boolean
  dryRun: boolean
  startedAt: string
  durationMs: number
  nodes: Record<string, NodeReport>
  error?: string
}

export interface RunActivity {
  node: string
  type: string
  status: 'ok' | 'error' | 'skipped'
  notes: string[]
  error?: string
}

export interface FlowRun {
  id: number
  flow_id: number | null
  flow_name: string
  dry_run: boolean
  ok: boolean
  error: string | null
  started_at: string
  duration_ms: number
  activity: RunActivity[]
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `Request failed (${r.status})`
    try {
      msg = ((await r.json()) as { error?: string }).error || msg
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg)
  }
  return (await r.json()) as T
}

export const listFlows = () =>
  fetchAuth('/api/flows').then((r) => json<{ flows: FlowSummary[] }>(r))

export const getNodeTypes = () =>
  fetchAuth('/api/flows/node-types').then((r) => json<{ nodeTypes: NodeSpec[] }>(r))

export const getFlow = (id: number) =>
  fetchAuth(`/api/flows/${id}`).then((r) => json<{ flow: Flow }>(r))

export const getFlowComponents = () =>
  fetchAuth('/api/flows/components').then((r) =>
    json<{ components: NodeSpec[] }>(r).then((d) => d.components),
  )

export const getFlowInterface = (id: number) =>
  fetchAuth(`/api/flows/${id}/interface`).then((r) =>
    json<{ interface: ComponentInterface; component: FlowComponentMeta | null; name: string }>(r),
  )

export const createFlow = (name: string, description?: string) =>
  fetchAuth('/api/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  }).then((r) => json<{ flow: Flow }>(r))

export const saveFlow = (
  id: number,
  patch: { name?: string; description?: string | null; graph?: FlowGraph; component?: FlowComponentMeta | null },
) =>
  fetchAuth(`/api/flows/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => json<{ flow: Flow }>(r))

export const deleteFlow = (id: number) =>
  fetchAuth(`/api/flows/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r))

export const runFlow = (id: number, dryRun: boolean) =>
  fetchAuth(`/api/flows/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun }),
  }).then((r) => json<{ report: RunReport }>(r))

/** One streamed progress event from POST /api/flows/:id/run/stream. */
export type RunStreamEvent =
  | { type: 'start'; id: string }
  | { type: 'node'; id: string; report: NodeReport }
  | { type: 'done'; report: RunReport }
  | { type: 'error'; error: string }

/**
 * Run a flow and receive live per-node progress. Calls `onEvent` for each
 * node as it starts/finishes; resolves with the final RunReport. Falls back to
 * throwing on transport/HTTP errors like the other helpers.
 */
export async function runFlowStream(
  id: number,
  dryRun: boolean,
  onEvent: (ev: RunStreamEvent) => void,
): Promise<RunReport> {
  const res = await fetchAuth(`/api/flows/${id}/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun }),
  })
  if (!res.ok || !res.body) {
    // Non-stream error (e.g. 409 already running, 404) — parse it like the rest.
    await json<unknown>(res)
    throw new Error(`Request failed (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: RunReport | null = null
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const ev = JSON.parse(trimmed) as RunStreamEvent
    if (ev.type === 'done') final = ev.report
    if (ev.type === 'error') throw new Error(ev.error)
    onEvent(ev)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.trim()) handleLine(buffer)
  if (!final) throw new Error('Run ended without a final report')
  return final
}

export const listRuns = (limit = 100) =>
  fetchAuth(`/api/flows/runs?limit=${limit}`).then((r) => json<{ runs: FlowRun[] }>(r))

// Outbound-request limiter snapshot (server/httpQueue.ts) for the Activity queue strip.
export interface QueueStat {
  inFlight: number
  queued: number
  minGapMs: number
  concurrency: number
  total: number
  retried: number
  lastStartAt: number | null
  lastError: { at: number; message: string } | null
}

export const getQueueStats = () =>
  fetchAuth('/api/flows/queue').then((r) => json<{ queues: Record<string, QueueStat> }>(r))

// Live activity stream events (GET /api/flows/runs/stream). `snapshot` arrives
// first, then run lifecycle events as they happen; `ping` is a keepalive.
export type ActivityStreamEvent =
  | { type: 'snapshot'; runs: FlowRun[] }
  | { type: 'start'; runToken: string; flowId: number | null; flowName: string; dryRun: boolean; startedAt: string }
  | { type: 'node-start'; runToken: string; nodeId: string }
  | {
      type: 'node'
      runToken: string
      nodeId: string
      node: string
      nodeType: string
      status: 'ok' | 'error' | 'skipped'
      notes: string[]
      error?: string
    }
  | { type: 'done'; runToken: string; run: FlowRun }
  | { type: 'aborted'; runToken: string; error: string }
  | { type: 'ping' }

// Subscribe to the live activity feed. Calls `onEvent` per event until the
// stream ends or `signal` aborts; throws on transport/HTTP errors so the caller
// can reconnect.
export async function streamActivity(
  onEvent: (ev: ActivityStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetchAuth('/api/flows/runs/stream', { signal })
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    onEvent(JSON.parse(trimmed) as ActivityStreamEvent)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.trim()) handleLine(buffer)
}

// --- Schedules -----------------------------------------------------------

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'once'
export type WeekDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export type ScheduleSpec =
  | { every: number; unit: 'minutes' | 'hours' }
  | { at: string }
  | { day: WeekDay; at: string }
  | { runAt: string }

export interface FlowSchedule {
  id: number
  flow_id: number
  trigger_name: string | null // when set, fires this trigger name (not flow_id)
  flow_name: string | null
  name: string | null
  kind: ScheduleKind
  spec: ScheduleSpec
  dry_run: boolean
  enabled: boolean
  next_run: string | null
  last_run: string | null
  last_run_id: number | null
  last_run_ok: boolean | null
  created_at: string
  updated_at: string
}

// Shape sent to POST/PUT /api/schedules. A target (triggerName preferred, or the
// legacy flowId) + kind + spec are required on create; every field is optional on
// update.
export interface ScheduleInput {
  flowId?: number
  triggerName?: string | null
  name?: string | null
  kind: ScheduleKind
  spec: ScheduleSpec
  dryRun?: boolean
  enabled?: boolean
}

// Distinct trigger.start names across all flows (schedule target picker).
export const getTriggers = () =>
  fetchAuth('/api/flows/triggers').then((r) => json<{ triggers: string[] }>(r).then((d) => d.triggers))

export const listSchedules = () =>
  fetchAuth('/api/schedules').then((r) => json<{ schedules: FlowSchedule[] }>(r))

export const createSchedule = (input: ScheduleInput) =>
  fetchAuth('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<{ schedule: FlowSchedule }>(r))

export const updateSchedule = (id: number, patch: Partial<ScheduleInput>) =>
  fetchAuth(`/api/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => json<{ schedule: FlowSchedule }>(r))

export const deleteSchedule = (id: number) =>
  fetchAuth(`/api/schedules/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r))

export const runScheduleNow = (id: number) =>
  fetchAuth(`/api/schedules/${id}/run`, { method: 'POST' }).then((r) =>
    json<{ report: RunReport }>(r),
  )
