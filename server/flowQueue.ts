// The flow lock plus a coalescing run queue in front of it. One flow runs at a
// time (flows hit rate-limited upstreams — Jikan, TsukiHime — and a second
// concurrent run is always a mistake); automated fires that find the lock taken
// wait here instead of being dropped, and run in order once it frees.
//
// Deliberately free of DB / flow imports: callers hand in a `run` closure, so
// the queue is testable on its own (scripts/verify-flow-queue.mjs).
//
// Who queues and who doesn't:
// - Schedules, named triggers, chained `trigger.fire` publishes and event
//   watchers go through `enqueueRuns`.
// - Interactive callers (the flow editor's run, the per-series re-search, a
//   legacy schedule's "Run now") and the scheduler's sourcing reconcile take the
//   lock directly with `acquireFlowLock` and answer "busy" when it's held — see
//   the editor run route in flowRoutes.ts for why they don't queue. Their
//   `releaseFlowLock` kicks the queue so nothing waits on the next tick.

import { emitActivity } from './runEvents.js'

/** A request for one flow run, handed to `enqueueRuns`. */
export interface RunRequest {
  /** Coalescing key, or null for "never merge" — build it with `coalesceKey`. */
  key: string | null
  flowId: number | null
  flowName: string
  /** Human label of what fired it: `"chase-wants"`, `qbit-complete`, `schedule #3`. */
  trigger: string
  /** Items the run carries (0 for a schedule / item-less fire). */
  items: number
  dryRun: boolean
  /** Runs the flow. Called with the lock held; must not throw (errors are logged). */
  run: () => Promise<void>
}

/** A pending entry as shown by GET /api/flows/queue and the Activity feed. */
export interface QueuedRunView {
  id: number
  flowId: number | null
  flowName: string
  trigger: string
  items: number
  dryRun: boolean
  queuedAt: string
  /** Further identical fires merged into this entry while it waited. */
  coalesced: number
}

interface Entry extends QueuedRunView {
  key: string | null
  run: () => Promise<void>
  waiters: (() => void)[]
}

export interface EnqueueResult {
  /** False when the queue bound refused the batch; nothing was queued. */
  accepted: boolean
  /** New pending entries created. */
  queued: number
  /** Requests merged into an entry that was already pending. */
  coalesced: number
  /** Resolves once every requested run has finished (immediately if refused). */
  done: Promise<void>
}

// Coalescing rule — at most one *pending* entry per (flow id + trigger event
// identity + dryRun), and only for runs that carry no items:
//
// - An item-less run (a schedule tick, the air-date sweep's `chase-wants`, a
//   `trigger.fire` with nothing on its input) is a "go look at the world now"
//   request. Twelve of them waiting behind a long import all mean the same
//   thing, and one run after the import sees everything the twelve would have.
// - A run carrying items (event watchers, the retrigger route, a `fire` node
//   fed items) never merges. Dropping the second payload loses those items;
//   concatenating them changes what the flow sees (a release flow is built to
//   take one airing per run). Each keeps its own entry.
// - Only *pending* entries absorb fires. One that has started was planned
//   against an older view of the world, so a fire arriving mid-run queues a
//   fresh entry: at most one running + one pending per key.
// - dryRun is part of the key, so a dry schedule never folds into a live one
//   (or the reverse) — each entry keeps the flag it was fired with.
export function coalesceKey(
  flowId: number | null,
  event: string,
  dryRun: boolean,
  items: number,
): string | null {
  if (items > 0) return null
  return `${flowId ?? '-'}|${event}|${dryRun ? 'dry' : 'live'}`
}

// Bound on pending entries, so a pathological loop (a fire chain that fans out,
// a watcher re-firing faster than runs complete) can't grow memory without
// limit. Generous: coalescing keeps the steady state to roughly one entry per
// subscribed flow, and prod has a few dozen flows. A batch that doesn't fit is
// refused whole and logged; event watchers see `accepted: false` and retry.
export const MAX_PENDING = 100

let locked = false
let draining = false
let drainKicked = false
let nextId = 1
let dropped = 0
const pending: Entry[] = []
let active: QueuedRunView | null = null

/** Take the flow lock for a run outside the queue. False = a flow is running. */
export function acquireFlowLock(): boolean {
  if (locked) return false
  locked = true
  return true
}

