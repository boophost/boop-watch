// Executes a flow graph: topologically orders the nodes, feeds each node the
// items produced on its incoming edges, and collects a per-node report the
// editor renders after a run. Items are loose JSON records; nodes decide what
// fields mean.

import {
  NODE_REGISTRY,
  FlowItem,
  RunContext,
  portCompatible,
  isRecordType,
  recordLCA,
  type PortDataType,
  type TriggerEvent,
  type FireRequest,
} from './flowNodes.js'
import { executableGraph, isEditorNode } from './flowEditorMeta.js'

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

export type NodePortSpec = { id: string; dataType?: PortDataType }
export type ResolvedNodeSpec = { inputs: NodePortSpec[]; outputs: NodePortSpec[] }

/**
 * Resolves a node's port spec for node types that aren't in the static
 * NODE_REGISTRY (currently just `flow.subflow`, whose ports come from the
 * referenced flow's published interface). Return null to defer to the
 * registry / report the type as unknown.
 */
export type SpecResolver = (node: FlowNode) => ResolvedNodeSpec | null

export function validateGraph(graph: FlowGraph, resolveSpec?: SpecResolver): string | null {
  // Ports for a node: an external resolver (flow.subflow interfaces) wins,
  // then the impl's config-driven ports (typed boundaries, transform.pick),
  // then the static spec. Editor-only nodes (sticky notes, groups, …) are
  // ignored for validation and execution.
  const portsFor = (node: FlowNode): ResolvedNodeSpec | undefined => {
    if (isEditorNode(node.type)) return { inputs: [], outputs: [] }
    const resolved = resolveSpec?.(node)
    if (resolved) return resolved
    const impl = NODE_REGISTRY.get(node.type)
    if (!impl) return undefined
    return impl.resolvePorts?.(node.config ?? {}) ?? impl.spec
  }

  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') return 'Node missing id'
    if (ids.has(node.id)) return `Duplicate node id: ${node.id}`
    ids.add(node.id)
    if (!portsFor(node)) return `Unknown node type: ${node.type}`
  }
  const runnable = executableGraph(graph)
  // Record-family type propagation (mirrors propagateRecordTypes in
  // src/lib/flows.ts): generic nodes carry their inbound record subtype through
  // to undeclared outputs, so save-time validation matches the editor's live
  // socket colours. We only need effective *output* types — an edge is checked
  // as source-effective-output vs target-declared-input.
  const effOut = effectiveOutputs(runnable, portsFor)
  const srcType = (nodeId: string, portId: string): PortDataType => effOut.get(`${nodeId}:${portId}`) ?? 'items'
  for (const edge of runnable.edges) {
    const source = runnable.nodes.find((n) => n.id === edge.source)
    const target = runnable.nodes.find((n) => n.id === edge.target)
    if (!source) return `Edge ${edge.id}: unknown source node`
    if (!target) return `Edge ${edge.id}: unknown target node`
    const sourceSpec = portsFor(source)
    const targetSpec = portsFor(target)
    if (!sourceSpec || !targetSpec) return `Unknown node type on edge ${edge.id}`
    const out = sourceSpec.outputs.find((o) => o.id === edge.sourceHandle)
    if (!out) return `Edge ${edge.id}: ${source.type} has no output "${edge.sourceHandle}"`
    const inp = targetSpec.inputs.find((i) => i.id === edge.targetHandle)
    if (!inp) return `Edge ${edge.id}: ${target.type} has no input "${edge.targetHandle}"`
    const srcEff = srcType(edge.source, edge.sourceHandle)
    if (!portCompatible(srcEff, inp.dataType))
      return `Edge ${edge.id}: can't connect ${srcEff} output "${edge.sourceHandle}" to ${inp.dataType ?? 'items'} input "${edge.targetHandle}"`
  }
  if (topoOrder(runnable) === null) return 'Graph has a cycle'
  return null
}

/** A declared record type is "fixed" (doesn't propagate) when it's a value type
 * or a concrete record subtype; base 'items'/undefined propagates. */
const isFixedType = (t: PortDataType | undefined): boolean => t !== undefined && t !== 'items'

/** Effective output type per port after record-family propagation, keyed
 * `${nodeId}:${portId}`. Fixed ports keep their declared type; propagating
 * record ports take the LCA of their inbound record types. Mirrors the output
 * half of propagateRecordTypes in src/lib/flows.ts — keep in sync. */
