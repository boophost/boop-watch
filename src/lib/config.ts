// Client for the app-configuration API (/manage/settings).
import { fetchAuth, parseAuthJson } from '@/lib/api'

/** Where a setting's effective value comes from right now. */
export type ConfigSource = 'env' | 'database' | 'default'

export interface ConfigRow {
  key: string
  label: string
  group: string
  secret: boolean
  help?: string
  placeholder?: string
  default?: string
  source: ConfigSource
  /** Absent for secrets — the server never sends their value, not even masked. */
  value?: string
  isSet: boolean
  updatedAt: string | null
  updatedBy: string | null
  /** Set when a stored secret can't be decrypted (CONFIG_KEY missing or rotated). */
  error?: string
}

export interface ConfigResponse {
  config: ConfigRow[]
  /** False ⇒ secrets can be read but not written; the page explains why. */
  configKeyConfigured: boolean
}

export async function getConfig(): Promise<ConfigResponse> {
  const r = await fetchAuth('/api/config')
  if (!r.ok) throw new Error((await parseAuthJson<{ error?: string }>(r)).error ?? 'Failed to load settings')
  return parseAuthJson<ConfigResponse>(r)
}

export async function putConfig(key: string, value: string): Promise<ConfigRow> {
  const r = await fetchAuth(`/api/config/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  const d = await parseAuthJson<{ config?: ConfigRow; error?: string }>(r)
  if (!r.ok || !d.config) throw new Error(d.error ?? 'Failed to save setting')
  return d.config
}

export async function deleteConfig(key: string): Promise<ConfigRow> {
  const r = await fetchAuth(`/api/config/${encodeURIComponent(key)}`, { method: 'DELETE' })
  const d = await parseAuthJson<{ config?: ConfigRow; error?: string }>(r)
  if (!r.ok || !d.config) throw new Error(d.error ?? 'Failed to clear setting')
  return d.config
}
