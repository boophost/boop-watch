import posthog from 'posthog-js'

const env = (window as { ENV?: Record<string, string> }).ENV || {}
const key = import.meta.env.VITE_POSTHOG_KEY || env.POSTHOG_KEY || ''
const host =
  import.meta.env.VITE_POSTHOG_HOST || env.POSTHOG_HOST || 'https://us.i.posthog.com'

let initialized = false

export type AuthState = 'anonymous' | 'authenticated'

export function isAnalyticsEnabled(): boolean {
  return Boolean(key)
}

export function initAnalytics(): void {
  if (initialized || !key) return
  initialized = true
  posthog.init(key, {
    api_host: host,
    capture_pageview: false,
    autocapture: true,
    persistence: 'localStorage',
    disable_session_recording: true,
  })
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return
  posthog.capture(event, properties)
}

export function trackPageView(path: string): void {
  if (!initialized) return
  posthog.capture('$pageview', { $current_url: `${window.location.origin}${path}` })
}

export function resetAnalytics(): void {
  if (!initialized) return
  posthog.reset()
}
