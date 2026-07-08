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
}

export interface ChaseTorrent {
  episode: number | null
  progress: number
  isBatch?: boolean
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

  // No dated candidates: next gap after highest on-site / known ep.
  const missing = candidates.find((e) => !onSite(e.episode))
  return missing ?? null
}

function torrentsForEpisode(torrents: ChaseTorrent[], episode: number): ChaseTorrent[] {
  return torrents.filter((t) => t.episode === episode || (t.isBatch && t.episode == null))
}

export function resolveNextChase(args: {
  episodes: EpisodeAirInfo[]
  siteEpisodes: Record<string, string>
  libraryEpisodes: Set<number>
  torrents: ChaseTorrent[]
  now?: number
}): EpisodeChase | null {
  const now = args.now ?? Date.now()
  const onSite = (n: number) => !!args.siteEpisodes[String(n)]
  const next = pickNextEpisode(args.episodes, onSite, now)
  if (!next || onSite(next.episode)) return null

  const airsAt = next.aired ?? null
  const airMs = airsAt ? Date.parse(airsAt) : NaN
  const future = Number.isFinite(airMs) && airMs > now

  const epTorrents = torrentsForEpisode(args.torrents, next.episode)
  const active = epTorrents.filter((t) => t.progress < 1)
  const complete = epTorrents.filter((t) => t.progress >= 1)
  const inLib = args.libraryEpisodes.has(next.episode)

  let state: ChaseState
  let progress: number | null = null
  if (future) {
    state = 'waiting'
  } else if (active.length) {
    state = 'downloading'
    progress = Math.max(...active.map((t) => t.progress))
  } else if (complete.length || inLib) {
    state = 'importing'
  } else {
    // Past air (or unknown air date) with nothing in flight.
    state = 'searching'
  }

  return {
    episode: next.episode,
    title: next.title ?? null,
    airsAt,
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
