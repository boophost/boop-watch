// Public (no-login) portal API: catalog browse/detail, player metadata, the
// HLS/subtitle/image proxies, and the schedule. Every content route runs through
// the scope guard — a request 403s/404s unless the id is in the Public collection.
import crypto from 'node:crypto'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import {
  jellyfinConfigured, ensureScope, jfItem, jfJson, jfUrl, proxy,
  getCollectionItems, getScopeEpisodes, getPlayableIds, isCollectionItem, type JfItem,
} from './jellyfin.js'
import { buildWatchData, type Segment } from './watch.js'
import { aniskipSegments } from './aniskip.js'
import { getSchedule } from './schedule.js'
import { getPortalItem, getPortalEpisodes, getPortalSeasons } from './portalDb.js'
import { getBanner, getSelectedBanner, findByMalId, listSeries, type BannerRow, type SeriesRow } from './db.js'
import { buildSeriesChase, toPublicChase } from './chaseContext.js'
import { fetchAnimeFull, relatedAnimeFromFull } from './jikan.js'

export const publicRouter = Router()

// Uploaded banner files live under DATA_DIR/banners (a mounted volume in prod).
export const BANNERS_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'banners')

// Serve a banner candidate: redirect to its remote URL, or stream the uploaded
// file. Returns false when the row points at nothing servable.
function serveBanner(res: Response, b: Pick<BannerRow, 'url' | 'local_file'>): boolean {
  if (b.url) { res.redirect(302, b.url); return true }
  if (b.local_file) {
    // basename guards against path traversal; filenames are server-generated.
    res.sendFile(path.join(BANNERS_DIR, path.basename(b.local_file)))
    return true
  }
  return false
}

const qStr = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '')

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** True when a catalog title is clearly the same franchise as the portal name. */
function titleMatchesFranchise(portalName: string, catalog: SeriesRow): boolean {
  const name = normTitle(portalName)
  if (!name) return false
  for (const raw of [catalog.title, catalog.title_english]) {
    if (!raw) continue
    const t = normTitle(raw)
    if (!t) continue
    if (name === t || name.includes(t) || t.includes(name)) return true
  }
  return false
}

/**
 * Catalog cour for a Public JF series.
 * Always anchor to this franchise first (mal_id / title / shared tvdb_id) —
 * never pick another show that merely shares the same `tvdb_season` number
 * (Slime ?season=2 must not resolve to Mushoku Part 2).
 */
