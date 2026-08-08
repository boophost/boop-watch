// TMDB (themoviedb.org) client — the metadata catalog behind the TV and Movies
// sections, the way AniList/Jikan sit behind anime.
//
// One provider covers both sections, and `external_ids` hands back `imdb_id`
// and `tvdb_id` in the same call, so we get all three id namespaces from one
// lookup — and they are the same ids Jellyfin matched the library with, which
// is what lets a catalog row and a library item be recognised as each other.
//
// Rate-limited through the shared 'tmdb' queue like every other outbound API.
// TMDB does not publish a hard rate limit any more (the old 40 req/10s cap was
// retired) but it does still 429; the queue's Retry-After handling covers it.
import { limitedFetch } from './httpQueue.js'
import { cfgSafe } from './config.js'

// Read per call, not once at import: these are editable from /manage/settings,
// and a module-scope constant would pin whatever was set when the pod started.
const tmdbBase = (): string => cfgSafe('TMDB_URL').replace(/\/+$/, '')
const key = (): string => cfgSafe('TMDB_API_KEY')

/** Unset ⇒ every TV/movie metadata route reports itself unavailable, loudly. */
export const tmdbConfigured = (): boolean => key() !== ''

// TMDB serves images off a separate CDN host, sized by path segment. w500 is
// the poster size the /manage grid renders at; original would be ~10x the bytes
// for no visible gain in a 200px card.
const IMAGE_BASE = 'https://image.tmdb.org/t/p'
export const tmdbPoster = (p: string | null | undefined, size = 'w500'): string | null =>
  p ? `${IMAGE_BASE}/${size}${p}` : null
export const tmdbBackdrop = (p: string | null | undefined, size = 'w1280'): string | null =>
  p ? `${IMAGE_BASE}/${size}${p}` : null

/** Which TMDB media endpoint a section maps to. */
export type TmdbKind = 'tv' | 'movie'

function tmdbUrl(path: string, query: Record<string, string | number | undefined> = {}): URL {
  const u = new URL(tmdbBase() + (path.startsWith('/') ? path : '/' + path))
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  }
  // TMDB accepts either a v3 API key as a query param or a v4 read access
  // token as a Bearer header. Accept whichever the operator pasted in rather
  // than making them care which page of the TMDB settings they copied from:
  // v4 tokens are JWTs, v3 keys are 32 hex chars.
  if (!isBearerToken()) u.searchParams.set('api_key', key())
  return u
}

const isBearerToken = (): boolean => {
  const k = key()
  return k.startsWith('ey') && k.split('.').length === 3
}

async function tmdbJson<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!tmdbConfigured()) {
    throw new Error('TMDB is not configured — set TMDB_API_KEY to manage the TV and Movies sections')
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (isBearerToken()) headers.Authorization = `Bearer ${key()}`
  const res = await limitedFetch('tmdb', tmdbUrl(path, query), { headers })
  if (!res.ok) {
    // TMDB puts a human-readable reason in status_message; surfacing it turns
    // "502 from the API" into "invalid API key" in the admin UI.
    let detail = ''
    try {
      const body = (await res.json()) as { status_message?: string }
      if (body?.status_message) detail = ` — ${body.status_message}`
    } catch { /* non-JSON error body */ }
    throw new Error(`TMDB ${path} -> ${res.status}${detail}`)
  }
  return (await res.json()) as T
}

// --- wire shapes (only the fields we read) ----------------------------------

interface TmdbSearchResult {
  id: number
  name?: string // tv
  title?: string // movie
  original_name?: string
  original_title?: string
  overview?: string | null
  poster_path?: string | null
  first_air_date?: string // tv
  release_date?: string // movie
}

interface TmdbExternalIds {
  imdb_id?: string | null
  tvdb_id?: number | null
}

interface TmdbDetail extends TmdbSearchResult {
  backdrop_path?: string | null
  status?: string | null
  vote_average?: number | null
  genres?: { id: number; name: string }[]
  number_of_episodes?: number | null
  episode_run_time?: number[]
  runtime?: number | null
  // tv
  networks?: { name: string }[]
  seasons?: { season_number: number; episode_count: number; name: string; air_date: string | null }[]
  // movie
  production_companies?: { name: string }[]
  imdb_id?: string | null
  external_ids?: TmdbExternalIds
}

// --- normalised shapes ------------------------------------------------------

/** A search hit, shaped to line up with the anime search hits the UI already renders. */
export interface TmdbSearchHit {
  source_id: number
  title: string
  synopsis: string
  image_url: string | null
  url: string
  year: number | null
  /** 'TV' | 'Movie' — MAL-style casing, so one UI renders both providers. */
  type: string
  status: string | null
  episodes: number | null
}

