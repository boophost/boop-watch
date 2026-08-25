#!/usr/bin/env node
/**
 * Mint a real Supabase browser session for the QA agent, so it can drive
 * `/manage` instead of skipping every item there.
 *
 * ## Why this exists
 *
 * `/manage` is a client-rendered SPA behind **Supabase** auth: `fetchAuth` sends
 * the Supabase session token, and `AuthContext` reads the session out of
 * localStorage. The QA prompt used to hand the agent the HS256 admin JWT minted
 * from `JWT_SECRET` and tell it to fabricate a localStorage entry around it.
 * That can never work. The JWT is accepted by `/api/*` only because the server
 * keeps a `jwt.verify` fallback; supabase-js rejects it outright — wrong issuer,
 * wrong signing key, no refresh token it can use. So the agent would seed a
 * session, reload, still be logged out, and mark every `/manage` item `skip`.
 *
 * That is issue #293, and it is not a small hole: an entire UI redesign of
 * /manage was graded 1/10 with the other nine items "verified" by reading the
 * source, which is not verification at all.
 *
 * ## How
 *
 * Supabase's admin API will mint a magic-link token for any user without a
 * password, and `/auth/v1/verify` exchanges it for a genuine session:
 *
 *   1. POST /auth/v1/admin/generate_link  (service-role key) → hashed_token
 *   2. POST /auth/v1/verify               (anon key)         → full session
 *   3. localStorage['sb-<ref>-auth-token'] = <session JSON>
 *
 * `<ref>` is the first label of the Supabase host, which is how supabase-js
 * derives its storage key — for `https://dev-boop-watch.boopurno.es` that is
 * `sb-dev-boop-watch-auth-token`.
 *
 * Sessions last an hour, which is longer than a QA run, so this mints once per
 * run rather than trying to refresh.
 *
 * ## Inputs
 *
 * `SUPABASE_URL` and `SUPABASE_ANON_KEY` are read from the preview's own
 * `/config.js` rather than passed in — they are public by design (the browser
 * gets them), and reading them from the app guarantees the session is for the
 * exact project the SPA will talk to. Only the service-role key and the email
 * have to be supplied.
 */

import { pathToFileURL } from 'node:url'

/** Pull window.ENV out of the app's /config.js without executing it. */
export async function readAppConfig(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/config.js`)
  if (!res.ok) throw new Error(`GET /config.js → ${res.status}`)
  const body = await res.text()
  const url = body.match(/["']?SUPABASE_URL["']?\s*:\s*["']([^"']+)["']/)?.[1]
  const anon = body.match(/["']?SUPABASE_ANON_KEY["']?\s*:\s*["']([^"']+)["']/)?.[1]
  if (!url || !anon) throw new Error('config.js carried no SUPABASE_URL / SUPABASE_ANON_KEY')
  return { supabaseUrl: url.replace(/\/$/, ''), anonKey: anon }
}

/** supabase-js derives its localStorage key from the project ref — the first
 * label of the Supabase host. */
export function storageKeyFor(supabaseUrl) {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
}

export async function mintSupabaseSession({ supabaseUrl, anonKey, serviceRoleKey, email }) {
  if (!serviceRoleKey) throw new Error('no service-role key')
  if (!email) throw new Error('no admin email')

  const gen = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email }),
  })
  if (!gen.ok) throw new Error(`generate_link → ${gen.status} ${(await gen.text()).slice(0, 200)}`)
  const { hashed_token: tokenHash } = await gen.json()
  if (!tokenHash) throw new Error('generate_link returned no hashed_token')

  const ver = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  })
  if (!ver.ok) throw new Error(`verify → ${ver.status} ${(await ver.text()).slice(0, 200)}`)
  const session = await ver.json()
  if (!session?.access_token) throw new Error('verify returned no access_token')

  return { key: storageKeyFor(supabaseUrl), session }
}

/**
 * Best-effort: returns `{ key, session }` or `null`, never throws.
 *
 * Deliberately non-fatal. A QA run that can only check the public portal is far
 * better than no QA run, and the prompt says plainly what is unavailable so the
 * agent skips /manage items honestly instead of inventing evidence for them.
 */
export async function trySupabaseSession({ baseUrl, serviceRoleKey, email }) {
  try {
    const { supabaseUrl, anonKey } = await readAppConfig(baseUrl)
    return await mintSupabaseSession({ supabaseUrl, anonKey, serviceRoleKey, email })
  } catch (e) {
    console.warn(`⚠️  Could not mint a /manage session: ${e instanceof Error ? e.message : e}`)
    console.warn('   The agent will skip /manage UI items rather than guess at them.')
    return null
  }
}

/**
 * Preflight: prove the minted session is one the *app* accepts.
 *
 * `requireAuth` validates a Bearer token against Supabase `/auth/v1/user`, so a
 * session good enough for `/api/me` is the same session the SPA will accept out
 * of localStorage. That makes this checkable without a browser or an LLM — which
 * matters, because the failure this guards against is silent: a broken session
 * does not error, it just quietly sends every /manage item back to `skip`.
 */
export async function checkSession(baseUrl, { key, session }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/me`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`GET /api/me with the minted session → ${res.status}`)
  const me = await res.json().catch(() => ({}))
  return { key, email: me.email ?? session.user?.email ?? null, isAdmin: me.isAdmin ?? me.admin ?? null }
}

// CLI: node scripts/qa-agent/supabase-session.mjs <baseUrl>
// Env: SUPABASE_SERVICE_ROLE_KEY, QA_ADMIN_EMAIL (or ADMIN_EMAILS)
// pathToFileURL rather than string-building `file://…`: on Windows the manual
// form yields two slashes where Node emits three, so the guard silently never
// fires and the CLI looks like it did nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.argv[2] || process.env.BASE_URL
  if (!baseUrl) {
    console.error('Usage: supabase-session.mjs <baseUrl>')
    process.exit(2)
  }
  const out = await trySupabaseSession({
    baseUrl,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    email: (process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAILS || '').split(',')[0].trim(),
  })
  if (!out) {
    console.error('❌ Could not mint a /manage session — the QA agent will skip every /manage UI item.')
    process.exit(1)
  }
  console.log(`localStorage key: ${out.key}`)
  console.log(`access_token: ${String(out.session.access_token).slice(0, 12)}… (${String(out.session.access_token).length} chars)`)
  console.log(`user: ${out.session.user?.email ?? '(unknown)'}`)
  try {
    const ok = await checkSession(baseUrl, out)
    console.log(`✅ the app accepts it: /api/me → ${ok.email}${ok.isAdmin != null ? ` (admin: ${ok.isAdmin})` : ''}`)
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : e}`)
    console.error('   The session was minted but the app rejects it — /manage QA would silently degrade to skips.')
    process.exit(1)
  }
}
