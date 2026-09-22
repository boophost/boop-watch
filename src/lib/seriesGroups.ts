import type { EpisodeChase } from '@/lib/chase'
import type { PortalSection } from '@/lib/sections'

/**
 * One row of the catalog — a single metadata entry, which for anime means one
 * MAL cour rather than one show.
 *
 * Identity is `(section, source, source_id)`; `mal_id` is anime-only and null
 * for TV and movies. The `tvdb_*` fields are the multi-season placement (see
 * `server/seasonMap.ts`): `tvdb_id` groups a show's cours, `tvdb_season` and
 * `episode_offset` place this cour inside the library.
 */
export interface SeriesEntry {
  id: number
  /** Anime only — null for TV and movies. */
  mal_id: number | null
  section?: PortalSection
  source?: 'mal' | 'tmdb'
  source_id?: number
  title: string
  title_english?: string | null
  synopsis: string | null
  image_url: string | null
  url: string | null
  added_at: string
  episodes?: number | null
  /** Release year — the only thing a film has to put in a chip, and the
   *  release-date sort's fallback when there is no full date. */
  year?: number | null
  /** MAL's air-date string ("Jan 6, 2026 to Mar 24, 2026"). Anime only in
   *  practice; TMDB rows carry a year and nothing finer. */
  aired?: string | null
  tvdb_id?: number | null
  tvdb_season?: number | null
  episode_offset?: number | null
  mapping_source?: string | null
  /** TV only: the seasons this show has in the library, from the portal cache.
   *  Anime reads its seasons off sibling rows instead, and a film has none. */
  librarySeasons?: Array<{ season: number; episodes: number }> | null
  /** When this row's newest *aired* episode came out (ISO), from MAL air dates
   *  and/or Jellyfin — see latestEpisodeFor on the server. Null for films and
   *  for titles neither source knows. Never in the future. */
  latestEpisodeAt?: string | null
  nextChase?: EpisodeChase | null
}

/**
 * A show: every catalog row that shares a `tvdb_id`, in broadcast order.
 *
 * Grouping is derived, not stored — `tvdb_id` is what the season mapping
 * already means, what `/api/series/:id/status` uses for its sibling switcher,
 * and what the portal anchors a franchise on. A row with no `tvdb_id` (a
 * brand-new title the mapping datasets don't carry yet, or any TV/movie row,
 * whose TMDB seasons already are the library's seasons) is its own group of
 * one: grouping degrades, it never hides a row.
 */
export interface SeriesGroup {
  /** Stable React key: the shared `tvdb_id`, or the lone row's id. */
  key: string
  /** Display name for the show — see `groupTitle`. */
  title: string
  poster: string | null
  /** Member rows, earliest cour first. */
  rows: SeriesEntry[]
  /** Distinct TVDB seasons these cours span (0 when none of them is mapped). */
  seasons: number
  /** Anime only: the rows carry no `tvdb_id` at all, so nothing can be grouped
   *  and the import sink falls back to "Season 1, no offset" for them — worth
   *  saying out loud rather than rendering as an ordinary row.
   *
   *  Never true outside anime. A TMDB row has no `tvdb_id` by design (its own
   *  seasons *are* the library's), so flagging one would be warning about the
   *  normal case — the fastest way to teach someone to ignore the badge. */
  unmapped: boolean
  /** Seasons below the highest one that no row covers, e.g. `[1]` for a show
   *  whose catalog starts at season 2. Empty when the run is complete. */
  missingSeasons: number[]
  /** Ids of rows whose episode range overlaps another cour of the same season. */
  overlapping: number[]
  /** Which library episodes are double-claimed, e.g. "season 2, episode 13".
   *  Null when nothing overlaps. */
  overlapDetail: string | null
  /** The most advanced chase across the group, for the list's status chip. */
  nextChase: EpisodeChase | null
}

/** Broadcast order: season, then where the cour starts inside it. */
function courOrder(a: SeriesEntry, b: SeriesEntry): number {
  return (
    (a.tvdb_season ?? 0) - (b.tvdb_season ?? 0) ||
    (a.episode_offset ?? 0) - (b.episode_offset ?? 0) ||
    a.id - b.id
  )
}

