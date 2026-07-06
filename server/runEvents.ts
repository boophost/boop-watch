// A process-wide event bus for flow-run lifecycle, so the Activity feed can watch
// runs happen live. Every run — editor, scheduler, or MCP — goes through
// runFlowAndRecord (flowRoutes.ts), which emits start → node(-start) → done here.
// The flow lock means at most one run is in flight at a time, so a subscriber
// only ever tracks a single in-progress run.

import { EventEmitter } from 'node:events'
import type { FlowRunRow } from './flowsDb.js'

export type ActivityEvent =
  | {
      type: 'start'
      runToken: string
      flowId: number | null
      flowName: string
      dryRun: boolean
      startedAt: string
    }
  | { type: 'node-start'; runToken: string; nodeId: string }
  | {
      type: 'node'
      runToken: string
      nodeId: string
      node: string // human label
      nodeType: string
      status: 'ok' | 'error' | 'skipped'
      notes: string[]
      error?: string
    }
  | { type: 'done'; runToken: string; run: FlowRunRow }
  | { type: 'aborted'; runToken: string; error: string }

const emitter = new EventEmitter()
emitter.setMaxListeners(0) // one listener per open Activity tab; don't warn
const CHANNEL = 'activity'

export function emitActivity(event: ActivityEvent): void {
  emitter.emit(CHANNEL, event)
}

// Subscribe to the bus; returns an unsubscribe function.
export function subscribeActivity(cb: (event: ActivityEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
