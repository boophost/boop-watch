// Typed client for the public portal JSON APIs (server/publicRoutes.ts).

import type { ChaseState, EpisodeChase } from '@/lib/chase'
import { supabase } from './supabase'

export type { ChaseState, EpisodeChase }

export interface CatalogItem {
  id: string
  type?: string
  name: string
  year: number | null
  genres: string[]
}
export interface Catalog {
  items: CatalogItem[]
  genres: string[]
}

export async function fetchAuth(url: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = new Headers(options.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }
  return fetch(url, { ...options, headers })
}

/** Parse a fetchAuth response; surfaces plain-text/HTML proxy errors cleanly. */
export async function parseAuthJson<T>(r: Response): Promise<T> {
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    const text = (await r.text()).trim()
    // A non-JSON body here is an infra error page (e.g. a Cloudflare 5xx),
    // not our API. Dumping the raw HTML into the UI produces a wall of markup
    // (that's how a gateway blip used to render on the episodes tab), so throw
    // a concise message instead.
    if (!text || /^\s*</.test(text)) {
      throw new Error(
        r.status >= 500 ? `Upstream error (${r.status})` : `Request failed (${r.status})`,
      )
    }
    throw new Error(text)
  }
  return (await r.json()) as T
}

// A "recently updated" home-page entry: one per season, one per movie. `id` is
// always directly playable (the season's newest episode / the movie), and
// `epLabel` names that episode.
export interface RecentItem {
  id: string
  seriesId: string | null
  type: 'season' | 'movie'
  name: string
  season: number | null
  epLabel: string
  epCount: number
  addedAt: string | null
}

// Scope-cache metadata for a playable id — enough to render a history card.
export interface ItemSummary {
  id: string
  type: 'episode' | 'movie' | 'series'
  seriesId: string | null
  name: string
  season: number | null
  epLabel: string
  epName: string
}

// A featured-banner slide. `watchId` is directly playable (first episode /
// the movie); `id` is the title for detail links + artwork.
export interface FeaturedItem {
  id: string
  type: 'series' | 'movie'
  name: string
  overview: string
  year: number | null
  genres: string[]
  epCount: number | null
  /** Latest season, only for a multi-season series — drives the banner + label. */
  season: number | null
  watchId: string
}

export interface SeriesEpisode {
  id: string | null
  name: string
  num: string
  status?: ChaseState
  airsAt?: string | null
}
export interface SeasonInfo {
  season: number
  /** Full display name from Jellyfin (e.g. "Season 2", "Final Season"). */
  name: string
  episodes: number
}
export interface SeriesDetail {
  type: 'series'
  id: string
  name: string
  overview: string
  genres: string[]
  year: number | null
  episodes: SeriesEpisode[]
  /** JF season numbers present for this franchise (empty when unknown). */
  seasons?: number[]
  /** Per-season name + episode count for the season picker cards. */
  seasonList?: SeasonInfo[]
  /** Season whose episodes are listed (defaults to latest when multi-season). */
  season?: number | null
  // Catalog series id for the admin-only "Library settings" shortcut; null when
  // the title isn't in the catalog.
  manageId?: number | null
  nextEpisode?: EpisodeChase | null
}
export interface MovieDetail {
  type: 'movie'
  id: string
  name: string
  overview: string
  genres: string[]
  year: number | null
  runtimeMin: number | null
}
export type TitleDetail = SeriesDetail | MovieDetail

export interface AudioTrack { index: number; lang: string; label: string; detail: string; def: boolean }
export interface SubTrack { index: number; group: string; sel: string }
export interface QualityPreset { key: string; label: string; h: number; vb: number }
export interface WatchEpisode { id: string; num: string; name: string; current: boolean }
export interface Segment { type: 'intro' | 'outro'; start: number; end: number }
export interface WatchData {
  id: string
  title: string
  epNum: string
  isEpisode: boolean
  seriesId: string | null
  season: number | null
  back: { href: string; label: string }
  audio: { tracks: AudioTrack[]; default: number | null }
  subs: SubTrack[]
  quality: QualityPreset[]
  episodes: WatchEpisode[]
  nextId: string | null
  segments: Segment[]
  // Catalog series id for the admin-only "Library settings" shortcut.
  manageId?: number | null
  nextEpisode?: EpisodeChase | null
}

export interface ScheduleEvent {
  title: string; ep: string; img: string | null; type: string
  time: string; aired: boolean; onBreak: boolean
}
export interface ScheduleDay {
  iso: string; dow: string; label: string; today: boolean
  events: ScheduleEvent[]; count: number
}
export interface SchedulePayload {
  days: ScheduleDay[]
  range: string
  isCurrent: boolean
  prev: { year: number; week: number } | null
  next: { year: number; week: number } | null
  stats: { total: number; today: number; aired: number; upcoming: number }
}

