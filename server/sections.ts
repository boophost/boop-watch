// Per-section facts the manager needs, in one place.
//
// The portal already knows the three sections exist (PortalSection in
// portalDb.ts, one Jellyfin collection each in jellyfin.ts). What it does NOT
// carry is how a section is *managed*: which metadata provider owns a title's
// identity, where its files land on disk, and what the import path looks like.
// Those are the facts the /manage catalog, the admin APIs and the flow nodes
// all need, and they were previously hardcoded as "anime" throughout.
//
// Deliberately NOT merged into jellyfin.ts: that module is the Jellyfin access
// layer and importing it drags the whole HLS/proxy surface into anything that
// only wants to know a section's metadata provider (db.ts, for one, which
// jellyfin.ts already depends on transitively via sync.ts).
import { PORTAL_SECTIONS, type PortalSection } from './portalDb.js'
// Import cycle, deliberate and safe: db.ts → sections.ts → config.ts → db.ts.
// It resolves because `getDb` is a hoisted function *declaration* and nothing
// here calls it during module evaluation. Keep it that way — a top-level
// cfg()/getDb() call in any of these three modules would break the cycle.
import { cfgSafe } from './config.js'

/**
 * Which external catalog owns a title's identity in a section.
 *
 * `mal` is the anime stack (AniList-primary, Jikan/MAL fallback) that predates
 * sections. `tmdb` covers both TV and movies from one client, and its
 * external_ids response carries imdb_id and tvdb_id, so the other two id
 * namespaces come along for free and line up with whatever Jellyfin matched.
 */
export type MetadataProvider = 'mal' | 'tmdb'

export interface SectionConfig {
  section: PortalSection
  label: string
  /** Catalog that owns identity for titles in this section. */
  provider: MetadataProvider
  /** Where sink.library-import places this section's files. */
  libraryRoot: string
  /**
   * Default relative destination path for an import (no extension). Movies get
   * a flat `Title (year)/Title (year)` because Jellyfin's movie scanner wants
   * one folder per film, with no season layer.
   */
  pathTemplate: string
  /** Jellyfin CollectionType of the underlying library, for cross-checking. */
  collectionType: 'tvshows' | 'movies'
}

const SERIES_TEMPLATE =
  '{show} ({production_year})/Season {season:2}/{show} - S{season:2}E{torrent_episode:2}'
const MOVIE_TEMPLATE = '{show} ({production_year})/{show} ({production_year})'

// LIBRARY_DIR keeps its historical meaning (the anime library — it was the only
// one when the import sink was written), so an existing deployment that sets
// only LIBRARY_DIR keeps working untouched. The other two default to siblings
// of it rather than to /library, because in practice all three libraries live
// on the same media NFS and a wrong default that *looks* plausible is worse
// than one that is obviously unset.
// Read through cfg() so /manage/settings can own these, and read *per call* so
// a change takes effect without a pod roll. cfgSafe falls back to the spec
// default rather than throwing on a hot path.
const LIBRARY_ROOTS: Record<PortalSection, () => string> = {
  anime: () => cfgSafe('LIBRARY_DIR'),
  tv: () => cfgSafe('LIBRARY_DIR_TV'),
  movies: () => cfgSafe('LIBRARY_DIR_MOVIES'),
}

const SECTION_DEFS: Record<PortalSection, Omit<SectionConfig, 'libraryRoot'>> = {
  anime: {
    section: 'anime',
    label: 'Anime',
    provider: 'mal',
    pathTemplate: SERIES_TEMPLATE,
    collectionType: 'tvshows',
  },
  tv: {
    section: 'tv',
    label: 'TV',
    provider: 'tmdb',
    pathTemplate: SERIES_TEMPLATE,
    collectionType: 'tvshows',
  },
  movies: {
    section: 'movies',
    label: 'Movies',
    provider: 'tmdb',
    pathTemplate: MOVIE_TEMPLATE,
    collectionType: 'movies',
  },
}

/** Full config for a section. Roots are read per call so tests can set env. */
export function sectionConfig(section: PortalSection): SectionConfig {
  return { ...SECTION_DEFS[section], libraryRoot: LIBRARY_ROOTS[section]() }
}

/** Every section's config, in display order. */
export const sectionConfigs = (): SectionConfig[] => PORTAL_SECTIONS.map(sectionConfig)

/** The metadata provider that owns identity for titles in this section. */
export const sectionProvider = (section: PortalSection): MetadataProvider =>
  SECTION_DEFS[section].provider

/** Where this section's imported files land. */
export const sectionLibraryRoot = (section: PortalSection): string => LIBRARY_ROOTS[section]()

/**
 * The section a provider id belongs to is ambiguous for tmdb (tv and movies
 * share it), so identity is always the (section, source, source_id) triple —
 * never source_id alone. This is the guard that keeps callers honest.
 */
export function assertProviderMatchesSection(
  section: PortalSection,
  provider: MetadataProvider,
): void {
  const expected = sectionProvider(section)
  if (provider !== expected) {
    throw new Error(
      `Section "${section}" is sourced from ${expected}, not ${provider}`,
    )
  }
}
