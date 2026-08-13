import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'
import { fetchAnimeFull } from './jikan.js'
import * as seriesDb from './db.js'
import { getEpisodesForDisplay, isProperTitle } from './episodes.js'
import { enrichSeasonMapping } from './seasonMap.js'
import { publicRouter, commentView, portalSeriesForCatalog } from './publicRoutes.js'
import {
  getPortalSeasonCounts, getPortalSeasonTitles, getPortalSeasonYears, setPortalSeasonTitle,
  isPortalSection, type PortalSection,
} from './portalDb.js'
import { sectionConfigs, sectionProvider } from './sections.js'
import {
  listConfig, setConfig, clearConfig, isKnownConfigKey, configKeyConfigured,
} from './config.js'
import { clientForSection } from './metadata/index.js'
import { fetchTmdbShowEpisodes } from './tmdb.js'
import { cacheSelectedBanner, ensureSeriesBanners, BANNERS_DIR, EXT_BY_TYPE } from './banners.js'
import { AVATARS_DIR } from './avatars.js'
import { flowRouter, runFlowAndRecord, acquireFlowLock, releaseFlowLock, fireEvent } from './flowRoutes.js'
import type { FlowItem } from './flowNodes.js'
import { pruneWorkDir, assertScratchVolumeSafe } from './flowNodes.js'
import { startScheduler } from './scheduler.js'
import type { FlowGraph } from './flowExecutor.js'
import { discordPresenceRouter } from './discordPresence.js'
import { fetchAniListMedia } from './anilist.js'
import {
  warmScope, ensureScope, getPlayableIds,
  jfVirtualFolders, sectionCollections, enabledSections, type JfVirtualFolder,
} from './jellyfin.js'
import { getSeriesLibraryMedia, getSeriesDownloadStatus } from './downloads.js'
import { buildSeriesChase, buildSeriesListChases } from './chaseContext.js'
import {
  sourcingLedger,
  sourcingBackfill,
  sourcingReconcile,
  sourcingSweep,
  retryExhaustedTorrent,
  wantAction,
} from './sourcing.js'
import { qbitConfigured, qbitDelete } from './qbit.js'
import { createIssue, githubConfigured } from './github.js'
import * as blacklist from './blacklist.js'
import { posthogProxy } from './posthogProxy.js'
import { posthogUiHostEffective } from './posthogConfig.js'
import { deleteUser, listAllUsers, setUserAdmin, isAdminViaEnv, isAdminForUserId } from './users.js'
import { cfgSafe } from './config.js'
import { sectionLibraryRoot } from './sections.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.disable('x-powered-by')
const PORT = parseInt(process.env.PORT ?? '3001')
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'
// The qBittorrent category the code-built research flow queues into. Saved flows
// carry their own category; this is for the one graph we construct in code, so a
// dev instance sharing qBit with prod doesn't queue into prod's category. Set
// qbitCategory()=anime-dev on staging; default 'anime' is prod-correct.
const qbitCategory = (): string => cfgSafe('qbitCategory()') || 'anime'
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
        // display_name / custom_avatar_url are the user's own profile-page overrides
        // (set directly on their Supabase user_metadata); they win over whatever the
        // OAuth provider supplied.
        const name = [meta.display_name, meta.full_name, meta.name, meta.user_name].find(
          (v): v is string => typeof v === 'string' && v.trim().length > 0,
        )
        res.locals.displayName = name?.trim() || String(res.locals.email).split('@')[0] || 'user'
        const avatar = meta.custom_avatar_url ?? meta.avatar_url ?? meta.picture
        res.locals.avatarUrl = typeof avatar === 'string' && avatar ? avatar : null
        // Admin = ADMIN_EMAILS super-admin allowlist or a row in the Postgres
        // admin_users table (the /manage/Users toggle writes there).
        const isAdmin = await isAdminForUserId(String(user.id), String(res.locals.email))
        res.locals.isAdmin = isAdmin
        // Keep the comment-author cache current so public reads show the latest
        // name/avatar/admin badge without a Supabase round-trip.
        try {
          seriesDb.upsertUserProfile({
            user_id: String(res.locals.username),
            display_name: String(res.locals.displayName),
            avatar_url: (res.locals.avatarUrl as string | null) ?? null,
            is_admin: isAdmin,
          })
        } catch (e) {
          console.error('user_profiles upsert failed', e)
        }
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
    // Legacy JWT login has no Supabase user id, so only the env allowlist applies.
    res.locals.isAdmin = isAdminViaEnv(String(res.locals.email))
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

function requireAdmin(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!res.locals.isAdmin) {
    res.status(403).json({ error: 'Admin only' })
    return
  }
  next()
}

/**
 * Resolve `:id` as an **anime** catalog row, answering the request itself when
 * it isn't one.
 *
 * A large part of the catalog API is anime-specific — MAL detail, episode
 * caches, season mapping, torrent sourcing, blacklists — because it reasons
 * about a MAL id the row may not have. Now that the catalog also holds TV and
 * movie titles, those routes need an answer for "right id, wrong kind of
 * title" that isn't a 500 on a null mal_id. 409 says the request was
 * well-formed but doesn't apply to this resource, which is exactly the case.
 *
 * Returns null when it has already responded; callers just `return`.
 */
function animeSeriesOr(
  res: express.Response,
  id: number,
  what: string,
): seriesDb.AnimeSeriesRow | null {
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return null
  }
  const row = seriesDb.getSeriesById(id)
  if (!row) {
    res.status(404).json({ error: 'Series not found' })
    return null
  }
  if (!seriesDb.isAnimeSeries(row)) {
    res.status(409).json({
      error: `${what} is only available for anime titles — "${row.title}" is in the ${row.section} section`,
      section: row.section,
    })
    return null
  }
  return row
}

