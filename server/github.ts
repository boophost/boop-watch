// GitHub App client — the "bot" that files issues on behalf of the portal.
//
// User suggestions used to become rows in `series.sqlite`, which meant prod and
// staging each had their own board (they drifted, and engineering work got mixed
// in with user requests). Suggestions now open a **GitHub issue** instead, so
// there's one tracker that links to the code that fixes it.
//
// Auth is the existing GitHub App (the one that opens the promotion PR): sign a
// short App JWT with the private key, exchange it for an installation token, and
// cache that until just before it expires. Configured from env — if it isn't
// configured the caller must 503 rather than silently drop a user's suggestion.

import jwt from 'jsonwebtoken'

const API = 'https://api.github.com'

const appId = (): string => (process.env.GITHUB_APP_ID ?? '').trim()
// The private key is a PEM. Env vars can't hold raw newlines in every deploy
// path, so accept the common `\n`-escaped form too.
const privateKey = (): string => (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim()
/** owner/repo the bot files issues into. */
export const githubRepo = (): string => (process.env.GITHUB_REPO ?? 'boophost/boop-watch').trim()

export function githubConfigured(): boolean {
  return Boolean(appId() && privateKey())
}

async function gh<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : null) as T
}

/** Short-lived JWT identifying the *App* (not an installation). */
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId() }, // 10-min max; clock-skew margin
    privateKey(),
    { algorithm: 'RS256' },
  )
}

// Installation tokens last an hour; cache and refresh a minute early.
let cached: { token: string; expiresAt: number } | null = null

async function installationToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token
  const j = appJwt()
  const { id } = await gh<{ id: number }>(`/repos/${githubRepo()}/installation`, j)
  const res = await gh<{ token: string; expires_at: string }>(
    `/app/installations/${id}/access_tokens`,
    j,
    { method: 'POST' },
  )
  cached = { token: res.token, expiresAt: new Date(res.expires_at).getTime() }
  return res.token
}

export interface CreatedIssue {
  number: number
  url: string
}

export async function createIssue(opts: {
  title: string
  body: string
  labels?: string[]
}): Promise<CreatedIssue> {
  if (!githubConfigured()) throw new Error('GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)')
  const token = await installationToken()
  const issue = await gh<{ number: number; html_url: string }>(`/repos/${githubRepo()}/issues`, token, {
    method: 'POST',
    body: JSON.stringify({ title: opts.title, body: opts.body, labels: opts.labels ?? [] }),
  })
  return { number: issue.number, url: issue.html_url }
}
