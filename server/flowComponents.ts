import type { FlowGraph } from './flowExecutor.js'
import { NODE_REGISTRY } from './flowNodes.js'
import type { ConfigField, NodePort, NodeSpec } from './flowNodes.js'

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
