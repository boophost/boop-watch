import posthog from 'posthog-js'

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
    capture_pageview: false,
    capture_pageleave: true,
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

export function trackPageLeave(path: string): void {
  if (!initialized) return
  posthog.capture('$pageleave', { $current_url: `${window.location.origin}${path}` })
}

export function resetAnalytics(): void {
  if (!initialized) return
  posthog.reset()
}
