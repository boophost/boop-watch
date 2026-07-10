import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'
import {
  searchAnime,
  pickPosterUrl,
  fetchAnimeFull,
  fetchAnimeEpisodesPage,
  episodeNumberFromUrl,
} from './jikan.js'
import * as seriesDb from './db.js'
import { enrichSeasonMapping } from './seasonMap.js'
import { publicRouter, commentView } from './publicRoutes.js'
import { cacheSelectedBanner, ensureSeriesBanners, BANNERS_DIR, EXT_BY_TYPE } from './banners.js'
import { flowRouter, runFlowAndRecord, acquireFlowLock, releaseFlowLock } from './flowRoutes.js'
import { startScheduler } from './scheduler.js'
import type { FlowGraph } from './flowExecutor.js'
import { discordPresenceRouter } from './discordPresence.js'
import { searchAnimeAniList } from './anilist.js'
import { warmScope, ensureScope, getPlayableIds } from './jellyfin.js'
import { getSeriesLibraryMedia } from './downloads.js'
import { buildSeriesChase, buildSeriesListChases } from './chaseContext.js'
import { qbitConfigured, qbitDelete } from './qbit.js'
import * as blacklist from './blacklist.js'
import { posthogProxy } from './posthogProxy.js'
import { posthogUiHost } from './posthogConfig.js'
import { deleteUser, listAllUsers, setUserAdmin } from './users.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.disable('x-powered-by')
const PORT = parseInt(process.env.PORT ?? '3001')
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'
const AUTH_USERNAME = process.env.AUTH_USERNAME ?? 'admin'
const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? 'changeme'
// .trim() guards against stray whitespace in the env value — untrimmed, a
// trailing space survives string interpolation and makes fetch() throw
// "Failed to parse URL" on every Supabase Bearer-token check, silently
// falling back to (always-failing) local JWT verification.
const SUPABASE_URL = process.env.SUPABASE_URL?.trim() || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || ''
const COOKIE_NAME = 'ai_session'
const IS_PROD = process.env.NODE_ENV === 'production'

// Before body parsers — PostHog proxy forwards the raw request stream.
app.use(posthogProxy)
app.use(express.json())
app.use(cookieParser())

// Public, no-login portal routes (catalog, player, HLS/sub/image proxies,
// schedule). Registered before the authed admin APIs and the SPA catch-all.
app.use(publicRouter)

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  let token = req.cookies[COOKIE_NAME] as string | undefined
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1]
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
      })
      if (resp.ok) {
        const user = await resp.json()
        res.locals.username = user.id
        res.locals.email = typeof user.email === 'string' ? user.email : ''
        // Display identity for user-visible content (comments): OAuth name keys
        // vary by provider (Google: full_name/name, Discord: user_name); fall
        // back to the email's local part so there is always a readable label.
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>
        const name = [meta.full_name, meta.name, meta.user_name].find(
          (v): v is string => typeof v === 'string' && v.trim().length > 0,
        )
        res.locals.displayName = name?.trim() || String(res.locals.email).split('@')[0] || 'user'
        const avatar = meta.avatar_url ?? meta.picture
        res.locals.avatarUrl = typeof avatar === 'string' && avatar ? avatar : null
        return next()
      }
    } catch (e) {
      // fallback to jwt.verify below
    }
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { username?: string, email?: string }
    res.locals.username = payload.email || payload.username || 'admin'
    res.locals.email = payload.email || ''
    res.locals.displayName = String(res.locals.username).split('@')[0]
    res.locals.avatarUrl = null
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

// Same allowlist idea as ADMIN_EMAILS in src/lib/AuthContext.tsx, but enforced
// server-side for the APIs that can mutate the portal or hammer upstreams.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'ethanwhi@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

function requireAdmin(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const email = String(res.locals.email ?? '').toLowerCase()
  if (!email || !ADMIN_EMAILS.includes(email)) {
    res.status(403).json({ error: 'Admin only' })
    return
  }
  next()
}

