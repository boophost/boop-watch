// Public (no-login) portal API: catalog browse/detail, player metadata, the
// HLS/subtitle/image proxies, and the schedule. Every content route runs through
// the scope guard — a request 403s/404s unless the id is in the Public collection.
import crypto from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import {
  jellyfinConfigured, ensureScope, jfItem, jfJson, jfUrl, proxy,
  getCollectionItems, getPlayableIds, isCollectionItem, type JfItem,
} from './jellyfin.js'
import { buildWatchData } from './watch.js'
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
  let item: JfItem = { Id: id }
  try { item = await jfItem(id, 'MediaStreams,MediaSources,Overview') } catch { /* title is cosmetic */ }

  let siblings: JfItem[] = []
  if (item.Type === 'Episode' && item.SeriesId) {
    try {
      const e = await jfJson<{ Items?: JfItem[] }>(`/Shows/${item.SeriesId}/Episodes`)
      siblings = (e.Items || []).filter((ep) => getPlayableIds().has(ep.Id))
    } catch { /* sidebar is optional */ }
  }
  res.json(buildWatchData(id, item, siblings))
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
