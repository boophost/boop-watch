// Episode watch progress: per-account in Supabase (watch_progress, RLS-scoped
// to the user) when logged in, localStorage when not. The local store is always
// written too, so resume still works after logging out and pre-login history
// backfills the account on first login.
import { supabase } from './supabase'

export interface Progress { position: number; duration: number; watched: boolean }

const POS_PREFIX = 'bw:pos:'   // legacy resume key (seconds), still honoured
const WATCHED_KEY = 'bw:watched'
const PROG_KEY = 'bw:prog'     // id -> { p, d, w }

type LocalMap = Record<string, { p: number; d: number; w?: 1 }>

const readLocal = (): LocalMap => {
  try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}') } catch { return {} }
}
const writeLocal = (m: LocalMap) => {
  try { localStorage.setItem(PROG_KEY, JSON.stringify(m)) } catch { /* ignore */ }
}
const readLegacyWatched = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}') } catch { return {} }
}

/** The local progress entry for one item (legacy keys included). */
export function localProgress(id: string): Progress | null {
  const m = readLocal()[id]
  if (m) return { position: m.p, duration: m.d, watched: !!m.w }
  const pos = parseInt(localStorage.getItem(POS_PREFIX + id) || '', 10)
  const watched = !!readLegacyWatched()[id]
  if (!Number.isInteger(pos) && !watched) return null
  return { position: Number.isInteger(pos) ? pos : 0, duration: 0, watched }
}

export function saveLocalProgress(id: string, p: Progress) {
  const m = readLocal()
  m[id] = { p: Math.floor(p.position), d: Math.floor(p.duration), ...(p.watched ? { w: 1 as const } : {}) }
  writeLocal(m)
  // Keep the legacy keys coherent for older tabs/sessions.
  try {
    if (p.watched || p.position <= 5) localStorage.removeItem(POS_PREFIX + id)
    else localStorage.setItem(POS_PREFIX + id, String(Math.floor(p.position)))
    if (p.watched) {
      const w = readLegacyWatched()
      if (!w[id]) { w[id] = 1; localStorage.setItem(WATCHED_KEY, JSON.stringify(w)) }
    }
  } catch { /* ignore */ }
}

/** Progress for a set of items: account rows when logged in (local fills the
 * gaps), local only otherwise. */
export async function loadProgressMap(ids: string[], loggedIn: boolean): Promise<Record<string, Progress>> {
  const out: Record<string, Progress> = {}
  for (const id of ids) {
    const l = localProgress(id)
    if (l) out[id] = l
  }
  if (!loggedIn || !ids.length) return out
  try {
    const { data, error } = await supabase
      .from('watch_progress')
      .select('item_id, position, duration, watched')
      .in('item_id', ids)
    if (error) throw error
    for (const r of data || []) {
      out[r.item_id] = { position: r.position, duration: r.duration, watched: r.watched }
    }
  } catch { /* offline/unreachable: local view is still useful */ }
  return out
}

export interface RecentWatch extends Progress { id: string }

/** The account's most recently touched items, newest first. Rows barely started
 * (<5% in, never finished) are dropped — an accidental click isn't history. */
export async function recentlyWatched(limit = 24): Promise<RecentWatch[]> {
  try {
    const { data, error } = await supabase
      .from('watch_progress')
      .select('item_id, position, duration, watched')
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data || [])
      .map((r) => ({ id: r.item_id, position: r.position, duration: r.duration, watched: r.watched }))
      .filter((r) => r.watched || (r.duration > 0 && r.position / r.duration > 0.05))
  } catch {
    return []
  }
}

export async function saveAccountProgress(userId: string, id: string, p: Progress): Promise<void> {
  await supabase.from('watch_progress').upsert({
    user_id: userId,
    item_id: id,
    position: Math.floor(p.position),
    duration: Math.floor(p.duration),
    watched: p.watched,
    updated_at: new Date().toISOString(),
  })
}

const BACKFILL_KEY = 'bw:prog-backfilled'

/** One-time push of pre-login local history into a fresh account, so logging
 * in doesn't wipe the episode list's memory. Account rows win on conflict. */
export async function backfillAccountProgress(userId: string): Promise<void> {
  try {
    if (localStorage.getItem(BACKFILL_KEY) === userId) return
    const local = readLocal()
    const legacy = readLegacyWatched()
    const ids = new Set([...Object.keys(local), ...Object.keys(legacy)])
    for (const id of Object.keys(localStorage)) {
      if (id.startsWith(POS_PREFIX)) ids.add(id.slice(POS_PREFIX.length))
    }
    if (ids.size) {
      const { data } = await supabase.from('watch_progress').select('item_id').in('item_id', [...ids])
      const have = new Set((data || []).map((r) => r.item_id))
      const rows = [...ids].filter((id) => !have.has(id)).flatMap((id) => {
        const p = localProgress(id)
        if (!p) return []
        return [{
          user_id: userId, item_id: id,
          position: Math.floor(p.position), duration: Math.floor(p.duration), watched: p.watched,
        }]
      })
      if (rows.length) await supabase.from('watch_progress').upsert(rows, { ignoreDuplicates: true })
    }
    localStorage.setItem(BACKFILL_KEY, userId)
  } catch { /* retried next visit */ }
}
