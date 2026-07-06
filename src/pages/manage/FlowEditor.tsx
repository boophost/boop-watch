import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getFlow,
  getNodeTypes,
  saveFlow,
  runFlowStream,
  type NodeSpec,
  type NodeCategory,
  type FlowGraph,
  type RunReport,
  type NodeReport,
} from '@/lib/flows'

// ---- graph <-> React Flow conversion ---------------------------------------

interface FlowNodeData extends Record<string, unknown> {
  specType: string
  config: Record<string, unknown>
  report?: NodeReport
  running?: boolean
}

type RFNode = Node<FlowNodeData, 'flow'>
type RFEdge = Edge

const CATEGORY_DOT: Record<NodeCategory, string> = {
  source: 'bg-violet-400',
  filter: 'bg-sky-400',
  enrich: 'bg-amber-400',
  combine: 'bg-emerald-400',
  sink: 'bg-rose-400',
  boundary: 'bg-slate-400',
}

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  source: 'Source',
  filter: 'Filter',
  enrich: 'Enrich',
  combine: 'Combine',
  sink: 'Sink',
  boundary: 'Boundary',
}

const NODE_CATEGORIES: NodeCategory[] = ['source', 'filter', 'enrich', 'combine', 'sink', 'boundary']

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

/** Shared add-node palette: search + collapsible category folders. */
function NodePicker({
  specs,
  onSelect,
  compact = false,
}: {
  specs: NodeSpec[]
  onSelect: (spec: NodeSpec) => void
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<NodeCategory>>(() => new Set(DEFAULT_COLLAPSED))

  const grouped = useMemo(() => groupSpecs(specs, query), [specs, query])
  const searching = query.trim().length > 0

  const isCollapsed = (category: NodeCategory) => !searching && collapsed.has(category)

  const toggleCategory = (category: NodeCategory) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
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
        {grouped.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching nodes</p>
        ) : (
          grouped.map((g) => (
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
          ))
        )}
      </div>
    </div>
  )
}

let specLookup: Map<string, NodeSpec> = new Map()

