// Node registry for the /manage flow editor: every node type the executor can
// run, plus the metadata (inputs/outputs/config fields) the client needs to
// render and configure it. Specs are served via GET /api/flows/node-types so
// the editor never hardcodes node knowledge.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jfJson, jfUrl, jellyfinConfigured, JfItem } from './jellyfin.js'
import { listSeries, upsertSeriesMetadata } from './db.js'
import { getAllPortalItems, getPortalItem, upsertPortalItem, PortalItem } from './portalDb.js'
import { searchAnime, pickPosterUrl, fetchAnimeFull } from './jikan.js'
import { blacklistedHashes } from './blacklist.js'
import { limitedFetch, limitedJson, hostKey } from './httpQueue.js'

const execFileP = promisify(execFile)

export type FlowItem = Record<string, unknown>

export interface ConfigField {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'boolean' | 'password'
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  help?: string
}

export interface NodePort {
  id: string
  label: string
}

export type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'boundary'

export interface NodeSpec {
  type: string
  label: string
  category: NodeCategory
  description: string
  inputs: NodePort[]
  outputs: NodePort[]
  config: ConfigField[]
}

export interface RunContext {
  dryRun: boolean
  notes: string[]
}

export interface NodeImpl {
  spec: NodeSpec
  run(
    inputs: Record<string, FlowItem[]>,
    config: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<Record<string, FlowItem[]>>
}

const str = (config: Record<string, unknown>, key: string, fallback: string): string => {
  const v = config[key]
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

const num = (config: Record<string, unknown>, key: string, fallback: number): number => {
  const v = Number(config[key])
  return Number.isFinite(v) ? v : fallback
}

const bool = (config: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const v = config[key]
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const allInputs = (inputs: Record<string, FlowItem[]>): FlowItem[] =>
  Object.values(inputs).flat()

const USER_AGENT = 'boop-watch-flows/1.0'

// Through the shared limiter, keyed by host — TsukiHime and AnimeTosho each get
// their own min-gap + Retry-After-honouring retry (TsukiHime documents per-IP
// windows: 120 req/min default, 50 req/min for /v1/search/torrents), and the
// generic source.http node gets limiting for free (hostKey falls back to 'other').
function fetchJson(url: string): Promise<unknown> {
  return limitedJson(hostKey(url), url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
}

/** Resolves a dot path ("data.results") into a fetched JSON document. */
function digPath(doc: unknown, path: string): unknown {
  if (!path) return doc
  let cur: unknown = doc
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

const COLLECTION_ID = process.env.WATCH_COLLECTION_ID

/** Maps a Jellyfin item to the flow-item shape (superset of PortalItem). */
function fromJellyfin(it: JfItem): FlowItem {
  const existing = getPortalItem(it.Id)
  return {
    id: it.Id,
    type: it.Type || 'Movie',
    name: it.Name || '',
    original_title: it.OriginalTitle || null,
    overview: it.Overview || null,
    date_created: it.DateCreated || null,
    premiere_date: it.PremiereDate || null,
    production_year: it.ProductionYear || null,
    genres: it.Genres ? JSON.stringify(it.Genres) : null,
    runtime_ticks: it.RunTimeTicks || null,
    index_number: it.IndexNumber ?? null,
    parent_index_number: it.ParentIndexNumber ?? null,
    series_id: it.SeriesId || null,
    series_name: it.SeriesName || null,
    // Like sync.ts: keep whatever image the portal row already has.
    image_url: existing?.image_url || null,
    backdrop_url: existing?.backdrop_url || null,
    has_backdrop: it.BackdropImageTags && it.BackdropImageTags.length > 0 ? 1 : 0,
    // Not a PortalItem column — lets flows branch on "Jellyfin already has art".
    has_primary_image: it.PrimaryImageAspectRatio ? 1 : 0,
  }
}

const jellyfinSource: NodeImpl = {
  spec: {
    type: 'source.jellyfin',
    label: 'Jellyfin collection',
    category: 'source',
    description: 'Fetches titles from the Public Jellyfin collection.',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      {
        key: 'itemTypes',
        label: 'Item types',
        kind: 'select',
        options: [
          { value: 'Movie,Series', label: 'Movies + Series' },
          { value: 'Series', label: 'Series only' },
          { value: 'Movie', label: 'Movies only' },
        ],
        default: 'Movie,Series',
      },
    ],
  },
  async run(_inputs, config) {
    if (!jellyfinConfigured || !COLLECTION_ID) {
      throw new Error('Jellyfin is not configured (JELLYFIN_API_KEY / WATCH_COLLECTION_ID)')
    }
    const res = await jfJson<{ Items?: JfItem[] }>('/Items', {
      ParentId: COLLECTION_ID,
      Recursive: 'true',
      IncludeItemTypes: str(config, 'itemTypes', 'Movie,Series'),
      Fields:
        'PrimaryImageAspectRatio,BackdropImageTags,ProductionYear,Genres,OriginalTitle,DateCreated,PremiereDate,Overview,RunTimeTicks',
    })
    return { items: (res.Items || []).map(fromJellyfin) }
  },
}

const indexerSource: NodeImpl = {
  spec: {
    type: 'source.indexer',
    label: 'Indexer series',
    category: 'source',
    description: 'Reads the /manage catalog (MAL-backed series list).',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [],
  },
  async run() {
    return { items: listSeries().map((s) => ({ ...s })) }
  },
}

const portalSource: NodeImpl = {
  spec: {
    type: 'source.portal',
    label: 'Portal items',
    category: 'source',
    description: 'Reads items already stored in the public portal database.',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      {
        key: 'type',
        label: 'Type',
        kind: 'select',
        options: [
          { value: '', label: 'All' },
          { value: 'Series', label: 'Series' },
          { value: 'Movie', label: 'Movie' },
          { value: 'Episode', label: 'Episode' },
        ],
        default: '',
      },
    ],
  },
  async run(_inputs, config) {
    const type = str(config, 'type', '')
    const items = getAllPortalItems().filter((it) => !type || it.type === type)
    return { items: items.map((it) => ({ ...it })) }
  },
}

const httpSource: NodeImpl = {
  spec: {
    type: 'source.http',
    label: 'Fetch JSON',
    category: 'source',
    description: 'GETs a URL and emits the JSON items found at a path in the response.',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'url', label: 'URL', kind: 'text', default: '' },
      {
        key: 'itemsPath',
        label: 'Items path',
        kind: 'text',
        default: '',
        help: 'Dot path to the array in the response, e.g. "data" or "results". Empty = whole body.',
      },
    ],
  },
  async run(_inputs, config, ctx) {
    const url = str(config, 'url', '')
    if (!url) throw new Error('URL is required')
    const doc = await fetchJson(url)
    const found = digPath(doc, str(config, 'itemsPath', ''))
    const items = Array.isArray(found)
      ? found.filter((v): v is FlowItem => typeof v === 'object' && v !== null)
      : found && typeof found === 'object'
        ? [found as FlowItem]
        : []
    if (!Array.isArray(found)) ctx.notes.push('response path was not an array')
    return { items }
  },
}

// ---------------------------------------------------------------------------
// qBittorrent WebUI client shared by the source (list) and sink (add) nodes.
// Credentials come from node config first, env vars second, so a stored graph
// can stay credential-free.
// ---------------------------------------------------------------------------
async function qbitLogin(base: string, username: string, password: string): Promise<string> {
  const login = await fetch(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    signal: AbortSignal.timeout(15_000),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!login.ok || !cookie || !(await login.text()).includes('Ok')) {
    throw new Error('qBittorrent login failed')
  }
  return cookie
}

function qbitCreds(config: Record<string, unknown>): { base: string; user: string; pass: string } {
  const base = (str(config, 'url', '') || process.env.QBIT_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('qBittorrent URL is not set (node config or QBIT_URL env)')
  return {
    base,
    user: str(config, 'username', '') || process.env.QBIT_USERNAME || 'admin',
    pass: str(config, 'password', '') || process.env.QBIT_PASSWORD || '',
  }
}

// qBittorrent reports every torrent's on-disk location as an absolute path from
// its own filesystem. The importer runs in a different container, so rewrite
// that prefix to wherever the same files are mounted in the pod.
function remapPath(p: string, from: string, to: string): string {
  if (!from || !to) return p
  const f = from.replace(/\/+$/, '')
  if (p === f) return to.replace(/\/+$/, '')
  if (p.startsWith(f + '/')) return to.replace(/\/+$/, '') + p.slice(f.length)
  return p
}

interface QbitInfo {
  hash: string
  name: string
  state: string
  progress: number
  category: string
  size: number
  save_path?: string
  content_path?: string
}

const qbittorrentSource: NodeImpl = {
  spec: {
    type: 'source.qbittorrent',
    label: 'qBittorrent torrents',
    category: 'source',
    description:
      'Lists torrents from qBittorrent (optionally completed only), emitting each one’s on-disk content path so the importer can place the files.',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'url', label: 'qBittorrent URL', kind: 'text', default: '', help: 'Empty = QBIT_URL env.' },
      { key: 'username', label: 'Username', kind: 'text', default: '', help: 'Empty = QBIT_USERNAME env.' },
      { key: 'password', label: 'Password', kind: 'password', default: '', help: 'Empty = QBIT_PASSWORD env.' },
      { key: 'category', label: 'Category', kind: 'text', default: 'anime', help: 'Empty = all categories.' },
      { key: 'completedOnly', label: 'Completed only', kind: 'boolean', default: true, help: 'Only emit torrents that finished downloading (ready to import).' },
      { key: 'pathFrom', label: 'Download path (qBit)', kind: 'text', default: '', help: 'Path prefix as qBittorrent sees it, e.g. /downloads.' },
      { key: 'pathTo', label: 'Download path (pod)', kind: 'text', default: '', help: 'Where that same prefix is mounted here, e.g. /downloads. Both empty = no rewrite.' },
    ],
  },
  async run(_inputs, config, ctx) {
    const { base, user, pass } = qbitCreds(config)
    const category = str(config, 'category', 'anime')
    const completedOnly = bool(config, 'completedOnly', true)
    const from = str(config, 'pathFrom', '')
    const to = str(config, 'pathTo', '')

    const cookie = await qbitLogin(base, user, pass)
    const q = new URLSearchParams()
    if (category) q.set('category', category)
    if (completedOnly) q.set('filter', 'completed')
    const res = await fetch(`${base}/api/v2/torrents/info?${q.toString()}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`qBittorrent list failed (${res.status})`)
    const torrents = (await res.json()) as QbitInfo[]

    const items = torrents.map((t): FlowItem => {
      const contentPath = remapPath(String(t.content_path ?? ''), from, to)
      return {
        // `name` so title-matching / template nodes work unchanged.
        name: t.name,
        torrent_hash: t.hash,
        torrent_name: t.name,
        torrent_state: t.state,
        torrent_progress: t.progress,
        torrent_category: t.category,
        torrent_size: t.size ?? null,
        save_path: remapPath(String(t.save_path ?? ''), from, to),
        content_path: contentPath,
        torrent_episode: parseEpisode(t.name),
        torrent_is_batch: titleIsBatch(t.name),
      }
    })
    ctx.notes.push(`${items.length} torrent(s)${completedOnly ? ' (completed)' : ''}${category ? ` in "${category}"` : ''}`)
    return { items }
  },
}

const template: NodeImpl = {
  spec: {
    type: 'transform.template',
    label: 'Set field from template',
    category: 'enrich',
    description:
      'Sets a field by filling a template with the item’s own values, e.g. "{title} 1080p".',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'field', label: 'Set field', kind: 'text', default: 'query' },
      {
        key: 'template',
        label: 'Template',
        kind: 'text',
        default: '{title}',
        help: '{name} placeholders are replaced with the item’s field values.',
      },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'query')
    const tpl = str(config, 'template', '{title}')
    const items = allInputs(inputs).map((item) => ({
      ...item,
      [field]: tpl.replace(/\{([^}]+)\}/g, (_, key: string) => String(item[key] ?? '')).trim(),
    }))
    return { items }
  },
}

const diff: NodeImpl = {
  spec: {
    type: 'combine.diff',
    label: 'Difference',
    category: 'combine',
    description:
      'Splits stream A on whether a matching item exists in stream B (titles are compared loosely).',
    inputs: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    outputs: [
      { id: 'missing', label: 'missing from B' },
      { id: 'present', label: 'present in B' },
    ],
    config: [
      { key: 'fieldA', label: 'Match field (A)', kind: 'text', default: 'title' },
      { key: 'fieldB', label: 'Match field (B)', kind: 'text', default: 'name' },
      {
        key: 'fieldB2',
        label: 'Fallback field (B)',
        kind: 'text',
        default: 'original_title',
        help: 'Second field on B items that also counts as a match.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const fieldA = str(config, 'fieldA', 'title')
    const fieldB = str(config, 'fieldB', 'name')
    const fieldB2 = str(config, 'fieldB2', '')
    const known = new Set<string>()
    for (const item of inputs.b ?? []) {
      const k1 = norm(item[fieldB])
      const k2 = fieldB2 ? norm(item[fieldB2]) : ''
      if (k1) known.add(k1)
      if (k2) known.add(k2)
    }
    const missing: FlowItem[] = []
    const present: FlowItem[] = []
    for (const item of inputs.a ?? []) {
      const key = norm(item[fieldA])
      // Un-keyed items can't be proven missing — keep them out of the
      // "missing" branch so nothing downstream acts on garbage.
      ;(key && !known.has(key) ? missing : present).push(item)
    }
    ctx.notes.push(`${missing.length} of ${(inputs.a ?? []).length} A-items missing from B`)
    return { missing, present }
  },
}

// Left-join two streams on a key: for each primary item, copy a field from the
// first matching donor item. The generic pairing primitive behind the dual-audio
// mux (attach the donor file path onto the h264 primary per episode), but it's
// not mux-specific — any "enrich A with a value looked up from B by key" join.
const join: NodeImpl = {
  spec: {
    type: 'combine.join',
    label: 'Join by key',
    category: 'combine',
    description:
      'For each primary item, looks up the first donor item with the same key and copies a field from it (e.g. donor file_path -> donor_path). Primary items with no donor match exit "unmatched"; none are dropped.',
    inputs: [
      { id: 'primary', label: 'primary' },
      { id: 'donor', label: 'donor' },
    ],
    outputs: [
      { id: 'joined', label: 'joined' },
      { id: 'unmatched', label: 'unmatched' },
    ],
    config: [
      { key: 'keyField', label: 'Key field (primary)', kind: 'text', default: 'group_key' },
      { key: 'donorKeyField', label: 'Key field (donor)', kind: 'text', default: '', help: 'Empty = same as the primary key field.' },
      { key: 'copyFrom', label: 'Copy from (donor field)', kind: 'text', default: 'file_path' },
      { key: 'copyTo', label: 'Copy to (primary field)', kind: 'text', default: 'donor_path' },
    ],
  },
  async run(inputs, config, ctx) {
    const keyField = str(config, 'keyField', 'group_key')
    const donorKeyField = str(config, 'donorKeyField', '') || keyField
    const copyFrom = str(config, 'copyFrom', 'file_path')
    const copyTo = str(config, 'copyTo', 'donor_path')
    const donorByKey = new Map<string, FlowItem>()
    for (const d of inputs.donor ?? []) {
      const k = String(d[donorKeyField] ?? '')
      if (k && !donorByKey.has(k)) donorByKey.set(k, d) // first donor per key wins
    }
    const joined: FlowItem[] = []
    const unmatched: FlowItem[] = []
    for (const p of inputs.primary ?? []) {
      const k = String(p[keyField] ?? '')
      const d = k ? donorByKey.get(k) : undefined
      if (d && d[copyFrom] != null && d[copyFrom] !== '') joined.push({ ...p, [copyTo]: d[copyFrom] })
      else unmatched.push(p)
    }
    ctx.notes.push(`joined ${joined.length}, ${unmatched.length} without a donor`)
    return { joined, unmatched }
  },
}

const dedupe: NodeImpl = {
  spec: {
    type: 'filter.dedupe',
    label: 'Deduplicate',
    category: 'filter',
    description: 'Drops items whose field value was already seen (first one wins).',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [{ key: 'field', label: 'Field', kind: 'text', default: 'id' }],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'id')
    const seen = new Set<string>()
    const items: FlowItem[] = []
    let dropped = 0
    for (const item of allInputs(inputs)) {
      const key = String(item[field] ?? '')
      if (key && seen.has(key)) {
        dropped++
        continue
      }
      if (key) seen.add(key)
      items.push(item)
    }
    if (dropped > 0) ctx.notes.push(`dropped ${dropped} duplicates`)
    return { items }
  },
}

const limit: NodeImpl = {
  spec: {
    type: 'filter.limit',
    label: 'Limit',
    category: 'filter',
    description: 'Passes the first N items through; the rest exit "overflow".',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'items', label: 'items' },
      { id: 'overflow', label: 'overflow' },
    ],
    config: [{ key: 'count', label: 'Max items', kind: 'number', default: 10 }],
  },
  async run(inputs, config) {
    const count = Math.max(0, num(config, 'count', 10))
    const all = allInputs(inputs)
    return { items: all.slice(0, count), overflow: all.slice(count) }
  },
}

const fieldFilter: NodeImpl = {
  spec: {
    type: 'filter.field',
    label: 'Filter by field',
    category: 'filter',
    description: 'Splits items on a field test: matches exit "pass", the rest exit "fail".',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'pass', label: 'pass' },
      { id: 'fail', label: 'fail' },
    ],
    config: [
      { key: 'field', label: 'Field', kind: 'text', default: 'image_url' },
      {
        key: 'mode',
        label: 'Condition',
        kind: 'select',
        options: [
          { value: 'empty', label: 'is empty' },
          { value: 'not-empty', label: 'is not empty' },
          { value: 'equals', label: 'equals value' },
          { value: 'contains', label: 'contains value' },
        ],
        default: 'empty',
      },
      { key: 'value', label: 'Value', kind: 'text', default: '', help: 'Used by equals / contains.' },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'image_url')
    const mode = str(config, 'mode', 'empty')
    const value = str(config, 'value', '')
    const pass: FlowItem[] = []
    const fail: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      const raw = item[field]
      const s = raw == null ? '' : String(raw)
      let ok: boolean
      switch (mode) {
        case 'not-empty':
          ok = s !== ''
          break
        case 'equals':
          ok = s === value
          break
        case 'contains':
          ok = value !== '' && s.toLowerCase().includes(value.toLowerCase())
          break
        default:
          ok = s === ''
      }
      ;(ok ? pass : fail).push(item)
    }
    return { pass, fail }
  },
}

// ---------------------------------------------------------------------------
// General compute primitives. Sorting/filtering/math belong in the graph, not
// hardcoded inside domain nodes — these let a flow express "best per episode",
// "score then sort", "keep the ones above N", etc. from generic building blocks.
// ---------------------------------------------------------------------------

// Coerce a value for comparison: numbers stay numeric (so 9 < 10), everything
// else is lowercased string. Booleans -> 1/0 so they sort/compare sanely.
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// Safe arithmetic evaluator for transform.compute — a recursive-descent parser
// over {field} refs, numeric literals, + - * / %, parentheses, unary minus, and
// a few functions. No eval / Function, so a stored graph can't run code.
type Tok = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'fn'; v: string }
const FUNCS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0] ?? 0),
  round: (a) => Math.round(a[0] ?? 0),
  floor: (a) => Math.floor(a[0] ?? 0),
  ceil: (a) => Math.ceil(a[0] ?? 0),
}

function tokenizeExpr(expr: string, item: FlowItem): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '{') {
      const end = expr.indexOf('}', i)
      if (end < 0) throw new Error('unclosed { in expression')
      const key = expr.slice(i + 1, end).trim()
      const n = asNumber(item[key])
      if (n == null) throw new Error(`field "${key}" is not numeric`)
      toks.push({ t: 'num', v: n })
      i = end + 1
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++
      toks.push({ t: 'num', v: Number(expr.slice(i, j)) })
      i = j
      continue
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i + 1
      while (j < expr.length && /[a-zA-Z]/.test(expr[j])) j++
      const name = expr.slice(i, j).toLowerCase()
      if (!FUNCS[name]) throw new Error(`unknown function "${name}"`)
      toks.push({ t: 'fn', v: name })
      i = j
      continue
    }
    if ('+-*/%(),'.includes(c)) {
      toks.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`unexpected character "${c}" in expression`)
  }
  return toks
}

function evalExpr(expr: string, item: FlowItem): number {
  const toks = tokenizeExpr(expr, item)
  let pos = 0
  const peek = () => toks[pos]
  const eat = (v?: string) => {
    const tk = toks[pos]
    if (!tk || (v && !(tk.t === 'op' && tk.v === v))) throw new Error(`expected "${v}" in expression`)
    pos++
    return tk
  }
  // expr := term (('+'|'-') term)*
  function parseExpr(): number {
    let v = parseTerm()
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '+' || (peek() as { v: string }).v === '-')) {
      const op = (eat() as { v: string }).v
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  // term := factor (('*'|'/'|'%') factor)*
  function parseTerm(): number {
    let v = parseFactor()
    while (peek()?.t === 'op' && ['*', '/', '%'].includes((peek() as { v: string }).v)) {
      const op = (eat() as { v: string }).v
      const r = parseFactor()
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }
  function parseFactor(): number {
    const tk = peek()
    if (!tk) throw new Error('unexpected end of expression')
    if (tk.t === 'op' && tk.v === '-') { eat(); return -parseFactor() }
    if (tk.t === 'op' && tk.v === '+') { eat(); return parseFactor() }
    if (tk.t === 'op' && tk.v === '(') {
      eat('(')
      const v = parseExpr()
      eat(')')
      return v
    }
    if (tk.t === 'fn') {
      eat()
      eat('(')
      const args: number[] = [parseExpr()]
      while (peek()?.t === 'op' && (peek() as { v: string }).v === ',') { eat(','); args.push(parseExpr()) }
      eat(')')
      return FUNCS[tk.v](args)
    }
    if (tk.t === 'num') { eat(); return tk.v }
    throw new Error('malformed expression')
  }
  const result = parseExpr()
  if (pos !== toks.length) throw new Error('trailing tokens in expression')
  return result
}

const compute: NodeImpl = {
  spec: {
    type: 'transform.compute',
    label: 'Compute field',
    category: 'enrich',
    description:
      'Sets a numeric field from an arithmetic expression over the item’s fields, e.g. "{torrent_seeders} + {res_rank} * 100". Supports + - * / %, parentheses, and min/max/abs/round/floor/ceil.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'ok', label: 'ok' },
      { id: 'error', label: 'error' },
    ],
    config: [
      { key: 'field', label: 'Set field', kind: 'text', default: 'score' },
      { key: 'expr', label: 'Expression', kind: 'text', default: '{torrent_seeders}', help: '{field} refs must be numeric. Non-numeric items exit "error" untouched.' },
    ],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'score')
    const expr = str(config, 'expr', '')
    const ok: FlowItem[] = []
    const error: FlowItem[] = []
    let firstErr = ''
    for (const item of allInputs(inputs)) {
      try {
        ok.push({ ...item, [field]: evalExpr(expr, item) })
      } catch (e) {
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
        error.push(item)
      }
    }
    if (error.length > 0) ctx.notes.push(`${error.length} item(s) failed to compute (${firstErr})`)
    return { ok, error }
  },
}

const compare: NodeImpl = {
  spec: {
    type: 'filter.compare',
    label: 'Compare',
    category: 'filter',
    description:
      'Splits items on a comparison. Compares a field against a fixed value or another field; numeric when both sides are numbers, otherwise string.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'pass', label: 'pass' },
      { id: 'fail', label: 'fail' },
    ],
    config: [
      { key: 'field', label: 'Field', kind: 'text', default: 'score' },
      {
        key: 'op',
        label: 'Operator',
        kind: 'select',
        options: [
          { value: 'eq', label: '= equals' },
          { value: 'ne', label: '≠ not equals' },
          { value: 'gt', label: '> greater than' },
          { value: 'gte', label: '≥ at least' },
          { value: 'lt', label: '< less than' },
          { value: 'lte', label: '≤ at most' },
          { value: 'contains', label: 'contains' },
          { value: 'matches', label: 'matches regex' },
          { value: 'in', label: 'in (comma list)' },
        ],
        default: 'gte',
      },
      { key: 'value', label: 'Value', kind: 'text', default: '', help: 'Compared against. Empty compares against the "Other field" instead.' },
      { key: 'otherField', label: 'Other field', kind: 'text', default: '', help: 'When Value is empty, compare the field against this field.' },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'score')
    const op = str(config, 'op', 'gte')
    const rawValue = str(config, 'value', '')
    const otherField = str(config, 'otherField', '')
    const pass: FlowItem[] = []
    const fail: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      const left = item[field]
      const right: unknown = rawValue !== '' ? rawValue : otherField ? item[otherField] : ''
      let ok: boolean
      switch (op) {
        case 'contains':
          ok = String(left ?? '').toLowerCase().includes(String(right).toLowerCase())
          break
        case 'matches':
          try { ok = new RegExp(String(right), 'i').test(String(left ?? '')) } catch { ok = false }
          break
        case 'in':
          ok = String(right).split(',').map((s) => s.trim().toLowerCase()).includes(String(left ?? '').toLowerCase())
          break
        default: {
          const ln = asNumber(left)
          const rn = asNumber(right)
          const numeric = ln != null && rn != null
          const cmp = numeric
            ? ln < rn ? -1 : ln > rn ? 1 : 0
            : String(left ?? '').toLowerCase().localeCompare(String(right).toLowerCase())
          ok =
            op === 'eq' ? cmp === 0 :
            op === 'ne' ? cmp !== 0 :
            op === 'gt' ? cmp > 0 :
            op === 'gte' ? cmp >= 0 :
            op === 'lt' ? cmp < 0 :
            op === 'lte' ? cmp <= 0 : false
        }
      }
      ;(ok ? pass : fail).push(item)
    }
    return { pass, fail }
  },
}

const sortNode: NodeImpl = {
  spec: {
    type: 'filter.sort',
    label: 'Sort',
    category: 'filter',
    description: 'Orders items by a field (numeric when the values are numbers, otherwise alphabetical).',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'field', label: 'Sort by field', kind: 'text', default: 'score' },
      {
        key: 'direction',
        label: 'Direction',
        kind: 'select',
        options: [
          { value: 'desc', label: 'Descending (high → low)' },
          { value: 'asc', label: 'Ascending (low → high)' },
        ],
        default: 'desc',
      },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'score')
    const dir = str(config, 'direction', 'desc') === 'asc' ? 1 : -1
    const items = [...allInputs(inputs)].sort((a, b) => {
      const an = asNumber(a[field])
      const bn = asNumber(b[field])
      if (an != null && bn != null) return (an - bn) * dir
      return String(a[field] ?? '').toLowerCase().localeCompare(String(b[field] ?? '').toLowerCase()) * dir
    })
    return { items }
  },
}

const groupPick: NodeImpl = {
  spec: {
    type: 'combine.group-pick',
    label: 'Pick best per group',
    category: 'combine',
    description:
      'Groups items by a key field and keeps the top N of each group (ordered by a sort field). The classic "best release per episode" primitive.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'picked', label: 'picked' },
      { id: 'rest', label: 'rest' },
    ],
    config: [
      { key: 'groupField', label: 'Group by field', kind: 'text', default: 'torrent_episode' },
      { key: 'sortField', label: 'Rank by field', kind: 'text', default: 'score' },
      {
        key: 'direction',
        label: 'Rank direction',
        kind: 'select',
        options: [
          { value: 'desc', label: 'Descending (keep highest)' },
          { value: 'asc', label: 'Ascending (keep lowest)' },
        ],
        default: 'desc',
      },
      { key: 'perGroup', label: 'Keep per group', kind: 'number', default: 1 },
    ],
  },
  async run(inputs, config, ctx) {
    const groupField = str(config, 'groupField', 'torrent_episode')
    const sortField = str(config, 'sortField', 'score')
    const dir = str(config, 'direction', 'desc') === 'asc' ? 1 : -1
    const perGroup = Math.max(1, num(config, 'perGroup', 1))
    const groups = new Map<string, FlowItem[]>()
    for (const item of allInputs(inputs)) {
      const key = String(item[groupField] ?? '')
      const arr = groups.get(key)
      if (arr) arr.push(item)
      else groups.set(key, [item])
    }
    const picked: FlowItem[] = []
    const rest: FlowItem[] = []
    for (const arr of groups.values()) {
      const ranked = [...arr].sort((a, b) => {
        const an = asNumber(a[sortField])
        const bn = asNumber(b[sortField])
        if (an != null && bn != null) return (an - bn) * dir
        return String(a[sortField] ?? '').toLowerCase().localeCompare(String(b[sortField] ?? '').toLowerCase()) * dir
      })
      picked.push(...ranked.slice(0, perGroup))
      rest.push(...ranked.slice(perGroup))
    }
    ctx.notes.push(`${groups.size} group(s) → ${picked.length} picked, ${rest.length} set aside`)
    return { picked, rest }
  },
}

const indexerMatch: NodeImpl = {
  spec: {
    type: 'enrich.indexer-match',
    label: 'Match indexer title',
    category: 'enrich',
    description:
      'Finds an indexer series whose title matches the item and copies a field from it. Exact mode compares whole titles; tokens mode matches messy release names by shared distinctive words (romaji/english/japanese catalog titles).',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'matched', label: 'matched' },
      { id: 'unmatched', label: 'unmatched' },
    ],
    config: [
      { key: 'setField', label: 'Set field', kind: 'text', default: 'image_url' },
      {
        key: 'fromField',
        label: 'From indexer field',
        kind: 'text',
        default: 'image_url',
        help: 'Column on the indexer series row to copy from.',
      },
      { key: 'queryField', label: 'Match against field', kind: 'text', default: 'name', help: 'Item field holding the title/release name to match.' },
      {
        key: 'matchMode',
        label: 'Match mode',
        kind: 'select',
        options: [
          { value: 'exact', label: 'Exact title' },
          { value: 'tokens', label: 'Shared words (release names)' },
        ],
        default: 'exact',
      },
      { key: 'threshold', label: 'Min word overlap (0-1)', kind: 'number', default: 0.6, help: 'Tokens mode: fraction of a catalog title’s distinctive words the release must contain.' },
    ],
  },
  async run(inputs, config, ctx) {
    const setField = str(config, 'setField', 'image_url')
    const fromField = str(config, 'fromField', 'image_url')
    const queryField = str(config, 'queryField', 'name')
    const mode = str(config, 'matchMode', 'exact')
    const threshold = num(config, 'threshold', 0.6)
    const catalog = listSeries()

    // Precompute each catalog row's distinctive tokens across its title variants
    // (romaji / english / japanese), for tokens mode.
    const titleVariants = (s: (typeof catalog)[number]): string[] =>
      [s.title, s.title_english, s.title_japanese].filter((t): t is string => !!t)

    const matchExact = (item: FlowItem): (typeof catalog)[number] | undefined =>
      catalog.find(
        (s) =>
          titleVariants(s).some((t) => norm(t) === norm(item[queryField])) ||
          (item.original_title != null && norm(s.title) === norm(item.original_title)),
      )

    // Tokens mode: pick the catalog row whose distinctive words are most present
    // in the release name, above the threshold (best overlap wins ties).
    const matchTokens = (item: FlowItem): (typeof catalog)[number] | undefined => {
      const hay = norm(item[queryField])
      const collapsed = hay.replace(/ /g, '')
      let best: { row: (typeof catalog)[number] | undefined; score: number } = { row: undefined, score: 0 }
      for (const s of catalog) {
        let rowScore = 0
        for (const variant of titleVariants(s)) {
          const toks = significantTokens(variant)
          if (toks.length === 0) continue
          const present = toks.filter((t) => hay.includes(t) || collapsed.includes(t)).length
          rowScore = Math.max(rowScore, present / toks.length)
        }
        if (rowScore > best.score) best = { row: s, score: rowScore }
      }
      return best.score >= threshold ? best.row : undefined
    }

    const matched: FlowItem[] = []
    const unmatched: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      const hit = mode === 'tokens' ? matchTokens(item) : matchExact(item)
      const copied = hit ? (hit as unknown as FlowItem)[fromField] : null
      if (hit && copied != null && copied !== '') {
        matched.push({ ...item, [setField]: copied })
      } else {
        unmatched.push(item)
      }
    }
    ctx.notes.push(`${matched.length}/${matched.length + unmatched.length} matched an indexer title`)
    return { matched, unmatched }
  },
}

const jikanEnrich: NodeImpl = {
  spec: {
    type: 'enrich.jikan',
    label: 'Jikan image search',
    category: 'enrich',
    description:
      'Searches Jikan (MyAnimeList) by name and fills a field with the top result’s poster. Rate-limited: ~1 item/sec.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'found', label: 'found' },
      { id: 'missed', label: 'missed' },
    ],
    config: [
      { key: 'setField', label: 'Set field', kind: 'text', default: 'image_url' },
      { key: 'queryField', label: 'Query field', kind: 'text', default: 'name' },
      {
        key: 'maxItems',
        label: 'Max items',
        kind: 'number',
        default: 25,
        help: 'Safety cap per run (Jikan is rate-limited). 0 = unlimited.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const setField = str(config, 'setField', 'image_url')
    const queryField = str(config, 'queryField', 'name')
    const maxItems = num(config, 'maxItems', 25)
    const items = allInputs(inputs)
    const found: FlowItem[] = []
    const missed: FlowItem[] = []
    let queried = 0
    for (const item of items) {
      const q = String(item[queryField] ?? '').trim()
      if (!q || (maxItems > 0 && queried >= maxItems)) {
        missed.push(item)
        continue
      }
      queried++
      try {
        const results = await searchAnime(q, 1)
        const poster = results.length > 0 ? pickPosterUrl(results[0]) : null
        if (poster) {
          found.push({ ...item, [setField]: poster })
        } else {
          missed.push(item)
        }
      } catch (e) {
        ctx.notes.push(`Jikan error for "${q}": ${e instanceof Error ? e.message : String(e)}`)
        missed.push(item)
      }
      // Jikan spacing handled by the shared 'jikan' queue.
    }
    if (maxItems > 0 && items.length > maxItems) {
      ctx.notes.push(`capped at ${maxItems} of ${items.length} items`)
    }
    return { found, missed }
  },
}

// Torrent index base URLs, overridable for mirrors/self-hosted proxies.
const TOSHO_URL = process.env.TORRENT_TOSHO_URL ?? 'https://feed.animetosho.xyz'
const TSUKI_URL = process.env.TORRENT_TSUKI_URL ?? 'https://api.tsukihime.org'

// Trackers appended when building a magnet from a bare info-hash (TsukiHime
// results carry `btih` but no magnet). Same set Anime Tosho magnets embed.
const MAGNET_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
]

function magnetFromHash(btih: string, name: string): string {
  const tr = MAGNET_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${btih}&dn=${encodeURIComponent(name)}${tr}`
}

// A normalized torrent-search candidate with the quality signals the selector
// scores on. AnimeTosho gives structured resolution/seeders/batch; audio and
// episode number are parsed from the release title (no structured field).
interface Candidate {
  name: string
  magnet: string
  hash: string
  size: number | null
  seeders: number | null
  resolution: string // '2160p' | '1080p' | '720p' | '480p' | ''
  dualAudio: boolean
  videoCodec: string // 'av1' | 'hevc' | 'h264' | '' (parsed from the release name)
  isBatch: boolean
  episode: number | null
  aid: number | null // AniDB series id (AnimeTosho) — canonical show identity
  // Provider's canonical *per-season* id, used to pin the exact season (they
  // share titles): AnimeTosho's AniDB aid, or TsukiHime's anime.id. TsukiHime is
  // the more reliable of the two — AnimeTosho occasionally mis-tags a season.
  pinId: number | null
  seriesTitle: string | null // AnimeTosho canonical series title
}

const RES_RANK: Record<string, number> = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }

function normResolution(raw: string, title: string): string {
  const r = raw.toLowerCase()
  if (RES_RANK[r]) return r
  const m = title.match(/\b(2160|1080|720|480)p?\b/i)
  return m ? `${m[1]}p` : ''
}

// "Dual Audio" / "Multi Audio" — English + Japanese tracks. Note "Multi-Subs"
// is subtitles only (usually Japanese audio), so it deliberately doesn't match.
function titleDualAudio(title: string): boolean {
  return /dual[\s._-]?audio|multi[\s._-]?audio|dual[\s._-]?lang/i.test(title)
}

function titleIsBatch(title: string): boolean {
  return /\bbatch\b|\bcomplete(?:d)?\b|\bseason\b|\(\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*\)/i.test(title)
}

// Video codec from the release name. Matters for playability: our Jellyfin
// transcodes on a Tesla T4 (Turing), which HW-decodes h264/HEVC but NOT AV1 —
// so an AV1 source forces a slow software decode that stalls the stream.
function titleCodec(title: string): string {
  if (/\bav1\b/i.test(title)) return 'av1'
  if (/\b(hevc|x[\s._-]?265|h[\s._-]?265)\b/i.test(title)) return 'hevc'
  if (/\b(avc|x[\s._-]?264|h[\s._-]?264)\b/i.test(title)) return 'h264'
  return ''
}

// Best-effort single-episode number from a fansub title. Ranges ("(01-28)")
// are batches, not episodes, so they return null.
function parseEpisode(title: string): number | null {
  if (/\(\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*\)/.test(title)) return null
  let m = title.match(/\bS\d{1,2}\s*E(\d{1,4})\b/i)
  if (m) return Number(m[1])
  m = title.match(/\bEP?(\d{1,4})\b/i)
  if (m) return Number(m[1])
  m = title.match(/\s-\s(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/i)
  if (m) return Number(m[1])
  m = title.match(/\s(\d{2,4})\s*(?:\[|\()/)
  if (m) return Number(m[1])
  return null
}

async function toshoCandidates(q: string, base: string): Promise<Candidate[]> {
  const doc = (await fetchJson(
    `${base}/json/v1/search?q=${encodeURIComponent(q)}`,
  )) as { data?: Record<string, unknown>[] }
  return (doc.data ?? [])
    .filter((r) => r.magnet || r.info_hash)
    .map((r) => {
      const title = String(r.title ?? '')
      const hash = String(r.info_hash ?? '')
      const series = (r.series ?? null) as { anidb_aid?: number; title?: string } | null
      return {
        name: title || q,
        magnet: String(r.magnet ?? magnetFromHash(hash, title || q)),
        hash,
        size:
          r.size_bytes != null
            ? Number(r.size_bytes)
            : r.total_size != null
              ? Number(r.total_size)
              : null,
        seeders: r.seeders != null ? Number(r.seeders) : null,
        resolution: normResolution(String(r.resolution ?? ''), title),
        dualAudio: titleDualAudio(title),
        videoCodec: titleCodec(title),
        isBatch: Boolean(r.is_batch) || titleIsBatch(title),
        episode: parseEpisode(title),
        aid: series?.anidb_aid != null ? Number(series.anidb_aid) : null,
        pinId: series?.anidb_aid != null ? Number(series.anidb_aid) : null,
        seriesTitle: series?.title != null ? String(series.title) : null,
      }
    })
}

async function tsukiCandidates(q: string, base: string): Promise<Candidate[]> {
  const doc = (await fetchJson(
    `${base}/v1/search/torrents?q=${encodeURIComponent(q)}&limit=50`,
  )) as { results?: Record<string, unknown>[] }
  return (doc.results ?? [])
    .filter((r) => r.btih && !r.is_adult)
    .map((r) => {
      const title = String(r.name ?? '')
      const hash = String(r.btih)
      const audio = Array.isArray(r.audiolangs) ? (r.audiolangs as string[]) : []
      const ep = r.episode_no != null ? Number(r.episode_no) : parseEpisode(title)
      // TsukiHime tags each release with its per-season anime entry (id +
      // titles), so "Frieren S1" (id 19) and "Frieren 2nd Season" (id 284) are
      // distinguishable even though the release names both say "Frieren".
      const anime = (r.anime ?? null) as { id?: number; title?: string } | null
      return {
        name: title || q,
        magnet: magnetFromHash(hash, title || q),
        hash,
        size: r.totalsize != null ? Number(r.totalsize) : null,
        // TsukiHime exposes no seeder count.
        seeders: null,
        resolution: normResolution('', title),
        dualAudio: (audio.includes('ja') && audio.includes('en')) || titleDualAudio(title),
        videoCodec: titleCodec(title),
        isBatch: r.episode_no == null && (titleIsBatch(title) || Number(r.filecount ?? 0) > 2),
        episode: ep,
        aid: null,
        pinId: anime?.id != null ? Number(anime.id) : null,
        seriesTitle: anime?.title != null ? String(anime.title) : null,
      }
    })
}

// Release-name noise that shouldn't count as title words when checking whether
// a search hit actually matches the show we asked for.
const QUALITY_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'bd', 'bluray', 'bdrip', 'web', 'webrip', 'webdl',
  'hevc', 'x265', 'x264', 'av1', 'avc', 'aac', 'opus', 'flac', 'dual', 'audio', 'multi', 'subs',
  'sub', 'batch', 'complete', 'completed', 'uncensored', 'remux', 'season', 'part', 'ova',
])

function significantTokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !QUALITY_TOKENS.has(t) && !/^\d+$/.test(t))
}