// Flow editor + scheduler APIs (admin-only: flows run external fetches + portal
// writes). Both are served by flowRouter; the gates cover their path prefixes.
app.use('/api/flows', requireAuth, requireAdmin)
app.use('/api/schedules', requireAuth, requireAdmin)
app.use(flowRouter)

// --- App configuration (/manage/settings) --------------------------------
// Admin-only: these are the app's credentials and paths. Secret *values* never
// leave the server — listConfig() omits them entirely rather than masking, so
// there is no code path here that can serialise one.

app.get('/api/config', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    config: listConfig(),
    /** Without this, secrets can be read but not written — the UI says so. */
    configKeyConfigured: configKeyConfigured(),
  })
})

app.put('/api/config/:key', requireAuth, requireAdmin, (req, res) => {
  const key = String(req.params.key)
  if (!isKnownConfigKey(key)) {
    // Refuse unknown keys rather than storing them: a typo'd key would sit in
    // the table forever, read by nothing, looking like it had taken effect.
    res.status(400).json({ error: `Unknown setting: ${key}` })
    return
  }
  const raw = (req.body as { value?: unknown })?.value
  if (typeof raw !== 'string') {
    res.status(400).json({ error: 'value must be a string' })
    return
  }
  try {
    setConfig(key, raw, String(res.locals.email || res.locals.username || 'admin'))
  } catch (e) {
    // The common case is a missing CONFIG_KEY on a secret — that message names
    // the variable and says how to generate one, so pass it through verbatim.
    res.status(400).json({ error: e instanceof Error ? e.message : 'Could not save setting' })
    return
  }
  res.json({ config: listConfig().find((c) => c.key === key) ?? null })
})

app.delete('/api/config/:key', requireAuth, requireAdmin, (req, res) => {
  const key = String(req.params.key)
  if (!isKnownConfigKey(key)) {
    res.status(400).json({ error: `Unknown setting: ${key}` })
    return
  }
  clearConfig(key)
  res.json({ config: listConfig().find((c) => c.key === key) ?? null })
})

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
    // Comment reads join user_profiles; keep the admin badge current even if
    // the target hasn't authenticated since the toggle.
    try { seriesDb.setUserProfileAdmin(id, isAdmin) } catch { /* no cached row yet */ }
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
  res.json({
    username: res.locals.username as string,
    email: res.locals.email as string,
    isAdmin: Boolean(res.locals.isAdmin),
  })
})

// Custom profile-picture upload (raw image bytes; content-type sets the extension).
// Mirrors the season-art upload below. The client sets user_metadata.custom_avatar_url
// itself (via supabase.auth.updateUser, its own field to write) after this returns
// the file's URL — this endpoint only owns storage.
app.post(
  '/api/profile/avatar',
  requireAuth,
  express.raw({ type: Object.keys(EXT_BY_TYPE), limit: '5mb' }),
  (req, res) => {
    const userId = String(res.locals.username).replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = EXT_BY_TYPE[String(req.headers['content-type'] ?? '').split(';')[0].trim()]
    const body = req.body as Buffer
    if (!ext || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Send raw image bytes (jpeg/png/webp/avif/gif)' })
      return
    }
    fs.mkdirSync(AVATARS_DIR, { recursive: true })
    for (const existing of fs.readdirSync(AVATARS_DIR)) {
      if (existing.startsWith(`${userId}-`)) {
        try { fs.unlinkSync(path.join(AVATARS_DIR, existing)) } catch { /* already gone */ }
      }
    }
    const file = `${userId}-${Date.now()}.${ext}`
    fs.writeFileSync(path.join(AVATARS_DIR, file), body)
    res.status(201).json({ avatarUrl: `/api/avatar/${file}` })
  },
)

// Remove the uploaded file. The client also clears user_metadata.custom_avatar_url
// so the OAuth-provided picture (if any) reappears.
app.delete('/api/profile/avatar', requireAuth, (req, res) => {
  const userId = String(res.locals.username).replace(/[^a-zA-Z0-9_-]/g, '_')
  try {
    for (const existing of fs.readdirSync(AVATARS_DIR)) {
      if (existing.startsWith(`${userId}-`)) fs.unlinkSync(path.join(AVATARS_DIR, existing))
    }
  } catch { /* dir doesn't exist yet */ }
  res.json({ ok: true })
})

/** `?section=` for the manage APIs. Defaults to anime — the only section that
 *  existed when these routes were written, so an old client keeps its meaning. */
function reqSection(req: express.Request): PortalSection {
  const s = String(req.query.section ?? '')
  return isPortalSection(s) ? s : 'anime'
}

/**
 * The sections the manager can work with, and how each is wired.
 *
 * This is what lets /manage present libraries as real things rather than
 * hardcoding three tabs: the client reads the provider, the library root and
 * the counts from here instead of knowing them. `jellyfin` is best-effort —
 * a Jellyfin that's down or a key that can't read VirtualFolders costs you the
 * folder cross-check, not the page.
 */
