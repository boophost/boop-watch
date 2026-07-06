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

export type NodePortSpec = { id: string }
export type ResolvedNodeSpec = { inputs: NodePortSpec[]; outputs: NodePortSpec[] }

/**
 * Resolves a node's port spec for node types that aren't in the static
 * NODE_REGISTRY (currently just `flow.subflow`, whose ports come from the
 * referenced flow's published interface). Return null to defer to the
 * registry / report the type as unknown.
 */
export type SpecResolver = (node: FlowNode) => ResolvedNodeSpec | null

export function validateGraph(graph: FlowGraph, resolveSpec?: SpecResolver): string | null {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') return 'Node missing id'
    if (ids.has(node.id)) return `Duplicate node id: ${node.id}`
    ids.add(node.id)
    const impl = NODE_REGISTRY.get(node.type)
    if (!impl) {
      const resolved = resolveSpec?.(node)
      if (!resolved) return `Unknown node type: ${node.type}`
    }
  }
  for (const edge of graph.edges) {
    const source = graph.nodes.find((n) => n.id === edge.source)
    const target = graph.nodes.find((n) => n.id === edge.target)
    if (!source) return `Edge ${edge.id}: unknown source node`
    if (!target) return `Edge ${edge.id}: unknown target node`
    const sourceSpec = resolveSpec?.(source) ?? NODE_REGISTRY.get(source.type)?.spec
    const targetSpec = resolveSpec?.(target) ?? NODE_REGISTRY.get(target.type)?.spec
    if (!sourceSpec || !targetSpec) return `Unknown node type on edge ${edge.id}`
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

/** Live per-node progress callbacks, fired as the executor walks the graph. */
export interface RunHooks {
  /** A node is about to run (after its inputs are gathered). */
  onNodeStart?: (nodeId: string) => void
  /** A node finished (ok, error, or skipped); its report is final. */
  onNodeDone?: (nodeId: string, report: NodeReport) => void
}

export interface RunFlowOptions {
  hooks?: RunHooks
  /**
   * For boundary.input nodes: return items to use as that node's output
   * instead of running its (empty, pass-through) impl. Returning null falls
   * back to the normal impl.run. Used by flow.subflow to feed the caller's
   * per-port inputs into the nested graph.
   */
  injectOutput?: (node: FlowNode) => FlowItem[] | null
  /** Prefix applied to node ids passed to hooks — lets a subflow's nested run
   * report progress under a qualified id in the parent's live feed. */
  qualifyId?: (nodeId: string) => string
}

export interface RunFlowResult extends RunReport {
  /** Inputs gathered for each node right before it ran, keyed by node id then
   * input handle. boundary.output collection reads `items` off of this to
   * recover what a published component produced on each output port. */
  finalInputs?: Map<string, Record<string, FlowItem[]>>
}

function normalizeRunOptions(hooksOrOptions?: RunHooks | RunFlowOptions): RunFlowOptions {
  if (!hooksOrOptions) return {}
  if ('onNodeStart' in hooksOrOptions || 'onNodeDone' in hooksOrOptions) {
    return { hooks: hooksOrOptions as RunHooks }
  }
  return hooksOrOptions as RunFlowOptions
}

export async function runFlow(
  graph: FlowGraph,
  dryRun: boolean,
  hooksOrOptions?: RunHooks | RunFlowOptions,
): Promise<RunFlowResult> {
  const { hooks, injectOutput, qualifyId } = normalizeRunOptions(hooksOrOptions)
  const qid = qualifyId ?? ((id: string) => id)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const reports: Record<string, NodeReport> = {}
  const finalInputs = new Map<string, Record<string, FlowItem[]>>()

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
    const reportKey = qid(node.id)
    const incoming = graph.edges.filter((e) => e.target === node.id)

    // Skip nodes downstream of a failure so one broken source doesn't cascade
    // into misleading per-node errors.
    if (incoming.some((e) => failed.has(e.source))) {
      failed.add(node.id)
      reports[reportKey] = {
        status: 'skipped',
        durationMs: 0,
        counts: {},
        samples: {},
        notes: ['skipped: upstream node failed'],
      }
      hooks?.onNodeDone?.(reportKey, reports[reportKey])
      continue
    }

    hooks?.onNodeStart?.(reportKey)

    const inputs: Record<string, FlowItem[]> = {}
    for (const port of impl.spec.inputs) inputs[port.id] = []
    for (const e of incoming) {
      const produced = buffers.get(e.source)?.[e.sourceHandle] ?? []
      inputs[e.targetHandle] = [...(inputs[e.targetHandle] ?? []), ...produced]
    }
    finalInputs.set(node.id, inputs)

    const ctx: RunContext = {
      dryRun,
      notes: [],
      nodeId: node.id,
      hooks,
      mergeNestedReports: (nested) => {
        Object.assign(reports, nested)
      },
    }
    const nodeT0 = Date.now()
    try {
      const injected = node.type === 'boundary.input' ? injectOutput?.(node) ?? null : null
      const outputs = injected !== null ? { items: injected } : await impl.run(inputs, node.config ?? {}, ctx)
      buffers.set(node.id, outputs)
      reports[reportKey] = {
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
      reports[reportKey] = {
        status: 'error',
        durationMs: Date.now() - nodeT0,
        counts: {},
        samples: {},
        notes: ctx.notes,
        error: e instanceof Error ? e.message : String(e),
      }
    }
    hooks?.onNodeDone?.(reportKey, reports[reportKey])
  }

  const ok = Object.values(reports).every((r) => r.status === 'ok')
  return { ok, dryRun, startedAt, durationMs: Date.now() - t0, nodes: reports, finalInputs }
}