// Flow editor + scheduler APIs (admin-only: flows run external fetches + portal
// writes). Both are served by flowRouter; the gates cover their path prefixes.
app.use('/api/flows', requireAuth, requireAdmin)
app.use('/api/schedules', requireAuth, requireAdmin)
app.use(flowRouter)

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await listAllUsers()
    res.json({ users })
  } catch (e) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to list users'
    res.status(502).json({ error: msg })
  }
})

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = String(req.params.id)
  const { isAdmin } = req.body as { isAdmin?: unknown }
  if (typeof isAdmin !== 'boolean') {
    res.status(400).json({ error: 'isAdmin (boolean) required' })
    return
  }
  if (id === res.locals.username && !isAdmin) {
    res.status(400).json({ error: 'Cannot remove your own admin access' })
    return
  }
  try {
    const user = await setUserAdmin(id, isAdmin)
    res.json({ user })
  } catch (e) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to update user'
    const status = msg === 'User not found' ? 404 : 502
    res.status(status).json({ error: msg })
  }
})

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = String(req.params.id)
  if (id === res.locals.username) {
    res.status(400).json({ error: 'Cannot delete your own account' })
    return
  }
  try {
    await deleteUser(id)
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to delete user'
    res.status(502).json({ error: msg })
  }
})

// Discord watch-status presence (opt-in OAuth link + playback heartbeats).
app.use(discordPresenceRouter(requireAuth))

app.get('/api/me', requireAuth, (_req, res) => {
  res.json({ username: res.locals.username as string })
})

app.get('/api/search/anime', requireAuth, async (req, res) => {
  const raw = req.query.q
  const q = typeof raw === 'string' ? raw : ''
  if (!q.trim()) {
    res.json({ results: [] })
    return
  }
  // AniList is the primary search source: it needs no auth, carries idMal (so
  // hits stay addable to our MAL-id catalog), and is reliable. We self-host
  // Jikan only for the MAL-specific data AniList lacks (per-episode titles,
  // detail) — its search endpoint needs a Typesense index we don't run, so it's
  // the fallback here, used only if AniList is down.
  try {
    const results = await searchAnimeAniList(q)
    res.json({ results })
  } catch (anilistErr) {
    console.error('search: AniList failed, trying Jikan —', anilistErr)
    try {
      const data = await searchAnime(q)
      res.json({
        results: data.map((a) => ({
          mal_id: a.mal_id,
          title: a.title,
          synopsis: a.synopsis ?? '',
          image_url: pickPosterUrl(a),
          url: a.url,
        })),
      })
    } catch (jikanErr) {
      console.error('search: Jikan fallback also failed —', jikanErr)
      res.status(502).json({ error: 'Anime metadata lookup is temporarily unavailable — try again shortly' })
    }
  }
})

app.get('/api/series', requireAuth, async (_req, res) => {
  seriesDb.getDb()
  const series = seriesDb.listSeries()
  try {
    const chases = await buildSeriesListChases(series)
    res.json({
      series: series.map((s) => ({
        ...s,
        nextChase: chases.get(s.id) ?? null,
      })),
    })
  } catch (e) {
    console.error('series list chase enrich failed —', e)
    res.json({ series })
  }
})

