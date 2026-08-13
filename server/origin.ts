import type { Request } from 'express'

/** Public origin of the request, for absolute URLs (share cards, Discord
 * activity art, OAuth redirects). The forwarded-proto header can't be trusted:
 * TLS terminates at the Cloudflare edge and Traefik receives plain HTTP on the
 * `web` entrypoint, so it stamps X-Forwarded-Proto: http even though every
 * public host is https-only. Force https for anything that isn't local. */
export function reqOrigin(req: Request): string {
  const fwdHost = req.headers['x-forwarded-host']
  const host = (typeof fwdHost === 'string' ? fwdHost.split(',')[0].trim() : '') || req.headers.host || ''
  const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(host)
  return `${isLocal ? req.protocol : 'https'}://${host}`
}