// How well a candidate matches the show we asked for, most-confident first:
//   3   canonical series title equals ours exactly ("Chainsaw Man" TV, not the
//       "Chainsaw Man: Reze Hen" movie)
//   2.5 our title is contained in the canonical series title
//   2   our title appears as a phrase in the release name (space-insensitive) —
//       catches romaji releases of an English-canonical show ("Kimi no Na wa")
//   0-1 fraction of our distinctive words present (weak fallback)
function relevanceScore(c: Candidate, titleNorm: string, queryTokens: string[]): number {
  const titleCollapsed = titleNorm.replace(/ /g, '')
  const st = c.seriesTitle ? norm(c.seriesTitle) : ''
  if (st) {
    if (st === titleNorm) return 3
    if (titleCollapsed.length >= 5 && st.replace(/ /g, '').includes(titleCollapsed)) return 2.5
  }
  const cand = norm(c.name)
  if (titleCollapsed.length >= 5 && cand.replace(/ /g, '').includes(titleCollapsed)) return 2
  if (queryTokens.length === 0) return 1
  return queryTokens.filter((t) => cand.includes(t)).length / queryTokens.length
}

interface SearchOpts {
  resolution: string
  requireResolution: boolean
  preferDualAudio: boolean
  requireDualAudio: boolean
  minSeeders: number
  excludeCodecs: string[] // video codecs to drop outright, e.g. ['av1']
}

