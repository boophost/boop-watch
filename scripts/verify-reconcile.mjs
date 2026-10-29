// Smoke test for sourcingReconcile's torrent policy (server/sourcing.ts):
// gone / stalled (young + old) / error / missingFiles / foreign category, plus
// dry-run parity and the claim guard that keeps a second pass (or the old
// "Unstick sourcing" flow) from double-processing a torrent.
// Run: npx tsx scripts/verify-reconcile.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'))
process.env.DATA_DIR = tmp
process.env.LIBRARY_DIR = path.join(tmp, 'library')
process.env.QBIT_URL = 'http://qbit.test'
process.env.QBIT_USERNAME = ''
process.env.QBIT_PASSWORD = ''
process.env.QBIT_CATEGORY = 'anime'
process.env.JELLYFIN_API_KEY = ''
delete process.env.SOURCING_STALL_HOURS // default 24
delete process.env.SOURCING_STALL_DELETE_FILES // default true

const H = (c) => c.repeat(40)
const now = Math.floor(Date.now() / 1000)
const hr = 3600
const t = (hash, state, extra = {}) => ({
  hash, name: `T-${hash.slice(0, 1)}`, state, progress: 0.4, dlspeed: 0, size: 1, num_seeds: 0,
  num_leechs: 0, eta: 8640000, category: 'anime', tags: '', added_on: now - 72 * hr, last_activity: now - hr, ...extra,
})
// g (gone) is deliberately absent from qBittorrent.
let torrents = [
  t(H('a'), 'stalledDL', { last_activity: now - 2 * hr }), // young stall
  t(H('b'), 'stalledDL', { last_activity: now - 30 * hr }), // old stall, two wants
  t(H('c'), 'metaDL', { last_activity: 0, added_on: now - 48 * hr }), // magnet never resolved
  t(H('e'), 'error'),
  t(H('m'), 'missingFiles'),
  t(H('d'), 'downloading', { last_activity: now - 40 * hr }), // not a stall state
  // The other environment's slice of the shared qBittorrent.
  t(H('x'), 'stalledDL', { category: 'anime-dev', last_activity: now - 99 * hr }),
  t(H('y'), 'error', { category: 'anime-dev' }),
  t(H('z'), 'missingFiles', { category: 'anime-dev' }),
]
const deletes = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=x' } })
  if (u.includes('/torrents/info')) return Response.json(torrents)
  if (u.includes('/sync/maindata')) return Response.json({ server_state: { free_space_on_disk: 123 } })
  if (u.endsWith('/torrents/delete')) {
    const p = new URLSearchParams(String(init.body))
    const hashes = p.get('hashes').split('|')
    deletes.push({ hashes: [...hashes].sort(), deleteFiles: p.get('deleteFiles') })
    torrents = torrents.filter((x) => !hashes.includes(x.hash))
    return new Response('')
  }
  throw new Error('unexpected fetch ' + u)
}

const db = await import('../server/db.ts')
const { sourcingReconcile } = await import('../server/sourcing.ts')
db.insertSeries({ mal_id: 1, title: 'Show', synopsis: null, image_url: null, url: null })

const want = (ep, hash, category = 'anime') => {
  const w = db.upsertWant({ mal_id: 1, kind: 'episode', episode: ep, reason: 'test' }).want
  db.recordTorrentQueued({ hash, mal_id: 1, kind: 'episode', episode: ep, category, provider: 'test' })
  db.markWantSourced(w.id, hash)
  return w.id
}
const W = {
  gone: want(1, H('g')),
  young: want(2, H('a')),
  old1: want(3, H('b')),
  old2: want(4, H('b')),
  meta: want(5, H('c')),
  err: want(6, H('e')),
  missing: want(7, H('m')),
  dl: want(8, H('d')),
}
// Ledger rows for the other environment's torrents (no wants: those live in its DB).
for (const c of ['x', 'y', 'z']) db.recordTorrentQueued({ hash: H(c), mal_id: 1, category: 'anime-dev', provider: 'test' })

const wantStatus = (id) => db.getWant(id).status
const ledger = (c) => db.getTorrent(H(c)).status
const snapshot = () => JSON.stringify({
  wants: db.listWants().map((w) => [w.id, w.status]),
  ledger: ['g', 'a', 'b', 'c', 'e', 'm', 'd', 'x', 'y', 'z'].map(ledger),
})

// --- Dry run: full report, no writes, no deletes. ---------------------------
const before = snapshot()
const dry = await sourcingReconcile(true)
assert.equal(snapshot(), before, 'dry run writes nothing')
assert.equal(deletes.length, 0, 'dry run deletes nothing')