/** Release a lock taken with `acquireFlowLock`, and let queued runs proceed. */
export function releaseFlowLock(): void {
  locked = false
  kickDrain()
}

/**
 * Queue a batch of runs (e.g. every subscriber of one trigger, in order).
 * `front` puts the new entries ahead of everything already pending — used for a
 * run's own `trigger.fire` publishes, so a chain still finishes before
 * unrelated queued work starts (the depth-first order it had before the queue).
 * The batch is all-or-nothing against MAX_PENDING, so a watcher that retries a
 * refused batch can't double-fire the half that got in.
 */
export function enqueueRuns(reqs: RunRequest[], opts: { front?: boolean } = {}): EnqueueResult {
  // Plan first, mutate after the bound check.
  const fresh: Entry[] = []
  const merges: { into: Entry; waiter: Promise<void>; resolve: () => void }[] = []
  const waits: Promise<void>[] = []
  for (const req of reqs) {
    let resolve!: () => void
    const waiter = new Promise<void>((r) => (resolve = r))
    waits.push(waiter)
    const into =
      req.key === null
        ? undefined
        : (pending.find((e) => e.key === req.key) ?? fresh.find((e) => e.key === req.key))
    if (into) {
      merges.push({ into, waiter, resolve })
      continue
    }
    fresh.push({
      id: nextId++,
      key: req.key,
      flowId: req.flowId,
      flowName: req.flowName,
      trigger: req.trigger,
      items: req.items,
      dryRun: req.dryRun,
      queuedAt: new Date().toISOString(),
      coalesced: 0,
      run: req.run,
      waiters: [resolve],
    })
  }
  if (pending.length + fresh.length > MAX_PENDING) {
    dropped += reqs.length
    console.warn(
      `flow queue: full (${pending.length}/${MAX_PENDING} pending) — refused ${reqs.length} run(s): ` +
        reqs.map((r) => `${r.trigger} → ${r.flowName}`).join(', '),
    )
    return { accepted: false, queued: 0, coalesced: 0, done: Promise.resolve() }
  }
  for (const m of merges) {
    m.into.coalesced++
    m.into.waiters.push(m.resolve)
  }
  if (opts.front) pending.unshift(...fresh)
  else pending.push(...fresh)
  if (fresh.length > 0 || merges.length > 0) emitQueue()
  kickDrain()
  return {
    accepted: true,
    queued: fresh.length,
    coalesced: merges.length,
    done: Promise.all(waits).then(() => undefined),
  }
}

/** The queue as it stands: the entry running now (if it came from the queue)
 * plus everything pending, in run order. */
export function flowQueueSnapshot(): {
  busy: boolean
  running: QueuedRunView | null
  pending: QueuedRunView[]
  max: number
  dropped: number
} {
  return { busy: locked, running: active, pending: pending.map(view), max: MAX_PENDING, dropped }
}

function view(e: Entry): QueuedRunView {
  return {
    id: e.id,
    flowId: e.flowId,
    flowName: e.flowName,
    trigger: e.trigger,
    items: e.items,
    dryRun: e.dryRun,
    queuedAt: e.queuedAt,
    coalesced: e.coalesced,
  }
}

function emitQueue(): void {
  emitActivity({ type: 'queue', pending: pending.map(view) })
}

// Deferred so a caller enqueuing several batches in one go (or releasing the
// lock) finishes its synchronous work before the first queued run starts.
function kickDrain(): void {
  if (drainKicked || pending.length === 0) return
  drainKicked = true
  setImmediate(() => {
    drainKicked = false
    void drain()
  })
}

// Run pending entries one at a time while the lock is free. Hands the lock from
// one entry straight to the next (no gap an interactive caller could slip into
// mid-backlog — they'd get "busy" either way). Stops when something outside the
// queue holds the lock; its releaseFlowLock kicks the drain again.
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.length > 0 && !locked) {
      const entry = pending.shift()!
      locked = true
      active = view(entry)
      emitQueue()
      try {
        await entry.run()
      } catch (e) {
        console.error(`flow queue: ${entry.trigger} → ${entry.flowName} threw`, e)
      } finally {
        locked = false
        active = null
      }
      for (const w of entry.waiters) w()
    }
  } finally {
    draining = false
  }
}