function passesFilters(c: Candidate, o: SearchOpts): boolean {
  // Seeder floor only applies when the provider reports seeders (TsukiHime doesn't).
  if (o.minSeeders > 0 && c.seeders != null && c.seeders < o.minSeeders) return false
  if (o.requireResolution && o.resolution && c.resolution !== o.resolution) return false
  if (o.requireDualAudio && !c.dualAudio) return false
  // Drop unplayable codecs (only when detected — an untagged release is kept).
  if (c.videoCodec && o.excludeCodecs.includes(c.videoCodec)) return false
  return true
}

function scoreCandidate(c: Candidate, o: SearchOpts): number {
  let s = 0
  if (o.resolution && c.resolution === o.resolution) s += 1000
  else s += (RES_RANK[c.resolution] ?? 0) * 100 // closeness when off-target
  if (c.dualAudio) s += o.preferDualAudio ? 400 : 100
  // Prefer codecs the server can hardware-decode. Our Tesla T4 (Turing) can't
  // HW-decode AV1, so a forced h264 transcode of AV1 stalls; h264 direct-plays
  // and HEVC HW-transcodes. Penalty (600) outweighs the seeder cap (500) so a
  // playable release always beats a higher-seeded AV1 one.
  if (c.videoCodec === 'h264') s += 300
  else if (c.videoCodec === 'hevc') s += 250
  else if (c.videoCodec === 'av1') s -= 600
  s += Math.min(c.seeders ?? 0, 500) // seeders, capped so they don't dominate quality
  return s
}

