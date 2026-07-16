import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { Lock, Unlock } from 'lucide-react'
import {
  arrowDashArray,
  arrowEndpointTangent,
  arrowHeadInset,
  arrowPathD,
  normalizeArrowConfig,
  type ArrowHead,
  type EditorArrowPoint,
  type EditorGroupConfig,
  type EditorStickyConfig,
} from '@/lib/flowEditorMeta'

export interface EditorNodeData extends Record<string, unknown> {
  specType: string
  config: Record<string, unknown>
  report?: unknown
  running?: boolean
  /** Ephemeral — not persisted; wired by FlowEditor for size/text updates. */
  onEditorChange?: (patch: Record<string, unknown>) => void
}

type EditorRfNode = Node<EditorNodeData, 'sticky' | 'arrow' | 'group'>
type EditorNodeProps = NodeProps<EditorRfNode>

const DEFAULT_STICKY = '#fef08a'
const DEFAULT_GROUP = 'rgba(124, 92, 255, 0.12)'
const GROUP_BORDER = 'rgba(124, 92, 255, 0.45)'

function persistSize(data: EditorNodeData, width: number, height: number) {
  data.onEditorChange?.({ width: Math.round(width), height: Math.round(height) })
}

const DEFAULT_FONT_SIZE = 12

function noteTextStyle(cfg: EditorStickyConfig): CSSProperties {
  return {
    fontSize: cfg.fontSize ?? DEFAULT_FONT_SIZE,
    textAlign: cfg.textAlign ?? 'left',
  }
}

function noteVerticalJustify(v: EditorStickyConfig['verticalAlign']) {
  if (v === 'center') return 'center'
  if (v === 'bottom') return 'flex-end'
  return 'flex-start'
}

function rotationStyle(deg: number | undefined): CSSProperties | undefined {
  const r = deg ?? 0
  return r === 0 ? undefined : { transform: `rotate(${r}deg)`, transformOrigin: 'center center' }
}

export const StickyNoteNode = memo(function StickyNoteNode({ data, selected }: EditorNodeProps) {
  const cfg = data.config as EditorStickyConfig
  const color = cfg.color ?? DEFAULT_STICKY
  const text = cfg.text ?? ''
  const textStyle = noteTextStyle(cfg)
  const rotate = rotationStyle(cfg.rotation)
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) return
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [editing])

  useEffect(() => {
    if (!selected) setEditing(false)
  }, [selected])

  const onText = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      data.onEditorChange?.({ text: e.target.value })
    },
    [data],
  )

  return (
    <div
      className={`relative h-full w-full ${selected ? 'ring-2 ring-ring/50 rounded-sm' : ''}`}
    >
      <NodeResizer
        minWidth={100}
        minHeight={72}
        isVisible={Boolean(selected) && !editing}
        onResize={(_, p) => persistSize(data, p.width, p.height)}
        onResizeEnd={(_, p) => persistSize(data, p.width, p.height)}
      />
      <div className="h-full w-full" style={rotate}>
        <div
          className="relative flex h-full w-full flex-col rounded-sm shadow-md"
          style={{ backgroundColor: color, color: '#422006' }}
          onDoubleClick={() => setEditing(true)}
        >
          {editing ? (
            <textarea
              ref={textareaRef}
              className="nodrag nopan nowheel min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 leading-snug outline-none placeholder:text-amber-900/40"
              style={textStyle}
              value={text}
              placeholder="Note…"
              onChange={onText}
              onBlur={() => setEditing(false)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditing(false)
                  ;(e.target as HTMLTextAreaElement).blur()
                }
              }}
            />
          ) : (
            <div
              className="pointer-events-none flex min-h-0 flex-1 flex-col overflow-hidden px-2.5 py-2"
              style={{ justifyContent: noteVerticalJustify(cfg.verticalAlign) }}
            >
              <div className="w-full leading-snug whitespace-pre-wrap" style={textStyle}>
                {text || <span className="text-amber-900/40">Note…</span>}
              </div>
            </div>
          )}
          <span className="pointer-events-none absolute bottom-0 right-0 size-3 bg-gradient-to-tl from-amber-900/15 to-transparent" />
        </div>
      </div>
    </div>
  )
})

