// Live Flow Map: every flow as a movable parent group on one canvas.
// Group positions + sticky notes are saved server-side; Ctrl+Z/Y undoes map edits.
// Inner flow nodes stay fixed (read-only); live activity paints running nodes.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  BaseEdge,
  getBezierPath,
  EdgeLabelRenderer,
  NodeResizer,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './flowMap.css'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FlaskConical,
  Loader2,
  Map as MapIcon,
  Network,
  Redo2,
  RefreshCw,
  StickyNote,
  Trash2,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isEditorNode } from '@/lib/flowEditorMeta'
import { ArrowCurveGraphic } from './flowEditorAnnotations'
import {
  getFlowMap,
  getNodeTypes,
  getQueueStats,
  saveFlowMapState,
  streamActivity,
  resolveNodePorts,
  type ActivityStreamEvent,
  type FlowMapEntry,
  type FlowMapLayout,
  type FlowMapNote,
  type NodeCategory,
  type NodePort,
  type NodeReport,
  type NodeSpec,
  type PortDataType,
  type QueueStat,
  type RunActivity,
} from '@/lib/flows'
import { useFlowHistory } from './useFlowHistory'

// ---- constants -------------------------------------------------------------

const LEGACY_LAYOUT_KEY = 'boop-watch.flow-map.layout'
const GROUP_PAD = { top: 24, left: 20, right: 20, bottom: 20 }
const GROUP_GAP = 80
const EST_NODE = { w: 180, h: 96 }
const EST_REROUTE = { w: 16, h: 16 }
const EST_STICKY = { w: 160, h: 100 }
const DEFAULT_NOTE = { w: 200, h: 140, color: '#fef08a' }

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

const PORT_COLOR: Record<PortDataType, string> = {
  items: 'var(--muted-foreground)',
  torrent: '#c084fc',
  release: '#818cf8',
  catalog: '#e879f9',
  file: '#facc15',
  probed: '#F9A825',
  text: '#38bdf8',
  number: '#fbbf24',
  color: '#f472b6',
  url: '#2dd4bf',
  json: '#fb923c',
  embed: '#a78bfa',
}

const TRIGGER_LIME = '#a3e635'
const QUEUE_LABELS: Record<string, string> = {
  jikan: 'Jikan',
  tsukihime: 'TsukiHime',
  tosho: 'AnimeTosho',
  anilist: 'AniList',
  kitsu: 'Kitsu',
  fanart: 'fanart.tv',
  jimaku: 'Jimaku',
  aniskip: 'AniSkip',
  other: 'Other',
}

const portColor = (t: PortDataType | undefined) => PORT_COLOR[t ?? 'items']

// ---- types -----------------------------------------------------------------

interface MapNodeData extends Record<string, unknown> {
  flowId: number
  flowName: string
  published: boolean
  active?: boolean
  dimmed?: boolean
  specType?: string
  config?: Record<string, unknown>
  label?: string
  category?: NodeCategory
  inputs?: NodePort[]
  outputs?: NodePort[]
  isTrigger?: boolean
  running?: boolean
  report?: NodeReport
  noteId?: string
  text?: string
  color?: string
  onNoteChange?: (patch: { text?: string; width?: number; height?: number }) => void
}

type MapRFNode = Node<MapNodeData, 'mapGroup' | 'mapFlow' | 'mapReroute' | 'mapNote' | 'mapSticky'>
type MapRFEdge = Edge<{ pulse?: number; pulseAt?: number }>
type SavedLayout = FlowMapLayout

interface LiveRun {
  runToken: string
  flowId: number | null
  flowName: string
  dryRun: boolean
  startedAt: string
  nodes: RunActivity[]
}

interface NodeLive {
  running?: boolean
  report?: NodeReport
}

// ---- layout helpers --------------------------------------------------------

function mapNodeId(flowId: number, nodeId: string) {
  return `f${flowId}:${nodeId}`
}

function mapGroupId(flowId: number) {
  return `flow-${flowId}`
}

function nodeSize(type: string, config: Record<string, unknown>): { w: number; h: number } {
  const w = typeof config.width === 'number' ? config.width : undefined
  const h = typeof config.height === 'number' ? config.height : undefined
  if (type === 'transform.reroute') return { w: w ?? EST_REROUTE.w, h: h ?? EST_REROUTE.h }
  if (type === 'editor.sticky') return { w: w ?? EST_STICKY.w, h: h ?? EST_STICKY.h }
  if (type === 'editor.arrow') return { w: w ?? 200, h: h ?? 120 }
  if (type === 'editor.group') return { w: w ?? 280, h: h ?? 180 }
  return { w: w ?? EST_NODE.w, h: h ?? EST_NODE.h }
}