function candidateFields(c: Candidate): FlowItem {
  return {
    torrent_name: c.name,
    torrent_magnet: c.magnet,
    torrent_hash: c.hash,
    torrent_size: c.size,
    torrent_seeders: c.seeders,
    torrent_resolution: c.resolution || null,
    torrent_dual_audio: c.dualAudio,
    torrent_codec: c.videoCodec || null,
    torrent_is_batch: c.isBatch,
    torrent_episode: c.episode,
  }
}

const torrentSearch: NodeImpl = {
  spec: {
    type: 'enrich.torrent-search',
    label: 'Torrent search',
    category: 'enrich',
    description:
      'Searches a torrent index per item, scores results by resolution/audio/seeders, and picks a season-pack batch or one release per episode.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'found', label: 'found' },
      { id: 'missed', label: 'missed' },
    ],
    config: [
      {
        key: 'provider',
        label: 'Provider',
        kind: 'select',
        options: [
          { value: 'animetosho', label: 'Anime Tosho (has seeders)' },
          { value: 'tsukihime', label: 'TsukiHime (no seeders)' },
        ],
        default: 'animetosho',
      },
      { key: 'baseUrl', label: 'Index base URL', kind: 'text', default: '', help: 'Override the provider’s API host. Empty = default.' },
      { key: 'queryField', label: 'Query field', kind: 'text', default: 'torrent_query' },
      {
        key: 'mode',
        label: 'What to grab',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto (batch if finished, episodes if airing)' },
          { value: 'batch', label: 'Season pack (batch)' },
          { value: 'episode', label: 'Individual episodes' },
        ],
        default: 'auto',
        help: 'Auto reads the item’s want_mode / air_status (set by the Anime status node).',
      },
      { key: 'resolution', label: 'Resolution', kind: 'select', options: [
        { value: '1080p', label: '1080p' },
        { value: '720p', label: '720p' },
        { value: '2160p', label: '2160p (4K)' },
        { value: '', label: 'Any' },
      ], default: '1080p' },
      { key: 'requireResolution', label: 'Require exact resolution', kind: 'boolean', default: false, help: 'Off = prefer it but accept the best available.' },
      { key: 'preferDualAudio', label: 'Prefer dual audio (EN+JP)', kind: 'boolean', default: true },
      { key: 'requireDualAudio', label: 'Require dual audio', kind: 'boolean', default: false, help: 'Drops releases without English+Japanese audio. Many fansubs are sub-only.' },
      { key: 'excludeCodecs', label: 'Exclude codecs', kind: 'text', default: '', help: 'Comma list of video codecs to drop, e.g. "av1". Our Jellyfin GPU (Tesla T4) can’t hardware-decode AV1, so those stall on playback. h264/HEVC are preferred automatically.' },
      { key: 'minSeeders', label: 'Min seeders', kind: 'number', default: 1, help: 'Drops dead torrents (AnimeTosho only — TsukiHime reports no seeders).' },
      { key: 'minTitleMatch', label: 'Title match (0-1)', kind: 'number', default: 0.5, help: 'Min fraction of the show’s title words a result must contain. Guards against the index returning a different show.' },
      { key: 'maxEpisodes', label: 'Max episodes', kind: 'number', default: 26, help: 'Episode mode: cap on how many recent episodes to queue per show.' },
      { key: 'maxItems', label: 'Max shows', kind: 'number', default: 10, help: 'Safety cap of searches per run. 0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const provider = str(config, 'provider', 'animetosho')
    const base =
      str(config, 'baseUrl', '').replace(/\/$/, '') ||
      (provider === 'tsukihime' ? TSUKI_URL : TOSHO_URL)
    const queryField = str(config, 'queryField', 'torrent_query')
    const configMode = str(config, 'mode', 'auto')
    const opts: SearchOpts = {
      resolution: str(config, 'resolution', '1080p'),
      requireResolution: bool(config, 'requireResolution', false),
      preferDualAudio: bool(config, 'preferDualAudio', true),
      requireDualAudio: bool(config, 'requireDualAudio', false),
      minSeeders: num(config, 'minSeeders', 1),
      excludeCodecs: str(config, 'excludeCodecs', '')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    }
    const maxEpisodes = Math.max(1, num(config, 'maxEpisodes', 26))
    const minTitleMatch = num(config, 'minTitleMatch', 0.5)
    const maxItems = num(config, 'maxItems', 10)

    const items = allInputs(inputs)
    const found: FlowItem[] = []
    const missed: FlowItem[] = []
    let queried = 0

    for (const item of items) {
      const q = String(item[queryField] ?? '').trim()
      if (!q || (maxItems > 0 && queried >= maxItems)) {
        missed.push(item)
        continue
      }
      queried++

      // Resolve batch-vs-episode per item.
      let mode = configMode
      if (mode === 'auto') {
        const wm = String(item.want_mode ?? '')
        if (wm === 'episode' || wm === 'batch') mode = wm
        else mode = String(item.air_status ?? '') === 'airing' ? 'episode' : 'batch'
      }

      // Match on the show's title (prefer a clean field over the query, which
      // carries quality words like "1080p").
      const showTitle = String(item.title ?? item.name ?? q)
      const titleNorm = norm(showTitle)
      const qTokens = significantTokens(showTitle + ' ' + q)

      // Authoritative per-season id (set by the Anime status node from the MAL
      // id). Each provider tags releases with its own canonical id — AnimeTosho's
      // AniDB aid, TsukiHime's anime.id — so this pins the exact season, the only
      // reliable way to tell e.g. Frieren S1 from S2, which share a title.
      const knownPin = provider === 'tsukihime' ? Number(item.tsuki_id) : Number(item.anidb_id)
      const havePin = Number.isFinite(knownPin) && knownPin > 0

      try {
        const raw =
          provider === 'tsukihime'
            ? await tsukiCandidates(q, base)
            : await toshoCandidates(q, base)

        let relevant: Candidate[]
        // Only trust the pin when the results actually carry ids (a provider can
        // return untagged releases); otherwise fall through to title relevance.
        if (havePin && raw.some((c) => c.pinId != null)) {
          // Keep only this season's releases, discarding everything else. If none
          // exist yet — e.g. no dual-audio release of this season is posted — this
          // is empty and the item exits "missed", never a different season.
          // Grabbing e.g. Frieren S2 for an S1 upgrade would overwrite S1
          // (episode numbers reset per season).
          relevant = raw.filter((c) => c.pinId === knownPin)
          if (relevant.length === 0 && raw.length > 0) {
            ctx.notes.push(`no season-${knownPin} releases for "${q}" (${raw.length} other-season results ignored)`)
          }
        } else {
          // No season id (unknown status, or an untagged result set): anchor on
          // the most title-relevant release, then trust its id to gather that
          // show's other releases (English + romaji variants).
          let best = { c: null as Candidate | null, rel: 0 }
          for (const c of raw) {
            const rel = relevanceScore(c, titleNorm, qTokens)
            if (rel > best.rel) best = { c, rel }
          }
          relevant =
            best.c && best.rel >= minTitleMatch
              ? best.c.pinId != null
                ? raw.filter((c) => c.pinId === best.c!.pinId)
                : raw.filter((c) => relevanceScore(c, titleNorm, qTokens) >= minTitleMatch)
              : []
        }
        const blocked = blacklistedHashes()
        const cands = relevant
          .filter((c) => !c.hash || !blocked.has(c.hash.toLowerCase()))
          .filter((c) => passesFilters(c, opts))
        const blacklistedOut = relevant.length - relevant.filter((c) => !c.hash || !blocked.has(c.hash.toLowerCase())).length
        if (blacklistedOut > 0) ctx.notes.push(`skipped ${blacklistedOut} blacklisted release(s) for "${q}"`)

        if (cands.length === 0) {
          missed.push(item)
          const why =
            raw.length > 0 && relevant.length === 0
              ? `no title-relevant releases for "${q}" (${raw.length} off-title results ignored)`
              : `no releases passed filters for "${q}"`
          ctx.notes.push(why)
        } else if (mode === 'episode') {
          // Best release per episode number, most recent episodes first.
          const byEp = new Map<number, Candidate>()
          for (const c of cands) {
            if (c.isBatch || c.episode == null) continue
            const cur = byEp.get(c.episode)
            if (!cur || scoreCandidate(c, opts) > scoreCandidate(cur, opts)) byEp.set(c.episode, c)
          }
          const eps = [...byEp.entries()].sort((a, b) => b[0] - a[0]).slice(0, maxEpisodes)
          if (eps.length === 0) {
            missed.push(item)
            ctx.notes.push(`no single-episode releases for "${q}"`)
          } else {
            for (const [, c] of eps) found.push({ ...item, ...candidateFields(c) })
            ctx.notes.push(`${q}: ${eps.length} episode(s), best seeders ${Math.max(...eps.map(([, c]) => c.seeders ?? 0))}`)
          }
        } else {
          // Season pack: highest-scoring batch, or best overall if none flagged batch.
          const batches = cands.filter((c) => c.isBatch)
          const pool = batches.length > 0 ? batches : cands
          const best = pool.sort((a, b) => scoreCandidate(b, opts) - scoreCandidate(a, opts))[0]
          found.push({ ...item, ...candidateFields(best) })
          ctx.notes.push(
            `${q}: ${best.resolution || '?'} ${best.videoCodec || '?'} ${best.dualAudio ? 'dual' : 'sub'} ${best.isBatch ? 'batch' : 'single'} · ${best.seeders ?? '?'} seeders`,
          )
        }
      } catch (e) {
        ctx.notes.push(`search error for "${q}": ${e instanceof Error ? e.message : String(e)}`)
        missed.push(item)
      }
      // Rate-limit spacing is handled by the shared queue (tsukihime/tosho keys).
    }
    if (maxItems > 0 && items.length > maxItems) {
      ctx.notes.push(`capped at ${maxItems} of ${items.length} shows`)
    }
    return { found, missed }
  },
}

