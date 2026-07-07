import posthog from 'posthog-js'
import { isTrackedPortalPath, pathnameOf } from './analyticsPaths'

const env = (window as { ENV?: Record<string, string> }).ENV || {}
const key = import.meta.env.VITE_POSTHOG_KEY || env.POSTHOG_KEY || ''
const uiHost =
  import.meta.env.VITE_POSTHOG_UI_HOST || env.POSTHOG_UI_HOST || 'https://us.posthog.com'

let initialized = false

export type AuthState = 'anonymous' | 'authenticated'

export function isAnalyticsEnabled(): boolean {
  return Boolean(key)
}

export function initAnalytics(): void {
  if (initialized || !key) return
  initialized = true
  posthog.init(key, {
    api_host: '/ingest',
    ui_host: uiHost,
    defaults: '2026-01-30',
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: {
      url_ignorelist: [
        '/manage',
        '/manage/*',
        '/login',
        '/signup',
      ],
    },
    persistence: 'localStorage',
    disable_session_recording: true,
  })
}

function pageProps(path: string): Record<string, string> {
  const pathname = pathnameOf(path)
  return {
    $current_url: `${window.location.origin}${path}`,
    $pathname: pathname,
  }
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return
  posthog.capture(event, properties)
}

export interface IdentifyProps {
  email?: string
  name?: string
  provider?: string
  is_admin?: boolean
  created_at?: string
}

/**
 * Link the current visitor to a boop-watch account (Supabase user id). Because
 * `person_profiles: 'identified_only'`, this is what actually creates the
 * PostHog person and folds the prior anonymous events into it — never call
 * `reset()` on login or the merge is lost.
 */
export function identifyUser(distinctId: string, props: IdentifyProps): void {
  if (!initialized || !distinctId) return
  const set: Record<string, unknown> = {}
  if (props.email) set.email = props.email
  if (props.name) set.name = props.name
  if (props.provider) set.provider = props.provider
  if (typeof props.is_admin === 'boolean') set.is_admin = props.is_admin
  const setOnce: Record<string, unknown> = {}
  if (props.created_at) setOnce.created_at = props.created_at
  posthog.identify(distinctId, set, setOnce)
}

export function trackPageView(path: string): void {
  if (!initialized || !isTrackedPortalPath(path)) return
  posthog.capture('$pageview', pageProps(path))
}

export function trackPageLeave(path: string): void {
  if (!initialized || !isTrackedPortalPath(path)) return
  posthog.capture('$pageleave', pageProps(path))
}

export function resetAnalytics(): void {
  if (!initialized) return
  posthog.reset()
}