function loadLegacyLayout(): SavedLayout {
  try {
    const raw = localStorage.getItem(LEGACY_LAYOUT_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as SavedLayout
  } catch {
    return {}
  }
}

function clearLegacyLayout() {
  try {
    localStorage.removeItem(LEGACY_LAYOUT_KEY)
  } catch {
    /* ignore */
  }
}

function packGroups(
  sizes: { flowId: number; w: number; h: number }[],
  saved: SavedLayout,
  rowWidth = 2400,
): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>()
  let x = 0
  let y = 0
  let rowH = 0
  for (const s of sizes) {
    const remembered = saved[String(s.flowId)]
    if (remembered) {
      positions.set(s.flowId, remembered)
      continue
    }
    if (x > 0 && x + s.w > rowWidth) {
      x = 0
      y += rowH + GROUP_GAP
      rowH = 0
    }
    positions.set(s.flowId, { x, y })
    x += s.w + GROUP_GAP
    rowH = Math.max(rowH, s.h)
  }
  return positions
}

function buildFlowCanvas(
  entry: FlowMapEntry,
  specs: Map<string, NodeSpec>,
  origin: { x: number; y: number },
): { nodes: MapRFNode[]; edges: MapRFEdge[]; width: number; height: number } {
  const g = entry.graph
  const groupId = mapGroupId(entry.id)

  // Include editor annotations (stickies, arrows, groups) inside each flow group.
  const graphNodes = g.nodes
  const idSet = new Set(graphNodes.map((n) => n.id))

  const topLevel = graphNodes.filter((n) => {
    const gid = typeof n.config.groupId === 'string' ? n.config.groupId : undefined
    return !gid || !idSet.has(gid)
  })

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  if (topLevel.length === 0) {
    minX = 0
    minY = 0
    maxX = 200
    maxY = 80
  } else {
    for (const n of topLevel) {
      const { w, h } = nodeSize(n.type, n.config)
      minX = Math.min(minX, n.position.x)
      minY = Math.min(minY, n.position.y)
      maxX = Math.max(maxX, n.position.x + w)
      maxY = Math.max(maxY, n.position.y + h)
    }
  }

  const innerW = Math.max(160, maxX - minX)
  const innerH = Math.max(80, maxY - minY)
  const width = innerW + GROUP_PAD.left + GROUP_PAD.right
  const height = innerH + GROUP_PAD.top + GROUP_PAD.bottom

  const groupNode: MapRFNode = {
    id: groupId,
    type: 'mapGroup',
    position: origin,
    style: { width, height },
    zIndex: -1,
    draggable: true,
    selectable: true,
    connectable: false,
    data: {
      flowId: entry.id,
      flowName: entry.name,
      published: entry.published,
    },
  }

  const childNodes: MapRFNode[] = graphNodes.map((n) => {
    const nestedGid = typeof n.config.groupId === 'string' ? n.config.groupId : undefined
    const hasParent = !!(nestedGid && idSet.has(nestedGid))
    const { w, h } = nodeSize(n.type, n.config)
    const config = { ...n.config }
    delete config.groupId

    const relative = hasParent
      ? n.position
      : {
          x: n.position.x - minX + GROUP_PAD.left,
          y: n.position.y - minY + GROUP_PAD.top,
        }

    const spec = specs.get(n.type)
    const ports = spec ? resolveNodePorts(spec, config) : { inputs: [], outputs: [] }
    const isTrigger = n.type.startsWith('trigger.')
    const editor = isEditorNode(n.type)

    let rfType: MapRFNode['type'] = 'mapFlow'
    if (n.type === 'transform.reroute') rfType = 'mapReroute'
    else if (editor) rfType = 'mapNote'

    return {
      id: mapNodeId(entry.id, n.id),
      type: rfType,
      position: relative,
      parentId: hasParent ? mapNodeId(entry.id, nestedGid!) : groupId,
      extent: 'parent' as const,
      style: editor || n.type === 'editor.group' ? { width: w, height: h } : undefined,
      zIndex: n.type === 'editor.group' ? -1 : undefined,
      draggable: false,
      selectable: true,
      connectable: false,
      data: {
        flowId: entry.id,
        flowName: entry.name,
        published: entry.published,
        specType: n.type,
        config,
        label: spec?.label ?? n.type,
        category: spec?.category ?? 'source',
        inputs: ports.inputs,
        outputs: ports.outputs,
        isTrigger,
      },
    }
  })

  const edges: MapRFEdge[] = g.edges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({
      id: `f${entry.id}:${e.id}`,
      source: mapNodeId(entry.id, e.source),
      sourceHandle: e.sourceHandle,
      target: mapNodeId(entry.id, e.target),
      targetHandle: e.targetHandle,
      focusable: false,
      interactable: false,
      data: {},
    }))

  return { nodes: [groupNode, ...childNodes], edges, width, height }
}

