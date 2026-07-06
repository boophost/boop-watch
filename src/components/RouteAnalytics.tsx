import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { initAnalytics, trackPageLeave, trackPageView } from '@/lib/analytics'
import { isTrackedPortalPath } from '@/lib/analyticsPaths'

/** SPA pageviews + pageleaves for PostHog — skips admin and auth routes. */
export function RouteAnalytics() {
  const location = useLocation()
  const prevPath = useRef<string | null>(null)

  useEffect(() => {
    initAnalytics()
  }, [])

  useEffect(() => {
    const path = location.pathname + location.search
    const prev = prevPath.current
    if (prev && isTrackedPortalPath(prev)) trackPageLeave(prev)
    if (isTrackedPortalPath(path)) trackPageView(path)
    prevPath.current = path
  }, [location])

  return null
}
