// Smoke test for server/storage.ts: folder ↔ torrent linking by inode, the
// freed-space inputs, and the delete guard. Run: npx tsx scripts/verify-storage.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'))
const lib = path.join(tmp, 'anime')
const dl = path.join(tmp, 'downloads')
fs.mkdirSync(path.join(lib, 'Show A (2020)/Season 01'), { recursive: true })
fs.mkdirSync(path.join(lib, 'Show B'), { recursive: true })
fs.mkdirSync(path.join(dl, 'Show.A.S01'), { recursive: true })
fs.writeFileSync(path.join(dl, 'Show.A.S01/e1.mkv'), Buffer.alloc(1000))
fs.writeFileSync(path.join(dl, 'Show.A.S01/extra.nfo'), Buffer.alloc(10))
fs.linkSync(path.join(dl, 'Show.A.S01/e1.mkv'), path.join(lib, 'Show A (2020)/Season 01/e1.mkv'))
fs.writeFileSync(path.join(lib, 'Show B/b.mkv'), Buffer.alloc(500))

process.env.DATA_DIR = tmp
process.env.LIBRARY_DIR = lib
process.env.LIBRARY_DIR_TV = path.join(tmp, 'nope-tv')
process.env.LIBRARY_DIR_MOVIES = path.join(tmp, 'nope-movies')
process.env.QBIT_URL = 'http://qbit.test'
process.env.QBIT_USERNAME = ''
process.env.QBIT_PASSWORD = ''
process.env.JELLYFIN_API_KEY = ''

const torrents = [
  { hash: 'a'.repeat(40), name: 'Show.A.S01', state: 'stoppedUP', progress: 1, size: 1010, category: 'anime', tags: '', added_on: 1, content_path: path.join(dl, 'Show.A.S01'), save_path: dl },
  { hash: 'b'.repeat(40), name: 'Gone', state: 'missingFiles', progress: 0, size: 5, category: 'tv', tags: 'tmdb:4057', added_on: 2, content_path: path.join(dl, 'Gone'), save_path: dl },
]
const deleted = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'set-cookie': 'SID=x' } })
  if (u.includes('/torrents/info')) return Response.json(torrents)
  if (u.endsWith('/torrents/delete')) { deleted.push(String(init.body)); return new Response('') }
  throw new Error('unexpected fetch ' + u)
}

const { insertSeries } = await import('../server/db.ts')
const { buildStorageReport, deleteStorage, resolveDeletableFolder } = await import('../server/storage.ts')
insertSeries({ mal_id: 1, title: 'Show A', synopsis: null, image_url: null, url: null })

const r = await buildStorageReport()
const a = r.folders.find((f) => f.name === 'Show A (2020)')
const b = r.folders.find((f) => f.name === 'Show B')
assert.equal(a.bytes, 1000)
assert.equal(a.linkedBytes, 1000)
assert.deepEqual(a.torrents, ['a'.repeat(40)])
assert.equal(a.catalog?.title, 'Show A', 'year suffix normalised away for catalog match')
assert.equal(b.catalog, null)
assert.equal(b.linkedBytes, 0)
const ta = r.torrents.find((t) => t.name === 'Show.A.S01')
assert.equal(ta.bytes, 1010)
assert.equal(ta.linkedBytes, 1000)
assert.deepEqual(ta.folders, ['anime/Show A (2020)'])
assert.equal(r.missingRoots.length, 2)
assert.equal(r.volumes.length, 1)

for (const bad of ['..', '.', '', 'a/b', 'a\\b', '.hidden']) assert.throws(() => resolveDeletableFolder('anime', bad), bad)
assert.throws(() => resolveDeletableFolder('nope', 'Show B'))
await assert.rejects(deleteStorage({ folders: [], torrents: ['not-a-hash'] }))
assert.ok(fs.existsSync(path.join(lib, 'Show B')), 'invalid request removed nothing')

const res = await deleteStorage({ folders: [{ section: 'anime', name: 'Show B' }], torrents: ['A'.repeat(40)] })
assert.deepEqual(res.deletedFolders, ['anime/Show B'])
assert.equal(res.errors.length, 0)
assert.ok(!fs.existsSync(path.join(lib, 'Show B')))
assert.ok(fs.existsSync(path.join(lib, 'Show A (2020)')))
assert.match(deleted[0], /deleteFiles=true/)
assert.match(deleted[0], new RegExp('hashes=' + 'a'.repeat(40)))

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* sqlite still open on Windows */ }
console.log('verify-storage: ok')