function catalogCourForSeries(
  pItem: { mal_id: number | null; name: string },
  season: number | null,
): SeriesRow | null {
  const all = listSeries()

  let franchise: SeriesRow[] = []
  if (pItem.mal_id != null) {
    const seed = findByMalId(pItem.mal_id)
    if (seed?.tvdb_id != null) {
      franchise = all.filter((s) => s.tvdb_id === seed.tvdb_id)
    } else if (seed) {
      franchise = [seed]
    }
  }
  if (franchise.length === 0) {
    franchise = all.filter((s) => titleMatchesFranchise(pItem.name, s))
    // Expand to every cour sharing a tvdb_id with a title hit.
    const tvdbIds = new Set(franchise.map((s) => s.tvdb_id).filter((id): id is number => id != null))
    if (tvdbIds.size > 0) {
      franchise = all.filter((s) => s.tvdb_id != null && tvdbIds.has(s.tvdb_id))
    }
  }

  if (season != null && franchise.length > 0) {
    const cour = franchise.find((s) => s.tvdb_season === season)
    // Season not in catalog (e.g. Slime S1–S3 while only S4 is indexed) → no cour.
    return cour ?? null
  }

  if (pItem.mal_id != null) return findByMalId(pItem.mal_id) ?? null
  return franchise[0] ?? null
}

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
    if (!it.BackdropImageTags || it.BackdropImageTags.length === 0) return []
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
  const pItem = getPortalItem(id)
  try {
    if (pItem?.type === 'Series') {
      const seasons = getPortalSeasons(id)
      const seasonParam = qStr(req.query.season)
      const seasonNum = seasonParam ? Number(seasonParam) : NaN
      // Default: latest season when multi-season (franchise page); single-season unchanged.
      const season =
        Number.isFinite(seasonNum) && seasons.includes(seasonNum)
          ? seasonNum
          : seasons.length > 1
            ? seasons[seasons.length - 1]
            : (seasons[0] ?? null)

      const eps = getPortalEpisodes(id, season)
      const episodes: Array<{
        id: string | null
        name: string
        num: string
        status?: string
        airsAt?: string | null
      }> = eps.map((ep) => ({
        id: ep.id,
        name: ep.name || 'Episode',
        num: (ep.parent_index_number != null && ep.index_number != null)
          ? `S${ep.parent_index_number}·E${ep.index_number}`
          : (ep.index_number != null ? `E${ep.index_number}` : '·'),
      }))

      const manageRow = catalogCourForSeries(pItem, season)
      const manageId = manageRow?.id ?? null
      let nextEpisode: ReturnType<typeof toPublicChase> = null
      if (manageId != null) {
        try {
          const chase = await buildSeriesChase(manageId, {
            includeLibrary: false,
            budgetMs: 2500,
          })
          nextEpisode = toPublicChase(chase.nextChase)
          if (nextEpisode) {
            const stubNum =
              season != null
                ? `S${season}·E${nextEpisode.episode}`
                : `E${nextEpisode.episode}`
            episodes.push({
              id: null,
              name: nextEpisode.title || `Episode ${nextEpisode.episode}`,
              num: stubNum,
              status: nextEpisode.state,
              airsAt: nextEpisode.airsAt,
            })
          }
        } catch (e) {
          console.error('catalog chase failed —', e)
        }
      }

      // Related seasons/titles from Jikan relations → catalog rows that are on Public.
      let related: Array<{ id: string; name: string; relation: string; mal_id: number }> = []
      const malForRelated = manageRow?.mal_id ?? pItem.mal_id
      if (malForRelated != null) {
        try {
          const full = await Promise.race([
            fetchAnimeFull(malForRelated),
            new Promise<null>((r) => setTimeout(() => r(null), 2500)),
          ])
          if (full) {
            const links = relatedAnimeFromFull(full)
            const publicByMal = new Map(
              getCollectionItems()
                .map((it) => {
                  const p = getPortalItem(it.Id)
                  return p?.mal_id != null ? ([p.mal_id, { id: it.Id, name: p.name || it.Name || '' }] as const) : null
                })
                .filter((x): x is readonly [number, { id: string; name: string }] => !!x),
            )
            // Also map catalog mal_id → Public JF id via title match when portal mal unset.
            for (const link of links) {
              let hit = publicByMal.get(link.mal_id)
              if (!hit) {
                const cat = findByMalId(link.mal_id)
                if (cat) {
                  const jf = getCollectionItems().find((it) => {
                    const p = getPortalItem(it.Id)
                    return p?.mal_id === link.mal_id || (p?.name && cat.title_english && p.name === cat.title_english)
                  })
                  if (jf) hit = { id: jf.Id, name: jf.Name || cat.title_english || cat.title }
                }
              }
              if (hit && hit.id !== id) {
                related.push({ id: hit.id, name: hit.name, relation: link.relation, mal_id: link.mal_id })
              }
            }
          }
        } catch (e) {
          console.error('related seasons failed —', e)
        }
      }

      res.json({
        type: 'series',
        id,
        name: pItem.name || '',
        overview: pItem.overview || '',
        genres: pItem.genres ? JSON.parse(pItem.genres) : [],
        year: pItem.production_year || null,
        episodes,
        seasons,
        season,
        manageId,
        nextEpisode,
        related,
      })
    } else if (pItem) {
      res.json({
        type: 'movie',
        id,
        name: pItem.name || '',
        overview: pItem.overview || '',
        genres: pItem.genres ? JSON.parse(pItem.genres) : [],
        year: pItem.production_year || null,
        runtimeMin: pItem.runtime_ticks ? Math.round(pItem.runtime_ticks / 600000000) : null,
      })
    } else {
      res.status(404).json({ error: 'not found' })
    }
  } catch (e) {
    console.error(e)
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
      const season = item.ParentIndexNumber
      siblings = (e.Items || []).filter(
        (ep) =>
          getPlayableIds().has(ep.Id) &&
          (season == null || ep.ParentIndexNumber === season),
      )
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

  // Prefer our catalog-sourced names (portalDb) over Jellyfin's for everything
  // the player shows — episode/movie title, the series back-link, and the
  // sidebar list. Done after AniSkip so its matching still uses Jellyfin's title.
  const pSelf = getPortalItem(id)
  if (pSelf?.name) item.Name = pSelf.name
  if (item.SeriesId) {
    const pSeries = getPortalItem(item.SeriesId)
    if (pSeries?.name) item.SeriesName = pSeries.name
  }
  if (item.SeriesId && siblings.length) {
    const names = new Map(getPortalEpisodes(item.SeriesId).map((e) => [e.id, e.name]))
    siblings = siblings.map((ep) => {
      const n = names.get(ep.Id)
      return n ? { ...ep, Name: n } : ep
    })
  }
  // Catalog id for the admin "Library settings" shortcut — from the series
  // (episodes) or the item itself (movies). null when not catalogued.
  const manageMal = (item.SeriesId ? getPortalItem(item.SeriesId) : pSelf)?.mal_id
  const manageId = manageMal != null ? (findByMalId(manageMal)?.id ?? null) : null
  let nextEpisode: ReturnType<typeof toPublicChase> = null
  if (manageId != null && item.Type === 'Episode') {
    try {
      const chase = await buildSeriesChase(manageId, {
        includeLibrary: false,
        budgetMs: 2500,
      })
      nextEpisode = toPublicChase(chase.nextChase)
    } catch (e) {
      console.error('watch chase failed —', e)
    }
  }
  res.json({ ...buildWatchData(id, item, siblings, segments), manageId, nextEpisode })
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
  const pItem = getPortalItem(id)
  if (pItem?.image_url) {
    res.redirect(302, pItem.image_url)
    return
  }
  await proxy(req, res, jfUrl(`/Items/${id}/Images/Primary`, { maxWidth: '400', quality: '90' }))
})

