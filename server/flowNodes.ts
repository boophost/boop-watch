// Node registry for the /manage flow editor: every node type the executor can
// run, plus the metadata (inputs/outputs/config fields) the client needs to
// render and configure it. Specs are served via GET /api/flows/node-types so
// the editor never hardcodes node knowledge.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jfJson, jfUrl, jellyfinConfigured, JfItem } from './jellyfin.js'
import {
  listSeries,
  upsertSeriesMetadata,
  recordLibraryFile,
  forgetLibraryFile,
  importedTorrentHashes,
  recordTorrentQueued,
  recordTorrentOutcome,
  setTorrentStatus,
  blockedTorrentHashes,
  processedTorrentHashes,
  markTorrentsCompleted,
  markWantSourced,
  fulfilEpisodeWant,
  fulfilBatchWant,
  fulfilWantById,
  getTorrent,
  getSeriesStatus,
  saveSeriesStatus,
  upsertEpisodeAirDates,
  episodesCacheInfo,
  getCachedEpisodes,
  listWantsJoined,
  upsertWant,
  recordWantAttempt,
  updateWantStatus,
  type WantKind,
  type WantStatus,
} from './db.js'
import { fetchAniListAiring, fetchAniListMedia, type AniListMedia } from './anilist.js'
import { refreshEpisodeCache, isProperTitle } from './episodes.js'
import { enrichSeasonMapping } from './seasonMap.js'
import { getAllPortalItems, getPortalItem, upsertPortalItem, PortalItem } from './portalDb.js'
import { libraryAirings } from './schedule.js'
import { searchAnime, pickPosterUrl, fetchAnimeFull, type JikanAnimeFull } from './jikan.js'
import { blacklistedHashes } from './blacklist.js'
import { qbitList, qbitToItem, qbitConfigured, parseTorrentTags } from './qbit.js'
import { limitedFetch, limitedJson, hostKey } from './httpQueue.js'
import type { FlowGraph, NodeReport, RunHooks } from './flowExecutor.js'
import { getFlow, parseComponent } from './flowsDb.js'
import { deriveInterface, buildSpecResolver } from './flowComponents.js'

const execFileP = promisify(execFile)

export type FlowItem = Record<string, unknown>

export interface ConfigField {
  key: string
  label: string
  /** 'json' renders as a multi-line editor in the flow editor; 'color' as a color picker. */
  kind: 'text' | 'number' | 'select' | 'boolean' | 'password' | 'json' | 'color'
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  help?: string
}

/**
 * What travels over a port. The *record* family — base 'items' plus its stage
 * subtypes (torrent/release/catalog/file/probed) — is the classic stream of
 * loose records; the subtypes form a lineage under 'items' so a wrong wire (a
 * torrent into a file input) is caught while generic nodes still interoperate.
 * Every other type is a *value* port — its items are `{ value: <raw> }` wrappers
 * so the executor can move them like any other stream. Edges only connect
 * compatible types (see portCompatible), and the editor color-codes handles and
 * wires by type. Mirror any change in src/lib/flows.ts.
 */
export type PortDataType =
  | 'items'
  | 'torrent'
  | 'release'
  | 'catalog'
  | 'file'
  | 'probed'
  | 'text'
  | 'number'
  | 'color'
  | 'url'
  | 'json'
  | 'embed'

export interface NodePort {
  id: string
  label: string
  /** Omitted = base 'items'. */
  dataType?: PortDataType
}

/** Record-family subtype lineage (child → parent). Base 'items' is the root of
 * every record type; value types are a separate family. */
const RECORD_PARENT: Partial<Record<PortDataType, PortDataType>> = {
  torrent: 'items',
  release: 'items',
  catalog: 'items',
  file: 'items',
  probed: 'file',
}

const RECORD_TYPES: PortDataType[] = ['items', 'torrent', 'release', 'catalog', 'file', 'probed']
export const isRecordType = (t: PortDataType): boolean => RECORD_TYPES.includes(t)

/** Ancestor chain including self, nearest-first ('probed' → ['probed','file','items']). */
const recordLineage = (t: PortDataType): PortDataType[] => {
  const chain: PortDataType[] = [t]
  let p = RECORD_PARENT[t]
  while (p) {
    chain.push(p)
    p = RECORD_PARENT[p]
  }
  return chain
}

/** Nearest common ancestor of two record types (for propagation through merges). */
export const recordLCA = (a: PortDataType, b: PortDataType): PortDataType => {
  const bset = new Set(recordLineage(b))
  for (const t of recordLineage(a)) if (bset.has(t)) return t
  return 'items'
}

/** Extra value-source types a value target accepts besides its own; 'json' is
 * the wide value type; text-ish values cross-connect where a runtime
 * parse/stringify is safe. Record types are handled by lineage, not this table. */
const PORT_ACCEPTS: Partial<Record<PortDataType, PortDataType[]>> = {
  text: ['number', 'url', 'color'],
  color: ['text'],
  url: ['text'],
  json: ['text', 'number', 'color', 'url', 'embed'],
  embed: ['json'],
}

export function portCompatible(
  source: PortDataType | undefined,
  target: PortDataType | undefined,
): boolean {
  const s = source ?? 'items'
  const t = target ?? 'items'
  if (s === t) return true
  const sRec = isRecordType(s)
  const tRec = isRecordType(t)
  if (sRec !== tRec) return false // record and value families never mix
  if (sRec) return recordLineage(s).includes(t) || recordLineage(t).includes(s)
  return (PORT_ACCEPTS[t] ?? []).includes(s)
}

/** Unwraps a value port's items back to raw values ({ value: x } -> x). */
const socketValues = (items: FlowItem[] | undefined): unknown[] =>
  (items ?? []).map((it) =>
    it && typeof it === 'object' && 'value' in it ? (it as { value: unknown }).value : it,
  )

/** Pairing rule for value inputs: one value broadcasts to every item, N values
 * zip by index (clamped to the last, so a short wire doesn't drop items). */
const pickValue = (vals: unknown[], idx: number): unknown =>
  vals.length === 0 ? undefined : vals[Math.min(idx, vals.length - 1)]

const asValueItems = (vals: unknown[]): FlowItem[] => vals.map((value) => ({ value }))

export type NodeCategory = 'trigger' | 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'value' | 'boundary'

export interface NodeSpec {
  type: string
  label: string
  category: NodeCategory
  description: string
  inputs: NodePort[]
  outputs: NodePort[]
  config: ConfigField[]
}

/** The kind of trigger a run is firing: the named bus (`start`) or an event
 * source. Each maps to a `trigger.<kind>` node type. */
export type TriggerKind = 'start' | 'new-item' | 'new-portal' | 'release' | 'qbit-complete'

/** The event firing a run. Only a trigger node matching this event's kind (and,
 * for the named bus, its name) emits its payload; the rest stay empty. Absent =
 * a manual whole-flow run (every trigger fires). `manual` marks an editor
 * "run from here", so event triggers emit a representative sample instead of a
 * real event payload. */
export interface TriggerEvent {
  kind: TriggerKind
  /** Only meaningful for kind 'start' — the published trigger name. */
  name?: string
  items: FlowItem[]
  manual?: boolean
}

/** A deferred publish queued by a `trigger.fire` node, drained by the dispatcher
 * once the current run releases the flow lock (see fireTrigger in flowRoutes). */
export interface FireRequest {
  name: string
  items: FlowItem[]
}

export interface RunContext {
  dryRun: boolean
  notes: string[]
  /** Id of the node currently executing in the parent graph (for sub-flow prefixing). */
  nodeId?: string
  /** Live progress hooks from the outer runFlow — forwarded into nested runs. */
  hooks?: RunHooks
  /** Merge nested graph node reports into the parent run (keys already qualified). */
  mergeNestedReports?: (nested: Record<string, NodeReport>) => void
  /** The trigger event firing this run (null = manual whole-flow run). */
  trigger?: TriggerEvent | null
  /** Sink that `trigger.fire` pushes deferred publishes onto. */
  fireQueue?: FireRequest[]
}

export interface NodeImpl {
  spec: NodeSpec
  /** Ports that depend on the node's config — boundary nodes take their
   * dataType from config, transform.pick types its output. Omitted = the
   * static spec ports. Mirror any change in resolveNodePorts (src/lib/flows.ts). */
  resolvePorts?(config: Record<string, unknown>): { inputs: NodePort[]; outputs: NodePort[] }
  run(
    inputs: Record<string, FlowItem[]>,
    config: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<Record<string, FlowItem[]>>
}

/** Config select options for ports that can carry any data type. */
const DATA_TYPE_OPTIONS = (['items', 'text', 'number', 'color', 'url', 'json', 'embed'] as const).map(
  (t) => ({ value: t, label: t }),
)

const configDataType = (config: Record<string, unknown>): PortDataType | undefined => {
  const v = String(config.dataType ?? '')
  return (DATA_TYPE_OPTIONS.some((o) => o.value === v) ? v : undefined) as PortDataType | undefined
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

// Per-node "Run on dry runs" toggle for side-effecting nodes (delay, web
// requests, activity log). A dry run normally skips a node's real action; when
// this is on, the node performs it even in a dry run. `def` is the node's
// natural default (e.g. the activity log keeps logging on dry, a web request
// stays skipped). `runOnDryField(def)` declares the matching config field.
const runsLive = (config: Record<string, unknown>, ctx: RunContext, def: boolean): boolean =>
  !ctx.dryRun || bool(config, 'runOnDry', def)

const runOnDryField = (def: boolean): ConfigField => ({
  key: 'runOnDry',
  label: 'Run on dry runs',
  kind: 'boolean',
  default: def,
  help: 'Off = does nothing on a dry run (safe preview). On = performs its action even in a dry run.',
})

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
    label: 'Get Jellyfin titles',
    category: 'source',
    description: 'Fetches titles from the Public Jellyfin collection.',
    inputs: [{ id: 'when', label: 'when' }],
    outputs: [{ id: 'items', label: 'catalog', dataType: 'catalog' }],
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
    label: 'Get Catalog',
    category: 'source',
    description: 'Reads the /manage catalog (MAL-backed series list).',
    inputs: [{ id: 'when', label: 'when' }],
    outputs: [{ id: 'items', label: 'catalog', dataType: 'catalog' }],
    config: [],
  },
  async run() {
    return { items: listSeries().map((s) => ({ ...s })) }
  },
}

const portalSource: NodeImpl = {
  spec: {
    type: 'source.portal',
    label: 'Get Portal items',
    category: 'source',
    description: 'Reads items already stored in the public portal database.',
    inputs: [{ id: 'when', label: 'when' }],
    outputs: [{ id: 'items', label: 'catalog', dataType: 'catalog' }],
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
    inputs: [{ id: 'when', label: 'when' }],
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
// Outbound web-request nodes: enrich.http fires one request per item and keeps
// the response, sink.http delivers items somewhere (webhook-style). Both fill
// {field} placeholders from the item, escaping each value for where it lands.
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain',
}

const CONTENT_TYPE_OPTIONS = [
  { value: 'json', label: 'JSON' },
  { value: 'form', label: 'Form (urlencoded)' },
  { value: 'text', label: 'Plain text' },
]

// Placeholder lookup: a literal key wins, otherwise a dot path digs into
// nested values ({response.data.title}) so JSON built by one node is
// addressable by the next.
const fieldValue = (item: FlowItem, key: string): unknown =>
  key in item ? item[key] : key.includes('.') ? digPath(item, key) : undefined

// Placeholders are restricted to word characters ({title}, {mal_id}) so JSON
// braces in a body/headers template are never mistaken for one.
function fillTemplate(tpl: string, item: FlowItem, escape: 'none' | 'url' | 'json'): string {
  return tpl.replace(/\{([\w.]+)\}/g, (_, key: string) => {
    const raw = fieldValue(item, key)
    const v = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    if (escape === 'url') return encodeURIComponent(v)
    if (escape === 'json') return JSON.stringify(v).slice(1, -1)
    return v
  })
}

/** Headers config is a JSON object; values support {field} placeholders. */
function templateHeaders(raw: string, item: FlowItem): Record<string, string> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fillTemplate(raw, item, 'json'))
  } catch {
    throw new Error('Headers must be a JSON object, e.g. {"X-Api-Key": "secret"}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Headers must be a JSON object, e.g. {"X-Api-Key": "secret"}')
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
}

/** Walks a parsed JSON body template: a string that is exactly "{field}"
 * becomes the item's raw value (numbers/objects keep their type, missing →
 * null); strings mixing text and placeholders interpolate; everything else is
 * a literal default and passes through untouched. */
function fillJsonTemplate(node: unknown, item: FlowItem): unknown {
  if (typeof node === 'string') {
    const exact = node.match(/^\{([\w.]+)\}$/)
    if (exact) return fieldValue(item, exact[1]) ?? null
    return fillTemplate(node, item, 'none')
  }
  if (Array.isArray(node)) return node.map((v) => fillJsonTemplate(v, item))
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, fillJsonTemplate(v, item)]),
    )
  }
  return node
}

function buildBody(tpl: string, item: FlowItem, ctKey: string): string {
  if (ctKey === 'json') {
    // A body that is itself valid JSON (placeholders live inside strings) is
    // treated as a typed template — defaults stay literal, "{field}" values
    // take the item's raw value. Anything else falls back to plain text
    // templating with JSON-escaped substitutions so a quote in a title can't
    // break the payload.
    try {
      return JSON.stringify(fillJsonTemplate(JSON.parse(tpl), item))
    } catch {
      return fillTemplate(tpl, item, 'json')
    }
  }
  return ctKey === 'form' ? fillTemplate(tpl, item, 'url') : fillTemplate(tpl, item, 'none')
}

const httpEnrich: NodeImpl = {
  spec: {
    type: 'enrich.http',
    label: 'Web request',
    category: 'enrich',
    description:
      'Sends an HTTP request per item — URL, body, and headers are filled from its fields — and stores the response in a field.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'ok', label: 'ok' },
      { id: 'error', label: 'error' },
    ],
    config: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        default: '',
        help: '{name} placeholders are replaced with the item’s field values (URL-encoded).',
      },
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
      },
      {
        key: 'body',
        label: 'Body',
        kind: 'json',
        default: '',
        help: 'JSON template mixing defaults with item fields: a value that is exactly "{field}" takes the item’s raw value (numbers/objects stay typed, missing = null); strings can mix text and {field}; anything else is sent as a literal default. Empty (or GET) = no body.',
      },
      { key: 'contentType', label: 'Content type', kind: 'select', default: 'json', options: CONTENT_TYPE_OPTIONS },
      {
        key: 'headers',
        label: 'Extra headers',
        kind: 'json',
        default: '',
        help: 'JSON object, e.g. {"X-Api-Key": "secret"}; values support {field} placeholders.',
      },
      {
        key: 'responsePath',
        label: 'Response path',
        kind: 'text',
        default: '',
        help: 'Dot path into the JSON response, e.g. "data.0.score". Empty = whole body.',
      },
      { key: 'field', label: 'Store in field', kind: 'text', default: 'response' },
      runOnDryField(false),
    ],
  },
  async run(inputs, config, ctx) {
    const urlTpl = str(config, 'url', '')
    if (!urlTpl) throw new Error('URL is required')
    const method = str(config, 'method', 'GET').toUpperCase()
    const bodyTpl = str(config, 'body', '')
    const ctKey = str(config, 'contentType', 'json')
    const headersRaw = str(config, 'headers', '')
    const responsePath = str(config, 'responsePath', '')
    const field = str(config, 'field', 'response')

    const items = allInputs(inputs)
    // GETs are read-only and run even on dry runs (like Fetch JSON); anything
    // else could mutate the remote side, so a dry run only counts them unless
    // "Run on dry runs" is on.
    if (method !== 'GET' && !runsLive(config, ctx, false)) {
      ctx.notes.push(`dry run — would send ${items.length} ${method} request(s)`)
      return { ok: items, error: [] }
    }

    const ok: FlowItem[] = []
    const error: FlowItem[] = []
    for (const item of items) {
      const url = fillTemplate(urlTpl, item, 'url')
      try {
        new URL(url)
      } catch {
        error.push({ ...item, http_error: `invalid URL: ${url}` })
        continue
      }
      try {
        const headers: Record<string, string> = {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...templateHeaders(headersRaw, item),
        }
        const init: RequestInit = { method, headers }
        if (bodyTpl && method !== 'GET') {
          headers['Content-Type'] = CONTENT_TYPES[ctKey] ?? CONTENT_TYPES.json
          init.body = buildBody(bodyTpl, item, ctKey)
        }
        const res = await limitedFetch(hostKey(url), url, init)
        const text = await res.text()
        if (!res.ok) {
          error.push({ ...item, http_status: res.status, http_error: `${res.status} ${res.statusText}` })
          continue
        }
        let doc: unknown = text
        try {
          doc = JSON.parse(text)
        } catch {
          /* not JSON — keep the raw text */
        }
        ok.push({ ...item, [field]: responsePath ? digPath(doc, responsePath) : doc, http_status: res.status })
      } catch (e) {
        error.push({ ...item, http_error: e instanceof Error ? e.message : String(e) })
      }
    }
    ctx.notes.push(`${ok.length} ok, ${error.length} failed`)
    const firstError = error.find((it) => it.http_error)
    if (firstError) ctx.notes.push(`first error: ${String(firstError.http_error)}`)
    return { ok, error }
  },
}

