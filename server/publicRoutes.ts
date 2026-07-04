// Public (no-login) portal API: catalog browse/detail, player metadata, the
// HLS/subtitle/image proxies, and the schedule. Every content route runs through
// the scope guard — a request 403s/404s unless the id is in the Public collection.
import crypto from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import {
  jellyfinConfigured, ensureScope, jfItem, jfJson, jfUrl, proxy,
  getCollectionItems, getScopeEpisodes, getPlayableIds, isCollectionItem, type JfItem,
} from './jellyfin.js'
import { buildWatchData, type Segment } from './watch.js'
import { aniskipSegments } from './aniskip.js'
import { getSchedule } from './schedule.js'

export const publicRouter = Router()

const qStr = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '')

publicRouter.get('/health', (_req, res) => { res.type('text').send('ok') })

// Fail every portal route cleanly (not at boot) when Jellyfin isn't configured.
function ensureConfigured(res: Response): boolean {
  if (jellyfinConfigured) return true
  res.status(503).json({ error: 'Jellyfin not configured' })
  return false
}

// Browse: the Public collection.
publicRouter.get('/api/catalog', async (_req, res) => {
  if (!ensureConfigured(res)) return
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'Library unavailable' })
    return
  }
  const items = getCollectionItems().map((it) => ({
    id: it.Id,
    type: it.Type,
    name: it.Name || '',
    year: it.ProductionYear || null,
    genres: it.Genres || [],
  }))
  const genres = [...new Set(getCollectionItems().flatMap((it) => it.Genres || []))].sort()
  res.json({ items, genres })
})

// Recency = the actual release/air date (PremiereDate), so a bulk-imported
// back-catalog doesn't flood the rail; DateCreated (file added) is the
// fallback for items with no premiere metadata.
const releasedAt = (it: JfItem): string | null => it.PremiereDate || it.DateCreated || null
const releasedTs = (it: JfItem): number => Date.parse(releasedAt(it) || '') || 0

// Home page rail: every recently released watchable, newest first — each
// episode is its own entry, movies too. Clicking an entry goes straight to
// /watch/:id, so id is always a *playable* id.
publicRouter.get('/api/recent', async (_req, res) => {
  if (!ensureConfigured(res)) return
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'Library unavailable' })
    return
  }
  const epLabel = (ep: JfItem) =>
    (ep.ParentIndexNumber != null && ep.IndexNumber != null)
      ? `S${ep.ParentIndexNumber}·E${ep.IndexNumber}`
      : (ep.IndexNumber != null ? `E${ep.IndexNumber}` : '')
  // Same-day drops share a premiere date; break those ties by episode order
  // so the furthest-along episode leads.
  const epOrd = (ep: JfItem) => (ep.ParentIndexNumber || 0) * 10000 + (ep.IndexNumber || 0)

  const entries = [
    ...getScopeEpisodes().map((ep) => ({
      t: releasedTs(ep),
      o: epOrd(ep),
      item: {
        id: ep.Id,
        seriesId: ep.SeriesId || null,
        type: 'episode' as const,
        name: ep.SeriesName || ep.Name || '',
        epLabel: epLabel(ep),
        epName: ep.Name || '',
        addedAt: releasedAt(ep),
      },
    })),
    ...getCollectionItems().filter((it) => it.Type !== 'Series').map((it) => ({
      t: releasedTs(it),
      o: 0,
      item: {
        id: it.Id,
        seriesId: null,
        type: 'movie' as const,
        name: it.Name || '',
        epLabel: '',
        epName: '',
        addedAt: releasedAt(it),
      },
    })),
  ]
  entries.sort((a, b) => (b.t - a.t) || (b.o - a.o))
  res.json({ items: entries.slice(0, 24).map((e) => e.item) })
})

// Home page spotlight: the five most recently updated titles, with enough
// metadata to render the featured banner. `watchId` jumps straight into the
// title — the first regular episode for series (S0 specials sort last), the
// movie itself otherwise.
publicRouter.get('/api/featured', async (_req, res) => {
  if (!ensureConfigured(res)) return
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'Library unavailable' })
    return
  }
  const epOrd = (ep: JfItem) =>
    (ep.ParentIndexNumber ? ep.ParentIndexNumber : 999) * 10000 + (ep.IndexNumber ?? 9999)

  const newestBySeries = new Map<string, number>()
  const firstEp = new Map<string, JfItem>()
  const epCount = new Map<string, number>()
  for (const ep of getScopeEpisodes()) {
    const sid = ep.SeriesId
    if (!sid) continue
    const t = releasedTs(ep)
    if (t > (newestBySeries.get(sid) ?? -1)) newestBySeries.set(sid, t)
    epCount.set(sid, (epCount.get(sid) || 0) + 1)
    const prev = firstEp.get(sid)
    if (!prev || epOrd(ep) < epOrd(prev)) firstEp.set(sid, ep)
  }

  const entries = getCollectionItems().flatMap((it) => {
    const isSeries = it.Type === 'Series'
    const watchId = isSeries ? firstEp.get(it.Id)?.Id : it.Id
    if (!watchId) return []
    return [{
      t: isSeries ? (newestBySeries.get(it.Id) ?? 0) : releasedTs(it),
      item: {
        id: it.Id,
        type: isSeries ? ('series' as const) : ('movie' as const),
        name: it.Name || '',
        overview: it.Overview || '',
        year: it.ProductionYear || null,
        genres: (it.Genres || []).slice(0, 3),
        epCount: isSeries ? (epCount.get(it.Id) || 0) : null,
        watchId,
      },
    }]
  })
  entries.sort((a, b) => b.t - a.t)
  res.json({ items: entries.slice(0, 5).map((e) => e.item) })
})

