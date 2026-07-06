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

export const listRuns = (limit = 100) =>
  fetchAuth(`/api/flows/runs?limit=${limit}`).then((r) => json<{ runs: FlowRun[] }>(r))