/**
 * A cour reduced to what names it: which library season it lands in, where it
 * starts inside that season, and how long it is.
 *
 * Spelled out as its own type on purpose. A catalog row carries **two**
 * different "seasons" — `tvdb_season` (the library's) and `season` (MAL's
 * broadcast season, the string "fall") — so a helper that accepts either
 * shape and picks whichever it finds will happily render "Sfall · 1-12".
 * Callers convert, and the conversion is the place the right field is chosen.
 */
export interface CourShape {
  season: number | null
  episodeOffset: number
  episodes: number | null
}

/** The library-season view of a catalog row. */
export function courShapeOf(row: SeriesEntry): CourShape {
  return {
    season: row.tvdb_season ?? null,
    episodeOffset: row.episode_offset ?? 0,
    episodes: row.episodes ?? null,
  }
}

/**
 * The episode range a cour occupies inside its season, 1-based and inclusive.
 * Null when we don't know how many episodes it has.
 */
export function courRange(cour: CourShape): { from: number; to: number } | null {
  if (cour.episodes == null) return null
  return { from: cour.episodeOffset + 1, to: cour.episodeOffset + cour.episodes }
}

/**
 * "S2 · 13-24" — a cour named by its *shape* rather than its title.
 *
 * Titles across cours are long and near-identical ("…Season 2 Part 2" against
 * "…Season 2"), so the season and episode range are the part that actually
 * tells two of them apart. Used by the catalog's season chips and by the
 * detail page's sibling switcher, which must agree.
 */
export function courShapeLabel(cour: CourShape): string {
  const label = cour.season != null ? `S${cour.season}` : '—'
  const range = courRange(cour)
  if (!range) return label
  return `${label} · ${range.from}-${range.to}`
}

// Trailing season/part markers on a cour title. Stripped only when a group has
// more than one cour, and only off the *earliest* one, so the group reads as
// the show ("That Time I Got Reincarnated as a Slime") rather than as whichever
// cour happens to be first in the catalog ("…Slime Season 2"). A single-cour
// group keeps its title verbatim — there is nothing to generalise from.
const SEASON_SUFFIX =
  /[\s:_-]+(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+)\s*$/i

/**
 * What to call the group.
 *
 * The earliest cour's title, English preferred. There is no stored show name
 * (`tvdb_id` is a number), and the group cannot assume its season 1 is even in
 * the catalog, so this is the most reliable thing we have without a round trip
 * to the portal for the Jellyfin series name.
 */
export function groupTitle(rows: SeriesEntry[]): string {
  const first = rows[0]
  if (!first) return ''
  const raw = first.title_english?.trim() || first.title
  if (rows.length < 2) return raw
  const stripped = raw.replace(SEASON_SUFFIX, '').trim()
  // Never strip away the whole title (a cour literally called "Season 2").
  return stripped.length >= 3 ? stripped : raw
}

/**
 * Seasons between 1 and the highest one present that no cour covers.
 *
 * Only for a group that already has several cours, where a hole in the run is
 * a fact about the show. For a lone row it is not: a catalog holding only
 * Re:ZERO season 4 would otherwise announce three "missing" seasons nobody
 * ever asked it to track.
 */
function missingSeasonsIn(rows: SeriesEntry[]): number[] {
  if (rows.length < 2) return []
  const present = new Set<number>()
  for (const r of rows) if (r.tvdb_season != null) present.add(r.tvdb_season)
  if (present.size === 0) return []
  const highest = Math.max(...present)
  const gaps: number[] = []
  // Season 0 is Jellyfin's specials folder, so a real run starts at 1.
  for (let s = 1; s < highest; s++) if (!present.has(s)) gaps.push(s)
  return gaps
}

/**
 * Cours of one season whose episode ranges overlap.
 *
 * Two cours of a season are meant to be consecutive — 1-12 then 13-24 — so an
 * overlap means both will chase the same library episode number. It is not
 * always a wrong offset: `episodes` is the *provider's* count, and MAL counts
 * a recap or special that TVDB does not place in the season, which makes an
 * otherwise-correct cour look one episode too long. (Mushoku's season 2 is
 * exactly that: MAL says part 1 is 13 episodes, TVDB's season 2 holds 24, and
 * part 1's last episode aired the day part 2's numbering starts from.) So this
 * is reported as something to look at, never as a diagnosis.
 *
 * Either way it is invisible on a per-cour page and obvious the moment the
 * cours are shown on one line.
 */
