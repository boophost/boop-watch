// The TV/movies metadata client, mapping the TMDB wire shapes onto the
// section-agnostic TitleHit/TitleDetail contract.
import type { PortalSection } from '../portalDb.js'
import {
  fetchTmdbTitle,
  searchTmdb,
  tmdbConfigured,
  type TmdbKind,
  type TmdbTitle,
} from '../tmdb.js'
import type { MetadataClient, TitleDetail, TitleHit } from './index.js'

/**
 * TMDB splits shows and films across separate endpoints, so the section
 * decides which one we're talking to. This is the only place that mapping
 * lives — `sections.ts` says *which provider*, this says *which endpoint*.
 */
function kindFor(section: PortalSection): TmdbKind {
  if (section === 'movies') return 'movie'
  if (section === 'tv') return 'tv'
  // 'anime' is sourced from MAL; reaching here means a caller bypassed
  // clientForSection() and would otherwise get silently wrong results.
  throw new Error(`Section "${section}" is not sourced from TMDB`)
}

const UNCONFIGURED =
  'TMDB is not configured — set TMDB_API_KEY to search and add TV or movie titles'

export const tmdbClient: MetadataClient = {
  provider: 'tmdb',
  get configured() {
    return tmdbConfigured()
  },
  get unconfiguredReason() {
    return tmdbConfigured() ? '' : UNCONFIGURED
  },

  async search(section: PortalSection, query: string, limit = 15): Promise<TitleHit[]> {
    const hits = await searchTmdb(kindFor(section), query, limit)
    return hits.map((h) => ({
      source: 'tmdb' as const,
      source_id: h.source_id,
      // No MAL id exists for these, and inventing one would put a fake row in
      // the namespace the whole anime pipeline keys on.
      mal_id: null,
      title: h.title,
      synopsis: h.synopsis,
      image_url: h.image_url,
      url: h.url,
      year: h.year,
      type: h.type,
      status: h.status,
      episodes: h.episodes,
    }))
  },

  async detail(section: PortalSection, sourceId: number): Promise<TitleDetail> {
    const t: TmdbTitle = await fetchTmdbTitle(kindFor(section), sourceId)
    return {
      source: 'tmdb',
      source_id: t.source_id,
      mal_id: null,
      title: t.title,
      synopsis: t.synopsis,
      image_url: t.image_url,
      url: t.url,
      year: t.year,
      type: t.type,
      status: t.status,
      episodes: t.episodes,
      imdb_id: t.imdb_id,
      tvdb_id: t.tvdb_id,
      metadata: {
        // TMDB has one localised title and one original; the catalog's two
        // title columns are english/japanese, so original_title goes in the
        // second slot rather than being dropped.
        title_english: t.title,
        title_japanese: t.original_title,
        type: t.type,
        episodes: t.episodes,
        status: t.status,
        score: t.score,
        year: t.year,
        // TMDB has no notion of a broadcast season (Winter/Spring/…) — that's
        // an anime-scheduling concept.
        season: null,
        aired: null,
        studios: JSON.stringify(t.studios),
        genres: JSON.stringify(t.genres),
        broadcast: null,
      },
    }
  },
}