// Title detail — series (with episode list) or movie.
publicRouter.get('/api/catalog/:id', async (req, res) => {
  if (!ensureConfigured(res)) return
  const { id } = req.params
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'unavailable' })
    return
  }
  if (!isCollectionItem(id)) {
    res.status(403).json({ error: 'not available' })
    return
  }
  const known = getCollectionItems().find((it) => it.Id === id)
  try {
    if (known?.Type === 'Series') {
      const series = await jfItem(id, 'Overview,Genres,ProductionYear')
      const eps = await jfJson<{ Items?: JfItem[] }>(`/Shows/${id}/Episodes`, { Fields: 'Overview' })
      const episodes = (eps.Items || []).map((ep) => ({
        id: ep.Id,
        name: ep.Name || 'Episode',
        num: (ep.ParentIndexNumber != null && ep.IndexNumber != null)
          ? `S${ep.ParentIndexNumber}·E${ep.IndexNumber}`
          : (ep.IndexNumber != null ? `E${ep.IndexNumber}` : '·'),
      }))
      res.json({
        type: 'series',
        id,
        name: series.Name || '',
        overview: series.Overview || '',
        genres: series.Genres || [],
        year: series.ProductionYear || null,
        episodes,
      })
    } else {
      const item = await jfItem(id, 'Overview,Genres,ProductionYear,RunTimeTicks')
      res.json({
        type: 'movie',
        id,
        name: item.Name || '',
        overview: item.Overview || '',
        genres: item.Genres || [],
        year: item.ProductionYear || null,
        runtimeMin: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null,
      })
    }
  } catch {
    res.status(502).json({ error: 'unavailable' })
  }
})

// Player metadata (audio/subtitle/quality tracks + sibling episodes).
publicRouter.get('/api/watch/:id', async (req, res) => {
  if (!ensureConfigured(res)) return
  const { id } = req.params
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'unavailable' })
    return
  }
  if (!getPlayableIds().has(id)) {
    res.status(403).json({ error: 'not available' })
    return
  }
  // Intro/outro skip ranges from Jellyfin Media Segments (populated server-side
  // by a provider plugin, e.g. Intro Skipper). Keyed by the same item id; empty
  // when no provider is installed, so the player simply shows no skip button.
  const segPromise = jfJson<{ Items?: Array<{ Type?: string; StartTicks?: number; EndTicks?: number }> }>(
    `/MediaSegments/${id}`, { includeSegmentTypes: 'Intro,Outro' },
  ).then((d) => (d.Items || []).flatMap((s) => {
    const type = String(s.Type || '').toLowerCase()
    if (type !== 'intro' && type !== 'outro') return []
    return [{ type: type as 'intro' | 'outro', start: (s.StartTicks || 0) / 1e7, end: (s.EndTicks || 0) / 1e7 }]
  })).catch(() => [])

  let item: JfItem = { Id: id }
  try { item = await jfItem(id, 'MediaStreams,MediaSources,Overview') } catch { /* title is cosmetic */ }

  let siblings: JfItem[] = []
  if (item.Type === 'Episode' && item.SeriesId) {
    try {
      const e = await jfJson<{ Items?: JfItem[] }>(`/Shows/${item.SeriesId}/Episodes`)
      siblings = (e.Items || []).filter((ep) => getPlayableIds().has(ep.Id))
    } catch { /* sidebar is optional */ }
  }

  // Fallback: when Jellyfin has no Media Segments provider, source community
  // skip times from AniSkip (MAL-keyed, resolved by the episode's air date).
  // Budgeted so a cold resolve (Jikan sequel-chain walk) can't stall the route —
  // the walk keeps filling the cache in the background and the *next* load of
  // the episode gets the button.
  let segments = await segPromise
  if (!segments.length && item.Type === 'Episode' && item.SeriesName) {
    const epLenSec = item.RunTimeTicks ? item.RunTimeTicks / 1e7 : 0
    segments = await Promise.race([
      aniskipSegments(item.SeriesName, item.PremiereDate, epLenSec).catch(() => [] as Segment[]),
      new Promise<Segment[]>((r) => setTimeout(() => r([]), 8000)),
    ])
  }
  res.json(buildWatchData(id, item, siblings, segments))
})