function buildMapGraph(
  flows: FlowMapEntry[],
  specs: Map<string, NodeSpec>,
  hideComponents: boolean,
  saved: SavedLayout,
): { nodes: MapRFNode[]; edges: MapRFEdge[] } {
  const visible = hideComponents ? flows.filter((f) => !f.published) : flows
  const measured = visible.map((f) => {
    const built = buildFlowCanvas(f, specs, { x: 0, y: 0 })
    return { flow: f, built }
  })
  const positions = packGroups(
    measured.map((m) => ({ flowId: m.flow.id, w: m.built.width, h: m.built.height })),
    saved,
  )

  const nodes: MapRFNode[] = []
  const edges: MapRFEdge[] = []
  for (const m of measured) {
    const origin = positions.get(m.flow.id) ?? { x: 0, y: 0 }
    const rebuilt = buildFlowCanvas(m.flow, specs, origin)
    nodes.push(...rebuilt.nodes)
    edges.push(...rebuilt.edges)
  }
  return { nodes, edges }
}

function stickyNodesFromNotes(
  notes: FlowMapNote[],
  onNoteChange: (noteId: string, patch: { text?: string; width?: number; height?: number }) => void,
): MapRFNode[] {
  return notes.map((n) => ({
    id: `note:${n.id}`,
    type: 'mapSticky' as const,
    position: { x: n.x, y: n.y },
    style: { width: n.width, height: n.height },
    draggable: true,
    selectable: true,
    connectable: false,
    zIndex: 5,
    data: {
      flowId: 0,
      flowName: '',
      published: false,
      noteId: n.id,
      text: n.text,
      color: n.color ?? DEFAULT_NOTE.color,
      onNoteChange: (patch) => onNoteChange(n.id, patch),
    },
  }))
}

function layoutFromNodes(nodes: MapRFNode[]): SavedLayout {
  const layout: SavedLayout = {}
  for (const n of nodes) {
    if (n.type !== 'mapGroup') continue
    layout[String(n.data.flowId)] = {
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
    }
  }
  return layout
}

function notesFromNodes(nodes: MapRFNode[]): FlowMapNote[] {
  return nodes
    .filter((n) => n.type === 'mapSticky' && n.data.noteId)
    .map((n) => {
      const w = typeof n.style?.width === 'number' ? n.style.width : DEFAULT_NOTE.w
      const h = typeof n.style?.height === 'number' ? n.style.height : DEFAULT_NOTE.h
      return {
        id: n.data.noteId!,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        width: Math.round(w),
        height: Math.round(h),
        text: String(n.data.text ?? ''),
        ...(n.data.color ? { color: String(n.data.color) } : {}),
      }
    })
}

/** Title grows as you zoom out so group names stay readable; never shrinks below 1×. */
function zoomTitleScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(Math.max(1 / zoom, 1), 8)
}

function zoomBorderPx(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 2
  return Math.min(Math.max(2 / zoom, 2), 10)
}

// ---- node components -------------------------------------------------------

const MapGroupNode = memo(function MapGroupNode({ data, selected }: NodeProps<MapRFNode>) {
  const zoom = useStore((s) => s.transform[2])
  const titleScale = zoomTitleScale(zoom)
  const borderPx = zoomBorderPx(zoom)

  return (
    <div className="relative h-full w-full">
      {/* Floating counter-scaled label — readable at any zoom. */}
      <div
        className="flow-map-label absolute left-0 z-10"
        style={{
          bottom: '100%',
          marginBottom: 6,
          transform: `scale(${titleScale})`,
          transformOrigin: 'bottom left',
        }}
      >
        <div
          className={cn(
            'flex max-w-[min(70vw,520px)] items-center gap-2 rounded-md border bg-background/95 px-2.5 py-1 shadow-md backdrop-blur-sm',
            data.active ? 'border-violet-400' : selected ? 'border-ring' : 'border-border',
          )}
        >
          <span className="truncate text-sm font-semibold text-foreground">{data.flowName}</span>
          {data.published ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Component
            </span>
          ) : null}
          {data.active ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-400" />
          ) : (
            <Link
              to={`/manage/flows/${data.flowId}`}
              className="nodrag nopan pointer-events-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="Open in editor"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-3.5" />
            </Link>
          )}
        </div>
      </div>

      <div
        className={cn(
          'h-full w-full rounded-xl bg-card/50 backdrop-blur-[1px]',
          data.active
            ? 'flow-map-group-active border-violet-400'
            : selected
              ? 'border-ring'
              : 'border-violet-400/55',
          data.dimmed && !data.active ? 'opacity-45' : null,
        )}
        style={{ borderStyle: 'solid', borderWidth: borderPx }}
      />
    </div>
  )
})