const animeStatus: NodeImpl = {
  spec: {
    type: 'enrich.anime-status',
    label: 'Anime status',
    category: 'enrich',
    description:
      'Looks up airing status + episode count by MAL id (TsukiHime) and sets air_status / total_episodes / is_movie / want_mode.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'out', label: 'out' },
      { id: 'unknown', label: 'unknown' },
    ],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      { key: 'baseUrl', label: 'API base URL', kind: 'text', default: '', help: 'Empty = TsukiHime default.' },
      { key: 'maxItems', label: 'Max lookups', kind: 'number', default: 25, help: '0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const base = str(config, 'baseUrl', '').replace(/\/$/, '') || TSUKI_URL
    const maxItems = num(config, 'maxItems', 25)
    const out: FlowItem[] = []
    const unknown: FlowItem[] = []
    let looked = 0
    for (const item of allInputs(inputs)) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0 || (maxItems > 0 && looked >= maxItems)) {
        unknown.push(item)
        continue
      }
      looked++
      try {
        const a = (await fetchJson(`${base}/v1/animes/mal/${mal}`)) as Record<string, unknown>
        const isMovie = Boolean(a.is_movie)
        // TsukiHime air_status: 1 = airing, 2 = finished.
        const airStatus = a.air_status === 1 ? 'airing' : a.air_status === 2 ? 'finished' : 'unknown'
        const wantMode = airStatus === 'airing' ? 'episode' : 'batch'
        out.push({
          ...item,
          air_status: airStatus,
          total_episodes: a.total_episodes ?? null,
          is_movie: isMovie,
          want_mode: wantMode,
          // Authoritative per-season ids — let torrent search disambiguate
          // seasons that share a title (Frieren S1 vs S2). anidb_id pins
          // AnimeTosho; tsuki_id (TsukiHime's own anime.id) pins TsukiHime, which
          // tags seasons more reliably than AnimeTosho does.
          anidb_id: a.anidb != null ? Number(a.anidb) : null,
          tsuki_id: a.id != null ? Number(a.id) : null,
          anilist_id: a.anilist != null ? Number(a.anilist) : null,
        })
      } catch {
        // Unknown status → default to batch downstream, but route separately.
        unknown.push({ ...item, air_status: 'unknown', want_mode: 'batch' })
      }
      // TsukiHime default limit is 120 req/min; 550ms spacing (~109/min) stays
      // under it with headroom.
      await new Promise((r) => setTimeout(r, 550))
    }
    ctx.notes.push(`resolved status for ${out.length}, ${unknown.length} unknown`)
    return { out, unknown }
  },
}

// ---------------------------------------------------------------------------
// Library-import stage: expand a torrent into its video files, probe them for
// subtitle tracks, extract embedded subs we own, then place the files. These
// need the downloaded files mounted into the pod (see the source.qbittorrent
// path remap) and ffmpeg/ffprobe on PATH.
// ---------------------------------------------------------------------------
const VIDEO_EXTS_DEFAULT = 'mkv,mp4,avi,m4v,mov'
const WORK_DIR = () => process.env.DATA_DIR ?? path.join(process.cwd(), 'data')

function walkFiles(root: string, exts: Set<string>, out: string[]): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(root)
  } catch {
    return
  }
  if (stat.isFile()) {
    if (exts.has(path.extname(root).slice(1).toLowerCase())) out.push(root)
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of fs.readdirSync(root)) {
    // Skip sample dirs/files — a common torrent nuisance that mis-imports.
    if (/^sample$/i.test(entry) || /\bsample\b/i.test(entry)) continue
    walkFiles(path.join(root, entry), exts, out)
  }
}

const expandFiles: NodeImpl = {
  spec: {
    type: 'transform.expand-files',
    label: 'Expand to files',
    category: 'enrich',
    description:
      'Turns each item into one item per video file at its path (recurses into folders for season packs). Re-parses the episode number from each file name.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'files', label: 'files' },
      { id: 'empty', label: 'no files' },
    ],
    config: [
      { key: 'pathField', label: 'Path field', kind: 'text', default: 'content_path' },
      { key: 'extensions', label: 'Video extensions', kind: 'text', default: VIDEO_EXTS_DEFAULT, help: 'Comma-separated, no dots.' },
    ],
  },
  async run(inputs, config, ctx) {
    const pathField = str(config, 'pathField', 'content_path')
    const exts = new Set(
      str(config, 'extensions', VIDEO_EXTS_DEFAULT).split(',').map((e) => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean),
    )
    const files: FlowItem[] = []
    const empty: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      const p = String(item[pathField] ?? '')
      const found: string[] = []
      if (p) walkFiles(p, exts, found)
      if (found.length === 0) {
        empty.push(item)
        continue
      }
      for (const filePath of found.sort()) {
        const fileName = path.basename(filePath)
        let size: number | null = null
        try { size = fs.statSync(filePath).size } catch { /* raced deletion */ }
        files.push({
          ...item,
          file_path: filePath,
          file_name: fileName,
          file_size: size,
          // Per-file episode is more reliable than the torrent name for batches.
          torrent_episode: parseEpisode(fileName) ?? item.torrent_episode ?? null,
        })
      }
    }
    ctx.notes.push(`${files.length} file(s) from ${allInputs(inputs).length} item(s), ${empty.length} with none`)
    return { files, empty }
  },
}

interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  tags?: { language?: string; title?: string }
}

const mediaProbe: NodeImpl = {
  spec: {
    type: 'enrich.media-probe',
    label: 'Probe media',
    category: 'enrich',
    description:
      'ffprobes the video file and emits its stream facts (sub_langs, sub_codecs, sub_track_count, audio_langs, video_codec) plus a sub_tracks list for the extractor. Branch on these with a Compare node.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'probed', label: 'probed' },
      { id: 'error', label: 'error' },
    ],
    config: [
      { key: 'fileField', label: 'File field', kind: 'text', default: 'file_path' },
    ],
  },
  async run(inputs, config, ctx) {
    const fileField = str(config, 'fileField', 'file_path')
    const probed: FlowItem[] = []
    const error: FlowItem[] = []
    let firstErr = ''
    for (const item of allInputs(inputs)) {
      const file = String(item[fileField] ?? '')
      if (!file) { error.push(item); continue }
      try {
        const { stdout } = await execFileP(
          'ffprobe',
          ['-v', 'quiet', '-print_format', 'json', '-show_streams', file],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        )
        const streams = (JSON.parse(stdout).streams ?? []) as ProbeStream[]
        // Subtitle-relative index is what `ffmpeg -map 0:s:N` wants.
        let subOrdinal = 0
        const subTracks = streams
          .filter((s) => s.codec_type === 'subtitle')
          .map((s) => ({
            index: subOrdinal++,
            lang: s.tags?.language ?? '',
            codec: s.codec_name ?? '',
            title: s.tags?.title ?? '',
          }))
        const audioLangs = streams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => s.tags?.language ?? '')
          .filter(Boolean)
        const video = streams.find((s) => s.codec_type === 'video')
        probed.push({
          ...item,
          sub_track_count: subTracks.length,
          sub_langs: subTracks.map((t) => t.lang).filter(Boolean).join(','),
          sub_codecs: subTracks.map((t) => t.codec).filter(Boolean).join(','),
          sub_tracks: JSON.stringify(subTracks),
          audio_langs: audioLangs.join(','),
          video_codec: video?.codec_name ?? '',
        })
      } catch (e) {
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e)
        error.push(item)
      }
    }
    if (error.length > 0) ctx.notes.push(`${error.length} probe failure(s) (${firstErr})`)
    return { probed, error }
  },
}

// ffmpeg subtitle codec -> sidecar extension. Text subs become .ass/.srt we own;
// image subs (PGS/VobSub) can't be turned into text, so the extractor skips them.
const SUB_EXT: Record<string, string> = { ass: 'ass', ssa: 'ass', subrip: 'srt', srt: 'srt', webvtt: 'vtt', mov_text: 'srt' }

