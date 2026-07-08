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

// A "recently added" home-page entry. `id` is always directly playable
// (episode or movie), so cards link straight to /watch/:id.
export interface RecentItem {
  id: string
  seriesId: string | null
  type: 'episode' | 'movie'
  name: string
  epLabel: string
  epName: string
  addedAt: string | null
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
  watchId: string
}

export interface SeriesEpisode {
  id: string | null
  name: string
  num: string
  status?: ChaseState
  airsAt?: string | null
}
export interface SeriesDetail {
  type: 'series'
  id: string
  name: string
  overview: string
  genres: string[]
  year: number | null
  episodes: SeriesEpisode[]
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
export interface SubTrack { index: number; group: string }
export interface QualityPreset { key: string; label: string; h: number; vb: number }
export interface WatchEpisode { id: string; num: string; name: string; current: boolean }
export interface Segment { type: 'intro' | 'outro'; start: number; end: number }
export interface WatchData {
  id: string
  title: string
  epNum: string
  isEpisode: boolean
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
export const getFeatured = () => getJSON<{ items: FeaturedItem[] }>('/api/featured')
export const getTitle = (id: string) => getJSON<TitleDetail>(`/api/catalog/${encodeURIComponent(id)}`)
export const getWatch = (id: string) => getJSON<WatchData>(`/api/watch/${encodeURIComponent(id)}`)
export const getSchedule = (weekParam: string) =>
  getJSON<SchedulePayload>('/api/schedule' + (weekParam ? `?${weekParam}` : ''))

export const imgUrl = (id: string) => `/img/${encodeURIComponent(id)}`
export const backdropUrl = (id: string) => `/img/${encodeURIComponent(id)}/backdrop`

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

export async function submitSuggestion(body: string): Promise<void> {
  const r = await fetchAuth('/api/suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  const data = await parseAuthJson<{ error?: string }>(r)
  if (!r.ok) throw new Error(data.error || 'Failed to submit suggestion')
}
