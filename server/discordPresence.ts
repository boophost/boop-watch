// Discord "watch status" presence. Users opt in from the profile page via a
// first-party Discord OAuth flow (scope: identify + activities.write) — this is
// separate from the Supabase Discord *login* identity, because GoTrue neither
// requests activities.write nor persists provider refresh tokens. Tokens live
// server-side in series.sqlite; the Watch page heartbeats playback state and we
// mirror it to Discord as a "Watching …" activity through the headless-sessions
// REST API (no desktop client needed). Headless sessions expire after 20 min,
// so we re-post on a shorter cadence while beats keep arriving.
import express, { Router } from 'express'
import jwt from 'jsonwebtoken'
import { getDb } from './db.js'
import { getPortalItem } from './portalDb.js'

const DISCORD_API = 'https://discord.com/api/v10'
const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? ''
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'
// activities.write is the documented headless-sessions scope but is
// approval-gated for ordinary apps; sdk.social_layer_presence is the
// self-serve Social SDK equivalent. Overridable while we settle which one
// Discord accepts for this app.
const OAUTH_SCOPE = process.env.DISCORD_PRESENCE_SCOPE ?? 'identify sdk.social_layer_presence'

// Re-post the headless session when it's older than this (TTL is 20 min).
const SESSION_REFRESH_MS = 8 * 60_000
// Timestamp drift (seek/rate mismatch) beyond which we re-post early.
const DRIFT_MS = 15_000
// Clear the "Browsing the library" activity once the user has been browsing
// (no active player) continuously for this long — an opted-in user who leaves
// the tab open shouldn't show a stale watch status forever. Watching/paused
// reset it; only idle browsing counts down.
const BROWSING_IDLE_MS = Number(process.env.DISCORD_BROWSING_IDLE_MS) || 10 * 60_000

interface LinkRow {
  username: string
  discord_id: string
  discord_name: string | null
  access_token: string
  refresh_token: string
  expires_at: number
}

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS discord_presence (
      username TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      discord_name TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

function getLink(username: string): LinkRow | undefined {
  ensureTable()
  return getDb()
    .prepare('SELECT * FROM discord_presence WHERE username = ?')
    .get(username) as LinkRow | undefined
}

function deleteLink(username: string) {
  ensureTable()
  getDb().prepare('DELETE FROM discord_presence WHERE username = ?').run(username)
  sessions.delete(username)
  browsingSince.delete(username)
}

// One live headless session per user, tracked in memory only: after a restart
// the next beat simply creates a fresh session (the orphan expires on its own).
type PresenceKind = 'watching' | 'paused' | 'browsing'
interface LiveSession {
  token: string
  kind: PresenceKind
  itemId: string | null // the title being watched/paused; null while browsing
  endMs: number // predicted timestamps.end, for drift detection (watching only)
  postedAt: number
}
const sessions = new Map<string, LiveSession>()

// When the current continuous "browsing" spell began, per user. Set on the first
// browsing beat after any active (watching/paused) state; kept across the idle
// stop so we don't repost; cleared when the user becomes active again or stops.
const browsingSince = new Map<string, number>()

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse | null> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...params,
    }),
  })
  if (!res.ok) {
    console.error('discord token request failed', res.status, await res.text().catch(() => ''))
    return null
  }
  return (await res.json()) as TokenResponse
}

/** A usable access token for the row, refreshing (and persisting) if it's
 * near expiry. Returns null — and unlinks — when the grant is gone. */
async function freshAccessToken(row: LinkRow): Promise<string | null> {
  if (row.expires_at - 60_000 > Date.now()) return row.access_token
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  if (!tok) {
    deleteLink(row.username)
    return null
  }
  const expires_at = Date.now() + tok.expires_in * 1000
  getDb()
    .prepare('UPDATE discord_presence SET access_token = ?, refresh_token = ?, expires_at = ? WHERE username = ?')
    .run(tok.access_token, tok.refresh_token, expires_at, row.username)
  row.access_token = tok.access_token
  row.expires_at = expires_at
  return tok.access_token
}

interface Activity {
  type: 3 // Watching
  name: string
  details?: string
  state?: string // second line — "⏸ Paused", "Browsing the library", …
  timestamps?: { start: number; end: number }
  assets?: { large_image: string; large_text?: string }
  application_id: string
  platform: 'desktop'
}

