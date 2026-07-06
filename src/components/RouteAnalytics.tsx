import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { initAnalytics, trackPageLeave, trackPageView } from '@/lib/analytics'

function trackedPortalPath(path: string): boolean {
  return !path.startsWith('/manage') && path !== '/login'
}

/** SPA pageviews + pageleaves for PostHog — skips admin and login routes. */
export function RouteAnalytics() {
  const location = useLocation()
  const prevPath = useRef<string | null>(null)

  useEffect(() => {
    initAnalytics()
  }, [])

  useEffect(() => {
    const path = location.pathname + location.search
    const prev = prevPath.current
    if (prev && trackedPortalPath(prev)) trackPageLeave(prev)
    if (trackedPortalPath(path)) trackPageView(path)
    prevPath.current = path
  }, [location])

  return null
}