async function getJSON<T>(url: string, attempt = 0): Promise<T> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      let msg = `Request failed (${res.status})`
      try { msg = ((await res.json()) as { error?: string }).error || msg } catch { /* non-JSON */ }
      throw new Error(msg)
    }
    return (await res.json()) as T
  } catch (e) {
    // Deploy cutovers / brief ingress blips surface as TypeError("NetworkError…")
    // in Firefox. Retry once before failing the page.
    const msg = e instanceof Error ? e.message : String(e)
    if (attempt < 1 && /networkerror|failed to fetch|load failed/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 400))
      return getJSON<T>(url, attempt + 1)
    }
    throw e instanceof Error ? e : new Error(msg)
  }
}

export const getCatalog = () => getJSON<Catalog>('/api/catalog')

// The browse grid and the header search palette both need the catalog; share one fetch.
let catalogPromise: Promise<Catalog> | null = null
export const loadCatalog = (): Promise<Catalog> => (catalogPromise ??= getCatalog())
export const getRecent = () => getJSON<{ items: RecentItem[] }>('/api/recent')
export const getItemSummaries = (ids: string[]) =>
  ids.length
    ? getJSON<{ items: ItemSummary[] }>(`/api/items/summary?ids=${encodeURIComponent(ids.join(','))}`)
    : Promise.resolve({ items: [] as ItemSummary[] })
export const getFeatured = () => getJSON<{ items: FeaturedItem[] }>('/api/featured')
export const getTitle = (id: string, season?: number | null) =>
  getJSON<TitleDetail>(
    `/api/catalog/${encodeURIComponent(id)}` +
      (season != null && Number.isFinite(season) ? `?season=${season}` : ''),
  )
export const getWatch = (id: string) => getJSON<WatchData>(`/api/watch/${encodeURIComponent(id)}`)

// OP/ED theme songs (MAL-sourced, season-scoped). Empty when the title isn't
// mapped to a MAL entry or the upstream is down — the widget hides itself.
export interface ThemeSong {
  kind: 'op' | 'ed'
  index: number | null
  title: string
  artist: string | null
  episodes: string | null
  /** Cover art (iTunes) — null while the server-side lookup is still cold. */
  art: string | null
}
export const getThemes = (id: string, season?: number | null) =>
  getJSON<{ themes: ThemeSong[] }>(
    `/api/catalog/${encodeURIComponent(id)}/themes` +
      (season != null && Number.isFinite(season) ? `?season=${season}` : ''),
  )
export const getSchedule = (weekParam: string) =>
  getJSON<SchedulePayload>('/api/schedule' + (weekParam ? `?${weekParam}` : ''))

export const imgUrl = (id: string) => `/img/${encodeURIComponent(id)}`
export const backdropUrl = (id: string, season?: number | null) =>
  `/img/${encodeURIComponent(id)}/backdrop` + (season != null ? `?season=${season}` : '')
export const seasonImgUrl = (id: string, season: number) =>
  `/img/${encodeURIComponent(id)}/season/${season}`

export const getSavedAnimes = () => fetchAuth('/api/library/saved').then(r => r.json() as Promise<{ saved: { item_id: string; added_at: string }[] }>)
export async function saveAnime(id: string): Promise<void> {
  const r = await fetchAuth('/api/library/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: id }),
  })
  if (!r.ok) throw new Error('failed to save anime')
}
export async function unsaveAnime(id: string): Promise<void> {
  const r = await fetchAuth(`/api/library/saved/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!r.ok) throw new Error('failed to unsave anime')
}

// Per-episode comments on the player page. Reading is public; posting and
// deleting ride the Supabase session (fetchAuth).
export interface Comment {
  id: number
  userId: string
  name: string
  avatarUrl: string | null
  isAdmin: boolean
  body: string
  createdAt: string
}

export const getComments = (itemId: string) =>
  getJSON<{ comments: Comment[] }>(`/api/comments/${encodeURIComponent(itemId)}`)

export async function postComment(itemId: string, body: string): Promise<Comment> {
  const r = await fetchAuth(`/api/comments/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  const data = await parseAuthJson<{ comment?: Comment; error?: string }>(r)
  if (!r.ok || !data.comment) throw new Error(data.error || 'Could not post comment')
  return data.comment
}

export async function deleteComment(id: number): Promise<void> {
  const r = await fetchAuth(`/api/comments/${id}`, { method: 'DELETE' })
  if (!r.ok) {
    const data = await parseAuthJson<{ error?: string }>(r).catch(() => ({ error: '' }))
    throw new Error(data.error || 'Could not delete comment')
  }
}

/** The GitHub issue a suggestion opened. */
export interface SuggestionIssue {
  number: number
  url: string
}

/** Submitting opens a GitHub issue (server-side, via the App bot). `page` and
 * `replayUrl` ride along so the issue is actionable without a follow-up. */
export async function submitSuggestion(
  body: string,
  context?: { page?: string, replayUrl?: string },
): Promise<SuggestionIssue> {
  const r = await fetchAuth('/api/suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, ...context }),
  })
  const data = await parseAuthJson<{ issue?: SuggestionIssue, error?: string }>(r)
  if (!r.ok || !data.issue) throw new Error(data.error || 'Failed to submit suggestion')
  return data.issue
}
