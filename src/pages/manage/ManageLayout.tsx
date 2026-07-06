import { Link, NavLink, Outlet } from 'react-router-dom'
import { Activity, CalendarClock, ExternalLink, Library, LogOut, Users, Workflow } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/manage', label: 'Library', icon: Library, end: true },
  { to: '/manage/flows', label: 'Flows', icon: Workflow, end: false },
  { to: '/manage/schedules', label: 'Schedules', icon: CalendarClock, end: false },
  { to: '/manage/activity', label: 'Activity', icon: Activity, end: false },
  { to: '/manage/users', label: 'Users', icon: Users, end: false },
]

export default function ManageLayout() {
  const { user, logout } = useAuth()

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
          {NAV_ITEMS.map(({ to, label, icon: NavIcon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors md:justify-start md:px-3',
                  isActive
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
        <Outlet />
      </div>
    </div>
  )
}
