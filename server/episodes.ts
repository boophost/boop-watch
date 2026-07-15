// Episode data assembly — AniList owns *which episodes exist + when* (the
// freshness-critical fact MAL/Jikan lags on); per-episode *titles* are merged
// from several sources into `series_episodes` (AniList has no reliable titles).
// Everything is cache-first: `series_episodes` is the single store the /manage
// episodes API and the chase UI read from, and the flow node keeps it warm.
import { limitedFetch } from './httpQueue.js'
import { fetchAnimeEpisodesPage, episodeNumberFromUrl } from './jikan.js'
import { fetchAniListMedia, type AniListMedia } from './anilist.js'
import { getCachedEpisodes, upsertEpisodeAirDates, upsertEpisodeTitles, episodesCacheInfo } from './db.js'

/** One merged episode ready for display. */
export interface DisplayEpisode {
  number: number
  title: string | null
  title_japanese: string | null
  aired: string | null
}

/** Kitsu episode titles for a MAL id — resolve mal → kitsu anime via the
 * mappings table (mirrors banners.ts `fetchKitsuArt`), then walk its episodes.
 * Best-effort: [] on any error. Kitsu numbers episodes per its own (MAL-mapped)
 * entry, so `number` matches our per-cour MAL numbering. */
export async function fetchKitsuEpisodes(
  malId: number,
): Promise<{ number: number; title: string; title_japanese: string | null }[]> {
  try {
    const mapRes = await limitedFetch(
      'kitsu',
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { headers: { Accept: 'application/vnd.api+json' } },
    )
    if (!mapRes.ok) return []
    const mapJson = (await mapRes.json()) as {
      data?: Array<{ relationships?: { item?: { data?: { id?: string; type?: string } } } }>
    }
    const rel = mapJson.data?.[0]?.relationships?.item?.data
    if (!rel || rel.type !== 'anime' || !rel.id) return []
    const out: { number: number; title: string; title_japanese: string | null }[] = []
    // Episodes are paginated 20/page; a handful of pages covers any cour.
    for (let offset = 0; offset < 200; offset += 20) {
      const epRes = await limitedFetch(
        'kitsu',
        `https://kitsu.io/api/edge/anime/${rel.id}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`,
        { headers: { Accept: 'application/vnd.api+json' } },
      )
      if (!epRes.ok) break
      const epJson = (await epRes.json()) as {
        data?: Array<{
          attributes?: { number?: number | null; canonicalTitle?: string | null; titles?: { ja_jp?: string | null } }
        }>
      }
      const rows = epJson.data ?? []
      for (const e of rows) {
        const n = e.attributes?.number
        const title = (e.attributes?.canonicalTitle ?? '').trim()
        if (n != null && Number.isFinite(n) && title) {
          out.push({ number: n, title, title_japanese: e.attributes?.titles?.ja_jp ?? null })
        }
      }
      if (rows.length < 20) break
    }
    return out
  } catch {
    return []
  }
}

/** Jikan episode titles for a MAL id (a title contributor now, not the source of
 * truth on which episodes exist). Best-effort: [] on any error. */
async function fetchJikanEpisodeTitles(
  malId: number,
): Promise<{ number: number; title: string; title_japanese: string | null; aired: string | null }[]> {
  const out: { number: number; title: string; title_japanese: string | null; aired: string | null }[] = []
  try {
    for (let page = 1; page <= 4; page++) {
      const { episodes, pagination } = await fetchAnimeEpisodesPage(malId, page)
      episodes.forEach((e, i) => {
        const number = episodeNumberFromUrl(e.url) ?? e.mal_id ?? (page - 1) * 100 + i + 1
        const title = (e.title ?? '').trim()
        if (Number.isFinite(number) && title) {
          out.push({ number, title, title_japanese: e.title_japanese ?? null, aired: e.aired ?? null })
        }
      })
      if (!pagination.has_next_page) break
    }
  } catch {
    /* Jikan flakes constantly — its titles are best-effort. */
  }
  return out
}

const firstNonEmpty = (...vals: (string | null | undefined)[]): string | null =>
  vals.find((v) => v && v.trim().length > 0)?.trim() ?? null

export interface FillTitlesOptions {
  /** Finished shows may have episode existence established by Jikan/Kitsu (MAL is
   * complete + stable for them); airing shows keep AniList as the existence
   * authority, so titles only fill numbers already in the cache. */
  finished?: boolean
  /** AniList streaming titles already fetched by the caller (avoids a re-fetch). */
  streamingTitles?: AniListMedia['streamingTitles']
  /** Source order to try (default jikan → kitsu → anilist). */
  sources?: ('jikan' | 'kitsu' | 'anilist')[]
}

/**
 * Fill missing episode titles for a series from multiple sources, merged into
 * `series_episodes` (first non-empty wins in source order). Returns how many
 * rows were written. Fetches sources unconditionally when called — callers gate
 * on cache freshness (cache-first).
 */
