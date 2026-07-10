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

// Admin status is server-verified: GET /api/me consults the ADMIN_EMAILS
// allowlist and the Postgres admin_users table. The session metadata is no
// longer trusted for this — toUser() defaults isAdmin to false and
// refreshIsAdmin() upgrades it once the server answers.
async function fetchIsAdmin(session: Session): Promise<boolean> {
  const resp = await fetch('/api/me', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!resp.ok) return false
  const body = (await resp.json()) as { isAdmin?: unknown }
  return body.isAdmin === true
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
// the same id just refreshes the properties. is_admin is asserted separately
// once the server answers (see refreshIsAdmin), so it isn't guessed here.
function identifyFromSession(session: Session): void {
  const name = displayName(session)
  identifyUser(session.user.id, {
    email: session.user.email ?? undefined,
    name: name || undefined,
    provider: oauthProvider(session) ?? 'email',
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

// isAdmin starts false and is upgraded asynchronously by refreshIsAdmin once
// /api/me answers — callers that rebuild the user for unrelated reasons must
// merge the already-resolved value back in (see unlinkProvider/updateProfile).
function toUser(session: Session | null): User | null {
  if (!session?.user) return null
  return {
    username: displayName(session) || session.user.email || '',
    id: session.user.id,
    isAdmin: false,
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
  /** False while the server-verified isAdmin flag is still in flight for the
   *  current session — admin route guards should wait on this, not redirect. */
  adminReady: boolean
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
  adminReady: false,
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
  const [adminReady, setAdminReady] = useState(false)

  useEffect(() => {
    // Resolve the server-verified admin flag for a just-seen session. Always
    // asserts the settled boolean (into state and the PostHog person) so a
    // revoke can't leave a stale true; the id guard keeps a late response for
    // an old session from clobbering a newer one.
    // adminReady latches true after the first resolution (it starts false, so
    // hard-refresh deep links to /manage wait for the real answer) — later
    // re-verifications on token refresh just correct isAdmin in place without
    // bouncing route guards back to a spinner.
    const refreshIsAdmin = (session: Session) => {
      fetchIsAdmin(session)
        .catch(() => false)
        .then((isAdmin) => {
          setUser((prev) =>
            prev && prev.id === session.user.id ? { ...prev, isAdmin } : prev,
          )
          identifyUser(session.user.id, { is_admin: isAdmin })
          setAdminReady(true)
        })
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) identifyFromSession(session)
      setUser(toUser(session))
      setLoading(false)
      if (session) refreshIsAdmin(session)
      else setAdminReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      handleAuthChange(event, session)
      // This fires on token refreshes/tab refocus too — keep the resolved
      // isAdmin for the same user so admin UI doesn't flicker off while
      // refreshIsAdmin re-verifies.
      setUser((prev) => {
        const next = toUser(session)
        return next && prev && prev.id === next.id
          ? { ...next, isAdmin: prev.isAdmin }
          : next
      })
      setLoading(false)
      if (session) refreshIsAdmin(session)
      else setAdminReady(true)
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
    // Unlinking doesn't change admin status — keep the resolved flag rather
    // than letting toUser() regress it to false until the next auth cycle.
    setUser((prev) => {
      const next = toUser(session)
      return next ? { ...next, isAdmin: prev?.isAdmin ?? false } : next
    })
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
    // Profile edits don't change admin status — same merge as unlinkProvider.
    setUser((prev) => {
      const next = toUser(session)
      return next ? { ...next, isAdmin: prev?.isAdmin ?? false } : next
    })
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
      value={{ user, loading, adminReady, login, signup, loginWithProvider, linkProvider, unlinkProvider, updateProfile, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

