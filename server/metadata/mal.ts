// The anime metadata client: AniList primary, MyAnimeList/Jikan fallback.
//
// This is a wrapper, not a rewrite — the fetching, the AniList-first ordering
// and the record shape are exactly what `server/flowNodes.ts` has been using;
// they moved here because `enrich.metadata` is no longer the only caller now
// that the admin API resolves metadata per section too. `flowNodes.ts` imports
// `resolveCatalog` from here rather than keeping a second copy.
import { fetchAniListMedia, searchAnimeAniList, type AniListMedia } from '../anilist.js'
import { fetchAnimeFull, pickPosterUrl, searchAnime, type JikanAnimeFull } from '../jikan.js'
import type { PortalSection } from '../portalDb.js'
import type { MetadataClient, TitleDetail, TitleHit } from './index.js'

/**
 * A normalised catalog record, produced from either AniList (primary) or Jikan
 * (fallback), so a caller's write/emit logic is source-agnostic.
 */
export type CatalogRecord = {
  base: { title: string; synopsis: string | null; image_url: string | null; url: string }
  meta: {
    title_english: string | null
    title_japanese: string | null
    type: string | null
    episodes: number | null
    status: string | null
    score: number | null
    year: number | null
    season: string | null
    aired: string | null
    studios: string
    genres: string
    broadcast: string | null
  }
}

export function aniListToCatalog(a: AniListMedia, mal: number): CatalogRecord {
  return {
    base: {
      title: a.title,
      synopsis: a.synopsis,
      image_url: a.coverImage,
      url: `https://myanimelist.net/anime/${mal}`,
    },
    meta: {
      title_english: a.titleEnglish,
      title_japanese: a.titleNative,
      type: a.type,
      episodes: a.totalEpisodes,
      status: a.status,
      score: a.score,
      year: a.year,
      season: a.season,
      aired: a.airedString,
      studios: JSON.stringify(a.studios),
      genres: JSON.stringify(a.genres),
      broadcast: a.broadcast ? JSON.stringify(a.broadcast) : null,
    },
  }
}

export function jikanToCatalog(a: JikanAnimeFull): CatalogRecord {
  return {
    base: {
      title: a.title,
      synopsis: a.synopsis ?? null,
      image_url: pickPosterUrl(a as unknown as Parameters<typeof pickPosterUrl>[0]),
      url: a.url,
    },
    meta: {
      title_english: a.title_english ?? null,
      title_japanese: a.title_japanese ?? null,
      type: a.type ?? null,
      episodes: a.episodes ?? null,
      status: a.status ?? null,
      score: a.score ?? null,
      year: a.year ?? null,
      season: a.season ?? null,
      aired: a.aired?.string ?? null,
      studios: JSON.stringify((a.studios ?? []).map((s) => s.name)),
      genres: JSON.stringify((a.genres ?? []).map((g) => g.name)),
      broadcast: a.broadcast
        ? JSON.stringify({
            day: a.broadcast.day ?? null,
            time: a.broadcast.time ?? null,
            timezone: a.broadcast.timezone ?? null,
            string: a.broadcast.string ?? null,
          })
        : null,
    },
  }
}

/**
 * Resolve a catalog record for a mal_id — AniList first (current, not
 * rate-limit-prone), Jikan only if AniList can't answer. Returns the record and
 * which source produced it (for observability). Throws only if both fail.
 */
export async function resolveCatalog(
  mal: number,
): Promise<{ record: CatalogRecord; source: 'anilist' | 'jikan' }> {
  const al = await fetchAniListMedia(mal)
  if (al) return { record: aniListToCatalog(al, mal), source: 'anilist' }
  return { record: jikanToCatalog(await fetchAnimeFull(mal)), source: 'jikan' }
}

/**
 * How long `search` waits on Jikan before answering with AniList's hits alone.
 * Search is interactive (it fires on every debounced keystroke) and Jikan is
 * only a supplementary index here, so it must never hold up results the primary
 * provider already has. The abandoned request is left to settle in its queue.
 */
const JIKAN_SEARCH_BUDGET_MS = 3500

/** Resolves to `null` rather than waiting past `ms`. `p` must not reject. */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms) })])
}

export const malClient: MetadataClient = {
  provider: 'mal',
  // AniList and Jikan are both public and unauthenticated.
  configured: true,
  unconfiguredReason: '',

  async search(_section: PortalSection, query: string, limit = 15): Promise<TitleHit[]> {
    const toHit = (h: {
      mal_id: number
      title: string
      synopsis: string
      image_url: string | null
      url: string
      year: number | null
      type: string | null
      status: string | null
      episodes: number | null
    }): TitleHit => ({ source: 'mal', source_id: h.mal_id, ...h })

    // Both indexes are queried and their hits unioned by mal_id, because
    // neither one alone is complete. AniList's matcher is literal over its own
    // title/synonym list, so a show whose common English name lives only on MAL
    // misses entirely — "The Super Dimension Fortress Macross" returns the two
    // sequels but not the 1982 series, whose AniList synonym is spelled
    // "Super Dimensional Fortress Macross". Jikan catches those. AniList stays
    // primary (better relevance order, and it carries the year/type/status/
    // episode fields the cards render), so it leads and wins any overlap.
    const [anilist, jikan] = await Promise.all([
      searchAnimeAniList(query, limit).catch((err) => {
        console.error('search: AniList failed —', err)
        return null
      }),
      // Jikan's own search needs a Typesense index a self-hosted instance may
      // not run, and the public one 504s under load, so a miss here is routine.
      withBudget(
        searchAnime(query, limit).catch((err) => {
          console.error('search: Jikan failed —', err)
          return null
        }),
        JIKAN_SEARCH_BUDGET_MS,
      ),
    ])
    if (anilist == null && jikan == null) {
      throw new Error('Anime search is unavailable — both AniList and Jikan failed')
    }

    const hits = (anilist ?? []).map(toHit)
    const seen = new Set(hits.map((h) => h.source_id))
    for (const a of jikan ?? []) {
      if (seen.has(a.mal_id)) continue
      seen.add(a.mal_id)
      hits.push(
        toHit({
          mal_id: a.mal_id,
          title: a.title,
          synopsis: a.synopsis ?? '',
          image_url: pickPosterUrl(a),
          url: a.url,
          // Jikan's brief search result carries none of these; the card degrades.
          year: null,
          type: null,
          status: null,
          episodes: null,
        }),
      )
    }
    return hits.slice(0, limit)
  },

  async detail(_section: PortalSection, sourceId: number): Promise<TitleDetail> {
    const { record } = await resolveCatalog(sourceId)
    const { base, meta } = record
    return {
      source: 'mal',
      source_id: sourceId,
      mal_id: sourceId,
      title: base.title,
      synopsis: base.synopsis ?? '',
      image_url: base.image_url,
      url: base.url,
      year: meta.year,
      type: meta.type,
      status: meta.status,
      episodes: meta.episodes,
      // MAL knows neither; the season-map dataset is what supplies tvdb_id for
      // anime (see server/seasonMap.ts), and it is resolved separately on add.
      imdb_id: null,
      tvdb_id: null,
      metadata: meta,
    }
  },
}
