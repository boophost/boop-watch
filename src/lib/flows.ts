// Types + typed client for the /manage flow editor APIs (server/flowRoutes.ts).
// The node-spec shapes mirror server/flowNodes.ts; the editor renders whatever
// specs the server reports, so new node types need no client changes.

import { fetchAuth } from './api'

export interface ConfigField {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'boolean' | 'password'
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  help?: string
}

export interface NodePort {
  id: string
  label: string
}

export type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink'

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

export interface Flow {
  id: number
  name: string
  description: string | null
  graph: FlowGraph
  created_at: string
  updated_at: string
}

export interface FlowSummary {
  id: number
  name: string
  description: string | null
  node_count: number
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

export const createFlow = (name: string, description?: string) =>
  fetchAuth('/api/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  }).then((r) => json<{ flow: Flow }>(r))

export const saveFlow = (id: number, patch: { name?: string; description?: string | null; graph?: FlowGraph }) =>
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
