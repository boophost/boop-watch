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
  tags?: string
  added_on: number
  content_path?: string
  save_path?: string
}

/**
 * Identity we stamped on the torrent when we queued it (`mal:59970`, `season:4`,
 * `ep:5`). Reading it back beats re-deriving the cour from a release name — that
 * is how "…4th Season - 05" ended up matched to the season-1 catalog row.
 */
export function parseTorrentTags(tags: string | undefined): {
  tag_mal_id: number | null
  tag_season: number | null
  tag_episode: number | null
} {
  const out = { tag_mal_id: null as number | null, tag_season: null as number | null, tag_episode: null as number | null }
  for (const raw of (tags ?? '').split(',')) {
    const [k, v] = raw.trim().split(':')
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    if (k === 'mal') out.tag_mal_id = n
    else if (k === 'season') out.tag_season = n
    else if (k === 'ep') out.tag_episode = n
  }
  return out
}

/** Map a qBittorrent torrent to the flow-item shape source.qbittorrent emits, so
 * the "Download complete" trigger's payload is a drop-in `torrent` record. */
export function qbitToItem(t: QbitTorrent): Record<string, unknown> {
  return {
    name: t.name,
    torrent_hash: t.hash,
    torrent_name: t.name,
    torrent_state: t.state,
    torrent_progress: t.progress,
    torrent_category: t.category,
    torrent_tags: t.tags ?? '',
    torrent_size: t.size ?? null,
    save_path: t.save_path ?? '',
    content_path: t.content_path ?? '',
    ...parseTorrentTags(t.tags),
  }
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