async function postSession(access: string, activity: Activity, token?: string): Promise<string | null> {
  const res = await fetch(`${DISCORD_API}/users/@me/headless-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
    body: JSON.stringify(token ? { activities: [activity], token } : { activities: [activity] }),
  })
  if (!res.ok) {
    console.error('discord headless session failed', res.status, await res.text().catch(() => ''))
    return null
  }
  const body = (await res.json()) as { token?: string }
  return body.token ?? token ?? null
}

/** Post (or update in place) the user's live activity, throttled: we only hit
 * Discord when the state actually changes — a new kind (watching/paused/
 * browsing), a different title, playback drift, or the headless session nearing
 * its TTL. Reuses the existing session token so transitions don't flicker. */
async function syncSession(
  username: string,
  row: LinkRow,
  kind: PresenceKind,
  itemId: string | null,
  endMs: number,
  activity: Activity,
): Promise<{ linked: boolean; active: boolean }> {
  const now = Date.now()
  const live = sessions.get(username)
  const needsPost =
    !live ||
    live.kind !== kind ||
    live.itemId !== itemId ||
    now - live.postedAt >= SESSION_REFRESH_MS ||
    (kind === 'watching' && Math.abs(live.endMs - endMs) > DRIFT_MS)
  if (!needsPost) return { linked: true, active: true }

  const access = await freshAccessToken(row)
  if (!access) return { linked: false, active: false }
  const token = await postSession(access, activity, live?.token)
  if (!token) {
    sessions.delete(username)
    return { linked: true, active: false }
  }
  sessions.set(username, { token, kind, itemId, endMs, postedAt: now })
  return { linked: true, active: true }
}

// Tear down the live Discord headless session (clearing the on-profile activity)
// without touching the browsing-idle tracker.
async function killSession(username: string, row: LinkRow) {
  const live = sessions.get(username)
  sessions.delete(username)
  if (!live) return
  const access = await freshAccessToken(row)
  if (!access) return
  await fetch(`${DISCORD_API}/users/@me/headless-sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
    body: JSON.stringify({ token: live.token }),
  }).catch(() => {})
}

async function endSession(username: string, row: LinkRow) {
  browsingSince.delete(username)
  await killSession(username, row)
}

/** Public origin of the request, for OAuth redirect URIs and absolute poster
 * URLs in activity assets. The forwarded-proto header can't be trusted here:
 * TLS terminates at the Cloudflare edge and Traefik receives plain HTTP on the
 * `web` entrypoint, so it stamps X-Forwarded-Proto: http even though every
 * public host is https-only. Force https for anything that isn't local. */
function reqOrigin(req: express.Request): string {
  const fwdHost = req.headers['x-forwarded-host']
  const host = (typeof fwdHost === 'string' ? fwdHost.split(',')[0].trim() : '') || req.headers.host || ''
  const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(host)
  return `${isLocal ? req.protocol : 'https'}://${host}`
}

const redirectUri = (origin: string) => `${origin}/api/discord/callback`

type AuthedHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

