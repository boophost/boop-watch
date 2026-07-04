// AniSkip fallback for intro/outro skip segments: community-sourced timestamps
// keyed by MyAnimeList id + episode number (api.aniskip.com). Jellyfin items
// carry no MAL ids (only IMDb/TVDB/TMDb), so we resolve the series name via
// Jikan search, then walk the MAL *sequel chain* to find the entry whose aired
// date range contains the episode's air date, and match the episode number
// against that entry's per-episode air dates. Air dates are the anchor because
// the two obvious alternatives both break: MAL splits seasons into separate
// entries ("2nd Season", "... Part 2"), so season/episode arithmetic needs
// title parsing; and counting files on disk shifts everything after a gap in
// the library (a missing cour made season-3 episodes resolve to season-2 ids).
import type { Segment } from './watch.js'

const JIKAN = 'https://api.jikan.moe/v4'
const ANISKIP = 'https://api.aniskip.com/v2'
const CHAIN_TTL = 24 * 60 * 60 * 1000
const SKIP_TTL = 24 * 60 * 60 * 1000
const NEG_TTL = 60 * 60 * 1000             // empty answers may be an upstream blip — retry hourly
const EPS_TTL_AIRING = 6 * 60 * 60 * 1000  // airing entries grow a row per week
const EPS_TTL_DONE = 7 * 24 * 60 * 60 * 1000
const MAX_CHAIN = 12          // sequel-chain hops, total (guards a runaway walk)
const MAX_EP_PAGES = 4        // Jikan pages of 100 eps — plenty for one MAL entry
const JIKAN_GAP_MS = 350      // Jikan allows ~3 req/s; space chain-walk requests
const DAY = 24 * 60 * 60 * 1000
const DATE_SLACK = 3 * DAY    // TVDB vs MAL air dates disagree by up to a day or two

// A MAL entry in the sequel chain, with its aired range (ms epoch; `to` is null
// while the entry is still airing → open-ended).
interface ChainEntry { malId: number; from: number | null; to: number | null; airing: boolean }
// The walked prefix of a series' sequel chain. `frontier` holds the next MAL
// ids to visit so a later episode can resume the walk where it stopped.
interface Chain { entries: ChainEntry[]; frontier: number[]; hops: number }

const chainCache = new Map<string, { at: number; chain: Chain | null }>()
const epsCache = new Map<number, { at: number; ttl: number; rows: EpRow[] }>()
const skipCache = new Map<string, { at: number; segs: Segment[] }>()
// Serialise walks per series so concurrent /api/watch calls don't double-fetch.
const walkLocks = new Map<string, Promise<void>>()

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const parseMs = (s?: string | null): number | null => {
  const t = Date.parse(s || '')
  return Number.isFinite(t) ? t : null
}

