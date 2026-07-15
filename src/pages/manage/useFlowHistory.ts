// Snapshot stack for the flow editor canvas (nodes + edges). Take a snapshot
// *before* a mutating action; undo/redo swap the current graph with the stack.
// Intermediate drag ticks are skipped by snapshotting on drag-start only.

import { useCallback, useRef, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'

export interface GraphSnapshot<N extends Node, E extends Edge> {
  nodes: N[]
  edges: E[]
}

const MAX_HISTORY = 75

/** Drop ephemeral editor glue so history doesn't retain run paint / callbacks. */
function sanitizeNode<N extends Node>(n: N): N {
  const data = { ...(n.data as Record<string, unknown>) }
  delete data.report
  delete data.running
  delete data.onEditorChange
  delete data.onRunTrigger
  delete data.runDisabled
  delete data.onNoteChange
  return { ...n, selected: false, data } as N
}

function cloneGraph<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
): GraphSnapshot<N, E> {
  // JSON round-trip: history must not retain callbacks or run paint, and the
  // graph shape is plain data after sanitizeNode.
  return {
    nodes: JSON.parse(JSON.stringify(nodes.map((n) => sanitizeNode(n)))) as N[],
    edges: JSON.parse(
      JSON.stringify(edges.map((e) => ({ ...e, selected: false }))),
    ) as E[],
  }
}

export function useFlowHistory<N extends Node, E extends Edge>() {
  const past = useRef<GraphSnapshot<N, E>[]>([])
  const future = useRef<GraphSnapshot<N, E>[]>([])
  const applying = useRef(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const syncFlags = useCallback(() => {
    setCanUndo(past.current.length > 0)
    setCanRedo(future.current.length > 0)
  }, [])

  const clear = useCallback(() => {
    past.current = []
    future.current = []
    syncFlags()
  }, [syncFlags])

  /** Record the current graph so the next mutation can be undone. */
  const takeSnapshot = useCallback(
    (nodes: N[], edges: E[]) => {
      if (applying.current) return
      past.current.push(cloneGraph(nodes, edges))
      if (past.current.length > MAX_HISTORY) past.current.shift()
      future.current = []
      syncFlags()
    },
    [syncFlags],
  )

  const undo = useCallback(
    (
      nodes: N[],
      edges: E[],
      restore: (snap: GraphSnapshot<N, E>) => void,
    ): boolean => {
      const snap = past.current.pop()
      if (!snap) return false
      future.current.push(cloneGraph(nodes, edges))
      applying.current = true
      restore(snap)
      syncFlags()
      queueMicrotask(() => {
        applying.current = false
      })
      return true
    },
    [syncFlags],
  )

  const redo = useCallback(
    (
      nodes: N[],
      edges: E[],
      restore: (snap: GraphSnapshot<N, E>) => void,
    ): boolean => {
      const snap = future.current.pop()
      if (!snap) return false
      past.current.push(cloneGraph(nodes, edges))
      applying.current = true
      restore(snap)
      syncFlags()
      queueMicrotask(() => {
        applying.current = false
      })
      return true
    },
    [syncFlags],
  )

  return {
    takeSnapshot,
    undo,
    redo,
    clear,
    canUndo,
    canRedo,
    isApplying: () => applying.current,
  }
}
