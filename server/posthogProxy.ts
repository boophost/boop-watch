import type { Request, Response, NextFunction } from 'express'

const PREFIX = '/ingest'

function posthogHosts(): { api: string; assets: string } {
  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com'
  if (host.includes('eu')) {
    return { api: 'eu.i.posthog.com', assets: 'eu-assets.i.posthog.com' }
  }
  return { api: 'us.i.posthog.com', assets: 'us-assets.i.posthog.com' }
}

/** Reverse-proxy PostHog ingest + static assets through our domain (ad-blocker evasion). */
export function posthogProxy(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? ''
  if (!url.startsWith(PREFIX)) {
    next()
    return
  }

  const pathname = url.slice(PREFIX.length) || '/'
  const { api, assets } = posthogHosts()
  const useAssets = pathname.startsWith('/static/') || pathname.startsWith('/array/')
  const targetHost = useAssets ? assets : api

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