app.get('/api/series/:id/detail', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const series = seriesDb.getSeriesById(id)
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  try {
    const mal = await fetchAnimeFull(series.mal_id)
    // Persist episode count + weekly broadcast so chase can estimate next air
    // times when Jikan hasn't listed the next episode yet.
    try {
      const patch: Parameters<typeof seriesDb.upsertSeriesMetadata>[1] = {}
      if (typeof mal.episodes === 'number' && mal.episodes > 0 && mal.episodes !== series.episodes) {
        patch.episodes = mal.episodes
      }
      if (mal.status && mal.status !== series.status) patch.status = mal.status
      if (mal.broadcast) {
        const serialized = JSON.stringify({
          day: mal.broadcast.day ?? null,
          time: mal.broadcast.time ?? null,
          timezone: mal.broadcast.timezone ?? null,
          string: mal.broadcast.string ?? null,
        })
        if (serialized !== series.broadcast) patch.broadcast = serialized
      }
      if (Object.keys(patch).length) {
        seriesDb.upsertSeriesMetadata({ mal_id: series.mal_id, title: series.title }, patch)
      }
    } catch (persistErr) {
      console.error('detail: failed to persist metadata —', persistErr)
    }
    res.json({ series: seriesDb.getSeriesById(id) ?? series, mal })
  } catch (e) {
    console.error(e)
    res.json({
      series,
      mal: null,
      malError: e instanceof Error ? e.message : 'Could not load MAL details',
    })
  }
})

app.get('/api/series/:id/episodes', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const series = seriesDb.getSeriesById(id)
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  const pageRaw = req.query.page
  const p =
    typeof pageRaw === 'string' && Number.isFinite(Number(pageRaw))
      ? Math.max(1, Math.floor(Number(pageRaw)))
      : 1
  const malUrl = series.url ?? `https://myanimelist.net/anime/${series.mal_id}`
  try {
    const { episodes, pagination } = await fetchAnimeEpisodesPage(series.mal_id, p)
    // The episode number drives every per-episode cell (library file, download,
    // watch link). MAL episode URLs don't always carry `/episode/N`, so fall back
    // to the episode's own mal_id (Jikan numbers episodes there) then its page
    // position — never leave it null, or the whole row goes blank.
    const rows = episodes.map((e, i) => ({
      mal_id: e.mal_id,
      url: e.url,
      title: e.title,
      title_japanese: e.title_japanese ?? null,
      aired: e.aired ?? null,
      filler: e.filler,
      recap: e.recap,
      episode: episodeNumberFromUrl(e.url) ?? e.mal_id ?? (p - 1) * 100 + i + 1,
    }))
    // Cache what we got so the fallback below can serve it next time Jikan is down.
    seriesDb.upsertEpisodes(
      series.mal_id,
      rows.map((r) => ({
        number: r.episode,
        title: r.title,
        title_japanese: r.title_japanese,
        aired: r.aired,
      })),
    )
    res.json({ episodes: rows, pagination, source: 'jikan' })
  } catch (e) {
    // Jikan (MAL proxy) flakes constantly. Rather than an empty page, serve a
    // fallback so the per-episode library/watch status is still visible: cached
    // rows if we ever fetched them, else a synthesized 1..N from the known count.
    console.error(e)
    if (p > 1) {
      // Fallbacks are a single page; deeper paging has nothing more to give.
      res.json({ episodes: [], pagination: { has_next_page: false, current_page: p }, source: 'none' })
      return
    }
    const cached = seriesDb.getCachedEpisodes(series.mal_id)
    let rows: {
      mal_id: number
      url: string
      title: string
      title_japanese: string | null
      aired: string | null
      filler: boolean
      recap: boolean
      episode: number
    }[] = []
    let source = ''
    if (cached.length > 0) {
      rows = cached.map((c) => ({
        mal_id: series.mal_id,
        url: malUrl,
        title: c.title ?? `Episode ${c.number}`,
        title_japanese: c.title_japanese ?? null,
        aired: c.aired ?? null,
        filler: false,
        recap: false,
        episode: c.number,
      }))
      source = 'cache'
    } else if (series.episodes && series.episodes > 0) {
      rows = Array.from({ length: series.episodes }, (_, i) => ({
        mal_id: series.mal_id,
        url: malUrl,
        title: `Episode ${i + 1}`,
        title_japanese: null,
        aired: null,
        filler: false,
        recap: false,
        episode: i + 1,
      }))
      source = 'synthesized'
    }
    if (rows.length === 0) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'Could not load episodes' })
      return
    }
    res.json({
      episodes: rows,
      pagination: { has_next_page: false, current_page: 1, last_visible_page: 1 },
      source,
    })
  }
})

