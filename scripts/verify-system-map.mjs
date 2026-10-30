// Smoke test for src/lib/systemMap.ts against prod's sourcing graphs (Oct 30,
// 2026 — only the node types/config the model reads, padded back to each
// flow's real node count). Run: npx tsx scripts/verify-system-map.mjs
import assert from 'node:assert/strict'
import { loadSystemMapFixture } from './fixtures/system-map-fixture.mjs'

const { buildSystemModel, layoutSystemModel } = await import('../src/lib/systemMap.ts')
const { flows, schedules } = loadSystemMapFixture()
const model = buildSystemModel(flows, schedules)
const box = (title) => model.boxes.find((b) => b.title === title)
const edge = (from, to, label) =>
  model.edges.find((e) => e.from === from && e.to === to && (label === undefined || e.label === label))
const fb = (title) => box(title).id
/** The edge between two boxes in either direction (reciprocal pairs are merged). */
const pair = (a, b) => model.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))

// Lanes and stages come from node types, not names.
assert.equal(box('Chase wants').lane, 'anime')
assert.equal(box('Chase wants').column, 'acquire')
assert.equal(box('Show added').column, 'intent')
assert.equal(box('Release aired').column, 'intent')
assert.equal(box('Library import').column, 'import')
assert.equal(box('Library import').lane, 'anime')
assert.equal(box('TV import').lane, 'media')
assert.equal(box('Movie import').lane, 'media')
assert.equal(box('TV & movie sourcing').lane, 'media')
assert.equal(box('TV & movie sourcing').column, 'acquire')
assert.deepEqual(box('TV & movie sourcing').lines, ['plans gaps · apibay'], 'providers listed once')
assert.equal(box('Unstick sourcing').tone, 'heal')
assert.equal(box('Unstick sourcing').off, true, 'only trigger is a disabled schedule')
assert.equal(box('Chase wants').off, false)
assert.ok(!model.boxes.some((b) => b.title === 'Trim audio tracks'), 'components are not cards')
assert.deepEqual([...box('Library import').uses].sort(), ['Discord webhook', 'Discord webhook', 'Trim audio tracks'])
assert.deepEqual(model.components.map((c) => c.name).sort(), ['Discord embed', 'Discord message', 'Discord webhook', 'Trim audio tracks'])

// Links between flows.
assert.ok(edge(fb('Show added'), fb('Chase wants'), 'fires'))
assert.ok(edge(fb('Release aired'), fb('Chase wants'), 'fires'))
assert.ok(edge(fb('Show added'), 'wants', 'upsert'))
const chaseWants = pair('wants', fb('Chase wants'))
assert.ok(chaseWants.both && /open/.test(chaseWants.label) && /miss/.test(chaseWants.label), 'Chase <-> wants is one double-headed edge')
assert.ok(/reopen/.test(pair(fb('Unstick sourcing'), 'wants').label))
assert.ok(model.edges.some((e) => e.from === fb('Chase wants') && e.to === 'qbit' && e.toPort === 'anime' && e.label === 'queue'))
assert.ok(model.edges.some((e) => e.from === fb('TV & movie sourcing') && e.to === 'qbit' && e.toPort === 'tv'))
assert.ok(model.edges.some((e) => e.from === 'qbit' && e.fromPort === 'tv' && e.to === fb('TV import') && e.label === 'done'))
const libQbit = pair(fb('Library import'), 'qbit')
assert.ok(libQbit.both && /upgrade/.test(libQbit.label) && /done/.test(libQbit.label), 'done + upgrade folded into one edge')
assert.equal(libQbit.tone, 'normal', 'one heal half does not paint the pair orange')
assert.ok(edge(fb('Library import'), 'jellyfin'))
assert.ok(!edge(fb('Library import'), 'wants'), 'fulfil is stated on the store, not drawn across the lane')
assert.ok(edge('jellyfin', 'portal'))
assert.deepEqual(box('Unstick sourcing').schedules, [{ label: 'every 15 m', off: true, dry: false }], 'disabled schedule shown on the card')
assert.deepEqual(box('Chase wants').schedules, [{ label: 'every 15 m', off: false, dry: false }], 'flow-id schedule matched')
assert.ok(model.edges.filter((e) => e.from === fb('Unstick sourcing') || e.to === fb('Unstick sourcing')).every((e) => e.tone === 'soft' && e.dashed), 'switched-off flow drawn muted')
assert.equal(box('Image sourcing').lane, 'other', 'catalog enrichment is not anime sourcing')
assert.ok(!model.boxes.some((b) => b.kind === 'timer'), 'schedules are badges, not boxes')
assert.ok(model.edges.some((e) => e.from === 'event:new-item:media' && e.to === fb('TV & movie sourcing')))
assert.ok(edge('job:sweep', fb('Chase wants'), 'fires'))
assert.ok(model.edges.some((e) => e.both && [e.from, e.to].includes('job:reconcile') && (e.toPort ?? e.fromPort) === 'anime'))
assert.ok(!model.edges.some((e) => e.label === 'held'), 'planner reads are implied, not drawn')
assert.ok(model.edges.filter((e) => [e.from, e.to].includes(fb('Unstick sourcing'))).every((e) => e.muted), 'switched-off flow edges are muted')
assert.deepEqual(model.boxes.find((b) => b.id === 'qbit').ports, ['anime', 'tv', 'movies'])

// Layout: every box inside the canvas, no two boxes overlapping, every edge routed.
const L = layoutSystemModel(model)
assert.equal(L.boxes.length, model.boxes.length, 'every box placed')
for (const b of L.boxes)
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= L.width && b.y + b.h <= L.height, `${b.id} inside canvas`)
for (let i = 0; i < L.boxes.length; i++)
  for (let j = i + 1; j < L.boxes.length; j++) {
    const a = L.boxes[i]
    const b = L.boxes[j]
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`)
  }
assert.equal(L.edges.length, model.edges.length, 'every edge routed')
// No line runs through a card that isn't one of its ends.
const segs = (d) => {
  const out = []
  let x = 0, y = 0
  for (const [, op, a, b] of d.matchAll(/([MHV])([\d.-]+)(?: ([\d.-]+))?/g)) {
    const n = Number(a)
    if (op === 'M') { x = n; y = Number(b); continue }
    const nx = op === 'H' ? n : x, ny = op === 'V' ? n : y
    out.push({ x1: Math.min(x, nx), x2: Math.max(x, nx), y1: Math.min(y, ny), y2: Math.max(y, ny) })
    x = nx; y = ny
  }
  return out
}
for (const e of L.edges)
  for (const s of segs(e.d))
    for (const b of L.boxes) {
      if (b.id === e.from || b.id === e.to) continue
      const cuts = s.x1 < b.x + b.w - 1 && s.x2 > b.x + 1 && s.y1 < b.y + b.h - 1 && s.y2 > b.y + 1
      assert.ok(!cuts, `${e.id} runs through ${b.id}`)
    }
const atRest = L.edges.filter((e) => e.labelAtRest)
assert.ok(atRest.length >= L.edges.filter((e) => e.label).length / 2, 'most labels fit at rest')
for (const e of L.edges) assert.match(e.d, /^M[\d.-]+ [\d.-]+( [HV][\d.-]+)+$/, `${e.id} path`)
assert.deepEqual(L.lanes.map((l) => l.id), ['anime', 'media', 'other'])

console.log(`verify-system-map: ok (${model.boxes.length} boxes, ${model.edges.length} edges, ${L.width}x${Math.round(L.height)})`)
