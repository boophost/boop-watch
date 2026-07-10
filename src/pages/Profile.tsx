import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { PortalLayout, Avatar } from '../components/PortalLayout'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getPresenceStatus, presenceAuthorizeUrl, unlinkPresence, type PresenceStatus,
} from '../lib/presence'
import { uploadAvatar, deleteAvatarFile } from '../lib/profile'

const MAX_DISPLAY_NAME = 40

const LINKABLE_PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'discord', label: 'Discord' },
] as const

export default function Profile() {
  const { user, logout, linkProvider, unlinkProvider, updateProfile } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  const [nameInput, setNameInput] = useState('')
  const [nameError, setNameError] = useState('')
  const [savingName, setSavingName] = useState(false)
  useEffect(() => {
    if (user) setNameInput(user.username)
  }, [user?.id, user?.username])

  const [avatarError, setAvatarError] = useState('')
  const [avatarPending, setAvatarPending] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const nameDirty = user != null && nameInput.trim() !== user.username
  const handleSaveName = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      setNameError('Display name cannot be empty')
      return
    }
    if (trimmed.length > MAX_DISPLAY_NAME) {
      setNameError(`Display name must be ${MAX_DISPLAY_NAME} characters or fewer`)
      return
    }
    setNameError('')
    setSavingName(true)
    try {
      await updateProfile({ displayName: trimmed })
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to update display name')
    } finally {
      setSavingName(false)
    }
  }

  const handleAvatarPick = () => avatarInputRef.current?.click()

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarError('')
    setAvatarPending(true)
    try {
      const avatarUrl = await uploadAvatar(file)
      await updateProfile({ avatarUrl })
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to upload profile picture')
    } finally {
      setAvatarPending(false)
    }
  }

  const handleAvatarRemove = async () => {
    setAvatarError('')
    setAvatarPending(true)
    try {
      await deleteAvatarFile()
      await updateProfile({ avatarUrl: null })
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to remove profile picture')
    } finally {
      setAvatarPending(false)
    }
  }

  // Discord watch status (independent of the Discord *login* identity above:
  // it needs its own OAuth grant with the activities.write scope).
  const [searchParams, setSearchParams] = useSearchParams()
  const [presence, setPresence] = useState<PresenceStatus | null>(null)
  const [presenceError, setPresenceError] = useState('')
  const [presencePending, setPresencePending] = useState(false)
  const presenceResult = searchParams.get('discord_presence')

  useEffect(() => {
    if (!user) return
    getPresenceStatus().then(setPresence).catch(() => {})
  }, [user])

  const handlePresenceEnable = async () => {
    setPresenceError('')
    setPresencePending(true)
    try {
      window.location.href = await presenceAuthorizeUrl()
    } catch (err) {
      setPresenceError(err instanceof Error ? err.message : 'Failed to start Discord link')
      setPresencePending(false)
    }
  }

  const handlePresenceDisable = async () => {
    setPresenceError('')
    setPresencePending(true)
    try {
      await unlinkPresence()
      setPresence((p) => (p ? { ...p, linked: false, discord: null } : p))
      if (presenceResult) setSearchParams({}, { replace: true })
    } catch (err) {
      setPresenceError(err instanceof Error ? err.message : 'Failed to disable')
    } finally {
      setPresencePending(false)
    }
  }

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
            <div className="relative shrink-0">
              {user && <Avatar user={user} size={64} />}
              <button
                type="button"
                onClick={handleAvatarPick}
                disabled={avatarPending}
                title="Change profile picture"
                className="absolute -bottom-1 -right-1 flex items-center justify-center w-6 h-6 rounded-full bg-white/20 hover:bg-white/30 disabled:opacity-40 transition-colors text-xs"
              >
                {avatarPending ? '…' : '✎'}
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                className="hidden"
                onChange={handleAvatarFile}
              />
            </div>
            <div className="min-w-0">
              <div className="text-lg font-medium">{user?.username}</div>
              <div className="text-sm text-white/50">ID: {user?.id}</div>
              {user?.isAdmin && (
                <div className="mt-1">
                  <span className="text-xs bg-accent text-accent-fg px-2 py-0.5 rounded font-medium">Admin</span>
                </div>
              )}
              {user?.hasCustomAvatar && (
                <button
                  type="button"
                  onClick={handleAvatarRemove}
                  disabled={avatarPending}
                  className="text-xs text-white/40 hover:text-white/70 disabled:opacity-40 mt-1 underline underline-offset-2"
                >
                  Remove custom picture
                </button>
              )}
            </div>
          </div>
          {avatarError && <p className="text-sm text-red-400 -mt-6 mb-6">{avatarError}</p>}

          <div className="pb-6 border-b border-white/10">
            <h2 className="text-sm font-medium text-white/70 mb-3">Display name</h2>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={MAX_DISPLAY_NAME}
                className="flex-1 px-3 py-2 text-sm bg-white/5 border border-white/10 rounded focus:outline-none focus:border-white/30"
                placeholder="Display name"
              />
              <button
                onClick={handleSaveName}
                disabled={savingName || !nameDirty}
                className="px-3 py-2 text-xs bg-white/10 text-white hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10 rounded transition-colors shrink-0"
              >
                {savingName ? 'Saving…' : 'Save'}
              </button>
            </div>
            {nameError && <p className="text-sm text-red-400 mt-2">{nameError}</p>}
          </div>

          <div className="pt-6">
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

          {presence?.available && (
            <div className="pt-6 mt-6 border-t border-white/10">
              <h2 className="text-sm font-medium text-white/70 mb-3">Discord watch status</h2>
              <div className="flex items-center justify-between px-3 py-2 bg-white/5 border border-white/10 rounded">
                <div className="min-w-0 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Show what I'm watching</span>
                    {presence.linked && (
                      <span className="text-xs bg-white/10 text-white/60 px-2 py-0.5 rounded">
                        {presence.discord?.name ? `On for ${presence.discord.name}` : 'On'}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">
                    While you watch, your Discord activity shows the title and episode.
                  </p>
                </div>
                <button
                  onClick={presence.linked ? handlePresenceDisable : handlePresenceEnable}
                  disabled={presencePending}
                  className="px-3 py-1 text-xs bg-white/10 text-white hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10 rounded transition-colors shrink-0"
                >
                  {presencePending ? '...' : presence.linked ? 'Disable' : 'Enable'}
                </button>
              </div>
              {presenceResult === 'linked' && presence.linked && (
                <p className="text-sm text-emerald-400 mt-2">Discord watch status enabled.</p>
              )}
              {presenceResult && presenceResult !== 'linked' && !presence.linked && (
                <p className="text-sm text-red-400 mt-2">
                  Discord link failed
                  {presenceResult === 'access_denied' ? ' (cancelled)' : ` (${presenceResult})`} — try
                  again.
                </p>
              )}
              {presenceError && <p className="text-sm text-red-400 mt-2">{presenceError}</p>}
            </div>
          )}

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