app.post('/api/series', requireAuth, (req, res) => {
  const body = req.body as {
    mal_id?: unknown
    title?: unknown
    synopsis?: unknown
    image_url?: unknown
    url?: unknown
  }
  const mal_id = typeof body.mal_id === 'number' ? body.mal_id : Number(body.mal_id)
  const title = typeof body.title === 'string' ? body.title : ''
  const synopsis =
    typeof body.synopsis === 'string' ? body.synopsis : body.synopsis == null ? null : String(body.synopsis)
  const image_url =
    typeof body.image_url === 'string' ? body.image_url : body.image_url == null ? null : String(body.image_url)
  const url =
    typeof body.url === 'string' ? body.url : body.url == null ? null : String(body.url)

  if (!Number.isFinite(mal_id) || !title) {
    res.status(400).json({ error: 'mal_id and title are required' })
    return
  }
  if (seriesDb.findByMalId(mal_id)) {
    res.status(409).json({ error: 'Already in your list' })
    return
  }
  try {
    const row = seriesDb.insertSeries({
      mal_id,
      title,
      synopsis,
      image_url,
      url,
    })
    res.status(201).json({ series: row })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Could not save series' })
  }
})

app.delete('/api/series/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  if (!seriesDb.deleteSeries(id)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ ok: true })
})

// Multi-season placement override. A cour whose season-map dataset value is
// wrong (public data mis-tags some split cours) gets a manual TVDB season +
// episode offset here; the auto-enrich then leaves it alone. `source: 'auto'`
// resets the row and re-resolves from the dataset.
app.patch('/api/series/:id/mapping', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const series = seriesDb.getSeriesById(id)
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  const body = req.body as { tvdb_id?: unknown; tvdb_season?: unknown; episode_offset?: unknown; source?: unknown }
  const numOrNull = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  try {
    if (body.source === 'auto') {
      // Clear the manual flag, then re-resolve from the dataset.
      seriesDb.setSeasonMapping(series.mal_id, { source: null })
      await enrichSeasonMapping(series.mal_id, { write: true })
    } else {
      seriesDb.setSeasonMapping(series.mal_id, {
        tvdb_id: numOrNull(body.tvdb_id),
        tvdb_season: numOrNull(body.tvdb_season),
        episode_offset: numOrNull(body.episode_offset) ?? 0,
        source: 'manual',
      })
    }
    res.json({ series: seriesDb.getSeriesById(id) })
  } catch (e) {
    console.error('mapping update failed', e)
    res.status(500).json({ error: 'Could not update mapping' })
  }
})

// --- Series downloads / blacklist (manage series page) --------------------

// Download status for a series: matched qBittorrent torrents + which episodes
// are already live on the public portal + this series' blacklist.
app.get('/api/series/:id/downloads', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  try {
    // buildSeriesChase already carries the download status (one shared qBit
    // query — previously this route fetched it twice), and skips qBit entirely
    // when every expected episode is on site.
    const chase = await buildSeriesChase(id)
    res.json({
      qbitConfigured: chase.qbitConfigured,
      qbitError: chase.qbitError,
      torrents: chase.torrents,
      siteEpisodes: chase.siteEpisodes,
      qbitSkipped: chase.qbitSkipped,
      blacklist: blacklist.listBlacklist(id),
      airedCount: chase.airedCount,
      expectedForPipeline: chase.expectedForPipeline,
      nextChase: chase.nextChase,
      portalSeriesId: chase.portalSeriesId,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load downloads' })
  }
})

// Reconcile the import ledger against the library on disk. `unclaimed` files
// have no recorded provenance — they predate the ledger or were placed by hand,
// and they are what a cleanup must quarantine rather than guess about.
// `missing` rows point at a file that is gone; `rewritten` ones at a file whose
// inode changed under us (a trim/mux re-encode landing as a copy).
app.get('/api/library/ledger', requireAuth, requireAdmin, (_req, res) => {
  const root = process.env.LIBRARY_DIR ?? '/library'
  const rows = seriesDb.listLibraryFiles()
  const onDisk = new Set<string>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mkv|mp4|m4v|avi)$/i.test(e.name)) onDisk.add(path.relative(root, p))
    }
  }
  walk(root)

  const claimed = new Set(rows.map((r) => r.path))
  const missing: string[] = []
  const rewritten: string[] = []
  for (const r of rows) {
    if (!onDisk.has(r.path)) { missing.push(r.path); continue }
    try {
      if (r.inode != null && fs.statSync(path.join(root, r.path)).ino !== r.inode) rewritten.push(r.path)
    } catch { /* raced with a delete */ }
  }
  const unclaimed = [...onDisk].filter((p) => !claimed.has(p)).sort()
  res.json({
    root,
    counts: { onDisk: onDisk.size, recorded: rows.length, unclaimed: unclaimed.length, missing: missing.length, rewritten: rewritten.length },
    unclaimed,
    missing,
    rewritten,
  })
})

