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

/** What travels over a port; omitted = 'items'. Mirrors server/flowNodes.ts. */
export type PortDataType = 'items' | 'text' | 'number' | 'color' | 'url' | 'json' | 'embed'

export interface NodePort {
  id: string
  label: string
  dataType?: PortDataType
}

/** Extra source types a target port accepts besides its own — keep in sync
 * with PORT_ACCEPTS in server/flowNodes.ts (the server enforces this on save;
 * the editor uses it to block bad connections as you drag). */
const PORT_ACCEPTS: Record<PortDataType, PortDataType[]> = {
  items: [],
  text: ['number', 'url', 'color'],
  number: [],
  color: ['text'],
  url: ['text'],
  json: ['text', 'number', 'color', 'url', 'embed'],
  embed: ['json'],
}

export function portCompatible(source: PortDataType | undefined, target: PortDataType | undefined): boolean {
  const s = source ?? 'items'
  const t = target ?? 'items'
  return s === t || PORT_ACCEPTS[t].includes(s)
}

export type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'value' | 'boundary'

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

// Shape sent to POST/PUT /api/schedules. flowId + kind + spec are required on
// create; every field is optional on update.
export interface ScheduleInput {
  flowId: number
  name?: string | null
  kind: ScheduleKind
  spec: ScheduleSpec
  dryRun?: boolean
  enabled?: boolean
}

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