function overlappingIn(rows: SeriesEntry[]): { ids: number[]; detail: string | null } {
  const hit = new Set<number>()
  const spans: string[] = []
  const bySeason = new Map<number, SeriesEntry[]>()
  for (const r of rows) {
    if (r.tvdb_season == null || r.episodes == null) continue
    const list = bySeason.get(r.tvdb_season)
    if (list) list.push(r)
    else bySeason.set(r.tvdb_season, [r])
  }
  for (const [season, cours] of bySeason) {
    for (let i = 0; i < cours.length; i++) {
      for (let j = i + 1; j < cours.length; j++) {
        const a = courRange(courShapeOf(cours[i]))
        const b = courRange(courShapeOf(cours[j]))
        if (!a || !b) continue
        const from = Math.max(a.from, b.from)
        const to = Math.min(a.to, b.to)
        if (from > to) continue
        hit.add(cours[i].id)
        hit.add(cours[j].id)
        spans.push(
          from === to
            ? `season ${season}, episode ${from}`
            : `season ${season}, episodes ${from}-${to}`,
        )
      }
    }
  }
  return { ids: [...hit], detail: spans.length ? spans.join('; ') : null }
}

// Which chase the group's chip should show when several cours are mid-flight:
// the furthest along, because that is the one about to change state.
const CHASE_RANK: Record<string, number> = {
  downloading: 4,
  importing: 3,
  searching: 2,
  waiting: 1,
}

function groupChase(rows: SeriesEntry[]): EpisodeChase | null {
  let best: EpisodeChase | null = null
  for (const r of rows) {
    const c = r.nextChase
    if (!c || c.state === 'ready') continue
    if (!best || (CHASE_RANK[c.state] ?? 0) > (CHASE_RANK[best.state] ?? 0)) best = c
  }
  return best
}

/**
 * Group a catalog list by show, preserving the order the rows arrived in.
 *
 * A group takes the position of its earliest-listed member, so the list still
 * reads newest-first (the API orders by `added_at DESC`) rather than being
 * reshuffled into an order nobody asked for.
 */
export function groupSeries(rows: SeriesEntry[]): SeriesGroup[] {
  const byKey = new Map<string, SeriesEntry[]>()
  const order: string[] = []
  for (const row of rows) {
    const key = row.tvdb_id != null ? `tvdb:${row.tvdb_id}` : `row:${row.id}`
    const list = byKey.get(key)
    if (list) list.push(row)
    else {
      byKey.set(key, [row])
      order.push(key)
    }
  }
  return order.map((key) => {
    const members = [...byKey.get(key)!].sort(courOrder)
    const seasons = new Set(
      members.map((r) => r.tvdb_season).filter((s): s is number => s != null),
    )
    const overlaps = overlappingIn(members)
    return {
      key,
      title: groupTitle(members),
      poster: members.find((r) => r.image_url)?.image_url ?? null,
      rows: members,
      seasons: seasons.size,
      unmapped:
        members.every((r) => (r.section ?? 'anime') === 'anime') &&
        members.every((r) => r.tvdb_id == null),
      missingSeasons: missingSeasonsIn(members),
      overlapping: overlaps.ids,
      overlapDetail: overlaps.detail,
      nextChase: groupChase(members),
    }
  })
}

/**
 * "3 seasons · 5 cours" — the line under a group's title.
 *
 * Cours are only counted where they mean something: anime splits a show across
 * rows, so "5 cours" is a real fact about the catalog. A TV row is the whole
 * show, so it only ever reports its seasons.
 */