export function discordPresenceRouter(requireAuth: AuthedHandler): Router {
  const router = Router()
  const configured = Boolean(CLIENT_ID && CLIENT_SECRET)

  router.get('/api/discord/presence', requireAuth, (_req, res) => {
    const row = configured ? getLink(res.locals.username as string) : undefined
    res.json({
      available: configured,
      linked: !!row,
      discord: row ? { id: row.discord_id, name: row.discord_name } : null,
    })
  })

  // Returns the Discord consent URL; the client navigates to it. state binds
  // the callback to the logged-in user (the callback itself arrives as a bare
  // browser redirect with no Authorization header).
  router.post('/api/discord/presence/authorize', requireAuth, (req, res) => {
    if (!configured) {
      res.status(503).json({ error: 'Discord integration is not configured' })
      return
    }
    const state = jwt.sign({ u: res.locals.username as string }, JWT_SECRET, { expiresIn: '10m' })
    const url =
      'https://discord.com/oauth2/authorize?' +
      new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri(reqOrigin(req)),
        scope: OAUTH_SCOPE,
        state,
      }).toString()
    res.json({ url })
  })

  router.get('/api/discord/callback', async (req, res) => {
    const back = (result: string) => res.redirect(`/profile?discord_presence=${result}`)
    const { code, state, error } = req.query
    if (error || typeof code !== 'string' || typeof state !== 'string') {
      console.error('discord oauth callback error', req.query)
      back(typeof error === 'string' && error ? encodeURIComponent(error) : 'denied')
      return
    }
    let username: string
    try {
      username = (jwt.verify(state, JWT_SECRET) as { u: string }).u
    } catch {
      back('expired')
      return
    }
    const tok = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(reqOrigin(req)),
    })
    if (!tok) {
      back('failed')
      return
    }
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })
    if (!meRes.ok) {
      back('failed')
      return
    }
    const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null }
    ensureTable()
    getDb()
      .prepare(`
        INSERT INTO discord_presence (username, discord_id, discord_name, access_token, refresh_token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          discord_id = excluded.discord_id,
          discord_name = excluded.discord_name,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at
      `)
      .run(
        username,
        me.id,
        me.global_name || me.username,
        tok.access_token,
        tok.refresh_token,
        Date.now() + tok.expires_in * 1000,
      )
    back('linked')
  })

  router.delete('/api/discord/presence', requireAuth, async (req, res) => {
    const username = res.locals.username as string
    const row = getLink(username)
    if (row) {
      await endSession(username, row)
      // Best-effort revoke so the grant doesn't linger in the user's
      // authorized apps after they turned the feature off.
      await fetch(`${DISCORD_API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          token: row.access_token,
          token_type_hint: 'access_token',
        }),
      }).catch(() => {})
      deleteLink(username)
    }
    res.json({ ok: true })
  })

  // Heartbeat from the portal. The Watch page sends playback beats (every ~30s
  // + on play/pause edges); the portal shell sends `browsing: true` while the
  // user is on the site but not in the player. The client sends these freely;
  // this end decides when Discord actually needs a new session post.
  router.post('/api/discord/presence/beat', requireAuth, async (req, res) => {
    const username = res.locals.username as string
    const row = configured ? getLink(username) : undefined
    if (!row) {
      res.json({ linked: false })
      return
    }
    const { itemId, position, duration, paused, browsing } = req.body as {
      itemId?: unknown
      position?: unknown
      duration?: unknown
      paused?: unknown
      browsing?: unknown
    }

    // Browsing the library (no active player). Idle out after a while so an
    // opted-in user who just left the tab open doesn't show a stale status.
    if (browsing) {
      const now = Date.now()
      const since = browsingSince.get(username) ?? now
      if (!browsingSince.has(username)) browsingSince.set(username, now)
      if (now - since >= BROWSING_IDLE_MS) {
        // Been browsing too long — clear the activity and stay quiet (the tracker
        // stays set, so further browsing beats keep it off) until they watch again.
        await killSession(username, row)
        res.json({ linked: true, active: false })
        return
      }
      const activity: Activity = {
        type: 3,
        name: 'boopurnoes · watch',
        state: 'Browsing the library',
        application_id: CLIENT_ID,
        platform: 'desktop',
      }
      res.json(await syncSession(username, row, 'browsing', null, 0, activity))
      return
    }
    // Any active player state below (watching/paused) ends the browsing spell.
    browsingSince.delete(username)

    if (typeof itemId !== 'string' || typeof position !== 'number' || typeof duration !== 'number') {
      res.status(400).json({ error: 'itemId, position, duration required' })
      return
    }
    const item = getPortalItem(itemId)
    if (!item || duration <= 0) {
      res.json({ linked: true, active: false })
      return
    }

    const isEpisode = item.type === 'Episode'
    const name = (isEpisode ? item.series_name : null) || item.name
    let details: string | undefined
    if (isEpisode) {
      const se =
        item.index_number != null
          ? `S${item.parent_index_number ?? 1}E${item.index_number}`
          : null
      details = [se, item.name].filter(Boolean).join(' · ') || undefined
    }
    const origin = reqOrigin(req)
    const assets = {
      large_image: `${origin}/img/${encodeURIComponent(item.series_id || item.id)}`,
      large_text: name,
    }

    // Paused: keep the title on the profile but drop the live countdown and
    // flag it, instead of clearing the activity outright.
    if (paused) {
      const activity: Activity = {
        type: 3,
        name,
        ...(details ? { details } : {}),
        state: '⏸ Paused',
        assets,
        application_id: CLIENT_ID,
        platform: 'desktop',
      }
      res.json(await syncSession(username, row, 'paused', itemId, 0, activity))
      return
    }

    const now = Date.now()
    const start = now - Math.floor(position * 1000)
    const end = start + Math.floor(duration * 1000)
    const activity: Activity = {
      type: 3,
      name,
      ...(details ? { details } : {}),
      timestamps: { start, end },
      assets,
      application_id: CLIENT_ID,
      platform: 'desktop',
    }
    res.json(await syncSession(username, row, 'watching', itemId, end, activity))
  })

  // Explicit stop (leaving the player). Fire-and-forget on the client.
  router.post('/api/discord/presence/stop', requireAuth, async (_req, res) => {
    const username = res.locals.username as string
    const row = getLink(username)
    if (row) await endSession(username, row)
    res.json({ ok: true })
  })

  return router
}
