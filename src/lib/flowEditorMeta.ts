// Editor-only flow canvas nodes — keep in sync with server/flowEditorMeta.ts.

export const EDITOR_NODE_TYPES = new Set(['editor.sticky', 'editor.arrow', 'editor.group'])

export function isEditorNode(type: string): boolean {
  return EDITOR_NODE_TYPES.has(type)
}

export type EditorStickyConfig = {
  text?: string
  color?: string
  width?: number
  height?: number
  fontSize?: number
  textAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'center' | 'bottom'
  /** Degrees clockwise. */
  rotation?: number
}

export type ArrowDash = 'solid' | 'dashed' | 'dotted'
export type ArrowHead = 'none' | 'arrow' | 'triangle' | 'open' | 'diamond' | 'dot'

/** Normalized 0–1 coordinates within the arrow node's box. */
export type EditorArrowPoint = { x: number; y: number }

export type EditorArrowConfig = {
  color?: string
  strokeWidth?: number
  /** Arrowhead length in px (independent of stroke thickness). */
  headSize?: number
  dash?: ArrowDash
  startHead?: ArrowHead
  endHead?: ArrowHead
  /**
   * Bezier control polyline in normalized [0,1] box space.
   * 2 = straight segment; 3 = quadratic; 4+ = chained cubics through the points.
   */
  points?: EditorArrowPoint[]
  width?: number
  height?: number
  /** @deprecated Migrated into `points` on load — right=0, down=90, left=180, up=270. */
  direction?: 'right' | 'left' | 'up' | 'down'
  /** @deprecated Migrated into `points` on load. */
  rotation?: number
}

export type EditorGroupConfig = {
  title?: string
  color?: string
  locked?: boolean
  width?: number
  height?: number
  /** Persisted parent link — mapped to React Flow parentId on load. */
  groupId?: string
}

export function normalizeRotation(deg: number): number {
  const n = deg % 360
  return n < 0 ? n + 360 : n
}

export function editorRotationFromConfig(specType: string, config: Record<string, unknown>): number {
  if (typeof config.rotation === 'number') return normalizeRotation(config.rotation)
  if (specType === 'editor.arrow') {
    const d = config.direction ?? 'right'
    if (d === 'down') return 90
    if (d === 'left') return 180
    if (d === 'up') return 270
  }
  return 0
}

export const DEFAULT_ARROW_POINTS: EditorArrowPoint[] = [
  { x: 0.08, y: 0.5 },
  { x: 0.5, y: 0.22 },
  { x: 0.92, y: 0.5 },
]

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

function rotateAroundCenter(p: EditorArrowPoint, deg: number): EditorArrowPoint {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const x = p.x - 0.5
  const y = p.y - 0.5
  return {
    x: clamp01(x * cos - y * sin + 0.5),
    y: clamp01(x * sin + y * cos + 0.5),
  }
}

/** Normalize legacy straight arrows (rotation/direction) into editable curve points. */
export function normalizeArrowConfig(config: Record<string, unknown>): EditorArrowConfig {
  const cfg = config as EditorArrowConfig
  const raw = Array.isArray(cfg.points) ? cfg.points : null
  let points: EditorArrowPoint[] | null = null
  if (raw && raw.length >= 2) {
    points = raw.map((p) => ({
      x: clamp01(typeof p?.x === 'number' ? p.x : 0.5),
      y: clamp01(typeof p?.y === 'number' ? p.y : 0.5),
    }))
  }

  if (!points) {
    const rot = editorRotationFromConfig('editor.arrow', config)
    // Straight-ish baseline → bend upward so new arrows look like curves.
    const base: EditorArrowPoint[] =
      rot === 0
        ? [...DEFAULT_ARROW_POINTS]
        : [
            { x: 0.08, y: 0.5 },
            { x: 0.5, y: 0.5 },
            { x: 0.92, y: 0.5 },
          ].map((p) => rotateAroundCenter(p, rot))
    points = base
  }

  const strokeWidth =
    typeof cfg.strokeWidth === 'number' && Number.isFinite(cfg.strokeWidth)
      ? Math.min(16, Math.max(1, cfg.strokeWidth))
      : 2
  const headSize =
    typeof cfg.headSize === 'number' && Number.isFinite(cfg.headSize)
      ? Math.min(48, Math.max(4, cfg.headSize))
      : 10

  return {
    color: typeof cfg.color === 'string' && cfg.color ? cfg.color : '#a1a1aa',
    strokeWidth,
    headSize,
    dash: cfg.dash === 'dashed' || cfg.dash === 'dotted' ? cfg.dash : 'solid',
    startHead: isArrowHead(cfg.startHead) ? cfg.startHead : 'none',
    endHead: isArrowHead(cfg.endHead) ? cfg.endHead : 'arrow',
    points,
    width: typeof cfg.width === 'number' ? cfg.width : undefined,
    height: typeof cfg.height === 'number' ? cfg.height : undefined,
  }
}