function ArrowHeadMark({
  x,
  y,
  angle,
  kind,
  color,
  strokeWidth,
  headSize,
}: {
  x: number
  y: number
  angle: number
  kind: ArrowHead
  color: string
  strokeWidth: number
  headSize: number
}) {
  if (kind === 'none') return null
  const s = Math.max(4, headSize)
  const common = {
    transform: `translate(${x} ${y}) rotate(${angle})`,
  }
  if (kind === 'dot') {
    return <circle cx={x} cy={y} r={Math.max(2, s * 0.45)} fill={color} />
  }
  if (kind === 'open') {
    return (
      <polyline
        {...common}
        points={`-${s},${-s * 0.55} 0,0 -${s},${s * 0.55}`}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
  if (kind === 'diamond') {
    const d = s * 0.85
    return (
      <polygon
        {...common}
        points={`0,0 -${d / 2},${-d * 0.55} -${d},0 -${d / 2},${d * 0.55}`}
        fill={color}
      />
    )
  }
  if (kind === 'triangle') {
    return (
      <polygon {...common} points={`0,0 -${s},${-s * 0.58} -${s},${s * 0.58}`} fill={color} />
    )
  }
  // classic arrow (notched)
  return (
    <polygon
      {...common}
      points={`0,0 -${s},${-s * 0.55} -${s * 0.72},0 -${s},${s * 0.55}`}
      fill={color}
    />
  )
}

/** Read-only (or interactive) arrow curve graphic used by editor + map. */
export function ArrowCurveGraphic({
  config,
  width,
  height,
  interactive = false,
  onPointsChange,
}: {
  config: Record<string, unknown>
  width: number
  height: number
  interactive?: boolean
  onPointsChange?: (points: EditorArrowPoint[]) => void
}) {
  const cfg = normalizeArrowConfig(config)
  const points = cfg.points ?? []
  const strokeWidth = cfg.strokeWidth ?? 2
  const headSize = cfg.headSize ?? 10
  const color = cfg.color ?? '#a1a1aa'
  const dash = arrowDashArray(cfg.dash, strokeWidth)
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const startT = arrowEndpointTangent(points, 'start', w, h)
  const endT = arrowEndpointTangent(points, 'end', w, h)
  const start = points[0]
  const end = points[points.length - 1]

  // Pull the stroke back into the head so the tip isn't fighting a round cap.
  const strokePoints =
    points.length >= 2
      ? points.map((p, i) => {
          if (i === 0) {
            const inset = arrowHeadInset(cfg.startHead, headSize)
            if (inset <= 0) return p
            return {
              x: p.x - (startT.x * inset) / w,
              y: p.y - (startT.y * inset) / h,
            }
          }
          if (i === points.length - 1) {
            const inset = arrowHeadInset(cfg.endHead, headSize)
            if (inset <= 0) return p
            return {
              x: p.x - (endT.x * inset) / w,
              y: p.y - (endT.y * inset) / h,
            }
          }
          return p
        })
      : points
  const d = arrowPathD(strokePoints, w, h)
  const hitD = arrowPathD(points, w, h)

  const dragIndex = useRef<number | null>(null)
  const boxRef = useRef<SVGSVGElement>(null)

  const movePoint = useCallback(
    (index: number, clientX: number, clientY: number) => {
      const svg = boxRef.current
      if (!svg || !onPointsChange) return
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
      const next = points.map((p, i) => (i === index ? { x: nx, y: ny } : p))
      onPointsChange(next)
    },
    [onPointsChange, points],
  )

  const onHandleDown = (index: number) => (e: ReactPointerEvent<SVGCircleElement>) => {
    if (!interactive || !onPointsChange) return
    e.stopPropagation()
    e.preventDefault()
    dragIndex.current = index
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHandleMove = (e: ReactPointerEvent<SVGCircleElement>) => {
    if (dragIndex.current == null) return
    e.stopPropagation()
    movePoint(dragIndex.current, e.clientX, e.clientY)
  }

  const onHandleUp = (e: ReactPointerEvent<SVGCircleElement>) => {
    if (dragIndex.current == null) return
    e.stopPropagation()
    dragIndex.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <svg ref={boxRef} className="size-full overflow-visible" width={w} height={h}>
      {/* Wider invisible hit/stroke target */}
      <path
        d={hitD}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(16, strokeWidth + 12)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        strokeLinecap="butt"
        strokeLinejoin="round"
      />
      {start ? (
        <ArrowHeadMark
          x={start.x * w}
          y={start.y * h}
          angle={startT.angle}
          kind={cfg.startHead ?? 'none'}
          color={color}
          strokeWidth={strokeWidth}
          headSize={headSize}
        />
      ) : null}
      {end ? (
        <ArrowHeadMark
          x={end.x * w}
          y={end.y * h}
          angle={endT.angle}
          kind={cfg.endHead ?? 'arrow'}
          color={color}
          strokeWidth={strokeWidth}
          headSize={headSize}
        />
      ) : null}
      {interactive
        ? points.map((p, i) => (
            <circle
              key={i}
              className="nodrag nopan"
              cx={p.x * w}
              cy={p.y * h}
              r={6}
              fill={i === 0 || i === points.length - 1 ? 'var(--background)' : 'var(--background)'}
              stroke="var(--ring)"
              strokeWidth={2}
              style={{ cursor: 'grab', pointerEvents: 'all' }}
              onPointerDown={onHandleDown(i)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            />
          ))
        : null}
    </svg>
  )
}

export const ArrowNoteNode = memo(function ArrowNoteNode({ data, selected, width, height }: EditorNodeProps) {
  const cfg = normalizeArrowConfig(data.config)
  const w = width ?? cfg.width ?? 200
  const h = height ?? cfg.height ?? 120

  const onPointsChange = useCallback(
    (points: EditorArrowPoint[]) => {
      data.onEditorChange?.({
        points,
        strokeWidth: cfg.strokeWidth,
        headSize: cfg.headSize,
        dash: cfg.dash,
        startHead: cfg.startHead,
        endHead: cfg.endHead,
        color: cfg.color,
        // Drop legacy fields once the curve is edited.
        rotation: undefined,
        direction: undefined,
      })
    },
    [data, cfg.strokeWidth, cfg.headSize, cfg.dash, cfg.startHead, cfg.endHead, cfg.color],
  )

  return (
    <div className={`relative h-full w-full ${selected ? 'rounded ring-2 ring-ring/40' : ''}`}>
      <NodeResizer
        minWidth={64}
        minHeight={48}
        isVisible={Boolean(selected)}
        onResize={(_, p) => persistSize(data, p.width, p.height)}
        onResizeEnd={(_, p) => persistSize(data, p.width, p.height)}
      />
      <div className="h-full w-full">
        <ArrowCurveGraphic
          config={data.config}
          width={w}
          height={h}
          interactive={Boolean(selected)}
          onPointsChange={onPointsChange}
        />
      </div>
    </div>
  )
})

export const GroupNode = memo(function GroupNode({ data, selected }: EditorNodeProps) {
  const cfg = data.config as EditorGroupConfig
  const locked = cfg.locked === true
  const color = cfg.color ?? DEFAULT_GROUP
  const title = cfg.title ?? 'Group'

  return (
    <div
      className={`relative h-full w-full rounded-lg border-2 border-dashed ${
        selected ? 'ring-2 ring-ring/40' : ''
      }`}
      style={{
        backgroundColor: color,
        borderColor: GROUP_BORDER,
        minWidth: 120,
        minHeight: 80,
      }}
    >
      <div className="flex items-center gap-1 border-b border-dashed px-2 py-1" style={{ borderColor: GROUP_BORDER }}>
        <input
          className="nodrag nopan min-w-0 flex-1 bg-transparent text-[11px] font-medium text-foreground/80 outline-none"
          value={title}
          disabled={locked}
          onChange={(e) => data.onEditorChange?.({ title: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="nodrag nopan rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={locked ? 'Unlock group' : 'Lock group'}
          onClick={() => data.onEditorChange?.({ locked: !locked })}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </button>
      </div>
      <NodeResizer
        minWidth={120}
        minHeight={80}
        isVisible={Boolean(selected) && !locked}
        onResizeEnd={(_, p) => persistSize(data, p.width, p.height)}
      />
      <Handle type="target" position={Position.Top} className="!size-0 !opacity-0" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="!size-0 !opacity-0" isConnectable={false} />
    </div>
  )
})

export const editorNodeTypes = {
  sticky: StickyNoteNode,
  arrow: ArrowNoteNode,
  group: GroupNode,
}

export function editorRfType(specType: string): 'sticky' | 'arrow' | 'group' | 'flow' {
  if (specType === 'editor.sticky') return 'sticky'
  if (specType === 'editor.arrow') return 'arrow'
  if (specType === 'editor.group') return 'group'
  return 'flow'
}
