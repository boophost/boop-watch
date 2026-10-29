import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  ExternalLink,
  HardDrive,
  Library,
  Lightbulb,
  LogOut,
  Map as MapIcon,
  SlidersHorizontal,
  Users,
  Workflow,
} from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getQbitGuard } from '@/lib/qbitGuard'

const GUARD_POLL_MS = 60_000

/** Reasons the torrent-add guard would refuse right now; empty when it passes,
 *  for non-admins, and while the status can't be loaded. */
function useQbitGuardReasons(enabled: boolean): string[] {
  const [reasons, setReasons] = useState<string[]>([])
  useEffect(() => {
    if (!enabled) {
      setReasons([])
      return
    }
    let alive = true
    const load = () =>
      getQbitGuard()
        .then((g) => alive && setReasons(g.ok ? [] : g.reasons))
        .catch(() => alive && setReasons([]))
    void load()
    const t = setInterval(load, GUARD_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [enabled])
  return reasons
}

const NAV_ITEMS: {
  to: string
  label: string
  icon: typeof Library
  end?: boolean
  /** Custom active check — Flows includes the editor but excludes Map. */
  isActive?: (pathname: string) => boolean
}[] = [
  { to: '/manage', label: 'Catalog', icon: Library, end: true },
  {
    to: '/manage/flows',
    label: 'Flows',
    icon: Workflow,
    isActive: (pathname) =>
      pathname === '/manage/flows' || /^\/manage\/flows\/\d+(\/|$)/.test(pathname),
  },
  { to: '/manage/flows/map', label: 'Map', icon: MapIcon, end: true },
  { to: '/manage/schedules', label: 'Schedules', icon: CalendarClock },
  { to: '/manage/activity', label: 'Activity', icon: Activity },
  { to: '/manage/storage', label: 'Storage', icon: HardDrive },
  { to: '/manage/users', label: 'Users', icon: Users },
  { to: '/manage/suggestions', label: 'Suggestions', icon: Lightbulb },
  { to: '/manage/settings', label: 'Settings', icon: SlidersHorizontal },
]

export default function ManageLayout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  const guardReasons = useQbitGuardReasons(user?.isAdmin === true)

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 flex h-screen w-14 shrink-0 flex-col border-r md:w-56">
        <div className="flex h-14 items-center justify-center border-b px-2 md:justify-start md:px-4">
          <Link to="/manage" className="flex items-baseline gap-1.5 font-semibold">
            <span className="md:hidden">b</span>
            <span className="hidden md:inline">boopurnoes</span>
            <span className="hidden text-sm font-medium text-muted-foreground md:inline">
              · manage
            </span>
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV_ITEMS.map(({ to, label, icon: NavIcon, end, isActive: matchActive }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors md:justify-start md:px-3',
                  (matchActive ? matchActive(pathname) : isActive)
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )
              }
              title={label}
            >
              <NavIcon className="size-4 shrink-0" />
              <span className="hidden md:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="justify-center gap-2 md:justify-start"
            asChild
          >
            <Link to="/" title="View site">
              <ExternalLink className="size-4 shrink-0" />
              <span className="hidden md:inline">View site</span>
            </Link>
          </Button>
          <div className="hidden truncate px-3 text-xs text-muted-foreground md:block">
            {user?.username}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="justify-center gap-2 md:justify-start"
            onClick={logout}
            title="Sign out"
          >
            <LogOut className="size-4 shrink-0" />
            <span className="hidden md:inline">Sign out</span>
          </Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {guardReasons.length > 0 && (
          <div
            role="alert"
            className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-medium">Torrent adds blocked:</span> {guardReasons.join('; ')}
            </span>
          </div>
        )}
        <Outlet />
      </div>
    </div>
  )
}
