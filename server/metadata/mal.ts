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

    try {
      return (await searchAnimeAniList(query, limit)).map(toHit)
    } catch (anilistErr) {
      // Jikan's own search needs a Typesense index a self-hosted instance may
      // not run, so this is a genuine fallback, not a preference.
      console.error('search: AniList failed, trying Jikan —', anilistErr)
      return (await searchAnime(query)).slice(0, limit).map((a) =>
        toHit({
          mal_id: a.mal_id,
          title: a.title,
          synopsis: a.synopsis ?? '',
          image_url: pickPosterUrl(a),
          url: a.url,
          // Jikan's brief search result carries none of these; the UI degrades.
          year: null,
          type: null,
          status: null,
          episodes: null,
        }),
      )
    }
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
