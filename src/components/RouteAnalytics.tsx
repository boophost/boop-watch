import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { initAnalytics, trackPageView } from '@/lib/analytics'

/** SPA pageviews for PostHog — skips admin and login routes. */
export function RouteAnalytics() {
  const location = useLocation()

  useEffect(() => {
    initAnalytics()
  }, [])

  useEffect(() => {
    const path = location.pathname + location.search
    if (path.startsWith('/manage') || path === '/login') return
    trackPageView(path)
  }, [location])

  return null
}
