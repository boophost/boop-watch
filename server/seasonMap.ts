// Multi-season placement mapping.
//
// A single Jellyfin/TVDB show is usually several MyAnimeList entries — one per
// broadcast cour (Mushoku Tensei: S1 cour1 = mal 39535, S1 cour2 = 42260,
// S2 = 45576, S2 part2 = 55888, S3 = 59193, …). To place a cour's downloads
// under the right Jellyfin `Season NN` folder with the right episode numbers we
// need, per mal_id: the TVDB series id (to group the cours as one show), the
// TVDB season number, and an episode offset (a cour that continues a season
// starts partway through it, e.g. S1 cour2 → offset 11).
//
// Two public datasets give this, and we deliberately use BOTH because neither is
// reliable alone:
//   • Fribb/anime-lists (JSON): maps mal_id → anidb_id (+ a tvdb_id and a
//     season.tvdb hint). The id cross-reference is good; its season hint is
//     sometimes wrong for split cours (it mis-tags Mushoku S2 as season 1).
//   • Anime-Lists/anime-lists "anime-list-master.xml" (ScudLee — what Sonarr
//     uses): keyed by anidb_id, carries the authoritative `defaulttvdbseason`
//     and `episodeoffset`.
// So: mal_id --Fribb--> anidb_id --ScudLee--> {season, offset}, preferring
// ScudLee's season/offset over Fribb's hint. When the data is still wrong (rare,
// but Mushoku is exactly such a case), an admin sets a manual override on the
// catalog row and this auto path leaves it alone.

import fs from 'fs'
import path from 'path'
import { findByMalId, setSeasonMapping } from './db.js'

const FRIBB_URL =
  process.env.SEASONMAP_FRIBB_URL ??
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
const SCUDLEE_URL =
  process.env.SEASONMAP_SCUDLEE_URL ??
  'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml'

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const cacheDir = path.join(dataDir, 'season-map')
const FRIBB_CACHE = path.join(cacheDir, 'anime-list-full.json')
const SCUDLEE_CACHE = path.join(cacheDir, 'anime-list-master.xml')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // refresh weekly
const FETCH_TIMEOUT_MS = 90_000

export interface SeasonMapping {
  tvdbId: number | null
  tvdbSeason: number | null
  episodeOffset: number
  /** anidb id we resolved through, for debugging/notes. */
  anidbId: number | null
}

// anidb_id -> {tvdbId, season, offset} from the ScudLee XML.
type ScudEntry = { tvdbId: number | null; season: number | null; offset: number }
// mal_id -> {anidbId, tvdbId, seasonHint} from Fribb.
type FribbEntry = { anidbId: number | null; tvdbId: number | null; seasonHint: number | null }

let scudById: Map<number, ScudEntry> | null = null
let fribbByMal: Map<number, FribbEntry> | null = null
let loading: Promise<void> | null = null

