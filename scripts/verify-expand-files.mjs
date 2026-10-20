#!/usr/bin/env node
// Smoke tests for transform.expand-files' qBittorrent filtering (no vitest in this repo).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.QBIT_URL = 'http://qbit.test'
process.env.QBIT_USERNAME = 'u'
process.env.QBIT_PASSWORD = 'p'

const { NODE_REGISTRY } = await import('../server/flowNodes.ts')
const node = NODE_REGISTRY.get('transform.expand-files')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// qBit mock: login OK, /torrents/files answers `filesFor[hash]` or a status.
let filesFor = {}
let calls = []
globalThis.fetch = async (url) => {
  const u = new URL(String(url))
  calls.push(u.pathname)
  if (u.pathname === '/api/v2/auth/login') {
    return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } })
  }
  if (u.pathname === '/api/v2/torrents/files') {
    const r = filesFor[u.searchParams.get('hash')]
    if (typeof r === 'number') return new Response('err', { status: r })
    return new Response(JSON.stringify(r), { status: 200 })
  }
  return new Response('?', { status: 404 })
}

async function run(items) {
  const notes = []
  const out = await node.run({ in: items }, {}, { notes, dryRun: true })
  return { out, notes }
}
const names = (items) => items.map((i) => i.file_name).sort()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expand-files-'))
const save = path.join(root, 'dl')
const touch = (rel) => {
  const p = path.join(save, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
  return p
}
const row = (name, priority, progress) => ({ name, priority, progress })

// Folder torrent: complete kept, priority-0 stub and incomplete stub skipped.
{
  touch('Kai/Kai - 001.mkv'); touch('Kai/Kai - 099.mkv'); touch('Kai/Kai - 152.mkv'); touch('Kai/Kai - 098.mkv')
  filesFor = {
    h1: [
      row('Kai/Kai - 001.mkv', 1, 1),
      row('Kai/Kai - 098.mkv', 1, 0.5), // wanted but still downloading
      row('Kai/Kai - 099.mkv', 0, 0.012), // priority 0 with boundary pieces
      row('Kai/Kai - 152.mkv', 0, 0.004),
    ],
  }
  const { out, notes } = await run([{ torrent_hash: 'h1', save_path: save, content_path: path.join(save, 'Kai') }])
  assert(names(out.files).join() === 'Kai - 001.mkv', `folder: ${names(out.files)}`)
  assert(out.empty.length === 0, 'folder: not empty')
  assert(notes.some((n) => /skipped 3 file\(s\).*2 priority 0, 1 incomplete/.test(n)), `folder notes: ${notes}`)
}

// Single-file torrent: content_path is the file itself.
{
  const p = touch('Movie.mkv')
  filesFor = { h2: [row('Movie.mkv', 1, 1)] }
  const { out } = await run([{ torrent_hash: 'h2', save_path: save, content_path: p }])
  assert(names(out.files).join() === 'Movie.mkv', 'single-file kept')
  filesFor = { h2: [row('Movie.mkv', 0, 1)] }
  const r = await run([{ torrent_hash: 'h2', save_path: save, content_path: p }])
  assert(r.out.files.length === 0 && r.out.empty.length === 1, 'single-file priority 0 -> empty')
}

// A disk file qBit does not list is skipped too (never fail open on a path mismatch).
{
  filesFor = { h3: [row('Kai/other.mkv', 1, 1)] }
  const { out } = await run([{ torrent_hash: 'h3', save_path: save, content_path: path.join(save, 'Kai') }])
  assert(out.files.length === 0 && out.empty.length === 1, 'unlisted files skipped')
}

// No hash: disk-only behaviour, qBit never contacted.
{
  calls = []
  const { out } = await run([{ content_path: path.join(save, 'Kai') }])
  assert(out.files.length === 4, `no-hash keeps all: ${out.files.length}`)
  assert(calls.length === 0, `no-hash made calls: ${calls}`)
}

// API failure: fail closed onto the empty port with a note.
{
  filesFor = { h4: 500 }
  const { out, notes } = await run([{ torrent_hash: 'h4', save_path: save, content_path: path.join(save, 'Kai') }])
  assert(out.files.length === 0 && out.empty.length === 1, 'api failure fails closed')
  assert(notes.some((n) => /lookup failed.*not importing/.test(n)), `failure note: ${notes}`)
}

fs.rmSync(root, { recursive: true, force: true })
console.log('expand-files: ok')