// A node's ctx.notes are what the activity feed keeps (activityFromReport in
// flowRoutes.ts drops silent nodes), so logging = pushing rendered notes.
const logSink: NodeImpl = {
  spec: {
    type: 'sink.log',
    label: 'Log to activity',
    category: 'sink',
    description:
      'Writes a templated message to the run’s activity log (the Activity tab) — one line per item, or a single summary line. Items pass through unchanged, so it can sit anywhere in a flow.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      {
        key: 'message',
        label: 'Message',
        kind: 'text',
        default: '{title}',
        help: '{field} placeholders fill from each item (dot paths reach nested values); {count} is the item count.',
      },
      {
        key: 'perItem',
        label: 'One line per item',
        kind: 'boolean',
        default: true,
        help: 'Off = a single line, filled from the first item (useful with {count}).',
      },
      {
        key: 'limit',
        label: 'Max lines',
        kind: 'number',
        default: 20,
        help: 'Per-item lines beyond this collapse into "…and N more".',
      },
      {
        key: 'skipEmpty',
        label: 'Skip when no items',
        kind: 'boolean',
        default: true,
        help: 'Off = log the message (with {count} = 0) even when nothing arrives.',
      },
      // Logs on both dry and live by default (a dry run's log is its preview);
      // turn off to keep dry runs out of the activity feed.
      runOnDryField(true),
    ],
  },
  async run(inputs, config, ctx) {
    const message = str(config, 'message', '{title}')
    const perItem = bool(config, 'perItem', true)
    const limit = Math.max(1, Math.floor(num(config, 'limit', 20)))
    const skipEmpty = bool(config, 'skipEmpty', true)

    const items = allInputs(inputs)
    // Pass items through regardless; only the logging respects the dry-run toggle.
    if (!runsLive(config, ctx, true)) {
      ctx.notes.push(`dry run — logging skipped (${items.length} item(s))`)
      return { items }
    }
    const fill = (item: FlowItem) =>
      fillTemplate(message, { ...item, count: items.length }, 'none').trim()

    if (items.length === 0) {
      if (!skipEmpty) ctx.notes.push(fill({}))
      return { items }
    }
    if (perItem) {
      for (const item of items.slice(0, limit)) {
        const line = fill(item)
        if (line) ctx.notes.push(line)
      }
      if (items.length > limit) ctx.notes.push(`…and ${items.length - limit} more`)
    } else {
      const line = fill(items[0])
      if (line) ctx.notes.push(line)
    }
    return { items }
  },
}

const httpSink: NodeImpl = {
  spec: {
    type: 'sink.http',
    label: 'Send web request',
    category: 'sink',
    description:
      'Sends one HTTP request per incoming item (webhook-style) — or all items batched into one JSON array request.',
    inputs: [{ id: 'in', label: 'items to send' }],
    outputs: [
      { id: 'sent', label: 'sent' },
      { id: 'failed', label: 'failed' },
    ],
    config: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        default: '',
        help: '{name} placeholders are replaced with the item’s field values (URL-encoded).',
      },
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        default: 'POST',
        options: ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'].map((m) => ({ value: m, label: m })),
      },
      {
        key: 'body',
        label: 'Body',
        kind: 'json',
        default: '',
        help: 'JSON template per item mixing defaults with item fields ("{field}" = raw value, strings interpolate). Empty = the whole item as JSON. Ignored when batching.',
      },
      { key: 'contentType', label: 'Content type', kind: 'select', default: 'json', options: CONTENT_TYPE_OPTIONS },
      {
        key: 'headers',
        label: 'Extra headers',
        kind: 'json',
        default: '',
        help: 'JSON object, e.g. {"Authorization": "Bearer …"}; values support {field} placeholders.',
      },
      {
        key: 'batch',
        label: 'Batch into one request',
        kind: 'boolean',
        default: false,
        help: 'Send a single request with every item as a JSON array (URL placeholders resolve empty).',
      },
      runOnDryField(false),
    ],
  },
  async run(inputs, config, ctx) {
    const urlTpl = str(config, 'url', '')
    if (!urlTpl) throw new Error('URL is required')
    const method = str(config, 'method', 'POST').toUpperCase()
    const bodyTpl = str(config, 'body', '')
    const ctKey = str(config, 'contentType', 'json')
    const headersRaw = str(config, 'headers', '')
    const batch = bool(config, 'batch', false)

    const items = allInputs(inputs)
    if (items.length === 0) return { sent: [], failed: [] }
    if (!runsLive(config, ctx, false)) {
      ctx.notes.push(`dry run — would send ${batch ? 1 : items.length} ${method} request(s)`)
      return { sent: items, failed: [] }
    }

    const send = async (url: string, item: FlowItem, body: string | undefined) => {
      new URL(url) // throws on an invalid URL
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        ...templateHeaders(headersRaw, item),
      }
      const init: RequestInit = { method, headers }
      if (body !== undefined && method !== 'GET') {
        headers['Content-Type'] = CONTENT_TYPES[ctKey] ?? CONTENT_TYPES.json
        init.body = body
      }
      const res = await limitedFetch(hostKey(url), url, init)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.status
    }

    if (batch) {
      try {
        const status = await send(fillTemplate(urlTpl, {}, 'url'), {}, JSON.stringify(items))
        ctx.notes.push(`sent ${items.length} item(s) in one request (${status})`)
        return { sent: items.map((it) => ({ ...it, http_status: status })), failed: [] }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ctx.notes.push(`batch request failed: ${msg}`)
        return { sent: [], failed: items.map((it) => ({ ...it, http_error: msg })) }
      }
    }

    const sent: FlowItem[] = []
    const failed: FlowItem[] = []
    for (const item of items) {
      try {
        const body =
          method === 'GET' ? undefined : bodyTpl ? buildBody(bodyTpl, item, ctKey) : JSON.stringify(item)
        const status = await send(fillTemplate(urlTpl, item, 'url'), item, body)
        sent.push({ ...item, http_status: status })
      } catch (e) {
        failed.push({ ...item, http_error: e instanceof Error ? e.message : String(e) })
      }
    }
    ctx.notes.push(`sent ${sent.length}, failed ${failed.length}`)
    const firstError = failed.find((it) => it.http_error)
    if (firstError) ctx.notes.push(`first error: ${String(firstError.http_error)}`)
    return { sent, failed }
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
  tags?: string
  size: number
  save_path?: string
  content_path?: string
  // qBittorrent unix seconds; completion is -1/0 until the torrent finishes.
  added_on?: number
  completion_on?: number
}

const qbittorrentSource: NodeImpl = {
  spec: {
    type: 'source.qbittorrent',
    label: 'Get Torrents',
    category: 'source',
    description:
      'Lists torrents from qBittorrent (optionally completed only), emitting each one’s on-disk content path so the importer can place the files.',
    inputs: [{ id: 'when', label: 'when' }],
    outputs: [{ id: 'items', label: 'torrents', dataType: 'torrent' }],
    config: [
      { key: 'url', label: 'qBittorrent URL', kind: 'text', default: '', help: 'Empty = QBIT_URL env.' },
      { key: 'username', label: 'Username', kind: 'text', default: '', help: 'Empty = QBIT_USERNAME env.' },
      { key: 'password', label: 'Password', kind: 'password', default: '', help: 'Empty = QBIT_PASSWORD env.' },
      { key: 'category', label: 'Category', kind: 'text', default: 'anime', help: 'Empty = all categories.' },
      { key: 'completedOnly', label: 'Completed only', kind: 'boolean', default: true, help: 'Only emit torrents that finished downloading (ready to import).' },
      { key: 'skipImported', label: 'Skip already imported', kind: 'boolean', default: true, help: 'Drop torrents whose hash is already in the library ledger before the expensive probe/mux nodes, so a fresh download is not starved behind re-processing the backlog. Turn off to force a re-import.' },
      { key: 'newestFirst', label: 'Newest first', kind: 'boolean', default: true, help: 'Emit the most recently completed torrents first, so a just-finished download is processed ahead of older backlog work. Also exposes torrent_completed_on / torrent_added_on for filter.sort.' },
      { key: 'pathFrom', label: 'Download path (qBit)', kind: 'text', default: '', help: 'Path prefix as qBittorrent sees it, e.g. /downloads.' },
      { key: 'pathTo', label: 'Download path (pod)', kind: 'text', default: '', help: 'Where that same prefix is mounted here, e.g. /downloads. Both empty = no rewrite.' },
    ],
  },
  async run(_inputs, config, ctx) {
    const { base, user, pass } = qbitCreds(config)
    const category = str(config, 'category', 'anime')
    const completedOnly = bool(config, 'completedOnly', true)
    const skipImported = bool(config, 'skipImported', true)
    const newestFirst = bool(config, 'newestFirst', true)
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
    let torrents = (await res.json()) as QbitInfo[]

    // Newest-completed first (fall back to when it was added) so a
    // just-finished download is processed ahead of the older backlog rather
    // than starved behind it.
    if (newestFirst) {
      torrents = [...torrents].sort((a, b) => {
        const ac = a.completion_on ?? 0
        const bc = b.completion_on ?? 0
        if (bc !== ac) return bc - ac
        return (b.added_on ?? 0) - (a.added_on ?? 0)
      })
    }

    // Observation backstop: anything qBittorrent reports complete moves off
    // queued/downloading in the torrent ledger, even when no qbit-complete
    // watcher is running. Pure bookkeeping of observed reality, but dry runs
    // still leave the DB untouched.
    if (!ctx.dryRun) {
      markTorrentsCompleted(torrents.filter((t) => (t.progress ?? 0) >= 1).map((t) => t.hash))
    }

    // Drop torrents whose processing is finished before they reach the
    // expensive probe/mux nodes: imported ones (library ledger + torrent
    // ledger) and ones the torrent ledger knows are done for other reasons —
    // exhausted (nothing importable in them), superseded, cleaned. A quality
    // upgrade is a *new* torrent (new hash), so it still runs.
    let skippedImported = 0
    let skippedProcessed = 0
    if (skipImported) {
      const imported = importedTorrentHashes()
      const processed = processedTorrentHashes()
      const keep: typeof torrents = []
      for (const t of torrents) {
        if (imported.has(t.hash)) skippedImported++
        else if (processed.has(t.hash)) skippedProcessed++
        else keep.push(t)
      }
      torrents = keep
    }

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
        torrent_tags: t.tags ?? '',
        torrent_size: t.size ?? null,
        torrent_added_on: t.added_on ?? null,
        torrent_completed_on: t.completion_on ?? null,
        save_path: remapPath(String(t.save_path ?? ''), from, to),
        content_path: contentPath,
        // `ep:` from the tag is what we asked for; the name is only a guess.
        torrent_episode: parseTorrentTags(t.tags).tag_episode ?? parseEpisode(t.name),
        torrent_is_batch: titleIsBatch(t.name),
        ...parseTorrentTags(t.tags),
      }
    })
    ctx.notes.push(
      `${items.length} torrent(s)${completedOnly ? ' (completed)' : ''}${category ? ` in "${category}"` : ''}` +
        (skippedImported ? `, skipped ${skippedImported} already imported` : '') +
        (skippedProcessed ? `, skipped ${skippedProcessed} already processed (exhausted/cleaned)` : ''),
    )
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
    outputs: [
      { id: 'items', label: 'items' },
      { id: 'text', label: 'text', dataType: 'text' },
    ],
    config: [
      { key: 'field', label: 'Set field', kind: 'text', default: 'query' },
      {
        key: 'template',
        label: 'Template',
        kind: 'text',
        default: '{title}',
        help: '{name} placeholders are replaced with the item’s field values. Empty = set the field to an empty value. The "text" output emits each filled string as a text value.',
      },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'query')
    // An explicitly empty template means "set the field to ''" (so optional
    // component params can be left blank) — only a missing key falls back.
    const tplRaw = config['template']
    const tpl = typeof tplRaw === 'string' ? tplRaw : '{title}'
    const filled = allInputs(inputs).map(
      (item) => tpl.replace(/\{([^}]+)\}/g, (_, key: string) => String(item[key] ?? '')).trim(),
    )
    const items = allInputs(inputs).map((item, i) => ({ ...item, [field]: filled[i] }))
    return { items, text: asValueItems(filled) }
  },
}

// ---------------------------------------------------------------------------
// Value literal nodes: each emits a single constant on a typed value port, so
// graphs can wire "the color", "the bot name", … into a socket instead of
// burying it in another node's config. One value broadcasts to every item on
// the receiving side (see pickValue).
// ---------------------------------------------------------------------------

const valueLiteral = (
  type: string,
  label: string,
  dataType: PortDataType,
  field: ConfigField,
  parse: (raw: string) => unknown,
): NodeImpl => ({
  spec: {
    type,
    label,
    category: 'value',
    description: `A constant ${dataType} value, emitted on a typed port. Wire it into a matching (${dataType}) input socket.`,
    inputs: [],
    outputs: [{ id: 'value', label: dataType, dataType }],
    config: [field],
  },
  async run(_inputs, config) {
    const raw = str(config, 'value', String(field.default ?? ''))
    return { value: asValueItems([parse(raw)]) }
  },
})

const textValue = valueLiteral(
  'value.text',
  'Text',
  'text',
  { key: 'value', label: 'Text', kind: 'text', default: '' },
  (raw) => raw,
)

const numberValue = valueLiteral(
  'value.number',
  'Number',
  'number',
  { key: 'value', label: 'Number', kind: 'number', default: 0 },
  (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`Not a number: ${raw}`)
    return n
  },
)

const colorValue = valueLiteral(
  'value.color',
  'Color',
  'color',
  { key: 'value', label: 'Color', kind: 'color', default: '#7c5cff' },
  (raw) => {
    if (!/^#?[0-9a-f]{6}$/i.test(raw)) throw new Error(`Not a hex color: ${raw}`)
    return raw.startsWith('#') ? raw : `#${raw}`
  },
)

const jsonValue = valueLiteral(
  'value.json',
  'JSON',
  'json',
  { key: 'value', label: 'JSON', kind: 'json', default: '{}' },
  (raw) => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error('Not valid JSON')
    }
  },
)

const urlValue = valueLiteral(
  'value.url',
  'URL',
  'url',
  { key: 'value', label: 'URL', kind: 'text', default: '' },
  (raw) => {
    if (raw && !asHttpUrl(raw)) throw new Error(`Not an http(s) URL: ${raw}`)
    return raw
  },
)

/** One random number in [lo, hi]. Integers are inclusive on both ends; floats
 * use half-open [lo, hi) so adjacent ranges tile cleanly. */
function sampleRandom(lo: number, hi: number, integer: boolean): number {
  if (integer) {
    const a = Math.ceil(Math.min(lo, hi))
    const b = Math.floor(Math.max(lo, hi))
    if (b < a) throw new Error(`No integers in range [${lo}, ${hi}]`)
    return a + Math.floor(Math.random() * (b - a + 1))
  }
  const min = Math.min(lo, hi)
  const max = Math.max(lo, hi)
  return min + Math.random() * (max - min)
}

const randomNumber: NodeImpl = {
  spec: {
    type: 'value.random',
    label: 'Random number',
    category: 'value',
    description:
      'Emits one or more random numbers on a typed number port. Wire into "Set field from value" — one value broadcasts to every item; set Count to N to zip a distinct roll onto each item. Evaluated on demand when a live downstream node needs it (not at flow start), so a Random feeding only an untaken Switch arm stays idle.',
    inputs: [],
    outputs: [{ id: 'value', label: 'number', dataType: 'number' }],
    config: [
      { key: 'min', label: 'Minimum', kind: 'number', default: 0 },
      { key: 'max', label: 'Maximum', kind: 'number', default: 1 },
      {
        key: 'integer',
        label: 'Whole numbers only',
        kind: 'boolean',
        default: false,
        help: 'When on, rolls integers inclusive of min and max. When off, floats in [min, max).',
      },
      {
        key: 'count',
        label: 'Count',
        kind: 'number',
        default: 1,
        help: 'How many independent rolls to emit. Pair with Set field from value to zip one roll per item.',
      },
    ],
  },
  async run(_inputs, config, ctx) {
    const lo = num(config, 'min', 0)
    const hi = num(config, 'max', 1)
    const integer = bool(config, 'integer', false)
    const count = Math.max(0, Math.floor(num(config, 'count', 1)))
    const vals: number[] = []
    for (let i = 0; i < count; i++) vals.push(sampleRandom(lo, hi, integer))
    ctx.notes.push(
      count === 0
        ? 'emitted nothing (count = 0)'
        : `rolled ${count} ${integer ? 'integer' : 'float'}${count === 1 ? '' : 's'} in [${Math.min(lo, hi)}, ${Math.max(lo, hi)}${integer ? ']' : ')'}`,
    )
    return { value: asValueItems(vals) }
  },
}

// ---------------------------------------------------------------------------
// JSON-builder nodes: transform.json shapes a typed JSON value onto each item,
// combine.collect folds a field from many items into one array field, and
// transform.discord-embed emits a Discord-format embed object (with typed
// value sockets for its parts). combine.discord-message assembles embeds +
// content into webhook payloads (a Discord message carries up to 10 embeds).
// ---------------------------------------------------------------------------

const isEmptyValue = (v: unknown): boolean => {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

/** Recursively drops empty values (null, "", empty objects/arrays) so optional
 * JSON keys disappear instead of being sent as null. 0 and false survive. */
function pruneEmpty(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneEmpty).filter((v) => !isEmptyValue(v))
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .map(([k, v]) => [k, pruneEmpty(v)] as const)
        .filter(([, v]) => !isEmptyValue(v)),
    )
  }
  return node
}

