import type { FlowGraph, SpecResolver } from './flowExecutor.js'
import { NODE_REGISTRY } from './flowNodes.js'
import type { ConfigField, NodePort, NodeSpec } from './flowNodes.js'
import { parseComponent } from './flowsDb.js'

export interface ExposedParam {
  nodeId: string
  configKey: string
  label?: string
}

export interface FlowComponentMeta {
  published: boolean
  label: string
  description: string
  category: 'source' | 'filter' | 'enrich' | 'combine' | 'sink'
  exposedParams: ExposedParam[]
}

export interface ComponentInterface {
  flowId: number
  inputs: NodePort[]
  outputs: NodePort[]
  exposedParams: (ExposedParam & Pick<ConfigField, 'kind' | 'options'> & { default?: unknown })[]
}

export function enrichExposedParams(
  graph: FlowGraph,
  meta: FlowComponentMeta,
): ComponentInterface['exposedParams'] {
  return meta.exposedParams.flatMap((p) => {
    const node = graph.nodes.find((n) => n.id === p.nodeId)
    if (!node) return []
    const spec = NODE_REGISTRY.get(node.type)?.spec
    const field = spec?.config.find((f) => f.key === p.configKey)
    if (!field) return []
    return [{
      ...p,
      label: p.label ?? field.label,
      kind: field.kind,
      default: node.config[p.configKey] ?? field.default,
      options: field.options,
    }]
  })
}

export function deriveInterface(
  flowId: number,
  graph: FlowGraph,
  meta?: FlowComponentMeta | null,
): ComponentInterface | { error: string } {
  const inputs: NodePort[] = []
  const outputs: NodePort[] = []
  const portIds = new Set<string>()

  for (const node of graph.nodes) {
    if (node.type === 'boundary.input') {
      const portId = String(node.config.portId ?? '').trim()
      const label = String(node.config.label ?? portId)
      if (!portId) return { error: `Boundary input ${node.id} missing portId` }
      if (portIds.has(portId)) return { error: `Duplicate portId: ${portId}` }
      portIds.add(portId)
      inputs.push({ id: portId, label })
    } else if (node.type === 'boundary.output') {
      const portId = String(node.config.portId ?? '').trim()
      const label = String(node.config.label ?? portId)
      if (!portId) return { error: `Boundary output ${node.id} missing portId` }
      if (portIds.has(portId)) return { error: `Duplicate portId: ${portId}` }
      portIds.add(portId)
      outputs.push({ id: portId, label })
    }
  }

  if (inputs.length === 0) return { error: 'Published component needs at least one boundary input' }
  if (outputs.length === 0) return { error: 'Published component needs at least one boundary output' }

  return {
    flowId,
    inputs,
    outputs,
    exposedParams: meta ? enrichExposedParams(graph, meta) : [],
  }
}

export function validatePublish(graph: FlowGraph): string | null {
  const iface = deriveInterface(0, graph)
  if ('error' in iface) return iface.error
  return null
}

/** flow.subflow node ids reference other flows by config.flowId. */
export function findSubflowReferences(graph: FlowGraph): number[] {
  return graph.nodes
    .filter((n) => n.type === 'flow.subflow')
    .map((n) => Number(n.config.flowId))
    .filter((id) => Number.isFinite(id))
}

/**
 * Walks flow.subflow references starting at rootFlowId looking for a cycle
 * (a flow that, transitively, embeds itself). loadGraph should return null
 * for a missing/corrupt flow so a dangling reference doesn't crash the walk.
 */
export function detectReferenceCycle(
  rootFlowId: number,
  loadGraph: (id: number) => FlowGraph | null,
): string | null {
  const stack = new Set<number>()
  const visited = new Set<number>()

  function dfs(flowId: number): string | null {
    if (stack.has(flowId)) return `Reference cycle involving flow ${flowId}`
    if (visited.has(flowId)) return null
    visited.add(flowId)
    stack.add(flowId)
    const graph = loadGraph(flowId)
    if (graph) {
      for (const ref of findSubflowReferences(graph)) {
        const err = dfs(ref)
        if (err) return err
      }
    }
    stack.delete(flowId)
    return null
  }

  return dfs(rootFlowId)
}

/**
 * Builds a SpecResolver for validateGraph that resolves flow.subflow nodes to
 * the published interface of the flow they reference — the only node type
 * not in the static NODE_REGISTRY. parentFlowId is the id of the flow being
 * saved (null when creating/validating a graph with no flow id yet), used to
 * reject a component embedding itself directly.
 */
export function buildSpecResolver(
  parentFlowId: number | null,
  getFlowRow: (id: number) => { graph: string; component: string | null } | undefined,
): SpecResolver {
  return (node) => {
    if (node.type !== 'flow.subflow') return null
    const flowId = Number(node.config.flowId)
    if (!Number.isFinite(flowId)) return null
    if (parentFlowId !== null && flowId === parentFlowId) return null // self-ref
    const row = getFlowRow(flowId)
    if (!row) return null
    const meta = parseComponent(row.component)
    if (!meta?.published) return null
    let graph: FlowGraph
    try {
      graph = JSON.parse(row.graph) as FlowGraph
    } catch {
      return null
    }
    const iface = deriveInterface(flowId, graph, meta)
    if ('error' in iface) return null
    return { inputs: iface.inputs, outputs: iface.outputs }
  }
}

export function componentToNodeSpec(
  flowId: number,
  flowName: string,
  meta: FlowComponentMeta,
  iface: ComponentInterface,
): NodeSpec {
  return {
    type: 'flow.subflow',
    label: meta.label || flowName,
    category: meta.category,
    description: meta.description,
    inputs: iface.inputs,
    outputs: iface.outputs,
    config: [
      {
        key: 'flowId',
        label: 'Component flow',
        kind: 'select',
        default: flowId,
        options: [{ value: String(flowId), label: flowName }],
      },
      ...iface.exposedParams.map((p) => ({
        key: `params.${p.nodeId}.${p.configKey}`,
        label: p.label ?? p.configKey,
        kind: p.kind,
        default: p.default as string | number | boolean | undefined,
        options: p.options,
      })),
    ],
  }
}