// Per-episode media facts for the files actually in the library (codec, audio
// tracks, resolution, size) — what the mux/import produced, not the torrents.
app.get('/api/series/:id/library', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  try {
    res.json({ episodes: await getSeriesLibraryMedia(id) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load library media' })
  }
})

// Remove a download from qBittorrent (optionally its files).
app.post('/api/series/:id/downloads/delete', requireAuth, requireAdmin, async (req, res) => {
  const body = req.body as { hash?: unknown; deleteFiles?: unknown }
  const hash = typeof body.hash === 'string' ? body.hash : ''
  if (!hash) {
    res.status(400).json({ error: 'hash required' })
    return
  }
  if (!qbitConfigured()) {
    res.status(503).json({ error: 'qBittorrent is not configured (QBIT_URL)' })
    return
  }
  try {
    await qbitDelete([hash], body.deleteFiles === true)
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(502).json({ error: e instanceof Error ? e.message : 'Delete failed' })
  }
})

// Blacklist a source so the flow won't re-pick it; optionally remove it from
// qBittorrent in the same action.
app.post('/api/series/:id/blacklist', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const body = req.body as {
    info_hash?: unknown
    name?: unknown
    reason?: unknown
    alsoDelete?: unknown
    deleteFiles?: unknown
  }
  const info_hash = typeof body.info_hash === 'string' ? body.info_hash : ''
  if (!info_hash) {
    res.status(400).json({ error: 'info_hash required' })
    return
  }
  const row = blacklist.addBlacklist({
    info_hash,
    name: typeof body.name === 'string' ? body.name : null,
    series_id: Number.isFinite(id) ? id : null,
    reason: typeof body.reason === 'string' ? body.reason : null,
  })
  let deleted = false
  if (body.alsoDelete === true && qbitConfigured()) {
    try {
      await qbitDelete([info_hash], body.deleteFiles === true)
      deleted = true
    } catch (e) {
      console.error('blacklist qbit delete failed', e)
    }
  }
  res.status(201).json({ entry: row, deleted })
})

app.delete('/api/blacklist/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || !blacklist.removeBlacklist(id)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ ok: true })
})

