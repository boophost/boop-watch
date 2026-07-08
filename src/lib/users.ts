import { fetchAuth, parseAuthJson } from './api'

export interface AdminUserRow {
  id: string
  email: string | null
  avatarUrl: string | null
  providers: string[]
  createdAt: string
  lastSignInAt: string | null
  isAdmin: boolean
  adminViaEnv: boolean
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const r = await fetchAuth('/api/users')
  const data = await parseAuthJson<{ users: AdminUserRow[]; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.users
}

export async function setUserAdmin(id: string, isAdmin: boolean): Promise<AdminUserRow> {
  const r = await fetchAuth(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAdmin }),
  })
  const data = await parseAuthJson<{ user: AdminUserRow; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.user
}

export async function deleteUser(id: string): Promise<void> {
  const r = await fetchAuth(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
  const data = await parseAuthJson<{ ok?: boolean; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
}
