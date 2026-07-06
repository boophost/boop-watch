import { fetchAuth, parseAuthJson } from './api'

export interface AdminUserRow {
  id: string
  email: string | null
  avatarUrl: string | null
  providers: string[]
  createdAt: string
  lastSignInAt: string | null
  isAdmin: boolean
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const r = await fetchAuth('/api/users')
  const data = await parseAuthJson<{ users: AdminUserRow[]; error?: string }>(r)
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data.users
}