// A one-off, single-series version of the acquisition flow: find the best
// non-blacklisted, playable (h264/HEVC, no AV1) release for this series and
// queue it in qBittorrent. Built from the same nodes as the "Missing videos"
// flow, so blacklisted hashes are skipped automatically and the run shows up in
// the Activity tab. Used by the series page's "Blacklist" action to swap a bad
// source for a fresh one in one click.
function buildResearchGraph(seriesId: number, query: string): FlowGraph {
  return {
    nodes: [
      { id: 'idx', type: 'source.indexer', position: { x: 0, y: 0 }, config: {} },
      { id: 'pick', type: 'filter.field', position: { x: 260, y: 0 }, config: { field: 'id', mode: 'equals', value: String(seriesId) } },
      // Literal query (no {refs}) — the caller picks the English title, since
      // dual-audio releases are usually English-named; romaji misses them.
      { id: 'tpl', type: 'transform.template', position: { x: 520, y: 0 }, config: { field: 'torrent_query', template: query } },
      { id: 'st', type: 'enrich.anime-status', position: { x: 780, y: 0 }, config: { malField: 'mal_id', maxItems: 0 } },
      { id: 'tor', type: 'enrich.torrent-search', position: { x: 1040, y: 0 }, config: { provider: 'tsukihime', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, preferDualAudio: true, requireDualAudio: false, excludeCodecs: 'av1', minSeeders: 0, minTitleMatch: 0.4, maxEpisodes: 26, maxItems: 0 } },
      { id: 'qb', type: 'sink.qbittorrent', position: { x: 1300, y: 0 }, config: { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false } },
    ],
    edges: [
      { id: 'e1', source: 'idx', sourceHandle: 'items', target: 'pick', targetHandle: 'in' },
      { id: 'e2', source: 'pick', sourceHandle: 'pass', target: 'tpl', targetHandle: 'in' },
      { id: 'e3', source: 'tpl', sourceHandle: 'items', target: 'st', targetHandle: 'in' },
      { id: 'e4', source: 'st', sourceHandle: 'out', target: 'tor', targetHandle: 'in' },
      { id: 'e5', source: 'st', sourceHandle: 'unknown', target: 'tor', targetHandle: 'in' },
      { id: 'e6', source: 'tor', sourceHandle: 'found', target: 'qb', targetHandle: 'in' },
    ],
  }
}

app.post('/api/series/:id/research', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  if (!acquireFlowLock()) {
    res.status(409).json({ error: 'A flow is already running — try again in a moment' })
    return
  }
  try {
    const query = `${series.title_english || series.title} 1080p`
    const report = await runFlowAndRecord(buildResearchGraph(id, query), {
      dryRun: false,
      flowId: null,
      flowName: `Re-search: ${series.title_english || series.title}`,
    })
    const queued = report.nodes.qb?.counts?.sent ?? 0
    const notes = [...(report.nodes.tor?.notes ?? []), ...(report.nodes.qb?.notes ?? [])]
    res.json({ ok: report.ok, queued, notes })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Re-search failed' })
  } finally {
    releaseFlowLock()
  }
})

// ---- Season-banner candidates (admin picker + upload) ---------------------
// Shape an art row for the client: `preview` is the public image route so an
// <img> can render it (uploads aren't public URLs).
function bannerView(b: seriesDb.BannerRow) {
  return {
    id: b.id,
    kind: b.kind,
    source: b.source,
    selected: b.selected === 1,
    width: b.width,
    height: b.height,
    preview: `/api/banner/${b.id}/image`,
    thumb: `/api/banner/${b.id}/image?thumb=1`,
  }
}

/** `?kind=poster` picks the portrait art; anything else means the wide banner. */
const artKind = (req: express.Request): seriesDb.ArtKind =>
  seriesDb.isArtKind(req.query.kind) ? req.query.kind : 'banner'

// List candidates of one kind (gathering them from remote sources on first view).
app.get('/api/series/:id/banners', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!series) { res.status(404).json({ error: 'Series not found' }); return }
  try { await ensureSeriesBanners(series.mal_id) } catch (e) { console.error('art gather failed', e) }
  res.json({ banners: seriesDb.listBanners(series.mal_id, artKind(req)).map(bannerView) })
})

// Choose which candidate the portal serves. The kind comes from the row itself.
app.post('/api/series/:id/banners/select', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!series) { res.status(404).json({ error: 'Series not found' }); return }
  const bannerId = Number((req.body as { bannerId?: unknown })?.bannerId)
  const row = Number.isFinite(bannerId) ? seriesDb.getBanner(bannerId) : undefined
  if (!row || !seriesDb.selectBanner(series.mal_id, bannerId)) {
    res.status(400).json({ error: 'Unknown banner for this series' })
    return
  }
  // Only the selection is cached, so a newly-picked candidate has to be pulled
  // down now — otherwise the portal hotlinks it until the next gather.
  try { await cacheSelectedBanner(series.mal_id, row.kind) } catch (e) { console.error('art cache failed', e) }
  res.json({ banners: seriesDb.listBanners(series.mal_id, row.kind).map(bannerView) })
})