// Weekly anime schedule, filtered to the library.
publicRouter.get('/api/schedule', async (req, res) => {
  if (!ensureConfigured(res)) return
  const year = qStr(req.query.year)
  const week = qStr(req.query.week)
  const weekParam = (/^\d{4}$/.test(year) && /^\d{1,2}$/.test(week)) ? `year=${year}&week=${week}` : ''
  try {
    await Promise.all([ensureScope().catch(() => {}), Promise.resolve()])
    const sched = await getSchedule(weekParam)
    res.json(sched)
  } catch {
    res.status(502).json({ error: 'Schedule unavailable right now.' })
  }
})

// Poster proxy.
publicRouter.get('/img/:id', async (req, res) => {
  if (!ensureConfigured(res)) return
  await ensureScope().catch(() => {})
  const { id } = req.params
  if (!getPlayableIds().has(id) && !isCollectionItem(id)) {
    res.status(404).end()
    return
  }
  await proxy(req, res, jfUrl(`/Items/${id}/Images/Primary`, { maxWidth: '400', quality: '90' }))
})

// Wide backdrop art for the featured banner (top-level titles only; the client
// falls back to the poster when a title has no backdrop).
publicRouter.get('/img/:id/backdrop', async (req, res) => {
  if (!ensureConfigured(res)) return
  await ensureScope().catch(() => {})
  const { id } = req.params
  if (!isCollectionItem(id)) {
    res.status(404).end()
    return
  }
  await proxy(req, res, jfUrl(`/Items/${id}/Images/Backdrop/0`, { maxWidth: '1600', quality: '80' }))
})

// HLS entry point: build the master playlist request with transcode params.
publicRouter.get('/api/play/:id/master.m3u8', async (req, res) => {
  if (!ensureConfigured(res)) return
  const { id } = req.params
  try { await ensureScope() } catch { res.status(502).end(); return }
  if (!getPlayableIds().has(id)) { res.status(403).end(); return }

  const params: Record<string, string | number> = {
    MediaSourceId: id,
    VideoCodec: 'h264',
    AudioCodec: 'aac,mp3',
    SegmentContainer: 'ts',
    TranscodingMaxAudioChannels: '2',
    BreakOnNonKeyFrames: 'true',
    MinSegments: '2',
    PlaySessionId: crypto.randomUUID(),
  }
  // Audio / quality selection, validated as ints so nothing arbitrary reaches JF.
  // Subtitles are NOT burned in here — they're delivered separately via /api/sub
  // and rendered client-side (JASSUB), so toggling subs never restarts ffmpeg.
  const audio = parseInt(qStr(req.query.audio), 10)
  if (Number.isInteger(audio)) params.AudioStreamIndex = audio
  const h = parseInt(qStr(req.query.h), 10)
  if (Number.isInteger(h) && h > 0) params.maxHeight = h
  const vb = parseInt(qStr(req.query.vb), 10)
  if (Number.isInteger(vb) && vb > 0) params.videoBitRate = vb

  await proxy(req, res, jfUrl(`/Videos/${id}/master.m3u8`, params), { isPlaylist: true })
})

// HLS sub-playlists + segments. Relative URIs in the playlists resolve under
// /api/play/:id/ and map 1:1 onto Jellyfin's /Videos/:id/. (Express 5 requires a
// named wildcard; req.params.splat is the matched path segments.)
publicRouter.get('/api/play/:id/*splat', async (req, res) => {
  if (!ensureConfigured(res)) return
  const { id } = req.params
  try { await ensureScope() } catch { res.status(502).end(); return }
  if (!getPlayableIds().has(id)) { res.status(403).end(); return }

  const splat = (req.params as Record<string, string | string[]>).splat
  const rest = Array.isArray(splat) ? splat.join('/') : String(splat) // e.g. "main.m3u8" or "hls1/main/0.ts"
  const url = jfUrl(`/Videos/${id}/${rest}`)
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'api_key') url.searchParams.set(k, qStr(v))
  }
  await proxy(req, res, url)
})

// Text-subtitle delivery (rendered client-side by JASSUB). Jellyfin converts any
// text track to ASS, so one path covers every subtitle.
publicRouter.get('/api/sub/:id/:index', async (req, res) => {
  if (!ensureConfigured(res)) return
  const { id } = req.params
  try { await ensureScope() } catch { res.status(502).end(); return }
  if (!getPlayableIds().has(id)) { res.status(403).end(); return }
  const index = parseInt(req.params.index, 10)
  if (!Number.isInteger(index) || index < 0) { res.status(400).end(); return }

  res.set('cache-control', 'public, max-age=86400') // subtitles are static per item
  res.set('access-control-allow-origin', '*')        // JASSUB's worker may fetch cross-origin
  await proxy(req, res, jfUrl(`/Videos/${id}/${id}/Subtitles/${index}/0/Stream.ass`))
})
