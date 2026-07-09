// Public (no-login) portal API: catalog browse/detail, player metadata, the
// HLS/subtitle/image proxies, and the schedule. Every content route runs through
// the scope guard — a request 403s/404s unless the id is in the Public collection.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import {
  jellyfinConfigured, ensureScope, jfItem, jfJson, jfUrl, proxy, getSeriesSeasons,
  getCollectionItems, getScopeEpisodes, getPlayableIds, isCollectionItem, type JfItem, type JfSeason,
} from './jellyfin.js'
import { buildWatchData, type Segment } from './watch.js'
import { aniskipSegments } from './aniskip.js'
import { getSchedule } from './schedule.js'
import { getPortalItem, getPortalEpisodes, getPortalSeasonCounts } from './portalDb.js'
import { getBanner, getSelectedBanner, findByMalId, listSeries, type BannerRow, type SeriesRow } from './db.js'
import { BANNERS_DIR } from './banners.js'
import { buildSeriesChase, toPublicChase } from './chaseContext.js'

export const publicRouter = Router()

// Serve a banner candidate. The cached copy under BANNERS_DIR wins, so art that
// moves or 404s upstream can't change what the portal shows; the remote URL is
// only a fallback for a row we haven't managed to cache yet. Returns false when
// the row points at nothing servable.
function serveBanner(res: Response, b: Pick<BannerRow, 'url' | 'local_file'>): boolean {
  if (b.local_file) {
    // basename guards against path traversal; filenames are server-generated.
    const file = path.join(BANNERS_DIR, path.basename(b.local_file))
    if (fs.existsSync(file)) { res.sendFile(file); return true }
  }
  if (b.url) { res.redirect(302, b.url); return true }
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
export function catalogCourForSeries(
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
    if (cour) return cour
    // No cour matches this season number. That's correct to reject for a mapped
    // multi-cour franchise (Slime S2's page must not resolve to S4's row) — but
    // only because those rows *have* seasons. A brand-new title whose mal_id
    // isn't in the season-mapping datasets yet has a null tvdb_season, so it can
    // never match any season; its row still *is* this series, and the manage
    // link is exactly where an admin goes to set the mapping. Fall back to it
    // when the whole franchise is unmapped (no row has a season) — that can't be
    // a real multi-cour franchise, so the guard above still holds for those.
    if (franchise.every((s) => s.tvdb_season == null)) return franchise[0]
    return null
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

// Home page rail: recently released watchables, newest first — one entry per
// *season* (a per-episode rail buries every other title whenever one show drops
// a batch), plus one per movie. `id` is always a *playable* id (the season's
// newest episode / the movie itself), so a card can still link into the player.
publicRouter.get('/api/recent', async (_req, res) => {
  if (!ensureConfigured(res)) return
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'Library unavailable' })
    return
  }
  // Same-day drops share a premiere date; break those ties by episode order
  // so the furthest-along episode represents the season.
  const epOrd = (ep: JfItem) => (ep.ParentIndexNumber || 0) * 10000 + (ep.IndexNumber || 0)

  // Newest episode per (series, season), and how many episodes that season has.
  const newest = new Map<string, JfItem>()
  const counts = new Map<string, number>()
  for (const ep of getScopeEpisodes()) {
    if (!ep.SeriesId) continue
    const key = `${ep.SeriesId}:${ep.ParentIndexNumber ?? ''}`
    counts.set(key, (counts.get(key) || 0) + 1)
    const prev = newest.get(key)
    if (!prev || releasedTs(ep) > releasedTs(prev) ||
        (releasedTs(ep) === releasedTs(prev) && epOrd(ep) > epOrd(prev))) {
      newest.set(key, ep)
    }
  }

  const entries = [
    ...[...newest].map(([key, ep]) => ({
      t: releasedTs(ep),
      item: {
        id: ep.Id,
        seriesId: ep.SeriesId || null,
        type: 'season' as const,
        name: ep.SeriesName || ep.Name || '',
        season: ep.ParentIndexNumber ?? null,
        epLabel: ep.IndexNumber != null ? `E${ep.IndexNumber}` : '',
        epCount: counts.get(key) || 0,
        addedAt: releasedAt(ep),
      },
    })),
    ...getCollectionItems().filter((it) => it.Type !== 'Series').map((it) => ({
      t: releasedTs(it),
      item: {
        id: it.Id,
        seriesId: null,
        type: 'movie' as const,
        name: it.Name || '',
        season: null,
        epLabel: '',
        epCount: 0,
        addedAt: releasedAt(it),
      },
    })),
  ]
  entries.sort((a, b) => b.t - a.t)
  res.json({ items: entries.slice(0, 24).map((e) => e.item) })
})

