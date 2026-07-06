import type { Request, Response, NextFunction } from 'express'
import {
  POSTHOG_INGEST_PREFIX,
  posthogApiHost,
  posthogAssetHost,
  posthogRegion,
} from './posthogConfig.js'

/** Reverse-proxy PostHog ingest + static assets through our domain (ad-blocker evasion). */
export function posthogProxy(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? ''
  if (!url.startsWith(POSTHOG_INGEST_PREFIX)) {
    next()
    return
  }

  const pathname = url.slice(POSTHOG_INGEST_PREFIX.length) || '/'
  const region = posthogRegion()
  const useAssets = pathname.startsWith('/static/') || pathname.startsWith('/array/')
  const targetHost = useAssets ? posthogAssetHost(region) : posthogApiHost(region)

  const headers = new Headers()
  for (const [key, values] of Object.entries(req.headers)) {
    if (!values || key === 'host' || key === 'connection' || key === 'cookie') continue
    const v = Array.isArray(values) ? values.join(', ') : values
    headers.set(key, v)
  }
  headers.set('host', targetHost)
  if (req.headers.host) headers.set('X-Forwarded-Host', req.headers.host)
  const ip = req.socket.remoteAddress
  if (ip) {
    headers.set('X-Real-IP', ip)
    headers.set('X-Forwarded-For', ip)
  }

  const method = req.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = req as unknown as BodyInit
    init.duplex = 'half'
  }

  fetch(new URL(pathname, `https://${targetHost}`), init)
    .then(async (upstream) => {
      res.status(upstream.status)
      upstream.headers.forEach((value, key) => {
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return
        res.setHeader(key, value)
      })
      const body = Buffer.from(await upstream.arrayBuffer())
      res.end(body)
    })
    .catch((err) => {
      console.error('[posthog-proxy]', err)
      res.status(502).end()
    })
}
