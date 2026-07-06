/** PostHog reverse-proxy + runtime config (server-side). */

export const POSTHOG_INGEST_PREFIX = '/ingest'

export type PosthogRegion = 'us' | 'eu'

export function posthogRegion(): PosthogRegion {
  const host = process.env.POSTHOG_HOST || ''
  return host.includes('eu') ? 'eu' : 'us'
}

export function posthogApiHost(region: PosthogRegion = posthogRegion()): string {
  return region === 'eu' ? 'eu.i.posthog.com' : 'us.i.posthog.com'
}

export function posthogAssetHost(region: PosthogRegion = posthogRegion()): string {
  return region === 'eu' ? 'eu-assets.i.posthog.com' : 'us-assets.i.posthog.com'
}

export function posthogUiHost(region: PosthogRegion = posthogRegion()): string {
  return region === 'eu' ? 'https://eu.posthog.com' : 'https://us.posthog.com'
}
