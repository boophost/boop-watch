// Absolute episode numbers past a cour's length, spilled into the sibling cour.
// Pure (no DB/IO) so scripts/verify-absolute-spill.mjs can drive it directly.
//
// A pack numbered absolutely across a franchise (Dragon Ball Kai 001-159, where
// the catalog splits it into mal 6033 = 98 eps and mal 22777 = 61 eps) lands
// its tail in the first cour's season as S01E99-159. The catalog already knows
// the cours are siblings (same tvdb_id, ascending tvdb_season), so we can move
// the overflow to where it belongs.
//
// The boundary is the cour's length *in the library* (its TVDB season), not
// MAL's count: MAL lists Kai as 97 episodes, TVDB S1 and the pack have 98. The
// caller resolves `episodes` as override > TVDB season length > MAL and says
// which in `episodes_source`; this module only does the arithmetic.

export interface SpillCour {
  mal_id: number | null
  tvdb_id: number | null
  tvdb_season: number | null
  episode_offset: number | null
  /** Episode count of this cour; null/0 when the catalog doesn't know it. */
  episodes: number | null
  /** Where `episodes` came from: 'override' | 'tvdb' | 'mal'. Informational. */
  episodes_source?: string
}

export type SpillResult =
  | { kind: 'in-range' }
  | { kind: 'unchanged'; reason: string }
  | { kind: 'spilled'; cour: SpillCour; episode: number; from: number }

const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0

/** Sibling cours of `cour` in order: one per later tvdb_season (the earliest
 * offset within a season), so a chain walks season by season. */
function laterSeasons(cour: SpillCour, catalog: SpillCour[]): SpillCour[] {
  if (cour.tvdb_id == null || cour.tvdb_season == null) return []
  const bySeason = new Map<number, SpillCour>()
  for (const s of catalog) {
    if (s.tvdb_id !== cour.tvdb_id || s.tvdb_season == null || s.tvdb_season <= cour.tvdb_season!) continue
    const have = bySeason.get(s.tvdb_season)
    if (!have || (s.episode_offset ?? 0) < (have.episode_offset ?? 0)) bySeason.set(s.tvdb_season, s)
  }
  return [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)
}

/**
 * Where does episode `episode` of `cour` really belong? Files within the
 * cour's length are never touched. Past it, walk the sibling cours subtracting
 * each one's length until the number fits. Anything we can't place with
 * confidence (unknown count, no sibling, runs past the last sibling) is left
 * exactly as it was, with a reason for the run log.
 */
export function spillAbsoluteEpisode(episode: number, cour: SpillCour, catalog: SpillCour[]): SpillResult {
  if (!Number.isInteger(episode) || episode < 1) return { kind: 'unchanged', reason: 'no usable episode number' }
  if (!known(cour.episodes)) return { kind: 'unchanged', reason: 'cour episode count unknown' }
  if (episode <= cour.episodes) return { kind: 'in-range' }
  const siblings = laterSeasons(cour, catalog)
  let at = cour
  let ep = episode
  let hops = 0
  while (known(at.episodes) && ep > at.episodes) {
    const next = siblings[hops]
    if (!next) {
      return {
        kind: 'unchanged',
        reason: hops === 0 ? `no sibling cour after mal ${cour.mal_id}` : `episode ${episode} runs past the last sibling cour (mal ${at.mal_id})`,
      }
    }
    ep -= at.episodes
    at = next
    hops++
  }
  return { kind: 'spilled', cour: at, episode: ep, from: episode }
}

/**
 * A cour's length in the library, and where it came from. Explicit override
 * first; then the TVDB season length when the caller has one for a cour that is
 * the whole season (it is ignored when shorter than MAL's count, which means the
 * library copy is incomplete rather than the season short); MAL last.
 */
export function resolveCourLength(
  row: { season_length?: number | null; episodes: number | null },
  tvdbLength: number | null | undefined,
): { episodes: number | null; source: 'override' | 'tvdb' | 'mal' } {
  if (known(row.season_length)) return { episodes: row.season_length, source: 'override' }
  if (known(tvdbLength) && tvdbLength >= (row.episodes ?? 0)) return { episodes: tvdbLength, source: 'tvdb' }
  return { episodes: row.episodes, source: 'mal' }
}

export type SpillCatalogRow = SpillCour & { season_length?: number | null }

/**
 * The catalog with each cour's boundary resolved (override > TVDB > MAL).
 * TVDB lengths come from `fetchLengths`, which is slow (a Jellyfin call per
 * show), so it is only asked about shows that need it: an input item whose cour
 * has a later sibling season and whose episode is past the override/MAL length.
 * An all-in-range batch makes zero lookups. TVDB is only used for a cour that is
 * the whole season (offset 0, sole row for its tvdb_id + season).
 */
export async function buildSpillCatalog<T extends SpillCatalogRow>(
  rows: T[],
  items: { mal_id: number; episode: number }[],
  fetchLengths: (row: T) => Promise<Map<number, number>>,
): Promise<(SpillCour & { episodes_source: 'override' | 'tvdb' | 'mal' })[]> {
  const needs = new Set<number>() // tvdb_id of shows worth a lookup
  for (const it of items) {
    const row = rows.find((r) => r.mal_id === it.mal_id)
    if (!row || known(row.season_length) || row.tvdb_id == null || row.tvdb_season == null) continue
    if (it.episode <= (row.episodes ?? 0)) continue
    if (laterSeasons(row, rows).length === 0) continue
    needs.add(row.tvdb_id)
  }
  const lengths = new Map<number, Map<number, number>>()
  for (const tvdbId of needs) {
    const any = rows.find((r) => r.tvdb_id === tvdbId)!
    lengths.set(tvdbId, await fetchLengths(any))
  }
  return rows.map((s) => {
    let tvdbLen: number | undefined
    if (s.tvdb_id != null && s.tvdb_season != null && (s.episode_offset ?? 0) === 0 && lengths.has(s.tvdb_id)) {
      const sole = !rows.some((o) => o !== s && o.tvdb_id === s.tvdb_id && o.tvdb_season === s.tvdb_season)
      if (sole) tvdbLen = lengths.get(s.tvdb_id)!.get(s.tvdb_season)
    }
    const { episodes, source } = resolveCourLength(s, tvdbLen)
    return { mal_id: s.mal_id, tvdb_id: s.tvdb_id, tvdb_season: s.tvdb_season, episode_offset: s.episode_offset, episodes, episodes_source: source }
  })
}
