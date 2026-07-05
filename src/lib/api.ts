// Typed client for the public portal JSON APIs (server/publicRoutes.ts).

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

import { supabase } from './supabase'

export async function fetchAuth(url: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = new Headers(options.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }
  return fetch(url, { ...options, headers })
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

export interface SeriesEpisode { id: string; name: string; num: string }
export interface SeriesDetail {
  type: 'series'
  id: string
  name: string
  overview: string
  genres: string[]
  year: number | null
  episodes: SeriesEpisode[]
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
}

export interface ScheduleEvent {
  title: string; ep: string; img: string | null; type: string
  time: string; aired: boolean; now: boolean
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

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try { msg = ((await res.json()) as { error?: string }).error || msg } catch { /* non-JSON */ }
    throw new Error(msg)
  }
  return (await res.json()) as T
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
export const saveAnime = (item_id: string) => fetchAuth('/api/library/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id }) })
export const unsaveAnime = (item_id: string) => fetchAuth(`/api/library/saved/${encodeURIComponent(item_id)}`, { method: 'DELETE' })

export const getHistory = () => fetchAuth('/api/library/history').then(r => r.json() as Promise<{ history: { item_id: string; watched_at: string }[] }>)
export const addHistory = (item_id: string) => fetchAuth('/api/library/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id }) })