// Upload custom art (raw image bytes; content-type sets the extension).
app.post(
  '/api/series/:id/banners/upload',
  requireAuth, requireAdmin,
  express.raw({ type: Object.keys(EXT_BY_TYPE), limit: '12mb' }),
  (req, res) => {
    const id = Number(req.params.id)
    const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
    if (!series) { res.status(404).json({ error: 'Series not found' }); return }
    const ext = EXT_BY_TYPE[String(req.headers['content-type'] ?? '').split(';')[0].trim()]
    const body = req.body as Buffer
    if (!ext || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Send raw image bytes (jpeg/png/webp/avif/gif)' })
      return
    }
    const kind = artKind(req)
    const file = `${series.mal_id}-${Date.now()}.${ext}`
    fs.mkdirSync(BANNERS_DIR, { recursive: true })
    fs.writeFileSync(path.join(BANNERS_DIR, file), body)
    const row = seriesDb.addBanner({ mal_id: series.mal_id, kind, source: 'upload', local_file: file })
    seriesDb.selectBanner(series.mal_id, row.id)
    res.status(201).json({ banners: seriesDb.listBanners(series.mal_id, kind).map(bannerView) })
  },
)

// Remove a candidate (deletes an uploaded file; re-selects a default if needed).
app.delete('/api/series/:id/banners/:bannerId', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!series) { res.status(404).json({ error: 'Series not found' }); return }
  const bannerId = Number(req.params.bannerId)
  const removed = Number.isFinite(bannerId) ? seriesDb.deleteBanner(series.mal_id, bannerId) : undefined
  if (!removed) { res.status(404).json({ error: 'Banner not found' }); return }
  if (removed.local_file) {
    try { fs.unlinkSync(path.join(BANNERS_DIR, path.basename(removed.local_file))) } catch { /* already gone */ }
  }
  // Deleting the selected banner promotes the next candidate — the hero must not
  // go empty. A deleted poster promotes nothing: with none selected the portal
  // falls back to the season's own Jellyfin poster, which is the better default.
  if (removed.selected === 1 && removed.kind === 'banner') {
    const next = seriesDb.listBanners(series.mal_id, 'banner')[0]
    if (next) seriesDb.selectBanner(series.mal_id, next.id)
  }
  res.json({ banners: seriesDb.listBanners(series.mal_id, removed.kind).map(bannerView) })
})

app.get('/api/library/saved', requireAuth, (req, res) => {
  res.json({ saved: seriesDb.getSavedAnimes(res.locals.username as string) })
})

app.post('/api/library/saved', requireAuth, (req, res) => {
  const { item_id } = req.body
  if (!item_id) { res.status(400).json({ error: 'item_id required' }); return }
  seriesDb.saveAnime(res.locals.username as string, String(item_id))
  res.json({ ok: true })
})

app.delete('/api/library/saved/:id', requireAuth, (req, res) => {
  seriesDb.unsaveAnime(res.locals.username as string, String(req.params.id))
  res.json({ ok: true })
})

// --- Suggestions (any logged-in user submits; admins review in /manage) ----

const SUGGESTION_MAX = 2000

app.post('/api/suggestions', requireAuth, (req, res) => {
  const body = String((req.body as { body?: unknown })?.body ?? '').trim()
  if (!body) {
    res.status(400).json({ error: 'Suggestion cannot be empty' })
    return
  }
  if (body.length > SUGGESTION_MAX) {
    res.status(400).json({ error: `Suggestion is too long (max ${SUGGESTION_MAX} characters)` })
    return
  }
  const row = seriesDb.addSuggestion(
    res.locals.username as string,
    (res.locals.email as string) || null,
    body,
  )
  res.status(201).json({ suggestion: row })
})

