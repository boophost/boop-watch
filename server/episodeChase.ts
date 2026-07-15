// Pure helpers for currently-airing catch-up + next-episode chase.
// Used by admin downloads/list APIs and public catalog/watch builders.

export type ChaseState = 'waiting' | 'searching' | 'downloading' | 'importing' | 'ready'

export interface EpisodeAirInfo {
  episode: number
  title?: string | null
  aired?: string | null
}

export interface EpisodeChase {
  episode: number
  title?: string | null
  airsAt: string | null
  state: ChaseState
  progress?: number | null
  /** Persisted want backing this state (absent when derived from live qBit only). */
  wantId?: number
  attempts?: number
  nextAttemptAt?: string | null
  note?: string | null
}

/** Minimal shapes of the persisted sourcing rows (server/db.ts), so this file
 * stays pure/import-free. */
export interface WantStateRow {
  id: number
  status: 'open' | 'sourced' | 'fulfilled' | 'abandoned'
  attempts: number
  next_attempt_at: string | null
  note: string | null
}
export interface TorrentStateRow {
  status: string
}

/**
 * Overlay the persisted want/ledger state onto a derived chase. The want is
 * the source of truth for *intent* (searching with N attempts vs silently
 * stuck); live qBit still owns download progress when we have it. A chase with
 * no want row passes through unchanged (pre-wants series).
 */
export function applyWantState(
  chase: EpisodeChase | null,
  want: WantStateRow | null,
  torrent: TorrentStateRow | null,
): EpisodeChase | null {
  if (!chase || !want) return chase
  const out: EpisodeChase = {
    ...chase,
    wantId: want.id,
    attempts: want.attempts,
    nextAttemptAt: want.next_attempt_at,
    note: want.note,
  }
  // Future episodes stay 'waiting' regardless of want bookkeeping.
  if (chase.state === 'waiting') return out
  if (want.status === 'open' || want.status === 'abandoned') {
    // Nothing sourced: honest state is searching (retrying on backoff), even
    // when a stale/unrelated torrent made the derived state look busier.
    return { ...out, state: 'searching', progress: null }
  }
  if (want.status === 'sourced') {
    if (torrent && (torrent.status === 'completed' || torrent.status === 'imported')) {
      return { ...out, state: 'importing' }
    }
    if (torrent && torrent.status === 'exhausted') {
      // Its torrent turned out to contain nothing importable — the reconciler
      // will reopen it; show the truth meanwhile.
      return { ...out, state: 'searching', progress: null }
    }
    // queued/downloading — keep live progress when the derived pass had it.
    return { ...out, state: 'downloading' }
  }
  // fulfilled: the file is placed; if the portal hasn't caught up it's importing.
  return { ...out, state: chase.state === 'ready' ? 'ready' : 'importing' }
}

export interface ChaseTorrent {
  episode: number | null
  progress: number
  isBatch?: boolean
}

/** MAL broadcast block (from Jikan `/anime/{id}/full`). */
export interface MalBroadcast {
  day?: string | null
  time?: string | null
  timezone?: string | null
  string?: string | null
}

const WEEKDAY: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

function parseBroadcastDay(day: string | null | undefined): number | null {
  if (!day) return null
  const key = day.toLowerCase().replace(/s$/, '') // Fridays → friday
  return WEEKDAY[key] ?? null
}

function parseBroadcastTime(time: string | null | undefined): { hh: number; mm: number } | null {
  if (!time) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return { hh, mm }
}

function zonedParts(ms: number, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number; wd: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  const wdName = (map.weekday || '').toLowerCase().slice(0, 3)
  const wdLookup: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour),
    mm: Number(map.minute),
    wd: wdLookup[wdName] ?? 0,
  }
}