// Wide banner art (top-level titles only) for the season hero and featured
// rail. Prefer our AniList banner, then Jellyfin's own backdrop, and only as a
// last resort the poster — so the hero is never empty but avoids a stretched
// portrait whenever a real wide image exists.
publicRouter.get('/img/:id/backdrop', async (req, res) => {
  if (!ensureConfigured(res)) return
  await ensureScope().catch(() => {})
  const { id } = req.params
  if (!isCollectionItem(id)) {
    res.status(404).end()
    return
  }
  const pItem = getPortalItem(id)
  // The admin-selected banner candidate wins (AniList/Kitsu/upload)…
  if (pItem?.mal_id != null) {
    const sel = getSelectedBanner(pItem.mal_id)
    if (sel && serveBanner(res, sel)) return
  }
  if (pItem?.backdrop_url) {
    res.redirect(302, pItem.backdrop_url)
    return
  }
  // …then Jellyfin's own backdrop, then the poster as a last resort.
  const image = pItem?.has_backdrop ? 'Backdrop/0' : 'Primary'
  await proxy(req, res, jfUrl(`/Items/${id}/Images/${image}`, { maxWidth: '1600', quality: '80' }))
})

// Serve any banner candidate by id (public art — used by the admin picker's
// thumbnails and reachable from an <img> tag without auth).
publicRouter.get('/api/banner/:bannerId/image', (req, res) => {
  const bid = Number(req.params.bannerId)
  const b = Number.isFinite(bid) ? getBanner(bid) : undefined
  if (!b || !serveBanner(res, b)) res.status(404).end()
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
  // Subtitles are normally NOT burned in — they're delivered separately via
  // /api/sub and rendered client-side (JASSUB), so toggling subs never restarts
  // ffmpeg. The exception is ?sub=: devices whose native fullscreen/PiP player
  // can't show a DOM overlay (iPhone) request the track burned into the video
  // (Jellyfin encodes with libass, so styling matches JASSUB).
  const audio = parseInt(qStr(req.query.audio), 10)
  if (Number.isInteger(audio)) params.AudioStreamIndex = audio
  const h = parseInt(qStr(req.query.h), 10)
  if (Number.isInteger(h) && h > 0) params.maxHeight = h
  const vb = parseInt(qStr(req.query.vb), 10)
  if (Number.isInteger(vb) && vb > 0) params.videoBitRate = vb
  const sub = parseInt(qStr(req.query.sub), 10)
  if (Number.isInteger(sub) && sub >= 0) {
    params.SubtitleStreamIndex = sub
    params.SubtitleMethod = 'Encode'
  }

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