export function groupSubtitle(group: SeriesGroup): string {
  const parts: string[] = []
  const librarySeasons = group.rows[0]?.librarySeasons?.length ?? 0
  const seasons = Math.max(group.seasons, librarySeasons)
  if (seasons > 1) parts.push(`${seasons} seasons`)
  if (group.rows.length > 1) parts.push(`${group.rows.length} cours`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Sorting and filtering the grouped list
// ---------------------------------------------------------------------------

export type CatalogSort = 'activity' | 'added' | 'title' | 'released'

// Dropdown order: the default first, then the date sorts, then alphabetical.
export const SORT_LABELS: Record<CatalogSort, string> = {
  added: 'Recently added',
  activity: 'Recent activity',
  released: 'Release date',
  title: 'Title (A–Z)',
}

export const isCatalogSort = (s: string): s is CatalogSort =>
  s === 'activity' || s === 'added' || s === 'title' || s === 'released'

/** SQLite's `datetime('now')` is UTC without a zone marker. */
function addedMs(row: SeriesEntry): number {
  const t = Date.parse(row.added_at.includes('T') ? row.added_at : row.added_at.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : 0
}

/**
 * When a row was released, to the best precision the section has.
 *
 * Anime carries MAL's air-date string — "Oct 5, 2024 to Mar 15, 2025", or just
 * "Apr 2019" or "2019" for older entries — so the start of it is parsed first.
 * TMDB rows only ever have a year. Null when there is nothing at all, which
 * sorts such rows last rather than pretending they are from 1970.
 */
export function releasedMs(row: SeriesEntry): number | null {
  const start = row.aired?.split(/\s+to\s+/i)[0]?.trim()
  if (start && !/not available|\?/i.test(start)) {
    const t = Date.parse(start)
    if (Number.isFinite(t)) return t
  }
  if (row.year != null) return Date.UTC(row.year, 0, 1)
  return null
}

/** Newest episode release for a row; a film falls back to its release date. */
function activityMs(row: SeriesEntry): number | null {
  if (row.latestEpisodeAt) {
    const t = Date.parse(row.latestEpisodeAt)
    if (Number.isFinite(t)) return t
  }
  return row.section === 'movies' ? releasedMs(row) : null
}

// Library-style title sort: "The Bear" files under B, the way Jellyfin shelves
// it on the portal, so the two surfaces agree about where a show lives.
function titleKey(title: string): string {
  return title.trim().replace(/^(the|a|an)\s+/i, '').toLocaleLowerCase()
}

/**
 * Order groups for display. Every key is the *show's*, not one cour's:
 *
 *  - **Recently added** uses the newest row in the group, so adding a new cour
 *    brings its whole show back to the top — which is when you want to see it.
 *  - **Release date** uses the newest *release* in the group, newest first, so
 *    a show whose latest season is airing now sits with the current season
 *    rather than wherever its 2019 first season would put it. Rows with no date
 *    at all go last.
 *
 *  - **Recent activity** means new episode releases: newest-aired episode
 *    first, so what just came out leads. A film has no episodes, so it sorts by
 *    its release date instead; a title with neither goes last.
 *
 * Ties fall back to the title, so the order is stable across reloads.
 */
export function sortGroups(groups: SeriesGroup[], sort: CatalogSort): SeriesGroup[] {
  const byTitle = (a: SeriesGroup, b: SeriesGroup) =>
    titleKey(a.title).localeCompare(titleKey(b.title))
  const out = [...groups]
  if (sort === 'title') return out.sort(byTitle)
  if (sort === 'added') {
    const key = (g: SeriesGroup) => Math.max(...g.rows.map(addedMs))
    return out.sort((a, b) => key(b) - key(a) || byTitle(a, b))
  }
  const rowKey = sort === 'activity' ? activityMs : releasedMs
  const key = (g: SeriesGroup) => {
    const dates = g.rows.map(rowKey).filter((t): t is number => t != null)
    return dates.length ? Math.max(...dates) : null
  }
  return out.sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka == null && kb == null) return byTitle(a, b)
    if (ka == null) return 1
    if (kb == null) return -1
    return kb - ka || byTitle(a, b)
  })
}

const foldText = (s: string) =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()

/**
 * Narrow the list to groups matching a query.
 *
 * Matches the show's display name *and* every member's own titles — romaji and
 * English — so "tensei shitara" still finds Slime although its group is named
 * in English, and "part 2" finds the Mushoku group through its cour. Accents
 * and case are ignored; each space-separated word must appear somewhere.
 */
export function filterGroups(groups: SeriesGroup[], query: string): SeriesGroup[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return groups
  return groups.filter((g) => {
    const hay = foldText(
      [g.title, ...g.rows.flatMap((r) => [r.title, r.title_english ?? ''])].join(' '),
    )
    return words.every((w) => hay.includes(w))
  })
}
