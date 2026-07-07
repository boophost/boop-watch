import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  reconnectEdge,
  getNodesBounds,
  type Node,
  type Edge,
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
  Trash2,
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
import { isEditorNode, editorRotationFromConfig, normalizeRotation } from '@/lib/flowEditorMeta'
import {
  editorNodeTypes,
  editorRfType,
} from './flowEditorAnnotations'

// ---- graph <-> React Flow conversion ---------------------------------------

interface FlowNodeData extends Record<string, unknown> {
  specType: string
  config: Record<string, unknown>
  report?: NodeReport
  running?: boolean
  onEditorChange?: (patch: Record<string, unknown>) => void
}

type RFNode = Node<FlowNodeData, 'flow' | 'sticky' | 'arrow' | 'group'>
type RFEdge = Edge

const CATEGORY_DOT: Record<NodeCategory, string> = {
  source: 'bg-violet-400',
  filter: 'bg-sky-400',
  enrich: 'bg-amber-400',
  combine: 'bg-emerald-400',
  sink: 'bg-rose-400',
  value: 'bg-pink-400',
  boundary: 'bg-slate-400',
}

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  source: 'Source',
  filter: 'Filter',
  enrich: 'Enrich',
  combine: 'Combine',
  sink: 'Sink',
  value: 'Value',
  boundary: 'Boundary',
}

const NODE_CATEGORIES: NodeCategory[] = ['source', 'filter', 'enrich', 'combine', 'sink', 'value', 'boundary']

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

/** Effective (propagated) port types keyed `${nodeId}:in|out:${portId}`, so a
 * generic node's sockets/wires show the record subtype flowing through it. */