app.get('/api/sections', requireAuth, async (_req, res) => {
  const counts = seriesDb.countSeriesBySection()
  const folders = await jfVirtualFolders()

  /**
   * Which Jellyfin library a section's files land in, and how confident we are.
   *
   * Path is the only real evidence. Collection type is not: anime and tv are
   * both `tvshows`, so type alone hands them the same folder and the panel
   * states something untrue with total confidence.
   *
   * So the match is reported *with its basis*:
   *  - `path`  — a library's own Locations contain our configured root. Certain.
   *  - `type`  — the root is unset, but exactly one library has this type, so
   *              it is the only candidate. A reasonable guess, labelled as one.
   *  - `null`  — a root IS configured and no library lives there. This is the
   *              answer that earns its keep: it is how the operator learns the
   *              TV library doesn't exist yet, or that LIBRARY_DIR_TV points
   *              somewhere Jellyfin isn't looking. Never paper over it with a
   *              type guess — that is the bug this replaced.
   */
  const matchFolder = (
    root: string,
    collectionType: string,
  ): { folder: JfVirtualFolder | null; basis: 'path' | 'type' | null } => {
    if (!folders) return { folder: null, basis: null }
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (root) {
      const r = norm(root)
      const byPath = folders.find((f) => (f.Locations ?? []).some((l) => norm(l) === r))
      return { folder: byPath ?? null, basis: byPath ? 'path' : null }
    }
    const sameType = folders.filter((f) => f.CollectionType === collectionType)
    return sameType.length === 1 ? { folder: sameType[0], basis: 'type' } : { folder: null, basis: null }
  }

  res.json({
    sections: sectionConfigs().map((c) => ({
      section: c.section,
      label: c.label,
      provider: c.provider,
      providerConfigured: clientForSection(c.section).configured,
      providerUnavailableReason: clientForSection(c.section).unconfiguredReason,
      libraryRoot: c.libraryRoot,
      pathTemplate: c.pathTemplate,
      collectionType: c.collectionType,
      collectionId: sectionCollections().find((s) => s.section === c.section)?.collectionId ?? null,
      /** Configured on the portal side — an unconfigured section is manageable but not browsable. */
      portalEnabled: enabledSections().includes(c.section),
      count: counts[c.section] ?? 0,
      ...(() => {
        const { folder, basis } = matchFolder(c.libraryRoot, c.collectionType)
        return {
          jellyfin: folder,
          /** 'path' = certain, 'type' = single-candidate guess, null = no library at this root. */
          jellyfinMatch: basis,
        }
      })(),
    })),
    jellyfinReachable: folders !== null,
  })
})

// Search the section's own metadata provider.
const searchHandler = (forceSection?: PortalSection) =>
  async (req: express.Request, res: express.Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  if (!q.trim()) {
    res.json({ results: [] })
    return
  }
  const section = forceSection ?? reqSection(req)
  const client = clientForSection(section)
  if (!client.configured) {
    // 503, not an empty list: "no results" and "no API key" look identical in
    // the UI otherwise, and the second is a thing the operator must fix.
    res.status(503).json({ error: client.unconfiguredReason })
    return
  }
  try {
    const hits = await client.search(section, q)
    // Tag each hit with whether it's already in our catalog so the add UI can
    // mark/skip owned titles. Keyed on the identity triple, not mal_id — TV and
    // movies share the tmdb namespace.
    res.json({
      results: hits.map((h) => ({
        ...h,
        inCatalog: !!seriesDb.findBySource(section, h.source, h.source_id),
      })),
    })
  } catch (e) {
    console.error(`search(${section}) failed —`, e)
    res.status(502).json({
      error: `${section === 'anime' ? 'Anime' : 'TMDB'} metadata lookup is temporarily unavailable — try again shortly`,
    })
  }
}

app.get('/api/search', requireAuth, searchHandler())
// Back-compat alias — the old path is anime-only by name, so it stays pinned
// to anime regardless of any ?section= a caller might bolt on.
app.get('/api/search/anime', requireAuth, searchHandler('anime'))