function effectiveOutputs(
  graph: FlowGraph,
  portsFor: (node: FlowNode) => ResolvedNodeSpec | undefined,
): Map<string, PortDataType> {
  const ordered = topoOrder(graph) ?? graph.nodes
  const eff = new Map<string, PortDataType>()
  const outEff = (nodeId: string, portId: string): PortDataType => {
    const node = graph.nodes.find((n) => n.id === nodeId)
    const declared = node ? portsFor(node)?.outputs.find((o) => o.id === portId)?.dataType : undefined
    return eff.get(`${nodeId}:${portId}`) ?? declared ?? 'items'
  }
  for (const node of ordered) {
    const ports = portsFor(node)
    if (!ports) continue
    let mergedIn: PortDataType | undefined
    for (const inp of ports.inputs) {
      let e: PortDataType | undefined
      for (const edge of graph.edges) {
        if (edge.target !== node.id || edge.targetHandle !== inp.id) continue
        const st = outEff(edge.source, edge.sourceHandle)
        e = e === undefined ? st : isRecordType(e) && isRecordType(st) ? recordLCA(e, st) : e
      }
      const effIn = e ?? inp.dataType ?? 'items'
      if (isRecordType(effIn) && (e !== undefined || isFixedType(inp.dataType)))
        mergedIn = mergedIn === undefined ? effIn : recordLCA(mergedIn, effIn)
    }
    for (const out of ports.outputs) {
      eff.set(`${node.id}:${out.id}`, isFixedType(out.dataType) ? (out.dataType as PortDataType) : mergedIn ?? 'items')
    }
  }
  return eff
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

/**
 * Exclusive routers (Switch): only non-empty output arms activate downstream.
 * Splitters like Compare still schedule both branches even when one side is empty.
 */
function isExclusiveRouter(type: string): boolean {
  return type === 'filter.switch'
}

/**
 * Pure value producers (Random, Text, Number, …) have no inputs so topo-order
 * would run them at the start of every flow. They are demand-driven instead:
 * only evaluated when an active downstream consumer pulls them (e.g. once the
 * path reaches the Switch / Set-field that needs the value).
 */
function isLazyProducer(type: string): boolean {
  return type.startsWith('value.')
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
  /**
   * Resolves flow.subflow node ports against the referenced flow's published
   * interface, same as passed to validateGraph directly. Without this, the
   * internal pre-flight validateGraph call falls back to flow.subflow's
   * static placeholder spec (single "in"/"out" ports) and rejects any graph
   * whose subflow nodes use their real, derived port ids.
   */
  resolveSpec?: SpecResolver
  /** The named event firing this run: only a matching `trigger.start` emits its
   * payload. Omitted/null = a manual whole-flow run (every trigger fires). */
  trigger?: TriggerEvent | null
}

export interface RunFlowResult extends RunReport {
  /** Inputs gathered for each node right before it ran, keyed by node id then
   * input handle. boundary.output collection reads `items` off of this to
   * recover what a published component produced on each output port. */
  finalInputs?: Map<string, Record<string, FlowItem[]>>
  /** Deferred publishes from `trigger.fire` nodes, for the caller's dispatcher
   * to fan out once the flow lock is free (see fireTrigger in flowRoutes). */
  fires?: FireRequest[]
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
  const { hooks, injectOutput, qualifyId, resolveSpec, trigger } = normalizeRunOptions(hooksOrOptions)
  const qid = qualifyId ?? ((id: string) => id)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const reports: Record<string, NodeReport> = {}
  const finalInputs = new Map<string, Record<string, FlowItem[]>>()
  // trigger.fire nodes push deferred publishes here; returned to the caller.
  const fireQueue: FireRequest[] = []

  const invalid = validateGraph(graph, resolveSpec)
  if (invalid) {
    return { ok: false, dryRun, startedAt, durationMs: Date.now() - t0, nodes: {}, error: invalid }
  }

  const runnable = executableGraph(graph)
  // Cycle check (also used by validateGraph); execution is demand-driven below.
  if (topoOrder(runnable) === null) {
    return { ok: false, dryRun, startedAt, durationMs: Date.now() - t0, nodes: {}, error: 'Graph has a cycle' }
  }
  const nodeById = new Map(runnable.nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, FlowEdge[]>()
  const incoming = new Map<string, FlowEdge[]>()
  for (const n of runnable.nodes) {
    outgoing.set(n.id, [])
    incoming.set(n.id, [])
  }
  for (const e of runnable.edges) {
    outgoing.get(e.source)?.push(e)
    incoming.get(e.target)?.push(e)
  }

  // node id -> output handle -> items
  const buffers = new Map<string, Record<string, FlowItem[]>>()
  const failed = new Set<string>()
  /** Nodes that produced outputs (including gated empties). Exclusive-router gating. */
  const active = new Set<string>()
  /** Finished ensureRan (ran, gated, failed, or silent-skipped). */
  const settled = new Set<string>()
  const ensuring = new Set<string>()

  /** An incoming edge activates its target when the source ran and — for
   * exclusive routers like Switch — the specific output arm carried items. */
  const edgeActivates = (e: FlowEdge): boolean => {
    if (failed.has(e.source) || !active.has(e.source)) return false
    const src = nodeById.get(e.source)
    if (!src) return false
    if (isExclusiveRouter(src.type)) {
      return (buffers.get(e.source)?.[e.sourceHandle]?.length ?? 0) > 0
    }
    return true
  }

  const emptyBuffers = (node: FlowNode) => {
    const impl = NODE_REGISTRY.get(node.type)!
    const ports = impl.resolvePorts?.(node.config ?? {}).outputs ?? impl.spec.outputs
    const out: Record<string, FlowItem[]> = {}
    for (const p of ports) out[p.id] = []
    return { ports, out }
  }

  const scheduleActivated = (nodeId: string, pending: Set<string>) => {
    for (const e of outgoing.get(nodeId) ?? []) {
      if (edgeActivates(e)) pending.add(e.target)
    }
  }

  async function ensureRan(nodeId: string, pending: Set<string>): Promise<void> {
    if (settled.has(nodeId)) return
    if (ensuring.has(nodeId)) return // cycle already rejected by validate; re-entry no-op
    const node = nodeById.get(nodeId)
    if (!node || isEditorNode(node.type)) {
      settled.add(nodeId)
      return
    }
    const impl = NODE_REGISTRY.get(node.type)
    if (!impl) {
      settled.add(nodeId)
      return
    }
    ensuring.add(nodeId)

    const ins = incoming.get(nodeId) ?? []
    // Pull upstream first (lazy value.* nodes, deferred branches, …).
    for (const e of ins) {
      await ensureRan(e.source, pending)
    }

    const reportKey = qid(node.id)
    const emitEmpty = (status: NodeReport['status'], notes: string[], error?: string) => {
      const { ports, out } = emptyBuffers(node)
      buffers.set(node.id, out)
      reports[reportKey] = {
        status,
        durationMs: 0,
        counts: Object.fromEntries(ports.map((p) => [p.id, 0])),
        samples: {},
        notes,
        ...(error ? { error } : {}),
      }
      hooks?.onNodeDone?.(reportKey, reports[reportKey])
    }

    if (ins.some((e) => failed.has(e.source))) {
      failed.add(node.id)
      emitEmpty('skipped', ['skipped: upstream node failed'])
      settled.add(node.id)
      ensuring.delete(node.id)
      return
    }

    // Exclusive Switch: only arms that emitted items schedule downstream.
    // Silent skip — no report/hooks — so untaken arms don't flash or wipe trails.
    if (ins.length > 0 && !ins.some(edgeActivates)) {
      const { out } = emptyBuffers(node)
      buffers.set(node.id, out)
      settled.add(node.id)
      ensuring.delete(node.id)
      return
    }

    hooks?.onNodeStart?.(reportKey)

    const inputs: Record<string, FlowItem[]> = {}
    const inPorts = impl.resolvePorts?.(node.config ?? {}).inputs ?? impl.spec.inputs
    for (const port of inPorts) inputs[port.id] = []
    for (const e of ins) {
      const produced = buffers.get(e.source)?.[e.sourceHandle] ?? []
      inputs[e.targetHandle] = [...(inputs[e.targetHandle] ?? []), ...produced]
    }
    finalInputs.set(node.id, inputs)

    const whenWired = ins.some((e) => e.targetHandle === 'when')
    if (whenWired && (inputs.when?.length ?? 0) === 0) {
      emitEmpty('ok', ['gated: not triggered'])
      active.add(node.id)
      settled.add(node.id)
      ensuring.delete(node.id)
      scheduleActivated(node.id, pending)
      return
    }

    const ctx: RunContext = {
      dryRun,
      notes: [],
      nodeId: node.id,
      hooks,
      trigger: trigger ?? null,
      fireQueue,
      mergeNestedReports: (nested) => {
        Object.assign(reports, nested)
      },
    }
    const nodeT0 = Date.now()
    try {
      const injected = node.type === 'boundary.input' ? injectOutput?.(node) ?? null : null
      const outputs = injected !== null ? { items: injected } : await impl.run(inputs, node.config ?? {}, ctx)
      buffers.set(node.id, outputs)
      active.add(node.id)
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
    settled.add(node.id)
    ensuring.delete(node.id)
    if (active.has(node.id)) scheduleActivated(node.id, pending)
  }

  // Starters: indegree-0 nodes that aren't lazy value producers. Lazy producers
  // (value.random, value.text, …) are pulled only when an active consumer needs
  // them — so a Random → Values-to-items chain feeding one Switch arm stays idle
  // until that arm is taken (or until a pre-switch consumer on the live path pulls it).
  let starters = runnable.nodes.filter(
    (n) => !isEditorNode(n.type) && (incoming.get(n.id)?.length ?? 0) === 0 && !isLazyProducer(n.type),
  )
  if (starters.length === 0) {
    // Pure value graphs (e.g. random → log) still need to run.
    starters = runnable.nodes.filter(
      (n) => !isEditorNode(n.type) && (incoming.get(n.id)?.length ?? 0) === 0,
    )
  }

  const pending = new Set(starters.map((n) => n.id))
  while (pending.size > 0) {
    const id = pending.values().next().value!
    pending.delete(id)
    await ensureRan(id, pending)
  }

  const ok = Object.values(reports).every((r) => r.status !== 'error')
  return { ok, dryRun, startedAt, durationMs: Date.now() - t0, nodes: reports, finalInputs, fires: fireQueue }
}
