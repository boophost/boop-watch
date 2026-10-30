// Smoke test for src/lib/runTimeline.ts on prod's sourcing graphs plus a few
// synthetic runs. Run: npx tsx scripts/verify-run-timeline.mjs
import assert from 'node:assert/strict'
import { loadSystemMapFixture } from './fixtures/system-map-fixture.mjs'

const { buildSystemModel } = await import('../src/lib/systemMap.ts')
const { buildTimeline, runTrigger, runHighlights, SLOT_MS } = await import('../src/lib/runTimeline.ts')

const { flows, schedules } = loadSystemMapFixture()
const model = buildSystemModel(flows, schedules)
const now = Date.parse('2026-10-30T12:00:00Z')
const iso = (t) => new Date(t).toISOString()
const H = 3_600_000
const sched = schedules.map((s) => ({ ...s, next_run: s.enabled ? iso(now + 5 * 60_000) : null }))
const run = (id, flow, startOffset, ms, extra = {}) => ({
  id, flow_id: flow, flow_name: '', dry_run: false, ok: true, error: null,
  started_at: iso(now + startOffset), duration_ms: ms, activity: [], ...extra,
})
const runs = [
  run(1, 29, -2 * H, 4000, { activity: [{ node: 'Trigger', type: 'trigger.start', status: 'ok', notes: ['fired "chase-wants" (1)'] }, { node: 'Send to qBittorrent', type: 'sink.qbittorrent', status: 'ok', notes: ['sent 2 magnet(s) to qBittorrent'] }] }),
  run(2, 4, -2 * H + 2000, 90_000),
  run(3, 31, -1 * H, 3000, { ok: false, error: 'boom', activity: [{ node: 'Import', type: 'sink.library-import', status: 'error', notes: [], error: 'disk full' }] }),
  run(4, 29, -10 * H, 3000), // outside a 6 h window
  run(5, 26, -1 * H, 1000), // a component: no row of its own
]
const tl = buildTimeline({
  model, schedules: sched, runs,
  running: new Map([[39, { startedAt: iso(now - 30_000), node: 'Torrent search', dryRun: false }]]),
  queued: [{ id: 7, flowId: 29, flowName: 'Chase wants', trigger: '"chase-wants"', items: 0, dryRun: false, queuedAt: iso(now), coalesced: 2 }],
  now, pastMs: 6 * H, futureMs: 3 * H,
})

const titles = tl.rows.map((r) => r.title)
assert.ok(titles.indexOf('Chase wants') < titles.indexOf('TV & movie sourcing'), 'anime lane before TV lane, like the map')
assert.ok(!titles.includes('Trim audio tracks'), 'components have no row')
assert.deepEqual(tl.rows.find((r) => r.title === 'Unstick sourcing').cadences, ['every 15 m · off'])

const of = (flowId, kind) => tl.marks.filter((m) => m.flowId === flowId && m.kind === kind)
assert.equal(of(29, 'run').length, 1, 'run outside the window dropped')
assert.equal(of(31, 'run')[0].ok, false)
assert.equal(of(39, 'running').length, 1)
assert.equal(of(39, 'running')[0].t1, now, 'running bar grows to now')
assert.equal(of(29, 'queued')[0].coalesced, 2)
// Chase every 15 m from now+5m to now+3h -> 12 ticks; Unstick's schedule is off -> none.
assert.equal(of(29, 'scheduled').length, 12)
assert.equal(of(32, 'scheduled').length, 0, 'disabled schedule projects nothing')
assert.equal(of(30, 'scheduled').length, 1, '3-hourly TV import: one fire in the next 3 h')

// Overlapping runs merge into one busy span on the lock row.
const merged = tl.busy.find(([a]) => a === now - 2 * H)
assert.ok(merged && merged[1] === now - 2 * H + 2000 + 90_000, 'Chase + Library import overlap -> one span')
const slot = tl.slots.find((s) => s.t0 === Math.floor((now - 2 * H) / SLOT_MS) * SLOT_MS)
assert.equal(slot.count, 2, 'two runs started in that slot')
assert.ok(tl.slots.filter((s) => s.future).some((s) => s.count > 0), 'future slots count scheduled fires')

assert.equal(runTrigger(runs[0]), 'fired "chase-wants" (1)')
assert.deepEqual(runHighlights(runs[0]), ['Send to qBittorrent: sent 2 magnet(s) to qBittorrent'])
assert.deepEqual(runHighlights(runs[2]), ['Import: disk full'], 'errors first')

console.log(`verify-run-timeline: ok (${tl.rows.length} rows, ${tl.marks.length} marks)`)