app.get('/api/series', requireAuth, async (_req, res) => {
  seriesDb.getDb()
  // ?section= scopes the list to one section; absent means the whole catalog.
  const sectionQ = String(_req.query.section ?? '')
  const series = seriesDb.listSeries(isPortalSection(sectionQ) ? sectionQ : undefined)
  try {
    // Chase chips are an anime-sourcing concept; TV/movie rows simply have none.
    const chases = await buildSeriesListChases(series.filter(seriesDb.isAnimeSeries))
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
  const row = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  // A TMDB-sourced title resolves through its own provider. The response keeps
  // the `mal`-shaped envelope the /manage detail page already reads — the page
  // renders titles, year, score, genres and studios, none of which are
  // MAL-specific — so one component serves every section.
  if (!seriesDb.isAnimeSeries(row)) {
    try {
      const d = await clientForSection(row.section).detail(row.section, row.source_id)
      try {
        seriesDb.updateSeriesMetadataById(row.id, d.metadata)
      } catch (persistErr) {
        console.error('detail: failed to persist TMDB metadata —', persistErr)
      }
      res.json({
        series: seriesDb.getSeriesById(row.id) ?? row,
        mal: {
          title: d.title,
          title_english: d.metadata.title_english,
          title_japanese: d.metadata.title_japanese,
          synopsis: d.synopsis,
          type: d.type,
          episodes: d.episodes,
          status: d.status,
          score: d.metadata.score,
          year: d.year,
          season: null,
          aired: null,
          broadcast: null,
          genres: JSON.parse(d.metadata.genres ?? '[]').map((name: string) => ({ name })),
          studios: JSON.parse(d.metadata.studios ?? '[]').map((name: string) => ({ name })),
          images: d.image_url
            ? {
                webp: { large_image_url: d.image_url, image_url: d.image_url },
                jpg: { large_image_url: d.image_url, image_url: d.image_url },
              }
            : undefined,
          url: d.url,
          source: null,
          duration: null,
          rating: null,
        },
      })
    } catch (e) {
      console.error(`detail(${row.section}/${row.source_id}) failed —`, e)
      res.json({ series: row, mal: null })
    }
    return
  }
  const series = row
  try {
    // AniList-primary (current, auth-free); MyAnimeList/Jikan only if AniList
    // can't answer. `mal` keeps the Jikan-ish shape the /manage UI reads.
    const al = await fetchAniListMedia(series.mal_id)
    const mal = al
      ? {
          title: al.title,
          title_english: al.titleEnglish,
          title_japanese: al.titleNative,
          synopsis: al.synopsis,
          type: al.type,
          episodes: al.totalEpisodes,
          status: al.status,
          score: al.score,
          season: al.season,
          year: al.year,
          aired: { string: al.airedString },
          broadcast: al.broadcast,
          genres: al.genres.map((name) => ({ name })),
          studios: al.studios.map((name) => ({ name })),
          images: al.coverImage
            ? {
                webp: { large_image_url: al.coverImage, image_url: al.coverImage },
                jpg: { large_image_url: al.coverImage, image_url: al.coverImage },
              }
            : undefined,
          url: series.url ?? `https://myanimelist.net/anime/${series.mal_id}`,
          // AniList carries no source/duration/rating — the UI hides them.
          source: null,
          duration: null,
          rating: null,
        }
      : await fetchAnimeFull(series.mal_id)
    // Persist episode count + weekly broadcast so chase can estimate next air
    // times when the next episode hasn't been listed yet.
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
    // Backstop the add-time enrich: any row still unmapped (add-time attempt
    // failed, or it predates that path) gets its season mapping resolved now, so
    // the episode/download matcher can disambiguate seasons. Gated on unmapped
    // (mapping_source == null) so we neither re-resolve every view nor clobber a
    // manual override. Best-effort — a dataset hiccup never breaks the detail.
    if (series.mapping_source == null) {
      try {
        await enrichSeasonMapping(series.mal_id)
      } catch (mapErr) {
        console.error('detail: season mapping enrich failed —', mapErr)
      }
    }
    res.json({ series: seriesDb.getSeriesById(series.id) ?? series, mal })
  } catch (e) {
    console.error(e)
    res.json({
      series,
      mal: null,
      malError: e instanceof Error ? e.message : 'Could not load catalog details',
    })
  }
})

app.get('/api/series/:id/episodes', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const row = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!row) {
    res.status(404).json({ error: 'Series not found' })
    return
  }

  // Movies have no episode list. TV is TMDB seasons; anime stays on AniList/MAL.
  if (row.section === 'movies') {
    res.json({
      episodes: [],
      pagination: { has_next_page: false, current_page: 1, last_visible_page: 1 },
      source: 'tmdb',
    })
    return
  }
  if (!seriesDb.isAnimeSeries(row)) {
    try {
      const eps = await fetchTmdbShowEpisodes(row.source_id)
      const rows = eps.map((e) => ({
        mal_id: null,
        season: e.season,
        url: `https://www.themoviedb.org/tv/${row.source_id}/season/${e.season}/episode/${e.episode}`,
        title: e.title ?? `Episode ${e.episode}`,
        title_pending: !e.title,
        aired: e.aired,
        filler: false,
        recap: false,
        episode: e.episode,
      }))
      res.json({
        episodes: rows,
        pagination: { has_next_page: false, current_page: 1, last_visible_page: 1 },
        source: 'tmdb',
      })
    } catch (e) {
      console.error(e)
      res.status(502).json({ error: e instanceof Error ? e.message : 'Could not load episodes' })
    }
    return
  }

  const series = row
  const malUrl = series.url ?? `https://myanimelist.net/anime/${series.mal_id}`
  // `series_episodes` is the single source of truth: existence + air dates come
  // from AniList (current, unlike MAL), titles from a multi-source merge (see
  // server/episodes.ts). Cache-first — one page, all episodes at once.
  const status = seriesDb.getSeriesStatus(series.mal_id)
  const finished =
    String(status?.air_status ?? '') === 'finished' || String(series.status ?? '') === 'Finished Airing'
  const total = status?.total_episodes ?? series.episodes ?? null
  try {
    const { episodes, source } = await getEpisodesForDisplay({
      mal_id: series.mal_id,
      finished,
      totalEpisodes: total,
    })
    const rows = episodes.map((e) => ({
      mal_id: series.mal_id,
      url: malUrl,
      title: e.title ?? `Episode ${e.number}`,
      // No source has published a real title yet — the `title` above is the
      // placeholder, not a name anyone wrote.
      title_pending: e.titlePending,
      aired: e.aired,
      filler: false,
      recap: false,
      episode: e.number,
    }))
    res.json({
      episodes: rows,
      pagination: { has_next_page: false, current_page: 1, last_visible_page: 1 },
      source,
    })
  } catch (e) {
    // Every upstream failed: serve whatever the cache holds, else synthesize
    // 1..N from the known count so the per-episode library/download status is
    // still visible.
    console.error(e)
    const cached = seriesDb.getCachedEpisodes(series.mal_id)
    const rows =
      cached.length > 0
        ? cached.map((c) => {
            const proper = isProperTitle(c.title, c.title_source)
            return {
              mal_id: series.mal_id,
              url: malUrl,
              title: proper ? (c.title as string) : `Episode ${c.number}`,
              title_pending: !proper,
              aired: c.aired ?? null,
              filler: false,
              recap: false,
              episode: c.number,
            }
          })
        : total && total > 0
          ? Array.from({ length: total }, (_, i) => ({
              mal_id: series.mal_id,
              url: malUrl,
              title: `Episode ${i + 1}`,
              title_pending: true,
              aired: null,
              filler: false,
              recap: false,
              episode: i + 1,
            }))
          : []
    if (rows.length === 0) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'Could not load episodes' })
      return
    }
    res.json({
      episodes: rows,
      pagination: { has_next_page: false, current_page: 1, last_visible_page: 1 },
      source: cached.length > 0 ? 'cache' : 'synthesized',
    })
  }
})

