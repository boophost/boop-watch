// One interface over the catalogs that own title identity, so the admin API
// and the /manage UI don't grow a branch per section.
//
// The two implementations are deliberately thin: `mal.ts` is a wrapper around
// the existing AniList/Jikan code (which keeps working exactly as it did —
// this is not a rewrite of the anime path), and `tmdb.ts` maps the TMDB client.
// Everything section-specific is decided by `sectionProvider()`, so adding a
// fourth section later is a registry entry plus, at most, one new client.
import type { PortalSection } from '../portalDb.js'
import type { SeriesMetadata } from '../db.js'
import { sectionProvider, type MetadataProvider } from '../sections.js'

/**
 * A search result, normalised across providers.
 *
 * `source` + `source_id` are the identity half — together with the section
 * they form the catalog's unique key. `mal_id` rides along only for anime
 * (where it is the same number as `source_id`) because the whole sourcing
 * pipeline still speaks it.
 */
export interface TitleHit {
  source: MetadataProvider
  source_id: number
  mal_id: number | null
  title: string
  synopsis: string
  image_url: string | null
  url: string
  year: number | null
  /** MAL-style media type: TV | Movie | OVA | ONA | Special | Music. */
  type: string | null
  status: string | null
  episodes: number | null
  /** Set by the route: is this already in our catalog? */
  inCatalog?: boolean
}

/** Everything needed to create and enrich a catalog row for one title. */
export interface TitleDetail extends TitleHit {
  imdb_id: string | null
  tvdb_id: number | null
  /** The columns `upsertSeriesMetadata` writes. */
  metadata: SeriesMetadata
}

export interface MetadataClient {
  readonly provider: MetadataProvider
  /** False ⇒ the provider has no credentials; callers should 503 rather than return nothing. */
  readonly configured: boolean
  /** Why it isn't configured, for the error body. Empty when it is. */
  readonly unconfiguredReason: string
  search(section: PortalSection, query: string, limit?: number): Promise<TitleHit[]>
  detail(section: PortalSection, sourceId: number): Promise<TitleDetail>
}

// Imported after the interface so the modules can type against it.
import { malClient } from './mal.js'
import { tmdbClient } from './tmdb.js'

const CLIENTS: Record<MetadataProvider, MetadataClient> = {
  mal: malClient,
  tmdb: tmdbClient,
}

/** The client that owns identity for titles in this section. */
export const clientForSection = (section: PortalSection): MetadataClient =>
  CLIENTS[sectionProvider(section)]

export const clientForProvider = (provider: MetadataProvider): MetadataClient => CLIENTS[provider]
