import { createContext, useContext, useEffect, useState } from 'react'
import type { AuthChangeEvent, Session, UserIdentity } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { identifyUser, resetAnalytics, track } from './analytics'

interface User {
  username: string
  id: string
  isAdmin: boolean
  avatarUrl: string | null
  /** True when avatarUrl comes from the user's own upload (profile-page override),
   *  not the OAuth provider — controls whether "Remove" shows on the profile page. */
  hasCustomAvatar: boolean
  identities: UserIdentity[]
}

// Emails granted admin regardless of Supabase metadata. Admin is only enforced
// client-side (the /manage guard + sidebar link), so this allowlist is the
// source of truth alongside user_metadata.admin / app_metadata.role.
const ADMIN_EMAILS = ['admin@example.com']

const NEW_USER_MS = 60_000

function oauthProvider(session: Session): 'google' | 'discord' | null {
  const provider =
    session.user.app_metadata?.provider ?? session.user.identities?.[0]?.provider
  if (provider === 'google' || provider === 'discord') return provider
  return null
}

function isNewUser(session: Session): boolean {
  const created = new Date(session.user.created_at).getTime()
  return Number.isFinite(created) && Date.now() - created < NEW_USER_MS
}

function computeIsAdmin(session: Session): boolean {
  const meta = session.user.user_metadata || {}
  const email = session.user.email ?? ''
  return (
    meta.admin === true ||
    session.user.app_metadata?.role === 'admin' ||
    ADMIN_EMAILS.includes(email.toLowerCase())
  )
}

// display_name / custom_avatar_url are the user's own profile-page overrides
// (written directly to their Supabase user_metadata); they win over whatever
// the OAuth provider supplied. OAuth display name otherwise lands under
// full_name/name (Google) or user_name (Discord); email is the last resort so
// every profile has a readable label.
function displayName(session: Session): string {
  const meta = session.user.user_metadata || {}
  return meta.display_name || meta.full_name || meta.name || meta.user_name || session.user.email || ''
}

function customAvatarUrl(session: Session): string | null {
  const meta = session.user.user_metadata || {}
  return typeof meta.custom_avatar_url === 'string' && meta.custom_avatar_url ? meta.custom_avatar_url : null
}

function avatarUrl(session: Session): string | null {
  const meta = session.user.user_metadata || {}
  return customAvatarUrl(session) || meta.avatar_url || meta.picture || null
}

// Tie the PostHog person profile to the Supabase account. Keyed by the stable
// user id (survives email changes); safe to call repeatedly — re-identifying
// the same id just refreshes the properties.
function identifyFromSession(session: Session): void {
  const name = displayName(session)
  identifyUser(session.user.id, {
    email: session.user.email ?? undefined,
    name: name || undefined,
    provider: oauthProvider(session) ?? 'email',
    is_admin: computeIsAdmin(session),
    created_at: session.user.created_at,
  })
}

function onSignedIn(session: Session): void {
  const provider = oauthProvider(session)
  if (!provider) return
  if (isNewUser(session)) {
    track('user_signed_up', { method: provider, auth_state: 'authenticated' })
  } else {
    track('user_logged_in', { method: provider, auth_state: 'authenticated' })
  }
}

function handleAuthChange(event: AuthChangeEvent, session: Session | null): void {
  if (event === 'SIGNED_IN' && session) {
    identifyFromSession(session)
    onSignedIn(session)
  }
  if (event === 'SIGNED_OUT') resetAnalytics()
}

function toUser(session: Session | null): User | null {
  if (!session?.user) return null
  return {
    username: displayName(session) || session.user.email || '',
    id: session.user.id,
    isAdmin: computeIsAdmin(session),
    avatarUrl: avatarUrl(session),
    hasCustomAvatar: customAvatarUrl(session) !== null,
    identities: session.user.identities ?? [],
  }
}

interface ProfilePatch {
  /** Overrides the OAuth-provided name. Empty/undefined leaves it unchanged; pass null to clear the override. */
  displayName?: string | null
  /** Overrides the OAuth-provided avatar. Pass null to clear the override (reverts to the OAuth picture, if any). */
  avatarUrl?: string | null
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<void>
  loginWithProvider: (provider: 'google' | 'discord') => Promise<void>
  linkProvider: (provider: 'google' | 'discord') => Promise<void>
  unlinkProvider: (identity: UserIdentity) => Promise<void>
  updateProfile: (patch: ProfilePatch) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => {},
  signup: async () => {},
  loginWithProvider: async () => {},
  linkProvider: async () => {},
  unlinkProvider: async () => {},
  updateProfile: async () => {},
  logout: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) identifyFromSession(session)
      setUser(toUser(session))
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      handleAuthChange(event, session)
      setUser(toUser(session))
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const login = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    track('user_logged_in', { method: 'email', auth_state: 'authenticated' })
  }

  const signup = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
    })
    if (error) throw error
  }

  const loginWithProvider = async (provider: 'google' | 'discord') => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: window.location.origin + '/profile'
      }
    })
    if (error) throw error
  }

  const linkProvider = async (provider: 'google' | 'discord') => {
    const { error } = await supabase.auth.linkIdentity({
      provider,
      options: {
        redirectTo: window.location.origin + '/profile',
      },
    })
    if (error) throw error
  }

  const unlinkProvider = async (identity: UserIdentity) => {
    const { error } = await supabase.auth.unlinkIdentity(identity)
    if (error) throw error
    const { data: { session } } = await supabase.auth.getSession()
    setUser(toUser(session))
  }

  // display_name / custom_avatar_url are the user's own metadata fields (never
  // written by an OAuth provider), so writing them directly is safe. Ping /api/me
  // afterward so the server's user_profiles cache (used by comment reads) picks
  // up the new name/avatar without waiting for the next authed request.
  const updateProfile = async (patch: ProfilePatch) => {
    const data: Record<string, unknown> = {}
    if (patch.displayName !== undefined) data.display_name = patch.displayName
    if (patch.avatarUrl !== undefined) data.custom_avatar_url = patch.avatarUrl
    const { error } = await supabase.auth.updateUser({ data })
    if (error) throw error
    const { data: { session } } = await supabase.auth.getSession()
    setUser(toUser(session))
    if (session?.access_token) {
      void fetch('/api/me', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {})
    }
  }

  const logout = async () => {
    await supabase.auth.signOut()
    resetAnalytics()
    setUser(null)
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, login, signup, loginWithProvider, linkProvider, unlinkProvider, updateProfile, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