app.post('/api/series', requireAuth, async (req, res) => {
  const body = req.body as {
    mal_id?: unknown
    /** TMDB titles identify by (section, source_id); anime may still send mal_id alone. */
    source_id?: unknown
    section?: unknown
    title?: unknown
    synopsis?: unknown
    image_url?: unknown
    url?: unknown
  }
  const section: PortalSection = isPortalSection(String(body.section ?? ''))
    ? (String(body.section) as PortalSection)
    : 'anime'
  const provider = sectionProvider(section)
  // An anime add historically sent only mal_id, and that is still its identity.
  const rawId = body.source_id ?? body.mal_id
  const source_id = typeof rawId === 'number' ? rawId : Number(rawId)
  const mal_id = provider === 'mal' ? source_id : null
  const str = (v: unknown): string | null =>
    typeof v === 'string' ? v : v == null ? null : String(v)
  let title = typeof body.title === 'string' ? body.title : ''
  let synopsis = str(body.synopsis)
  let image_url = str(body.image_url)
  let url = str(body.url)
  let imdb_id: string | null = null

  if (!Number.isFinite(source_id)) {
    res.status(400).json({ error: `A ${provider} id is required to add a ${section} title` })
    return
  }
  if (seriesDb.findBySource(section, provider, source_id)) {
    res.status(409).json({ error: 'Already in your list' })
    return
  }

  // The add UI posts what the search hit showed, but a caller with only an id
  // is legitimate (and TMDB search carries no imdb_id), so fill the gaps from
  // the provider. Best-effort for anime — that path has always accepted a
  // client-supplied title — but required for TMDB, where a row with no title
  // is useless and the failure should be visible now rather than as a blank
  // card later.
  if (!title || provider === 'tmdb') {
    try {
      const d = await clientForSection(section).detail(section, source_id)
      title = title || d.title
      synopsis = synopsis ?? d.synopsis
      image_url = image_url ?? d.image_url
      url = url ?? d.url
      imdb_id = d.imdb_id
    } catch (e) {
      console.error(`add(${section}/${source_id}): provider lookup failed —`, e)
      if (!title) {
        res.status(502).json({
          error: e instanceof Error ? e.message : 'Could not look that title up',
        })
        return
      }
    }
  }
  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }

  try {
    const row = seriesDb.insertSeries({
      mal_id,
      section,
      source: provider,
      source_id,
      imdb_id,
      title,
      synopsis,
      image_url,
      url,
    })
    // Populate the multi-season placement mapping (tvdb_season/episode_offset)
    // for this newly-added row. Without it, a cour in a multi-season franchise
    // has no season to disambiguate on, so the download/episode matcher keys
    // site episodes by bare IndexNumber — which collides across seasons and
    // links an episode to the wrong Jellyfin season (e.g. a S2 cour's Ep 3
    // resolving to S3E3). Best-effort + non-blocking: the dataset fetch can be
    // slow on a cold cache, and a hiccup must never fail the add. The detail
    // route re-attempts this for any row left unmapped. Anime only — the
    // dataset maps MAL cours onto TVDB seasons, and a TV show has no cours to
    // map (its TMDB seasons already are the library's seasons).
    if (mal_id != null) {
      void enrichSeasonMapping(mal_id).catch((mapErr) => {
        console.error('add: season mapping enrich failed —', mapErr)
      })
    }
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
  // Season mapping exists to place MAL cours into TVDB seasons — there is no
  // cour problem to solve for a TV show or a film.
  const series = animeSeriesOr(res, Number(req.params.id), 'Season mapping')
  if (!series) return
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
    res.json({ series: seriesDb.getSeriesById(series.id) })
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
  const row = seriesDb.getSeriesById(id)
  if (!row) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  try {
    // Chase chips are the anime sourcing pipeline (MAL air dates, wants). TV
    // and movies still need live qBit + on-site status for the Downloads panel.
    if (!seriesDb.isAnimeSeries(row)) {
      const status = await getSeriesDownloadStatus(id)
      res.json({
        qbitConfigured: status.qbitConfigured,
        qbitError: status.qbitError,
        torrents: status.torrents,
        siteEpisodes: status.siteEpisodes,
        qbitSkipped: status.qbitSkipped,
        blacklist: blacklist.listBlacklist(id),
        airedCount: 0,
        expectedForPipeline: null,
        nextChase: null,
        portalSeriesId: status.portalSeriesId,
      })
      return
    }
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
  const root = sectionLibraryRoot('anime')
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

// Sourcing reconciliation: the torrent-lifecycle side of tracking (the route
// above answers "disk vs library_files"; these answer "qBittorrent vs the
// torrent ledger vs wants"). Report is read-only; backfill/reconcile default
// to dry-run and only write when {dryRun:false} is explicit.
app.get('/api/sourcing/ledger', requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await sourcingLedger())
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Ledger report failed' })
  }
})

app.get('/api/sourcing/wants', requireAuth, requireAdmin, (req, res) => {
  const raw = typeof req.query.status === 'string' ? req.query.status : undefined
  const status =
    raw === 'open' || raw === 'sourced' || raw === 'fulfilled' || raw === 'abandoned' ? raw : undefined
  res.json({ wants: seriesDb.listWants(status) })
})

app.post('/api/sourcing/backfill', requireAuth, requireAdmin, async (req, res) => {
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  try {
    res.json(await sourcingBackfill(dryRun))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Backfill failed' })
  }
})

