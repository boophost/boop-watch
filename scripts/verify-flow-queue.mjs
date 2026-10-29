// Smoke test for the flow run queue (server/flowQueue.ts) and the dispatch that
// feeds it (fireTrigger / fireEvent in server/flowRoutes.ts): busy fires queue
// instead of dropping, identical item-less fires coalesce, dryRun survives the
// queue, the bound holds, and event dispatch is neither lost nor doubled.
// Run: npx tsx scripts/verify-flow-queue.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-queue-'))
process.env.DATA_DIR = tmp
process.env.QBIT_URL = ''
process.env.QBIT_USERNAME = ''
process.env.QBIT_PASSWORD = ''
process.env.LIBRARY_DIR = ''
process.env.JELLYFIN_API_KEY = ''
process.env.POSTHOG_KEY = ''

const q = await import('../server/flowQueue.ts')
const { subscribeActivity } = await import('../server/runEvents.ts')
const flowsDb = await import('../server/flowsDb.ts')
const { fireTrigger, fireEvent, acquireFlowLock, releaseFlowLock } = await import('../server/flowRoutes.ts')

const { enqueueRuns, coalesceKey, flowQueueSnapshot, MAX_PENDING } = q
const turn = () => new Promise((r) => setImmediate(r))
async function idle() {
  for (let i = 0; i < 2000; i++) {
    const s = flowQueueSnapshot()
    if (!s.busy && s.pending.length === 0) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('queue never went idle')
}
const req = (over) => ({
  key: null, flowId: 1, flowName: 'f', trigger: 't', items: 0, dryRun: false,
  run: async () => {}, ...over,
})

const events = []
subscribeActivity((ev) => events.push(ev))

// ---- 1. Queue module ------------------------------------------------------

// A fire during a busy run is queued, not dropped, and runs once the lock frees.
{
  const ran = []
  assert.equal(acquireFlowLock(), true)
  const r = enqueueRuns([req({ key: 'k1', run: async () => ran.push('A') })])
  assert.equal(r.accepted, true)
  await turn()
  assert.deepEqual(ran, [], 'does not run while the lock is held')
  assert.equal(flowQueueSnapshot().pending.length, 1)
  assert.ok(events.some((e) => e.type === 'queue' && e.pending.length === 1), 'queued is broadcast')
  releaseFlowLock()
  await r.done
  assert.deepEqual(ran, ['A'], 'runs after release')
  await idle()
}

// Twelve identical item-less fires coalesce into one run; every caller's
// promise resolves when that run finishes.
{
  let runs = 0
  acquireFlowLock()
  const key = coalesceKey(7, 'start:chase-wants', false, 0)
  const results = Array.from({ length: 12 }, () => enqueueRuns([req({ key, run: async () => void runs++ })]))
  const s = flowQueueSnapshot()
  assert.equal(s.pending.length, 1)
  assert.equal(s.pending[0].coalesced, 11)
  assert.equal(results[0].queued, 1)
  assert.ok(results.slice(1).every((r) => r.coalesced === 1 && r.queued === 0))
  releaseFlowLock()
  await Promise.all(results.map((r) => r.done))
  assert.equal(runs, 1)
  await idle()
}

// What must NOT coalesce: different dryRun, item-bearing runs, and a fire that
// arrives while an identical run is already in progress.
{
  assert.notEqual(coalesceKey(7, 'start:x', true, 0), coalesceKey(7, 'start:x', false, 0))
  assert.equal(coalesceKey(7, 'qbit-complete', false, 1), null, 'item-bearing runs never merge')

  acquireFlowLock()
  enqueueRuns([req({ key: coalesceKey(7, 'start:x', true, 0) })])
  enqueueRuns([req({ key: coalesceKey(7, 'start:x', false, 0) })])
  enqueueRuns([req({ key: coalesceKey(7, 'start:x', false, 2), items: 2 })])
  enqueueRuns([req({ key: coalesceKey(7, 'start:x', false, 2), items: 2 })])
  assert.equal(flowQueueSnapshot().pending.length, 4)
  releaseFlowLock()
  await idle()

  let release
  const gate = new Promise((r) => (release = r))
  let runs = 0
  const key = coalesceKey(8, 'start:y', false, 0)
  const first = enqueueRuns([req({ key, run: async () => { runs++; await gate } })])
  await turn()
  assert.equal(flowQueueSnapshot().running?.flowId, 1, 'first run is in progress')
  const second = enqueueRuns([req({ key, run: async () => void runs++ })])
  assert.equal(second.queued, 1, 'a fire during the identical run queues a fresh entry')
  release()
  await Promise.all([first.done, second.done])
  assert.equal(runs, 2)
  await idle()
}

// Front insertion (a run's own fires) jumps ahead of pending work, in order.
{
  const order = []
  acquireFlowLock()
  enqueueRuns([req({ run: async () => order.push('later') })])
  enqueueRuns([req({ run: async () => order.push('fire-1') }), req({ run: async () => order.push('fire-2') })], { front: true })
  releaseFlowLock()
  await idle()
  assert.deepEqual(order, ['fire-1', 'fire-2', 'later'])
}

// The bound: MAX_PENDING entries max, and a batch that doesn't fit is refused
// whole (so a retried event can't double-fire the half that got in).
{
  acquireFlowLock()
  for (let i = 0; i < MAX_PENDING - 1; i++) assert.equal(enqueueRuns([req({})]).accepted, true)
  const tooBig = enqueueRuns([req({}), req({})])
  assert.equal(tooBig.accepted, false)
  assert.equal(flowQueueSnapshot().pending.length, MAX_PENDING - 1, 'refused batch left nothing behind')
  assert.equal(enqueueRuns([req({})]).accepted, true)
  assert.equal(enqueueRuns([req({})]).accepted, false, 'full')
  // Coalescing into a pending entry still works at the bound (it adds nothing).
  const key = coalesceKey(9, 'start:z', false, 0)
  releaseFlowLock()
  await idle()
  acquireFlowLock()
  enqueueRuns([req({ key })])
  for (let i = 0; i < MAX_PENDING - 1; i++) enqueueRuns([req({})])
  assert.equal(enqueueRuns([req({ key })]).accepted, true, 'merge needs no room')
  assert.ok(flowQueueSnapshot().dropped >= 3)
  releaseFlowLock()
  await idle()
}

// ---- 2. Through fireTrigger / fireEvent with real flows --------------------

function makeFlow(name, nodes, edges = []) {
  const f = flowsDb.createFlow(name, null)
  flowsDb.updateFlow(f.id, {
    graph: {
      nodes: nodes.map((n, i) => ({ position: { x: i * 200, y: 0 }, config: {}, ...n })),
      edges,
    },
  })
  return f.id
}
const sweepId = makeFlow('Sweep', [{ id: 't', type: 'trigger.start', config: { name: 'sweep' } }])
const eventId = makeFlow('On complete', [{ id: 't', type: 'trigger.qbit-complete' }])
const chainA = makeFlow(
  'Chain A',
  [
    { id: 't', type: 'trigger.start', config: { name: 'chain-a' } },
    { id: 'f', type: 'trigger.fire', config: { name: 'chain-b' } },
  ],
  [{ id: 'e1', source: 't', sourceHandle: 'out', target: 'f', targetHandle: 'in' }],
)
const chainB = makeFlow('Chain B', [{ id: 't', type: 'trigger.start', config: { name: 'chain-b' } }])
const runsOf = (id) => flowsDb.listRuns(500).filter((r) => r.flow_id === id)

// A schedule-style fire during a busy run queues; twelve coalesce into one run,
// and the dry-run flag reaches the recorded run.
{
  acquireFlowLock()
  const first = await fireTrigger('sweep', [], 0, true)
  assert.deepEqual(first, { queued: 1, coalesced: 0 })
  for (let i = 0; i < 11; i++) assert.deepEqual(await fireTrigger('sweep', [], 0, true), { queued: 0, coalesced: 1 })
  // A live fire of the same trigger is a different entry.
  assert.deepEqual(await fireTrigger('sweep', [], 0, false), { queued: 1, coalesced: 0 })
  assert.equal(runsOf(sweepId).length, 0, 'nothing ran while busy')
  releaseFlowLock()
  await idle()
  const runs = runsOf(sweepId)
  assert.equal(runs.length, 2, 'one dry + one live run, not thirteen')
  assert.deepEqual(runs.map((r) => r.dry_run).sort(), [false, true])
}

// Event dispatch: fireEvent resolves true only once the subscriber actually ran
// (the watcher advances its watermark on that), each payload runs exactly once,
// and two events with different items never merge.
{
  const before = runsOf(eventId).length
  const outCounts = []
  const unsub = subscribeActivity((ev) => {
    if (ev.type === 'node' && ev.nodeType === 'trigger.qbit-complete') outCounts.push(ev.counts?.out)
  })
  acquireFlowLock()
  let settled = false
  const p1 = fireEvent('qbit-complete', [{ hash: 'h1' }]).then((v) => ((settled = true), v))
  const p2 = fireEvent('qbit-complete', [{ hash: 'h2' }, { hash: 'h3' }])
  await turn()
  await turn()
  assert.equal(settled, false, 'queued is not dispatched — watermark must not advance yet')
  assert.equal(flowQueueSnapshot().pending.length, 2, 'item-bearing events kept apart')
  releaseFlowLock()
  assert.equal(await p1, true)
  assert.equal(await p2, true)
  await idle()
  unsub()
  assert.equal(runsOf(eventId).length - before, 2, 'each event ran once')
  assert.deepEqual(outCounts, [1, 2], 'payloads intact, in order')
}

// A full queue refuses an event outright (false → the watcher retries next
// tick), and nothing of it was queued, so the retry can't double-fire.
{
  acquireFlowLock()
  for (let i = 0; i < MAX_PENDING; i++) enqueueRuns([req({})])
  const before = flowQueueSnapshot().pending.length
  assert.equal(await fireEvent('qbit-complete', [{ hash: 'h4' }]), false)
  assert.equal(flowQueueSnapshot().pending.length, before)
  releaseFlowLock()
  await idle()
}

// A run's own trigger.fire is queued ahead of work that was already pending,
// so the chain completes first (the depth-first order it had before the queue).
{
  acquireFlowLock()
  await fireTrigger('chain-a', [], 0, false)
  await fireTrigger('sweep', [], 0, false)
  releaseFlowLock()
  await idle()
  const recent = flowsDb.listRuns(3).reverse().map((r) => r.flow_id)
  assert.deepEqual(recent, [chainA, chainB, sweepId])
}

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  /* Windows keeps the open SQLite file locked — the temp dir is harmless */
}
console.log('verify-flow-queue: all checks passed')
process.exit(0)
