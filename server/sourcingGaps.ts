// What a TV show still needs downloaded, given what TMDB says has aired, what the
// portal already serves, and what qBittorrent already holds. Pure (no DB/IO) so
// scripts/verify-sourcing-gaps.mjs can drive it directly; the flow node
// `enrich.sourcing-gaps` (flowNodes.ts) does the lookups and calls in here.
//
// Anime has the wants pipeline (MAL-keyed) for this. TV and movies have no MAL
// id, so they plan from live state instead: anything on the portal or matched to
// a torrent counts as held, whatever state that torrent is in — a stalled or
// errored download is a human's call, and re-queuing a second copy of it every
// run would be worse.

export interface AiredEpisode {
  season: number
  episode: number
  /** TMDB air date (YYYY-MM-DD); null = announced, not dated. */
  aired: string | null
}

export type GapPlan =
  | { kind: 'batch'; season: number; episodes: number }
  | { kind: 'episode'; season: number; episode: number }

/** What a release name covers. `seasons: 'all'` = a complete-series pack, or a
 * name with no season/episode marker at all (a miniseries is usually posted
 * that way — treating it as covering everything avoids a duplicate download). */
export interface TorrentCoverage {
  seasons: 'all' | { from: number; to: number }
  /** Set for a single-episode release; null = the whole season range. */
  episode: number | null
}

export function torrentCoverage(name: string): TorrentCoverage {
  let m = name.match(/\bS(\d{1,2})[\s._-]*E(\d{1,4})\b/i) ?? name.match(/\b(\d{1,2})x(\d{2,3})\b/)
  if (m) {
    const s = Number(m[1])
    return { seasons: { from: s, to: s }, episode: Number(m[2]) }
  }
  m =
    name.match(/\bS(\d{1,2})\s*[-–~]\s*S?(\d{1,2})\b/i) ??
    name.match(/\bSeasons?\s*(\d{1,2})\s*[-–~]\s*(\d{1,2})\b/i)
  if (m) return { seasons: { from: Number(m[1]), to: Number(m[2]) }, episode: null }
  m =
    name.match(/\bS(\d{1,2})\b/i) ??
    name.match(/\bSeason\s*(\d{1,2})\b/i) ??
    name.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i)
  if (m) {
    const s = Number(m[1])
    return { seasons: { from: s, to: s }, episode: null }
  }
  return { seasons: 'all', episode: null }
}

function covers(c: TorrentCoverage, season: number, episode: number): boolean {
  if (c.seasons !== 'all' && (season < c.seasons.from || season > c.seasons.to)) return false
  return c.episode == null || c.episode === episode
}

export function planTvGaps(args: {
  episodes: AiredEpisode[]
  /** Portal episode keys, "season:episode" (matchSeriesDownloads' siteEpisodes). */
  onSite: Set<string>
  /** Names of the qBittorrent torrents already matched to this show. */
  torrents: string[]
  /** YYYY-MM-DD; an episode airing today counts as aired. */
  today: string
  /** Collapse a fully-aired season with nothing held into one season pack. */
  seasonPacks: boolean
  /** Plan only this season (the episode fallback for a pack search that missed). */
  onlySeason?: number | null
}): { missing: GapPlan[]; held: number; unaired: number } {
  const coverage = args.torrents.map(torrentCoverage)
  const bySeason = new Map<number, AiredEpisode[]>()
  for (const e of args.episodes) {
    // Season 0 is TMDB's specials bucket — release groups rarely post it under
    // that numbering, so it would only ever be searched for and missed.
    if (e.season < 1) continue
    if (args.onlySeason != null && e.season !== args.onlySeason) continue
    bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e])
  }

  const missing: GapPlan[] = []
  let held = 0
  let unaired = 0
  for (const season of [...bySeason.keys()].sort((a, b) => a - b)) {
    const eps = bySeason.get(season)!.sort((a, b) => a.episode - b.episode)
    const aired = eps.filter((e) => e.aired != null && e.aired <= args.today)
    unaired += eps.length - aired.length
    const need = aired.filter((e) => {
      const have =
        args.onSite.has(`${season}:${e.episode}`) || coverage.some((c) => covers(c, season, e.episode))
      if (have) held++
      return !have
    })
    if (need.length === 0) continue
    // A pack only exists once the whole season is out, and only makes sense when
    // none of it is held — otherwise it re-downloads what we have.
    if (args.seasonPacks && aired.length === eps.length && need.length === eps.length && eps.length > 1) {
      missing.push({ kind: 'batch', season, episodes: eps.length })
    } else {
      for (const e of need) missing.push({ kind: 'episode', season, episode: e.episode })
    }
  }
  return { missing, held, unaired }
}
