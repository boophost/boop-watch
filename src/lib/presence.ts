// Client side of the Discord watch-status feature (server/discordPresence.ts):
// profile-page link management + playback heartbeats from the Watch page. The
// server owns all Discord API traffic; beats are cheap JSON posts it throttles.
import { fetchAuth } from './api'
import { supabase } from './supabase'

export interface PresenceStatus {
  available: boolean
  linked: boolean
  discord: { id: string; name: string | null } | null
}

export async function getPresenceStatus(): Promise<PresenceStatus> {
  const r = await fetchAuth('/api/discord/presence')
  if (!r.ok) throw new Error('failed to load Discord status')
  return (await r.json()) as PresenceStatus
}

/** Consent URL to navigate to; links Discord presence for the current user. */
export async function presenceAuthorizeUrl(): Promise<string> {
  const r = await fetchAuth('/api/discord/presence/authorize', { method: 'POST' })
  const body = (await r.json()) as { url?: string; error?: string }
  if (!r.ok || !body.url) throw new Error(body.error || 'failed to start Discord link')
  return body.url
}

export async function unlinkPresence(): Promise<void> {
  const r = await fetchAuth('/api/discord/presence', { method: 'DELETE' })
  if (!r.ok) throw new Error('failed to unlink Discord')
}

// The Watch page beats through here. Cache linked-ness per page load so
// non-linked users don't post on every tick; a beat answering linked:false
// turns the tap off until the next full reload (or re-link redirect).
let linkedCache: boolean | null = null

export async function presenceLinked(): Promise<boolean> {
  if (linkedCache === null) {
    try {
      linkedCache = (await getPresenceStatus()).linked
    } catch {
      linkedCache = false
    }
  }
  return linkedCache
}

export async function presenceBeat(
  itemId: string,
  position: number,
  duration: number,
  paused: boolean,
): Promise<void> {
  if (!(await presenceLinked())) return
  const r = await fetchAuth('/api/discord/presence/beat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, position, duration, paused }),
  })
  if (r.ok) {
    const body = (await r.json()) as { linked?: boolean }
    if (body.linked === false) linkedCache = false
  }
}

/** Clear the Discord activity when leaving the player. keepalive lets the
 * request survive pagehide/unmount navigation (sendBeacon can't carry the
 * Authorization header). */
export async function presenceStop(): Promise<void> {
  if (linkedCache !== true) return
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return
  fetch('/api/discord/presence/stop', {
    method: 'POST',
    keepalive: true,
    headers: { Authorization: `Bearer ${session.access_token}` },
  }).catch(() => {})
}