app.post('/api/sourcing/reconcile', requireAuth, requireAdmin, async (req, res) => {
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  try {
    res.json(await sourcingReconcile(dryRun))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Reconcile failed' })
  }
})

// Open wants for aired-but-untracked episodes of airing shows. The scheduler
// runs this every 15 min; the route is the on-demand handle (and the dry run is
// how you see what the sweep would do before it does it).
app.post('/api/sourcing/sweep', requireAuth, requireAdmin, async (req, res) => {
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun !== false
  try {
    res.json(await sourcingSweep(dryRun))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e instanceof Error ? e.message : 'Sweep failed' })
  }
})

// Put an `exhausted` torrent back in front of the import flow. See
// retryExhaustedTorrent — this is the only way to reconsider a fully-downloaded
// torrent whose files were all skipped, once the cause of the skip is fixed.
app.post('/api/sourcing/torrents/:hash/retry', requireAuth, requireAdmin, (req, res) => {
  const r = retryExhaustedTorrent(String(req.params.hash))
  res.status(r.ok ? 200 : 409).json(r)
})

// Admin action on one want (the chase panel's "retry now" / "abandon").
app.post('/api/series/:id/wants/:wantId', requireAuth, requireAdmin, (req, res) => {
  const wantId = Number(req.params.wantId)
  const action = (req.body as { action?: unknown } | undefined)?.action
  if (!Number.isFinite(wantId) || (action !== 'retry-now' && action !== 'abandon' && action !== 'reopen')) {
    res.status(400).json({ error: 'action must be retry-now | abandon | reopen' })
    return
  }
  const want = wantAction(wantId, action)
  if (!want) {
    res.status(404).json({ error: 'Want not found' })
    return
  }
  res.json({ want })
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
      { id: 'tor', type: 'enrich.torrent-search', position: { x: 1040, y: 0 }, config: { provider: 'tsukihime', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, maxResolution: '1080p', preferDualAudio: true, requireDualAudio: false, excludeCodecs: 'av1', minSeeders: 0, minTitleMatch: 0.4, maxEpisodes: 26, maxItems: 0 } },
      { id: 'qb', type: 'sink.qbittorrent', position: { x: 1300, y: 0 }, config: { urlField: 'torrent_magnet', category: qbitCategory(), savepath: '', paused: false } },
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

// Re-fire the `new-item` trigger for one series — the same event the scheduler
// emits when a title is first added. Re-runs the "Show added" flow on this
// series (resolve airing status, mint wants for aired-but-missing episodes,
// chain into chase-wants), using each flow's own qBit category — so unlike the
// legacy /research route it stays env-isolated. Fire-and-forget: the flow chain
// runs in the background and shows up in the Activity tab.
app.post('/api/series/:id/retrigger', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const series = Number.isFinite(id) ? seriesDb.getSeriesById(id) : undefined
  if (!series) {
    res.status(404).json({ error: 'Series not found' })
    return
  }
  void fireEvent('new-item', [series as unknown as FlowItem]).catch((e) =>
    console.error(`retrigger new-item for series ${id} failed —`, e),
  )
  res.json({ ok: true })
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

// ---------------------------------------------------------------------------
// Season titles — the admin-authored season line on the portal title page
// ("Season 1 Part 2", "Diamond is Unbreakable"). Stored per (JF series id, JF
// season); these routes are keyed by catalog id to match the rest of /manage,
// and resolve the JF series through the portal's own franchise anchoring.
// ---------------------------------------------------------------------------

/** The season rows for a catalog series' JF show, override included. */
function seasonTitleView(malId: number) {
  const pItem = portalSeriesForCatalog(malId)
  if (!pItem) return { seriesId: null, seriesName: null, seasons: [] }
  const years = getPortalSeasonYears(pItem.id)
  const titles = getPortalSeasonTitles(pItem.id)
  return {
    seriesId: pItem.id,
    seriesName: pItem.name,
    seasons: getPortalSeasonCounts(pItem.id).map((c) => ({
      season: c.season,
      episodes: c.episodes,
      year: years.get(c.season) ?? null,
      displayTitle: titles.get(c.season) ?? null,
    })),
  }
}

app.get('/api/series/:id/season-titles', requireAuth, (req, res) => {
  const series = animeSeriesOr(res, Number(req.params.id), 'Season titles')
  if (!series) return
  res.json(seasonTitleView(series.mal_id))
})

// Set or clear one season's override. A blank/absent displayTitle clears it —
// the portal then falls back to its own generic default.
app.put('/api/series/:id/season-titles/:season', requireAuth, requireAdmin, (req, res) => {
  const series = animeSeriesOr(res, Number(req.params.id), 'Season titles')
  if (!series) return
  const season = Number(req.params.season)
  if (!Number.isInteger(season)) { res.status(400).json({ error: 'Invalid season' }); return }
  const pItem = portalSeriesForCatalog(series.mal_id)
  if (!pItem) { res.status(404).json({ error: 'No Public series for this catalog entry' }); return }
  if (!getPortalSeasonCounts(pItem.id).some((c) => c.season === season)) {
    res.status(400).json({ error: 'Unknown season for this series' })
    return
  }
  const raw = (req.body as { displayTitle?: unknown })?.displayTitle
  if (raw != null && typeof raw !== 'string') {
    res.status(400).json({ error: 'displayTitle must be a string or null' })
    return
  }
  setPortalSeasonTitle(pItem.id, season, raw ?? null)
  res.json(seasonTitleView(series.mal_id))
})

// List candidates of one kind (gathering them from remote sources on first view).
app.get('/api/series/:id/banners', requireAuth, async (req, res) => {
  const series = animeSeriesOr(res, Number(req.params.id), 'Season art')
  if (!series) return
  try { await ensureSeriesBanners(series.mal_id) } catch (e) { console.error('art gather failed', e) }
  res.json({ banners: seriesDb.listBanners(series.mal_id, artKind(req)).map(bannerView) })
})

// Choose which candidate the portal serves. The kind comes from the row itself.
app.post('/api/series/:id/banners/select', requireAuth, requireAdmin, async (req, res) => {
  const series = animeSeriesOr(res, Number(req.params.id), 'Season art')
  if (!series) return
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
    const series = animeSeriesOr(res, Number(req.params.id), 'Season art')
    if (!series) return
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
  const series = animeSeriesOr(res, Number(req.params.id), 'Season art')
  if (!series) return
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

// --- Suggestions ------------------------------------------------------------
// Submitting opens a **GitHub issue** (via the App bot), not a DB row: prod and
// staging each had their own suggestions table, so the boards drifted and
// engineering work got mixed in with user requests. GitHub is now the single
// tracker, and an issue links to the PR that fixes it. The GET/PATCH/DELETE
// routes below still serve the pre-migration rows as a read-only archive.

const SUGGESTION_MAX = 2000
const TITLE_MAX = 72

// Each submission becomes a real, notification-generating GitHub issue, so one
// user must not be able to flood the tracker. In-memory is enough: single pod,
// and the map is bounded by the (small) user count. The clock starts only when
// an issue is actually filed — a failed attempt doesn't lock the user out.
const SUGGESTION_COOLDOWN_MS = 60_000
const lastSuggestionAt = new Map<string, number>()

/** First line of the suggestion, trimmed to a sane issue title. */
function issueTitle(body: string): string {
  const first = body.split(/\r?\n/, 1)[0].trim() || body.trim()
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first
}

app.post('/api/suggestions', requireAuth, async (req, res) => {
  const payload = req.body as { body?: unknown, page?: unknown, replayUrl?: unknown } | undefined
  const body = String(payload?.body ?? '').trim()
  if (!body) {
    res.status(400).json({ error: 'Suggestion cannot be empty' })
    return
  }
  if (body.length > SUGGESTION_MAX) {
    res.status(400).json({ error: `Suggestion is too long (max ${SUGGESTION_MAX} characters)` })
    return
  }
  const userKey = String(res.locals.username)
  const last = lastSuggestionAt.get(userKey) ?? 0
  if (Date.now() - last < SUGGESTION_COOLDOWN_MS) {
    res.status(429).json({ error: 'Please wait a minute between suggestions' })
    return
  }
  if (!githubConfigured()) {
    // Never pretend a suggestion was received when it wasn't.
    res.status(503).json({ error: 'Suggestions are temporarily unavailable' })
    return
  }

  // Context that makes a report actionable — page + session replay. Deliberately
  // no email: issues shouldn't carry user PII. Both fields are client-supplied,
  // so they get the same distrust as the display name below: `page` lands in a
  // code span (strip backticks/newlines), and the replay link is only trusted
  // when it points at our own PostHog UI host and can't break out of the
  // markdown link it's wrapped in.
  const page = typeof payload?.page === 'string'
    ? payload.page.replace(/[`\r\n]/g, '').slice(0, 300)
    : ''
  const replayUrl = typeof payload?.replayUrl === 'string'
    && payload.replayUrl.startsWith(`${posthogUiHostEffective()}/`)
    && payload.replayUrl.length <= 500
    && /^[\w\-.~:/?&=%#]+$/.test(payload.replayUrl)
    ? payload.replayUrl
    : ''
  // The display name is user-chosen, and it lands in a markdown document. Strip
  // the characters that would let it break out of the attribution line and forge
  // extra context (newlines, emphasis, links, @-mentions).
  const who = String(res.locals.displayName || 'a user')
    .replace(/[\r\n`*_[\]()@<>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'a user'

  const context = [
    '',
    '---',
    `_From **${who}** via the in-app suggestion button._`,
    page ? `_Page:_ \`${page}\`` : '',
    replayUrl ? `_[Session replay](${replayUrl})_` : '',
  ].filter(Boolean).join('\n')

  try {
    const issue = await createIssue({
      title: issueTitle(body),
      body: `${body}\n${context}\n`,
      labels: ['suggestion'],
    })
    lastSuggestionAt.set(userKey, Date.now())
    res.status(201).json({ issue })
  } catch (err) {
    console.error('suggestion -> GitHub issue failed:', err)
    res.status(502).json({ error: 'Could not file your suggestion. Please try again.' })
  }
})

app.get('/api/suggestions', requireAuth, requireAdmin, (_req, res) => {
  res.json({ suggestions: seriesDb.listSuggestions(), groups: seriesDb.listSuggestionGroups() })
})

// A parsed optional field: invalid input (ok:false), key absent / leave
// unchanged (set:false), or a concrete value to write (set:true).
type Field<T> = { ok: false } | { ok: true; set: false } | { ok: true; set: true; value: T }

// Optional string field: accept a string (trimmed, empty ⇒ null to clear) or an
// explicit null. `undefined` (key absent) means "leave unchanged".
function readNullableText(v: unknown, max: number): Field<string | null> {
  if (v === undefined) return { ok: true, set: false }
  if (v === null) return { ok: true, set: true, value: null }
  if (typeof v !== 'string' || v.length > max) return { ok: false }
  const t = v.trim()
  return { ok: true, set: true, value: t === '' ? null : t }
}

// Optional id reference: a positive integer, or null to clear. `undefined` ⇒ leave.
function readNullableRef(v: unknown): Field<number | null> {
  if (v === undefined) return { ok: true, set: false }
  if (v === null) return { ok: true, set: true, value: null }
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) return { ok: false }
  return { ok: true, set: true, value: n }
}

app.patch('/api/suggestions/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: seriesDb.SuggestionPatch = {}

  if (b.status !== undefined) {
    if (
      typeof b.status !== 'string' ||
      !seriesDb.SUGGESTION_STATUSES.includes(b.status as seriesDb.SuggestionStatus)
    ) {
      res.status(400).json({ error: `status must be one of: ${seriesDb.SUGGESTION_STATUSES.join(', ')}` })
      return
    }
    patch.status = b.status as seriesDb.SuggestionStatus
  }

  const title = readNullableText(b.title, 200)
  if (!title.ok) {
    res.status(400).json({ error: 'title must be a string (max 200 chars) or null' })
    return
  }
  if (title.set) patch.title = title.value

  const notes = readNullableText(b.notes, 5000)
  if (!notes.ok) {
    res.status(400).json({ error: 'notes must be a string (max 5000 chars) or null' })
    return
  }
  if (notes.set) patch.notes = notes.value

  const dup = readNullableRef(b.duplicate_of)
  if (!dup.ok) {
    res.status(400).json({ error: 'duplicate_of must be a positive integer or null' })
    return
  }
  if (dup.set) {
    if (dup.value === id) {
      res.status(400).json({ error: 'A suggestion cannot be a duplicate of itself' })
      return
    }
    if (dup.value !== null && !seriesDb.getSuggestion(dup.value)) {
      res.status(400).json({ error: `No suggestion #${dup.value} to duplicate` })
      return
    }
    patch.duplicate_of = dup.value
  }

  const group = readNullableRef(b.group_id)
  if (!group.ok) {
    res.status(400).json({ error: 'group_id must be a positive integer or null' })
    return
  }
  if (group.set) {
    if (group.value !== null && !seriesDb.getSuggestionGroup(group.value)) {
      res.status(400).json({ error: `No group #${group.value}` })
      return
    }
    patch.group_id = group.value
  }

  const row = seriesDb.updateSuggestion(id, patch)
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

// --- Suggestion groups (epics) — admin-only triage grouping ----------------

app.get('/api/suggestion-groups', requireAuth, requireAdmin, (_req, res) => {
  res.json({ groups: seriesDb.listSuggestionGroups() })
})

app.post('/api/suggestion-groups', requireAuth, requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const title = readNullableText(b.title, 200)
  if (!title.ok || !title.set || !title.value) {
    res.status(400).json({ error: 'title is required (max 200 chars)' })
    return
  }
  const description = readNullableText(b.description, 5000)
  if (!description.ok) {
    res.status(400).json({ error: 'description must be a string (max 5000 chars) or null' })
    return
  }
  const group = seriesDb.addSuggestionGroup(title.value, description.set ? description.value : null)
  res.status(201).json({ group })
})

app.patch('/api/suggestion-groups/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: { title?: string; description?: string | null } = {}
  if (b.title !== undefined) {
    const title = readNullableText(b.title, 200)
    if (!title.ok || !title.set || !title.value) {
      res.status(400).json({ error: 'title must be a non-empty string (max 200 chars)' })
      return
    }
    patch.title = title.value
  }
  const description = readNullableText(b.description, 5000)
  if (!description.ok) {
    res.status(400).json({ error: 'description must be a string (max 5000 chars) or null' })
    return
  }
  if (description.set) patch.description = description.value
  const group = seriesDb.updateSuggestionGroup(id, patch)
  if (!group) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json({ group })
})

app.delete('/api/suggestion-groups/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || !seriesDb.deleteSuggestionGroup(id)) {
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
  const isAdmin = Boolean(res.locals.isAdmin)
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
    POSTHOG_KEY: ${JSON.stringify(cfgSafe('POSTHOG_KEY'))},
    POSTHOG_UI_HOST: ${JSON.stringify(posthogUiHostEffective())}
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
  // Flow execution is gated so an environment can be management-only: prod is a
  // read-only portal + /manage surface (edit catalog/flows, view qBit status),
  // but the heavy flows (ffmpeg mux, sync FS) that block the event loop and fill
  // the disk run only on the executor (staging). Set SCHEDULER_ENABLED=false to
  // keep every API/UI working while never *running* flows. Default on.
  if (process.env.SCHEDULER_ENABLED === 'false') {
    console.log('Scheduler disabled (SCHEDULER_ENABLED=false) — flows are editable but will not execute here.')
  } else {
    // Fail loudly at boot if flow scratch would land on a volume too small to
    // hold the GB-sized intermediates — a forgotten WORK_DIR once filled the
    // node PVC and evicted prod. Only enforced where flows actually run.
    try {
      assertScratchVolumeSafe()
    } catch (err) {
      console.error('[work-guard] refusing to start:', err instanceof Error ? err.message : err)
      process.exit(1)
    }
    startScheduler()
  }
  // Keep DATA_DIR/work from growing unbounded (it once hit 16GB and evicted prod
  // off its node). Sweep on boot and every 6h; the pruner only removes scratch
  // untouched for WORK_TTL_HOURS, so an in-flight job is safe.
  try { pruneWorkDir() } catch (err) { console.warn('[work-prune] boot sweep failed:', err) }
  setInterval(() => {
    try { pruneWorkDir() } catch (err) { console.warn('[work-prune] periodic sweep failed:', err) }
  }, 6 * 3600_000).unref()
  console.log(`Server running on http://localhost:${PORT}`)
})
