import { limitedFetch } from './httpQueue.js'
import { cfgSafe } from './config.js'

// Base URL of the Jikan (MyAnimeList proxy) API. Defaults to the public
// instance, but in production we point it at our own self-hosted jikan-rest
// (JIKAN_URL) — the public api.jikan.moe is chronically overloaded and 504s,
// which used to surface as a hard 502 on the episodes API. See k8s/jikan/.
const jikanBase = (): string => cfgSafe('JIKAN_URL')

// The self-hosted instance deliberately runs without Typesense, so the indexed
// `/anime?q=` search 500s there — id-based routes only. Searches go to their
// own base (JIKAN_SEARCH_URL), which stays the public API unless overridden.
// Search falls back to the id-base when unset: a self-hosted Jikan without a
// Typesense index 500s on /anime?q=, so the two can legitimately differ.
export const jikanSearchBase = (): string =>
  cfgSafe('JIKAN_SEARCH_URL') || cfgSafe('JIKAN_URL')

// Jikan allows ~3 req/s; the shared 'jikan' queue serializes every caller
// (search + detail + episodes on one page load, plus aniskip's chain-walk) so
// they don't burst and trip 429s — Cloudflare fronts us and turns a 429 into a
// plain-text 502 the SPA can't JSON.parse. See server/httpQueue.ts.
const jikanGet = (url: string | URL): Promise<Response> =>
  limitedFetch('jikan', url, { headers: { Accept: 'application/json' } })

export interface JikanAnimeBrief {
  mal_id: number
  title: string
  synopsis: string
  images: {
    jpg: { image_url: string | null; small_image_url: string | null }
    webp: { image_url: string | null; small_image_url: string | null }
  }
  url: string
}

interface JikanAnimeSearchResponse {
  data?: JikanAnimeBrief[]
}

/** Jikan sometimes returns the same `mal_id` multiple times for one query; keep first (popularity) order. */
function dedupeByMalId<T extends { mal_id: number }>(items: T[]): T[] {
  const seen = new Set<number>()
  return items.filter((item) => {
    if (seen.has(item.mal_id)) return false
    seen.add(item.mal_id)
    return true
  })
}

export function pickPosterUrl(a: JikanAnimeBrief): string | null {
  const w = a.images.webp.image_url || a.images.webp.small_image_url
  const j = a.images.jpg.image_url || a.images.jpg.small_image_url
  const u = w || j
  return u && u.length > 0 ? u : null
}

export async function searchAnime(
  query: string,
  limit = 15,
): Promise<JikanAnimeBrief[]> {
  const q = query.trim()
  if (!q) return []

  const u = new URL(`${jikanSearchBase()}/anime`)
  u.searchParams.set('q', q)
  u.searchParams.set('limit', String(limit))
  u.searchParams.set('order_by', 'popularity')

  const res = await jikanGet(u)

  if (res.status === 429) {
    throw new Error('Rate limited — try again in a moment')
  }
  if (!res.ok) {
    throw new Error(`Jikan returned ${res.status}`)
  }

  const json = (await res.json()) as JikanAnimeSearchResponse
  return dedupeByMalId(json.data ?? [])
}

/** Full anime payload from GET /anime/{id}/full — we only type fields the UI needs. */
export type JikanAnimeFull = {
  mal_id: number
  url: string
  title: string
  title_english?: string | null
  title_japanese?: string | null
  type?: string
  source?: string
  episodes?: number | null
  status?: string
  duration?: string
  rating?: string
  score?: number | null
  synopsis?: string | null
  background?: string | null
  aired?: { string?: string | null }
  season?: string | null
  year?: number | null
  broadcast?: {
    day?: string | null
    time?: string | null
    timezone?: string | null
    string?: string | null
  } | null
  images: JikanAnimeBrief['images']
  studios?: { name: string }[]
  genres?: { name: string }[]
}

export interface JikanEpisodeRow {
  mal_id: number
  url: string
  title: string
  title_japanese?: string | null
  aired?: string | null
  filler: boolean
  recap: boolean
}

export interface JikanEpisodesPagination {
  last_visible_page: number
  has_next_page: boolean
  current_page?: number
}

function jikanFetchError(res: Response): Error {
  if (res.status === 429) {
    return new Error('Rate limited — try again in a moment')
  }
  return new Error(`Jikan returned ${res.status}`)
}

export async function fetchAnimeFull(malId: number): Promise<JikanAnimeFull> {
  const res = await jikanGet(`${jikanBase()}/anime/${malId}/full`)
  if (!res.ok) throw jikanFetchError(res)
  const json = (await res.json()) as { data?: JikanAnimeFull }
  if (!json.data) throw new Error('No anime data from Jikan')
  return json.data
}

export async function fetchAnimeEpisodesPage(
  malId: number,
  page = 1,
): Promise<{ episodes: JikanEpisodeRow[]; pagination: JikanEpisodesPagination }> {
  const u = new URL(`${jikanBase()}/anime/${malId}/episodes`)
  u.searchParams.set('page', String(page))
  const res = await jikanGet(u)
  if (!res.ok) throw jikanFetchError(res)
  const json = (await res.json()) as {
    data?: JikanEpisodeRow[]
    pagination?: JikanEpisodesPagination
  }
  const pagination = json.pagination ?? {
    last_visible_page: 1,
    has_next_page: false,
  }
  if (pagination.current_page == null) {
    pagination.current_page = page
  }
  return {
    episodes: json.data ?? [],
    pagination,
  }
}

/** MAL episode URLs end with `/episode/{n}`. */
export function episodeNumberFromUrl(url: string): number | null {
  const m = /\/episode\/(\d+)\/?(?:$|[?#])/i.exec(url)
  return m ? Number(m[1]) : null
}
