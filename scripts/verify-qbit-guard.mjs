// Smoke test for the torrent-add guard (server/qbitGuard.ts) and the
// sink.qbittorrent node that enforces it. Fakes qBittorrent by stubbing fetch.
// Run: npx tsx scripts/verify-qbit-guard.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-guard-'))
process.env.DATA_DIR = tmp
process.env.QBIT_URL = 'http://qbit.test'
process.env.QBIT_USERNAME = ''
process.env.QBIT_PASSWORD = ''
process.env.JELLYFIN_API_KEY = ''
process.env.QBIT_MIN_FREE_GB = '100'
process.env.QBIT_REQUIRED_INTERFACE = 'tailscale0'
process.env.HOME_PUBLIC_IP = '203.0.113.7'

const GiB = 2 ** 30
const qb = { free: 500 * GiB, iface: 'tailscale0', ext: '198.51.100.9' }
const calls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  calls.push(u.replace('http://qbit.test/api/v2', ''))
  if (u.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=x' } })
  if (u.endsWith('/sync/maindata'))
    return Response.json({ server_state: { free_space_on_disk: qb.free, last_external_address_v4: qb.ext } })
  if (u.endsWith('/app/preferences')) return Response.json({ current_network_interface: qb.iface })
  if (u.endsWith('/torrents/add') || u.endsWith('/torrents/addTags') || u.endsWith('/torrents/rename'))
    return new Response('Ok.')
  throw new Error('unexpected fetch ' + u)
}

const { checkQbitGuard, clearQbitGuardCache, qbitAddTorrents, QbitGuardRefused } = await import('../server/qbitGuard.ts')
const { qbitGuard } = await import('../server/qbit.ts')
const { NODE_REGISTRY } = await import('../server/flowNodes.ts')
const { insertSeries, upsertWant, getWant, getTorrent } = await import('../server/db.ts')

const B = 'http://qbit.test'
const cookie = async () => 'SID=x'
const fresh = async () => {
  clearQbitGuardCache()
  return checkQbitGuard(B, cookie)
}

// All good -> allowed; the home IP is never carried, a VPN exit IP is.
let g = await fresh()
assert.equal(g.ok, true, 'all good -> allowed')
assert.deepEqual(g.reasons, [])
assert.equal(g.freeGB, 500)
assert.equal(g.floorGB, 100)
assert.equal(g.interface, 'tailscale0')
assert.equal(g.externalIp, '198.51.100.9')

// Below floor -> refused with reason.
qb.free = 40 * GiB
g = await fresh()
assert.equal(g.ok, false, 'below floor -> refused')
assert.match(g.reasons.join(), /only 40 GB free.*floor 100 GB/)
qb.free = 500 * GiB

// Wrong interface -> refused; unbound ('' = any interface) -> refused.
qb.iface = 'eth0'
g = await fresh()
assert.equal(g.ok, false, 'wrong interface -> refused')
assert.match(g.reasons.join(), /"eth0", not "tailscale0"/)
qb.iface = ''
g = await fresh()
assert.match(g.reasons.join(), /any interface/)
qb.iface = 'tailscale0'

// External IP == home IP -> refused, and the status does not leak it.
qb.ext = '203.0.113.7'
g = await fresh()
assert.equal(g.ok, false, 'home IP -> refused')
assert.match(g.reasons.join(), /home connection/)
assert.equal(g.externalIp, undefined, 'home IP never returned')
assert.ok(!JSON.stringify(g).includes('203.0.113.7'), 'home IP not anywhere in the status')
qb.ext = '198.51.100.9'

// Unreadable qBittorrent -> refused (fail closed).
clearQbitGuardCache()
g = await checkQbitGuard(B, async () => {
  throw new Error('login failed')
})
assert.equal(g.ok, false, 'unreadable -> refused')
assert.match(g.reasons.join(), /could not read qBittorrent state: login failed/)

// Checks disabled when config is empty / 0 -> allowed without touching qBittorrent.
process.env.QBIT_MIN_FREE_GB = '0'
process.env.QBIT_REQUIRED_INTERFACE = ''
process.env.HOME_PUBLIC_IP = ''
qb.free = 0
qb.iface = 'eth0'
qb.ext = '203.0.113.7'
clearQbitGuardCache()
calls.length = 0
g = await checkQbitGuard(B, cookie)
assert.equal(g.ok, true, 'all checks off -> allowed')
assert.equal(calls.length, 0, 'disabled guard makes no requests')
process.env.QBIT_MIN_FREE_GB = '100'
process.env.QBIT_REQUIRED_INTERFACE = 'tailscale0'
process.env.HOME_PUBLIC_IP = '203.0.113.7'
qb.free = 500 * GiB
qb.iface = 'tailscale0'
qb.ext = '198.51.100.9'