/** Convert a civil datetime in `timeZone` to a UTC epoch ms. */
export function zonedLocalToUtcMs(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): number {
  let utc = Date.UTC(y, m - 1, d, hh, mm, 0)
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(utc, timeZone)
    const asLocal = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
    const desired = Date.UTC(y, m - 1, d, hh, mm)
    const delta = desired - asLocal
    if (delta === 0) break
    utc += delta
  }
  return utc
}

/**
 * Estimate when `nextEpisode` airs from MAL weekly broadcast + last known aired ep.
 * Returns an ISO string, or null when broadcast/anchor data is insufficient.
 */
export function estimateNextAir(args: {
  nextEpisode: number
  episodes: EpisodeAirInfo[]
  broadcast?: MalBroadcast | null
  now?: number
}): string | null {
  const bc = args.broadcast
  if (!bc) return null
  const wd = parseBroadcastDay(bc.day)
  const tm = parseBroadcastTime(bc.time)
  if (wd == null || !tm) return null
  const timeZone = (bc.timezone && bc.timezone.trim()) || 'Asia/Tokyo'

  const dated = args.episodes
    .filter((e) => e.aired && Number.isFinite(Date.parse(e.aired!)) && e.episode < args.nextEpisode)
    .sort((a, b) => b.episode - a.episode)
  const anchor = dated[0]
  if (!anchor?.aired) return null

  const anchorMs = Date.parse(anchor.aired)
  const weeksAhead = args.nextEpisode - anchor.episode
  if (weeksAhead < 1) return null

  // Prefer the broadcast wall-clock on the anchor's calendar day in the show's TZ
  // (MAL episode dates are often midnight UTC / date-only).
  const ap = zonedParts(anchorMs, timeZone)
  let y = ap.y
  let m = ap.m
  let d = ap.d
  // Snap to the broadcast weekday if the stored date drifted (rare).
  const probe = zonedLocalToUtcMs(y, m, d, tm.hh, tm.mm, timeZone)
  const probeWd = zonedParts(probe, timeZone).wd
  if (probeWd !== wd) {
    const delta = (wd - probeWd + 7) % 7
    const snapped = new Date(probe + delta * 86_400_000)
    const sp = zonedParts(snapped.getTime(), timeZone)
    y = sp.y
    m = sp.m
    d = sp.d
  }

  const base = zonedLocalToUtcMs(y, m, d, tm.hh, tm.mm, timeZone)
  const estimated = base + weeksAhead * 7 * 86_400_000
  return new Date(estimated).toISOString()
}

/** Catch-up denominator: prefer aired-so-far, else MAL total. */
export function resolveExpected(
  malEpisodes: number | null | undefined,
  aired: EpisodeAirInfo[],
  now = Date.now(),
): { airedCount: number; expected: number | null } {
  const airedCount = aired.filter((e) => {
    if (!e.aired) return false
    const t = Date.parse(e.aired)
    return Number.isFinite(t) && t <= now
  }).length
  if (airedCount > 0) return { airedCount, expected: airedCount }
  if (malEpisodes && malEpisodes > 0) return { airedCount: 0, expected: malEpisodes }
  return { airedCount: 0, expected: null }
}

function pickNextEpisode(
  episodes: EpisodeAirInfo[],
  onSite: (n: number) => boolean,
  now: number,
  malEpisodes: number | null | undefined,
  siteEpisodes: Record<string, string>,
): EpisodeAirInfo | null {
  const candidates = [...episodes]
    .filter((e) => Number.isFinite(e.episode) && e.episode > 0)
    .sort((a, b) => a.episode - b.episode)

  const past = candidates.find((e) => {
    if (onSite(e.episode) || !e.aired) return false
    const t = Date.parse(e.aired)
    return Number.isFinite(t) && t <= now
  })
  if (past) return past

  const future = candidates.find((e) => {
    if (onSite(e.episode) || !e.aired) return false
    const t = Date.parse(e.aired)
    return Number.isFinite(t) && t > now
  })
  if (future) return future

  // Known row not yet on site (undated).
  const missing = candidates.find((e) => !onSite(e.episode))
  if (missing) return missing

  // Airing seasons often only cache episodes that already exist on MAL —
  // once those are on site, synthesize the next number until MAL total says stop.
  const siteNums = Object.keys(siteEpisodes)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
  const knownMax = Math.max(0, ...candidates.map((e) => e.episode), ...siteNums)
  if (knownMax < 1) return null
  const guess = knownMax + 1
  if (malEpisodes && malEpisodes > 0 && guess > malEpisodes) return null
  return { episode: guess, title: null, aired: null }
}

