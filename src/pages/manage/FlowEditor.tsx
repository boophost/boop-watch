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
  ChevronLeft,
  Copy,
  Loader2,
  Play,
  Plus,
  Save,
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
  runFlow,
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
}

type RFNode = Node<FlowNodeData, 'flow'>
type RFEdge = Edge

const CATEGORY_DOT: Record<NodeCategory, string> = {
  source: 'bg-violet-400',
  filter: 'bg-sky-400',
  enrich: 'bg-amber-400',
  combine: 'bg-emerald-400',
  sink: 'bg-rose-400',
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
      return v === undefined || v === '' ? null : `${f.label}: ${String(v)}`
    })
    .filter(Boolean)
    .slice(0, 3)

  return (
    <div
      className={`min-w-44 max-w-56 rounded-md border bg-card text-card-foreground shadow-sm ${
        selected
          ? 'border-ring ring-2 ring-ring/40'
          : report?.status === 'error'
            ? 'border-destructive'
            : 'border-border'
      }`}
    >
      <div className="relative flex items-center gap-2 border-b border-border px-3 py-2">
        {spec.inputs.map((port) => (
          <Handle
            key={port.id}
            id={port.id}
            type="target"
            position={Position.Left}
            className="!size-2.5 !border-border !bg-muted-foreground"
          />
        ))}
        <span className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[spec.category]}`} />
        <span className="truncate text-xs font-medium">{spec.label}</span>
        {report?.status === 'ok' ? (
          <Check className="ml-auto size-3.5 shrink-0 text-emerald-400" />
        ) : report?.status === 'error' ? (
          <AlertTriangle className="ml-auto size-3.5 shrink-0 text-destructive" />
        ) : null}
      </div>
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
    try {
      if (dirty) await saveFlow(id, { name, graph: fromRF(nodes, edges) })
      setDirty(false)
      const d = await runFlow(id, dryRun)
      setReport(d.report)
      if (d.report.error) setError(d.report.error)
      setNodes((ns) =>
        ns.map((n) => ({ ...n, data: { ...n.data, report: d.report.nodes[n.id] } })),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunningKind(null)
    }
  }

  const grouped = useMemo(() => {
    const cats: NodeCategory[] = ['source', 'filter', 'enrich', 'combine', 'sink']
    return cats
      .map((c) => ({ category: c, specs: specs.filter((s) => s.category === c) }))
      .filter((g) => g.specs.length > 0)
  }, [specs])

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
                <div className="fixed inset-x-3 top-28 z-30 max-h-96 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-64">
                {grouped.map((g) => (
                  <div key={g.category}>
                    <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {g.category}
                    </p>
                    {g.specs.map((s) => (
                      <button
                        key={s.type}
                        type="button"
                        className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted"
                        onClick={() => addNode(s)}
                      >
                        <span className="flex items-center gap-2 text-sm">
                          <span className={`size-2 rounded-full ${CATEGORY_DOT[s.category]}`} />
                          {s.label}
                        </span>
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">
                          {s.description}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
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
              className="fixed z-40 w-56 rounded-md border border-border bg-popover p-1 shadow-md"
              style={{
                left: Math.min(menu.x, window.innerWidth - 232),
                top: Math.min(menu.y, window.innerHeight - (menu.kind === 'pane' ? 340 : 120)),
              }}
              role="menu"
            >
              {menu.kind === 'pane' ? (
                <div className="max-h-80 overflow-auto">
                  <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Add node here
                  </p>
                  {grouped.map((g) =>
                    g.specs.map((s) => (
                      <button
                        key={s.type}
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() =>
                          addNode(s, screenToFlowPosition({ x: menu.x, y: menu.y }))
                        }
                      >
                        <span className={`size-2 shrink-0 rounded-full ${CATEGORY_DOT[s.category]}`} />
                        {s.label}
                      </button>
                    )),
                  )}
                </div>
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
                            type={f.kind === 'number' ? 'number' : 'text'}
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