/** Fetch `url` to `cache`, falling back to a stale cache on any network error. */
async function fetchToCache(url: string, cache: string): Promise<string> {
  let fresh = false
  try {
    fresh = fs.statSync(cache).mtimeMs > Date.now() - MAX_AGE_MS
  } catch {
    /* no cache yet */
  }
  if (fresh) return fs.readFileSync(cache, 'utf8')
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.text()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cache, body)
    return body
  } catch (e) {
    // Network failed — use whatever we cached before, even if stale.
    if (fs.existsSync(cache)) {
      console.error(`seasonMap: refresh of ${url} failed (${e instanceof Error ? e.message : e}); using stale cache`)
      return fs.readFileSync(cache, 'utf8')
    }
    throw e
  }
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : null
}
function intOrNull(v: string | null): number | null {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function parseScudLee(xml: string): Map<number, ScudEntry> {
  const map = new Map<number, ScudEntry>()
  // Only need the opening <anime ...> tag of each entry.
  for (const m of xml.matchAll(/<anime\b[^>]*>/g)) {
    const tag = m[0]
    const anidb = intOrNull(attr(tag, 'anidbid'))
    if (anidb == null) continue
    map.set(anidb, {
      tvdbId: intOrNull(attr(tag, 'tvdbid')),
      // defaulttvdbseason can be "a" (absolute ordering) — not a real season.
      season: intOrNull(attr(tag, 'defaulttvdbseason')),
      offset: intOrNull(attr(tag, 'episodeoffset')) ?? 0,
    })
  }
  return map
}

function fribbSeasonHint(season: unknown): number | null {
  // Fribb's season is either a number or an object like {tvdb: 2, tmdb: 2}.
  if (typeof season === 'number') return Math.trunc(season)
  if (season && typeof season === 'object' && 'tvdb' in season) {
    const v = (season as { tvdb: unknown }).tvdb
    return typeof v === 'number' ? Math.trunc(v) : null
  }
  return null
}

function parseFribb(json: string): Map<number, FribbEntry> {
  const map = new Map<number, FribbEntry>()
  const arr = JSON.parse(json) as Array<Record<string, unknown>>
  for (const e of arr) {
    const malRaw = e.mal_id
    const mals = Array.isArray(malRaw) ? malRaw : [malRaw]
    const entry: FribbEntry = {
      anidbId: intOrNull(String(e.anidb_id ?? '')),
      tvdbId: intOrNull(String(e.tvdb_id ?? e.thetvdb_id ?? '')),
      seasonHint: fribbSeasonHint(e.season),
    }
    for (const m of mals) {
      const mid = intOrNull(String(m ?? ''))
      if (mid != null && !map.has(mid)) map.set(mid, entry)
    }
  }
  return map
}

async function ensureLoaded(): Promise<void> {
  if (scudById && fribbByMal) return
  if (!loading) {
    loading = (async () => {
      const [scud, fribb] = await Promise.all([
        fetchToCache(SCUDLEE_URL, SCUDLEE_CACHE),
        fetchToCache(FRIBB_URL, FRIBB_CACHE),
      ])
      scudById = parseScudLee(scud)
      fribbByMal = parseFribb(fribb)
    })().catch((e) => {
      loading = null // allow a retry on the next call
      throw e
    })
  }
  await loading
}

/**
 * Resolve the TVDB season + episode offset for a mal_id from the datasets.
 * Returns null if the id isn't in the cross-reference at all. `tvdbSeason` may
 * be null even when we have a tvdbId (e.g. an absolute-ordered show).
 */
export async function resolveSeasonMapping(mal_id: number): Promise<SeasonMapping | null> {
  await ensureLoaded()
  const fribb = fribbByMal!.get(mal_id)
  if (!fribb) return null
  const scud = fribb.anidbId != null ? scudById!.get(fribb.anidbId) : undefined
  const tvdbId = scud?.tvdbId ?? fribb.tvdbId ?? null
  // ScudLee's per-cour season/offset is authoritative; Fribb's hint is the
  // fallback and carries no offset.
  const tvdbSeason = scud?.season ?? fribb.seasonHint ?? null
  const episodeOffset = scud?.offset ?? 0
  return { tvdbId, tvdbSeason, episodeOffset, anidbId: fribb.anidbId }
}

/**
 * Resolve and persist the mapping onto the catalog row, unless the row already
 * carries a manual override. Returns what was applied (or null if unresolved /
 * left as manual). Used by the enrich.metadata flow node.
 */
export async function enrichSeasonMapping(
  mal_id: number,
  opts: { write?: boolean } = {},
): Promise<(SeasonMapping & { applied: boolean; reason?: string }) | null> {
  const write = opts.write ?? true
  const row = findByMalId(mal_id)
  // A manual override always wins — return its stored values and never touch it.
  if (row?.mapping_source === 'manual') {
    return {
      tvdbId: row.tvdb_id,
      tvdbSeason: row.tvdb_season,
      episodeOffset: row.episode_offset ?? 0,
      anidbId: null,
      applied: false,
      reason: 'manual override',
    }
  }
  const m = await resolveSeasonMapping(mal_id)
  if (!m) return null
  if (write) {
    setSeasonMapping(mal_id, {
      tvdb_id: m.tvdbId,
      tvdb_season: m.tvdbSeason,
      episode_offset: m.episodeOffset,
      source: 'auto',
    })
  }
  return { ...m, applied: write }
}