// --- Live run. --------------------------------------------------------------
const r = await sourcingReconcile(false)
const { dryRun: _a, ...drySansFlag } = dry
const { dryRun: _b, ...liveSansFlag } = r
assert.deepEqual(drySansFlag, liveSansFlag, 'dry-run report matches the live run')
assert.equal(r.stallHours, 24)

// gone → reopened, ledger failed
assert.equal(r.orphanRowsClosed, 1)
assert.equal(r.wantsReopened, 1)
assert.equal(wantStatus(W.gone), 'open')
assert.equal(ledger('g'), 'failed')

// young stall → untouched
assert.equal(r.stalledWaiting, 1)
assert.equal(wantStatus(W.young), 'sourced')
assert.equal(ledger('a'), 'queued')

// old stall (incl. never-active metaDL) → reopened, ledger cleaned, removed with files
assert.deepEqual(r.stalled.map((s) => s.hash).sort(), [H('b'), H('c')])
assert.deepEqual(r.stalled.find((s) => s.hash === H('b')).want_ids.sort(), [W.old1, W.old2].sort())
for (const id of [W.old1, W.old2, W.meta]) assert.equal(wantStatus(id), 'open')
assert.equal(ledger('b'), 'cleaned')
assert.equal(ledger('c'), 'cleaned')
assert.match(db.getTorrent(H('b')).note, /stalledDL, no activity for 30h/)

// error → untouched, reported (ours only), free space attached
assert.deepEqual(r.errored.map((e) => e.hash), [H('e')])
assert.deepEqual(r.errored[0].want_ids, [W.err])
assert.equal(r.freeBytes, 123)
assert.equal(wantStatus(W.err), 'sourced')
assert.equal(ledger('e'), 'queued')

// missingFiles → reopened, ledger cleaned, entry removed WITHOUT deleting files
assert.deepEqual(r.missingFiles.map((m) => m.hash), [H('m')])
assert.equal(wantStatus(W.missing), 'open')
assert.equal(ledger('m'), 'cleaned')

// a plain download is not a stall, however long ago it last moved data
assert.equal(wantStatus(W.dl), 'sourced')

// exactly two deletes: stalled with files, missingFiles without
assert.deepEqual(deletes, [
  { hashes: [H('b'), H('c')], deleteFiles: 'true' },
  { hashes: [H('m')], deleteFiles: 'false' },
])

// Given-up hashes are refused by the add path's dedupe guard; a gone one is not.
const blocked = db.blockedTorrentHashes()
for (const c of ['b', 'c', 'm']) assert.ok(blocked.has(H(c)), 'given-up ' + c + ' is blocked from re-queueing')
assert.ok(!blocked.has(H('g')), 'gone torrent stays re-queueable')

// the other environment's torrents and ledger rows are never touched
for (const c of ['x', 'y', 'z']) assert.equal(ledger(c), 'queued', `foreign ${c} untouched`)
assert.ok(torrents.some((x) => x.hash === H('x')), 'foreign stall not deleted')

// --- Second pass: nothing left to do, nothing deleted twice. ----------------
const r2 = await sourcingReconcile(false)
assert.equal(r2.stalled.length + r2.missingFiles.length + r2.wantsReopened + r2.orphanRowsClosed, 0)
assert.equal(deletes.length, 2, 'second pass deletes nothing')

// --- Claim guard: a want the old flow already reopened is not re-processed. --
torrents.push(t(H('f'), 'stalledDL', { last_activity: now - 50 * hr }))
const lost = want(9, H('f'))
db.updateWantStatus(lost, 'open', 'unstick: reopened first') // the old flow won the race
const r3 = await sourcingReconcile(false)
assert.equal(r3.stalled.length, 0, 'unclaimed torrent is not judged')
assert.equal(deletes.length, 2, 'no delete for a want someone else already reopened')
assert.equal(db.getWant(lost).note, 'unstick: reopened first')

// --- Config: a shorter threshold and keep-files. -----------------------------
process.env.SOURCING_STALL_HOURS = '1'
process.env.SOURCING_STALL_DELETE_FILES = 'false'
const r4 = await sourcingReconcile(false)
assert.equal(r4.stallHours, 1)
assert.deepEqual(r4.stalled.map((s) => s.hash), [H('a')])
assert.deepEqual(deletes.at(-1), { hashes: [H('a')], deleteFiles: 'false' })

db.getDb().close()
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // Windows can hold the SQLite file briefly; a leftover temp dir is harmless.
}
console.log('verify-reconcile: ok')
