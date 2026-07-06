import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Shield, Users as UsersIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { listUsers, type AdminUserRow } from '@/lib/users'

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function providerLabel(provider: string): string {
  if (provider === 'email') return 'Email'
  if (provider === 'google') return 'Google'
  if (provider === 'discord') return 'Discord'
  return provider
}

function UserCell({ user }: { user: AdminUserRow }) {
  const label = user.email ?? user.id
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="size-8 shrink-0 overflow-hidden rounded-full bg-muted">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-xs font-medium text-muted-foreground">
            {(user.email?.[0] ?? '?').toUpperCase()}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{label}</span>
          {user.isAdmin ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
              <Shield className="size-3" />
              admin
            </span>
          ) : null}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{user.id}</p>
      </div>
    </div>
  )
}

export default function Users() {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setUsers(await listUsers())
    } catch (e) {
      setUsers([])
      setError(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Users</h1>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {users.length > 0 ? `${users.length} total` : null}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {loading && users.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading users…</p>
        ) : users.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <UsersIcon className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No users yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Signed-up accounts from Supabase auth will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Providers</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3 font-medium">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <UserCell user={user} />
                    </td>
                    <td className="px-4 py-3">
                      {user.providers.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {user.providers.map((p) => (
                            <span
                              key={p}
                              className="rounded bg-muted px-2 py-0.5 text-xs text-foreground"
                            >
                              {providerLabel(p)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatWhen(user.createdAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatWhen(user.lastSignInAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
