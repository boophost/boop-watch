// Executes a flow graph: topologically orders the nodes, feeds each node the
// items produced on its incoming edges, and collects a per-node report the
// editor renders after a run. Items are loose JSON records; nodes decide what
// fields mean.

import { NODE_REGISTRY, FlowItem, RunContext } from './flowNodes.js'

export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  config: Record<string, unknown>
}

export interface FlowEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface NodeReport {
  status: 'ok' | 'error' | 'skipped'
  durationMs: number
  /** items emitted per output handle */
  counts: Record<string, number>
  /** first few items per output handle, for inspection in the editor */
  samples: Record<string, FlowItem[]>
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

const SAMPLE_SIZE = 3

export function validateGraph(graph: FlowGraph): string | null {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') return 'Node missing id'
    if (ids.has(node.id)) return `Duplicate node id: ${node.id}`
    ids.add(node.id)
    const impl = NODE_REGISTRY.get(node.type)
    if (!impl) return `Unknown node type: ${node.type}`
  }
  for (const edge of graph.edges) {
    const source = graph.nodes.find((n) => n.id === edge.source)
    const target = graph.nodes.find((n) => n.id === edge.target)
    if (!source) return `Edge ${edge.id}: unknown source node`
    if (!target) return `Edge ${edge.id}: unknown target node`
    const sourceSpec = NODE_REGISTRY.get(source.type)!.spec
    const targetSpec = NODE_REGISTRY.get(target.type)!.spec
    if (!sourceSpec.outputs.some((o) => o.id === edge.sourceHandle))
      return `Edge ${edge.id}: ${source.type} has no output "${edge.sourceHandle}"`
    if (!targetSpec.inputs.some((i) => i.id === edge.targetHandle))
      return `Edge ${edge.id}: ${target.type} has no input "${edge.targetHandle}"`
  }
  if (topoOrder(graph) === null) return 'Graph has a cycle'
  return null
}

function topoOrder(graph: FlowGraph): FlowNode[] | null {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]))
  for (const e of graph.edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0)
  const order: FlowNode[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const e of graph.edges) {
      if (e.source !== node.id) continue
      const d = (indegree.get(e.target) ?? 0) - 1
      indegree.set(e.target, d)
      if (d === 0) queue.push(graph.nodes.find((n) => n.id === e.target)!)
    }
  }
  return order.length === graph.nodes.length ? order : null
}

export async function runFlow(graph: FlowGraph, dryRun: boolean): Promise<RunReport> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const reports: Record<string, NodeReport> = {}

  const invalid = validateGraph(graph)
  if (invalid) {
    return { ok: false, dryRun, startedAt, durationMs: Date.now() - t0, nodes: {}, error: invalid }
  }

  const order = topoOrder(graph)!
  // node id -> output handle -> items
  const buffers = new Map<string, Record<string, FlowItem[]>>()
  const failed = new Set<string>()

  for (const node of order) {
    const impl = NODE_REGISTRY.get(node.type)!
    const incoming = graph.edges.filter((e) => e.target === node.id)

    // Skip nodes downstream of a failure so one broken source doesn't cascade
    // into misleading per-node errors.
    if (incoming.some((e) => failed.has(e.source))) {
      failed.add(node.id)
      reports[node.id] = {
        status: 'skipped',
        durationMs: 0,
        counts: {},
        samples: {},
        notes: ['skipped: upstream node failed'],
      }
      continue
    }

    const inputs: Record<string, FlowItem[]> = {}
    for (const port of impl.spec.inputs) inputs[port.id] = []
    for (const e of incoming) {
      const produced = buffers.get(e.source)?.[e.sourceHandle] ?? []
      inputs[e.targetHandle] = [...(inputs[e.targetHandle] ?? []), ...produced]
    }

    const ctx: RunContext = { dryRun, notes: [] }
    const nodeT0 = Date.now()
    try {
      const outputs = await impl.run(inputs, node.config ?? {}, ctx)
      buffers.set(node.id, outputs)
      reports[node.id] = {
        status: 'ok',
        durationMs: Date.now() - nodeT0,
        counts: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.length])),
        samples: Object.fromEntries(
          Object.entries(outputs).map(([k, v]) => [k, v.slice(0, SAMPLE_SIZE)]),
        ),
        notes: ctx.notes,
      }
    } catch (e) {
      failed.add(node.id)
      reports[node.id] = {
        status: 'error',
        durationMs: Date.now() - nodeT0,
        counts: {},
        samples: {},
        notes: ctx.notes,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const ok = Object.values(reports).every((r) => r.status === 'ok')
  return { ok, dryRun, startedAt, durationMs: Date.now() - t0, nodes: reports }
}
