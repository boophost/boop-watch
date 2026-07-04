// AniSkip fallback for intro/outro skip segments: community-sourced timestamps
// keyed by MyAnimeList id + episode number (api.aniskip.com). Jellyfin items
// carry no MAL ids (only IMDb/TVDB/TMDb), so we resolve the series name via
// Jikan search, then walk the MAL *sequel chain* consuming episode counts to
// map the episode's absolute position onto the right MAL entry — MAL splits
// seasons into separate entries ("2nd Season", "... Part 2"), so title parsing
// is a trap; position arithmetic isn't.
import type { Segment } from './watch.js'

const JIKAN = 'https://api.jikan.moe/v4'
const ANISKIP = 'https://api.aniskip.com/v2'
const CHAIN_TTL = 24 * 60 * 60 * 1000
const SKIP_TTL = 24 * 60 * 60 * 1000
const MAX_CHAIN = 12          // sequel-chain hops, total (guards a runaway walk)
const JIKAN_GAP_MS = 350      // Jikan allows ~3 req/s; space chain-walk requests

// A watched MAL entry in the sequel chain. episodes === null means MAL doesn't
// know the count yet (currently airing) — treated as "the rest fits here".
interface ChainEntry { malId: number; episodes: number | null }
// The walked prefix of a series' sequel chain. `frontier` holds the next MAL
// ids to visit so a later, deeper episode can resume the walk where it stopped.
interface Chain { entries: ChainEntry[]; frontier: number[]; hops: number }

const chainCache = new Map<string, { at: number; chain: Chain | null }>()
const skipCache = new Map<string, { at: number; segs: Segment[] }>()
// Serialise walks per series so concurrent /api/watch calls don't double-fetch.
const walkLocks = new Map<string, Promise<void>>()

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  episodes?: number | null
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

const chainLen = (c: Chain): number =>
  c.entries.reduce<number>((sum, e) => (e.episodes == null ? Infinity : sum + e.episodes), 0)

// Walk the sequel chain until it covers `needEps` episodes (or runs out).
// TV/ONA entries count toward the total; movies/OVAs/specials in the chain are
// passed through without counting — Jellyfin's episode list doesn't contain
// them either, so the absolute positions stay aligned.
async function extendChain(chain: Chain, needEps: number): Promise<void> {
  while (chainLen(chain) < needEps && chain.frontier.length && chain.hops < MAX_CHAIN) {
    const id = chain.frontier.shift()!
    chain.hops++
    await sleep(JIKAN_GAP_MS)
    const { data } = await jikanJson<{ data?: JikanFull }>(`/anime/${id}/full`)
    if (!data) continue
    if (data.type === 'TV' || data.type === 'ONA') {
      chain.entries.push({ malId: data.mal_id, episodes: data.episodes ?? null })
    }
    chain.frontier.push(...sequelIds(data))
  }
}

async function resolveChain(seriesName: string, needEps: number): Promise<Chain | null> {
  const key = norm(seriesName)
  // One walk at a time per series; later callers reuse (and may extend) the result.
  while (walkLocks.has(key)) await walkLocks.get(key)
  let release!: () => void
  walkLocks.set(key, new Promise<void>((r) => { release = r }))
  try {
    let cached = chainCache.get(key)
    if (cached && Date.now() - cached.at > CHAIN_TTL) cached = undefined
    if (cached && cached.chain === null) return null // negative-cached: no MAL match
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
    await extendChain(chain, needEps)
    return chain
  } finally {
    walkLocks.delete(key)
    release()
  }
}

interface AniskipResult { skipType: string; interval: { startTime: number; endTime: number } }

async function fetchSkipTimes(malId: number, ep: number, epLenSec: number): Promise<Segment[]> {
  const key = `${malId}:${ep}:${epLenSec}`
  const cached = skipCache.get(key)
  if (cached && Date.now() - cached.at < SKIP_TTL) return cached.segs
  const res = await fetch(
    `${ANISKIP}/skip-times/${malId}/${ep}?types[]=op&types[]=ed&episodeLength=${epLenSec}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
  )
  // 404 = no community submissions for this episode: a stable, cacheable "none".
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
 * @param seriesName Jellyfin series display name (matched against MAL titles)
 * @param absEp      1-based position in the series' aired order (specials excluded)
 * @param epLenSec   episode runtime in seconds. AniSkip uses it to pick the
 *                   submission for the right *cut* of the episode — unfiltered
 *                   (length 0) queries return other cuts with offset times, so
 *                   an unknown runtime means no lookup (wrong skips are worse
 *                   than no skip button).
 */
export async function aniskipSegments(seriesName: string, absEp: number, epLenSec: number): Promise<Segment[]> {
  if (absEp < 1 || epLenSec <= 0) return []
  const chain = await resolveChain(seriesName, absEp)
  if (!chain) return []
  let ep = absEp
  for (const entry of chain.entries) {
    if (entry.episodes == null || ep <= entry.episodes) return fetchSkipTimes(entry.malId, ep, Math.round(epLenSec))
    ep -= entry.episodes
  }
  return [] // chain exhausted before reaching the episode
}
