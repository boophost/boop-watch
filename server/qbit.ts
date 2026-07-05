// Shared qBittorrent WebUI v2 client, configured from env (QBIT_URL /
// QBIT_USERNAME / QBIT_PASSWORD). Used by the series-detail download panel to
// show progress and remove torrents. The flow sink node has its own inline
// client because its connection is configurable per-node.

const base = (): string => (process.env.QBIT_URL ?? '').replace(/\/$/, '')

export function qbitConfigured(): boolean {
  return Boolean(base())
}

export interface QbitTorrent {
  hash: string
  name: string
  state: string
  progress: number
  dlspeed: number
  size: number
  num_seeds: number
  num_leechs: number
  eta: number
  category: string
  added_on: number
}

async function login(): Promise<string> {
  const res = await fetch(`${base()}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.QBIT_USERNAME ?? 'admin',
      password: process.env.QBIT_PASSWORD ?? '',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!res.ok || !cookie || !(await res.text()).includes('Ok')) {
    throw new Error('qBittorrent login failed')
  }
  return cookie
}

export async function qbitList(category?: string): Promise<QbitTorrent[]> {
  const cookie = await login()
  const q = category ? `?category=${encodeURIComponent(category)}` : ''
  const res = await fetch(`${base()}/api/v2/torrents/info${q}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`qBittorrent list failed (${res.status})`)
  return (await res.json()) as QbitTorrent[]
}

export async function qbitDelete(hashes: string[], deleteFiles: boolean): Promise<void> {
  if (hashes.length === 0) return
  const cookie = await login()
  const res = await fetch(`${base()}/api/v2/torrents/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: String(deleteFiles) }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`qBittorrent delete failed (${res.status})`)
}