export interface TmdbTitle extends TmdbSearchHit {
  original_title: string | null
  backdrop_url: string | null
  imdb_id: string | null
  tvdb_id: number | null
  score: number | null
  genres: string[]
  studios: string[]
  seasons: { season: number; episodes: number; name: string; year: number | null }[]
}

const yearOf = (date: string | null | undefined): number | null => {
  const y = Number(String(date ?? '').slice(0, 4))
  return Number.isFinite(y) && y > 1800 ? y : null
}

const titleOf = (r: TmdbSearchResult): string =>
  r.name ?? r.title ?? r.original_name ?? r.original_title ?? `TMDB #${r.id}`

const dateOf = (r: TmdbSearchResult): string | undefined => r.first_air_date ?? r.release_date

/** Public TMDB page for a title — what the admin UI links "view on TMDB" to. */
export const tmdbPageUrl = (kind: TmdbKind, id: number): string =>
  `https://www.themoviedb.org/${kind}/${id}`

/**
 * Search TV shows or films by name. `include_adult=false` mirrors TMDB's own
 * default for unauthenticated browsing and keeps the add-title grid safe to
 * screenshot.
 */
export async function searchTmdb(
  kind: TmdbKind,
  query: string,
  limit = 15,
): Promise<TmdbSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const data = await tmdbJson<{ results?: TmdbSearchResult[] }>(`/search/${kind}`, {
    query: q,
    include_adult: 'false',
  })
  return (data.results ?? []).slice(0, limit).map((r) => ({
    source_id: r.id,
    title: titleOf(r),
    synopsis: r.overview ?? '',
    image_url: tmdbPoster(r.poster_path),
    url: tmdbPageUrl(kind, r.id),
    year: yearOf(dateOf(r)),
    type: kind === 'tv' ? 'TV' : 'Movie',
    // The search endpoint carries neither status nor episode count; the detail
    // call fills them in. The UI already degrades gracefully on nulls here
    // (Jikan's brief search results have the same gap).
    status: null,
    episodes: null,
  }))
}

/** Full metadata for one title, with external ids resolved in the same call. */
export async function fetchTmdbTitle(kind: TmdbKind, id: number): Promise<TmdbTitle> {
  const d = await tmdbJson<TmdbDetail>(`/${kind}/${id}`, { append_to_response: 'external_ids' })
  // A movie carries imdb_id at the top level; a show carries it under
  // external_ids. tvdb_id only ever exists for shows.
  const imdb = d.imdb_id ?? d.external_ids?.imdb_id ?? null
  return {
    source_id: d.id,
    title: titleOf(d),
    original_title: d.original_name ?? d.original_title ?? null,
    synopsis: d.overview ?? '',
    image_url: tmdbPoster(d.poster_path),
    backdrop_url: tmdbBackdrop(d.backdrop_path),
    url: tmdbPageUrl(kind, d.id),
    year: yearOf(dateOf(d)),
    type: kind === 'tv' ? 'TV' : 'Movie',
    status: d.status ?? null,
    episodes: d.number_of_episodes ?? null,
    imdb_id: imdb || null,
    tvdb_id: d.external_ids?.tvdb_id ?? null,
    score: typeof d.vote_average === 'number' && d.vote_average > 0 ? d.vote_average : null,
    genres: (d.genres ?? []).map((g) => g.name),
    // "Studios" is the anime catalog's column; for TV the closest equivalent is
    // the network, for film the production company.
    studios: (d.networks ?? d.production_companies ?? []).map((n) => n.name),
    seasons: (d.seasons ?? [])
      // Season 0 is TMDB's "Specials" bucket — not a season the library lays out.
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        season: s.season_number,
        episodes: s.episode_count,
        name: s.name,
        year: yearOf(s.air_date),
      })),
  }
}

export interface TmdbEpisode {
  episode: number
  title: string | null
  overview: string | null
  aired: string | null
}

/** Episode list for one season of a show. */
export async function fetchTmdbSeasonEpisodes(id: number, season: number): Promise<TmdbEpisode[]> {
  const d = await tmdbJson<{
    episodes?: { episode_number: number; name?: string | null; overview?: string | null; air_date?: string | null }[]
  }>(`/tv/${id}/season/${season}`)
  return (d.episodes ?? []).map((e) => ({
    episode: e.episode_number,
    title: e.name || null,
    overview: e.overview || null,
    aired: e.air_date || null,
  }))
}
