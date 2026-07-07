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

export type EditorArrowConfig = {
  color?: string
  /** @deprecated Migrated to `rotation` on load — right=0, down=90, left=180, up=270. */
  direction?: 'right' | 'left' | 'up' | 'down'
  width?: number
  height?: number
  /** Degrees clockwise. */
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
