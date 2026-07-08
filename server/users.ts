import { createClient, type User } from '@supabase/supabase-js'

export interface AdminUserRow {
  id: string
  email: string | null
  avatarUrl: string | null
  providers: string[]
  createdAt: string
  lastSignInAt: string | null
  isAdmin: boolean
  /** True when admin access comes from ADMIN_EMAILS (cannot be revoked here). */
  adminViaEnv: boolean
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? 'ethanwhi@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

function adminClient() {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function avatarUrl(user: User): string | null {
  const meta = user.user_metadata ?? {}
  const raw = meta.avatar_url ?? meta.picture
  return typeof raw === 'string' && raw ? raw : null
}

function providers(user: User): string[] {
  const fromIdentities = (user.identities ?? [])
    .map((i) => i.provider)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (fromIdentities.length > 0) return [...new Set(fromIdentities)]
  const fallback = user.app_metadata?.provider
  return typeof fallback === 'string' && fallback ? [fallback] : []
}

function isAdminViaEnv(email: string | null): boolean {
  const normalized = (email ?? '').toLowerCase()
  return normalized.length > 0 && ADMIN_EMAILS.includes(normalized)
}

function isAdminUser(user: User): boolean {
  const email = (user.email ?? '').toLowerCase()
  const meta = user.user_metadata ?? {}
  return (
    meta.admin === true ||
    user.app_metadata?.role === 'admin' ||
    (email.length > 0 && ADMIN_EMAILS.includes(email))
  )
}

function toRow(user: User): AdminUserRow {
  const email = user.email ?? null
  return {
    id: user.id,
    email,
    avatarUrl: avatarUrl(user),
    providers: providers(user),
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    isAdmin: isAdminUser(user),
    adminViaEnv: isAdminViaEnv(email),
  }
}

/** Paginate through every Supabase auth user (admin API). */
export async function listAllUsers(): Promise<AdminUserRow[]> {
  const client = adminClient()
  if (!client) {
    throw new Error('User listing is not configured (SUPABASE_SERVICE_ROLE_KEY)')
  }

  const rows: AdminUserRow[] = []
  let page = 1
  const perPage = 200

  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    for (const user of data.users) rows.push(toRow(user))
    if (data.users.length < perPage) break
    page += 1
  }

  rows.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime()
    const tb = new Date(b.createdAt).getTime()
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
  })
  return rows
}

export async function deleteUser(id: string): Promise<void> {
  const client = adminClient()
  if (!client) {
    throw new Error('User management is not configured (SUPABASE_SERVICE_ROLE_KEY)')
  }
  const { error } = await client.auth.admin.deleteUser(id)
  if (error) throw error
}

export async function setUserAdmin(id: string, isAdmin: boolean): Promise<AdminUserRow> {
  const client = adminClient()
  if (!client) {
    throw new Error('User management is not configured (SUPABASE_SERVICE_ROLE_KEY)')
  }

  const { data: existing, error: fetchError } = await client.auth.admin.getUserById(id)
  if (fetchError) throw fetchError
  if (!existing.user) throw new Error('User not found')

  if (!isAdmin && isAdminViaEnv(existing.user.email ?? null)) {
    throw new Error('Cannot revoke admin for an allowlisted email')
  }

  const { data, error } = await client.auth.admin.updateUserById(id, {
    app_metadata: { ...existing.user.app_metadata, role: isAdmin ? 'admin' : null },
    user_metadata: { ...existing.user.user_metadata, admin: isAdmin },
  })
  if (error) throw error
  if (!data.user) throw new Error('User not found')
  return toRow(data.user)
}