async function jikanJson<T>(path: string): Promise<T> {
  const res = await fetch(`${JIKAN}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`jikan ${res.status}`)
  return res.json() as Promise<T>
}

interface JikanSearchHit { mal_id: number; title?: string; title_english?: string | null; type?: string }
interface JikanFull {
  mal_id: number
  type?: string
  status?: string
  aired?: { from?: string | null; to?: string | null }
  relations?: Array<{ relation: string; entry: Array<{ mal_id: number; type: string }> }>
}

// The series' MAL root: best title match among the top search results.
async function searchRoot(seriesName: string): Promise<number | null> {
  const q = norm(seriesName)
  const { data } = await jikanJson<{ data?: JikanSearchHit[] }>(
    `/anime?q=${encodeURIComponent(seriesName)}&limit=10&order_by=popularity`,
  )
  const hits = (data || []).filter((a) => {
    const t = norm(a.title || '')
    const e = norm(a.title_english || '')
    return t === q || e === q || (q.length > 6 && (t.includes(q) || e.includes(q) || q.includes(t) || q.includes(e)))
  })
  // Prefer series-shaped entries over movies/specials that share the title.
  const best = hits.find((a) => a.type === 'TV' || a.type === 'ONA') || hits[0]
  return best ? best.mal_id : null
}

const sequelIds = (full: JikanFull): number[] =>
  (full.relations || [])
    .filter((r) => r.relation === 'Sequel')
    .flatMap((r) => r.entry.filter((e) => e.type === 'anime').map((e) => e.mal_id))

const containsDate = (e: ChainEntry, dateMs: number, slack: number): boolean =>
  e.from != null && dateMs >= e.from - slack && (e.to == null ? true : dateMs <= e.to + slack)

// The chain entry airing on `dateMs`; exact ranges win over slack-padded ones
// (consecutive cours sit close together, and slack must not bridge them).
const entryFor = (chain: Chain, dateMs: number): ChainEntry | null =>
  chain.entries.find((e) => containsDate(e, dateMs, 0))
  || chain.entries.find((e) => containsDate(e, dateMs, DATE_SLACK))
  || null

// Walk the sequel chain until an entry's aired range covers `dateMs` (or it
// runs out). TV/ONA entries are candidates; movies/OVAs/specials in the chain
// are passed through without becoming candidates — Jellyfin's episode list
// doesn't contain them either.
async function extendChain(chain: Chain, dateMs: number): Promise<void> {
  while (!entryFor(chain, dateMs) && chain.frontier.length && chain.hops < MAX_CHAIN) {
    const id = chain.frontier[0]
    await sleep(JIKAN_GAP_MS)
    let data: JikanFull | undefined
    try {
      data = (await jikanJson<{ data?: JikanFull }>(`/anime/${id}/full`)).data
    } catch (e) {
      // Transient failure (429/timeout): leave the id at the frontier head so
      // the next request resumes this link — shifting before a failed fetch
      // would silently sever the chain for the whole cache lifetime. A hard
      // 404 (dead id) is the one case to drop, or it would block forever.
      if (!/jikan 404/.test(String(e))) throw e
    }
    chain.frontier.shift()
    chain.hops++
    if (!data) continue
    if (data.type === 'TV' || data.type === 'ONA') {
      chain.entries.push({
        malId: data.mal_id,
        from: parseMs(data.aired?.from),
        to: parseMs(data.aired?.to),
        airing: data.status === 'Currently Airing',
      })
    }
    chain.frontier.push(...sequelIds(data))
  }
}

async function resolveEntry(seriesName: string, dateMs: number): Promise<ChainEntry | null> {
  const key = norm(seriesName)
  // One walk at a time per series; later callers reuse (and may extend) the result.
  while (walkLocks.has(key)) await walkLocks.get(key)
  let release!: () => void
  walkLocks.set(key, new Promise<void>((r) => { release = r }))
  try {
    let cached = chainCache.get(key)
    // Negative entries (no MAL match — possibly a search blip) expire sooner.
    if (cached && Date.now() - cached.at > (cached.chain === null ? NEG_TTL : CHAIN_TTL)) cached = undefined
    if (cached && cached.chain === null) return null
    let chain = cached?.chain
    if (!chain) {
      const root = await searchRoot(seriesName)
      if (root == null) {
        chainCache.set(key, { at: Date.now(), chain: null })
        return null
      }
      chain = { entries: [], frontier: [root], hops: 0 }
      chainCache.set(key, { at: Date.now(), chain })
    }
    await extendChain(chain, dateMs)
    return entryFor(chain, dateMs)
  } finally {
    walkLocks.delete(key)
    release()
  }
}

// One row of a MAL entry's episode list; mal_id is the episode number.
interface EpRow { num: number; aired: number }

async function episodeRows(entry: ChainEntry): Promise<EpRow[]> {
  const cached = epsCache.get(entry.malId)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.rows
  const rows: EpRow[] = []
  for (let page = 1; page <= MAX_EP_PAGES; page++) {
    if (page > 1) await sleep(JIKAN_GAP_MS)
    const json = await jikanJson<{
      data?: Array<{ mal_id: number; aired?: string | null }>
      pagination?: { has_next_page?: boolean }
    }>(`/anime/${entry.malId}/episodes?page=${page}`)
    for (const r of json.data || []) {
      const aired = parseMs(r.aired)
      if (aired != null) rows.push({ num: r.mal_id, aired })
    }
    if (!json.pagination?.has_next_page) break
  }
  // An empty list is more likely an upstream hiccup than a truly episode-less
  // entry — don't let it stick for days.
  epsCache.set(entry.malId, {
    at: Date.now(), ttl: !rows.length ? NEG_TTL : entry.airing ? EPS_TTL_AIRING : EPS_TTL_DONE, rows,
  })
  return rows
}

// The entry's episode number airing on `dateMs`: the closest listed air date
// within slack. MAL's list lags a freshly aired episode by a bit, so just past
// the end of the list we extrapolate on the weekly cadence (bounded — a long
// gap more likely means a hiatus than twenty unlisted episodes).
async function epNumByDate(entry: ChainEntry, dateMs: number): Promise<number | null> {
  const rows = await episodeRows(entry)
  let best: EpRow | null = null
  for (const r of rows) {
    if (Math.abs(r.aired - dateMs) <= DATE_SLACK && (!best || Math.abs(r.aired - dateMs) < Math.abs(best.aired - dateMs))) best = r
  }
  if (best) return best.num
  const WEEK = 7 * DAY
  const last = rows[rows.length - 1]
  const anchor = last || (entry.from != null ? { num: 0, aired: entry.from - WEEK } : null)
  if (anchor && dateMs > anchor.aired) {
    const weeks = Math.round((dateMs - anchor.aired) / WEEK)
    if (weeks >= 1 && weeks <= 3) return anchor.num + weeks
  }
  return null
}

interface AniskipResult { skipType: string; interval: { startTime: number; endTime: number } }

async function fetchSkipTimes(malId: number, ep: number, epLenSec: number): Promise<Segment[]> {
  const key = `${malId}:${ep}:${epLenSec}`
  const cached = skipCache.get(key)
  // Empty answers retry sooner: submissions for a fresh episode arrive over
  // hours-to-days, and a transient 404 must not stick.
  if (cached && Date.now() - cached.at < (cached.segs.length ? SKIP_TTL : NEG_TTL)) return cached.segs
  const res = await fetch(
    `${ANISKIP}/skip-times/${malId}/${ep}?types[]=op&types[]=ed&episodeLength=${epLenSec}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
  )
  // 404 = no community submissions for this episode.
  if (res.status === 404) {
    skipCache.set(key, { at: Date.now(), segs: [] })
    return []
  }
  if (!res.ok) throw new Error(`aniskip ${res.status}`)
  const json = await res.json() as { found?: boolean; results?: AniskipResult[] }
  const segs: Segment[] = (json.found ? (json.results || []) : []).flatMap((r) => {
    const type = r.skipType === 'op' ? 'intro' : r.skipType === 'ed' ? 'outro' : null
    if (!type || !(r.interval.endTime > r.interval.startTime)) return []
    return [{ type: type as Segment['type'], start: r.interval.startTime, end: r.interval.endTime }]
  })
  skipCache.set(key, { at: Date.now(), segs })
  return segs
}

/**
 * Intro/outro segments for one episode, or [] when unresolvable.
 * @param seriesName   Jellyfin series display name (matched against MAL titles)
 * @param premiereDate the episode's air date (Jellyfin PremiereDate) — the
 *                     anchor for both MAL-entry and episode-number resolution
 * @param epLenSec     episode runtime in seconds. AniSkip uses it to pick the
 *                     submission for the right *cut* of the episode — unfiltered
 *                     (length 0) queries return other cuts with offset times, so
 *                     an unknown runtime means no lookup (wrong skips are worse
 *                     than no skip button).
 */
export async function aniskipSegments(seriesName: string, premiereDate: string | undefined, epLenSec: number): Promise<Segment[]> {
  const dateMs = parseMs(premiereDate)
  if (dateMs == null || epLenSec <= 0) return []
  const entry = await resolveEntry(seriesName, dateMs)
  if (!entry) return []
  const ep = await epNumByDate(entry, dateMs)
  if (ep == null || ep < 1) return []
  return fetchSkipTimes(entry.malId, ep, Math.round(epLenSec))
}
