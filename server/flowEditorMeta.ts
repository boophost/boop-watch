// Editor-only flow canvas nodes (sticky notes, arrows, groups). Persisted in the
// graph JSON for layout/documentation but never executed — validateGraph and
// runFlow filter them out.

export const EDITOR_NODE_TYPES = new Set(['editor.sticky', 'editor.arrow', 'editor.group'])

export function isEditorNode(type: string): boolean {
  return EDITOR_NODE_TYPES.has(type)
}

/** Executable subgraph — strips annotations and any edges touching them. */
export function executableGraph<T extends { nodes: { id: string; type: string }[]; edges: { source: string; target: string }[] }>(
  graph: T,
): T {
  const ids = new Set(graph.nodes.filter((n) => !isEditorNode(n.type)).map((n) => n.id))
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  } as T
}
