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

export function isAdminViaEnv(email: string | null): boolean {
  const normalized = (email ?? '').toLowerCase()
  return normalized.length > 0 && ADMIN_EMAILS.includes(normalized)
}

/**
 * Admin status for one user: the env allowlist (super-admins, never revocable
 * and never dependent on the DB being reachable) or a row in admin_users.
 * Fails closed — a missing service client or query error means "not admin".
 */
export async function isAdminForUserId(id: string, email: string | null): Promise<boolean> {
  if (isAdminViaEnv(email)) return true
  const client = adminClient()
  if (!client) return false
  try {
    const { data, error } = await client
      .from('admin_users')
      .select('user_id')
      .eq('user_id', id)
      .maybeSingle()
    if (error) {
      console.error('admin_users lookup failed', error)
      return false
    }
    return data !== null
  } catch (e) {
    console.error('admin_users lookup failed', e)
    return false
  }
}

function toRow(user: User, isAdmin: boolean): AdminUserRow {
  const email = user.email ?? null
  return {
    id: user.id,
    email,
    avatarUrl: avatarUrl(user),
    providers: providers(user),
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    isAdmin,
    adminViaEnv: isAdminViaEnv(email),
  }
}

/** Paginate through every Supabase auth user (admin API). */
export async function listAllUsers(): Promise<AdminUserRow[]> {
  const client = adminClient()
  if (!client) {
    throw new Error('User listing is not configured (SUPABASE_SERVICE_ROLE_KEY)')
  }

  const { data: adminRows, error: adminError } = await client
    .from('admin_users')
    .select('user_id')
  if (adminError) throw adminError
  const adminIds = new Set((adminRows ?? []).map((r) => r.user_id as string))

  const rows: AdminUserRow[] = []
  let page = 1
  const perPage = 200

  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    for (const user of data.users) {
      const isAdmin = adminIds.has(user.id) || isAdminViaEnv(user.email ?? null)
      rows.push(toRow(user, isAdmin))
    }
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
  // admin_users.user_id cascades on auth.users delete — no separate cleanup.
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

  if (isAdmin) {
    const { error } = await client.from('admin_users').upsert({ user_id: id })
    if (error) throw error
  } else {
    const { error } = await client.from('admin_users').delete().eq('user_id', id)
    if (error) throw error
  }
  return toRow(existing.user, isAdmin || isAdminViaEnv(existing.user.email ?? null))
}