const setJson: NodeImpl = {
  spec: {
    type: 'transform.json',
    label: 'Set field from JSON',
    category: 'enrich',
    description:
      'Builds a JSON value from a typed template and stores it in a field — the JSON companion to "Set field from template". Use it to shape webhook payloads.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'field', label: 'Set field', kind: 'text', default: 'payload' },
      {
        key: 'template',
        label: 'JSON template',
        kind: 'json',
        default: '{}',
        help: 'JSON mixing literal defaults with item fields: a value that is exactly "{field}" takes the item’s raw value (objects/arrays/numbers keep their type, dot paths reach into nested values); other strings can mix text and {field}.',
      },
      {
        key: 'dropEmpty',
        label: 'Drop empty values',
        kind: 'boolean',
        default: true,
        help: 'Remove null / "" / empty object-or-array values after filling, so optional keys vanish instead of being sent as null.',
      },
    ],
  },
  async run(inputs, config) {
    const field = str(config, 'field', 'payload')
    const raw = str(config, 'template', '')
    if (!raw) throw new Error('JSON template is required')
    let tpl: unknown
    try {
      tpl = JSON.parse(raw)
    } catch {
      throw new Error(
        'Template must be valid JSON — placeholders live inside strings, e.g. {"content": "{title}"}',
      )
    }
    const drop = bool(config, 'dropEmpty', true)
    const items = allInputs(inputs).map((item) => {
      const value = fillJsonTemplate(tpl, item)
      return { ...item, [field]: drop ? pruneEmpty(value) : value }
    })
    return { items }
  },
}

const collect: NodeImpl = {
  spec: {
    type: 'combine.collect',
    label: 'Collect into list',
    category: 'combine',
    description:
      'Folds many items into few: gathers a field’s value from every incoming item into one array field, optionally grouped by a key and chunked (e.g. 10 embeds per Discord message). The emitted item keeps the chunk’s first item’s other fields.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'items', label: 'items' },
      { id: 'skipped', label: 'skipped' },
    ],
    config: [
      {
        key: 'field',
        label: 'Collect field',
        kind: 'text',
        default: 'embed',
        help: 'Field taken from each item; items without it exit "skipped". Empty = collect whole items.',
      },
      { key: 'into', label: 'Into list field', kind: 'text', default: 'embeds' },
      {
        key: 'groupBy',
        label: 'Group by',
        kind: 'text',
        default: '',
        help: 'Key field: one output item per distinct value. Empty = everything into one.',
      },
      {
        key: 'max',
        label: 'Max per item',
        kind: 'number',
        default: 10,
        help: 'A group with more values than this emits multiple chunked items (Discord allows 10 embeds per message). 0 = unlimited.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', '')
    const into = str(config, 'into', 'embeds')
    const groupBy = str(config, 'groupBy', '')
    const max = Math.max(0, Math.floor(num(config, 'max', 10)))

    const skipped: FlowItem[] = []
    const groups = new Map<string, FlowItem[]>()
    for (const item of allInputs(inputs)) {
      if (field && item[field] == null) {
        skipped.push(item)
        continue
      }
      const key = groupBy ? String(item[groupBy] ?? '') : ''
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }

    const out: FlowItem[] = []
    for (const members of groups.values()) {
      const size = max > 0 ? max : members.length
      for (let i = 0; i < members.length; i += size) {
        const chunk = members.slice(i, i + size)
        const base = { ...chunk[0] }
        if (field) delete base[field]
        out.push({ ...base, [into]: chunk.map((it) => (field ? it[field] : { ...it })) })
      }
    }
    ctx.notes.push(
      `${out.length} item(s) from ${groups.size} group(s)` +
        (skipped.length ? `, ${skipped.length} skipped (no "${field}")` : ''),
    )
    return { items: out, skipped }
  },
}

// ---------------------------------------------------------------------------
// Generic typed-socket primitives. These (not domain nodes) are what Discord
// components are built from: set-field wires any value socket into an item
// field, convert covers the mechanical transforms (hex color -> Discord's
// decimal int, truncation, timestamps), and pick lifts a field back out onto
// a typed value port so components can expose typed outputs.
// ---------------------------------------------------------------------------

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + '\u2026'

/** Discord wants colors as a decimal int; accept "#7c5cff", "7c5cff", or a number. */
function parseEmbedColor(s: string): number | undefined {
  const hex = s.match(/^#?([0-9a-f]{6})$/i)
  if (hex) return parseInt(hex[1], 16)
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 && n <= 0xffffff ? Math.floor(n) : undefined
}

const asHttpUrl = (s: string): string => {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : ''
  } catch {
    return ''
  }
}

const setField: NodeImpl = {
  spec: {
    type: 'combine.set-field',
    label: 'Set field from value',
    category: 'combine',
    description:
      'Writes a wired value into a field on each item \u2014 the bridge from typed sockets to item fields. One value broadcasts to every item; N values zip by index. Nothing wired = items pass through untouched (so config templates upstream act as the fallback).',
    inputs: [
      { id: 'in', label: 'in' },
      { id: 'value', label: 'value', dataType: 'json' },
    ],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'field', label: 'Set field', kind: 'text', default: 'value' },
      {
        key: 'skipEmpty',
        label: 'Ignore empty values',
        kind: 'boolean',
        default: true,
        help: 'Leave the item untouched when the wired value is null or "" (keeps the field\u2019s existing fallback).',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'value')
    const skipEmpty = bool(config, 'skipEmpty', true)
    const vals = socketValues(inputs.value)
    const items = (inputs.in ?? []).map((item, idx) => {
      const v = pickValue(vals, idx)
      if (v === undefined || (skipEmpty && (v === null || v === ''))) return item
      return { ...item, [field]: v }
    })
    if (vals.length === 0) ctx.notes.push('no value wired \u2014 items passed through')
    return { items }
  },
}

const convert: NodeImpl = {
  spec: {
    type: 'transform.convert',
    label: 'Convert field',
    category: 'enrich',
    description:
      'Mechanical field conversions: hex color \u2192 decimal int (Discord\u2019s format), truncate to a length, date \u2192 ISO timestamp, "now" \u2192 ISO timestamp, string \u2192 number. Missing/empty fields are left untouched.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'field', label: 'Field', kind: 'text', default: '' },
      {
        key: 'op',
        label: 'Conversion',
        kind: 'select',
        default: 'hex-color-int',
        options: [
          { value: 'hex-color-int', label: 'Hex color \u2192 int' },
          { value: 'truncate', label: 'Truncate text' },
          { value: 'to-iso-date', label: 'Date \u2192 ISO timestamp' },
          { value: 'now', label: 'Set to now (ISO timestamp)' },
          { value: 'to-number', label: 'Text \u2192 number' },
          { value: 'extract-number', label: 'First number in text' },
        ],
      },
      {
        key: 'length',
        label: 'Max length',
        kind: 'number',
        default: 0,
        help: 'For Truncate: keep this many characters (adds \u2026). 0 = no-op.',
      },
      {
        key: 'outField',
        label: 'Store in field',
        kind: 'text',
        default: '',
        help: 'Empty = overwrite the source field.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', '')
    const op = str(config, 'op', 'hex-color-int')
    const length = Math.max(0, Math.floor(num(config, 'length', 0)))
    const outField = str(config, 'outField', '') || field
    if (!field && op !== 'now') throw new Error('Field is required')
    if (op === 'now' && !outField) throw new Error('Store in field is required for "now"')

    let failed = 0
    const items = allInputs(inputs).map((item) => {
      if (op === 'now') return { ...item, [outField]: new Date().toISOString() }
      const raw = item[field]
      if (raw == null || raw === '') return item
      switch (op) {
        case 'hex-color-int': {
          const parsed = parseEmbedColor(String(raw))
          if (parsed === undefined) {
            failed++
            return item
          }
          return { ...item, [outField]: parsed }
        }
        case 'truncate':
          return length > 0 ? { ...item, [outField]: truncate(String(raw), length) } : item
        case 'to-iso-date': {
          const d = new Date(String(raw))
          if (Number.isNaN(d.getTime())) {
            failed++
            return item
          }
          return { ...item, [outField]: d.toISOString() }
        }
        case 'to-number': {
          const n = Number(raw)
          if (!Number.isFinite(n)) {
            failed++
            return item
          }
          return { ...item, [outField]: n }
        }
        // "Ep 5" / "Episode 12v2" → 5 / 12 — for payloads that carry an episode
        // as display text (the release trigger's `ep` field).
        case 'extract-number': {
          const m = /\d+/.exec(String(raw))
          if (!m) {
            failed++
            return item
          }
          return { ...item, [outField]: Number(m[0]) }
        }
        default:
          throw new Error(`Unknown conversion: ${op}`)
      }
    })
    if (failed > 0) ctx.notes.push(`${failed} item(s) had an unconvertible value \u2014 left untouched`)
    return { items }
  },
}

const fromValue: NodeImpl = {
  spec: {
    type: 'transform.from-value',
    label: 'Values to items',
    category: 'combine',
    description:
      'Turns a typed value stream back into an item stream: each wired value becomes an item holding it in a field. Use it inside a component to process what a typed boundary input receives (e.g. embeds → Collect).',
    inputs: [{ id: 'value', label: 'value', dataType: 'json' }],
    outputs: [{ id: 'items', label: 'items' }],
    config: [{ key: 'field', label: 'Store in field', kind: 'text', default: 'value' }],
  },
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'value')
    const items = socketValues(inputs.value).map((v): FlowItem => ({ [field]: v }))
    ctx.notes.push(`${items.length} value(s) → items`)
    return { items }
  },
}

const pick: NodeImpl = {
  spec: {
    type: 'transform.pick',
    label: 'Pick field as value',
    category: 'enrich',
    description:
      'Lifts a field off each item onto a typed value port (the inverse of "Set field from value"). Use it in front of a typed boundary output so a component can emit e.g. embeds. Items without the field are skipped.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'value', label: 'value', dataType: 'json' }],
    config: [
      { key: 'field', label: 'Field', kind: 'text', default: 'value', help: 'Dot paths reach nested values.' },
      {
        key: 'dataType',
        label: 'Value type',
        kind: 'select',
        default: 'json',
        options: DATA_TYPE_OPTIONS.filter((o) => o.value !== 'items'),
      },
    ],
  },
  resolvePorts: (config) => ({
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'value', label: 'value', dataType: configDataType(config) ?? 'json' }],
  }),
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'value')
    const vals = allInputs(inputs)
      .map((item) => fieldValue(item, field))
      .filter((v) => v !== undefined && v !== null)
    ctx.notes.push(`${vals.length} value(s) picked from "${field}"`)
    return { value: asValueItems(vals) }
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

/** Parse switch cases from config (`cases` JSON array or string[]). */
function parseSwitchCases(config: Record<string, unknown>): { id: string; label: string; value: string }[] {
  const raw = config.cases
  let arr: unknown[] = []
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      arr = Array.isArray(parsed) ? parsed : []
    } catch {
      arr = []
    }
  } else if (Array.isArray(raw)) {
    arr = raw
  }
  const used = new Set<string>(['else', 'in'])
  const slug = (s: string): string => {
    let base = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!base || used.has(base)) {
      if (!base) base = 'case'
      let id = base
      let n = 2
      while (used.has(id)) id = `${base}_${n++}`
      used.add(id)
      return id
    }
    used.add(base)
    return base
  }
  const out: { id: string; label: string; value: string }[] = []
  for (const entry of arr) {
    if (typeof entry === 'string') {
      const value = entry
      const id = slug(value || 'case')
      out.push({ id, label: value || id, value })
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const o = entry as Record<string, unknown>
    const value = String(o.value ?? o.match ?? '')
    const labelRaw = o.label != null && String(o.label) !== '' ? String(o.label) : value
    const label = labelRaw || 'case'
    const id =
      typeof o.id === 'string' && o.id.trim() ? slug(o.id.trim()) : slug(label || value || 'case')
    out.push({ id, label: label || id, value })
  }
  return out
}

function switchPorts(config: Record<string, unknown>): { inputs: NodePort[]; outputs: NodePort[] } {
  const cases = parseSwitchCases(config)
  return {
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      ...cases.map((c) => ({ id: c.id, label: c.label })),
      { id: 'else', label: 'else' },
    ],
  }
}

/**
 * Multi-way exclusive branch: each item goes to exactly one output — the first
 * matching case, or "else". Downstream of empty arms is not evaluated (unlike
 * Compare, which still schedules both sides).
 */
const switchNode: NodeImpl = {
  spec: {
    type: 'filter.switch',
    label: 'Switch',
    category: 'filter',
    description:
      'Exclusive multi-way branch: each item goes to exactly one output (first matching case, else "else"). Only arms that receive items run downstream — empty arms are skipped. Add/remove cases in config to grow or shrink the output ports.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'else', label: 'else' },
    ],
    config: [
      {
        key: 'field',
        label: 'Field',
        kind: 'text',
        default: 'value',
        help: 'Item field to match on (dot paths work).',
      },
      {
        key: 'match',
        label: 'Match',
        kind: 'select',
        options: [
          { value: 'eq', label: '= equals' },
          { value: 'contains', label: 'contains' },
          { value: 'matches', label: 'matches regex' },
        ],
        default: 'eq',
      },
      {
        key: 'caseSensitive',
        label: 'Case sensitive',
        kind: 'boolean',
        default: false,
      },
      {
        key: 'cases',
        label: 'Cases',
        kind: 'json',
        default: '[\n  { "value": "a", "label": "A" },\n  { "value": "b", "label": "B" }\n]',
        help: 'JSON array of cases, in priority order. Each entry is a string, or { "value", "label?", "id?" }. Port handles use id (or a slug of label/value). First matching case wins; no match → else.',
      },
    ],
  },
  resolvePorts: switchPorts,
  async run(inputs, config, ctx) {
    const field = str(config, 'field', 'value')
    const match = str(config, 'match', 'eq')
    const caseSensitive = bool(config, 'caseSensitive', false)
    const cases = parseSwitchCases(config)
    const buckets: Record<string, FlowItem[]> = { else: [] }
    for (const c of cases) buckets[c.id] = []

    const matches = (left: unknown, value: string): boolean => {
      if (match === 'matches') {
        try {
          return new RegExp(value, caseSensitive ? '' : 'i').test(String(left ?? ''))
        } catch {
          return false
        }
      }
      const L = caseSensitive ? String(left ?? '') : String(left ?? '').toLowerCase()
      const R = caseSensitive ? value : value.toLowerCase()
      if (match === 'contains') return L.includes(R)
      return L === R
    }

    let routed = 0
    for (const item of allInputs(inputs)) {
      const left = fieldValue(item, field)
      let hit: string | null = null
      for (const c of cases) {
        if (matches(left, c.value)) {
          hit = c.id
          break
        }
      }
      const dest = hit ?? 'else'
      buckets[dest]!.push(item)
      routed += 1
    }
    const summary = Object.entries(buckets)
      .filter(([, items]) => items.length > 0)
      .map(([id, items]) => `${id}:${items.length}`)
      .join(', ')
    ctx.notes.push(
      cases.length === 0
        ? `no cases configured — ${routed} item(s) → else`
        : `routed ${routed} item(s) [${summary || 'none'}]`,
    )
    return buckets
  },
}

/** Per-item coin flip: each item independently rolls into pass or fail. */
const chance: NodeImpl = {
  spec: {
    type: 'filter.chance',
    label: 'Chance',
    category: 'filter',
    description:
      'Splits items at random: each item independently rolls into "pass" with the configured probability (else "fail"). Use it for coin-flip branching without stamping a random field first.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'pass', label: 'pass' },
      { id: 'fail', label: 'fail' },
    ],
    config: [
      {
        key: 'probability',
        label: 'Pass probability',
        kind: 'number',
        default: 0.5,
        help: '0–1. Each item passes when Math.random() < this value (0 = all fail, 1 = all pass, 0.5 ≈ coin flip).',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const p = Math.min(1, Math.max(0, num(config, 'probability', 0.5)))
    const pass: FlowItem[] = []
    const fail: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      ;(Math.random() < p ? pass : fail).push(item)
    }
    ctx.notes.push(`${pass.length} of ${pass.length + fail.length} item(s) passed (p=${p})`)
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
      { key: 'seasonField', label: 'Season field', kind: 'text', default: '', help: 'Tokens mode: item field holding a numeric season (e.g. from Parse season). When present, only catalog rows whose tvdb_season matches are considered, so a file routes to the right season of a same-title franchise. Empty = title-only matching.' },
    ],
  },
  async run(inputs, config, ctx) {
    const setField = str(config, 'setField', 'image_url')
    const fromField = str(config, 'fromField', 'image_url')
    const queryField = str(config, 'queryField', 'name')
    const mode = str(config, 'matchMode', 'exact')
    const threshold = num(config, 'threshold', 0.6)
    const seasonField = str(config, 'seasonField', '')
    const catalog = listSeries()
    // When the release's season is known, a matching tvdb_season is strong
    // evidence, so we accept a lower title overlap than the general threshold
    // (the franchise name alone is enough to disambiguate within one season).
    const SEASON_FLOOR = 0.3

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

    // Best title-token overlap of a release name against a set of candidate rows.
    const hayOf = (item: FlowItem) => {
      const hay = norm(item[queryField])
      return { hay, collapsed: hay.replace(/ /g, '') }
    }
    // Overlap weighted by word length, not word count. Counting words treats
    // every word as equally identifying, which they are not: "inuyashiki" names
    // a show, "hero" and "last" do not. Long words are rare words, so charging
    // by length is a cheap stand-in for distinctiveness — it lets a release that
    // carries only the show's name ("Inuyashiki - 10") match a longer catalog
    // title, while denying a match to one that merely shares a filler word.
    const weigh = (toks: string[]) => toks.reduce((n, t) => n + t.length, 0)
    const bestByTokens = (
      rows: typeof catalog,
      hay: string,
      collapsed: string,
    ): { row: (typeof catalog)[number] | undefined; score: number } => {
      let best: { row: (typeof catalog)[number] | undefined; score: number } = { row: undefined, score: 0 }
      for (const s of rows) {
        let rowScore = 0
        for (const variant of titleVariants(s)) {
          const toks = significantTokens(variant)
          if (toks.length === 0) continue
          const present = toks.filter((t) => hay.includes(t) || collapsed.includes(t))
          rowScore = Math.max(rowScore, weigh(present) / weigh(toks))
        }
        if (rowScore > best.score) best = { row: s, score: rowScore }
      }
      return best
    }

    // Tokens mode: pick the catalog row whose distinctive words are most present
    // in the release name. When a season is known, first try to disambiguate
    // within the rows of that tvdb_season (accepting a lower overlap, since the
    // season match already narrows it); otherwise fall back to title-only.
    const matchTokens = (item: FlowItem): (typeof catalog)[number] | undefined => {
      const { hay, collapsed } = hayOf(item)
      const season = seasonField ? Number(item[seasonField]) : NaN
      if (Number.isFinite(season)) {
        const inSeason = catalog.filter((s) => s.tvdb_season != null && Number(s.tvdb_season) === season)
        if (inSeason.length > 0) {
          const best = bestByTokens(inSeason, hay, collapsed)
          if (best.row && best.score >= Math.min(threshold, SEASON_FLOOR)) return best.row
        }
        // No confident same-season row → fall through to title-only matching.
      }
      const best = bestByTokens(catalog, hay, collapsed)
      return best.score >= threshold ? best.row : undefined
    }

    // We stamped `mal:<id>` on the torrent when we queued it, so its cour is
    // known, not inferred. Trust that over token-matching a release name —
    // "…4th Season - 05" otherwise falls through to the season-1 row.
    //
    // Unless the release name itself contradicts the tag: a search for one
    // season can return (and queue-tag) another season's releases — three
    // "S04E11" torrents queued by a season-1 search carried `mal:<S1>` and
    // overwrote Season 1 files with Season 4 content. When the parsed season
    // (seasonField) disagrees with the tagged row's tvdb_season and the same
    // franchise (tvdb_id) has a row for the parsed season, believe the name.
    const matchTag = (item: FlowItem): (typeof catalog)[number] | undefined => {
      const mal = asNumber(item.tag_mal_id)
      const tagged = mal == null ? undefined : catalog.find((s) => s.mal_id === mal)
      if (!tagged || !seasonField) return tagged
      const season = Number(item[seasonField])
      if (!Number.isFinite(season) || tagged.tvdb_season == null || Number(tagged.tvdb_season) === season) {
        return tagged
      }
      const corrected = catalog.find(
        (s) => s.tvdb_id != null && s.tvdb_id === tagged.tvdb_id && Number(s.tvdb_season) === season,
      )
      if (corrected) {
        tagCorrected++
        return corrected
      }
      return tagged
    }

    const matched: FlowItem[] = []
    const unmatched: FlowItem[] = []
    let fromTag = 0
    let tagCorrected = 0
    for (const item of allInputs(inputs)) {
      const tagged = matchTag(item)
      if (tagged) fromTag++
      const hit = tagged ?? (mode === 'tokens' ? matchTokens(item) : matchExact(item))
      const copied = hit ? (hit as unknown as FlowItem)[fromField] : null
      if (hit && copied != null && copied !== '') {
        matched.push({ ...item, [setField]: copied })
      } else {
        unmatched.push(item)
      }
    }
    ctx.notes.push(
      `${matched.length}/${matched.length + unmatched.length} matched an indexer title` +
        (fromTag ? ` (${fromTag} from torrent tags)` : '') +
        (tagCorrected ? ` (${tagCorrected} tag(s) overridden by the release's own season)` : ''),
    )
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

// Roman numerals I–XII → number, for anime sequel titles ("Mushoku Tensei II").
const ROMAN_SEASON: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
}