const extractSubs: NodeImpl = {
  spec: {
    type: 'enrich.extract-subs',
    label: 'Extract subtitles',
    category: 'enrich',
    description:
      'Pulls an embedded text subtitle track out of the file into a sidecar we own (sets subtitle_path/subtitle_lang), plus any embedded fonts. Picks by language, with fallback. Image subs (PGS/VobSub) can’t be extracted.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'extracted', label: 'extracted' },
      { id: 'none', label: 'no track' },
    ],
    config: [
      { key: 'fileField', label: 'File field', kind: 'text', default: 'file_path' },
      { key: 'lang', label: 'Preferred language', kind: 'text', default: 'eng', help: 'ISO code(s) to prefer, comma-separated, e.g. "eng,en". Empty = first text track.' },
      { key: 'fallbackFirst', label: 'Fall back to first track', kind: 'boolean', default: true, help: 'If no language match, take the first text subtitle track anyway.' },
      { key: 'trackIndexField', label: 'Track index field', kind: 'text', default: '', help: 'If set and present on the item, extract exactly this subtitle-relative index (overrides language pick).' },
      { key: 'outDir', label: 'Output dir', kind: 'text', default: '', help: 'Where sidecars are written. Empty = DATA_DIR/work.' },
      { key: 'extractFonts', label: 'Extract embedded fonts', kind: 'boolean', default: true },
    ],
  },
  async run(inputs, config, ctx) {
    const fileField = str(config, 'fileField', 'file_path')
    const langPref = str(config, 'lang', 'eng').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const fallbackFirst = bool(config, 'fallbackFirst', true)
    const trackIndexField = str(config, 'trackIndexField', '')
    const outDir = str(config, 'outDir', '') || path.join(WORK_DIR(), 'work')
    const extractFonts = bool(config, 'extractFonts', true)

    interface SubTrack { index: number; lang: string; codec: string; title: string }
    const extracted: FlowItem[] = []
    const none: FlowItem[] = []

    for (const item of allInputs(inputs)) {
      const file = String(item[fileField] ?? '')
      let tracks: SubTrack[] = []
      try {
        tracks = item.sub_tracks ? (JSON.parse(String(item.sub_tracks)) as SubTrack[]) : []
      } catch { /* fall through to no-track */ }
      // Only text codecs we can turn into a sidecar.
      const textTracks = tracks.filter((t) => SUB_EXT[t.codec.toLowerCase()])
      if (!file || textTracks.length === 0) { none.push(item); continue }

      // Choose the track: explicit index field > language preference > first.
      let pick: SubTrack | undefined
      const forced = trackIndexField ? Number(item[trackIndexField]) : NaN
      if (Number.isFinite(forced)) pick = textTracks.find((t) => t.index === forced)
      if (!pick) {
        for (const lang of langPref) {
          pick = textTracks.find((t) => t.lang.toLowerCase() === lang || t.lang.toLowerCase().startsWith(lang))
          if (pick) break
        }
      }
      if (!pick && (fallbackFirst || langPref.length === 0)) pick = textTracks[0]
      if (!pick) { none.push(item); continue }

      const ext = SUB_EXT[pick.codec.toLowerCase()]
      const base = path.basename(file, path.extname(file))
      const langTag = pick.lang || 'und'
      const subDir = path.join(outDir, base)
      const subPath = path.join(subDir, `${base}.${langTag}.${ext}`)
      try {
        if (!ctx.dryRun) {
          fs.mkdirSync(subDir, { recursive: true })
          await execFileP(
            'ffmpeg',
            ['-y', '-v', 'error', '-i', file, '-map', `0:s:${pick.index}`, '-c:s', ext === 'ass' ? 'ass' : ext === 'srt' ? 'srt' : 'webvtt', subPath],
            { timeout: 120_000 },
          )
          if (extractFonts) {
            // Dump every attachment (fonts) into the sidecar dir; harmless if none.
            try {
              await execFileP('ffmpeg', ['-y', '-v', 'error', '-dump_attachment:t', '', '-i', file], {
                timeout: 60_000,
                cwd: subDir,
              })
            } catch { /* attachments are best-effort; -dump_attachment exits nonzero when there are none */ }
          }
        }
        extracted.push({
          ...item,
          subtitle_path: subPath,
          subtitle_lang: langTag,
          subtitle_codec: ext,
          subtitle_dir: subDir,
        })
      } catch (e) {
        ctx.notes.push(`extract failed for ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`)
        none.push(item)
      }
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would extract ${extracted.length} sidecar(s)`
        : `extracted ${extracted.length} sidecar(s), ${none.length} without a text track`,
    )
    return { extracted, none }
  },
}

// External subtitle fallback via Jimaku (jimaku.cc) — for releases with no good
// embedded sub in the target language. Keys on AniList id when available, else a
// title query. Needs JIMAKU_API_KEY; without it the node passes items straight
// to "missed" so the graph can route them elsewhere.
const JIMAKU_URL = process.env.JIMAKU_URL ?? 'https://jimaku.cc/api'

const fetchSubs: NodeImpl = {
  spec: {
    type: 'enrich.fetch-subs',
    label: 'Fetch subtitles (Jimaku)',
    category: 'enrich',
    description:
      'Downloads an external subtitle from Jimaku for the item’s episode when the release has none in the wanted language. Sets subtitle_path/lang/codec like the extractor, so import handles it identically. Needs JIMAKU_API_KEY.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'found', label: 'found' },
      { id: 'missed', label: 'missed' },
    ],
    config: [
      { key: 'apiKey', label: 'Jimaku API key', kind: 'password', default: '', help: 'Empty = JIMAKU_API_KEY env.' },
      { key: 'baseUrl', label: 'API base URL', kind: 'text', default: '', help: 'Empty = jimaku.cc default.' },
      { key: 'anilistField', label: 'AniList id field', kind: 'text', default: 'anilist_id', help: 'Preferred lookup key when present.' },
      { key: 'queryField', label: 'Title query field', kind: 'text', default: 'title', help: 'Fallback lookup when no AniList id.' },
      { key: 'episodeField', label: 'Episode field', kind: 'text', default: 'torrent_episode' },
      { key: 'lang', label: 'Language tag', kind: 'text', default: 'eng', help: 'Recorded as subtitle_lang on the sidecar.' },
      { key: 'outDir', label: 'Output dir', kind: 'text', default: '', help: 'Empty = DATA_DIR/work.' },
      { key: 'maxItems', label: 'Max lookups', kind: 'number', default: 25, help: '0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const apiKey = str(config, 'apiKey', '') || process.env.JIMAKU_API_KEY || ''
    const base = (str(config, 'baseUrl', '') || JIMAKU_URL).replace(/\/$/, '')
    const anilistField = str(config, 'anilistField', 'anilist_id')
    const queryField = str(config, 'queryField', 'title')
    const episodeField = str(config, 'episodeField', 'torrent_episode')
    const lang = str(config, 'lang', 'eng')
    const outDir = str(config, 'outDir', '') || path.join(WORK_DIR(), 'work')
    const maxItems = num(config, 'maxItems', 25)

    const items = allInputs(inputs)
    const found: FlowItem[] = []
    const missed: FlowItem[] = []

    if (!apiKey) {
      ctx.notes.push('no Jimaku API key (config or JIMAKU_API_KEY) — passing all items to "missed"')
      return { found, missed: items }
    }

    const jimaku = async (path: string): Promise<unknown> => {
      const res = await limitedFetch('jimaku', base + path, {
        headers: { Authorization: apiKey, Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
      if (!res.ok) throw new Error(`Jimaku ${res.status} ${res.statusText}`)
      return res.json()
    }

    let looked = 0
    for (const item of items) {
      const ep = Number(item[episodeField])
      const anilist = Number(item[anilistField])
      const query = String(item[queryField] ?? '').trim()
      if ((maxItems > 0 && looked >= maxItems) || (!Number.isFinite(anilist) && !query)) {
        missed.push(item)
        continue
      }
      looked++
      try {
        const search =
          Number.isFinite(anilist) && anilist > 0
            ? `/entries/search?anilist_id=${anilist}`
            : `/entries/search?query=${encodeURIComponent(query)}`
        const entries = (await jimaku(search)) as { id: number; name?: string }[]
        if (!Array.isArray(entries) || entries.length === 0) {
          missed.push(item)
          ctx.notes.push(`no Jimaku entry for "${query || anilist}"`)
          continue
        }
        const files = (await jimaku(`/entries/${entries[0].id}/files`)) as { name: string; url: string }[]
        // Match the file to this episode; if the item has no episode (movie /
        // batch), take the only/first file.
        const pickFile =
          Number.isFinite(ep)
            ? files.find((f) => parseEpisode(f.name) === ep)
            : files.length === 1
              ? files[0]
              : undefined
        if (!pickFile) {
          missed.push(item)
          ctx.notes.push(`no Jimaku file for "${query || anilist}"${Number.isFinite(ep) ? ` ep ${ep}` : ''}`)
          continue
        }
        const codec = /\.srt$/i.test(pickFile.name) ? 'srt' : /\.vtt$/i.test(pickFile.name) ? 'vtt' : 'ass'
        const baseName = String(item.file_name ? path.basename(String(item.file_name), path.extname(String(item.file_name))) : (query || `entry-${entries[0].id}`))
        const subDir = path.join(outDir, baseName)
        const subPath = path.join(subDir, `${baseName}.${lang}.${codec}`)
        if (!ctx.dryRun) {
          const dl = await fetch(pickFile.url, { signal: AbortSignal.timeout(30_000) })
          if (!dl.ok) throw new Error(`download ${dl.status}`)
          fs.mkdirSync(subDir, { recursive: true })
          fs.writeFileSync(subPath, Buffer.from(await dl.arrayBuffer()))
        }
        found.push({ ...item, subtitle_path: subPath, subtitle_lang: lang, subtitle_codec: codec, subtitle_dir: subDir, subtitle_source: 'jimaku' })
      } catch (e) {
        ctx.notes.push(`Jimaku error for "${query || anilist}": ${e instanceof Error ? e.message : String(e)}`)
        missed.push(item)
      }
      // Jimaku API spacing handled by the shared 'jimaku' queue.
    }
    ctx.notes.push(ctx.dryRun ? `dry run — resolved ${found.length} Jimaku sub(s)` : `fetched ${found.length} sub(s), ${missed.length} missed`)
    return { found, missed }
  },
}

// Combine a playable video (release A) with an audio/sub track stolen from a
// donor file (release B) into one stream-copied MKV — no video re-encode. This
// manufactures a *playable* dual-audio file (h264 + jpn + eng) from a sub-only
// h264 release + a dual (often AV1) donor, sidestepping the T4's inability to
// HW-decode AV1. Only safe for same-source (same edit + framerate) pairs; sync
// was validated for BD↔WEB Frieren (see docs/dual-audio-mux-plan.md).
const muxTracks: NodeImpl = {
  spec: {
    type: 'enrich.mux-tracks',
    label: 'Mux in tracks',
    category: 'enrich',
    description:
      'Muxes an audio (and/or subtitle) track from a donor file onto the primary video, stream-copied into a new MKV (no re-encode). Use to build a playable dual-audio file: playable h264 primary + eng dub from a dual donor. Same-source pairs only (matching edit/framerate); audioOffset corrects a constant delay.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'muxed', label: 'muxed' },
      { id: 'skipped', label: 'skipped' },
    ],
    config: [
      { key: 'fileField', label: 'Primary file field', kind: 'text', default: 'file_path', help: 'The playable video source; its video + audio are kept as-is.' },
      { key: 'donorField', label: 'Donor file field', kind: 'text', default: 'donor_path', help: 'The file to steal tracks from (e.g. the existing dual library file).' },
      { key: 'audioLang', label: 'Donor audio language', kind: 'text', default: 'eng', help: 'ISO code(s) of the donor audio track to add, comma-separated. Empty = add no audio.' },
      { key: 'subLang', label: 'Donor subtitle language', kind: 'text', default: '', help: 'ISO code(s) of the donor text subtitle track to add. Empty = add no sub. Image subs (PGS) are skipped.' },
      { key: 'audioOffset', label: 'Audio offset (s)', kind: 'number', default: 0, help: 'Seconds to shift the donor track (-itsoffset). Constant-delay correction; 0 for same-edit pairs.' },
      { key: 'outDir', label: 'Output dir', kind: 'text', default: '', help: 'Where the muxed MKV lands. Empty = DATA_DIR/work.' },
      { key: 'setDefaultAudio', label: 'Default audio language', kind: 'text', default: 'jpn', help: 'Which output audio language is flagged default. Empty = leave source dispositions.' },
    ],
  },
  async run(inputs, config, ctx) {
    const fileField = str(config, 'fileField', 'file_path')
    const donorField = str(config, 'donorField', 'donor_path')
    const audioLangs = str(config, 'audioLang', 'eng').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const subLangs = str(config, 'subLang', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const audioOffset = num(config, 'audioOffset', 0)
    const outDir = str(config, 'outDir', '') || path.join(WORK_DIR(), 'work')
    const defaultLangs = str(config, 'setDefaultAudio', 'jpn').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

    const matchLang = (lang: string, wanted: string[]): boolean =>
      wanted.some((w) => lang === w || (w.length > 0 && lang.startsWith(w)))
    const probe = async (file: string): Promise<ProbeStream[]> => {
      const { stdout } = await execFileP(
        'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_streams', file],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      )
      return (JSON.parse(stdout).streams ?? []) as ProbeStream[]
    }

    const muxed: FlowItem[] = []
    const skipped: FlowItem[] = []

    for (const item of allInputs(inputs)) {
      const primary = String(item[fileField] ?? '')
      const donor = String(item[donorField] ?? '')
      if (!primary || !donor || !fs.existsSync(primary) || !fs.existsSync(donor)) {
        ctx.notes.push(`skip: missing primary/donor file (${path.basename(primary || '?')} / ${path.basename(donor || '?')})`)
        skipped.push(item)
        continue
      }
      try {
        const [primaryStreams, donorStreams] = await Promise.all([probe(primary), probe(donor)])

        // Audio/subtitle indices are *codec-relative* (what `-map 1:a:N` / `1:s:N` want).
        let paOrd = 0
        const primaryAudio = primaryStreams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => ({ ord: paOrd++, lang: (s.tags?.language ?? '').toLowerCase() }))
        let daOrd = 0
        const donorAudio = donorStreams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => ({ ord: daOrd++, lang: (s.tags?.language ?? '').toLowerCase() }))
        let dsOrd = 0
        const donorSubs = donorStreams
          .filter((s) => s.codec_type === 'subtitle')
          .map((s) => ({ ord: dsOrd++, lang: (s.tags?.language ?? '').toLowerCase(), codec: (s.codec_name ?? '').toLowerCase() }))

        const donorAudioPick = audioLangs.length > 0 ? donorAudio.find((a) => matchLang(a.lang, audioLangs)) : undefined
        // Text subs only (same limit as extract-subs); image subs can't be relied on.
        const donorSubPick = subLangs.length > 0
          ? donorSubs.find((s) => SUB_EXT[s.codec] && matchLang(s.lang, subLangs))
          : undefined

        if (!donorAudioPick && !donorSubPick) {
          ctx.notes.push(`skip: donor has no matching ${audioLangs.join('/')||'audio'}${subLangs.length ? `/${subLangs.join('/')} sub` : ''} track (${path.basename(donor)})`)
          skipped.push(item)
          continue
        }

        // Output audio order = primary audio (0..N-1) then the appended donor track.
        const outAudioCount = primaryAudio.length + (donorAudioPick ? 1 : 0)
        let defaultIdx = -1
        if (defaultLangs.length > 0) {
          const inPrimary = primaryAudio.find((a) => matchLang(a.lang, defaultLangs))
          if (inPrimary) defaultIdx = inPrimary.ord
          else if (donorAudioPick && matchLang(donorAudioPick.lang, defaultLangs)) defaultIdx = primaryAudio.length
        }

        const base = path.basename(primary, path.extname(primary))
        const outPath = path.join(outDir, `${base}.mkv`)

        const args = ['-y', '-v', 'error', '-i', primary]
        if (audioOffset) args.push('-itsoffset', String(audioOffset))
        args.push('-i', donor, '-map', '0:v', '-map', '0:a')
        if (donorAudioPick) args.push('-map', `1:a:${donorAudioPick.ord}`)
        if (donorSubPick) args.push('-map', `1:s:${donorSubPick.ord}`)
        args.push('-c', 'copy')
        if (defaultIdx >= 0) {
          for (let i = 0; i < outAudioCount; i++) args.push(`-disposition:a:${i}`, i === defaultIdx ? 'default' : '0')
        }
        args.push(outPath)

        if (!ctx.dryRun) {
          fs.mkdirSync(outDir, { recursive: true })
          // Idempotent on a schedule: skip re-encoding if the output already
          // exists and is at least as new as both sources.
          let fresh = false
          try {
            const outM = fs.statSync(outPath).mtimeMs
            fresh = outM >= fs.statSync(primary).mtimeMs && outM >= fs.statSync(donor).mtimeMs
          } catch { /* no output yet */ }
          if (fresh) ctx.notes.push(`mux up-to-date, reusing ${path.basename(outPath)}`)
          else await execFileP('ffmpeg', args, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
        }
        muxed.push({
          ...item,
          [fileField]: outPath,
          mux_added_audio: donorAudioPick ? donorAudioPick.lang || 'und' : '',
          mux_added_sub: donorSubPick ? donorSubPick.lang || 'und' : '',
          mux_source: primary,
          mux_donor: donor,
        })
      } catch (e) {
        ctx.notes.push(`mux failed for ${path.basename(primary)}: ${e instanceof Error ? e.message : String(e)}`)
        skipped.push(item)
      }
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would mux ${muxed.length} file(s), ${skipped.length} skipped`
        : `muxed ${muxed.length} file(s), ${skipped.length} skipped`,
    )
    return { muxed, skipped }
  },
}

