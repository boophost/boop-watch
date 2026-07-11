#!/usr/bin/env node
/**
 * Periodic prod → staging catalog sync.
 *
 *   node scripts/sync-catalog.mjs [--dry-run]
 *
 * Prod is the management source of truth (you add shows on watch.boopurno.es),
 * but staging is the executor that actually sources + imports into the shared
 * Jellyfin library. The two have separate DBs, so a show added on prod never
 * reaches staging on its own — it just doesn't download. This copies every
 * catalog entry that exists on prod but not staging into staging (by mal_id), so
 * staging's flows pick it up. One-way, additive: it never deletes from staging
 * or overwrites staging-only entries.
 *
 * Only mal_id + title are copied — staging's `enrich.metadata` flow node fills in
 * year/tvdb/english-title/etc. (same as adding a show through /manage).
 *
 * Env:
 *   PROD_URL, STAGING_URL   base URLs (default the in-cluster Service DNS)
 *   PROD_JWT_SECRET, STAGING_JWT_SECRET   to mint admin tokens
 *   SYNC_ADMIN_EMAIL        default ethanwhi@gmail.com (must be in ADMIN_EMAILS)
 */

import { createHmac } from 'node:crypto'

const PROD_URL = (process.env.PROD_URL || 'http://boop-watch.link-apps.svc.cluster.local').replace(/\/$/, '')
const STAGING_URL = (process.env.STAGING_URL || 'http://boop-watch-dev.link-apps.svc.cluster.local').replace(/\/$/, '')
const EMAIL = process.env.SYNC_ADMIN_EMAIL || 'ethanwhi@gmail.com'
const DRY = process.argv.includes('--dry-run')

function mintToken(secret) {
  if (!secret) throw new Error('missing JWT secret')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const payload = b64({ email: EMAIL, username: EMAIL, iat: now, exp: now + 600 })
  const sig = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data }
}

function seriesList(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.series ?? [])
  return rows.filter((r) => r && Number.isFinite(Number(r.mal_id)))
}

async function main() {
  const prodTok = mintToken(process.env.PROD_JWT_SECRET)
  const stageTok = mintToken(process.env.STAGING_JWT_SECRET)

  const prod = await api(PROD_URL, prodTok, 'GET', '/api/series')
  const stage = await api(STAGING_URL, stageTok, 'GET', '/api/series')
  if (prod.status !== 200) throw new Error(`prod /api/series ${prod.status}: ${JSON.stringify(prod.data).slice(0, 200)}`)
  if (stage.status !== 200) throw new Error(`staging /api/series ${stage.status}: ${JSON.stringify(stage.data).slice(0, 200)}`)

  const prodRows = seriesList(prod.data)
  const stageIds = new Set(seriesList(stage.data).map((r) => Number(r.mal_id)))
  const missing = prodRows.filter((r) => !stageIds.has(Number(r.mal_id)))

  console.log(`prod: ${prodRows.length} series | staging: ${stageIds.size} | missing on staging: ${missing.length}`)
  if (!missing.length) { console.log('catalogs in sync — nothing to do.'); return }

  for (const r of missing) {
    const label = `${r.mal_id} ${String(r.title ?? '').slice(0, 50)}`
    if (DRY) { console.log(`  would add: ${label}`); continue }
    const resp = await api(STAGING_URL, stageTok, 'POST', '/api/series', {
      mal_id: Number(r.mal_id),
      title: r.title,
      synopsis: r.synopsis ?? null,
      image_url: r.image_url ?? r.image ?? null,
      url: r.url ?? null,
    })
    if (resp.status === 201) console.log(`  added: ${label}`)
    else if (resp.status === 409) console.log(`  (already present): ${label}`)
    else console.warn(`  FAILED (${resp.status}): ${label} — ${JSON.stringify(resp.data).slice(0, 120)}`)
  }
  console.log(DRY ? 'dry-run complete (no changes made).' : 'sync complete.')
}

main().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