// Best-effort season number from a release/torrent name. Distinguishes seasons
// of the same franchise (whose titles are otherwise near-identical) so a file
// routes to the right catalog cour. Tries explicit "S03"/"Season 3"/"3rd Season"
// forms first, then a trailing roman numeral ("... II"); returns null when a
// name carries no season marker (caller then treats it as unrestricted, not S1).
function parseSeason(title: string): number | null {
  // "S03", "S3", "S03E02" — the season digits of an SxxEyy / Sxx tag.
  let m = title.match(/\bS(\d{1,2})(?:\s*E\d{1,4})?\b/i)
  if (m) return Number(m[1])
  // "Season 3", "Season 03"
  m = title.match(/\bSeason\s*0*(\d{1,2})\b/i)
  if (m) return Number(m[1])
  // "3rd Season", "2nd Season"
  m = title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*Season\b/i)
  if (m) return Number(m[1])
  // Trailing roman numeral used as a sequel marker ("Mushoku Tensei II",
  // "... III: Subtitle"). Bare "I" is too ambiguous to trust, so ignore it.
  m = title.match(/\b(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\b(?=\s*[:\-–]|\s|$)/)
  if (m) return ROMAN_SEASON[m[1].toLowerCase()] ?? null
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

// Function words identify nothing. They have to go before the >=3-char filter
// can be trusted: "the" survives it, so "The Quintessential Quintuplets" used to
// offer {the, quintessential, quintuplets}, and *any* release name containing the
// word "the" scored 1/3 against it — over indexerMatch's season floor. That is
// how a 12-episode show grew episodes 13-25 out of two unrelated series.
// (Shorter function words — of, in, as, a — the length filter already drops.)
const STOPWORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'these', 'those', 'you', 'your', 'our',
  'its', 'their', 'not', 'but', 'are', 'was', 'were', 'has', 'had', 'out', 'all', 'into', 'over',
  'than', 'then', 'who', 'why', 'how', 'what', 'when', 'where', 'been', 'being',
])

function significantTokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !QUALITY_TOKENS.has(t) && !STOPWORDS.has(t) && !/^\d+$/.test(t))
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
  maxSizeBytes: number // per-torrent size cap; 0 = no cap
}

function passesFilters(c: Candidate, o: SearchOpts): boolean {
  // Seeder floor only applies when the provider reports seeders (TsukiHime doesn't).
  if (o.minSeeders > 0 && c.seeders != null && c.seeders < o.minSeeders) return false
  if (o.requireResolution && o.resolution && c.resolution !== o.resolution) return false
  if (o.requireDualAudio && !c.dualAudio) return false
  // Drop unplayable codecs (only when detected — an untagged release is kept).
  if (c.videoCodec && o.excludeCodecs.includes(c.videoCodec)) return false
  // Size cap (only when the release reports a size) — keeps a season-pack search
  // from picking an 80GB+ Blu-ray remux over a reasonable WEB-DL.
  if (o.maxSizeBytes > 0 && c.size != null && c.size > o.maxSizeBytes) return false
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
      { id: 'found', label: 'found', dataType: 'release' },
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
        key: 'episodeField',
        label: 'Episode pin field',
        kind: 'text',
        default: '',
        help: 'When set and the item carries a number there (e.g. torrent_episode from a want), episode mode grabs ONLY that episode instead of the most recent ones. Empty = off.',
      },
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
      { key: 'maxSizeGB', label: 'Max torrent size (GB)', kind: 'number', default: 0, help: 'Drop releases larger than this (per torrent). Keeps season-pack searches from grabbing 80GB+ Blu-ray remuxes over a ~20GB WEB-DL. 0 = no cap.' },
      { key: 'maxItems', label: 'Max shows', kind: 'number', default: 10, help: 'Safety cap of searches per run. 0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const provider = str(config, 'provider', 'animetosho')
    const base =
      str(config, 'baseUrl', '').replace(/\/$/, '') ||
      (provider === 'tsukihime' ? TSUKI_URL : TOSHO_URL)
    const queryField = str(config, 'queryField', 'torrent_query')
    const episodeField = str(config, 'episodeField', '')
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
      maxSizeBytes: Math.max(0, num(config, 'maxSizeGB', 0)) * 1e9,
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

      // Resolve batch-vs-episode per item. A pinned episode number is
      // authoritative: whoever set it (a want) needs THAT episode, so batch
      // mode — which ignores the pin and takes the best release for the whole
      // title — is never a safe fallback for it.
      const pinnedEpNum = episodeField ? asNumber(item[episodeField]) : null
      let mode = configMode
      if (pinnedEpNum != null) {
        mode = 'episode'
      } else if (mode === 'auto') {
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
          // Without an id pin, title relevance can't tell seasons of a
          // franchise apart ("Tensei shitara Slime Datta Ken" matches the
          // "…4th Season" release). When the item knows its season, drop
          // candidates whose own name declares a DIFFERENT one — a release
          // with no season marker stays (S1 releases usually carry none).
          const wantSeason = asNumber(item.tvdb_season)
          if (wantSeason != null) {
            const before = relevant.length
            relevant = relevant.filter((c) => {
              const rs = parseSeason(c.name)
              return rs == null || rs === wantSeason
            })
            if (relevant.length < before) {
              ctx.notes.push(
                `dropped ${before - relevant.length} other-season release(s) for "${q}" (want season ${wantSeason}, no id pin)`,
              )
            }
          }
        }
        const blocked = blacklistedHashes()
        const cands = relevant
          .filter((c) => !c.hash || !blocked.has(c.hash.toLowerCase()))
          .filter((c) => passesFilters(c, opts))
        const blacklistedOut = relevant.length - relevant.filter((c) => !c.hash || !blocked.has(c.hash.toLowerCase())).length
        if (blacklistedOut > 0) ctx.notes.push(`skipped ${blacklistedOut} blacklisted release(s) for "${q}"`)
        if (opts.maxSizeBytes > 0) {
          const tooBig = relevant.filter((c) => c.size != null && c.size > opts.maxSizeBytes)
          if (tooBig.length > 0) {
            const biggest = Math.max(...tooBig.map((c) => c.size ?? 0)) / 1e9
            ctx.notes.push(`dropped ${tooBig.length} over-size release(s) for "${q}" (largest ${biggest.toFixed(0)}GB > ${(opts.maxSizeBytes / 1e9).toFixed(0)}GB cap)`)
          }
        }

        if (cands.length === 0) {
          missed.push(item)
          const why =
            raw.length > 0 && relevant.length === 0
              ? `no title-relevant releases for "${q}" (${raw.length} off-title results ignored)`
              : `no releases passed filters for "${q}"`
          ctx.notes.push(why)
        } else if (mode === 'episode') {
          // A pinned episode (a want) narrows the grab to exactly that number;
          // otherwise: best release per episode, most recent first.
          const pinnedEp = pinnedEpNum
          const byEp = new Map<number, Candidate>()
          for (const c of cands) {
            if (c.isBatch || c.episode == null) continue
            if (pinnedEp != null && c.episode !== pinnedEp) continue
            const cur = byEp.get(c.episode)
            if (!cur || scoreCandidate(c, opts) > scoreCandidate(cur, opts)) byEp.set(c.episode, c)
          }
          const eps = [...byEp.entries()].sort((a, b) => b[0] - a[0]).slice(0, maxEpisodes)
          if (eps.length === 0) {
            missed.push(item)
            ctx.notes.push(
              pinnedEp != null
                ? `no release for "${q}" episode ${pinnedEp}${cands.some((c) => !c.isBatch) ? ` (${cands.filter((c) => !c.isBatch).length} other-episode releases ignored)` : ''}`
                : `no single-episode releases for "${q}"`,
            )
          } else {
            for (const [, c] of eps) found.push({ ...item, ...candidateFields(c), torrent_provider: provider })
            ctx.notes.push(`${q}: ${eps.length} episode(s), best seeders ${Math.max(...eps.map(([, c]) => c.seeders ?? 0))}`)
          }
        } else {
          // Season pack: highest-scoring batch, or best overall if none flagged batch.
          const batches = cands.filter((c) => c.isBatch)
          const pool = batches.length > 0 ? batches : cands
          const best = pool.sort((a, b) => scoreCandidate(b, opts) - scoreCandidate(a, opts))[0]
          found.push({ ...item, ...candidateFields(best), torrent_provider: provider })
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
      'Looks up airing status + episode count by MAL id and sets air_status / total_episodes / is_movie / want_mode. Cache-first: reads the catalog row and only hits TsukiHime when the cache is stale (finished shows are never re-polled).',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'out', label: 'out' },
      { id: 'unknown', label: 'unknown' },
    ],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      { key: 'baseUrl', label: 'API base URL', kind: 'text', default: '', help: 'Empty = TsukiHime default.' },
      { key: 'maxItems', label: 'Max lookups', kind: 'number', default: 25, help: '0 = unlimited.' },
      {
        key: 'cacheTtlHours',
        label: 'Cache TTL (hours)',
        kind: 'number',
        default: 24,
        help: 'Serve airing/unknown statuses from the catalog cache for this long before re-checking. Finished is terminal — never re-polled. 0 = always fetch.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const base = str(config, 'baseUrl', '').replace(/\/$/, '') || TSUKI_URL
    const maxItems = num(config, 'maxItems', 25)
    const ttlMs = Math.max(0, num(config, 'cacheTtlHours', 24)) * 3600_000
    const out: FlowItem[] = []
    const unknown: FlowItem[] = []
    let looked = 0
    let fromCache = 0
    for (const item of allInputs(inputs)) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0) {
        unknown.push(item)
        continue
      }
      // Cache-first: a finished show never changes; an airing/unknown one is
      // trusted for the TTL. Only stale rows cost a network call.
      const cached = getSeriesStatus(mal)
      if (ttlMs > 0 && cached?.air_status && cached.status_checked_at) {
        const fresh =
          cached.air_status === 'finished' ||
          Date.now() - new Date(cached.status_checked_at + 'Z').getTime() < ttlMs
        if (fresh) {
          fromCache++
          out.push({
            ...item,
            air_status: cached.air_status,
            total_episodes: cached.total_episodes,
            is_movie: !!cached.is_movie,
            want_mode: cached.air_status === 'airing' ? 'episode' : 'batch',
            anidb_id: cached.anidb_id,
            tsuki_id: cached.tsuki_id,
            anilist_id: cached.anilist_id,
          })
          continue
        }
      }
      if (maxItems > 0 && looked >= maxItems) {
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
        // Persist the lookup on the catalog row so the next run reads our DB
        // instead of TsukiHime (dry runs too: this caches an observation, it
        // doesn't take a side effect the flow was asked to skip).
        if (airStatus !== 'unknown') {
          saveSeriesStatus(mal, {
            air_status: airStatus,
            total_episodes: a.total_episodes != null ? Number(a.total_episodes) : null,
            is_movie: isMovie ? 1 : 0,
            anidb_id: a.anidb != null ? Number(a.anidb) : null,
            tsuki_id: a.id != null ? Number(a.id) : null,
            anilist_id: a.anilist != null ? Number(a.anilist) : null,
          })
        }
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
        // Never clobber an existing want_mode: an episode want must stay an
        // episode search even when the status lookup fails (a batch fallback
        // ignores the episode pin — that's how an S4 single got queued for an
        // S1 episode want on prod).
        unknown.push({ ...item, air_status: 'unknown', want_mode: item.want_mode ?? 'batch' })
      }
      // TsukiHime default limit is 120 req/min; 550ms spacing (~109/min) stays
      // under it with headroom.
      await new Promise((r) => setTimeout(r, 550))
    }
    ctx.notes.push(
      `resolved status for ${out.length}${fromCache ? ` (${fromCache} from cache)` : ''}, ${unknown.length} unknown`,
    )
    return { out, unknown }
  },
}

const episodesNode: NodeImpl = {
  spec: {
    type: 'enrich.episodes',
    label: 'Aired episodes',
    category: 'enrich',
    description:
      'Expands a series item into one item per *aired* episode (episode/torrent_episode set, MAL per-cour numbering). Cache-first: reads series_episodes and only asks AniList (airingSchedule by MAL id) when the cache is missing or stale; air dates are written back to the cache.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [
      { id: 'aired', label: 'aired' },
      { id: 'none', label: 'none' },
    ],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      {
        key: 'cacheTtlHours',
        label: 'Cache TTL (hours)',
        kind: 'number',
        default: 6,
        help: 'For airing shows, refresh the episode cache when older than this. A cache that already covers every episode of a finished show is never refreshed. 0 = always fetch.',
      },
      { key: 'maxFetch', label: 'Max upstream fetches', kind: 'number', default: 10, help: 'Cap of AniList lookups per run; items beyond it use whatever the cache has. 0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const ttlMs = Math.max(0, num(config, 'cacheTtlHours', 6)) * 3600_000
    const maxFetch = num(config, 'maxFetch', 10)
    const aired: FlowItem[] = []
    const none: FlowItem[] = []
    let fetched = 0
    let fromCache = 0
    for (const item of allInputs(inputs)) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0) {
        none.push(item)
        continue
      }
      const info = episodesCacheInfo(mal)
      const total = asNumber(item.total_episodes) ?? getSeriesStatus(mal)?.total_episodes ?? null
      const finished = String(item.air_status ?? getSeriesStatus(mal)?.air_status ?? '') === 'finished'
      // The cache answers when it's complete (finished show, every episode
      // present) or recent enough. Missing air dates count as incomplete —
      // pre-AniList rows only carried titles.
      const cachedRows = getCachedEpisodes(mal)
      const withDates = cachedRows.filter((e) => e.aired)
      const complete = finished && total != null && withDates.length >= total
      const freshEnough =
        info.updated_at != null &&
        withDates.length > 0 &&
        (ttlMs === 0 ? false : Date.now() - new Date(info.updated_at + 'Z').getTime() < ttlMs)
      let episodes = withDates
      if (!complete && !freshEnough && (maxFetch === 0 || fetched < maxFetch)) {
        fetched++
        const al = await fetchAniListAiring(mal)
        if (al && al.episodes.length > 0) {
          // Cache every known air time (future ones included — they become
          // "aired" by pure time passage, no refetch needed).
          upsertEpisodeAirDates(mal, al.episodes.map((e) => ({ number: e.number, aired: e.airedAt })))
          episodes = getCachedEpisodes(mal).filter((e) => e.aired)
        }
      } else if (episodes.length > 0) {
        fromCache++
      }
      const now = Date.now()
      const past = episodes.filter((e) => new Date(String(e.aired)).getTime() <= now)
      if (past.length === 0) {
        none.push(item)
        continue
      }
      for (const e of past) {
        aired.push({
          ...item,
          episode: e.number,
          torrent_episode: e.number,
          episode_aired: e.aired,
          episode_title: e.title ?? null,
        })
      }
    }
    ctx.notes.push(
      `${aired.length} aired episode(s) across ${new Set(aired.map((i) => i[malField])).size} series` +
        (fromCache ? `, ${fromCache} series from cache` : '') +
        (fetched ? `, ${fetched} AniList fetch(es)` : '') +
        (none.length ? `, ${none.length} with none aired` : ''),
    )
    return { aired, none }
  },
}

