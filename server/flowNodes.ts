// Node registry for the /manage flow editor: every node type the executor can
// run, plus the metadata (inputs/outputs/config fields) the client needs to
// render and configure it. Specs are served via GET /api/flows/node-types so
// the editor never hardcodes node knowledge.

import { jfJson, jellyfinConfigured, JfItem } from './jellyfin.js'
import { listSeries } from './db.js'
import { getAllPortalItems, getPortalItem, upsertPortalItem, PortalItem } from './portalDb.js'
import { searchAnime, pickPosterUrl } from './jikan.js'

export type FlowItem = Record<string, unknown>

export interface ConfigField {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'boolean'
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  help?: string
}

export interface NodePort {
  id: string
  label: string
}

export interface NodeSpec {
  type: string
  label: string
  category: 'source' | 'filter' | 'enrich' | 'combine' | 'sink'
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

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const allInputs = (inputs: Record<string, FlowItem[]>): FlowItem[] =>
  Object.values(inputs).flat()

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

const indexerMatch: NodeImpl = {
  spec: {
    type: 'enrich.indexer-match',
    label: 'Match indexer title',
    category: 'enrich',
    description:
      'Finds an indexer series whose title matches the item name and copies a field from it.',
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
    ],
  },
  async run(inputs, config, ctx) {
    const setField = str(config, 'setField', 'image_url')
    const fromField = str(config, 'fromField', 'image_url')
    const catalog = listSeries()
    const matched: FlowItem[] = []
    const unmatched: FlowItem[] = []
    for (const item of allInputs(inputs)) {
      const hit = catalog.find(
        (s) =>
          norm(s.title) === norm(item.name) ||
          (item.original_title != null && norm(s.title) === norm(item.original_title)),
      )
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
      await new Promise((r) => setTimeout(r, 1000)) // Jikan rate limit
    }
    if (maxItems > 0 && items.length > maxItems) {
      ctx.notes.push(`capped at ${maxItems} of ${items.length} items`)
    }
    return { found, missed }
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
  fieldFilter,
  indexerMatch,
  jikanEnrich,
  merge,
  portalSink,
]

export const NODE_REGISTRY: Map<string, NodeImpl> = new Map(IMPLS.map((n) => [n.spec.type, n]))

export const NODE_SPECS: NodeSpec[] = IMPLS.map((n) => n.spec)
