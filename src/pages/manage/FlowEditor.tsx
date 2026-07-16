import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  reconnectEdge,
  getNodesBounds,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeProps,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './flowEditor.css'
import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Layers,
  Loader2,
  Play,
  Plus,
  Save,
  Search,
  StickyNote,
  Waypoints,
  Trash2,
  Undo2,
  Redo2,
  Unlink,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getFlow,
  getFlowComponents,
  getFlowInterface,
  getNodeTypes,
  saveFlow,
  runFlowStream,
  portCompatible,
  resolveNodePorts,
  propagateRecordTypes,
  type RunTrigger,
  type NodeSpec,
  type NodeCategory,
  type NodePort,
  type PortDataType,
  type ConfigField,
  type FlowGraph,
  type FlowComponentMeta,
  type RunReport,
  type NodeReport,
  type ComponentInterface,
} from '@/lib/flows'
import {
  DEFAULT_ARROW_POINTS,
  isEditorNode,
  editorRotationFromConfig,
  normalizeArrowConfig,
  normalizeRotation,
  type ArrowDash,
  type ArrowHead,
} from '@/lib/flowEditorMeta'
import {
  editorNodeTypes,
  editorRfType,
} from './flowEditorAnnotations'
import { useFlowHistory } from './useFlowHistory'

// ---- graph <-> React Flow conversion ---------------------------------------

interface FlowNodeData extends Record<string, unknown> {
  specType: string
  config: Record<string, unknown>
  report?: NodeReport
  running?: boolean
  onEditorChange?: (patch: Record<string, unknown>) => void
  /** Fire the flow from this trigger node (per-node ▶). Set on trigger nodes. */
  onRunTrigger?: () => void
  /** True while any run is in progress (disables the per-node ▶). */
  runDisabled?: boolean
  /** Soft-dim nodes not yet touched during a live/dry run. */
  dimmed?: boolean
  /** Epoch ms — remount flash burst overlay while Date.now() < this. */
  flashUntil?: number
}

type RFNode = Node<FlowNodeData, 'flow' | 'reroute' | 'sticky' | 'arrow' | 'group'>
type RFEdge = Edge<{ pulse?: number; pulseAt?: number }>

const CATEGORY_DOT: Record<NodeCategory, string> = {
  trigger: 'bg-lime-400',
  source: 'bg-violet-400',
  filter: 'bg-sky-400',
  enrich: 'bg-amber-400',
  combine: 'bg-emerald-400',
  sink: 'bg-rose-400',
  value: 'bg-pink-400',
  boundary: 'bg-slate-400',
}

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  trigger: 'Trigger',
  source: 'Source',
  filter: 'Filter',
  enrich: 'Enrich',
  combine: 'Combine',
  sink: 'Sink',
  value: 'Value',
  boundary: 'Boundary',
}

const NODE_CATEGORIES: NodeCategory[] = ['trigger', 'source', 'filter', 'enrich', 'combine', 'sink', 'value', 'boundary']

/** Handle/wire color per port data type. Base 'items' keeps the neutral gray
 * the editor always had (it's genuinely "any record"); the record subtypes get
 * distinct bright hues — cool purples/indigo/fuchsia for the torrent/release/
 * catalog side, a warm gold pair for file/probed (probed a near-shade of file,
 * to read as is-a) — and the value types keep their own hues, so any socket is
 * findable at a glance (matching Blender-style typed sockets). Green and red are
 * deliberately NOT used here — they're reserved for run/dry-run outcome
 * (node ✓/✕), so a healthy typed graph never looks like an all-pass run. */
const PORT_COLOR: Record<PortDataType, string> = {
  items: 'var(--muted-foreground)',
  torrent: '#c084fc', // purple-400 — a raw download
  release: '#818cf8', // indigo-400 — a magnet search result
  catalog: '#e879f9', // fuchsia-400 — a metadata catalog entry
  file: '#facc15', // yellow-400 — a video file on disk
  probed: '#F9A825', // yellow-800 — a probed file (is-a file)
  text: '#38bdf8', // sky-400
  number: '#fbbf24', // amber-400
  color: '#f472b6', // pink-400
  url: '#2dd4bf', // teal-400
  json: '#fb923c', // orange-400
  embed: '#a78bfa', // violet-400
}

const portColor = (t: PortDataType | undefined) => PORT_COLOR[t ?? 'items']
const portTitle = (p: NodePort, eff?: PortDataType) =>
  `${p.label} (${eff ?? p.dataType ?? 'items'})`

/** Activation color: trigger outputs, `when` gate inputs, and the wires between
 * them read lime (matching the trigger category), so the fire path stands out. */
const TRIGGER_LIME = '#a3e635' // lime-400

/** Effective (propagated) port types keyed `${nodeId}:in|out:${portId}`, so a
 * generic node's sockets/wires show the record subtype flowing through it. */
const PropagatedTypesContext = createContext<Map<string, PortDataType>>(new Map())

/** The RunTrigger a trigger node fires from its ▶ button, or null for non-entry
 * nodes (e.g. trigger.fire, which publishes rather than starts). manual:true so
 * event triggers emit a sample. */
function runTriggerFor(specType: string, config: Record<string, unknown>): RunTrigger | null {
  if (specType === 'trigger.start')
    return { kind: 'start', name: String(config.name ?? 'start'), manual: true }
  if (specType === 'trigger.new-item') return { kind: 'new-item', manual: true }
  if (specType === 'trigger.new-portal') return { kind: 'new-portal', manual: true }
  if (specType === 'trigger.qbit-complete') return { kind: 'qbit-complete', manual: true }
  if (specType === 'trigger.release') return { kind: 'release', manual: true }
  return null
}

/** Node ids reachable downstream from `start` over the given edges (includes
 * `start`). Used to scope run results to the fired trigger's branch — the other
 * triggers run server-side but did nothing for this fire, so we don't paint them. */
function reachableFrom(start: string, edges: { source: string; target: string }[]): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target)
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const t of adj.get(cur) ?? []) if (!seen.has(t)) { seen.add(t); queue.push(t) }
  }
  return seen
}

/** Categories a flow can publish itself as when exposed as a reusable component. */
const COMPONENT_CATEGORIES: Exclude<NodeCategory, 'boundary'>[] = [
  'source',
  'filter',
  'enrich',
  'combine',
  'sink',
]

/** Categories collapsed by default in the add-node picker (largest / less common first picks). */
const DEFAULT_COLLAPSED: ReadonlySet<NodeCategory> = new Set(['enrich', 'sink'])

function matchesNodeSearch(spec: NodeSpec, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    spec.label.toLowerCase().includes(q) ||
    spec.description.toLowerCase().includes(q) ||
    spec.type.toLowerCase().includes(q)
  )
}

function groupSpecs(specs: NodeSpec[], query: string) {
  return NODE_CATEGORIES.map((category) => ({
    category,
    specs: specs.filter((s) => s.category === category && matchesNodeSearch(s, query)),
  })).filter((g) => g.specs.length > 0)
}

/** Synthetic key for the collapsible "Custom" folder, tracked alongside NodeCategory keys. */
const CUSTOM_FOLDER = 'custom' as const
type FolderKey = NodeCategory | typeof CUSTOM_FOLDER

