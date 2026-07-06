// HTTP client for the admin flow API (server/flowRoutes.ts), shared by the MCP
// server and the CLI. Auth: the flow API accepts a Supabase Bearer token OR a
// JWT_SECRET-signed token (requireAuth falls through to jwt.verify). We mint the
// latter with the same secret + an ADMIN_EMAILS address, so no live Supabase
// login is needed for local iteration. Point BOOP_API at a port-forward of the
// staging pod (see mcp/README.md).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import { Agent, setGlobalDispatcher } from 'undici'

const here = path.dirname(fileURLToPath(import.meta.url))

// A live flow run blocks the HTTP response until every node finishes — a big
// batch (per-item Jikan rate limits + ffmpeg extraction) easily exceeds undici's
// default 5-min headersTimeout, which would abort the client even though the run
// completes server-side. Disable those idle timeouts (0) and let the per-request
// AbortSignal below be the only bound.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

// Load mcp/flows.env (gitignored — holds the staging JWT secret) into the
// environment without clobbering anything already set by the caller.
function loadEnv() {
  const f = path.join(here, 'flows.env')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}

function cfg() {
  loadEnv()
  return {
    base: (process.env.BOOP_API || 'http://localhost:8080').replace(/\/$/, ''),
    email: process.env.BOOP_ADMIN_EMAIL || 'admin@example.com',
    token: process.env.BOOP_TOKEN || '',
    secret: process.env.BOOP_JWT_SECRET || '',
  }
}

function authToken() {
  const { token, secret, email } = cfg()
  if (token) return token
  if (!secret) {
    throw new Error('No admin credential: set BOOP_TOKEN or BOOP_JWT_SECRET in mcp/flows.env')
  }
  // Shape matches what requireAuth reads (email drives requireAdmin).
  return jwt.sign({ email, username: email }, secret, { expiresIn: '12h' })
}

async function api(method, p, body) {
  const { base } = cfg()
  const res = await fetch(base + p, {
    method,
    headers: {
      Authorization: `Bearer ${authToken()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Live runs hit rate-limited upstreams (Jikan ~1/s), so allow plenty of time.
    signal: AbortSignal.timeout(600_000),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && data.error ? data.error : `${res.status} ${res.statusText}`
    throw new Error(`${method} ${p} -> ${msg}`)
  }
  return data
}

export const flows = {
  nodeTypes: () => api('GET', '/api/flows/node-types'),
  list: () => api('GET', '/api/flows'),
  get: (id) => api('GET', `/api/flows/${Number(id)}`),
  create: (name, description) => api('POST', '/api/flows', { name, description: description ?? null }),
  save: (id, patch) => api('PUT', `/api/flows/${Number(id)}`, patch),
  remove: (id) => api('DELETE', `/api/flows/${Number(id)}`),
  run: (id, dryRun = true) => api('POST', `/api/flows/${Number(id)}/run`, { dryRun }),
  // Rolling activity log (one entry per flow run, editor or scheduler or MCP).
  runs: (limit = 100) => api('GET', `/api/flows/runs?limit=${Number(limit)}`),
}

// Scheduled flow runs. A schedule = { flowId, kind, spec, dryRun?, enabled? }.
// kind/spec: 'interval' {every,unit:'minutes'|'hours'} | 'daily' {at:'HH:MM'} |
// 'weekly' {day:'sun'..'sat',at} | 'once' {runAt:ISO}.
export const schedules = {
  list: () => api('GET', '/api/schedules'),
  get: (id) => api('GET', `/api/schedules/${Number(id)}`),
  create: (input) => api('POST', '/api/schedules', input),
  update: (id, patch) => api('PUT', `/api/schedules/${Number(id)}`, patch),
  remove: (id) => api('DELETE', `/api/schedules/${Number(id)}`),
  run: (id) => api('POST', `/api/schedules/${Number(id)}/run`),
}

export { cfg }