function FlowNodeView({ data, selected }: NodeProps<RFNode>) {
  const spec = specLookup.get(data.specType)
  const report = data.report
  if (!spec) {
    return (
      <div className="rounded-md border border-destructive bg-card px-3 py-2 text-xs">
        Unknown node: {data.specType}
      </div>
    )
  }
  const configLines = spec.config
    .map((f) => {
      const v = data.config[f.key] ?? f.default
      if (v === undefined || v === '') return null
      // Secrets never render on the canvas.
      return `${f.label}: ${f.kind === 'password' ? '••••••' : String(v)}`
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
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
        {spec.inputs.length === 1 ? (
          <Handle
            id={spec.inputs[0].id}
            type="target"
            position={Position.Left}
            className="!size-2.5 !border-border !bg-muted-foreground"
          />
        ) : null}
        <span className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[spec.category]}`} />
        <span className="truncate text-xs font-medium">{spec.label}</span>
        {running ? (
          <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-ring" />
        ) : report?.status === 'ok' ? (
          <Check className="ml-auto size-3.5 shrink-0 text-emerald-400" />
        ) : report?.status === 'error' ? (
          <AlertTriangle className="ml-auto size-3.5 shrink-0 text-destructive" />
        ) : null}
      </div>
      {spec.inputs.length > 1 ? (
        <div className="border-b border-border py-1">
          {spec.inputs.map((port) => (
            <div key={port.id} className="relative flex items-center gap-2 px-3 py-0.5">
              <Handle
                id={port.id}
                type="target"
                position={Position.Left}
                className="!size-2.5 !border-border !bg-muted-foreground"
                style={{ top: '50%' }}
              />
              <span className="text-[10px] text-muted-foreground">{port.label}</span>
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
        {spec.outputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-end gap-2 px-3 py-0.5">
            {report ? (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                {report.counts[port.id] ?? 0}
              </span>
            ) : null}
            <span className="text-[10px] text-muted-foreground">{port.label}</span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              className="!size-2.5 !border-border !bg-muted-foreground"
              style={{ top: '50%' }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

const nodeTypes = { flow: FlowNodeView }

function toRF(graph: FlowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: 'flow' as const,
      position: n.position,
      data: { specType: n.type, config: n.config },
    })),
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
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.specType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data.config,
    })),
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
  kind: 'pane' | 'node' | 'edge'
  x: number
  y: number
  targetId?: string
}

function FlowEditorInner() {
  const { flowId } = useParams<{ flowId: string }>()
  const navigate = useNavigate()
  const id = Number(flowId)

  const [specs, setSpecs] = useState<NodeSpec[]>([])
  const [name, setName] = useState('')
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
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    if (!Number.isFinite(id)) {
      navigate('/manage/flows', { replace: true })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [types, flow] = await Promise.all([getNodeTypes(), getFlow(id)])
        if (cancelled) return
        specLookup = new Map(types.nodeTypes.map((s) => [s.type, s]))
        setSpecs(types.nodeTypes)
        setName(flow.flow.name)
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
  const selectedSpec = selected ? specLookup.get(selected.data.specType) : undefined

  const markDirty = () => setDirty(true)

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((eds) => addEdge(conn, eds))
      setDirty(true)
    },
    [setEdges],
  )

  const addNode = (spec: NodeSpec, position?: { x: number; y: number }) => {
    const n = addAt.current++
    setNodes((ns) => [
      ...ns.map((node) => ({ ...node, selected: false })),
      {
        id: `n${Date.now().toString(36)}${n}`,
        type: 'flow' as const,
        position: position ?? { x: 80 + n * 24, y: 80 + n * 24 },
        data: {
          specType: spec.type,
          config: Object.fromEntries(
            spec.config.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]),
          ),
        },
        selected: true,
      },
    ])
    setPaletteOpen(false)
    setMenu(null)
    setDirty(true)
  }

  const removeNode = (nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId))
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setMenu(null)
    setDirty(true)
  }

  const duplicateNode = (nodeId: string) => {
    const src = nodes.find((n) => n.id === nodeId)
    if (!src) return
    const n = addAt.current++
    setNodes((ns) => [
      ...ns.map((node) => ({ ...node, selected: false })),
      {
        ...src,
        id: `n${Date.now().toString(36)}${n}`,
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

  const setConfigValue = (key: string, value: unknown) => {
    if (!selected) return
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected.id
          ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } }
          : n,
      ),
    )
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await saveFlow(id, { name, graph: fromRF(nodes, edges) })
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
      if (dirty) await saveFlow(id, { name, graph: fromRF(nodes, edges) })
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
                  <NodePicker specs={specs} onSelect={addNode} />
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

      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <ReactFlow<RFNode, RFEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            onNodesChange(changes)
            if (changes.some((c) => c.type === 'position' || c.type === 'remove')) markDirty()
          }}
          onEdgesChange={(changes) => {
            onEdgesChange(changes)
            if (changes.some((c) => c.type === 'remove')) markDirty()
          }}
          onConnect={onConnect}
          onPaneContextMenu={(e) => openMenu(e, 'pane')}
          onNodeContextMenu={(e, node) => openMenu(e, 'node', node.id)}
          onEdgeContextMenu={(e, edge) => openMenu(e, 'edge', edge.id)}
          onPaneClick={() => setMenu(null)}
          onMoveStart={() => setMenu(null)}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls className="!bottom-4 !left-4" showInteractive={false} />
        </ReactFlow>

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
                  <p className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Add node here
                  </p>
                  <NodePicker
                    specs={specs}
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
                    onClick={() => duplicateNode(menu.targetId!)}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Duplicate node
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-muted"
                    onClick={() => removeNode(menu.targetId!)}
                  >
                    <Trash2 className="size-3.5" />
                    Delete node
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

        {selected && selectedSpec ? (
          <aside className="absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-auto border-t border-border bg-card/95 backdrop-blur md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-80 md:border-l md:border-t-0">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span className={`size-2 rounded-full ${CATEGORY_DOT[selectedSpec.category]}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {selectedSpec.label}
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
              <p className="text-xs text-muted-foreground">{selectedSpec.description}</p>

              {selectedSpec.config.length > 0 ? (
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