const metadataEnrich: NodeImpl = {
  spec: {
    type: 'enrich.metadata',
    label: 'Fetch metadata (MAL)',
    category: 'enrich',
    description:
      'Pulls full MyAnimeList metadata by mal_id (titles, year, episodes, status, score, studios, genres) into our own catalog DB, and sets those fields on the item (e.g. production_year for the import path). Rate-limited ~1 item/sec.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'enriched', label: 'enriched' },
      { id: 'skipped', label: 'skipped' },
    ],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      { key: 'writeDb', label: 'Write to catalog DB', kind: 'boolean', default: true, help: 'Upsert the metadata into our series catalog (the Jellyfin-independent source of truth).' },
      { key: 'maxItems', label: 'Max lookups', kind: 'number', default: 25, help: '0 = unlimited. Jikan is rate-limited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const writeDb = bool(config, 'writeDb', true)
    const maxItems = num(config, 'maxItems', 25)
    const items = allInputs(inputs)
    const enriched: FlowItem[] = []
    const skipped: FlowItem[] = []
    let looked = 0
    for (const item of items) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0 || (maxItems > 0 && looked >= maxItems)) {
        skipped.push(item)
        continue
      }
      looked++
      try {
        const a = await fetchAnimeFull(mal)
        const studios = JSON.stringify((a.studios ?? []).map((s) => s.name))
        const genres = JSON.stringify((a.genres ?? []).map((g) => g.name))
        const meta = {
          title_english: a.title_english ?? null,
          title_japanese: a.title_japanese ?? null,
          type: a.type ?? null,
          episodes: a.episodes ?? null,
          status: a.status ?? null,
          score: a.score ?? null,
          year: a.year ?? null,
          season: a.season ?? null,
          aired: a.aired?.string ?? null,
          studios,
          genres,
        }
        if (writeDb && !ctx.dryRun) {
          upsertSeriesMetadata(
            { mal_id: mal, title: a.title, synopsis: a.synopsis ?? null, image_url: pickPosterUrl(a as unknown as Parameters<typeof pickPosterUrl>[0]), url: a.url },
            meta,
          )
        }
        enriched.push({
          ...item,
          title_english: meta.title_english,
          title_japanese: meta.title_japanese,
          mal_type: meta.type,
          episodes_total: meta.episodes,
          mal_status: meta.status,
          score: meta.score,
          // MAL's "season" is the airing cour name ("fall"), not a season
          // number — expose it as mal_season so it never lands in the numeric
          // {season} slot of the library path template.
          mal_season: meta.season,
          // Feed the import path template; only set when known so it doesn't
          // clobber an existing production_year.
          ...(meta.year != null ? { production_year: meta.year, year: meta.year } : {}),
          studios,
          genres,
        })
      } catch (e) {
        ctx.notes.push(`metadata lookup failed for mal ${mal}: ${e instanceof Error ? e.message : String(e)}`)
        skipped.push(item)
      }
      // Jikan spacing handled by the shared 'jikan' queue.
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — resolved ${enriched.length} metadata record(s)${writeDb ? ' (not written)' : ''}`
        : `enriched ${enriched.length}${writeDb ? ' (written to catalog)' : ''}, skipped ${skipped.length}`,
    )
    return { enriched, skipped }
  },
}

const qbittorrentSink: NodeImpl = {
  spec: {
    type: 'sink.qbittorrent',
    label: 'Send to qBittorrent',
    category: 'sink',
    description:
      'Adds each item’s magnet link to a qBittorrent instance via its WebUI API.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'sent', label: 'sent' }],
    config: [
      {
        key: 'url',
        label: 'qBittorrent URL',
        kind: 'text',
        default: '',
        help: 'WebUI base URL, e.g. http://[redacted-lan-ip]:8080. Empty = QBIT_URL env.',
      },
      { key: 'username', label: 'Username', kind: 'text', default: '', help: 'Empty = QBIT_USERNAME env.' },
      { key: 'password', label: 'Password', kind: 'password', default: '', help: 'Empty = QBIT_PASSWORD env.' },
      { key: 'urlField', label: 'Magnet field', kind: 'text', default: 'torrent_magnet' },
      { key: 'category', label: 'Category', kind: 'text', default: 'anime' },
      { key: 'savepath', label: 'Save path', kind: 'text', default: '', help: 'Empty = qBittorrent default.' },
      {
        key: 'paused',
        label: 'Add paused',
        kind: 'boolean',
        default: false,
        help: 'Off = start downloading immediately. A paused magnet can’t fetch its metadata (it shows as a bare hash until you resume it).',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const urlField = str(config, 'urlField', 'torrent_magnet')
    const items = allInputs(inputs)
    const withMagnet = items.filter((it) => String(it[urlField] ?? '').startsWith('magnet:'))
    if (items.length > withMagnet.length) {
      ctx.notes.push(`skipped ${items.length - withMagnet.length} items without a magnet link`)
    }
    if (withMagnet.length === 0) return { sent: [] }
    if (ctx.dryRun) {
      ctx.notes.push(`dry run — would send ${withMagnet.length} magnets to qBittorrent`)
      return { sent: withMagnet }
    }

    // Node config wins; env vars are the fallback so credentials can be kept
    // out of the stored graph when preferred.
    const { base, user, pass } = qbitCreds(config)
    const cookie = await qbitLogin(base, user, pass)

    const paused = bool(config, 'paused', false)
    const form = new URLSearchParams({
      urls: withMagnet.map((it) => String(it[urlField])).join('\n'),
      category: str(config, 'category', 'anime'),
      paused: String(paused),
      stopped: String(paused), // qBit >= 5 renamed the flag
    })
    const savepath = str(config, 'savepath', '')
    if (savepath) form.set('savepath', savepath)
    const add = await fetch(`${base}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: form,
      signal: AbortSignal.timeout(15_000),
    })
    if (!add.ok) throw new Error(`qBittorrent add failed (${add.status})`)

    // Give each torrent the readable name we already have from search, keyed by
    // its info-hash. This makes paused magnets (which can't fetch their own
    // metadata) reviewable instead of showing as a bare hash. Best-effort.
    let renamed = 0
    for (const it of withMagnet) {
      const hash = String(it.torrent_hash ?? '').toLowerCase()
      const name = String(it.torrent_name ?? '')
      if (!hash || !name) continue
      try {
        const r = await fetch(`${base}/api/v2/torrents/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
          body: new URLSearchParams({ hash, name }),
          signal: AbortSignal.timeout(10_000),
        })
        if (r.ok) renamed++
      } catch {
        /* rename is cosmetic — never fail the send over it */
      }
    }
    ctx.notes.push(
      `sent ${withMagnet.length} magnet(s) to qBittorrent${paused ? ' (paused)' : ''}` +
        (renamed ? `, named ${renamed}` : ''),
    )
    return { sent: withMagnet }
  },
}

const qbittorrentDelete: NodeImpl = {
  spec: {
    type: 'sink.qbittorrent-delete',
    label: 'Remove from qBittorrent',
    category: 'sink',
    description:
      'Removes each item’s torrent from qBittorrent (deduped by hash), optionally deleting its downloaded files. Use it to retire a release a better one has replaced — safe when the library copy is a hardlink of the NEW release (a different inode survives the delete).',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'removed', label: 'removed' }],
    config: [
      { key: 'url', label: 'qBittorrent URL', kind: 'text', default: '', help: 'Empty = QBIT_URL env.' },
      { key: 'username', label: 'Username', kind: 'text', default: '', help: 'Empty = QBIT_USERNAME env.' },
      { key: 'password', label: 'Password', kind: 'password', default: '', help: 'Empty = QBIT_PASSWORD env.' },
      { key: 'hashField', label: 'Torrent hash field', kind: 'text', default: 'torrent_hash' },
      { key: 'deleteFiles', label: 'Delete downloaded files', kind: 'boolean', default: true, help: 'On = also remove the files from disk. Only feed this fully-superseded torrents (see the Difference node in the seed).' },
    ],
  },
  async run(inputs, config, ctx) {
    const hashField = str(config, 'hashField', 'torrent_hash')
    const deleteFiles = bool(config, 'deleteFiles', true)
    const items = allInputs(inputs)
    const hashes = [
      ...new Set(items.map((it) => String(it[hashField] ?? '').toLowerCase()).filter(Boolean)),
    ]
    if (hashes.length === 0) {
      ctx.notes.push('no torrent hashes to remove')
      return { removed: [] }
    }
    if (ctx.dryRun) {
      ctx.notes.push(`dry run — would remove ${hashes.length} torrent(s)${deleteFiles ? ' + files' : ''}`)
      return { removed: items }
    }
    const { base, user, pass } = qbitCreds(config)
    const cookie = await qbitLogin(base, user, pass)
    const res = await fetch(`${base}/api/v2/torrents/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: String(deleteFiles) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`qBittorrent delete failed (${res.status})`)
    ctx.notes.push(`removed ${hashes.length} torrent(s)${deleteFiles ? ' + files' : ''}`)
    return { removed: items }
  },
}

// Fills a path template with an item's fields. {field} is the raw value;
// {field:2} zero-pads a number to 2 digits (season/episode). Unknown fields ->
// empty. Slashes in the template make directories.
function fillPathTemplate(tpl: string, item: FlowItem): string {
  return tpl.replace(/\{([^}:]+)(?::(\d+))?\}/g, (_, key: string, pad?: string) => {
    const v = item[key.trim()]
    if (v == null) return ''
    if (pad) {
      const n = asNumber(v)
      if (n != null) return String(Math.trunc(n)).padStart(Number(pad), '0')
    }
    return String(v)
  })
}

// Strip characters that are illegal or troublesome in file paths, per path
// segment (so template slashes still create directories).
function sanitizeSegments(rel: string): string {
  return rel
    .split('/')
    .map((seg) =>
      seg
        .replace(/[<>:"\\|?*\x00-\x1f]/g, '')
        .replace(/\(\s*\)/g, '') // drop empty "()" left by a missing {production_year}
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\.+$/, ''),
    )
    .filter(Boolean)
    .join('/')
}

const LIBRARY_DIR = () => process.env.LIBRARY_DIR ?? '/library'

// "Is the file already in the library this exact release?" Our imports hardlink,
// so a re-run's src and the dest it produced share an inode — cheap, exact skip
// that keeps scheduled runs idempotent. Fall back to size for copy-mode imports
// (different inode); a genuine upgrade — e.g. a dual-audio re-encode — is a
// larger, distinct file, so it still replaces the old one.
function sameLibraryFile(src: string, dest: string): boolean {
  try {
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) return true
    return a.size === b.size
  } catch {
    return false
  }
}

