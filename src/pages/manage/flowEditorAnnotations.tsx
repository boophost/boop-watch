import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { Lock, Unlock } from 'lucide-react'
import type { EditorArrowConfig, EditorGroupConfig, EditorStickyConfig } from '@/lib/flowEditorMeta'

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

export const StickyNoteNode = memo(function StickyNoteNode({ data, selected }: EditorNodeProps) {
  const cfg = data.config as EditorStickyConfig
  const color = cfg.color ?? DEFAULT_STICKY
  const text = cfg.text ?? ''
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
      className={`relative rounded-sm shadow-md ${selected ? 'ring-2 ring-ring/50' : ''}`}
      style={{
        width: cfg.width ?? 180,
        height: cfg.height ?? 120,
        backgroundColor: color,
        color: '#422006',
      }}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        minWidth={100}
        minHeight={72}
        isVisible={Boolean(selected) && !editing}
        onResizeEnd={(_, p) => persistSize(data, p.width, p.height)}
      />
      {editing ? (
        <textarea
          ref={textareaRef}
          className="nodrag nopan nowheel size-full resize-none bg-transparent px-2.5 py-2 text-xs leading-snug outline-none placeholder:text-amber-900/40"
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
        <div className="pointer-events-none size-full overflow-hidden px-2.5 py-2 text-xs leading-snug whitespace-pre-wrap">
          {text || <span className="text-amber-900/40">Note…</span>}
        </div>
      )}
      <span className="pointer-events-none absolute bottom-0 right-0 size-3 bg-gradient-to-tl from-amber-900/15 to-transparent" />
    </div>
  )
})

function ArrowSvg({ direction, color }: { direction: EditorArrowConfig['direction']; color: string }) {
  const d = direction ?? 'right'
  if (d === 'left') {
    return (
      <svg className="size-full" viewBox="0 0 100 24" preserveAspectRatio="none">
        <line x1="88" y1="12" x2="12" y2="12" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polygon points="12,12 24,4 24,20" fill={color} />
      </svg>
    )
  }
  if (d === 'up') {
    return (
      <svg className="size-full" viewBox="0 0 24 100" preserveAspectRatio="none">
        <line x1="12" y1="88" x2="12" y2="12" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polygon points="12,12 4,24 20,24" fill={color} />
      </svg>
    )
  }
  if (d === 'down') {
    return (
      <svg className="size-full" viewBox="0 0 24 100" preserveAspectRatio="none">
        <line x1="12" y1="12" x2="12" y2="88" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polygon points="12,88 4,76 20,76" fill={color} />
      </svg>
    )
  }
  return (
    <svg className="size-full" viewBox="0 0 100 24" preserveAspectRatio="none">
      <line x1="12" y1="12" x2="88" y2="12" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polygon points="88,12 76,4 76,20" fill={color} />
    </svg>
  )
}

export const ArrowNoteNode = memo(function ArrowNoteNode({ data, selected }: EditorNodeProps) {
  const cfg = data.config as EditorArrowConfig
  const color = cfg.color ?? 'var(--muted-foreground)'
  const direction = cfg.direction ?? 'right'
  const isVertical = direction === 'up' || direction === 'down'
  const w = cfg.width ?? (isVertical ? 48 : 160)
  const h = cfg.height ?? (isVertical ? 160 : 48)
  const labelH = cfg.text !== undefined && cfg.text !== '' ? 20 : cfg.text === '' ? 20 : 0

  return (
    <div
      className={`relative ${selected ? 'rounded ring-2 ring-ring/50' : ''}`}
      style={{ width: w, height: h + labelH }}
    >
      <NodeResizer
        minWidth={isVertical ? 32 : 80}
        minHeight={isVertical ? 80 : 32}
        isVisible={Boolean(selected)}
        onResizeEnd={(_, p) => persistSize(data, p.width, p.height - labelH)}
      />
      <div style={{ width: w, height: h }}>
        <ArrowSvg direction={direction} color={color} />
      </div>
      {cfg.text !== undefined ? (
        <input
          className="nodrag nopan mt-0.5 w-full bg-transparent text-center text-[10px] text-muted-foreground outline-none"
          value={cfg.text}
          placeholder="Label…"
          onChange={(e) => data.onEditorChange?.({ text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <button
          type="button"
          className="nodrag nopan mt-0.5 w-full text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
          onClick={() => data.onEditorChange?.({ text: '' })}
          onPointerDown={(e) => e.stopPropagation()}
        >
          + label
        </button>
      )}
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