const PropagatedTypesContext = createContext<Map<string, PortDataType>>(new Map())

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
  const inputs = componentIface?.inputs ?? resolvedPorts.inputs
  const outputs = componentIface?.outputs ?? resolvedPorts.outputs
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
  return (
    <div
      className={`min-w-44 max-w-56 rounded-md border bg-card text-card-foreground shadow-sm ${
        selected
          ? 'border-ring ring-2 ring-ring/40'
          : running
            ? 'border-ring ring-2 ring-ring/30'
            : report?.status === 'error'
              ? 'border-destructive'
              : 'border-border'
      }`}
    >
      <div
        className="relative flex items-center gap-2 border-b border-border px-3 py-2"
        title={spec.description || undefined}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[componentInfo?.component?.category ?? spec.category]}`}
        />
        <span className="truncate text-xs font-medium">
          {componentLabel(componentInfo) ?? spec.label}
        </span>
        {running ? (
          <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-ring" />
        ) : report?.status === 'ok' ? (
          <Check className="ml-auto size-3.5 shrink-0 text-emerald-400" />
        ) : report?.status === 'error' ? (
          <AlertTriangle className="ml-auto size-3.5 shrink-0 text-destructive" />
        ) : null}
      </div>
      {inputs.length > 0 ? (
        <div className="border-b border-border py-1">
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
        <div className="space-y-0.5 border-b border-border px-3 py-1.5">
          {configLines.map((line) => (
            <p key={line} className="truncate text-[10px] text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div className="py-1">
        {outputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-end gap-2 px-3 py-0.5">
            {report ? (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                {report.counts[port.id] ?? 0}
              </span>
            ) : null}
            <span className="text-[10px] text-muted-foreground" style={typedStyle(effOut(port))}>
              {port.label}
            </span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              className="!size-2.5 !border-border"
              style={{ top: '50%', background: portColor(effOut(port)) }}
              title={portTitle(port, effOut(port))}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

const nodeTypes = { flow: FlowNodeView, ...editorNodeTypes }

function toRF(graph: FlowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  const lockedGroups = new Map(
    graph.nodes
      .filter((n) => n.type === 'editor.group')
      .map((n) => [n.id, Boolean(n.config.locked)]),
  )
  return {
    nodes: graph.nodes.map((n) => {
      const rfType = editorRfType(n.type)
      const groupId = typeof n.config.groupId === 'string' ? n.config.groupId : undefined
      const parentLocked = groupId ? lockedGroups.get(groupId) : false
      const width = typeof n.config.width === 'number' ? n.config.width : undefined
      const height = typeof n.config.height === 'number' ? n.config.height : undefined
      const config = { ...n.config }
      delete config.groupId
      const style =
        width && height
          ? { width, height }
          : rfType === 'group'
            ? { width: width ?? 280, height: height ?? 180 }
            : undefined
      return {
        id: n.id,
        type: rfType,
        position: n.position,
        parentId: groupId,
        extent: groupId ? ('parent' as const) : undefined,
        style,
        zIndex: rfType === 'group' ? -1 : undefined,
        connectable: rfType === 'flow',
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
  'editor.arrow': { width: 160, height: 48, rotation: 0 },
  'editor.group': { title: 'Group', color: 'rgba(124, 92, 255, 0.12)', width: 280, height: 180, locked: false },
}

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
  const [componentPanelOpen, setComponentPanelOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runningKind, setRunningKind] = useState<'dry' | 'real' | null>(null)
  const [report, setReport] = useState<RunReport | null>(null)
  const [error, setError] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([])
  const addAt = useRef(0)
  const clipboardRef = useRef<{ nodes: RFNode[]; edges: RFEdge[] } | null>(null)
  const { screenToFlowPosition } = useReactFlow()

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
        setSpecs(types.nodeTypes)
        setComponents(comps)
        setName(flow.flow.name)
        setComponent(flow.flow.component)
        const rf = toRF(flow.flow.graph)
        setNodes(rf.nodes)
        setEdges(rf.edges)
      } catch {
        if (!cancelled) navigate('/manage/flows', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, navigate, setNodes, setEdges])

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
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onEditorChange: isEditorNode(n.data.specType)
            ? (patch: Record<string, unknown>) => patchEditorConfig(n.id, patch)
            : undefined,
        },
      })),
    [nodes, patchEditorConfig],
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
      setEdges((eds) => addEdge(conn, eds))
      setDirty(true)
    },
    [setEdges],
  )

  const onReconnect = useCallback(
    (oldEdge: RFEdge, newConnection: Connection) => {
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds))
      setDirty(true)
    },
    [setEdges],
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

  // Wires take the color of the (propagated) type they carry; base items edges
  // keep the default stroke.
  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const dataType =
          propagatedTypes.get(`${e.source}:out:${e.sourceHandle}`) ??
          findPort(e.source, e.sourceHandle, 'out')?.dataType
        if (!dataType || dataType === 'items') return e
        return { ...e, style: { ...e.style, stroke: portColor(dataType), strokeWidth: 1.5 } }
      }),
    [edges, findPort, propagatedTypes],
  )

  const addEditorNode = (
    specType: 'editor.sticky' | 'editor.arrow' | 'editor.group',
    position?: { x: number; y: number },
  ) => {
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

  const removeNode = (nodeId: string) => {
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
  }, [nodes, setNodes, setEdges])

  const groupSelection = useCallback(() => {
    const picked = nodes.filter((n) => n.selected && n.data.specType !== 'editor.group')
    if (picked.length < 2) return
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
  }, [nodes, setNodes])

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
  }, [setNodes, setEdges])

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copySelection, pasteClipboard, groupSelection])

  const duplicateNode = (nodeId: string) => {
    const src = nodes.find((n) => n.id === nodeId)
    if (!src) return
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

  const run = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('Really run this flow? It will write to the portal database.')) {
      return
    }
    setRunningKind(dryRun ? 'dry' : 'real')
    setError('')
    // Clear last run's per-node results so live progress paints from scratch.
    setReport(null)
    setNodes((ns) =>
      ns.map((n) => ({ ...n, data: { ...n.data, report: undefined, running: false } })),
    )
    try {
      if (dirty) await saveFlow(id, { name, graph: fromRF(nodes, edges), component })
      setDirty(false)
      const report = await runFlowStream(id, dryRun, (ev) => {
        if (ev.type === 'start') {
          setNodes((ns) =>
            ns.map((n) => (n.id === ev.id ? { ...n, data: { ...n.data, running: true } } : n)),
          )
        } else if (ev.type === 'node') {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === ev.id ? { ...n, data: { ...n.data, report: ev.report, running: false } } : n,
            ),
          )
        }
      })
      setReport(report)
      if (report.error) setError(report.error)
      // Reconcile against the final report (covers validation errors that emit
      // no per-node events, and any node that never streamed).
      setNodes((ns) =>
        ns.map((n) => ({ ...n, data: { ...n.data, report: report.nodes[n.id], running: false } })),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, running: false } })))
    } finally {
      setRunningKind(null)
    }
  }

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
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={runningKind !== null}
            onClick={() => void run(true)}
          >
            {runningKind === 'dry' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            <span className="hidden sm:inline">Dry run</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={runningKind !== null}
            onClick={() => void run(false)}
          >
            {runningKind === 'real' ? <Loader2 className="size-4 animate-spin" /> : null}
            <span>Apply</span>
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
          isValidConnection={isValidConnection}
          onNodesChange={(changes) => {
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
            onEdgesChange(changes)
            if (changes.some((c) => c.type === 'remove')) markDirty()
          }}
          onConnect={onConnect}
          onReconnect={onReconnect}
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
                    <>
                      <EditorRotationField
                        value={editorRotationFromConfig('editor.arrow', selected.data.config)}
                        onChange={(rotation) => setConfigValue('rotation', rotation)}
                      />
                      <div className="space-y-1">
                        <label className="text-xs font-medium" htmlFor="ed-arrow-color">
                          Color
                        </label>
                        <Input
                          id="ed-arrow-color"
                          className="h-8 font-mono"
                          value={String(selected.data.config.color ?? '')}
                          placeholder="CSS color"
                          onChange={(e) => setConfigValue('color', e.target.value)}
                        />
                      </div>
                    </>
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