const libraryImport: NodeImpl = {
  spec: {
    type: 'sink.library-import',
    label: 'Import to library',
    category: 'sink',
    description:
      'Places each video file into the media library at a templated path (hardlink, falling back to copy across filesystems), moving its subtitle sidecars alongside. This is what makes a download watchable.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'imported', label: 'imported' },
      { id: 'skipped', label: 'skipped' },
    ],
    config: [
      { key: 'fileField', label: 'Video file field', kind: 'text', default: 'file_path' },
      { key: 'libraryRoot', label: 'Library root', kind: 'text', default: '', help: 'Destination library dir. Empty = LIBRARY_DIR env (/library).' },
      {
        key: 'pathTemplate',
        label: 'Path template',
        kind: 'text',
        default: '{show} ({production_year})/Season {season:2}/{show} - S{season:2}E{torrent_episode:2}',
        help: 'Relative destination path (no extension). {field} = value, {field:2} = 2-digit padded. Slashes make folders.',
      },
      { key: 'showField', label: 'Show name field', kind: 'text', default: 'title', help: 'Aliased to {show} in the template; falls back to name/series_name.' },
      { key: 'defaultSeason', label: 'Default season', kind: 'number', default: 1, help: 'Used as {season} when the item has no season field.' },
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: [
          { value: 'hardlink', label: 'Hardlink (copy on cross-device)' },
          { value: 'copy', label: 'Copy' },
          { value: 'symlink', label: 'Symlink' },
        ],
        default: 'hardlink',
      },
      { key: 'overwrite', label: 'Overwrite existing', kind: 'boolean', default: false, help: 'Off = skip files already present in the library.' },
      { key: 'moveSubs', label: 'Bring subtitle sidecars', kind: 'boolean', default: true },
    ],
  },
  async run(inputs, config, ctx) {
    const fileField = str(config, 'fileField', 'file_path')
    const root = str(config, 'libraryRoot', '') || LIBRARY_DIR()
    // Keep this fallback identical to the spec's pathTemplate default so a node
    // that doesn't set it still gets the full Jellyfin layout.
    const tpl = str(config, 'pathTemplate', '{show} ({production_year})/Season {season:2}/{show} - S{season:2}E{torrent_episode:2}')
    const showField = str(config, 'showField', 'title')
    const defaultSeason = num(config, 'defaultSeason', 1)
    const method = str(config, 'method', 'hardlink')
    const overwrite = bool(config, 'overwrite', false)
    const moveSubs = bool(config, 'moveSubs', true)

    // Place one file: link/copy/symlink src -> dest with an EXDEV copy fallback.
    const place = (src: string, dest: string): 'copy' | 'hardlink' | 'symlink' => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (fs.existsSync(dest)) {
        if (!overwrite) return 'hardlink' // caller checks existence first; unreached
        fs.rmSync(dest)
      }
      if (method === 'copy') { fs.copyFileSync(src, dest); return 'copy' }
      if (method === 'symlink') { fs.symlinkSync(src, dest); return 'symlink' }
      try {
        fs.linkSync(src, dest)
        return 'hardlink'
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          // Different filesystem: hardlink impossible, copy instead.
          fs.copyFileSync(src, dest)
          return 'copy'
        }
        throw e
      }
    }

    const imported: FlowItem[] = []
    const skipped: FlowItem[] = []
    let copied = 0
    for (const item of allInputs(inputs)) {
      const src = String(item[fileField] ?? '')
      const show = String(item[showField] ?? item.title ?? item.name ?? item.series_name ?? '').trim()
      if (!src || !show) {
        ctx.notes.push(`skipped an item missing file or show name`)
        skipped.push(item)
        continue
      }
      const ext = path.extname(src)
      // Expose derived template fields without mutating the item.
      const ctxItem: FlowItem = {
        ...item,
        show,
        season: item.season ?? item.parent_index_number ?? defaultSeason,
        torrent_episode: item.torrent_episode ?? item.index_number ?? '',
      }
      const rel = sanitizeSegments(fillPathTemplate(tpl, ctxItem))
      if (!rel) {
        ctx.notes.push(`skipped "${show}" — template produced an empty path`)
        skipped.push(item)
        continue
      }
      const dest = path.join(root, rel + ext)

      if (fs.existsSync(dest)) {
        // Nothing there to upgrade → honour the plain skip.
        if (!overwrite) {
          skipped.push({ ...item, library_path: dest, import_status: 'exists' })
          continue
        }
        // Overwrite mode: only re-place when the incoming file actually differs
        // from what's already there, so re-runs don't churn (or re-trigger a
        // Jellyfin scan) but a real upgrade does replace the old file.
        if (sameLibraryFile(src, dest)) {
          skipped.push({ ...item, library_path: dest, import_status: 'current' })
          continue
        }
      }
      // dest still present here (with overwrite) means we're replacing a
      // superseded release, e.g. swapping the sub-only file for a dual-audio one.
      const replacing = fs.existsSync(dest)
      if (ctx.dryRun) {
        imported.push({ ...item, library_path: dest, import_method: method, import_status: replacing ? 'replaced' : 'new' })
        continue
      }
      try {
        const used = place(src, dest)
        if (used === 'copy' && method === 'hardlink') copied++
        const out: FlowItem = { ...item, library_path: dest, import_method: used, import_status: replacing ? 'replaced' : 'new' }
        // Bring subtitle + font sidecars next to the video (same basename).
        if (moveSubs && item.subtitle_path) {
          const subSrc = String(item.subtitle_path)
          // Prefer the exact lang.codec extension from extract-subs; fall back to
          // the source sidecar's own suffix if those fields aren't present.
          const lang = item.subtitle_lang ? String(item.subtitle_lang) : ''
          const codec = item.subtitle_codec ? String(item.subtitle_codec) : ''
          const subExt =
            lang && codec ? `.${lang}.${codec}` : path.basename(subSrc).slice(String(item.file_name ?? path.basename(subSrc)).lastIndexOf('.'))
          const subDest = dest.slice(0, dest.length - ext.length) + subExt
          try {
            fs.mkdirSync(path.dirname(subDest), { recursive: true })
            fs.copyFileSync(subSrc, subDest)
            out.library_subtitle_path = subDest
          } catch (e) {
            ctx.notes.push(`subtitle copy failed for ${path.basename(dest)}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        imported.push(out)
      } catch (e) {
        ctx.notes.push(`import failed for ${path.basename(src)}: ${e instanceof Error ? e.message : String(e)}`)
        skipped.push(item)
      }
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would import ${imported.length} file(s), skip ${skipped.length}`
        : `imported ${imported.length} file(s)${copied ? ` (${copied} copied, cross-device)` : ''}, skipped ${skipped.length}`,
    )
    return { imported, skipped }
  },
}

const jellyfinScan: NodeImpl = {
  spec: {
    type: 'sink.jellyfin-scan',
    label: 'Trigger Jellyfin scan',
    category: 'sink',
    description:
      'Kicks off a Jellyfin library refresh so newly-imported files get picked up for playback. (Transitional — playback still runs through Jellyfin.)',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [],
  },
  async run(inputs, _config, ctx) {
    const items = allInputs(inputs)
    if (ctx.dryRun) {
      ctx.notes.push('dry run — would trigger a Jellyfin library scan')
      return { items }
    }
    if (!jellyfinConfigured) {
      ctx.notes.push('Jellyfin not configured — scan skipped')
      return { items }
    }
    try {
      // POST /Library/Refresh — async full-library scan (item-scoped refresh
      // needs a user context we don't have; a library scan is cheap enough).
      const res = await fetch(jfUrl('/Library/Refresh'), { method: 'POST', signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      ctx.notes.push('triggered Jellyfin library scan')
    } catch (e) {
      ctx.notes.push(`Jellyfin scan failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { items }
  },
}

// Resolve a show name to a Jellyfin item id by searching + token-matching. The
// scan is async, so callers poll until it surfaces.
async function findJfItemByName(
  name: string,
  itemType: string,
  threshold: number,
): Promise<{ id: string; name: string } | null> {
  const wanted = significantTokens(name)
  if (wanted.length === 0) return null
  // Search by the most distinctive word for good recall, then match locally.
  const searchTerm = [...wanted].sort((a, b) => b.length - a.length)[0]
  let res: { Items?: JfItem[] }
  try {
    res = await jfJson<{ Items?: JfItem[] }>('/Items', {
      Recursive: 'true',
      IncludeItemTypes: itemType,
      SearchTerm: searchTerm,
      Limit: 25,
    })
  } catch {
    return null
  }
  let best: { id: string; name: string; score: number } | null = null
  for (const it of res.Items ?? []) {
    const hay = norm(it.Name)
    const present = wanted.filter((t) => hay.includes(t)).length
    const score = present / wanted.length
    if (!best || score > best.score) best = { id: it.Id, name: it.Name || '', score }
  }
  return best && best.score >= threshold ? { id: best.id, name: best.name } : null
}

const jellyfinCollection: NodeImpl = {
  spec: {
    type: 'sink.jellyfin-collection',
    label: 'Add to public collection',
    category: 'sink',
    description:
      'Adds each item’s Jellyfin show to the public "Watch" collection — the last step that makes an imported title appear on the site. Resolves the show by name and waits for the library scan to surface it.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'added', label: 'added' },
      { id: 'pending', label: 'not found yet' },
    ],
    config: [
      { key: 'collectionId', label: 'Collection id', kind: 'text', default: '', help: 'Empty = WATCH_COLLECTION_ID env (the public "Watch" collection).' },
      { key: 'nameField', label: 'Show name field', kind: 'text', default: 'title_english', help: 'Item field with the show title; falls back to name.' },
      { key: 'itemType', label: 'Item type', kind: 'select', options: [
        { value: 'Series', label: 'Series' },
        { value: 'Movie', label: 'Movie' },
      ], default: 'Series' },
      { key: 'threshold', label: 'Name match (0-1)', kind: 'number', default: 0.6, help: 'Min word overlap between the item name and the Jellyfin title.' },
      { key: 'waitSeconds', label: 'Wait for scan (s)', kind: 'number', default: 90, help: 'Poll this long for the newly-scanned show to appear. 0 = no wait.' },
    ],
  },
  async run(inputs, config, ctx) {
    const items = allInputs(inputs)
    const collectionId = str(config, 'collectionId', '') || COLLECTION_ID || ''
    const nameField = str(config, 'nameField', 'title_english')
    const itemType = str(config, 'itemType', 'Series')
    const threshold = num(config, 'threshold', 0.6)
    const waitSeconds = num(config, 'waitSeconds', 90)

    // Group items by show name (a 28-episode batch is one series to add).
    const byName = new Map<string, FlowItem[]>()
    for (const item of items) {
      const name = String(item[nameField] ?? item.name ?? '').trim()
      if (!name) continue
      ;(byName.get(name) ?? byName.set(name, []).get(name)!).push(item)
    }
    if (byName.size === 0) {
      ctx.notes.push('no items had a show name to resolve')
      return { added: [], pending: items }
    }
    if (!collectionId) throw new Error('No collection id (config or WATCH_COLLECTION_ID env)')
    if (!jellyfinConfigured) throw new Error('Jellyfin is not configured')

    // Resolve each unique show to a Jellyfin id, polling for the async scan.
    const resolved = new Map<string, { id: string; name: string }>()
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
    const names = [...byName.keys()]
    for (;;) {
      for (const name of names) {
        if (resolved.has(name)) continue
        const hit = await findJfItemByName(name, itemType, threshold)
        if (hit) resolved.set(name, hit)
      }
      if (resolved.size === names.length || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 5000))
    }

    const added: FlowItem[] = []
    const pending: FlowItem[] = []
    for (const [name, group] of byName) {
      if (resolved.has(name)) added.push(...group)
      else {
        pending.push(...group)
        ctx.notes.push(`"${name}" not found in Jellyfin yet (scan may still be running)`)
      }
    }

    const ids = [...resolved.values()].map((r) => r.id)
    if (ids.length === 0) {
      ctx.notes.push('resolved no shows to add')
      return { added, pending }
    }
    if (ctx.dryRun) {
      ctx.notes.push(`dry run — would add ${ids.length} show(s) to the collection: ${[...resolved.values()].map((r) => r.name).join(', ')}`)
      return { added, pending }
    }
    // POST /Collections/{id}/Items?ids=… — adding an existing member is a no-op.
    const res = await fetch(jfUrl(`/Collections/${collectionId}/Items`, { ids: ids.join(',') }), {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`Jellyfin add-to-collection failed (${res.status})`)
    ctx.notes.push(`added ${ids.length} show(s) to the collection: ${[...resolved.values()].map((r) => r.name).join(', ')}`)
    return { added, pending }
  },
}

const merge: NodeImpl = {
  spec: {
    type: 'combine.merge',
    label: 'Merge',
    category: 'combine',
    description: 'Concatenates every incoming branch into one stream.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [],
  },
  async run(inputs) {
    return { items: allInputs(inputs) }
  },
}

const portalSink: NodeImpl = {
  spec: {
    type: 'sink.portal-upsert',
    label: 'Write portal items',
    category: 'sink',
    description:
      'Upserts items into the portal database, merged over the existing row so missing fields never blank out stored data.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'written', label: 'written' }],
    config: [],
  },
  async run(inputs, _config, ctx) {
    const items = allInputs(inputs)
    const written: FlowItem[] = []
    let skipped = 0
    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : ''
      const name = typeof item.name === 'string' ? item.name : ''
      if (!id || !name) {
        skipped++
        continue
      }
      const existing = getPortalItem(id)
      const row: PortalItem = {
        id,
        type: String(item.type ?? existing?.type ?? 'Movie'),
        name,
        original_title: (item.original_title ?? existing?.original_title ?? null) as string | null,
        overview: (item.overview ?? existing?.overview ?? null) as string | null,
        date_created: (item.date_created ?? existing?.date_created ?? null) as string | null,
        premiere_date: (item.premiere_date ?? existing?.premiere_date ?? null) as string | null,
        production_year: (item.production_year ?? existing?.production_year ?? null) as number | null,
        genres: (item.genres ?? existing?.genres ?? null) as string | null,
        runtime_ticks: (item.runtime_ticks ?? existing?.runtime_ticks ?? null) as number | null,
        index_number: (item.index_number ?? existing?.index_number ?? null) as number | null,
        parent_index_number: (item.parent_index_number ?? existing?.parent_index_number ?? null) as number | null,
        series_id: (item.series_id ?? existing?.series_id ?? null) as string | null,
        series_name: (item.series_name ?? existing?.series_name ?? null) as string | null,
        image_url: (item.image_url ?? existing?.image_url ?? null) as string | null,
        backdrop_url: (item.backdrop_url ?? existing?.backdrop_url ?? null) as string | null,
        has_backdrop: (item.has_backdrop ?? existing?.has_backdrop ?? 0) as number | null,
        mal_id: (item.mal_id ?? existing?.mal_id ?? null) as number | null,
      }
      if (!ctx.dryRun) upsertPortalItem(row)
      written.push(item)
    }
    if (skipped > 0) ctx.notes.push(`skipped ${skipped} items without id/name`)
    ctx.notes.push(
      ctx.dryRun ? `dry run — would write ${written.length} items` : `wrote ${written.length} items`,
    )
    return { written }
  },
}

const IMPLS: NodeImpl[] = [
  jellyfinSource,
  indexerSource,
  portalSource,
  httpSource,
  qbittorrentSource,
  fieldFilter,
  compare,
  sortNode,
  compute,
  groupPick,
  join,
  expandFiles,
  mediaProbe,
  extractSubs,
  fetchSubs,
  muxTracks,
  metadataEnrich,
  dedupe,
  limit,
  indexerMatch,
  jikanEnrich,
  template,
  animeStatus,
  torrentSearch,
  diff,
  merge,
  portalSink,
  qbittorrentSink,
  qbittorrentDelete,
  libraryImport,
  jellyfinScan,
  jellyfinCollection,
  {
    spec: {
      type: 'boundary.input',
      label: 'Input',
      category: 'boundary',
      description: 'External input port for a published component flow.',
      inputs: [],
      outputs: [{ id: 'items', label: 'items' }],
      config: [
        { key: 'portId', label: 'Port id', kind: 'text', default: 'in' },
        { key: 'label', label: 'Label', kind: 'text', default: 'Input' },
      ],
    },
    run: async (inputs) => {
      return { items: inputs.items ?? [] }
    },
  },
  {
    spec: {
      type: 'boundary.output',
      label: 'Output',
      category: 'boundary',
      description: 'External output port for a published component flow.',
      inputs: [{ id: 'items', label: 'items' }],
      outputs: [],
      config: [
        { key: 'portId', label: 'Port id', kind: 'text', default: 'out' },
        { key: 'label', label: 'Label', kind: 'text', default: 'Output' },
      ],
    },
    run: async () => {
      return {}
    },
  },
]

export const NODE_REGISTRY: Map<string, NodeImpl> = new Map(IMPLS.map((n) => [n.spec.type, n]))

export const NODE_SPECS: NodeSpec[] = IMPLS.map((n) => n.spec)