/** Shared add-node palette: search + collapsible category folders. */
function NodePicker({
  specs,
  components = [],
  onSelect,
  compact = false,
}: {
  specs: NodeSpec[]
  components?: NodeSpec[]
  onSelect: (spec: NodeSpec) => void
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<FolderKey>>(() => new Set(DEFAULT_COLLAPSED))

  const grouped = useMemo(() => groupSpecs(specs, query), [specs, query])
  const matchedComponents = useMemo(
    () => components.filter((s) => matchesNodeSearch(s, query)),
    [components, query],
  )
  const searching = query.trim().length > 0

  const isCollapsed = (folder: FolderKey) => !searching && collapsed.has(folder)

  const toggleCategory = (folder: FolderKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-popover p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or description…"
            className="h-8 pl-8 text-sm"
            autoFocus
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <div className={compact ? 'max-h-64 overflow-auto' : 'max-h-72 overflow-auto'}>
        {grouped.length === 0 && matchedComponents.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching nodes</p>
        ) : (
          <>
            {grouped.map((g) => (
              <div key={g.category}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 pb-0.5 pt-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => toggleCategory(g.category)}
                >
                  {isCollapsed(g.category) ? (
                    <ChevronRight className="size-3 shrink-0" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0" />
                  )}
                  {CATEGORY_LABEL[g.category]}
                  <span className="ml-auto tabular-nums">{g.specs.length}</span>
                </button>
                {!isCollapsed(g.category)
                  ? g.specs.map((s) => (
                      <button
                        key={s.type}
                        type="button"
                        role="menuitem"
                        className={
                          compact
                            ? 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted'
                            : 'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted'
                        }
                        onClick={() => onSelect(s)}
                      >
                        <span className="flex items-center gap-2 text-sm">
                          <span className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[s.category]}`} />
                          {s.label}
                        </span>
                        {!compact ? (
                          <span className="line-clamp-2 text-[11px] text-muted-foreground">
                            {s.description}
                          </span>
                        ) : null}
                      </button>
                    ))
                  : null}
              </div>
            ))}
            {matchedComponents.length > 0 ? (
              <div key={CUSTOM_FOLDER}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2 pb-0.5 pt-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => toggleCategory(CUSTOM_FOLDER)}
                >
                  {isCollapsed(CUSTOM_FOLDER) ? (
                    <ChevronRight className="size-3 shrink-0" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0" />
                  )}
                  Custom
                  <span className="ml-auto tabular-nums">{matchedComponents.length}</span>
                </button>
                {!isCollapsed(CUSTOM_FOLDER)
                  ? matchedComponents.map((s) => (
                      <button
                        key={s.type + ':' + String(s.config.find((f) => f.key === 'flowId')?.default)}
                        type="button"
                        role="menuitem"
                        className={
                          compact
                            ? 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted'
                            : 'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted'
                        }
                        onClick={() => onSelect(s)}
                      >
                        <span className="flex items-center gap-2 text-sm">
                          <span className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[s.category]}`} />
                          {s.label}
                        </span>
                        {!compact ? (
                          <span className="line-clamp-2 text-[11px] text-muted-foreground">
                            {s.description}
                          </span>
                        ) : null}
                      </button>
                    ))
                  : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

let specLookup: Map<string, NodeSpec> = new Map()

/** Last-fetched interface per component flow id — lets edge coloring and
 * connection validation (which run outside React components) see a subflow
 * node's typed ports. Populated by useComponentInterface. */
const ifaceCache = new Map<number, ComponentInterface>()

interface ComponentInfo {
  interface: ComponentInterface
  component: FlowComponentMeta | null
  name: string
}

/** Fetches the derived interface (ports + exposed params) and component meta
 * for a flow.subflow node's referenced flow, refetching whenever flowId
 * changes. */
function useComponentInterface(flowId: number | undefined) {
  const [info, setInfo] = useState<ComponentInfo | null>(null)
  useEffect(() => {
    if (!Number.isFinite(flowId)) {
      setInfo(null)
      return
    }
    let cancelled = false
    void getFlowInterface(flowId!)
      .then((r) => {
        ifaceCache.set(flowId!, r.interface)
        if (!cancelled) setInfo(r)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [flowId])
  return info
}

/** Display name for a flow.subflow node: the component's custom label, falling
 * back to the referenced flow's name (same precedence as the node palette). */
function componentLabel(info: ComponentInfo | null): string | undefined {
  if (!info) return undefined
  return info.component?.label || info.name || undefined
}

function FlowNodeView({ id, data, selected }: NodeProps<RFNode>) {
  const propTypes = useContext(PropagatedTypesContext)
  const flowId = data.specType === 'flow.subflow' ? Number(data.config.flowId) : undefined
  const componentInfo = useComponentInterface(flowId)
  const componentIface = componentInfo?.interface ?? null
  const spec =
    specLookup.get(data.specType) ??
    (data.specType === 'flow.subflow'
      ? {
          type: 'flow.subflow',
          label: `Sub-flow ${data.config.flowId}`,
          category: 'combine' as const,
          description: '',
          inputs: [],
          outputs: [],
          config: [],
        }
      : null)
  const report = data.report
  if (!spec) {
    return (
      <div className="rounded-md border border-destructive bg-card px-3 py-2 text-xs">
        Unknown node: {data.specType}
      </div>
    )
  }
  const resolvedPorts = resolveNodePorts(spec, data.config)
  const allInputs = componentIface?.inputs ?? resolvedPorts.inputs
  const outputs = componentIface?.outputs ?? resolvedPorts.outputs
  // The `when` gate input is a trigger/activation socket — render it in the
  // header next to the title (an "action" affordance), not as a data-input row.
  const whenPort = allInputs.find((p) => p.id === 'when')
  const inputs = allInputs.filter((p) => p.id !== 'when')
  // Trigger nodes emit an activation signal — their outputs read lime.
  const isTrigger = (componentInfo?.component?.category ?? spec.category) === 'trigger'
  // Effective (propagated) type per port — a generic 'items' port shows the
  // record subtype flowing through it; falls back to the declared type.
  const effIn = (p: NodePort): PortDataType => propTypes.get(`${id}:in:${p.id}`) ?? p.dataType ?? 'items'
  const effOut = (p: NodePort): PortDataType => propTypes.get(`${id}:out:${p.id}`) ?? p.dataType ?? 'items'
  // A bare "in" label conveys nothing; show the type instead so every socket
  // reads as typed (this is what the single-input header dot used to hide).
  const inLabel = (p: NodePort) => (p.label === 'in' ? effIn(p) : p.label)
  const typedStyle = (t: PortDataType) => (t !== 'items' ? { color: portColor(t) } : undefined)
  const configLines = spec.config
    .map((f) => {
      const v = data.config[f.key] ?? f.default
      if (v === undefined || v === '') return null
      // Default-valued booleans are noise ("Batch: false"); render only when flipped.
      if (f.kind === 'boolean' && v === (f.default ?? false)) return null
      // Secrets never render on the canvas; multi-line JSON collapses to one line.
      return `${f.label}: ${f.kind === 'password' ? '••••••' : String(v).replace(/\s*\n\s*/g, ' ')}`
    })
    .filter(Boolean)
    .slice(0, 3)

  const running = data.running === true
  const flashUntil = data.flashUntil
  const flashing = typeof flashUntil === 'number' && flashUntil > Date.now()
  return (
    <div
      className={`relative min-w-44 max-w-56 rounded-md border bg-card text-card-foreground shadow-sm ${
        selected
          ? 'border-ring ring-2 ring-ring/40'
          : running
            ? 'border-ring ring-2 ring-ring/30'
            : report?.status === 'error'
              ? 'border-destructive'
              : report?.status === 'ok'
                ? 'border-emerald-500/50'
                : 'border-border'
      } ${data.dimmed && !flashing ? 'opacity-40' : ''}`}
    >
      {flashing ? (
        <span
          key={flashUntil}
          className="flow-node-flash-burst pointer-events-none absolute"
        />
      ) : null}
      <div
        className="relative z-[1] flex items-center gap-2 border-b border-border px-3 py-2"
        title={spec.description || undefined}
      >
        {whenPort ? (
          <Handle
            id={whenPort.id}
            type="target"
            position={Position.Left}
            className="!size-2.5 !border-border !bg-lime-400"
            title={`${whenPort.label} — runs only when a trigger fires it`}
          />
        ) : null}
        <span
          className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[componentInfo?.component?.category ?? spec.category]}`}
        />
        <span className="truncate text-xs font-medium">
          {componentLabel(componentInfo) ?? spec.label}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {data.onRunTrigger ? (
            <button
              type="button"
              title="Run the flow from this trigger"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-lime-400 disabled:opacity-40"
              disabled={data.runDisabled}
              onClick={(e) => {
                e.stopPropagation()
                data.onRunTrigger?.()
              }}
            >
              <Play className="size-3.5" />
            </button>
          ) : null}
          {running ? (
            <Loader2 className="size-3.5 animate-spin text-ring" />
          ) : report?.status === 'ok' ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : report?.status === 'error' ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : null}
        </div>
      </div>
      {inputs.length > 0 ? (
        <div className="relative z-[1] border-b border-border py-1">
          {inputs.map((port) => (
            <div key={port.id} className="relative flex items-center gap-2 px-3 py-0.5">
              <Handle
                id={port.id}
                type="target"
                position={Position.Left}
                className="!size-2.5 !border-border"
                style={{ top: '50%', background: portColor(effIn(port)) }}
                title={portTitle(port, effIn(port))}
              />
              <span className="text-[10px] text-muted-foreground" style={typedStyle(effIn(port))}>
                {inLabel(port)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {configLines.length > 0 ? (
        <div className="relative z-[1] space-y-0.5 border-b border-border px-3 py-1.5">
          {configLines.map((line) => (
            <p key={line} className="truncate text-[10px] text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div className="relative z-[1] py-1">
        {outputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-end gap-2 px-3 py-0.5">
            {report ? (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                {report.counts[port.id] ?? 0}
              </span>
            ) : null}
            <span
              className="text-[10px] text-muted-foreground"
              style={isTrigger ? { color: TRIGGER_LIME } : typedStyle(effOut(port))}
            >
              {port.label}
            </span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              className="!size-2.5 !border-border"
              style={{ top: '50%', background: isTrigger ? TRIGGER_LIME : portColor(effOut(port)) }}
              title={portTitle(port, effOut(port))}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A connection anchor: a bare movable dot that passes data through, coloured by
 * the (propagated) type of the connection running through it. The visible dot is
 * small, but it sits in a larger transparent box so it's an easy click/drag
 * target. */
const REROUTE_BOX = 30 // transparent drag hitbox
function RerouteNode({ id, selected }: NodeProps<RFNode>) {
  const propTypes = useContext(PropagatedTypesContext)
  const type = propTypes.get(`${id}:out:out`) ?? propTypes.get(`${id}:in:in`) ?? 'items'
  return (
    <div
      className="flex cursor-grab items-center justify-center"
      style={{ width: REROUTE_BOX, height: REROUTE_BOX }}
      title={`Reroute (${type})`}
    >
      <div
        className={`rounded-full border ${selected ? 'ring-2 ring-ring/60' : ''}`}
        style={{ width: 14, height: 14, background: portColor(type), borderColor: 'var(--border)' }}
      >
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          className="!size-3 !border-0 !bg-transparent"
          style={{ left: 0 }}
        />
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          className="!size-3 !border-0 !bg-transparent"
          style={{ right: 0 }}
        />
      </div>
    </div>
  )
}

const nodeTypes = { flow: FlowNodeView, reroute: RerouteNode, ...editorNodeTypes }

function RunThroughputEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<RFEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const pulse = data?.pulse
  const pulsing =
    typeof pulse === 'number' && pulse > 0 && data?.pulseAt != null && Date.now() - data.pulseAt < 2200
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        className={pulsing ? 'flow-run-edge-pulse' : undefined}
      />
      {pulsing ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-violet-500/90 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white shadow"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {pulse}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const edgeTypes = { throughput: RunThroughputEdge }

/** Map nested stream ids (`sub/inner`) onto the canvas parent node id. */
function canvasNodeId(streamId: string): string {
  const slash = streamId.indexOf('/')
  return slash >= 0 ? streamId.slice(0, slash) : streamId
}

const EDITOR_NODE_FLASH_MS = 1250
/** Minimum gap between successive node flashes (trail readability). */
const EDITOR_FLASH_COOLDOWN_MS = 250

function toRF(graph: FlowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  const lockedGroups = new Map(
    graph.nodes
      .filter((n) => n.type === 'editor.group')
      .map((n) => [n.id, Boolean(n.config.locked)]),
  )
  return {
    nodes: graph.nodes.map((n) => {
      const rfType = n.type === 'transform.reroute' ? 'reroute' : editorRfType(n.type)
      const groupId = typeof n.config.groupId === 'string' ? n.config.groupId : undefined
      const parentLocked = groupId ? lockedGroups.get(groupId) : false
      const config = { ...n.config }
      delete config.groupId
      if (n.type === 'editor.arrow') {
        const hadPoints = Array.isArray(n.config.points) && (n.config.points as unknown[]).length >= 2
        const normalized = normalizeArrowConfig(config)
        Object.assign(config, normalized)
        delete config.rotation
        delete config.direction
        // Legacy short boxes were for straight shafts — give curves room when migrating.
        if (!hadPoints && (typeof config.height !== 'number' || config.height < 80)) {
          config.height = 120
        }
        if (!hadPoints && (typeof config.width !== 'number' || config.width < 120)) {
          config.width = 200
        }
      }
      const width = typeof config.width === 'number' ? config.width : undefined
      const height = typeof config.height === 'number' ? config.height : undefined
      const style =
        width && height
          ? { width, height }
          : rfType === 'group'
            ? { width: width ?? 280, height: height ?? 180 }
            : rfType === 'arrow'
              ? { width: width ?? 200, height: height ?? 120 }
              : undefined
      return {
        id: n.id,
        type: rfType,
        position: n.position,
        parentId: groupId,
        extent: groupId ? ('parent' as const) : undefined,
        style,
        zIndex: rfType === 'group' ? -1 : undefined,
        connectable: rfType === 'flow' || rfType === 'reroute',
        draggable: !parentLocked,
        selectable: rfType === 'group' || !parentLocked,
        data: { specType: n.type, config },
      }
    }),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  }
}

function fromRF(nodes: RFNode[], edges: RFEdge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => {
      const config = { ...n.data.config }
      const w = n.style?.width
      const h = n.style?.height
      if (typeof w === 'number') config.width = w
      if (typeof h === 'number') config.height = h
      if (n.parentId) config.groupId = n.parentId
      return {
        id: n.id,
        type: n.data.specType,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        config,
      }
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? '',
      target: e.target,
      targetHandle: e.targetHandle ?? '',
    })),
  }
}

// ---- editor page ------------------------------------------------------------

/** Right-click menu state: where it opened and what it targets. */
interface MenuState {
  kind: 'pane' | 'node' | 'edge' | 'selection'
  x: number
  y: number
  targetId?: string
}

const EDITOR_DEFAULTS: Record<string, Record<string, unknown>> = {
  'editor.sticky': {
    text: '',
    color: '#fef08a',
    width: 180,
    height: 120,
    fontSize: 12,
    textAlign: 'left',
    verticalAlign: 'top',
    rotation: 0,
  },
  'editor.arrow': {
    width: 200,
    height: 120,
    color: '#a1a1aa',
    strokeWidth: 2,
    headSize: 10,
    dash: 'solid',
    startHead: 'none',
    endHead: 'arrow',
    points: DEFAULT_ARROW_POINTS.map((p) => ({ ...p })),
  },
  'editor.group': { title: 'Group', color: 'rgba(124, 92, 255, 0.12)', width: 280, height: 180, locked: false },
}

const ARROW_DASH_OPTIONS: { value: ArrowDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
]

const ARROW_HEAD_OPTIONS: { value: ArrowHead; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'open', label: 'Open' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'dot', label: 'Dot' },
]

function EditorRotationField({
  value,
  onChange,
}: {
  value: number
  onChange: (deg: number) => void
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium" htmlFor="ed-rotation">
        Rotation
      </label>
      <div className="flex flex-wrap gap-1">
        <Input
          id="ed-rotation"
          className="h-8 w-16"
          type="number"
          min={0}
          max={359}
          value={value}
          onChange={(e) => onChange(normalizeRotation(Number(e.target.value) || 0))}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => onChange(normalizeRotation(value - 15))}
        >
          −15°
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => onChange(normalizeRotation(value + 15))}
        >
          +15°
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => onChange(normalizeRotation(value + 90))}
        >
          +90°
        </Button>
      </div>
    </div>
  )
}

function FlowEditorInner() {
  const { flowId } = useParams<{ flowId: string }>()
  const navigate = useNavigate()
  const id = Number(flowId)

  const [specs, setSpecs] = useState<NodeSpec[]>([])
  const [components, setComponents] = useState<NodeSpec[]>([])
  const [name, setName] = useState('')
  const [component, setComponent] = useState<FlowComponentMeta | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [componentPanelOpen, setComponentPanelOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runningKind, setRunningKind] = useState<'dry' | 'real' | null>(null)
  // Dry vs Live is a persistent toggle (replaces the old Dry run / Apply buttons);
  // the run functions read it. A ref lets per-node ▶ handlers call the latest run.
  const [live, setLive] = useState(false)
  const runRef = useRef<(dryRun: boolean, trigger?: RunTrigger, fromNodeId?: string) => void>(() => {})
  const liveRef = useRef(live)
  const [report, setReport] = useState<RunReport | null>(null)
  const [error, setError] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const addAt = useRef(0)
  const clipboardRef = useRef<{ nodes: RFNode[]; edges: RFEdge[] } | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const flashQueue = useRef<string[]>([])
  const flashDrainTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashNextAt = useRef(0)
  const lastFlashAt = useRef(new Map<string, number>())
  const flashClearTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const playFlash = useCallback((nodeId: string) => {
    const now = Date.now()
    lastFlashAt.current.set(nodeId, now)
    const until = now + EDITOR_NODE_FLASH_MS
    setNodes((ns) =>
      ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, flashUntil: until } } : n)),
    )
    const prev = flashClearTimers.current.get(nodeId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      flashClearTimers.current.delete(nodeId)
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== nodeId || n.data.flashUntil !== until) return n
          return { ...n, data: { ...n.data, flashUntil: undefined } }
        }),
      )
    }, EDITOR_NODE_FLASH_MS + 40)
    flashClearTimers.current.set(nodeId, t)
  }, [setNodes])

  const drainFlashQueue = useCallback(() => {
    if (flashDrainTimer.current != null) return
    const tick = () => {
      flashDrainTimer.current = null
      const id = flashQueue.current.shift()
      if (!id) return
      playFlash(id)
      flashNextAt.current = Date.now() + EDITOR_FLASH_COOLDOWN_MS
      if (flashQueue.current.length > 0) {
        flashDrainTimer.current = setTimeout(tick, EDITOR_FLASH_COOLDOWN_MS)
      }
    }
    const wait = Math.max(0, flashNextAt.current - Date.now())
    flashDrainTimer.current = setTimeout(tick, wait)
  }, [playFlash])

  const flashNode = useCallback(
    (nodeId: string) => {
      const now = Date.now()
      if (flashQueue.current.includes(nodeId)) return
      const last = lastFlashAt.current.get(nodeId) ?? 0
      if (now - last < EDITOR_FLASH_COOLDOWN_MS) return
      flashQueue.current.push(nodeId)
      drainFlashQueue()
    },
    [drainFlashQueue],
  )

  useEffect(() => {
    const clearTimers = flashClearTimers.current
    return () => {
      for (const t of clearTimers.values()) clearTimeout(t)
      clearTimers.clear()
      if (flashDrainTimer.current) clearTimeout(flashDrainTimer.current)
      flashDrainTimer.current = null
      flashQueue.current = []
    }
  }, [])

  const {
    takeSnapshot: pushHistory,
    undo: undoHistory,
    redo: redoHistory,
    clear: clearHistory,
    canUndo,
    canRedo,
  } = useFlowHistory<RFNode, RFEdge>()

  const snapshot = useCallback(() => {
    pushHistory(nodesRef.current, edgesRef.current)
  }, [pushHistory])

  // Delete often emits node removes then edge removes in the same turn — one
  // snapshot for the whole gesture, not one per handler.
  const snapLock = useRef(false)
  const snapshotOnce = useCallback(() => {
    if (snapLock.current) return
    snapLock.current = true
    snapshot()
    queueMicrotask(() => {
      snapLock.current = false
    })
  }, [snapshot])

  const restoreSnapshot = useCallback(
    (snap: { nodes: RFNode[]; edges: RFEdge[] }) => {
      setNodes(snap.nodes)
      setEdges(snap.edges)
      setDirty(true)
    },
    [setNodes, setEdges],
  )

  const undo = useCallback(() => {
    undoHistory(nodesRef.current, edgesRef.current, restoreSnapshot)
  }, [undoHistory, restoreSnapshot])

  const redo = useCallback(() => {
    redoHistory(nodesRef.current, edgesRef.current, restoreSnapshot)
  }, [redoHistory, restoreSnapshot])

  useEffect(() => {
    if (!Number.isFinite(id)) {
      navigate('/manage/flows', { replace: true })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [types, flow, comps] = await Promise.all([
          getNodeTypes(),
          getFlow(id),
          getFlowComponents(),
        ])
        if (cancelled) return
        specLookup = new Map(types.nodeTypes.map((s) => [s.type, s]))
        // Reroute is added via the toolbar / double-click, not the palette.
        setSpecs(types.nodeTypes.filter((s) => s.type !== 'transform.reroute'))
        setComponents(comps)
        setName(flow.flow.name)
        setComponent(flow.flow.component)
        setEnabled(!!flow.flow.enabled)
        const rf = toRF(flow.flow.graph)
        setNodes(rf.nodes)
        setEdges(rf.edges)
        clearHistory()
        setDirty(false)
      } catch {
        if (!cancelled) navigate('/manage/flows', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, navigate, setNodes, setEdges, clearHistory])

  const selected = nodes.find((n) => n.selected)
  const selectedSpec = selected && !isEditorNode(selected.data.specType)
    ? specLookup.get(selected.data.specType)
    : undefined
  const selectedCount = nodes.filter((n) => n.selected).length
  const selectedFlowId =
    selected?.data.specType === 'flow.subflow' ? Number(selected.data.config.flowId) : undefined
  const selectedComponentInfo = useComponentInterface(selectedFlowId)
  const selectedComponentIface = selectedComponentInfo?.interface ?? null

  const innerReports = useMemo(() => {
    if (!report || !selected || selected.data.specType !== 'flow.subflow') return []
    const prefix = `${selected.id}/`
    return Object.entries(report.nodes).filter(([k]) => k.startsWith(prefix))
  }, [report, selected])

  // Every non-boundary node on the canvas that has configurable fields, for
  // the "expose parameters" checklist in the Component panel.
  const exposableFields = useMemo(() => {
    const out: { node: RFNode; spec: NodeSpec; field: ConfigField }[] = []
    for (const n of nodes) {
      const spec = specLookup.get(n.data.specType)
      if (!spec || spec.type.startsWith('boundary.')) continue
      for (const field of spec.config) out.push({ node: n, spec, field })
    }
    return out
  }, [nodes])

  const markDirty = () => setDirty(true)

  const patchEditorConfig = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setNodes((ns) => {
      let next = ns.map((n) => {
        if (n.id !== nodeId) return n
        const config = { ...n.data.config, ...patch }
        const style =
          typeof patch.width === 'number' && typeof patch.height === 'number'
            ? { ...n.style, width: patch.width, height: patch.height }
            : n.style
        return { ...n, data: { ...n.data, config }, style }
      })
      if ('locked' in patch) {
        const group = next.find((n) => n.id === nodeId)
        if (group?.data.specType === 'editor.group') {
          const locked = Boolean(patch.locked)
          next = next.map((n) =>
            n.parentId === nodeId ? { ...n, draggable: !locked, selectable: !locked } : n,
          )
        }
      }
      return next
    })
    markDirty()
  }, [setNodes])

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const trigger = runTriggerFor(n.data.specType, n.data.config)
        const touched = Boolean(n.data.running || n.data.report)
        return {
          ...n,
          data: {
            ...n.data,
            onEditorChange: isEditorNode(n.data.specType)
              ? (patch: Record<string, unknown>) => patchEditorConfig(n.id, patch)
              : undefined,
            onRunTrigger: trigger ? () => runRef.current(!liveRef.current, trigger, n.id) : undefined,
            runDisabled: runningKind !== null,
            dimmed: runningKind !== null && !touched && !isEditorNode(n.data.specType),
          },
        }
      }),
    [nodes, patchEditorConfig, runningKind],
  )

  const togglePublish = (published: boolean) => {
    setComponent((prev) => {
      if (published) {
        return prev
          ? { ...prev, published: true }
          : { published: true, label: name, description: '', category: 'source', exposedParams: [] }
      }
      return prev ? { ...prev, published: false } : null
    })
    markDirty()
  }

  const setComponentField = <K extends keyof FlowComponentMeta>(key: K, value: FlowComponentMeta[K]) => {
    setComponent((prev) => (prev ? { ...prev, [key]: value } : prev))
    markDirty()
  }

  const toggleExposedParam = (nodeId: string, configKey: string, checked: boolean) => {
    setComponent((prev) => {
      if (!prev) return prev
      const exposedParams = checked
        ? [...prev.exposedParams, { nodeId, configKey }]
        : prev.exposedParams.filter((p) => !(p.nodeId === nodeId && p.configKey === configKey))
      return { ...prev, exposedParams }
    })
    markDirty()
  }

  const onConnect = useCallback(
    (conn: Connection) => {
      snapshot()
      setEdges((eds) => addEdge(conn, eds))
      setDirty(true)
    },
    [setEdges, snapshot],
  )

  const onReconnect = useCallback(
    (oldEdge: RFEdge, newConnection: Connection) => {
      snapshot()
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds))
      setDirty(true)
    },
    [setEdges, snapshot],
  )

  /** Resolves the NodePort behind one end of a connection: subflow nodes via
   * the fetched component interface (typed boundary ports), everything else
   * via its spec + config-driven ports. Unresolvable ports come back
   * undefined, which portCompatible treats as plain 'items'. */
  const findPort = useCallback(
    (
      nodeId: string | null | undefined,
      handleId: string | null | undefined,
      dir: 'out' | 'in',
    ): NodePort | undefined => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return undefined
      if (node.data.specType === 'flow.subflow') {
        const iface = ifaceCache.get(Number(node.data.config.flowId))
        if (!iface) return undefined
        return (dir === 'out' ? iface.outputs : iface.inputs).find((p) => p.id === handleId)
      }
      const spec = specLookup.get(node.data.specType)
      if (!spec) return undefined
      const ports = resolveNodePorts(spec, node.data.config)
      return (dir === 'out' ? ports.outputs : ports.inputs).find((p) => p.id === handleId)
    },
    [nodes],
  )

  // Blender-style record propagation: trace each generic node's inbound subtype
  // through to its outputs so sockets/wires show — and connections validate
  // against — the effective type. Mirrors the server's validateGraph.
  const propagatedTypes = useMemo(
    () =>
      propagateRecordTypes(
        {
          nodes: nodes.map((n) => ({ id: n.id, type: n.data.specType, position: n.position, config: n.data.config })),
          edges: edges.map((e) => ({
            id: e.id,
            source: e.source,
            sourceHandle: e.sourceHandle ?? '',
            target: e.target,
            targetHandle: e.targetHandle ?? '',
          })),
        },
        (node) => {
          if (node.type === 'flow.subflow') {
            const iface = ifaceCache.get(Number(node.config.flowId))
            return iface ? { inputs: iface.inputs, outputs: iface.outputs } : null
          }
          if (isEditorNode(node.type)) return null
          const spec = specLookup.get(node.type)
          return spec ? resolveNodePorts(spec, node.config) : null
        },
      ),
    [nodes, edges],
  )

  // Blender-style typed sockets: dragging onto an incompatible input is
  // rejected live (the server re-validates on save as the backstop). The source
  // side uses its propagated (effective) type; the target its declared type.
  const isValidConnection = useCallback(
    (conn: Connection | RFEdge) => {
      const sourceNode = nodes.find((n) => n.id === conn.source)
      const targetNode = nodes.find((n) => n.id === conn.target)
      if (!sourceNode || !targetNode) return false
      if (sourceNode.type !== 'flow' || targetNode.type !== 'flow') return false
      const srcEff =
        propagatedTypes.get(`${conn.source}:out:${conn.sourceHandle}`) ??
        findPort(conn.source, conn.sourceHandle, 'out')?.dataType
      return portCompatible(srcEff, findPort(conn.target, conn.targetHandle, 'in')?.dataType)
    },
    [findPort, nodes, propagatedTypes],
  )

  // Wires take the color of the (propagated) type they carry; during a run,
  // recently completed nodes also get a pulsing throughput overlay.
  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const pulse = e.data?.pulse
        const pulsing =
          typeof pulse === 'number' &&
          pulse > 0 &&
          e.data?.pulseAt != null &&
          Date.now() - e.data.pulseAt < 2200
        const sourceCat = specLookup.get(
          nodes.find((n) => n.id === e.source)?.data.specType ?? '',
        )?.category
        const strokeWidth = pulsing ? 2.5 : 1.5
        if (e.targetHandle === 'when' || sourceCat === 'trigger') {
          return {
            ...e,
            type: 'throughput' as const,
            animated: pulsing,
            style: { ...e.style, stroke: TRIGGER_LIME, strokeWidth },
          }
        }
        const dataType =
          propagatedTypes.get(`${e.source}:out:${e.sourceHandle}`) ??
          findPort(e.source, e.sourceHandle, 'out')?.dataType
        const stroke = pulsing
          ? '#a78bfa'
          : dataType && dataType !== 'items'
            ? portColor(dataType)
            : undefined
        return {
          ...e,
          type: 'throughput' as const,
          animated: pulsing,
          style: {
            ...e.style,
            ...(stroke ? { stroke } : null),
            ...(pulsing || (dataType && dataType !== 'items') ? { strokeWidth } : null),
          },
        }
      }),
    [edges, findPort, propagatedTypes, nodes],
  )

  const addEditorNode = (
    specType: 'editor.sticky' | 'editor.arrow' | 'editor.group',
    position?: { x: number; y: number },
  ) => {
    snapshot()
    const n = addAt.current++
    const config = { ...EDITOR_DEFAULTS[specType] }
    const rfType = editorRfType(specType)
    const width = config.width as number
    const height = config.height as number
    setNodes((ns) => [
      ...ns.map((node) => ({ ...node, selected: false })),
      {
        id: `n${Date.now().toString(36)}${n}`,
        type: rfType,
        position: position ?? { x: 80 + n * 24, y: 80 + n * 24 },
        style: { width, height },
        zIndex: rfType === 'group' ? -1 : undefined,
        connectable: false,
        data: { specType, config },
        selected: true,
      },
    ])
    setPaletteOpen(false)
    setMenu(null)
    setDirty(true)
  }

  const addNode = (spec: NodeSpec, position?: { x: number; y: number }) => {
    snapshot()
    const n = addAt.current++
    const config =
      spec.type === 'flow.subflow'
        ? {
            flowId: Number(spec.config.find((f) => f.key === 'flowId')?.default),
            params: {},
          }
        : Object.fromEntries(
            spec.config.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
          )
    setNodes((ns) => [
      ...ns.map((node) => ({ ...node, selected: false })),
      {
        id: `n${Date.now().toString(36)}${n}`,
        type: 'flow' as const,
        position: position ?? { x: 80 + n * 24, y: 80 + n * 24 },
        data: { specType: spec.type, config },
        selected: true,
      },
    ])
    setPaletteOpen(false)
    setMenu(null)
    setDirty(true)
  }

  // A connection anchor — a real transform.reroute node rendered as a movable dot.
  const newReroute = (position: { x: number; y: number }): RFNode => {
    const n = addAt.current++
    return {
      id: `n${Date.now().toString(36)}${n}`,
      type: 'reroute' as const,
      position,
      connectable: true,
      data: { specType: 'transform.reroute', config: {} },
    }
  }

  const addReroute = (position?: { x: number; y: number }) => {
    snapshot()
    const n = addAt.current
    const node = newReroute(position ?? { x: 120 + n * 24, y: 120 + n * 24 })
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...node, selected: true }])
    setPaletteOpen(false)
    setMenu(null)
    setDirty(true)
  }

  // Double-clicking a wire drops an anchor onto it, splitting source→target into
  // source→reroute→target at the click point.
  const insertReroute = (edge: RFEdge, position: { x: number; y: number }) => {
    snapshot()
    // Center the box (and thus the visible dot) on the click point.
    const node = newReroute({ x: position.x - 15, y: position.y - 15 })
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...node, selected: true }])
    setEdges((eds) => [
      ...eds.filter((e) => e.id !== edge.id),
      { id: `e${node.id}a`, source: edge.source, sourceHandle: edge.sourceHandle, target: node.id, targetHandle: 'in' },
      { id: `e${node.id}b`, source: node.id, sourceHandle: 'out', target: edge.target, targetHandle: edge.targetHandle },
    ])
    setDirty(true)
  }

  const removeNode = (nodeId: string) => {
    snapshot()
    const target = nodes.find((n) => n.id === nodeId)
    if (target?.data.specType === 'editor.group') {
      setNodes((ns) =>
        ns
          .filter((n) => n.id !== nodeId)
          .map((n) => {
            if (n.parentId !== nodeId) return n
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              position: {
                x: n.position.x + target.position.x,
                y: n.position.y + target.position.y,
              },
            }
          }),
      )
    } else {
      setNodes((ns) => ns.filter((n) => n.id !== nodeId))
    }
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setMenu(null)
    setDirty(true)
  }

  const removeSelected = useCallback(() => {
    const ids = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
    if (ids.size === 0) return
    snapshot()
    setNodes((ns) => {
      let next = ns.filter((n) => !ids.has(n.id))
      for (const target of nodes) {
        if (!ids.has(target.id) || target.data.specType !== 'editor.group') continue
        next = next.map((n) => {
          if (n.parentId !== target.id || ids.has(n.id)) return n
          return {
            ...n,
            parentId: undefined,
            extent: undefined,
            position: {
              x: n.position.x + target.position.x,
              y: n.position.y + target.position.y,
            },
          }
        })
      }
      return next
    })
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
    setMenu(null)
    setDirty(true)
  }, [nodes, setNodes, setEdges, snapshot])

  const groupSelection = useCallback(() => {
    const picked = nodes.filter((n) => n.selected && n.data.specType !== 'editor.group')
    if (picked.length < 2) return
    snapshot()
    const bounds = getNodesBounds(picked)
    const padding = 24
    const titleH = 28
    const n = addAt.current++
    const groupId = `n${Date.now().toString(36)}${n}`
    const groupPos = { x: bounds.x - padding, y: bounds.y - padding - titleH }
    const gw = bounds.width + padding * 2
    const gh = bounds.height + padding * 2 + titleH
    const childIds = new Set(picked.map((node) => node.id))
    const groupNode: RFNode = {
      id: groupId,
      type: 'group',
      position: groupPos,
      style: { width: gw, height: gh },
      zIndex: -1,
      connectable: false,
      data: {
        specType: 'editor.group',
        config: { ...EDITOR_DEFAULTS['editor.group'], width: gw, height: gh },
      },
      selected: true,
    }
    setNodes((ns) => [
      ...ns
        .filter((node) => !childIds.has(node.id))
        .map((node) => ({ ...node, selected: false })),
      ...picked.map((node) => ({
        ...node,
        parentId: groupId,
        extent: 'parent' as const,
        position: {
          x: node.position.x - groupPos.x,
          y: node.position.y - groupPos.y,
        },
        selected: false,
      })),
      groupNode,
    ])
    setMenu(null)
    setDirty(true)
  }, [nodes, setNodes, snapshot])

  const copyNodes = useCallback(
    (nodeIds: string[]) => {
      const ids = new Set(nodeIds)
      const sel = nodes.filter((n) => ids.has(n.id))
      if (sel.length === 0) return
      clipboardRef.current = {
        nodes: sel.map((n) => ({
          ...n,
          selected: false,
          data: { specType: n.data.specType, config: { ...n.data.config } },
        })),
        edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      }
    },
    [nodes, edges],
  )

  const copySelection = useCallback(() => {
    copyNodes(nodes.filter((n) => n.selected).map((n) => n.id))
  }, [nodes, copyNodes])

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip) return
    snapshot()
    const idMap = new Map<string, string>()
    for (const node of clip.nodes) {
      idMap.set(node.id, `n${Date.now().toString(36)}${addAt.current++}`)
    }
    const offset = 40
    const newNodes: RFNode[] = clip.nodes.map((node) => ({
      ...node,
      id: idMap.get(node.id)!,
      parentId: node.parentId && idMap.has(node.parentId) ? idMap.get(node.parentId) : undefined,
      extent: node.parentId && idMap.has(node.parentId) ? ('parent' as const) : undefined,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      selected: true,
    }))
    const newEdges = clip.edges.map((e, i) => ({
      ...e,
      id: `e${Date.now().toString(36)}${i}`,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }))
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...newNodes])
    setEdges((es) => [...es, ...newEdges])
    setMenu(null)
    setDirty(true)
  }, [setNodes, setEdges, snapshot])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'c') {
        e.preventDefault()
        copySelection()
      } else if (mod && e.key === 'v') {
        e.preventDefault()
        pasteClipboard()
      } else if (mod && e.key === 'g') {
        e.preventDefault()
        groupSelection()
      } else if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((mod && e.key === 'y') || (mod && e.key === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copySelection, pasteClipboard, groupSelection, undo, redo])

  const duplicateNode = (nodeId: string) => {
    const src = nodes.find((n) => n.id === nodeId)
    if (!src) return
    snapshot()
    const n = addAt.current++
    setNodes((ns) => [
      ...ns.map((node) => ({ ...node, selected: false })),
      {
        ...src,
        id: `n${Date.now().toString(36)}${n}`,
        parentId: undefined,
        extent: undefined,
        position: { x: src.position.x + 32, y: src.position.y + 32 },
        data: { specType: src.data.specType, config: { ...src.data.config } },
        selected: true,
      },
    ])
    setMenu(null)
    setDirty(true)
  }

  const removeEdge = (edgeId: string) => {
    snapshot()
    setEdges((es) => es.filter((e) => e.id !== edgeId))
    setMenu(null)
    setDirty(true)
  }

  const openMenu = (
    event: MouseEvent | React.MouseEvent,
    kind: MenuState['kind'],
    targetId?: string,
  ) => {
    event.preventDefault()
    setPaletteOpen(false)
    setMenu({ kind, x: event.clientX, y: event.clientY, targetId })
  }

  // Plain config keys set `config[key]` directly. Keys of the form
  // `params.<nodeId>.<configKey>` (used for flow.subflow exposed-param
  // overrides) instead merge into a nested `config.params` object, keyed by
  // `<nodeId>.<configKey>` — matching what the flow.subflow executor reads.
  const setConfigValue = (key: string, value: unknown) => {
    if (!selected) return
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== selected.id) return n
        if (key.startsWith('params.')) {
          const nestedKey = key.slice('params.'.length)
          const params = { ...(n.data.config.params as Record<string, unknown> | undefined), [nestedKey]: value }
          return { ...n, data: { ...n.data, config: { ...n.data.config, params } } }
        }
        return { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } }
      }),
    )
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await saveFlow(id, { name, graph: fromRF(nodes, edges), component })
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Persists immediately, independent of unsaved graph edits — flipping
  // automation off must not require (or wait for) a graph save.
  const toggleEnabled = async () => {
    const next = !enabled
    setEnabled(next)
    try {
      await saveFlow(id, { enabled: next })
    } catch (e) {
      setEnabled(!next)
      setError(e instanceof Error ? e.message : 'Failed to update automation')
    }
  }

  const run = async (dryRun: boolean, trigger?: RunTrigger, fromNodeId?: string) => {
    if (!dryRun && !window.confirm('Really run this flow live? It will write to the portal database.')) {
      return
    }
    setRunningKind(dryRun ? 'dry' : 'real')
    setError('')
    // Firing a single trigger runs the whole graph server-side, but only its
    // branch actually did anything — paint results only on nodes reachable from
    // the fired trigger. A whole-flow run (no fromNodeId) paints everything.
    const active = fromNodeId ? reachableFrom(fromNodeId, edges) : null
    const paint = (nodeId: string) => active === null || active.has(nodeId)
    // Keep prior per-node reports so cascaded/partial runs leave a full trail.
    // Only clear running + edge pulses; the overall banner updates to this run.
    setReport(null)
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: { ...n.data, running: false, flashUntil: undefined },
      })),
    )
    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        animated: false,
        data: { ...e.data, pulse: undefined, pulseAt: undefined },
      })),
    )
    try {
      if (dirty) await saveFlow(id, { name, graph: fromRF(nodes, edges), component })
      setDirty(false)
      const report = await runFlowStream(
        id,
        dryRun,
        (ev) => {
          if (ev.type === 'start') {
            const idOnCanvas = canvasNodeId(ev.id)
            if (!paint(idOnCanvas)) return
            setNodes((ns) =>
              ns.map((n) =>
                n.id === idOnCanvas ? { ...n, data: { ...n.data, running: true } } : n,
              ),
            )
            flashNode(idOnCanvas)
          } else if (ev.type === 'node') {
            const idOnCanvas = canvasNodeId(ev.id)
            if (!paint(idOnCanvas)) return
            const nested = ev.id.includes('/')
            const skipped = ev.report.status === 'skipped'
            setNodes((ns) =>
              ns.map((n) => {
                if (n.id !== idOnCanvas) return n
                // Nested subflow steps keep the composite spinning until the
                // outer node itself reports.
                if (nested) return { ...n, data: { ...n.data, running: true } }
                return {
                  ...n,
                  data: { ...n.data, report: ev.report, running: false },
                }
              }),
            )
            // Inactive switch arms are reported as skipped — don't flash them.
            if (!skipped) flashNode(idOnCanvas)
            if (!skipped && !nested && ev.report.counts) {
              const nowMs = Date.now()
              setEdges((eds) =>
                eds.map((e) => {
                  if (e.source !== idOnCanvas) return e
                  const count = ev.report.counts[e.sourceHandle ?? '']
                  if (count == null) return e
                  return {
                    ...e,
                    animated: count > 0,
                    data: { ...e.data, pulse: count, pulseAt: nowMs },
                  }
                }),
              )
            }
          }
        },
        trigger,
      )
      setReport(report)
      if (report.error) setError(report.error)
      // Reconcile against the final report (covers validation errors that emit
      // no per-node events, and any node that never streamed) — merge into the
      // existing trail instead of wiping nodes outside this paint scope.
      setNodes((ns) =>
        ns.map((n) => {
          const streamed = paint(n.id) ? report.nodes[n.id] : undefined
          return {
            ...n,
            data: {
              ...n.data,
              report: streamed ?? n.data.report,
              running: false,
            },
          }
        }),
      )
      // Hold edge pulses briefly after the run so the path remains readable.
      setTimeout(() => {
        setEdges((eds) =>
          eds.map((e) => ({
            ...e,
            animated: false,
            data: { ...e.data, pulse: undefined, pulseAt: undefined },
          })),
        )
      }, 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, running: false } })))
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          animated: false,
          data: { ...e.data, pulse: undefined, pulseAt: undefined },
        })),
      )
    } finally {
      setRunningKind(null)
    }
  }

  // Keep the latest run + live flag reachable from the memoised per-node ▶
  // handlers (which are built before `run` is defined in render order).
  runRef.current = run
  liveRef.current = live

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading flow…</div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 md:px-4">
        <Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2" asChild>
          <Link to="/manage/flows">
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Flows</span>
          </Link>
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            markDirty()
          }}
          className="h-8 w-40 border-transparent bg-transparent font-medium focus-visible:border-input sm:w-56"
          aria-label="Flow name"
        />
        {report ? (
          <span
            className={`hidden text-xs sm:inline ${report.ok ? 'text-muted-foreground' : 'text-destructive'}`}
          >
            {report.dryRun ? 'dry run' : 'run'} · {(report.durationMs / 1000).toFixed(1)}s ·{' '}
            {report.ok ? 'ok' : 'failed'}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setComponentPanelOpen((v) => !v)}
          >
            <Box className="size-4" />
            <span className="hidden sm:inline">Component</span>
            {component?.published ? (
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
            ) : null}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => undo()}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => redo()}
          >
            <Redo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Notes"
            onClick={() => addEditorNode('editor.sticky')}
          >
            <StickyNote className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Arrow"
            onClick={() => addEditorNode('editor.arrow')}
          >
            <ArrowRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Reroute (or double-click a wire)"
            onClick={() => addReroute()}
          >
            <Waypoints className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 px-2"
            title="Group"
            disabled={selectedCount < 2}
            onClick={() => groupSelection()}
          >
            <Layers className="size-4" />
          </Button>
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setPaletteOpen((v) => !v)}
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">Add node</span>
            </Button>
            {paletteOpen ? (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-20 cursor-default"
                  aria-label="Close node palette"
                  onClick={() => setPaletteOpen(false)}
                />
                <div className="fixed inset-x-3 top-28 z-30 overflow-hidden rounded-md border border-border bg-popover shadow-md sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-72">
                  <NodePicker specs={specs} components={components} onSelect={addNode} />
                </div>
              </>
            ) : null}
          </div>
          {/* Automation on/off — whether schedules + event triggers fire this
              flow. Independent of Dry/Live, which only shapes manual runs here. */}
          <button
            type="button"
            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              enabled
                ? 'border-input text-emerald-400 hover:bg-muted/60'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
            }`}
            title={
              enabled
                ? 'Automation on: schedules and event triggers fire this flow. Click to turn off.'
                : 'Automation off: schedules skip this flow and event triggers ignore it. Manual runs still work. Click to turn on.'
            }
            onClick={() => void toggleEnabled()}
          >
            <span className="hidden sm:inline">Auto </span>
            {enabled ? 'on' : 'off'}
          </button>
          {/* Dry vs Live applies to every run — the per-trigger ▶ buttons and the
              whole-flow Run below. */}
          <div
            className="flex overflow-hidden rounded-md border border-input text-xs"
            title="Dry run leaves sinks untouched; Live writes for real"
          >
            <button
              type="button"
              className={`px-2 py-1 ${!live ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
              onClick={() => setLive(false)}
            >
              Dry
            </button>
            <button
              type="button"
              className={`px-2 py-1 ${live ? 'bg-amber-500/20 font-medium text-amber-500' : 'text-muted-foreground'}`}
              onClick={() => setLive(true)}
            >
              Live
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={runningKind !== null}
            title="Run the whole flow (every trigger). Use a trigger node’s ▶ to fire just that entry point."
            onClick={() => void run(!live)}
          >
            {runningKind !== null ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            <span className="hidden sm:inline">Run</span>
          </Button>
          <Button size="sm" className="gap-1" disabled={saving || !dirty} onClick={() => void save()}>
            <Save className="size-4" />
            <span className="hidden sm:inline">{dirty ? 'Save' : 'Saved'}</span>
          </Button>
        </div>
      </header>

      {componentPanelOpen ? (
        <div className="space-y-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={component?.published ?? false}
                onChange={(e) => togglePublish(e.target.checked)}
              />
              Publish as component
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              aria-label="Close component panel"
              onClick={() => setComponentPanelOpen(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          {component?.published ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="component-label">
                  Label
                </label>
                <Input
                  id="component-label"
                  className="h-8"
                  value={component.label}
                  placeholder={name}
                  onChange={(e) => setComponentField('label', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="component-category">
                  Category
                </label>
                <select
                  id="component-category"
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  value={component.category}
                  onChange={(e) =>
                    setComponentField('category', e.target.value as FlowComponentMeta['category'])
                  }
                >
                  {COMPONENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium" htmlFor="component-description">
                  Description
                </label>
                <textarea
                  id="component-description"
                  className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={component.description}
                  onChange={(e) => setComponentField('description', e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <p className="text-xs font-medium">Expose parameters</p>
                {exposableFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No configurable nodes on the canvas.</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2">
                    {exposableFields.map(({ node, spec, field }) => {
                      const checked = component.exposedParams.some(
                        (p) => p.nodeId === node.id && p.configKey === field.key,
                      )
                      return (
                        <label
                          key={`${node.id}.${field.key}`}
                          className="flex items-center gap-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 rounded border-input"
                            checked={checked}
                            onChange={(e) => toggleExposedParam(node.id, field.key, e.target.checked)}
                          />
                          <span className={`size-1.5 shrink-0 rounded-full ${CATEGORY_DOT[spec.category]}`} />
                          <span className="truncate">
                            {spec.label} · {field.label}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flow-editor-canvas relative min-h-0 flex-1">
        <PropagatedTypesContext.Provider value={propagatedTypes}>
        <ReactFlow<RFNode, RFEdge>
          nodes={displayNodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          isValidConnection={isValidConnection}
          deleteKeyCode={['Backspace', 'Delete']}
          onNodeDragStart={() => snapshot()}
          onSelectionDragStart={() => snapshot()}
          onNodesChange={(changes) => {
            if (changes.some((c) => c.type === 'remove')) snapshotOnce()
            onNodesChange(changes)
            if (
              changes.some(
                (c) =>
                  c.type === 'position' ||
                  c.type === 'remove' ||
                  c.type === 'dimensions' ||
                  c.type === 'replace',
              )
            ) {
              markDirty()
            }
          }}
          onEdgesChange={(changes) => {
            if (changes.some((c) => c.type === 'remove')) snapshotOnce()
            onEdgesChange(changes)
            if (changes.some((c) => c.type === 'remove')) markDirty()
          }}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgeDoubleClick={(ev, edge) =>
            insertReroute(edge, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }))
          }
          reconnectRadius={16}
          selectionOnDrag
          onPaneContextMenu={(e) => openMenu(e, 'pane')}
          onNodeContextMenu={(e, node) => openMenu(e, 'node', node.id)}
          onEdgeContextMenu={(e, edge) => openMenu(e, 'edge', edge.id)}
          onSelectionContextMenu={(e) => openMenu(e, 'selection')}
          onPaneClick={() => setMenu(null)}
          onMoveStart={() => setMenu(null)}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls className="!bottom-4 !left-4" showInteractive={false} />
        </ReactFlow>
        </PropagatedTypesContext.Provider>

        {menu ? (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 cursor-default"
              aria-label="Close context menu"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu(null)
              }}
            />
            <div
              className={`fixed z-40 overflow-hidden rounded-md border border-border bg-popover shadow-md ${
                menu.kind === 'pane' ? 'w-72' : 'w-56 p-1'
              }`}
              style={{
                left: Math.min(menu.x, window.innerWidth - (menu.kind === 'pane' ? 296 : 232)),
                top: Math.min(menu.y, window.innerHeight - (menu.kind === 'pane' ? 380 : 120)),
              }}
              role="menu"
            >
              {menu.kind === 'pane' ? (
                <>
                  <div className="space-y-0.5 border-b border-border p-1">
                    <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Annotations
                    </p>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() =>
                        addEditorNode(
                          'editor.sticky',
                          screenToFlowPosition({ x: menu.x, y: menu.y }),
                        )
                      }
                    >
                      <StickyNote className="size-3.5 text-muted-foreground" />
                      Notes
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() =>
                        addEditorNode(
                          'editor.arrow',
                          screenToFlowPosition({ x: menu.x, y: menu.y }),
                        )
                      }
                    >
                      <ArrowRight className="size-3.5 text-muted-foreground" />
                      Arrow
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() =>
                        addEditorNode(
                          'editor.group',
                          screenToFlowPosition({ x: menu.x, y: menu.y }),
                        )
                      }
                    >
                      <Layers className="size-3.5 text-muted-foreground" />
                      Empty group
                    </button>
                  </div>
                  <p className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Add node here
                  </p>
                  <NodePicker
                    specs={specs}
                    components={components}
                    compact
                    onSelect={(s) => addNode(s, screenToFlowPosition({ x: menu.x, y: menu.y }))}
                  />
                </>
              ) : menu.kind === 'node' ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      copyNodes([menu.targetId!])
                      setMenu(null)
                    }}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Copy
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => duplicateNode(menu.targetId!)}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Duplicate
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-muted"
                    onClick={() => removeNode(menu.targetId!)}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </button>
                </>
              ) : menu.kind === 'selection' ? (
                <>
                  {selectedCount >= 2 ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => groupSelection()}
                    >
                      <Layers className="size-3.5 text-muted-foreground" />
                      Group selection
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      copySelection()
                      setMenu(null)
                    }}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Copy
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    disabled={!clipboardRef.current}
                    onClick={() => pasteClipboard()}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Paste
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-muted"
                    onClick={() => removeSelected()}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-muted"
                  onClick={() => removeEdge(menu.targetId!)}
                >
                  <Unlink className="size-3.5" />
                  Delete connection
                </button>
              )}
            </div>
          </>
        ) : null}

        {selected && (selectedSpec || isEditorNode(selected.data.specType)) ? (
          <aside className="absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-auto border-t border-border bg-card/95 backdrop-blur md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-80 md:border-l md:border-t-0">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              {selectedSpec ? (
                <span
                  className={`size-2 rounded-full ${CATEGORY_DOT[selectedComponentInfo?.component?.category ?? selectedSpec.category]}`}
                />
              ) : (
                <StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {selectedSpec
                  ? (componentLabel(selectedComponentInfo) ?? selectedSpec.label)
                  : selected.data.specType === 'editor.sticky'
                    ? 'Notes'
                    : selected.data.specType === 'editor.arrow'
                      ? 'Arrow'
                      : 'Group'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                aria-label="Delete node"
                onClick={() => removeNode(selected.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                aria-label="Close panel"
                onClick={() =>
                  setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-4 p-4">
              {selectedSpec ? (
                <p className="text-xs text-muted-foreground">{selectedSpec.description}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Canvas annotation — not executed when the flow runs.
                </p>
              )}

              {isEditorNode(selected.data.specType) ? (
                <div className="space-y-3">
                  {selected.data.specType === 'editor.sticky' ? (
                    <>
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-sticky-text">
                          Text
                        </label>
                        <textarea
                          id="ed-sticky-text"
                          rows={4}
                          className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
                          value={String(selected.data.config.text ?? '')}
                          onChange={(e) => setConfigValue('text', e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-sticky-font">
                          Font size
                        </label>
                        <Input
                          id="ed-sticky-font"
                          className="h-8"
                          type="number"
                          min={8}
                          max={32}
                          value={Number(selected.data.config.fontSize ?? 12)}
                          onChange={(e) =>
                            setConfigValue('fontSize', Math.min(32, Math.max(8, Number(e.target.value) || 12)))
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs font-medium">Horizontal align</span>
                        <div className="flex gap-1">
                          {(['left', 'center', 'right'] as const).map((align) => (
                            <Button
                              key={align}
                              type="button"
                              variant={(selected.data.config.textAlign ?? 'left') === align ? 'secondary' : 'outline'}
                              size="sm"
                              className="h-8 flex-1 px-2 text-xs capitalize"
                              onClick={() => setConfigValue('textAlign', align)}
                            >
                              {align}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs font-medium">Vertical align</span>
                        <div className="flex gap-1">
                          {(['top', 'center', 'bottom'] as const).map((align) => (
                            <Button
                              key={align}
                              type="button"
                              variant={(selected.data.config.verticalAlign ?? 'top') === align ? 'secondary' : 'outline'}
                              size="sm"
                              className="h-8 flex-1 px-2 text-xs capitalize"
                              onClick={() => setConfigValue('verticalAlign', align)}
                            >
                              {align}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <EditorRotationField
                        value={editorRotationFromConfig('editor.sticky', selected.data.config)}
                        onChange={(rotation) => setConfigValue('rotation', rotation)}
                      />
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-sticky-color">
                          Color
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="ed-sticky-color"
                            type="color"
                            className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                            value={
                              /^#[0-9a-f]{6}$/i.test(String(selected.data.config.color ?? ''))
                                ? String(selected.data.config.color)
                                : '#fef08a'
                            }
                            onChange={(e) => setConfigValue('color', e.target.value)}
                          />
                          <Input
                            className="h-8 font-mono"
                            value={String(selected.data.config.color ?? '#fef08a')}
                            onChange={(e) => setConfigValue('color', e.target.value)}
                          />
                        </div>
                      </div>
                    </>
                  ) : selected.data.specType === 'editor.arrow' ? (
                    (() => {
                      const arrow = normalizeArrowConfig(selected.data.config)
                      const points = arrow.points ?? DEFAULT_ARROW_POINTS
                      const patchArrow = (patch: Record<string, unknown>) => {
                        const next = normalizeArrowConfig({ ...selected.data.config, ...patch })
                        patchEditorConfig(selected.id, {
                          ...next,
                          rotation: undefined,
                          direction: undefined,
                        })
                      }
                      return (
                        <>
                          <div className="space-y-1">
                            <label className="text-xs font-medium" htmlFor="ed-arrow-color">
                              Color
                            </label>
                            <div className="flex items-center gap-2">
                              <input
                                id="ed-arrow-color"
                                type="color"
                                className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                                value={
                                  /^#[0-9a-f]{6}$/i.test(String(arrow.color ?? ''))
                                    ? String(arrow.color)
                                    : '#a1a1aa'
                                }
                                onChange={(e) => patchArrow({ color: e.target.value })}
                              />
                              <Input
                                className="h-8 font-mono"
                                value={String(arrow.color ?? '#a1a1aa')}
                                onChange={(e) => patchArrow({ color: e.target.value })}
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-xs font-medium" htmlFor="ed-arrow-stroke">
                                Thickness
                              </label>
                              <Input
                                id="ed-arrow-stroke"
                                className="h-8"
                                type="number"
                                min={1}
                                max={16}
                                value={arrow.strokeWidth ?? 2}
                                onChange={(e) =>
                                  patchArrow({
                                    strokeWidth: Math.min(16, Math.max(1, Number(e.target.value) || 2)),
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium" htmlFor="ed-arrow-head-size">
                                Head size
                              </label>
                              <Input
                                id="ed-arrow-head-size"
                                className="h-8"
                                type="number"
                                min={4}
                                max={48}
                                value={arrow.headSize ?? 10}
                                onChange={(e) =>
                                  patchArrow({
                                    headSize: Math.min(48, Math.max(4, Number(e.target.value) || 10)),
                                  })
                                }
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <span className="text-xs font-medium">Line style</span>
                            <div className="flex gap-1">
                              {ARROW_DASH_OPTIONS.map((opt) => (
                                <Button
                                  key={opt.value}
                                  type="button"
                                  variant={(arrow.dash ?? 'solid') === opt.value ? 'secondary' : 'outline'}
                                  size="sm"
                                  className="h-8 flex-1 px-2 text-xs"
                                  onClick={() => patchArrow({ dash: opt.value })}
                                >
                                  {opt.label}
                                </Button>
                              ))}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-xs font-medium" htmlFor="ed-arrow-start-head">
                                Start head
                              </label>
                              <select
                                id="ed-arrow-start-head"
                                className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                                value={arrow.startHead ?? 'none'}
                                onChange={(e) => patchArrow({ startHead: e.target.value as ArrowHead })}
                              >
                                {ARROW_HEAD_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium" htmlFor="ed-arrow-end-head">
                                End head
                              </label>
                              <select
                                id="ed-arrow-end-head"
                                className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                                value={arrow.endHead ?? 'arrow'}
                                onChange={(e) => patchArrow({ endHead: e.target.value as ArrowHead })}
                              >
                                {ARROW_HEAD_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1">
                            <span className="text-xs font-medium">Curve points</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">{points.length} points</span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                disabled={points.length >= 8}
                                onClick={() => {
                                  const mid = Math.floor(points.length / 2)
                                  const a = points[mid - 1] ?? points[0]
                                  const b = points[mid] ?? points[points.length - 1]
                                  const inserted = {
                                    x: (a.x + b.x) / 2,
                                    y: Math.min(1, Math.max(0, (a.y + b.y) / 2 - 0.12)),
                                  }
                                  const next = [...points.slice(0, mid), inserted, ...points.slice(mid)]
                                  patchArrow({ points: next })
                                }}
                              >
                                Add bend
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                disabled={points.length <= 2}
                                onClick={() => {
                                  if (points.length <= 2) return
                                  const mid = Math.floor(points.length / 2)
                                  const next = points.filter((_, i) => i !== mid)
                                  patchArrow({ points: next.length >= 2 ? next : points })
                                }}
                              >
                                Remove bend
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              Select the arrow and drag the handles to reshape the curve.
                            </p>
                          </div>
                        </>
                      )
                    })()
                  ) : (
                    <>
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-group-title">
                          Title
                        </label>
                        <Input
                          id="ed-group-title"
                          className="h-8"
                          value={String(selected.data.config.title ?? 'Group')}
                          onChange={(e) => setConfigValue('title', e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-group-color">
                          Background
                        </label>
                        <Input
                          id="ed-group-color"
                          className="h-8 font-mono"
                          value={String(selected.data.config.color ?? '')}
                          placeholder="CSS color"
                          onChange={(e) => setConfigValue('color', e.target.value)}
                        />
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="size-3.5 rounded border-input"
                          checked={Boolean(selected.data.config.locked)}
                          onChange={(e) => patchEditorConfig(selected.id, { locked: e.target.checked })}
                        />
                        Lock contents (prevent moving nodes inside)
                      </label>
                    </>
                  )}
                </div>
              ) : selected.data.specType === 'flow.subflow' ? (
                <div className="space-y-4">
                  <Link
                    to={`/manage/flows/${selected.data.config.flowId}`}
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" />
                    Open component flow
                  </Link>

                  {selectedComponentIface && selectedComponentIface.exposedParams.length > 0 ? (
                    <div className="space-y-3 border-t border-border pt-3">
                      <p className="text-xs font-medium">Parameters</p>
                      {selectedComponentIface.exposedParams.map((p) => {
                        const nestedKey = `${p.nodeId}.${p.configKey}`
                        const params = (selected.data.config.params ?? {}) as Record<string, unknown>
                        const value = params[nestedKey] ?? p.default ?? ''
                        const configKey = `params.${nestedKey}`
                        return (
                          <div key={nestedKey} className="space-y-1">
                            <label className="text-xs font-medium" htmlFor={`param-${nestedKey}`}>
                              {p.label ?? p.configKey}
                            </label>
                            {p.kind === 'select' ? (
                              <select
                                id={`param-${nestedKey}`}
                                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                                value={String(value)}
                                onChange={(e) => setConfigValue(configKey, e.target.value)}
                              >
                                {(p.options ?? []).map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : p.kind === 'json' ? (
                              <textarea
                                id={`param-${nestedKey}`}
                                rows={4}
                                spellCheck={false}
                                className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs"
                                value={String(value)}
                                onChange={(e) => setConfigValue(configKey, e.target.value)}
                              />
                            ) : p.kind === 'color' ? (
                              <div className="flex items-center gap-2">
                                <input
                                  id={`param-${nestedKey}`}
                                  type="color"
                                  className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                                  value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#7c5cff'}
                                  onChange={(e) => setConfigValue(configKey, e.target.value)}
                                />
                                <Input
                                  className="h-8 font-mono"
                                  value={String(value)}
                                  onChange={(e) => setConfigValue(configKey, e.target.value)}
                                />
                              </div>
                            ) : p.kind === 'boolean' ? (
                              <select
                                id={`param-${nestedKey}`}
                                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                                value={String(Boolean(value))}
                                onChange={(e) => setConfigValue(configKey, e.target.value === 'true')}
                              >
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            ) : (
                              <Input
                                id={`param-${nestedKey}`}
                                className="h-8"
                                type={
                                  p.kind === 'number'
                                    ? 'number'
                                    : p.kind === 'password'
                                      ? 'password'
                                      : 'text'
                                }
                                autoComplete={p.kind === 'password' ? 'new-password' : undefined}
                                value={String(value)}
                                onChange={(e) =>
                                  setConfigValue(
                                    configKey,
                                    p.kind === 'number' ? Number(e.target.value) : e.target.value,
                                  )
                                }
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              ) : selectedSpec && selectedSpec.config.length > 0 ? (
                <div className="space-y-3">
                  {selectedSpec.config.map((f) => {
                    const value = selected.data.config[f.key] ?? f.default ?? ''
                    return (
                      <div key={f.key} className="space-y-1">
                        <label className="text-xs font-medium" htmlFor={`cfg-${f.key}`}>
                          {f.label}
                        </label>
                        {f.kind === 'select' ? (
                          <select
                            id={`cfg-${f.key}`}
                            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                            value={String(value)}
                            onChange={(e) => setConfigValue(f.key, e.target.value)}
                          >
                            {(f.options ?? []).map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : f.kind === 'json' ? (
                          <textarea
                            id={`cfg-${f.key}`}
                            rows={4}
                            spellCheck={false}
                            className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs"
                            value={String(value)}
                            onChange={(e) => setConfigValue(f.key, e.target.value)}
                          />
                        ) : f.kind === 'color' ? (
                          <div className="flex items-center gap-2">
                            <input
                              id={`cfg-${f.key}`}
                              type="color"
                              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                              value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#7c5cff'}
                              onChange={(e) => setConfigValue(f.key, e.target.value)}
                            />
                            <Input
                              className="h-8 font-mono"
                              value={String(value)}
                              onChange={(e) => setConfigValue(f.key, e.target.value)}
                            />
                          </div>
                        ) : f.kind === 'boolean' ? (
                          <select
                            id={`cfg-${f.key}`}
                            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                            value={String(Boolean(value))}
                            onChange={(e) => setConfigValue(f.key, e.target.value === 'true')}
                          >
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                          </select>
                        ) : (
                          <Input
                            id={`cfg-${f.key}`}
                            className="h-8"
                            type={
                              f.kind === 'number'
                                ? 'number'
                                : f.kind === 'password'
                                  ? 'password'
                                  : 'text'
                            }
                            autoComplete={f.kind === 'password' ? 'new-password' : undefined}
                            value={String(value)}
                            onChange={(e) =>
                              setConfigValue(
                                f.key,
                                f.kind === 'number' ? Number(e.target.value) : e.target.value,
                              )
                            }
                          />
                        )}
                        {f.help ? (
                          <p className="text-[11px] text-muted-foreground">{f.help}</p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No configuration.</p>
              )}

              {selected.data.report ? (
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs font-medium">
                    Last run:{' '}
                    <span
                      className={
                        selected.data.report.status === 'ok'
                          ? 'text-emerald-400'
                          : selected.data.report.status === 'error'
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                      }
                    >
                      {selected.data.report.status}
                    </span>{' '}
                    · {selected.data.report.durationMs}ms
                  </p>
                  {selected.data.report.error ? (
                    <p className="text-xs text-destructive">{selected.data.report.error}</p>
                  ) : null}
                  {selected.data.report.notes.map((note) => (
                    <p key={note} className="text-[11px] text-muted-foreground">
                      {note}
                    </p>
                  ))}
                  {innerReports.length > 0 ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        Inner steps ({innerReports.length})
                      </summary>
                      {innerReports.map(([k, r]) => (
                        <div key={k} className="mt-2 border-t border-border pt-2">
                          <p>
                            {k.split('/').pop()} —{' '}
                            <span
                              className={
                                r.status === 'ok'
                                  ? 'text-emerald-400'
                                  : r.status === 'error'
                                    ? 'text-destructive'
                                    : 'text-muted-foreground'
                              }
                            >
                              {r.status}
                            </span>{' '}
                            · {r.durationMs}ms
                          </p>
                          {r.error ? <p className="text-destructive">{r.error}</p> : null}
                          {r.notes.map((note) => (
                            <p key={note} className="text-[11px] text-muted-foreground">
                              {note}
                            </p>
                          ))}
                        </div>
                      ))}
                    </details>
                  ) : null}
                  {Object.entries(selected.data.report.samples).map(([port, items]) =>
                    items.length > 0 ? (
                      <details key={port} className="text-[11px]">
                        <summary className="cursor-pointer text-muted-foreground">
                          {port}: sample of {selected.data.report?.counts[port] ?? 0}
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[10px]">
                          {JSON.stringify(items, null, 2)}
                        </pre>
                      </details>
                    ) : null,
                  )}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

// useReactFlow (screenToFlowPosition for the context menu) needs a provider
// above the component that calls it.
export default function FlowEditor() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  )
}
