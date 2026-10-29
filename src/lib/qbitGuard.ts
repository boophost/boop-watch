// Client for the torrent-add guard status (GET /api/qbit/guard, admin-only).
import { fetchAuth, parseAuthJson } from '@/lib/api'

export interface QbitGuardStatus {
  ok: boolean
  configured: boolean
  freeGB?: number | null
  floorGB?: number
  interface?: string | null
  requiredInterface?: string
  externalIp?: string
  reasons: string[]
}

export async function getQbitGuard(): Promise<QbitGuardStatus> {
  const r = await fetchAuth('/api/qbit/guard')
  const d = await parseAuthJson<QbitGuardStatus & { error?: string }>(r)
  if (!r.ok) throw new Error(d.error ?? 'Failed to load qBittorrent guard')
  return d
}
