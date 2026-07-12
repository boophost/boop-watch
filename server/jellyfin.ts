// Jellyfin access layer (ported from the legacy single-file server).
// All Jellyfin access is server-side; the api_key never reaches the browser.
import { Readable, pipeline } from 'node:stream'
import type { Request, Response } from 'express'
import { syncJellyfinToPortal } from './sync.js'
import { getPortalCollectionItems, getPortalScopeEpisodes, getPortalPlayableIds, PortalItem } from './portalDb.js'

const JF = (process.env.JELLYFIN_URL || 'http://jellyfin:8096').replace(/\/+$/, '')
const KEY = process.env.JELLYFIN_API_KEY
const COLLECTION_ID = process.env.WATCH_COLLECTION_ID
const SCOPE_TTL_MS = 5 * 60 * 1000

/** The public portal needs both an admin key and the "Public" collection id. */
export const jellyfinConfigured = Boolean(KEY && COLLECTION_ID)

export interface JfMediaStream {
  Index: number
  Type?: string
  Codec?: string
  Language?: string
  Channels?: number
  Width?: number
  Height?: number
  IsDefault?: boolean
  IsForced?: boolean
  IsTextSubtitleStream?: boolean
  Title?: string
  DisplayTitle?: string
}

export interface JfItem {
  Id: string
  Name?: string
  Type?: string
  DateCreated?: string
  PremiereDate?: string
  ProductionYear?: number
  Genres?: string[]
  OriginalTitle?: string
  Overview?: string
  RunTimeTicks?: number
  IndexNumber?: number
  ParentIndexNumber?: number
  SeriesId?: string
  SeriesName?: string
  PrimaryImageAspectRatio?: number
  BackdropImageTags?: string[]
  MediaStreams?: JfMediaStream[]
  MediaSources?: { MediaStreams?: JfMediaStream[]; Size?: number; Container?: string }[]
}

type Query = Record<string, string | number | undefined | null>

export function jfUrl(path: string, query: Query = {}): URL {
  const u = new URL(JF + (path.startsWith('/') ? path : '/' + path))
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  u.searchParams.set('api_key', KEY ?? '')
  return u
}