app.get('/api/suggestions', requireAuth, requireAdmin, (_req, res) => {
  res.json({ suggestions: seriesDb.listSuggestions() })
})

app.patch('/api/suggestions/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { status } = req.body as { status?: unknown }
  if (
    !Number.isFinite(id) ||
    typeof status !== 'string' ||
    !seriesDb.SUGGESTION_STATUSES.includes(status as seriesDb.SuggestionStatus)
  ) {
    res.status(400).json({ error: `status must be one of: ${seriesDb.SUGGESTION_STATUSES.join(', ')}` })
    return
  }
  const row = seriesDb.setSuggestionStatus(id, status as seriesDb.SuggestionStatus)
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ suggestion: row })
})

app.delete('/api/suggestions/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || !seriesDb.deleteSuggestion(id)) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ ok: true })
})

// --- Per-episode comments (public read lives in publicRoutes; writes here) ---

const COMMENT_MAX = 1000

app.post('/api/comments/:itemId', requireAuth, async (req, res) => {
  const itemId = String(req.params.itemId)
  // Same scope guard as every public content route: only playable Public-
  // collection ids accept comments, so the table can't be spammed with junk ids.
  try { await ensureScope() } catch { res.status(502).json({ error: 'Library unavailable' }); return }
  if (!getPlayableIds().has(itemId)) {
    res.status(403).json({ error: 'not available' })
    return
  }
  const body = String((req.body as { body?: unknown })?.body ?? '').trim()
  if (!body) {
    res.status(400).json({ error: 'Comment cannot be empty' })
    return
  }
  if (body.length > COMMENT_MAX) {
    res.status(400).json({ error: `Comment is too long (max ${COMMENT_MAX} characters)` })
    return
  }
  const row = seriesDb.addComment({
    item_id: itemId,
    user_id: res.locals.username as string,
    user_name: (res.locals.displayName as string) || 'user',
    avatar_url: (res.locals.avatarUrl as string | null) ?? null,
    body,
  })
  res.status(201).json({ comment: commentView(row) })
})

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? seriesDb.getComment(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const email = String(res.locals.email ?? '').toLowerCase()
  const isAdmin = !!email && ADMIN_EMAILS.includes(email)
  if (row.user_id !== res.locals.username && !isAdmin) {
    res.status(403).json({ error: 'Not your comment' })
    return
  }
  seriesDb.deleteComment(id)
  res.json({ ok: true })
})


app.get('/config.js', (req, res) => {
  // Dynamic per-request env dump — a CDN in front of this (e.g. Cloudflare)
  // will otherwise cache it by its .js extension and serve stale credentials
  // long after a Supabase URL/key rotation.
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'no-store')
  res.send(`window.ENV = {
    SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)},
    SUPABASE_ANON_KEY: ${JSON.stringify(SUPABASE_ANON_KEY)},
    POSTHOG_KEY: ${JSON.stringify(process.env.POSTHOG_KEY || '')},
    POSTHOG_UI_HOST: ${JSON.stringify(process.env.POSTHOG_UI_HOST || posthogUiHost())}
  };`)
})

if (IS_PROD) {
  const distPath = path.join(__dirname, '../dist')
  
  app.use(express.static(distPath))
  app.use((req, res) => {
    if (
      req.method === 'GET' &&
      !req.path.startsWith('/api') &&
      !req.path.startsWith('/ingest')
    ) {
      // root-relative so send()'s dotfile check doesn't 404 when the checkout
      // itself lives under a dot-directory (e.g. a .claude worktree)
      res.sendFile('index.html', { root: distPath })
      return
    }
    res.status(404).end()
  })
}

app.listen(PORT, () => {
  seriesDb.getDb()
  warmScope()
  startScheduler()
  console.log(`Server running on http://localhost:${PORT}`)
})
