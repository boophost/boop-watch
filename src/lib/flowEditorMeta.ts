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
}

export type EditorArrowConfig = {
  text?: string
  color?: string
  direction?: 'right' | 'left' | 'up' | 'down'
  width?: number
  height?: number
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