function torrentsForEpisode(torrents: ChaseTorrent[], episode: number): ChaseTorrent[] {
  return torrents.filter((t) => t.episode === episode || (t.isBatch && t.episode == null))
}

export interface ChaseTarget {
  episode: number
  title?: string | null
  airsAt: string | null
  /** A confirmed-or-estimated air time at or before `now` — worth checking
   * download state for. False for future/unknown-timed episodes, where
   * nothing could legitimately be downloading yet. */
  due: boolean
}

/** Picks the next chase-worthy episode and its air time, independent of
 * torrent/library state — cheap enough to call before deciding whether a
 * (possibly slow) qBittorrent query is even worth making. */
export function resolveChaseTarget(args: {
  episodes: EpisodeAirInfo[]
  siteEpisodes: Record<string, string>
  malEpisodes?: number | null
  broadcast?: MalBroadcast | null
  now?: number
}): ChaseTarget | null {
  const now = args.now ?? Date.now()
  const onSite = (n: number) => !!args.siteEpisodes[String(n)]
  const next = pickNextEpisode(
    args.episodes,
    onSite,
    now,
    args.malEpisodes,
    args.siteEpisodes,
  )
  if (!next || onSite(next.episode)) return null

  let airsAt = next.aired ?? null
  if (!airsAt) {
    airsAt = estimateNextAir({
      nextEpisode: next.episode,
      episodes: args.episodes,
      broadcast: args.broadcast,
      now,
    })
  }

  const airMs = airsAt ? Date.parse(airsAt) : NaN
  const due = Number.isFinite(airMs) && airMs <= now

  return { episode: next.episode, title: next.title ?? null, airsAt, due }
}

export function resolveNextChase(args: {
  episodes: EpisodeAirInfo[]
  siteEpisodes: Record<string, string>
  libraryEpisodes: Set<number>
  torrents: ChaseTorrent[]
  malEpisodes?: number | null
  broadcast?: MalBroadcast | null
  now?: number
}): EpisodeChase | null {
  const now = args.now ?? Date.now()
  const target = resolveChaseTarget({
    episodes: args.episodes,
    siteEpisodes: args.siteEpisodes,
    malEpisodes: args.malEpisodes,
    broadcast: args.broadcast,
    now,
  })
  if (!target) return null

  const epTorrents = torrentsForEpisode(args.torrents, target.episode)
  const active = epTorrents.filter((t) => t.progress < 1)
  const complete = epTorrents.filter((t) => t.progress >= 1)
  const inLib = args.libraryEpisodes.has(target.episode)

  let state: ChaseState
  let progress: number | null = null
  if (!target.due) {
    // Future air, or timing unknown — nothing could legitimately be
    // downloading yet.
    state = 'waiting'
  } else if (active.length) {
    state = 'downloading'
    progress = Math.max(...active.map((t) => t.progress))
  } else if (complete.length || inLib) {
    state = 'importing'
  } else {
    state = 'searching'
  }

  return {
    episode: target.episode,
    title: target.title ?? null,
    airsAt: target.airsAt,
    state,
    progress,
  }
}

/** Public-safe chase (no progress). Null when absent or already ready. */
export function toPublicChase(
  c: EpisodeChase | null,
): Omit<EpisodeChase, 'progress'> | null {
  if (!c || c.state === 'ready') return null
  return {
    episode: c.episode,
    title: c.title ?? null,
    airsAt: c.airsAt,
    state: c.state,
  }
}