// Bulk metadata for playable ids, served straight from the in-memory scope
// cache (no Jellyfin round-trip). The "recently watched" rail resolves a page
// of history in one call instead of one /api/watch per row. Ids outside the
// Public collection are simply omitted — same guard as everywhere else.
publicRouter.get('/api/items/summary', async (req, res) => {
  if (!ensureConfigured(res)) return
  try {
    await ensureScope()
  } catch {
    res.status(502).json({ error: 'Library unavailable' })
    return
  }
  const ids = new Set(qStr(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60))
  if (!ids.size) { res.json({ items: [] }); return }

  const items = [
    ...getScopeEpisodes().filter((ep) => ids.has(ep.Id)).map((ep) => ({
      id: ep.Id,
      type: 'episode' as const,
      seriesId: ep.SeriesId || null,
      name: ep.SeriesName || ep.Name || '',
      season: ep.ParentIndexNumber ?? null,
      epLabel: ep.IndexNumber != null ? `E${ep.IndexNumber}` : '',
      epName: ep.Name || '',
    })),
    ...getCollectionItems().filter((it) => it.Type !== 'Series' && ids.has(it.Id)).map((it) => ({
      id: it.Id,
      type: 'movie' as const,
      seriesId: null,
      name: it.Name || '',
      season: null,
      epLabel: '',
      epName: '',
    })),
  ]
  res.json({ items })
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
      const seasonCounts = getPortalSeasonCounts(id)
      const seasons = seasonCounts.map((c) => c.season)
      const seasonParam = qStr(req.query.season)
      const seasonNum = seasonParam ? Number(seasonParam) : NaN
      // Default: latest season when multi-season (franchise page); single-season unchanged.
      const season =
        Number.isFinite(seasonNum) && seasons.includes(seasonNum)
          ? seasonNum
          : seasons.length > 1
            ? seasons[seasons.length - 1]
            : (seasons[0] ?? null)

      // Picker cards: full season names come from the JF season items (custom
      // names like "Final Season" pass through). Budgeted so a slow Jellyfin
      // can't stall the page — the "Season N" fallback still renders.
      let jfSeasons: JfSeason[] = []
      if (seasons.length > 1) {
        jfSeasons = await Promise.race([
          getSeriesSeasons(id),
          new Promise<JfSeason[]>((r) => setTimeout(() => r([]), 1500)),
        ])
      }
      const seasonList = seasonCounts.map((c) => ({
        season: c.season,
        name: jfSeasons.find((s) => s.IndexNumber === c.season)?.Name || `Season ${c.season}`,
        episodes: c.episodes,
      }))

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

      res.json({
        type: 'series',
        id,
        name: pItem.name || '',
        overview: pItem.overview || '',
        genres: pItem.genres ? JSON.parse(pItem.genres) : [],
        year: pItem.production_year || null,
        episodes,
        seasons,
        seasonList,
        season,
        manageId,
        nextEpisode,
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
  // Catalog id for the admin "Library settings" shortcut — season-scoped for
  // episodes (same franchise anchoring as the catalog route) so a watched
  // season that isn't catalogued gets no manageId, which also stops another
  // season's chase stub from trailing this season's sidebar.
  let manageId: number | null = null
  if (item.Type === 'Episode' && item.SeriesId) {
    const pSeries = getPortalItem(item.SeriesId)
    if (pSeries) manageId = catalogCourForSeries(pSeries, item.ParentIndexNumber ?? null)?.id ?? null
  } else if (pSelf?.mal_id != null) {
    manageId = findByMalId(pSelf.mal_id)?.id ?? null
  }
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
  // An admin-selected poster for this title's own cour wins, as with the hero.
  if (pItem?.mal_id != null) {
    const sel = getSelectedBanner(pItem.mal_id, 'poster')
    if (sel && serveBanner(res, sel)) return
  }
  if (pItem?.image_url) {
    res.redirect(302, pItem.image_url)
    return
  }
  await proxy(req, res, jfUrl(`/Items/${id}/Images/Primary`, { maxWidth: '400', quality: '90' }))
})

// Season poster (the picker cards) — that cour's admin-selected poster, else the
// JF season item's own art, falling back to the series poster so a card never
// renders empty. Guarded by the series id, so only seasons of Public titles are
// reachable.
publicRouter.get('/img/:id/season/:season', async (req, res) => {
  if (!ensureConfigured(res)) return
  await ensureScope().catch(() => {})
  const { id } = req.params
  if (!isCollectionItem(id)) {
    res.status(404).end()
    return
  }
  const n = Number(req.params.season)
  if (!Number.isFinite(n)) {
    res.redirect(302, `/img/${id}`)
    return
  }
  const pItem = getPortalItem(id)
  const cour = pItem ? catalogCourForSeries(pItem, n) : undefined
  if (cour) {
    const sel = getSelectedBanner(cour.mal_id, 'poster')
    if (sel && serveBanner(res, sel)) return
  }
  const match = (await getSeriesSeasons(id)).find((s) => s.IndexNumber === n)
  // No season item *or* that season has no poster of its own — Jellyfin 404s
  // the image rather than substituting one, so fall back here.
  if (!match?.ImageTags?.Primary) {
    res.redirect(302, `/img/${id}`)
    return
  }
  res.set('cache-control', 'public, max-age=3600')
  await proxy(req, res, jfUrl(`/Items/${match.Id}/Images/Primary`, { maxWidth: '300', quality: '90' }))
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
  // ?season= — prefer that cour's admin-selected banner; an uncatalogued
  // season (or one with no banner picked) falls through to the series chain.
  const seasonQ = Number(qStr(req.query.season))
  if (pItem && Number.isFinite(seasonQ)) {
    const cour = catalogCourForSeries(pItem, seasonQ)
    if (cour) {
      const sel = getSelectedBanner(cour.mal_id)
      if (sel && serveBanner(res, sel)) return
    }
  }
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
  if (!b) { res.status(404).end(); return }
  // `?thumb=1` is the picker's grid: a cour can carry dozens of provider
  // candidates, and only the selected one is ever cached locally, so fetching
  // each at full size to draw a 300px card would be gratuitous.
  if (req.query.thumb && b.thumb_url && !b.local_file) { res.redirect(302, b.thumb_url); return }
  if (!serveBanner(res, b)) res.status(404).end()
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