// Fills per-episode *titles* in the cache (AniList has no reliable episode
// titles) by merging several sources; existence/air-dates are AniList's job
// (enrich.episodes). Series-level + cache-first, so it warms series_episodes for
// the /manage episodes list without hitting anything when the cache is fresh.
const episodeTitlesNode: NodeImpl = {
  spec: {
    type: 'enrich.episode-titles',
    label: 'Episode titles',
    category: 'enrich',
    description:
      'Fills per-episode titles in the episode cache by merging Jikan, Kitsu and AniList streaming titles (AniList’s airing schedule carries no titles). Cache-first: skips series whose cached episodes already have titles and were refreshed within the TTL. Passes items through unchanged.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      { key: 'cacheTtlHours', label: 'Cache TTL (hours)', kind: 'number', default: 24, help: 'Skip series whose cache was refreshed within this and has every title. 0 = always refresh.' },
      { key: 'maxFetch', label: 'Max series fetched', kind: 'number', default: 10, help: 'Cap of upstream title lookups per run. 0 = unlimited.' },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const ttlMs = Math.max(0, num(config, 'cacheTtlHours', 24)) * 3600_000
    const maxFetch = num(config, 'maxFetch', 10)
    const out = allInputs(inputs)
    const seen = new Set<number>()
    let refreshed = 0
    let filled = 0
    for (const item of out) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0 || seen.has(mal)) continue
      seen.add(mal)
      // Cache-first: skip series already fully titled + fresh (refreshEpisodeCache
      // no-ops), and cap upstream lookups per run.
      const cachedRows = getCachedEpisodes(mal)
      const missing =
        cachedRows.length === 0 || cachedRows.some((e) => !isProperTitle(e.title, e.title_source))
      if (!missing) continue
      if (maxFetch > 0 && refreshed >= maxFetch) continue
      const finished =
        String(item.air_status ?? getSeriesStatus(mal)?.air_status ?? '') === 'finished' ||
        String(item.status ?? '') === 'Finished Airing'
      const total = asNumber(item.total_episodes) ?? getSeriesStatus(mal)?.total_episodes ?? null
      refreshed++
      const r = await refreshEpisodeCache({ mal_id: mal, finished, totalEpisodes: total }, { ttlMs })
      filled += r.filled
    }
    ctx.notes.push(`refreshed episode titles for ${refreshed} series (${filled} episode row(s) written)`)
    return { out }
  },
}

// ---------------------------------------------------------------------------
// Wants: the persistent memory of what the sourcing flows are trying to
// obtain. Domain source/sink nodes over the `wants` table (db.ts) — decision
// logic (aired vs airing, provider fallback) stays in the generic filter/
// compare nodes per the repo convention.
// ---------------------------------------------------------------------------

const wantsSource: NodeImpl = {
  spec: {
    type: 'source.wants',
    label: 'Wants',
    category: 'source',
    description:
      'Emits wants (episodes/season packs the system still needs), joined to their catalog rows. Open wants in backoff (next attempt in the future) are skipped by default. Sets want_mode so Torrent search "auto" grabs the right shape.',
    inputs: [{ id: 'when', label: 'when' }],
    outputs: [{ id: 'items', label: 'wants' }],
    config: [
      {
        key: 'status',
        label: 'Status',
        kind: 'select',
        options: [
          { value: 'open', label: 'Open (still unsourced)' },
          { value: 'sourced', label: 'Sourced (torrent queued)' },
          { value: 'fulfilled', label: 'Fulfilled' },
          { value: 'abandoned', label: 'Abandoned' },
        ],
        default: 'open',
      },
      {
        key: 'kind',
        label: 'Kind',
        kind: 'select',
        options: [
          { value: '', label: 'Any' },
          { value: 'episode', label: 'Episodes' },
          { value: 'batch', label: 'Season packs' },
        ],
        default: '',
      },
      { key: 'respectBackoff', label: 'Respect retry backoff', kind: 'boolean', default: true, help: 'Skip wants whose next_attempt_at is still in the future. Turn off to retry everything now.' },
      { key: 'maxItems', label: 'Max wants', kind: 'number', default: 10, help: 'Per run, least-tried first. 0 = unlimited.' },
    ],
  },
  async run(_inputs, config, ctx) {
    const status = str(config, 'status', 'open') as WantStatus
    const kind = str(config, 'kind', '') as WantKind | ''
    const respectBackoff = bool(config, 'respectBackoff', true)
    const maxItems = num(config, 'maxItems', 10)
    let rows = listWantsJoined({ status, kind: kind || undefined, respectBackoff })
    const total = rows.length
    if (maxItems > 0) rows = rows.slice(0, maxItems)
    const items: FlowItem[] = rows.map((w) => ({
      want_id: w.id,
      want_kind: w.kind,
      want_status: w.status,
      want_reason: w.reason,
      attempts: w.attempts,
      mal_id: w.mal_id,
      // MAL per-cour episode number — doubles as the search pin.
      episode: w.episode,
      torrent_episode: w.episode,
      // Lets enrich.torrent-search mode:"auto" pick batch vs episode.
      want_mode: w.kind,
      torrent_hash: w.torrent_hash,
      title: w.title,
      title_english: w.title_english,
      name: w.title,
      tvdb_id: w.tvdb_id,
      tvdb_season: w.tvdb_season,
      episode_offset: w.episode_offset,
      air_status: w.air_status,
      is_movie: w.is_movie != null ? !!w.is_movie : null,
      total_episodes: w.series_total_episodes,
    }))
    ctx.notes.push(
      `${items.length} ${status} want(s)` +
        (total > items.length ? ` of ${total}` : '') +
        (kind ? ` (${kind})` : ''),
    )
    return { items }
  },
}

const wantUpsert: NodeImpl = {
  spec: {
    type: 'sink.want-upsert',
    label: 'Record want',
    category: 'sink',
    description:
      'Creates a want per item (one per target, ever — an existing open/sourced want is left alone; a fulfilled one is only reopened when told to). This is what turns "a show was added" / "an episode aired" into persistent, retryable intent.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [
      { key: 'malField', label: 'MAL id field', kind: 'text', default: 'mal_id' },
      {
        key: 'kind',
        label: 'Kind',
        kind: 'select',
        options: [
          { value: 'episode', label: 'Episode (uses the episode field)' },
          { value: 'batch', label: 'Season pack' },
          { value: 'field', label: 'From item field (kindField)' },
        ],
        default: 'episode',
      },
      { key: 'kindField', label: 'Kind field', kind: 'text', default: 'want_mode', help: 'Only read when Kind = "From item field".' },
      { key: 'episodeField', label: 'Episode field', kind: 'text', default: 'torrent_episode', help: 'MAL per-cour episode number for episode wants.' },
      { key: 'reason', label: 'Reason', kind: 'text', default: 'flow', help: 'Recorded on the want: show-added | release-aired | upgrade | backfill | …' },
      { key: 'reopen', label: 'Reopen fulfilled/abandoned', kind: 'boolean', default: false, help: 'On = a fulfilled or abandoned want for the same target goes back to open (e.g. an explicit re-source). Off = it stays as-is.' },
    ],
  },
  async run(inputs, config, ctx) {
    const malField = str(config, 'malField', 'mal_id')
    const kindMode = str(config, 'kind', 'episode')
    const kindField = str(config, 'kindField', 'want_mode')
    const episodeField = str(config, 'episodeField', 'torrent_episode')
    const reason = str(config, 'reason', 'flow')
    const reopen = bool(config, 'reopen', false)
    const out: FlowItem[] = []
    let created = 0
    let reopened = 0
    let existing = 0
    let invalid = 0
    for (const item of allInputs(inputs)) {
      const mal = asNumber(item[malField])
      const kind = (kindMode === 'field' ? String(item[kindField] ?? '') : kindMode) as WantKind
      const episode = kind === 'episode' ? asNumber(item[episodeField]) : null
      if (mal == null || (kind !== 'episode' && kind !== 'batch') || (kind === 'episode' && episode == null)) {
        invalid++
        out.push(item)
        continue
      }
      if (ctx.dryRun) {
        out.push({ ...item, want_kind: kind })
        continue
      }
      const r = upsertWant({ mal_id: mal, kind, episode, reason, reopen })
      if (r.created) created++
      else if (r.reopened) reopened++
      else existing++
      out.push({ ...item, want_id: r.want.id, want_kind: kind, want_status: r.want.status })
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would record ${allInputs(inputs).length - invalid} want(s)`
        : `wants: ${created} created, ${reopened} reopened, ${existing} already tracked` +
            (invalid ? `, ${invalid} item(s) missing mal/episode` : ''),
    )
    return { out }
  },
}

const wantUpdate: NodeImpl = {
  spec: {
    type: 'sink.want-update',
    label: 'Update want',
    category: 'sink',
    description:
      'Transitions wants: record a failed search attempt (with exponential backoff before the next try), abandon, or reopen. Wire Torrent search\'s "missed" here so a fruitless hunt is remembered instead of retried blindly every run.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [
      { key: 'wantIdField', label: 'Want id field', kind: 'text', default: 'want_id' },
      {
        key: 'action',
        label: 'Action',
        kind: 'select',
        options: [
          { value: 'attempt', label: 'Record failed attempt (backoff)' },
          { value: 'abandon', label: 'Abandon' },
          { value: 'reopen', label: 'Reopen' },
        ],
        default: 'attempt',
      },
      { key: 'backoffBaseMinutes', label: 'Backoff base (minutes)', kind: 'number', default: 360, help: 'Next attempt after base × 2^attempts (capped at 32×). 360 = 6h, 12h, 24h, …' },
      { key: 'note', label: 'Note', kind: 'text', default: 'search missed', help: 'Recorded on the want; {field} placeholders are filled from the item.' },
    ],
  },
  async run(inputs, config, ctx) {
    const wantIdField = str(config, 'wantIdField', 'want_id')
    const action = str(config, 'action', 'attempt')
    const backoff = Math.max(1, num(config, 'backoffBaseMinutes', 360))
    const noteTpl = str(config, 'note', 'search missed')
    const items = allInputs(inputs)
    let updated = 0
    let skippedNoId = 0
    for (const item of items) {
      const id = asNumber(item[wantIdField])
      if (id == null) {
        skippedNoId++
        continue
      }
      if (ctx.dryRun) continue
      const note = noteTpl ? fillTemplate(noteTpl, item, 'none') : undefined
      if (action === 'attempt') recordWantAttempt(id, backoff, note)
      else if (action === 'abandon') updateWantStatus(id, 'abandoned', note)
      else updateWantStatus(id, 'open', note)
      updated++
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would ${action} ${items.length - skippedNoId} want(s)`
        : `${action}: ${updated} want(s)` + (skippedNoId ? `, ${skippedNoId} without a want_id` : ''),
    )
    return { out: items }
  },
}

// ---------------------------------------------------------------------------
// Library-import stage: expand a torrent into its video files, probe them for
// subtitle tracks, extract embedded subs we own, then place the files. These
// need the downloaded files mounted into the pod (see the source.qbittorrent
// path remap) and ffmpeg/ffprobe on PATH.
// ---------------------------------------------------------------------------
const VIDEO_EXTS_DEFAULT = 'mkv,mp4,avi,m4v,mov'
// Where flow scratch lives. Defaults to DATA_DIR — but DATA_DIR is a *small*
// node-disk PVC (1-2Gi), and the scratch nodes write GB-sized intermediates:
// `enrich.trim-audio-tracks` alone emits 3.5GB `.trimmed.mkv` files. That filled
// the node's disk and got the pod evicted (prod outage; staging nearly repeated
// it). Set WORK_DIR to a path on the big media NFS (e.g. /data/.boopwork) so
// scratch never lands on node disk. `.../work` is appended by the nodes.
//
// Safe by construction: `assertScratchVolumeSafe()` (called at boot on any
// environment that *runs* flows) refuses to start when this resolves to a
// volume below WORK_MIN_GIB — so a forgotten WORK_DIR fails loudly at deploy
// instead of silently filling the node PVC and evicting the pod at 3am.
const WORK_DIR = () =>
  process.env.WORK_DIR ?? process.env.DATA_DIR ?? path.join(process.cwd(), 'data')

// Boot guard: the library-import flow writes GB-sized intermediates, so scratch
// must never land on the small node PVC (see WORK_DIR above — that's what took
// prod down on 2026-07-11). Only call this where flows actually execute — a
// management-only environment (SCHEDULER_ENABLED=false) never writes scratch,
// so its small PVC is fine.
//
// Primary check is filesystem *identity*, not raw size: scratch must live on the
// same filesystem as LIBRARY_DIR (the big media NFS). That's also what lets
// sink.library-import hardlink the finished file into the library instead of
// copying it across filesystems. A raw capacity floor can't do this job —
// local-path PVCs don't enforce their requested size, so statfs on the node PVC
// reports the *whole node disk* (observed: 38Gi for a nominally 2Gi PVC), which
// a size threshold can't tell apart from the NFS. The device id can: if WORK_DIR
// is forgotten it falls back to DATA_DIR (the node PVC), a different device from
// the library NFS, and we refuse to start. When there's no LIBRARY_DIR to
// compare against, fall back to a best-effort capacity floor (WORK_MIN_GIB).
export function assertScratchVolumeSafe(minGiB = Number(process.env.WORK_MIN_GIB ?? 10)): void {
  const workDir = WORK_DIR()
  // stat needs an existing path; walk up to the nearest ancestor that exists
  // (the `work` subdir is created lazily by the nodes on first write).
  let probe = path.resolve(workDir)
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break // reached the filesystem root
    probe = parent
  }

  // Primary: scratch and the media library must share a filesystem.
  const libDir = LIBRARY_DIR()
  if (libDir && fs.existsSync(libDir)) {
    let workDev: number | undefined
    let libDev: number | undefined
    try { workDev = fs.statSync(probe).dev } catch { /* fall through to floor */ }
    try { libDev = fs.statSync(libDir).dev } catch { /* fall through to floor */ }
    if (workDev != null && libDev != null) {
      if (workDev !== libDev) {
        const src = process.env.WORK_DIR ? 'WORK_DIR' : process.env.DATA_DIR ? 'DATA_DIR' : 'the default'
        throw new Error(
          `flow scratch dir "${workDir}" (from ${src}) is on a different filesystem than the media library ` +
          `"${libDir}". Scratch has fallen back to the small node PVC instead of the media NFS; the ` +
          `library-import flow writes GB-sized intermediates (trim-audio-tracks alone emits ~3.5GB per ` +
          `episode) and will fill the node disk and evict the pod. Set WORK_DIR to a path on the same ` +
          `filesystem as LIBRARY_DIR (the media NFS), or set SCHEDULER_ENABLED=false for a management-only ` +
          `environment.`,
        )
      }
      console.log(`[work-guard] scratch dir "${workDir}" shares the media filesystem with "${libDir}" — ok`)
      return
    }
  }

  // Fallback: no LIBRARY_DIR to compare against — best-effort capacity floor.
  let totalGiB: number
  try {
    const st = fs.statfsSync(probe)
    totalGiB = (st.blocks * st.bsize) / 2 ** 30
  } catch (err) {
    // Can't stat (unusual FS / permissions) — warn but don't block boot; the
    // pruner and ephemeral-storage limit are still in place as backstops.
    console.warn(`[work-guard] could not stat scratch volume at ${probe}; skipping capacity check:`, err)
    return
  }
  if (totalGiB < minGiB) {
    const src = process.env.WORK_DIR ? 'WORK_DIR' : process.env.DATA_DIR ? 'DATA_DIR' : 'the default'
    throw new Error(
      `flow scratch dir "${workDir}" (from ${src}) is on a ${totalGiB.toFixed(1)}Gi volume, below the ` +
      `${minGiB}Gi floor. The library-import flow writes GB-sized intermediates (trim-audio-tracks alone ` +
      `emits ~3.5GB per episode) and will fill this volume and evict the pod. Point WORK_DIR at the big ` +
      `media NFS (e.g. a .boopwork dir on the same filesystem as LIBRARY_DIR), set SCHEDULER_ENABLED=false ` +
      `for a management-only environment, or lower the floor with WORK_MIN_GIB.`,
    )
  }
  console.log(`[work-guard] scratch volume "${workDir}" ok (${totalGiB.toFixed(0)}Gi ≥ ${minGiB}Gi floor)`)
}

// The library-import nodes (extract-subs, mux-tracks, …) drop intermediate
// files — extracted subs, fonts, muxed MKVs — under DATA_DIR/work. Nothing ever
// removed them, so on an unbounded local-path PVC they accumulated to 16GB,
// filled the node's disk, and kubelet evicted prod (an outage). Prune entries
// older than WORK_TTL_HOURS (default 24h) so scratch is self-limiting. The age
// cutoff means an in-progress job (touched within the window) is never touched.
export function pruneWorkDir(ttlHours = Number(process.env.WORK_TTL_HOURS ?? 24)): { removed: number; freedMB: number } {
  const workDir = path.join(WORK_DIR(), 'work')
  const cutoff = Date.now() - ttlHours * 3600_000
  let removed = 0
  let freedBytes = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workDir, { withFileTypes: true })
  } catch {
    return { removed: 0, freedMB: 0 } // no work dir yet
  }
  for (const ent of entries) {
    const p = path.join(workDir, ent.name)
    try {
      // Use the *newest* mtime in the subtree so a dir with a recent write is
      // kept even if its own mtime is old (a job actively writing into it).
      const newest = newestMtime(p)
      if (newest >= cutoff) continue
      const size = dirSize(p)
      fs.rmSync(p, { recursive: true, force: true })
      removed++
      freedBytes += size
    } catch {
      // best-effort; a file held open or a race just gets skipped this pass
    }
  }
  if (removed > 0) {
    console.log(`[work-prune] removed ${removed} stale entries (~${Math.round(freedBytes / 1e6)}MB) from ${workDir}`)
  }
  return { removed, freedMB: Math.round(freedBytes / 1e6) }
}