// Cached briefly: repeated checks read qBittorrent once.
clearQbitGuardCache()
calls.length = 0
for (let i = 0; i < 15; i++) await checkQbitGuard(B, cookie)
assert.equal(calls.filter((c) => c === '/sync/maindata').length, 1, 'maindata read once')
assert.equal(calls.filter((c) => c === '/app/preferences').length, 1, 'preferences read once')

// The shared env client goes through the same guard.
clearQbitGuardCache()
assert.equal((await qbitGuard()).ok, true, 'qbitGuard() via env client')

// The add itself refuses without POSTing.
qb.free = 1 * GiB
clearQbitGuardCache()
calls.length = 0
await assert.rejects(qbitAddTorrents(B, 'SID=x', new URLSearchParams({ urls: 'magnet:?x' })), QbitGuardRefused)
assert.ok(!calls.includes('/torrents/add'), 'refused add never POSTs')
qb.free = 500 * GiB

// --- sink.qbittorrent ------------------------------------------------------
const sink = NODE_REGISTRY.get('sink.qbittorrent')
assert.ok(sink.spec.outputs.some((o) => o.id === 'refused'), 'sink has a refused output')
insertSeries({ mal_id: 1, title: 'Show', synopsis: null, image_url: null, url: null })
const { want } = upsertWant({ mal_id: 1, kind: 'episode', episode: 1 })
const hash = 'c'.repeat(40)
const item = () => ({ torrent_magnet: `magnet:?xt=urn:btih:${hash}`, torrent_hash: hash, torrent_name: 'Show - 01', mal_id: 1, want_id: want.id, torrent_episode: 1 })
const ctx = (dryRun) => ({ dryRun, notes: [] })
const cfg = { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false }

// Live run, guard failing: everything to `refused`, reason noted, want untouched, nothing added.
qb.free = 10 * GiB
clearQbitGuardCache()
calls.length = 0
let c = ctx(false)
let out = await sink.run({ in: [item()] }, cfg, c)
assert.equal(out.sent.length, 0)
assert.equal(out.refused.length, 1, 'refused item routed visibly')
assert.match(out.refused[0].refused_reason, /floor 100 GB/)
assert.ok(c.notes.some((n) => /^REFUSED 1 magnet\(s\): only 10 GB free/.test(n)), 'run-report note names the reason')
assert.equal(getWant(want.id).status, 'open', 'want not marked sourced')
assert.equal(getTorrent(hash), undefined, 'refused torrent not ledgered')
assert.ok(!calls.includes('/torrents/add'), 'no add on refusal')

// Dry run, guard failing: reports what it would refuse.
clearQbitGuardCache()
c = ctx(true)
out = await sink.run({ in: [item()] }, cfg, c)
assert.equal(out.refused.length, 1, 'dry run reports refusal')
assert.ok(c.notes.some((n) => n.startsWith('dry run — would refuse')), 'dry-run note')

// Dry run without a reachable qBittorrent still works (preview envs).
process.env.QBIT_URL = ''
c = ctx(true)
out = await sink.run({ in: [item()] }, cfg, c)
assert.equal(out.sent.length, 1, 'dry run unaffected when qBittorrent is not configured')
assert.ok(c.notes.some((n) => n.startsWith('add guard not checked')), 'unchecked guard is noted')
process.env.QBIT_URL = 'http://qbit.test'

// Live run, guard passing: sent, want sourced, ledgered.
qb.free = 500 * GiB
clearQbitGuardCache()
calls.length = 0
c = ctx(false)
out = await sink.run({ in: [item()] }, cfg, c)
assert.equal(out.sent.length, 1, 'guard passing -> sent')
assert.equal(out.refused.length, 0)
assert.equal(calls.filter((x) => x === '/torrents/add').length, 1, 'one add')
assert.equal(calls.filter((x) => x === '/sync/maindata').length, 1, 'guard re-check served from cache')
assert.equal(getWant(want.id).status, 'sourced', 'want sourced on a real add')

console.log('verify-qbit-guard: all checks passed')
