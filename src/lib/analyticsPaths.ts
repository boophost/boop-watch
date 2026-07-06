/** Portal routes excluded from PostHog pageviews, pageleaves, and autocapture. */
export const ANALYTICS_IGNORE_PREFIXES = ['/manage', '/login', '/signup'] as const

export function isTrackedPortalPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? path
  return !ANALYTICS_IGNORE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/** Pathname only — stable key for paths/heatmaps (query strings vary). */
export function pathnameOf(path: string): string {
  return path.split('?')[0] ?? path
}