export async function fillEpisodeTitles(malId: number, opts: FillTitlesOptions = {}): Promise<number> {
  const sources = opts.sources ?? ['jikan', 'kitsu', 'anilist']
  const cached = getCachedEpisodes(malId)
  const existing = new Set(cached.map((e) => e.number))

  const jikan = sources.includes('jikan') ? await fetchJikanEpisodeTitles(malId) : []
  const kitsu = sources.includes('kitsu') ? await fetchKitsuEpisodes(malId) : []
  let streaming = opts.streamingTitles
  if (streaming == null && sources.includes('anilist')) {
    streaming = (await fetchAniListMedia(malId))?.streamingTitles ?? []
  }
  streaming = streaming ?? []

  const byNum = <T extends { number: number }>(rows: T[]) => new Map(rows.map((r) => [r.number, r]))
  const jMap = byNum(jikan)
  const kMap = byNum(kitsu)
  const sMap = byNum(streaming)

  // Airing shows: only fill numbers AniList already established. Finished shows:
  // let Jikan/Kitsu also establish existence (MAL is complete + stable there).
  const numbers = new Set(existing)
  if (opts.finished) {
    for (const n of jMap.keys()) numbers.add(n)
    for (const n of kMap.keys()) numbers.add(n)
  }

  const order = { jikan: jMap, kitsu: kMap, anilist: sMap }
  const rows: { number: number; title: string | null; title_japanese?: string | null; aired?: string | null }[] = []
  for (const n of numbers) {
    const title = firstNonEmpty(...sources.map((s) => order[s].get(n)?.title))
    const title_japanese = firstNonEmpty(
      ...sources.map((s) => (order[s].get(n) as { title_japanese?: string | null } | undefined)?.title_japanese),
    )
    const aired = jMap.get(n)?.aired ?? null // COALESCE keeps AniList's aired if set
    if (title || aired) rows.push({ number: n, title, title_japanese, aired })
  }
  upsertEpisodeTitles(malId, rows)
  return rows.length
}

export interface EpisodeSeriesInfo {
  mal_id: number
  finished: boolean
  totalEpisodes: number | null
}

/**
 * Bring `series_episodes` up to date for one series, cache-first: refresh
 * AniList existence/air-dates unless the cache already covers a finished show,
 * then fill any missing titles from the source merge. Shared by the episodes
 * route and the `enrich.episode-titles` flow node. Returns which source drove
 * the refresh and how many title rows were written.
 */
export async function refreshEpisodeCache(
  info: EpisodeSeriesInfo,
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<{ source: string; filled: number }> {
  const { mal_id, finished, totalEpisodes } = info
  const ttlMs = opts.ttlMs ?? 6 * 3600_000
  let source = 'db'
  let filled = 0

  const cachedBefore = getCachedEpisodes(mal_id)
  const complete = finished && totalEpisodes != null && cachedBefore.length >= totalEpisodes
  // Cache-first: a complete finished show never refreshes; otherwise skip the
  // upstream fetch while the cache is recent (episodes air weekly, not by the
  // minute) and has no missing titles — no excess AniList/Jikan/Kitsu polling.
  const ci = episodesCacheInfo(mal_id)
  const ageMs = ci.updated_at ? Date.now() - new Date(ci.updated_at + 'Z').getTime() : Infinity
  const missingTitles = cachedBefore.length === 0 || cachedBefore.some((e) => !e.title)
  const fresh = ttlMs > 0 && ageMs < ttlMs && !missingTitles
  if (!opts.force && (complete || fresh)) return { source, filled }

  const media = await fetchAniListMedia(mal_id)
  if (media) {
    source = 'anilist'
    if (media.episodes.length > 0) {
      upsertEpisodeAirDates(mal_id, media.episodes.map((e) => ({ number: e.number, aired: e.airedAt })))
    }
    // Fill titles (cache-first: only when something is missing).
    const total = totalEpisodes ?? media.totalEpisodes
    const needTitles = getCachedEpisodes(mal_id).some((e) => !e.title)
    const needMore = finished && total != null && getCachedEpisodes(mal_id).length < total
    if (needTitles || needMore) {
      filled = await fillEpisodeTitles(mal_id, { finished, streamingTitles: media.streamingTitles })
    }
  } else if (cachedBefore.some((e) => !e.title) || cachedBefore.length === 0) {
    // AniList down — still try Jikan/Kitsu so the list isn't empty/untitled.
    filled = await fillEpisodeTitles(mal_id, { finished })
  }
  return { source, filled }
}

/**
 * The episodes to show for a series, cache-first from `series_episodes`. Refreshes
 * the cache, then builds the set — finished shows show 1..total, airing shows show
 * the episodes aired so far.
 */
export async function getEpisodesForDisplay(
  info: EpisodeSeriesInfo,
): Promise<{ episodes: DisplayEpisode[]; source: string }> {
  const { mal_id, finished, totalEpisodes } = info
  const { source } = await refreshEpisodeCache(info)

  const cached = getCachedEpisodes(mal_id)
  const byNum = new Map(cached.map((e) => [e.number, e]))
  const now = Date.now()

  let numbers: number[]
  if (finished && totalEpisodes != null && totalEpisodes > 0) {
    numbers = Array.from({ length: totalEpisodes }, (_, i) => i + 1)
  } else {
    // Airing (or unknown total): show episodes that have aired so far, plus any
    // cached episode with a title (covers a finished show with no known total).
    const aired = cached.filter((e) => (e.aired ? new Date(e.aired).getTime() <= now : false) || e.title)
    numbers = aired.map((e) => e.number).sort((a, b) => a - b)
  }

  const episodes: DisplayEpisode[] = numbers.map((n) => {
    const row = byNum.get(n)
    return {
      number: n,
      title: row?.title ?? null,
      title_japanese: row?.title_japanese ?? null,
      aired: row?.aired ?? null,
    }
  })
  return { episodes, source }
}