function newestMtime(p: string): number {
  let newest = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop() as string
    let st: fs.Stats
    try { st = fs.statSync(cur) } catch { continue }
    if (st.mtimeMs > newest) newest = st.mtimeMs
    if (st.isDirectory()) {
      try { for (const c of fs.readdirSync(cur)) stack.push(path.join(cur, c)) } catch { /* skip */ }
    }
  }
  return newest
}

function dirSize(p: string): number {
  let total = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop() as string
    let st: fs.Stats
    try { st = fs.statSync(cur) } catch { continue }
    if (st.isDirectory()) {
      try { for (const c of fs.readdirSync(cur)) stack.push(path.join(cur, c)) } catch { /* skip */ }
    } else {
      total += st.size
    }
  }
  return total
}

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
    inputs: [{ id: 'in', label: 'in', dataType: 'torrent' }],
    outputs: [
      { id: 'files', label: 'files', dataType: 'file' },
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

const parseSeasonNode: NodeImpl = {
  spec: {
    type: 'transform.parse-season',
    label: 'Parse season',
    category: 'enrich',
    description:
      'Reads a season number from a release/torrent name (S03, Season 3, 3rd Season, or a roman-numeral sequel marker like "II") into a numeric field. Feed it to Match indexer title’s "Season field" so a file routes to the right season of a franchise whose per-season titles are otherwise identical.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [
      { key: 'sourceField', label: 'Name field', kind: 'text', default: 'name', help: 'Item field holding the release/torrent name. Falls back to file_name then torrent_name if empty.' },
      { key: 'targetField', label: 'Season field', kind: 'text', default: 'release_season', help: 'Numeric season written here (left unset when the name carries no season marker).' },
    ],
  },
  async run(inputs, config, ctx) {
    const sourceField = str(config, 'sourceField', 'name')
    const targetField = str(config, 'targetField', 'release_season')
    const out: FlowItem[] = []
    let parsed = 0
    for (const item of allInputs(inputs)) {
      const name = String(item[sourceField] ?? item.file_name ?? item.torrent_name ?? '')
      const season = parseSeason(name)
      if (season != null) {
        out.push({ ...item, [targetField]: season })
        parsed++
      } else {
        // No marker — leave the field unset so the matcher stays unrestricted.
        out.push(item)
      }
    }
    ctx.notes.push(`parsed a season for ${parsed}/${out.length} item(s)`)
    return { out }
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
    inputs: [{ id: 'in', label: 'in', dataType: 'file' }],
    outputs: [
      { id: 'probed', label: 'probed', dataType: 'probed' },
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
    inputs: [{ id: 'in', label: 'in', dataType: 'file' }],
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
    inputs: [{ id: 'in', label: 'in', dataType: 'file' }],
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

// Drops audio tracks outside a language allow-list (stream copy, no
// re-encode) — e.g. a BD-batch release bundles an incidental German/French
// dub we never want in the library. Video and subtitle tracks pass through
// untouched.
const trimAudioTracks: NodeImpl = {
  spec: {
    type: 'enrich.trim-audio-tracks',
    label: 'Trim audio tracks',
    category: 'enrich',
    description:
      'Drops audio tracks whose language isn\'t in the keep-list (stream copy, no re-encode) — e.g. strips an incidental German/French dub a batch release bundled in, keeping just jpn/eng. Video and subtitle tracks pass through untouched. Files that already only have wanted languages route to "unchanged" without a re-mux.',
    inputs: [{ id: 'in', label: 'in', dataType: 'file' }],
    outputs: [
      { id: 'trimmed', label: 'trimmed' },
      { id: 'unchanged', label: 'unchanged' },
    ],
    config: [
      { key: 'fileField', label: 'File field', kind: 'text', default: 'file_path' },
      {
        key: 'keepLangs',
        label: 'Languages to keep',
        kind: 'text',
        default: 'jpn,eng',
        help: 'ISO 639-2 codes, comma-separated. Audio tracks with no language tag are always kept (can\'t be classified).',
      },
      { key: 'outDir', label: 'Output dir', kind: 'text', default: '', help: 'Where the trimmed file lands. Empty = DATA_DIR/work.' },
    ],
  },
  async run(inputs, config, ctx) {
    const fileField = str(config, 'fileField', 'file_path')
    const keep = str(config, 'keepLangs', 'jpn,eng').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const outDir = str(config, 'outDir', '') || path.join(WORK_DIR(), 'work')

    const trimmed: FlowItem[] = []
    const unchanged: FlowItem[] = []

    for (const item of allInputs(inputs)) {
      const file = String(item[fileField] ?? '')
      if (!file) { unchanged.push(item); continue }
      try {
        const { stdout } = await execFileP(
          'ffprobe',
          ['-v', 'quiet', '-print_format', 'json', '-show_streams', file],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        )
        const streams = (JSON.parse(stdout).streams ?? []) as ProbeStream[]
        const drop = streams.filter((s) => {
          if (s.codec_type !== 'audio') return false
          const lang = (s.tags?.language ?? '').toLowerCase()
          if (!lang) return false // unclassified — keep rather than risk dropping the only track
          return !keep.some((k) => lang === k || lang.startsWith(k))
        })
        if (drop.length === 0) { unchanged.push(item); continue }

        const ext = path.extname(file)
        const base = path.basename(file, ext)
        const dest = path.join(outDir, `${base}.trimmed${ext}`)
        if (ctx.dryRun) {
          trimmed.push({
            ...item,
            [fileField]: dest,
            trimmed_audio_langs: drop.map((s) => s.tags?.language || 'und').join(','),
          })
          continue
        }
        fs.mkdirSync(outDir, { recursive: true })
        const args = ['-y', '-v', 'error', '-i', file, '-map', '0']
        for (const s of drop) args.push('-map', `-0:${s.index}`)
        args.push('-c', 'copy', dest)
        await execFileP('ffmpeg', args, { timeout: 300_000 })
        trimmed.push({
          ...item,
          [fileField]: dest,
          trimmed_audio_langs: drop.map((s) => s.tags?.language || 'und').join(','),
        })
      } catch (e) {
        ctx.notes.push(`trim failed for ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`)
        unchanged.push(item)
      }
    }
    ctx.notes.push(
      ctx.dryRun
        ? `dry run — would trim ${trimmed.length} file(s), ${unchanged.length} already clean`
        : `trimmed ${trimmed.length} file(s), ${unchanged.length} already clean`,
    )
    return { trimmed, unchanged }
  },
}

// A normalized catalog record, produced from either AniList (primary) or Jikan
// (fallback), so the enrich node's write/emit logic is source-agnostic.
type CatalogRecord = {
  base: { title: string; synopsis: string | null; image_url: string | null; url: string }
  meta: {
    title_english: string | null
    title_japanese: string | null
    type: string | null
    episodes: number | null
    status: string | null
    score: number | null
    year: number | null
    season: string | null
    aired: string | null
    studios: string
    genres: string
    broadcast: string | null
  }
}

function aniListToCatalog(a: AniListMedia, mal: number): CatalogRecord {
  return {
    base: {
      title: a.title,
      synopsis: a.synopsis,
      image_url: a.coverImage,
      url: `https://myanimelist.net/anime/${mal}`,
    },
    meta: {
      title_english: a.titleEnglish,
      title_japanese: a.titleNative,
      type: a.type,
      episodes: a.totalEpisodes,
      status: a.status,
      score: a.score,
      year: a.year,
      season: a.season,
      aired: a.airedString,
      studios: JSON.stringify(a.studios),
      genres: JSON.stringify(a.genres),
      broadcast: a.broadcast ? JSON.stringify(a.broadcast) : null,
    },
  }
}

function jikanToCatalog(a: JikanAnimeFull): CatalogRecord {
  return {
    base: {
      title: a.title,
      synopsis: a.synopsis ?? null,
      image_url: pickPosterUrl(a as unknown as Parameters<typeof pickPosterUrl>[0]),
      url: a.url,
    },
    meta: {
      title_english: a.title_english ?? null,
      title_japanese: a.title_japanese ?? null,
      type: a.type ?? null,
      episodes: a.episodes ?? null,
      status: a.status ?? null,
      score: a.score ?? null,
      year: a.year ?? null,
      season: a.season ?? null,
      aired: a.aired?.string ?? null,
      studios: JSON.stringify((a.studios ?? []).map((s) => s.name)),
      genres: JSON.stringify((a.genres ?? []).map((g) => g.name)),
      broadcast: a.broadcast
        ? JSON.stringify({
            day: a.broadcast.day ?? null,
            time: a.broadcast.time ?? null,
            timezone: a.broadcast.timezone ?? null,
            string: a.broadcast.string ?? null,
          })
        : null,
    },
  }
}

/** Resolve a catalog record for a mal_id — AniList first (current, not
 * rate-limit-prone), Jikan only if AniList can't answer. Returns the record and
 * which source produced it (for observability). Throws only if both fail. */
async function resolveCatalog(mal: number): Promise<{ record: CatalogRecord; source: 'anilist' | 'jikan' }> {
  const al = await fetchAniListMedia(mal)
  if (al) return { record: aniListToCatalog(al, mal), source: 'anilist' }
  return { record: jikanToCatalog(await fetchAnimeFull(mal)), source: 'jikan' }
}

const metadataEnrich: NodeImpl = {
  spec: {
    type: 'enrich.metadata',
    label: 'Fetch metadata (AniList)',
    category: 'enrich',
    description:
      'Pulls full catalog metadata by mal_id (titles, year, episodes, status, score, studios, genres) into our own catalog DB, and sets those fields on the item (e.g. production_year for the import path). AniList-primary (current + auth-free); falls back to MyAnimeList/Jikan only when AniList can’t answer.',
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
    // A library-import run feeds this node one item per FILE, so the same
    // mal_id arrives dozens of times — memoise per run (observed: ~100
    // identical metadata fetches for one show in one run).
    const memo = new Map<number, CatalogRecord>()
    const seasonNoted = new Set<number>()
    let looked = 0
    let jikanFallbacks = 0
    for (const item of items) {
      const mal = Number(item[malField])
      if (!Number.isFinite(mal) || mal <= 0 || (!memo.has(mal) && maxItems > 0 && looked >= maxItems)) {
        skipped.push(item)
        continue
      }
      if (!memo.has(mal)) looked++
      try {
        let record = memo.get(mal)
        if (!record) {
          const resolved = await resolveCatalog(mal)
          record = resolved.record
          memo.set(mal, record)
          if (resolved.source === 'jikan') jikanFallbacks++
        }
        const { base, meta } = record
        const studios = meta.studios
        const genres = meta.genres
        if (writeDb && !ctx.dryRun) {
          upsertSeriesMetadata({ mal_id: mal, ...base }, meta)
        }
        // Resolve the multi-season placement (TVDB season + episode offset) so a
        // cour lands under the right Jellyfin `Season NN` at the right episode
        // numbers. Best-effort: a lookup failure just leaves the item unmapped
        // (import falls back to season 1 / no offset, the old behaviour). Writes
        // to the catalog row only when persisting metadata, and never over a
        // manual override.
        let season: Awaited<ReturnType<typeof enrichSeasonMapping>> = null
        try {
          season = await enrichSeasonMapping(mal, { write: writeDb && !ctx.dryRun })
        } catch (e) {
          ctx.notes.push(`season-map lookup failed for mal ${mal}: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (season && !seasonNoted.has(mal)) {
          seasonNoted.add(mal)
          ctx.notes.push(
            `mal ${mal} → tvdb ${season.tvdbId ?? '?'} S${season.tvdbSeason ?? '?'} +${season.episodeOffset}` +
              (season.reason ? ` (${season.reason})` : ''),
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
          // Multi-season placement (null when unmapped) — consumed by
          // sink.library-import for {season} and the episode offset.
          ...(season?.tvdbId != null ? { tvdb_id: season.tvdbId } : {}),
          ...(season?.tvdbSeason != null ? { tvdb_season: season.tvdbSeason } : {}),
          ...(season ? { episode_offset: season.episodeOffset } : {}),
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
      (ctx.dryRun
        ? `dry run — resolved ${enriched.length} metadata record(s)${writeDb ? ' (not written)' : ''}`
        : `enriched ${enriched.length}${writeDb ? ' (written to catalog)' : ''}, skipped ${skipped.length}`) +
        (jikanFallbacks ? `; ${jikanFallbacks} via Jikan fallback` : ''),
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
        help: 'WebUI base URL, e.g. http://qbittorrent:8080. Empty = QBIT_URL env.',
      },
      { key: 'username', label: 'Username', kind: 'text', default: '', help: 'Empty = QBIT_USERNAME env.' },
      { key: 'password', label: 'Password', kind: 'password', default: '', help: 'Empty = QBIT_PASSWORD env.' },
      { key: 'urlField', label: 'Magnet field', kind: 'text', default: 'torrent_magnet' },
      { key: 'category', label: 'Category', kind: 'text', default: 'anime' },
      {
        key: 'tags',
        label: 'Tags',
        kind: 'text',
        default: 'mal:{mal_id},season:{tvdb_season},ep:{torrent_episode}',
        help: 'Per-torrent qBittorrent tags, {field} filled from the item. Stamps the identity we already decided, so the import reads it back instead of re-guessing the cour from the release name. Tags whose value is empty are dropped. Empty = no tags.',
      },
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
    let withMagnet = items.filter((it) => String(it[urlField] ?? '').startsWith('magnet:'))
    if (items.length > withMagnet.length) {
      ctx.notes.push(`skipped ${items.length - withMagnet.length} items without a magnet link`)
    }
    // The "nothing gets queued twice" guard: refuse hashes the torrent ledger
    // already tracks (queued, downloading, completed, imported, exhausted, …
    // — everything except failed). This is what stops a flow that re-decides
    // it needs something from re-sending the same magnet run after run.
    const blocked = blockedTorrentHashes()
    const already = withMagnet.filter((it) => {
      const h = String(it.torrent_hash ?? '').toLowerCase()
      return h !== '' && blocked.has(h)
    })
    if (already.length > 0) {
      withMagnet = withMagnet.filter((it) => !already.includes(it))
      ctx.notes.push(`skipped ${already.length} already tracked in the torrent ledger`)
      // Resolve the wants that led here, or the chase re-searches them
      // forever: a tracked-as-imported torrent already provides the content
      // (fulfil); one still in flight means the want is sourced by it; junk
      // statuses record a miss so backoff moves the search elsewhere.
      if (!ctx.dryRun) {
        for (const it of already) {
          const wantId = asNumber(it.want_id)
          const h = String(it.torrent_hash ?? '').toLowerCase()
          if (wantId == null) continue
          const t = getTorrent(h)
          if (!t) continue
          // The tracked torrent only satisfies the want when it's the same
          // series. A cross-series hit (title relevance matched a sibling
          // season's torrent — S4E11 for an S1 want, observed on prod) must
          // NOT fulfil; it's a failed search, back off and retry elsewhere.
          const wantMal = asNumber(it.mal_id)
          const sameSeries = t.mal_id == null || wantMal == null || t.mal_id === wantMal
          if (!sameSeries) {
            recordWantAttempt(
              wantId,
              360,
              `search matched torrent ${h.slice(0, 8)} of a different series (mal ${t.mal_id} ≠ ${wantMal}) — backing off`,
            )
            continue
          }
          if (t.status === 'imported') {
            fulfilWantById(wantId, h, 'already imported by a tracked torrent')
          } else if (t.status === 'queued' || t.status === 'downloading' || t.status === 'completed') {
            markWantSourced(wantId, h)
          } else {
            // exhausted / superseded / cleaned — this release is a dead end.
            recordWantAttempt(
              wantId,
              360,
              `search re-picked ${t.status} torrent ${h.slice(0, 8)} — backing off`,
            )
          }
        }
      }
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

    // `torrents/add` takes one tag set for the whole batch, but each magnet has
    // its own identity — so tag per hash, alongside the rename.
    const tagTpl = str(config, 'tags', 'mal:{mal_id},season:{tvdb_season},ep:{torrent_episode}')
    /** Drop `key:` pairs whose value didn't resolve — a batch has no single
     * episode, and a half-filled tag is worse than none. */
    const tagsFor = (it: FlowItem): string =>
      fillTemplate(tagTpl, it, 'none')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => /^[^:]+:.+$/.test(t))
        .join(',')

    // Give each torrent the readable name we already have from search, keyed by
    // its info-hash. This makes paused magnets (which can't fetch their own
    // metadata) reviewable instead of showing as a bare hash. Best-effort.
    let renamed = 0
    let tagged = 0
    let ledgered = 0
    let untracked = 0
    for (const it of withMagnet) {
      const hash = String(it.torrent_hash ?? '').toLowerCase()
      const name = String(it.torrent_name ?? '')
      if (!hash) {
        // A magnet without an info-hash field can't be tracked or guarded —
        // it was still sent, so say so rather than silently losing it.
        untracked++
        continue
      }
      // Ledger the queue while we still know why it happened: identity from
      // the search/status nodes, the want it satisfies, and the provider.
      const epNum = asNumber(it.torrent_episode)
      const kind = String(
        it.want_kind ?? it.want_mode ?? (it.torrent_is_batch ? 'batch' : epNum != null ? 'episode' : ''),
      )
      recordTorrentQueued({
        hash,
        mal_id: asNumber(it.mal_id),
        kind: kind || null,
        episode: epNum,
        tvdb_season: asNumber(it.tvdb_season),
        want_id: asNumber(it.want_id),
        name: name || null,
        category: str(config, 'category', 'anime') || null,
        provider: it.torrent_provider != null ? String(it.torrent_provider) : null,
        size: asNumber(it.torrent_size),
      })
      const wantId = asNumber(it.want_id)
      if (wantId != null) markWantSourced(wantId, hash)
      ledgered++
      const tags = tagTpl ? tagsFor(it) : ''
      if (tags) {
        try {
          const r = await fetch(`${base}/api/v2/torrents/addTags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
            body: new URLSearchParams({ hashes: hash, tags }),
            signal: AbortSignal.timeout(10_000),
          })
          if (r.ok) tagged++
        } catch {
          /* tagging is best-effort; the import still falls back to matching */
        }
      }
      if (!name) continue
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
        (renamed ? `, named ${renamed}` : '') +
        (tagged ? `, tagged ${tagged}` : '') +
        (ledgered ? `, ledgered ${ledgered}` : '') +
        (untracked ? `, ${untracked} WITHOUT a hash (untracked!)` : ''),
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
      {
        key: 'reason',
        label: 'Ledger status',
        kind: 'select',
        options: [
          { value: 'cleaned', label: 'Cleaned (routine post-import removal)' },
          { value: 'superseded', label: 'Superseded (a better release replaced it)' },
        ],
        default: 'cleaned',
        help: 'What the torrent ledger records for the removed torrents — provenance for why they left qBittorrent.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const hashField = str(config, 'hashField', 'torrent_hash')
    const deleteFiles = bool(config, 'deleteFiles', true)
    const reason = str(config, 'reason', 'cleaned') === 'superseded' ? 'superseded' : 'cleaned'
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
    // Ledger the removal for hashes we track (unknown hashes stay unknown —
    // this node must not invent provenance for torrents it didn't queue).
    let ledgered = 0
    for (const h of hashes) if (setTorrentStatus(h, reason)) ledgered++
    ctx.notes.push(
      `removed ${hashes.length} torrent(s)${deleteFiles ? ' + files' : ''}` +
        (ledgered ? `, ledgered ${ledgered} as ${reason}` : ''),
    )
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

/** Strip cour/season suffixes from a MAL title so multi-season imports land in
 * the franchise folder ("… as a Slime Season 4" → "… as a Slime") when we have
 * a tvdb_season to place under Season N. Leaves single-cour titles alone. */
function franchiseShowName(show: string, hasTvdbSeason: boolean): string {
  if (!hasTvdbSeason) return show
  const stripped = show
    .replace(
      /\s*(?:[:\-–—]\s*)?(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|Cour\s+\d+|第\d+期)\s*$/i,
      '',
    )
    .trim()
  return stripped || show
}

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

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm'])

/** Find an already-imported video for this season/episode by its SxxExx
 * marker, regardless of the rest of the filename — so a `pathTemplate` edit
 * (or a differently-named legacy import) still finds the old release instead
 * of treating it as new and leaving two files for one episode. */
function findSiblingEpisodeFile(destDir: string, marker: string, excludeBasename: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(destDir)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name === excludeBasename) continue
    if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue
    if (name.includes(marker)) return path.join(destDir, name)
  }
  return null
}

/**
 * Two imports of the same show can render different folder names: `{show}
 * ({production_year})` carries the *cour's* year onto a *franchise* folder, so
 * Slime S1 wants "… Slime (2018)" and S4 wants "… Slime (2026)" — and when the
 * metadata hasn't resolved, `sanitizeSegments` drops the empty "()" and yields a
 * third variant. `Season {season:2}` likewise renders "Season 04" where an older
 * import wrote "Season 4". Normalising those away lets us reuse the directory
 * that already holds the show instead of splitting it in two.
 */
function normalizeDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/, '')
    .replace(/^season\s*0*(\d+)$/, 'season $1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The directory to use for one templated segment: an existing directory that
 * differs only by a `(year)` suffix or season padding, else `wanted` itself.
 *
 * Note we deliberately do NOT short-circuit on `existsSync(wanted)`: once a
 * `… (2026)` twin exists alongside the legacy `…` folder, returning the exact
 * templated name would keep every import landing in the twin, and Jellyfin
 * indexes it as a second, separate (and non-Public) series — the episodes never
 * surface on the portal, so the chase sits at "importing" forever. Always run
 * the normalised match and pick the canonical twin so both folders converge. */
function resolveDirSegment(parent: string, wanted: string): string {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return wanted
  }
  const target = normalizeDirName(wanted)
  // Sorted so the choice is deterministic while a duplicate pair still exists;
  // the un-suffixed legacy name sorts before its "… (2026)" twin, and an
  // unpadded "Season 4" resolves within it once the show folder converges.
  const matches = entries
    .filter((e) => e.isDirectory() && normalizeDirName(e.name) === target)
    .map((e) => e.name)
    .sort()
  return matches[0] ?? wanted
}

/** Re-point a templated relative path at the directories already on disk. */
function resolveExistingPath(root: string, rel: string): string {
  const parts = rel.split('/')
  const file = parts.pop() as string
  let dir = root
  const resolved: string[] = []
  for (const seg of parts) {
    const use = resolveDirSegment(dir, seg)
    resolved.push(use)
    dir = path.join(dir, use)
  }
  return [...resolved, file].join('/')
}

const libraryImport: NodeImpl = {
  spec: {
    type: 'sink.library-import',
    label: 'Import to library',
    category: 'sink',
    description:
      'Places each video file into the media library at a templated path (hardlink, falling back to copy across filesystems), moving its subtitle sidecars alongside. This is what makes a download watchable.',
    inputs: [{ id: 'in', label: 'in', dataType: 'file' }],
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

    // One catalog read per run, not per item.
    let catalogRows: ReturnType<typeof listSeries> | null = null
    const catalog = () => (catalogRows ??= listSeries())

    /** True when this mal_id is one cour of a multi-season franchise (siblings
     * share its tvdb_id). Guessing Season 1 for such a file buries a later
     * cour's episodes under the wrong season — better to skip and say so. */
    const isMultiCourFranchise = (malId: unknown): boolean => {
      const mal = asNumber(malId)
      if (mal == null) return false
      const row = catalog().find((s) => s.mal_id === mal)
      if (!row || row.tvdb_id == null) return false
      return catalog().filter((s) => s.tvdb_id === row.tvdb_id).length > 1
    }

    const imported: FlowItem[] = []
    const skipped: FlowItem[] = []
    let copied = 0
    for (const item of allInputs(inputs)) {
      const src = String(item[fileField] ?? '')
      const rawShow = String(item[showField] ?? item.title ?? item.name ?? item.series_name ?? '').trim()
      if (!src || !rawShow) {
        ctx.notes.push(`skipped an item missing file or show name`)
        skipped.push({ ...item, import_status: 'missing-fields' })
        continue
      }
      // Never create a library folder from a torrent release name — that becomes
      // a junk Jellyfin "series" (Erai-raws / Yameii folders) and can leak into Public.
      if (looksLikeReleaseName(rawShow) && item.tvdb_season == null && !item.title_english && !item.title) {
        ctx.notes.push(`skipped release-named show folder: ${rawShow.slice(0, 80)}`)
        skipped.push({ ...item, import_status: 'release-name' })
        continue
      }
      const ext = path.extname(src)
      // Multi-season placement: tvdb_season (set by enrich.metadata from the
      // season-map dataset) is the Jellyfin season number this cour belongs to,
      // and episode_offset shifts a cour's per-cour episode numbers to their
      // absolute slot within that season (S1 cour 2 → +11). Both fall back to
      // the old behaviour (season 1 / no offset) when unmapped.
      const knownSeason = item.tvdb_season ?? item.tag_season ?? item.season ?? item.parent_index_number
      if (knownSeason == null && isMultiCourFranchise(item.mal_id)) {
        ctx.notes.push(`skipped "${rawShow.slice(0, 60)}" — multi-season franchise with no resolved season`)
        skipped.push({ ...item, import_status: 'unresolved-season' })
        continue
      }
      const season = knownSeason ?? defaultSeason
      const show = franchiseShowName(rawShow, item.tvdb_season != null)
      const baseEp = item.torrent_episode ?? item.index_number
      const offset = Number(item.episode_offset ?? 0)
      const epNum = Number(baseEp)
      const episode =
        Number.isFinite(epNum) && Number.isFinite(offset) ? epNum + offset : (baseEp ?? '')
      // An unresolved episode renders `{torrent_episode:2}` as nothing, and the
      // file lands as "… - S02E.mkv": Jellyfin can't number it, so it shows up
      // as a nameless ghost episode (and a duplicate series). Refuse instead.
      if (tpl.includes('{torrent_episode') && asNumber(episode) == null) {
        ctx.notes.push(`skipped "${rawShow.slice(0, 60)}" — no episode number resolved`)
        skipped.push({ ...item, import_status: 'unresolved-episode' })
        continue
      }
      // Expose derived template fields without mutating the item.
      const ctxItem: FlowItem = {
        ...item,
        show,
        season,
        torrent_episode: episode,
      }
      const templated = sanitizeSegments(fillPathTemplate(tpl, ctxItem))
      if (!templated) {
        ctx.notes.push(`skipped "${show}" — template produced an empty path`)
        skipped.push({ ...item, import_status: 'empty-path' })
        continue
      }
      // Land in the folder that already holds this show/season rather than the
      // one the template happens to name today.
      const rel = resolveExistingPath(root, templated)
      const dest = path.join(root, rel + ext)
      const destDir = path.dirname(dest)
      // Match any existing file for this episode by its SxxExx marker, not
      // just the exact templated name — a `pathTemplate` edit (or a
      // differently-named legacy import) must still find the old release, or
      // it gets left behind as a second file Jellyfin indexes as a duplicate
      // episode.
      const seasonNum = asNumber(season)
      const episodeNum = asNumber(episode)
      const marker =
        seasonNum != null && episodeNum != null
          ? `S${String(Math.trunc(seasonNum)).padStart(2, '0')}E${String(Math.trunc(episodeNum)).padStart(2, '0')}`
          : null
      const destBasename = path.basename(dest)
      let existing = fs.existsSync(dest) ? dest : null
      if (!existing && marker) existing = findSiblingEpisodeFile(destDir, marker, destBasename)

      // The want that asked for this file lives in MAL per-cour episode space —
      // fulfil with the PRE-offset number (epNum), never the post-offset
      // `episode` that names the library file.
      const fulfilHere = (libPath: string | null) => {
        if (ctx.dryRun) return
        const mal = asNumber(item.mal_id)
        if (mal == null) return
        const hash = item.torrent_hash != null ? String(item.torrent_hash) : null
        if (Number.isFinite(epNum)) fulfilEpisodeWant(mal, epNum, hash, libPath)
      }

      if (existing) {
        // Nothing there to upgrade → honour the plain skip. The episode is in
        // the library though, so any open want for it is satisfied.
        if (!overwrite) {
          fulfilHere(existing)
          skipped.push({ ...item, library_path: existing, import_status: 'exists' })
          continue
        }
        // Overwrite mode: only re-place when the incoming file actually differs
        // from what's already there, so re-runs don't churn (or re-trigger a
        // Jellyfin scan) but a real upgrade does replace the old file.
        if (sameLibraryFile(src, existing)) {
          // This library file *is* this torrent — free provenance for a file
          // imported before the ledger existed. Backfill it.
          if (!ctx.dryRun) {
            try {
              const st = fs.statSync(existing)
              recordLibraryFile({
                path: path.relative(root, existing),
                mal_id: asNumber(item.mal_id),
                tvdb_id: asNumber(item.tvdb_id),
                tvdb_season: asNumber(season),
                episode: asNumber(episode),
                torrent_hash: item.torrent_hash != null ? String(item.torrent_hash) : null,
                source_path: src,
                inode: st.ino,
                size: st.size,
                method: 'existing',
              })
            } catch { /* backfill is best-effort */ }
          }
          fulfilHere(existing)
          skipped.push({ ...item, library_path: existing, import_status: 'current' })
          continue
        }
      }
      // existing still set here (with overwrite) means we're replacing a
      // superseded release, e.g. swapping the sub-only file for a dual-audio one.
      const replacing = !!existing
      if (ctx.dryRun) {
        imported.push({ ...item, library_path: dest, import_method: method, import_status: replacing ? 'replaced' : 'new' })
        continue
      }
      try {
        const used = place(src, dest)
        // A stale sibling under a different name (an earlier import that used
        // an older path template) must go once the new file is safely placed,
        // or it lingers as a permanent duplicate episode.
        if (existing && existing !== dest) {
          try {
            fs.rmSync(existing)
            forgetLibraryFile(path.relative(root, existing))
          } catch (e) {
            ctx.notes.push(
              `could not remove stale duplicate ${path.basename(existing)}: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }
        // Write down what this file is while we still know. A trimmed/muxed
        // source lands here as a cross-filesystem copy, so its inode no longer
        // ties back to the torrent — the row is the only surviving provenance.
        try {
          const st = fs.statSync(dest)
          recordLibraryFile({
            path: path.relative(root, dest),
            mal_id: asNumber(item.mal_id),
            tvdb_id: asNumber(item.tvdb_id),
            tvdb_season: asNumber(season),
            episode: asNumber(episode),
            torrent_hash: item.torrent_hash != null ? String(item.torrent_hash) : null,
            source_path: src,
            inode: st.ino,
            size: st.size,
            method: used,
          })
        } catch (e) {
          ctx.notes.push(`ledger write failed for ${path.basename(dest)}: ${e instanceof Error ? e.message : String(e)}`)
        }
        fulfilHere(dest)
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
        skipped.push({ ...item, import_status: 'error' })
      }
    }

    // Torrent-level outcomes. A torrent that placed at least one file is
    // `imported`; one whose every file was skipped for a *terminal* reason is
    // `exhausted` — the marker that finally stops a junk torrent from
    // re-firing this flow every run. Transient failures (I/O errors) leave it
    // as-is so the next pass retries.
    if (!ctx.dryRun) {
      const TERMINAL = new Set([
        'missing-fields',
        'release-name',
        'unresolved-season',
        'unresolved-episode',
        'empty-path',
        'exists',
        'current',
      ])
      const byHash = new Map<
        string,
        { first: FlowItem; imported: number; terminal: Set<string>; transient: number }
      >()
      const agg = (it: FlowItem) => {
        const h = String(it.torrent_hash ?? '').toLowerCase()
        if (!h) return null
        let a = byHash.get(h)
        if (!a) byHash.set(h, (a = { first: it, imported: 0, terminal: new Set(), transient: 0 }))
        return a
      }
      for (const it of imported) {
        const a = agg(it)
        if (a) a.imported++
      }
      for (const it of skipped) {
        const a = agg(it)
        if (!a) continue
        const s = String(it.import_status ?? '')
        if (TERMINAL.has(s)) a.terminal.add(s)
        else a.transient++
      }
      let outImported = 0
      let outExhausted = 0
      for (const [hash, a] of byHash) {
        const identity = {
          hash,
          mal_id: asNumber(a.first.mal_id),
          kind: a.first.want_kind != null ? String(a.first.want_kind) : a.first.torrent_is_batch ? 'batch' : null,
          episode: asNumber(a.first.torrent_episode),
          tvdb_season: asNumber(a.first.tvdb_season),
          name: String(a.first.torrent_name ?? '') || null,
          category: String(a.first.torrent_category ?? '') || null,
        }
        if (a.imported > 0) {
          recordTorrentOutcome(identity, 'imported', { imported_files: a.imported })
          outImported++
          // A finished season pack satisfies its batch want (episode wants
          // were fulfilled per file above).
          const row = getTorrent(hash)
          const mal = asNumber(a.first.mal_id) ?? row?.mal_id ?? null
          if (mal != null && (row?.kind === 'batch' || a.first.torrent_is_batch === true)) {
            fulfilBatchWant(Number(mal), hash)
          }
        } else if (a.terminal.size > 0 && a.transient === 0) {
          recordTorrentOutcome(identity, 'exhausted', {
            note: `all files skipped: ${[...a.terminal].join(', ')}`,
          })
          outExhausted++
        }
      }
      if (outImported || outExhausted) {
        ctx.notes.push(
          `torrent ledger: ${outImported} imported` + (outExhausted ? `, ${outExhausted} exhausted` : ''),
        )
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

/** True when a Jellyfin/folder name looks like a torrent release, not a show title.
 * Those must never be added to Public or treated as franchise folders. */
export function looksLikeReleaseName(name: string): boolean {
  const n = name.trim()
  if (!n) return false
  if (/^\[[^\]]+\]/.test(n)) return true // [Group] …
  if (/\b(1080p|720p|480p|2160p|WEB-?DL|WEBRip|BDRip|BluRay|HEVC|x264|x265|AV1|MultiSub|Dual-?Audio)\b/i.test(n)) {
    return true
  }
  if (/\[[0-9A-F]{8}\]/i.test(n)) return true // CRC tag
  return false
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
    const jfName = it.Name || ''
    // Never promote a release-folder "series" into the Public collection.
    if (looksLikeReleaseName(jfName)) continue
    const hay = norm(jfName)
    const present = wanted.filter((t) => hay.includes(t)).length
    const score = present / wanted.length
    if (!best || score > best.score) best = { id: it.Id, name: jfName, score }
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

// A wire-routing waypoint (the editor renders it as a movable dot): passes its
// input straight through unchanged, so it's transparent at run time. Its output
// is untyped, so the connection's record type propagates through it.
const reroute: NodeImpl = {
  spec: {
    type: 'transform.reroute',
    label: 'Reroute',
    category: 'combine',
    description: 'A movable anchor for routing wires — passes its input through unchanged.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [],
  },
  async run(inputs) {
    return { out: allInputs(inputs) }
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

// Longest a Delay will actually wait — the run holds the single flow lock, so an
// unbounded delay would block the scheduler and other runs.
const MAX_DELAY_S = 600

const delay: NodeImpl = {
  spec: {
    type: 'transform.delay',
    label: 'Delay',
    category: 'enrich',
    description:
      'Waits the configured time, then passes its input straight through unchanged. Waits once (not per item). Set Max seconds above Delay for a uniform random wait in that range (jitter). A dry run skips the wait unless "Run on dry runs" is on. Capped at 10 minutes — the run holds the flow lock while waiting.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [
      { key: 'seconds', label: 'Delay (seconds)', kind: 'number', default: 5 },
      {
        key: 'maxSeconds',
        label: 'Max seconds (optional)',
        kind: 'number',
        default: 0,
        help: '0 = fixed delay. When greater than Delay, wait a random duration in [Delay, Max]. Both ends are capped at 10 minutes.',
      },
      runOnDryField(false),
    ],
  },
  async run(inputs, config, ctx) {
    const items = allInputs(inputs)
    const lo = Math.min(Math.max(0, num(config, 'seconds', 5)), MAX_DELAY_S)
    const rawMax = num(config, 'maxSeconds', 0)
    const hi = Math.min(Math.max(0, rawMax), MAX_DELAY_S)
    const jitter = hi > lo
    const seconds = jitter ? sampleRandom(lo, hi, false) : lo
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
    const rangeNote = jitter ? ` (jitter [${fmt(lo)}, ${fmt(hi)}))` : ''
    if (runsLive(config, ctx, false)) {
      if (seconds > 0) await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      ctx.notes.push(`waited ${fmt(seconds)}s${rangeNote}, passed ${items.length} item(s)`)
    } else {
      ctx.notes.push(
        jitter
          ? `would wait ${fmt(lo)}–${fmt(hi)}s (jitter), then pass ${items.length} item(s)`
          : `would wait ${fmt(seconds)}s, then pass ${items.length} item(s)`,
      )
    }
    return { out: items }
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

// Runs a published flow as a composite node: the caller's per-port items feed
// the referenced graph's boundary.input nodes, and the referenced graph's
// boundary.output nodes become this node's outputs. The static spec below is
// a placeholder — real instances get their actual ports from the referenced
// flow's derived interface via componentToNodeSpec (see flowComponents.ts),
// swapped in client-side and by buildSpecResolver during graph validation.
//
// Imports runFlow dynamically to dodge the flowExecutor <-> flowNodes import
// cycle (flowExecutor imports NODE_REGISTRY from this file at module scope).
const subflow: NodeImpl = {
  spec: {
    type: 'flow.subflow',
    label: 'Sub-flow',
    category: 'combine',
    description: 'Runs a published flow as a composite node.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'out' }],
    config: [{ key: 'flowId', label: 'Component flow', kind: 'number' }],
  },
  run: async (inputs, config, ctx) => {
    const flowId = Number(config.flowId)
    if (!Number.isFinite(flowId)) throw new Error('flowId required')

    const row = getFlow(flowId)
    if (!row) throw new Error(`Flow ${flowId} not found`)
    const meta = parseComponent(row.component)
    if (!meta?.published) throw new Error(`Flow ${flowId} is not a published component`)

    const graph = JSON.parse(row.graph) as FlowGraph

    // Exposed-param overrides: componentToNodeSpec exposes them as flat
    // `params.<nodeId>.<configKey>` config keys on this node; also accept a
    // nested `params` object (keyed either the same way or by bare configKey)
    // for callers that build config programmatically (e.g. the verify script).
    const nestedParams = (config.params ?? {}) as Record<string, unknown>
    for (const node of graph.nodes) {
      for (const ep of meta.exposedParams) {
        if (ep.nodeId !== node.id) continue
        const flatKey = `params.${ep.nodeId}.${ep.configKey}`
        const nestedKey = `${ep.nodeId}.${ep.configKey}`
        if (config[flatKey] !== undefined) {
          node.config = { ...node.config, [ep.configKey]: config[flatKey] }
        } else if (nestedParams[nestedKey] !== undefined) {
          node.config = { ...node.config, [ep.configKey]: nestedParams[nestedKey] }
        } else if (nestedParams[ep.configKey] !== undefined) {
          node.config = { ...node.config, [ep.configKey]: nestedParams[ep.configKey] }
        }
      }
    }

    const iface = deriveInterface(flowId, graph, meta)
    if ('error' in iface) throw new Error(iface.error)

    const { runFlow } = await import('./flowExecutor.js')

    const inner = await runFlow(graph, ctx.dryRun, {
      injectOutput: (node) => {
        if (node.type !== 'boundary.input') return null
        const portId = String(node.config.portId ?? '')
        return inputs[portId] ?? null
      },
      qualifyId: (id) => (ctx.nodeId ? `${ctx.nodeId}/${id}` : id),
      hooks: ctx.hooks,
      // This flow's own graph may itself contain flow.subflow nodes
      // referencing further published components — resolve those too so
      // nested composites of composites validate correctly.
      resolveSpec: buildSpecResolver(flowId, getFlow),
    })

    ctx.mergeNestedReports?.(inner.nodes)

    if (!inner.ok) {
      const failedEntry = Object.entries(inner.nodes).find(([, r]) => r.status === 'error')
      throw new Error(failedEntry?.[1].error ?? inner.error ?? 'Sub-flow failed')
    }

    const outputs: Record<string, FlowItem[]> = {}
    for (const node of graph.nodes) {
      if (node.type !== 'boundary.output') continue
      const portId = String(node.config.portId ?? '')
      const nodeInputs = inner.finalInputs?.get(node.id)
      outputs[portId] = nodeInputs?.items ?? []
    }

    ctx.notes.push(`sub-flow ${flowId}: ${inner.durationMs}ms`)
    return outputs
  },
}

// --- Triggers: a named event bus for starting flows ------------------------

const triggerStart: NodeImpl = {
  spec: {
    type: 'trigger.start',
    label: 'Trigger',
    category: 'trigger',
    description:
      'The named entry point of a flow — "this is where the flow starts". When its name is fired (by a schedule or a "Fire trigger" node in another flow) the flow starts here, emitting the trigger payload plus triggered_at. A manual run fires every trigger.',
    inputs: [],
    outputs: [{ id: 'out', label: 'start' }],
    config: [
      {
        key: 'name',
        label: 'Trigger name',
        kind: 'text',
        default: 'start',
        help: 'Schedules and "Fire trigger" nodes address this name.',
      },
      { key: 'description', label: 'Note', kind: 'text', default: '' },
    ],
  },
  async run(_inputs, config, ctx) {
    const name = str(config, 'name', 'start')
    // A manual whole-flow run (no event) fires every trigger; a fire only its
    // match — kind 'start' with the same name.
    if (ctx.trigger != null && !(ctx.trigger.kind === 'start' && ctx.trigger.name === name)) {
      ctx.notes.push(`idle — waiting on "${name}"`)
      return { out: [] }
    }
    const triggered_at = new Date().toISOString()
    const payload = ctx.trigger?.items ?? []
    const items: FlowItem[] = payload.length
      ? payload.map((it) => ({ ...it, triggered_at, trigger: name }))
      : [{ triggered_at, trigger: name }]
    ctx.notes.push(ctx.trigger == null ? `manual start (${items.length})` : `fired "${name}" (${items.length})`)
    return { out: items }
  },
}

// Whether this run's event targets a given event-trigger kind: a matching fire,
// or a manual whole-flow run (null event fires every trigger).
const triggerMatches = (ctx: RunContext, kind: TriggerKind): boolean =>
  ctx.trigger == null || ctx.trigger.kind === kind

const triggerNewItem: NodeImpl = {
  spec: {
    type: 'trigger.new-item',
    label: 'New catalog item',
    category: 'trigger',
    description:
      'Fires when a new title is added to the catalog (the /manage Catalog tab), emitting the new series. Runs automatically on a schedule tick; a manual run emits the most-recently-added title as a sample.',
    inputs: [],
    outputs: [{ id: 'out', label: 'item', dataType: 'catalog' }],
    config: [],
  },
  async run(_inputs, config, ctx) {
    if (!triggerMatches(ctx, 'new-item')) {
      ctx.notes.push('idle — waiting on a new catalog item')
      return { out: [] }
    }
    const triggered_at = new Date().toISOString()
    // The watcher passes the new series; a manual run samples the latest one.
    let source: FlowItem[] = ctx.trigger?.items ?? []
    if (ctx.trigger == null || ctx.trigger.manual) {
      const series = listSeries().sort((a, b) =>
        String(b.added_at ?? '').localeCompare(String(a.added_at ?? '')),
      )
      source = series.slice(0, 1) as unknown as FlowItem[]
      ctx.notes.push(source.length ? 'manual sample: latest catalog title' : 'no catalog titles to sample')
    }
    const items = source.map((it) => ({ ...it, triggered_at, trigger: 'new-item' }))
    ctx.notes.push(`${items.length} new item(s)`)
    return { out: items }
  },
}

const triggerNewPortalItem: NodeImpl = {
  spec: {
    type: 'trigger.new-portal',
    label: 'New portal item',
    category: 'trigger',
    description:
      'Fires when a new title (series or movie) appears in the public portal — the Jellyfin collection live on the site — emitting the new item(s). Runs automatically on a schedule tick; a manual run emits the most-recently-added portal title as a sample.',
    inputs: [],
    outputs: [{ id: 'out', label: 'item', dataType: 'catalog' }],
    config: [],
  },
  async run(_inputs, _config, ctx) {
    if (!triggerMatches(ctx, 'new-portal')) {
      ctx.notes.push('idle — waiting on a new portal item')
      return { out: [] }
    }
    const triggered_at = new Date().toISOString()
    let source: FlowItem[] = ctx.trigger?.items ?? []
    if (ctx.trigger == null || ctx.trigger.manual) {
      const titles = getAllPortalItems()
        .filter((p) => p.type === 'Series' || p.type === 'Movie')
        .sort((a, b) => String(b.date_created ?? '').localeCompare(String(a.date_created ?? '')))
      source = titles.slice(0, 1) as unknown as FlowItem[]
      ctx.notes.push(source.length ? 'manual sample: latest portal title' : 'no portal titles to sample')
    }
    const items = source.map((it) => ({ ...it, triggered_at, trigger: 'new-portal' }))
    ctx.notes.push(`${items.length} new item(s)`)
    return { out: items }
  },
}

const triggerQbitComplete: NodeImpl = {
  spec: {
    type: 'trigger.qbit-complete',
    label: 'Download complete',
    category: 'trigger',
    description:
      'Fires when a qBittorrent download finishes, emitting the completed torrent (hash, name, content_path) — wire it to expand-files to import promptly. Runs automatically on a schedule tick; a manual run samples the most-recently-completed torrent.',
    inputs: [],
    outputs: [{ id: 'out', label: 'torrent', dataType: 'torrent' }],
    config: [],
  },
  async run(_inputs, _config, ctx) {
    if (!triggerMatches(ctx, 'qbit-complete')) {
      ctx.notes.push('idle — waiting on a completed download')
      return { out: [] }
    }
    const triggered_at = new Date().toISOString()
    let source: FlowItem[] = ctx.trigger?.items ?? []
    if (ctx.trigger == null || ctx.trigger.manual) {
      if (!qbitConfigured()) {
        ctx.notes.push('qBittorrent not configured — nothing to sample')
        return { out: [] }
      }
      const done = (await qbitList()).filter((t) => t.progress >= 1).sort((a, b) => b.added_on - a.added_on)
      source = done.slice(0, 1).map(qbitToItem) as unknown as FlowItem[]
      ctx.notes.push(source.length ? 'manual sample: latest completed download' : 'no completed downloads to sample')
    }
    const items = source.map((it) => ({ ...it, triggered_at, trigger: 'qbit-complete' }))
    ctx.notes.push(`${items.length} completed download(s)`)
    return { out: items }
  },
}

const triggerRelease: NodeImpl = {
  spec: {
    type: 'trigger.release',
    label: 'Release due',
    category: 'trigger',
    description:
      'Fires when a library show’s scheduled episode air time passes, emitting the aired episode (title, ep, air time). Runs automatically on a schedule tick; a manual run emits the next upcoming library airing as a sample.',
    inputs: [],
    outputs: [{ id: 'out', label: 'airing' }],
    config: [],
  },
  async run(_inputs, config, ctx) {
    if (!triggerMatches(ctx, 'release')) {
      ctx.notes.push('idle — waiting on a release')
      return { out: [] }
    }
    const triggered_at = new Date().toISOString()
    let source: FlowItem[] = ctx.trigger?.items ?? []
    if (ctx.trigger == null || ctx.trigger.manual) {
      // Sample: the soonest upcoming airing, else the most recent aired one.
      const airings = await libraryAirings()
      const upcoming = airings.find((a) => !a.aired) ?? [...airings].reverse().find((a) => a.aired)
      source = upcoming ? [upcoming.item as unknown as FlowItem] : []
      ctx.notes.push(source.length ? 'manual sample: next airing' : 'no airings to sample')
    }
    const items = source.map((it) => ({ ...it, triggered_at, trigger: 'release' }))
    ctx.notes.push(`${items.length} release(s)`)
    return { out: items }
  },
}

const triggerFire: NodeImpl = {
  spec: {
    type: 'trigger.fire',
    label: 'Fire trigger',
    category: 'trigger',
    description:
      'Publishes to a trigger name: every flow with a "Trigger" of that name runs, receiving these items as its payload. The fire is deferred until this flow finishes, so use it to chain flows. Items pass straight through.',
    inputs: [{ id: 'in', label: 'in' }],
    outputs: [{ id: 'out', label: 'fired' }],
    config: [
      {
        key: 'name',
        label: 'Trigger name',
        kind: 'text',
        default: '',
        help: 'The Trigger name to fire in other flows.',
      },
    ],
  },
  async run(inputs, config, ctx) {
    const name = str(config, 'name', '')
    const items = allInputs(inputs)
    if (!name) {
      ctx.notes.push('no trigger name set — nothing fired')
      return { out: items }
    }
    if (ctx.dryRun) {
      ctx.notes.push(`would fire "${name}" with ${items.length} item(s)`)
    } else if (ctx.fireQueue) {
      ctx.fireQueue.push({ name, items })
      ctx.notes.push(`queued fire "${name}" with ${items.length} item(s)`)
    } else {
      ctx.notes.push(`fire "${name}" skipped (no dispatcher in this context)`)
    }
    return { out: items }
  },
}

const IMPLS: NodeImpl[] = [
  triggerStart,
  triggerNewItem,
  triggerNewPortalItem,
  triggerQbitComplete,
  triggerRelease,
  triggerFire,
  jellyfinSource,
  indexerSource,
  portalSource,
  httpSource,
  httpEnrich,
  qbittorrentSource,
  fieldFilter,
  compare,
  switchNode,
  chance,
  sortNode,
  compute,
  groupPick,
  join,
  expandFiles,
  parseSeasonNode,
  mediaProbe,
  extractSubs,
  fetchSubs,
  muxTracks,
  trimAudioTracks,
  metadataEnrich,
  dedupe,
  limit,
  indexerMatch,
  jikanEnrich,
  template,
  setJson,
  setField,
  convert,
  pick,
  fromValue,
  collect,
  textValue,
  numberValue,
  randomNumber,
  colorValue,
  urlValue,
  jsonValue,
  animeStatus,
  episodesNode,
  episodeTitlesNode,
  wantsSource,
  wantUpsert,
  wantUpdate,
  torrentSearch,
  diff,
  merge,
  reroute,
  delay,
  portalSink,
  httpSink,
  logSink,
  qbittorrentSink,
  qbittorrentDelete,
  libraryImport,
  jellyfinScan,
  jellyfinCollection,
  subflow,
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
        {
          key: 'dataType',
          label: 'Type',
          kind: 'select',
          options: DATA_TYPE_OPTIONS,
          default: 'items',
          help: 'What this port carries. Value types (text, color, …) make the component input a typed socket.',
        },
        {
          key: 'testItems',
          label: 'Test items',
          kind: 'json',
          default: '',
          help: 'JSON array of items this input emits when the flow runs on its own (Dry run and Apply). For a value-typed port use {"value": …} wrappers, e.g. [{"value": "#7c5cff"}]. Ignored when the flow runs as a component inside another flow — the parent’s items are used instead.',
        },
      ],
    },
    resolvePorts: (config) => ({
      inputs: [],
      outputs: [{ id: 'items', label: 'items', dataType: configDataType(config) }],
    }),
    // Only reached on standalone runs — when the flow is embedded as a
    // component, the executor injects the parent's per-port items and skips
    // run() entirely (see injectOutput in flowExecutor).
    run: async (inputs, config, ctx) => {
      const raw = str(config, 'testItems', '')
      if (!raw) return { items: inputs.items ?? [] }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('Test items must be a JSON array, e.g. [{"title": "Frieren"}]')
      }
      const items = Array.isArray(parsed) ? parsed : [parsed]
      if (!items.every((v): v is FlowItem => typeof v === 'object' && v !== null && !Array.isArray(v))) {
        throw new Error('Test items must be a JSON array of objects')
      }
      ctx.notes.push(`emitting ${items.length} test item(s) — standalone run`)
      return { items }
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
        {
          key: 'dataType',
          label: 'Type',
          kind: 'select',
          options: DATA_TYPE_OPTIONS,
          default: 'items',
          help: 'What this port carries — a value type makes the component output a typed socket.',
        },
      ],
    },
    resolvePorts: (config) => ({
      inputs: [{ id: 'items', label: 'items', dataType: configDataType(config) }],
      outputs: [],
    }),
    run: async () => {
      return {}
    },
  },
]

export const NODE_REGISTRY: Map<string, NodeImpl> = new Map(IMPLS.map((n) => [n.spec.type, n]))

export const NODE_SPECS: NodeSpec[] = IMPLS.map((n) => n.spec)