function isArrowHead(v: unknown): v is ArrowHead {
  return v === 'none' || v === 'arrow' || v === 'triangle' || v === 'open' || v === 'diamond' || v === 'dot'
}

/** Rotate all normalized arrow points around the box center. */
export function rotateArrowPoints(points: EditorArrowPoint[], deltaDeg: number): EditorArrowPoint[] {
  return points.map((p) => rotateAroundCenter(p, deltaDeg))
}

export function arrowDashArray(dash: ArrowDash | undefined, strokeWidth: number): string | undefined {
  if (dash === 'dashed') return `${Math.max(6, strokeWidth * 3)} ${Math.max(4, strokeWidth * 2)}`
  if (dash === 'dotted') return `${Math.max(1.5, strokeWidth * 0.8)} ${Math.max(3, strokeWidth * 1.6)}`
  return undefined
}

/** Build an SVG path `d` for normalized points in a pixel box of size w×h. */
export function arrowPathD(points: EditorArrowPoint[], w: number, h: number): string {
  if (points.length === 0) return ''
  const px = (p: EditorArrowPoint) => ({ x: p.x * w, y: p.y * h })
  const pts = points.map(px)
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`
  if (pts.length === 3) {
    return `M ${pts[0].x} ${pts[0].y} Q ${pts[1].x} ${pts[1].y} ${pts[2].x} ${pts[2].y}`
  }
  // 4+: smooth cubic chain through midpoints (Catmull-Rom-ish shortcuts).
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i += 1) {
    const curr = pts[i]
    const next = pts[i + 1]
    if (i + 1 === pts.length - 1) {
      d += ` Q ${curr.x} ${curr.y} ${next.x} ${next.y}`
    } else {
      const midX = (curr.x + next.x) / 2
      const midY = (curr.y + next.y) / 2
      d += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`
    }
  }
  return d
}

/**
 * Outward unit tangent at an endpoint in *pixel* space.
 * Pass the box size so non-square arrows get the visual angle (normalized
 * [0,1] slopes ≠ pixel slopes when width ≠ height).
 */
export function arrowEndpointTangent(
  points: EditorArrowPoint[],
  which: 'start' | 'end',
  width = 1,
  height = 1,
): { x: number; y: number; angle: number } {
  if (points.length < 2) return { x: 1, y: 0, angle: 0 }
  const a = which === 'start' ? points[0] : points[points.length - 2]
  const b = which === 'start' ? points[1] : points[points.length - 1]
  let dx = (b.x - a.x) * Math.max(1, width)
  let dy = (b.y - a.y) * Math.max(1, height)
  if (which === 'start') {
    dx = -dx
    dy = -dy
  }
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len
  return { x: dx, y: dy, angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}

/** How far to pull the stroke back from a filled tip so it meets the head cleanly. */
export function arrowHeadInset(kind: ArrowHead | undefined, headSize: number): number {
  if (!kind || kind === 'none' || kind === 'open') return 0
  if (kind === 'dot') return Math.max(2, headSize * 0.45)
  return Math.max(4, headSize * 0.85)
}
