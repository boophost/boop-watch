// Jellyfin access layer (ported from the legacy single-file server).
// All Jellyfin access is server-side; the api_key never reaches the browser.
import { Readable } from 'node:stream'
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

export async function ensureScope(): Promise<void> {
  if (scopeLoadedAt && Date.now() - scopeLoadedAt < SCOPE_TTL_MS) return
  if (!scopeLoading) {
    scopeLoading = refreshScope().finally(() => { scopeLoading = null })
  }
  await scopeLoading
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
    const body = stripCreds(await upstream.text())
    res.status(upstream.status)
    res.set('content-type', ct || 'application/vnd.apple.mpegurl')
    res.set('cache-control', 'no-store')
    res.send(body)
    return
  }

  res.status(upstream.status)
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h)
    if (v) res.set(h, v)
  }
  if (!upstream.body) {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
}
