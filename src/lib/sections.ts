// The portal's three sections — each backed by its own Jellyfin collection
// (server-side WATCH_COLLECTION_ID / _TV / _MOVIES). The server tells us which
// are actually configured via /api/catalog's `sections`.

export type Section = 'anime' | 'tv' | 'movies'
/** Server-side spelling; same union. */
export type PortalSection = Section

export const SECTION_LABELS: Record<Section, string> = {
  anime: 'Anime',
  tv: 'TV',
  movies: 'Movies',
}

/** Browse route per section — anime keeps the root, matching the pre-section portal. */
export const SECTION_PATHS: Record<Section, string> = {
  anime: '/',
  tv: '/tv',
  movies: '/movies',
}

/** The section a browse pathname addresses; null off the browse pages. */
export function sectionFromPath(pathname: string): Section | null {
  if (pathname === '/') return 'anime'
  if (pathname === '/tv') return 'tv'
  if (pathname === '/movies') return 'movies'
  return null
}

/** Narrow an arbitrary string (a URL param) to a Section. */
export const isSection = (s: string): s is Section =>
  s === 'anime' || s === 'tv' || s === 'movies'