const MapFlowNode = memo(function MapFlowNode({ data }: NodeProps<MapRFNode>) {
  const inputs = (data.inputs ?? []).filter((p) => p.id !== 'when')
  const whenPort = (data.inputs ?? []).find((p) => p.id === 'when')
  const outputs = data.outputs ?? []
  const report = data.report
  const running = data.running === true
  const category = data.category ?? 'source'

  return (
    <div
      className={cn(
        'min-w-40 max-w-52 rounded-md border bg-card text-card-foreground shadow-sm',
        running
          ? 'border-ring ring-2 ring-ring/30'
          : report?.status === 'error'
            ? 'border-destructive'
            : report?.status === 'ok'
              ? 'border-emerald-500/50'
              : 'border-border',
        data.dimmed ? 'opacity-40' : null,
      )}
    >
      <div className="relative flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        {whenPort ? (
          <Handle
            id={whenPort.id}
            type="target"
            position={Position.Left}
            className="!size-2 !border-border !bg-lime-400"
            isConnectable={false}
          />
        ) : null}
        <span className={`size-1.5 shrink-0 rounded-full ${CATEGORY_DOT[category]}`} />
        <span className="truncate text-[11px] font-medium">{data.label}</span>
        <div className="ml-auto shrink-0">
          {running ? (
            <Loader2 className="size-3 animate-spin text-ring" />
          ) : report?.status === 'ok' ? (
            <Check className="size-3 text-emerald-400" />
          ) : report?.status === 'error' ? (
            <AlertTriangle className="size-3 text-destructive" />
          ) : null}
        </div>
      </div>
      {inputs.length > 0 ? (
        <div className="border-b border-border py-0.5">
          {inputs.map((port) => (
            <div key={port.id} className="relative flex items-center gap-1.5 px-2.5 py-0.5">
              <Handle
                id={port.id}
                type="target"
                position={Position.Left}
                className="!size-2 !border-border"
                style={{ background: portColor(port.dataType) }}
                isConnectable={false}
              />
              <span className="text-[9px] text-muted-foreground">{port.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="py-0.5">
        {outputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-end gap-1.5 px-2.5 py-0.5">
            {report ? (
              <span className="rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">
                {report.counts[port.id] ?? 0}
              </span>
            ) : null}
            <span
              className="text-[9px] text-muted-foreground"
              style={data.isTrigger ? { color: TRIGGER_LIME } : undefined}
            >
              {port.label}
            </span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              className="!size-2 !border-border"
              style={{ background: data.isTrigger ? TRIGGER_LIME : portColor(port.dataType) }}
              isConnectable={false}
            />
          </div>
        ))}
      </div>
    </div>
  )
})

const MapRerouteNode = memo(function MapRerouteNode({ data }: NodeProps<MapRFNode>) {
  return (
    <div className={cn('relative size-3', data.dimmed ? 'opacity-40' : null)}>
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!size-2 !border-border !bg-muted-foreground"
        isConnectable={false}
        style={{ left: 0, top: '50%' }}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!size-2 !border-border !bg-muted-foreground"
        isConnectable={false}
        style={{ right: 0, top: '50%' }}
      />
    </div>
  )
})

/** Embedded editor annotation inside a flow group (read-only on the map). */
const MapNoteNode = memo(function MapNoteNode({ data, width, height }: NodeProps<MapRFNode>) {
  const cfg = data.config ?? {}
  if (data.specType === 'editor.arrow') {
    const w = width ?? (typeof cfg.width === 'number' ? cfg.width : 200)
    const h = height ?? (typeof cfg.height === 'number' ? cfg.height : 120)
    return (
      <div className={cn('h-full w-full', data.dimmed ? 'opacity-30' : 'opacity-90')}>
        <ArrowCurveGraphic config={cfg} width={w} height={h} />
      </div>
    )
  }
  const text = typeof cfg.text === 'string' ? cfg.text : data.label
  const color = typeof cfg.color === 'string' ? cfg.color : 'rgba(124, 92, 255, 0.12)'
  const title = typeof cfg.title === 'string' ? cfg.title : null
  return (
    <div
      className={cn(
        'h-full w-full rounded-md border border-dashed border-border/60 px-2 py-1 text-[10px] text-muted-foreground',
        data.dimmed ? 'opacity-30' : 'opacity-70',
      )}
      style={{ backgroundColor: color }}
    >
      {title ? <div className="mb-0.5 font-medium text-foreground/70">{title}</div> : null}
      {text ? <div className="line-clamp-4 whitespace-pre-wrap">{text}</div> : null}
    </div>
  )
})

/** Map-level sticky note (editable, draggable, persisted with the map). */
const MapStickyNode = memo(function MapStickyNode({ data, selected }: NodeProps<MapRFNode>) {
  const [editing, setEditing] = useState(false)
  const color = data.color ?? DEFAULT_NOTE.color
  const text = data.text ?? ''

  return (
    <div
      className={cn(
        'relative h-full w-full rounded-sm shadow-md',
        selected ? 'ring-2 ring-ring/50' : null,
      )}
      style={{ backgroundColor: color, color: '#422006' }}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        minWidth={120}
        minHeight={80}
        isVisible={Boolean(selected) && !editing}
        onResizeEnd={(_, p) => data.onNoteChange?.({ width: Math.round(p.width), height: Math.round(p.height) })}
      />
      {editing ? (
        <textarea
          className="nodrag nopan h-full w-full resize-none rounded-sm bg-transparent p-2 text-xs outline-none"
          autoFocus
          value={text}
          onChange={(e) => data.onNoteChange?.({ text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div className="h-full w-full whitespace-pre-wrap p-2 text-xs">
          {text || <span className="opacity-50">Double-click to edit…</span>}
        </div>
      )}
    </div>
  )
})

function MapThroughputEdge({
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
}: EdgeProps<MapRFEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const pulse = data?.pulse
  const pulsing = typeof pulse === 'number' && pulse > 0 && data?.pulseAt && Date.now() - data.pulseAt < 1800
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        className={pulsing ? 'flow-map-edge-pulse' : undefined}
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

function MapBackground() {
  const zoom = useStore((s) => s.transform[2])
  const gap = Math.max(18, Math.round(28 / Math.max(zoom, 0.2)))
  const size = Math.max(1.25, Math.min(3.5, 1.8 / Math.max(zoom, 0.25)))
  return <Background gap={gap} size={size} color="rgba(167, 139, 250, 0.28)" />
}

const nodeTypes = {
  mapGroup: MapGroupNode,
  mapFlow: MapFlowNode,
  mapReroute: MapRerouteNode,
  mapNote: MapNoteNode,
  mapSticky: MapStickyNode,
}

const edgeTypes = {
  throughput: MapThroughputEdge,
}

// ---- page ------------------------------------------------------------------

function FlowMapInner() {
  const [flows, setFlows] = useState<FlowMapEntry[]>([])
  const [specs, setSpecs] = useState<Map<string, NodeSpec>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hideComponents, setHideComponents] = useState(false)
  const [connected, setConnected] = useState(false)
  const [live, setLive] = useState<LiveRun | null>(null)
  const [nodeLive, setNodeLive] = useState<Record<string, NodeLive>>({})
  const [fadeUntil, setFadeUntil] = useState(0)
  const [queues, setQueues] = useState<Record<string, QueueStat>>({})
  const [gen, setGen] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const layoutRef = useRef<SavedLayout>({})
  const notesRef = useRef<FlowMapNote[]>([])
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteSeq = useRef(0)

  const [nodes, setNodes, onNodesChange] = useNodesState<MapRFNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapRFEdge>([])
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  const { screenToFlowPosition } = useReactFlow()
  const {
    takeSnapshot: pushHistory,
    undo: undoHistory,
    redo: redoHistory,
    clear: clearHistory,
    canUndo,
    canRedo,
  } = useFlowHistory<MapRFNode, MapRFEdge>()

  const snapshot = useCallback(() => {
    pushHistory(nodesRef.current, edgesRef.current)
  }, [pushHistory])

  const persistSoon = useCallback((nextNodes: MapRFNode[]) => {
    layoutRef.current = layoutFromNodes(nextNodes)
    notesRef.current = notesFromNodes(nextNodes)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      setSaveState('saving')
      void saveFlowMapState({ layout: layoutRef.current, notes: notesRef.current })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'))
    }, 350)
  }, [])

  const restoreSnapshot = useCallback(
    (snap: { nodes: MapRFNode[]; edges: MapRFEdge[] }) => {
      // Re-bind sticky callbacks after JSON round-trip from history.
      const restored = snap.nodes.map((n) => {
        if (n.type !== 'mapSticky' || !n.data.noteId) return n
        const noteId = n.data.noteId
        return {
          ...n,
          data: {
            ...n.data,
            onNoteChange: (patch: { text?: string; width?: number; height?: number }) => {
              setNodes((ns) =>
                ns.map((x) => {
                  if (x.data.noteId !== noteId) return x
                  return {
                    ...x,
                    style: {
                      ...x.style,
                      ...(patch.width != null ? { width: patch.width } : null),
                      ...(patch.height != null ? { height: patch.height } : null),
                    },
                    data: {
                      ...x.data,
                      ...(patch.text != null ? { text: patch.text } : null),
                    },
                  }
                }),
              )
            },
          },
        }
      })
      setNodes(restored)
      setEdges(snap.edges)
      persistSoon(restored)
    },
    [setNodes, setEdges, persistSoon],
  )

  const undo = useCallback(() => {
    undoHistory(nodesRef.current, edgesRef.current, restoreSnapshot)
  }, [undoHistory, restoreSnapshot])

  const redo = useCallback(() => {
    redoHistory(nodesRef.current, edgesRef.current, restoreSnapshot)
  }, [redoHistory, restoreSnapshot])

  const onNoteChange = useCallback(
    (noteId: string, patch: { text?: string; width?: number; height?: number }) => {
      setNodes((ns) => {
        const next = ns.map((x) => {
          if (x.data.noteId !== noteId) return x
          return {
            ...x,
            style: {
              ...x.style,
              ...(patch.width != null ? { width: patch.width } : null),
              ...(patch.height != null ? { height: patch.height } : null),
            },
            data: {
              ...x.data,
              ...(patch.text != null ? { text: patch.text } : null),
            },
          }
        })
        persistSoon(next)
        return next
      })
    },
    [setNodes, persistSoon],
  )

  const attachStickies = useCallback(
    (base: MapRFNode[], notes: FlowMapNote[]) => [
      ...base,
      ...stickyNodesFromNotes(notes, onNoteChange),
    ],
    [onNoteChange],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [{ flows: mapFlows, layout, notes }, { nodeTypes: types }] = await Promise.all([
        getFlowMap(),
        getNodeTypes(),
      ])
      const specMap = new Map(types.map((s) => [s.type, s]))
      setSpecs(specMap)
      setFlows(mapFlows)

      // One-time migrate browser-local positions if the server has none yet.
      let effectiveLayout = layout ?? {}
      if (Object.keys(effectiveLayout).length === 0) {
        const legacy = loadLegacyLayout()
        if (Object.keys(legacy).length > 0) {
          effectiveLayout = legacy
          clearLegacyLayout()
          void saveFlowMapState({ layout: effectiveLayout, notes: notes ?? [] })
        }
      }
      layoutRef.current = effectiveLayout
      notesRef.current = notes ?? []

      const built = buildMapGraph(mapFlows, specMap, hideComponents, effectiveLayout)
      setNodes(attachStickies(built.nodes, notesRef.current))
      setEdges(
        built.edges.map((e) => ({
          ...e,
          type: 'throughput',
          style: { stroke: 'rgba(167,139,250,0.45)', strokeWidth: 1.5 },
        })),
      )
      clearHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load flow map')
    } finally {
      setLoading(false)
    }
  }, [hideComponents, setNodes, setEdges, attachStickies, clearHistory])

  useEffect(() => {
    void load()
  }, [load, gen])

  // Rebuild flows when filter toggles; keep sticky notes.
  useEffect(() => {
    if (flows.length === 0 || specs.size === 0) return
    const stickies = notesFromNodes(nodesRef.current)
    notesRef.current = stickies.length ? stickies : notesRef.current
    layoutRef.current = {
      ...layoutRef.current,
      ...layoutFromNodes(nodesRef.current),
    }
    const built = buildMapGraph(flows, specs, hideComponents, layoutRef.current)
    setNodes(attachStickies(built.nodes, notesRef.current))
    setEdges(
      built.edges.map((e) => ({
        ...e,
        type: 'throughput',
        style: { stroke: 'rgba(167,139,250,0.45)', strokeWidth: 1.5 },
      })),
    )
    setNodeLive({})
  }, [hideComponents, flows, specs, setNodes, setEdges, attachStickies])

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === 'mapGroup' || node.type === 'mapSticky') snapshot()
    },
    [snapshot],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'mapGroup' && node.type !== 'mapSticky') return
      persistSoon(nodesRef.current)
    },
    [persistSoon],
  )

  const addNote = useCallback(() => {
    snapshot()
    const id = `n${Date.now().toString(36)}${noteSeq.current++}`
    const pos = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    const note: FlowMapNote = {
      id,
      x: Math.round(pos.x - DEFAULT_NOTE.w / 2),
      y: Math.round(pos.y - DEFAULT_NOTE.h / 2),
      width: DEFAULT_NOTE.w,
      height: DEFAULT_NOTE.h,
      text: '',
      color: DEFAULT_NOTE.color,
    }
    setNodes((ns) => {
      const next = [...ns, ...stickyNodesFromNotes([note], onNoteChange)]
      persistSoon(next)
      return next
    })
  }, [snapshot, screenToFlowPosition, setNodes, onNoteChange, persistSoon])

  const deleteSelectedStickies = useCallback(() => {
    const selected = nodesRef.current.filter((n) => n.selected && n.type === 'mapSticky')
    if (selected.length === 0) return
    snapshot()
    setNodes((ns) => {
      const next = ns.filter((n) => !(n.selected && n.type === 'mapSticky'))
      persistSoon(next)
      return next
    })
  }, [snapshot, setNodes, persistSoon])

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
      const key = e.key.toLowerCase()
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((mod && key === 'y') || (mod && key === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only delete map stickies — flow groups/nodes stay.
        if (nodesRef.current.some((n) => n.selected && n.type === 'mapSticky')) {
          e.preventDefault()
          deleteSelectedStickies()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelectedStickies])

  // Queue poll for side panel.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const { queues: q } = await getQueueStats()
        if (!cancelled) setQueues(q)
      } catch {
        /* keep last */
      }
    }
    void tick()
    const iv = setInterval(() => {
      if (!document.hidden) void tick()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [gen])

  // Live activity stream.
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()

    const handle = (ev: ActivityStreamEvent) => {
      setConnected(true)
      switch (ev.type) {
        case 'start':
          setLive({
            runToken: ev.runToken,
            flowId: ev.flowId,
            flowName: ev.flowName,
            dryRun: ev.dryRun,
            startedAt: ev.startedAt,
            nodes: [],
          })
          setNodeLive({})
          setFadeUntil(0)
          break
        case 'node-start':
          setLive((p) => {
            if (!p || p.runToken !== ev.runToken) return p
            const mid = p.flowId != null ? mapNodeId(p.flowId, ev.nodeId) : ev.nodeId
            setNodeLive((nl) => ({ ...nl, [mid]: { ...nl[mid], running: true } }))
            return p
          })
          break
        case 'node':
          setLive((p) => {
            if (!p || p.runToken !== ev.runToken) return p
            const mid = p.flowId != null ? mapNodeId(p.flowId, ev.nodeId) : ev.nodeId
            const report: NodeReport = {
              status: ev.status,
              durationMs: ev.durationMs ?? 0,
              counts: ev.counts ?? {},
              samples: {},
              notes: ev.notes,
              ...(ev.error ? { error: ev.error } : {}),
            }
            setNodeLive((nl) => ({
              ...nl,
              [mid]: { running: false, report },
            }))
            if (ev.counts) {
              const now = Date.now()
              setEdges((eds) =>
                eds.map((e) => {
                  if (e.source !== mid) return e
                  const handle = e.sourceHandle ?? ''
                  const count = ev.counts?.[handle]
                  if (count == null) return e
                  return {
                    ...e,
                    animated: count > 0,
                    data: { ...e.data, pulse: count, pulseAt: now },
                    style: {
                      ...e.style,
                      stroke: count > 0 ? '#a78bfa' : 'rgba(167,139,250,0.45)',
                      strokeWidth: count > 0 ? 2.5 : 1.5,
                    },
                  }
                }),
              )
            }
            return {
              ...p,
              nodes: [
                ...p.nodes,
                {
                  node: ev.node,
                  type: ev.nodeType,
                  status: ev.status,
                  notes: ev.notes,
                  error: ev.error,
                },
              ],
            }
          })
          break
        case 'done':
        case 'aborted': {
          const token = ev.runToken
          setLive((p) => {
            if (!p || p.runToken !== token) return p
            setFadeUntil(Date.now() + 4000)
            return { ...p }
          })
          setTimeout(() => {
            if (cancelled) return
            setLive((p) => (p && p.runToken === token ? null : p))
            setEdges((eds) =>
              eds.map((e) => ({
                ...e,
                animated: false,
                data: { ...e.data, pulse: undefined, pulseAt: undefined },
                style: { ...e.style, stroke: 'rgba(167,139,250,0.45)', strokeWidth: 1.5 },
              })),
            )
          }, 4000)
          break
        }
        default:
          break
      }
    }

    const loop = async () => {
      while (!cancelled) {
        try {
          await streamActivity((ev) => {
            if (!cancelled) handle(ev)
          }, ac.signal)
        } catch {
          if (cancelled) return
          setConnected(false)
        }
        if (cancelled) return
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void loop()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [gen, setEdges])

  const activeFlowId = live?.flowId ?? null
  const dimOthers = activeFlowId != null || (fadeUntil > Date.now() && live != null)

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.type === 'mapGroup') {
          const active = activeFlowId != null && n.data.flowId === activeFlowId
          return {
            ...n,
            data: {
              ...n.data,
              active,
              dimmed: dimOthers && !active,
            },
          }
        }
        if (n.type === 'mapSticky') {
          return { ...n, draggable: true }
        }
        const overlay = nodeLive[n.id]
        const active = activeFlowId != null && n.data.flowId === activeFlowId
        return {
          ...n,
          data: {
            ...n.data,
            running: overlay?.running,
            report: overlay?.report,
            dimmed: dimOthers && !active,
          },
          draggable: false,
        }
      }),
    [nodes, nodeLive, activeFlowId, dimOthers],
  )

  const queueEntries = Object.entries(queues)
    .filter(([, q]) => q.total > 0 || q.inFlight > 0 || q.queued > 0)
    .sort((a, b) => b[1].recent - a[1].recent || b[1].total - a[1].total)

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:px-6">
        <MapIcon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Flow Map</h1>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={() => undo()}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2"
          title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={() => redo()}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => addNote()}>
          <StickyNote className="size-4" />
          <span className="hidden sm:inline">Note</span>
        </Button>
        <label className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <input
            type="checkbox"
            className="size-3.5 accent-violet-500"
            checked={hideComponents}
            onChange={(e) => setHideComponents(e.target.checked)}
          />
          Hide components
        </label>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <span
            className={cn(
              'size-1.5 rounded-full',
              connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400',
            )}
          />
          {connected ? 'live' : 'reconnecting…'}
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Save failed'
                : null}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => setGen((g) => g + 1)}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/manage/flows">Flows</Link>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {error ? (
            <p className="absolute left-4 top-4 z-10 rounded-md border border-destructive/40 bg-card px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {loading && nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading flow map…
            </div>
          ) : (
            <ReactFlow
              className="flow-map-canvas bg-[#0b0a10]"
              nodes={displayNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesConnectable={false}
              edgesFocusable={false}
              elementsSelectable
              deleteKeyCode={null}
              panOnScroll
              fitView
              fitViewOptions={{ padding: 0.12 }}
              minZoom={0.08}
              maxZoom={1.5}
              colorMode="dark"
              proOptions={{ hideAttribution: true }}
            >
              <MapBackground />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 lg:flex">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Current run
            </h2>
            {live ? (
              <div
                className={cn(
                  'rounded-lg border p-3',
                  fadeUntil > Date.now() ? 'border-border' : 'border-violet-500/40',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {fadeUntil > Date.now() ? (
                    <Check className="size-3.5 text-emerald-400" />
                  ) : (
                    <Loader2 className="size-3.5 animate-spin text-violet-400" />
                  )}
                  <span className="text-sm font-medium">{live.flowName}</span>
                  {live.dryRun ? (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <FlaskConical className="size-3" />
                      dry
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
                      live
                    </span>
                  )}
                </div>
                {live.flowId != null ? (
                  <Link
                    to={`/manage/flows/${live.flowId}`}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Open editor <ExternalLink className="size-3" />
                  </Link>
                ) : null}
                <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto border-t pt-2">
                  {live.nodes.length === 0 ? (
                    <li className="text-[11px] text-muted-foreground">Starting…</li>
                  ) : (
                    live.nodes.map((n, i) => (
                      <li key={i} className="text-[11px]">
                        <span
                          className={cn(
                            'font-medium',
                            n.status === 'error' ? 'text-red-400' : 'text-foreground',
                          )}
                        >
                          {n.node}
                        </span>
                        {n.notes[0] ? (
                          <span className="block truncate text-muted-foreground">{n.notes[0]}</span>
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Idle. When a flow runs (editor, schedule, or trigger), it lights up on the map.
              </p>
            )}
          </div>

          <div>
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Network className="size-3.5" />
              Outbound queues
            </h2>
            {queueEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent outbound traffic.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {queueEntries.map(([key, q]) => {
                  const busy = q.inFlight > 0 || q.queued > 0
                  return (
                    <li
                      key={key}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px]',
                        busy ? 'border-violet-500/50 bg-violet-500/10' : 'border-border',
                      )}
                    >
                      {busy ? (
                        <Loader2 className="size-3 shrink-0 animate-spin text-violet-400" />
                      ) : (
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                      )}
                      <span className="font-medium">{QUEUE_LABELS[key] ?? key}</span>
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {busy ? `${q.inFlight}▶${q.queued > 0 ? ` ${q.queued}⏳` : ''}` : `${q.total}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <p className="mt-auto text-[10px] leading-relaxed text-muted-foreground">
            Drag flow groups and notes — layout is saved for everyone. Notes: Add → double-click to
            edit → Delete/Backspace to remove. Ctrl+Z / Ctrl+Y undo map edits. Group titles stay
            readable when zoomed out.
          </p>
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Trash2 className="size-3" /> selected notes only (groups stay)
          </p>
        </aside>
      </div>
    </div>
  )
}

export default function FlowMap() {
  return (
    <ReactFlowProvider>
      <FlowMapInner />
    </ReactFlowProvider>
  )
}