export async function jfJson<T = unknown>(path: string, query: Query = {}): Promise<T> {
  const res = await fetch(jfUrl(path, query), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Jellyfin ${path} -> ${res.status}`)
  return (await res.json()) as T
}

// The bare /Items/{id} route 500s on this server (it wants a user context),
// so fetch single-item metadata through the list endpoint instead.
export async function jfItem(id: string, fields = ''): Promise<JfItem> {
  const data = await jfJson<{ Items?: JfItem[] }>('/Items', { Ids: id, Fields: fields })
  return (data.Items || [])[0] || ({ Id: id } as JfItem)
}

// ---------------------------------------------------------------------------
// Season items per series — the picker cards need each season's display name
// and its own poster (season item id). Cached like the scope; a failed refresh
// serves the stale list rather than erroring the caller.
// ---------------------------------------------------------------------------
export interface JfSeason {
  Id: string; Name?: string; IndexNumber?: number; ImageTags?: { Primary?: string }
  ProductionYear?: number; PremiereDate?: string
}
const seasonCache = new Map<string, { at: number; items: JfSeason[] }>()

export async function getSeriesSeasons(seriesId: string): Promise<JfSeason[]> {
  const hit = seasonCache.get(seriesId)
  const now = Date.now()
  if (hit && now - hit.at < SCOPE_TTL_MS) return hit.items
  try {
    const data = await jfJson<{ Items?: JfSeason[] }>(`/Shows/${seriesId}/Seasons`, {
      Fields: 'ProductionYear,PremiereDate',
    })
    const items = (data.Items || []).filter((s) => s.IndexNumber != null)
    seasonCache.set(seriesId, { at: now, items })
    return items
  } catch {
    return hit?.items ?? []
  }
}

// ---------------------------------------------------------------------------
// Remote artwork. Jellyfin fronts whatever image providers it has configured
// (TheTVDB and TheMovieDb here, plus any provider plugin), so asking it for an
// item's remote images reaches those catalogs without us holding their keys —
// and the candidate pool grows on its own when a provider is added to Jellyfin.
// Season items carry their own, genuinely season-specific backgrounds.
// ---------------------------------------------------------------------------
export interface JfRemoteImage {
  provider: string
  url: string
  thumbUrl: string | null
  width: number | null
  height: number | null
}

interface JfRemoteImageRaw {
  ProviderName?: string
  Url?: string
  ThumbnailUrl?: string
  Width?: number
  Height?: number
}

/**
 * Remote artwork candidates Jellyfin's providers offer for one item. Jellyfin
 * returns them best-first, so `limit` trims the tail — worth capping, as a
 * popular series has ~125 remote posters.
 */
export async function jfRemoteImages(itemId: string, type = 'Backdrop', limit = 60): Promise<JfRemoteImage[]> {
  const data = await jfJson<{ Images?: JfRemoteImageRaw[] }>(`/Items/${itemId}/RemoteImages`, {
    type,
    limit,
    includeAllLanguages: 'true',
  })
  const out: JfRemoteImage[] = []
  for (const img of data.Images ?? []) {
    if (!img.Url) continue
    out.push({
      provider: img.ProviderName ?? 'jellyfin',
      url: img.Url,
      thumbUrl: img.ThumbnailUrl ?? null,
      width: img.Width ?? null,
      height: img.Height ?? null,
    })
  }
  return out
}

// tvdb id -> Jellyfin series id. `AnyProviderIdEquals` is silently ignored by
// this server (it returns the whole library), so match ProviderIds ourselves.
const tvdbIndex: { at: number; map: Map<number, string> } = { at: 0, map: new Map() }

export async function jfSeriesIdByTvdb(tvdbId: number): Promise<string | null> {
  const now = Date.now()
  if (now - tvdbIndex.at >= SCOPE_TTL_MS) {
    try {
      const data = await jfJson<{ Items?: (JfItem & { ProviderIds?: { Tvdb?: string } })[] }>('/Items', {
        Recursive: 'true',
        IncludeItemTypes: 'Series',
        Fields: 'ProviderIds',
      })
      const map = new Map<number, string>()
      for (const it of data.Items ?? []) {
        const tvdb = Number(it.ProviderIds?.Tvdb)
        // First match wins: duplicate library entries for one tvdb id (a stray
        // release dir re-scanned as its own series) must not shadow the real one.
        if (Number.isFinite(tvdb) && !map.has(tvdb)) map.set(tvdb, it.Id)
      }
      tvdbIndex.map = map
      tvdbIndex.at = now
    } catch {
      // Serve the stale index rather than losing every lookup on one hiccup.
    }
  }
  return tvdbIndex.map.get(tvdbId) ?? null
}

// ---------------------------------------------------------------------------
// Scope cache: what is publicly viewable, derived from the Public collection.
//   collectionItems : direct children (movies + series) -> browse/detail
//   playableIds     : movie ids + every episode id      -> the play guard
//   scopeEpisodes   : every episode item (with DateCreated) -> "recently added"
// ---------------------------------------------------------------------------
let collectionItems: JfItem[] = []
let scopeEpisodes: JfItem[] = []
let playableIds = new Set<string>()
let scopeLoadedAt = 0
let scopeLoading: Promise<void> | null = null

function mapPortalToJf(p: PortalItem): JfItem {
  return {
    Id: p.id,
    Name: p.name,
    Type: p.type,
    DateCreated: p.date_created || undefined,
    PremiereDate: p.premiere_date || undefined,
    ProductionYear: p.production_year || undefined,
    Genres: p.genres ? JSON.parse(p.genres) : undefined,
    OriginalTitle: p.original_title || undefined,
    Overview: p.overview || undefined,
    RunTimeTicks: p.runtime_ticks || undefined,
    IndexNumber: p.index_number ?? undefined,
    ParentIndexNumber: p.parent_index_number ?? undefined,
    SeriesId: p.series_id || undefined,
    SeriesName: p.series_name || undefined,
    BackdropImageTags: p.has_backdrop ? ['mock'] : undefined
  }
}

async function refreshScope(): Promise<void> {
  if (!jellyfinConfigured) throw new Error('Jellyfin not configured')
  
  await syncJellyfinToPortal()

  collectionItems = getPortalCollectionItems().map(mapPortalToJf)
  scopeEpisodes = getPortalScopeEpisodes().map(mapPortalToJf)
  playableIds = getPortalPlayableIds()
  scopeLoadedAt = Date.now()
}

// Throttles background refresh attempts when the sync keeps failing (a cold
// start always retries; see below).
let lastRefreshAttempt = 0

// Stale-while-revalidate. The scope (Public collection + playable ids) lives in
// memory and changes rarely, so once we have it we serve it immediately and
// refresh in the background when it goes stale — only the very first cold load
// blocks. Previously every request awaited refreshScope() once the 5-min cache
// expired, so a page's catalog call and its ~20 poster (/img) requests would
// all stall on one slow sync (Jellyfin + per-item Jikan/AniList calls) — and
// 502 together if it threw. Serving stale keeps the portal responsive.
export async function ensureScope(): Promise<void> {
  const now = Date.now()
  const haveData = scopeLoadedAt > 0
  if (haveData && now - scopeLoadedAt < SCOPE_TTL_MS) return

  if (!haveData) {
    // Cold start: nothing to serve, so block on a load and let failures surface
    // (routes turn that into a 502 "library unavailable"). Concurrent cold
    // requests share the one in-flight load.
    if (!scopeLoading) scopeLoading = refreshScope().finally(() => { scopeLoading = null })
    await scopeLoading
    return
  }

  // Warm but stale: refresh in the background and keep serving the current
  // scope — a slow or flaky sync never stalls (or 502s) the catalog/poster
  // requests. Throttled to once per TTL so a persistently failing sync doesn't
  // hammer upstreams.
  if (!scopeLoading && now - lastRefreshAttempt >= SCOPE_TTL_MS) {
    lastRefreshAttempt = now
    scopeLoading = refreshScope()
      .catch((e) => console.error('scope refresh failed (serving stale):', e instanceof Error ? e.message : e))
      .finally(() => { scopeLoading = null })
  }
}

/** Best-effort initial load at boot (no-op if Jellyfin isn't configured). */
export function warmScope(): void {
  if (!jellyfinConfigured) {
    console.warn('[jellyfin] JELLYFIN_API_KEY / WATCH_COLLECTION_ID not set — public portal routes disabled')
    return
  }
  refreshScope()
    .then(() => console.log(`scope loaded: ${collectionItems.length} items, ${playableIds.size} playable`))
    .catch((e) => console.error('initial scope load failed:', e instanceof Error ? e.message : e))
}

export const getCollectionItems = (): JfItem[] => collectionItems
export const getScopeEpisodes = (): JfItem[] => scopeEpisodes
export const getPlayableIds = (): Set<string> => playableIds
export const isCollectionItem = (id: string): boolean => collectionItems.some((it) => it.Id === id)

// ---------------------------------------------------------------------------
// Byte-streaming proxy to Jellyfin (images, playlists, segments).
// Jellyfin embeds the api_key inside playlist URIs; strip every api_key/ApiKey
// param so the viewer never sees the token. The catch-all re-adds it server-side
// when the (relative) URI comes back through us.
// ---------------------------------------------------------------------------
function stripCreds(m3u8: string): string {
  return m3u8
    .replace(/&(?:api_key|ApiKey)=[^&\r\n"']*/gi, '')      // mid/end param
    .replace(/\?(?:api_key|ApiKey)=[^&\r\n"']*&/gi, '?')   // first of several
    .replace(/\?(?:api_key|ApiKey)=[^&\r\n"']*/gi, '')     // only param
}

export async function proxy(
  req: Request,
  res: Response,
  url: URL,
  { isPlaylist = false }: { isPlaylist?: boolean } = {},
): Promise<void> {
  const headers: Record<string, string> = {}
  if (typeof req.headers.range === 'string') headers.range = req.headers.range

  let upstream: globalThis.Response
  try {
    upstream = await fetch(url, { headers })
  } catch {
    res.status(502).type('text').send('upstream error')
    return
  }

  const ct = upstream.headers.get('content-type') || ''
  const playlist = isPlaylist || /mpegurl/i.test(ct)

  if (playlist) {
    // Reading the body can reject too (the upstream can die between headers and
    // the last byte), and this one is awaited — so keep the 502 shape the fetch
    // failure above already uses rather than letting it surface as a 500.
    let text: string
    try {
      text = await upstream.text()
    } catch {
      res.status(502).type('text').send('upstream error')
      return
    }
    const body = stripCreds(text)
    res.status(upstream.status)
    res.set('content-type', ct || 'application/vnd.apple.mpegurl')
    res.set('cache-control', 'no-store')
    res.send(body)
    return
  }

  res.status(upstream.status)
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h)
    if (!v) continue
    // A lifetime the route already set wins over Jellyfin's. JF answers image
    // requests with a bare `cache-control: public` (no max-age), and copying it
    // over the route's `public, max-age=3600` silently deleted the max-age — so
    // the poster/season/backdrop routes have never actually cached for an hour
    // despite setting the header. Everything else still mirrors upstream.
    if (h === 'cache-control' && res.get('cache-control')) continue
    res.set(h, v)
  }
  // Never cache a failure. Routes set their own long max-age *before* calling
  // us (posters an hour, subtitles a day), and Jellyfin's error responses carry
  // no cache-control of their own — so without this an upstream 404/500 gets
  // stored under that lifetime and the browser keeps serving the error long
  // after the item is fixed. This is a "no poster for an hour" bug, not a
  // caching nicety.
  if (upstream.status >= 400) res.set('cache-control', 'no-store')
  if (!upstream.body) {
    res.end()
    return
  }
  // `.pipe()` leaves the body stream's 'error' event unhandled, and an unhandled
  // 'error' on a stream takes the whole process down. Upstream drops mid-body are
  // routine here — Jellyfin ends a transcode, restarts, or the viewer seeks/closes
  // the tab and undici aborts the fetch — so a single interrupted segment used to
  // crash the server for every viewer. pipeline() owns the error and tears both
  // sides down instead. Headers are already flushed by now, so there is no status
  // code left to send: just destroy the response.
  pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res, () => {
    res.destroy()
  })
}
