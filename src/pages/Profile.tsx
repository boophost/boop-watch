import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { PortalLayout, Avatar } from '../components/PortalLayout'
import { useNavigate } from 'react-router-dom'

const LINKABLE_PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'discord', label: 'Discord' },
] as const

export default function Profile() {
  const { user, logout, linkProvider, unlinkProvider } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  const handleLogout = async () => {
    await logout()
    navigate('/')
  }

  const handleLink = async (provider: 'google' | 'discord') => {
    setError('')
    setPending(provider)
    try {
      await linkProvider(provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to link ${provider}`)
      setPending(null)
    }
  }

  const handleUnlink = async (provider: 'google' | 'discord') => {
    const identity = user?.identities.find((i) => i.provider === provider)
    if (!identity) return
    setError('')
    setPending(provider)
    try {
      await unlinkProvider(identity)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to unlink ${provider}`)
    } finally {
      setPending(null)
    }
  }

  const canUnlink = (user?.identities.length ?? 0) > 1

  return (
    <PortalLayout>
      <div className="p-8 max-w-2xl mx-auto w-full">
        <div className="bg-white/5 border border-white/10 rounded-lg p-6">
          <h1 className="text-2xl font-semibold mb-6">Profile</h1>

          <div className="flex items-center gap-4 mb-8">
            {user && <Avatar user={user} size={64} />}
            <div>
              <div className="text-lg font-medium">{user?.username}</div>
              <div className="text-sm text-white/50">ID: {user?.id}</div>
              {user?.isAdmin && (
                <div className="mt-1">
                  <span className="text-xs bg-accent text-accent-fg px-2 py-0.5 rounded font-medium">Admin</span>
                </div>
              )}
            </div>
          </div>

          <div className="pt-6 border-t border-white/10">
            <h2 className="text-sm font-medium text-white/70 mb-3">Connected accounts</h2>
            <div className="flex flex-col gap-2">
              {LINKABLE_PROVIDERS.map(({ id, label }) => {
                const linked = user?.identities.some((i) => i.provider === id) ?? false
                const disabled = pending === id || (linked && !canUnlink)
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between px-3 py-2 bg-white/5 border border-white/10 rounded"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{label}</span>
                      {linked && (
                        <span className="text-xs bg-white/10 text-white/60 px-2 py-0.5 rounded">Linked</span>
                      )}
                    </div>
                    <button
                      onClick={() => (linked ? handleUnlink(id) : handleLink(id))}
                      disabled={disabled}
                      title={linked && !canUnlink ? "Can't unlink your only sign-in method" : undefined}
                      className="px-3 py-1 text-xs bg-white/10 text-white hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10 rounded transition-colors"
                    >
                      {pending === id ? '...' : linked ? 'Unlink' : 'Link'}
                    </button>
                  </div>
                )
              })}
            </div>
            {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
          </div>

          <div className="pt-6 mt-6 border-t border-white/10 flex items-center gap-4">
            {user?.isAdmin && (
              <button
                onClick={() => navigate('/manage')}
                className="px-4 py-2 bg-white/10 text-white hover:bg-white/20 rounded transition-colors"
              >
                Admin Dashboard
              </button>
            )}
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded transition-colors"
            >
              Log Out
            </button>
          </div>
        </div>
      </div>
    </PortalLayout>
  )
}
