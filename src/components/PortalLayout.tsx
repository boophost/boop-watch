import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { Chrome } from './Chrome'
import { Icon } from './Icon'
import { useAuth } from '@/lib/AuthContext'
import { presenceBrowse, presenceStop } from '@/lib/presence'

/** Collapse state for the side nav, remembered per browser. Lives on the shell
 * root (via data-collapsed) so both the portal and the player can share it. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('snav-collapsed') === '1')
  useEffect(() => {
    localStorage.setItem('snav-collapsed', collapsed ? '1' : '0')
  }, [collapsed])
  return [collapsed, setCollapsed] as const
}

/** The Kagura-scoped side nav: sticky brand + links, collapses to an icon rail.
 * Shared by the portal shell and the player page. */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { user } = useAuth()
  return (
    <aside className="snav">
      <div className="snav-inner">
        <div className="snav-head">
          <Link className="snav-brand" to="/" title="boopurnoes · watch">
            <span className="brand-mark">B</span>
            <span className="snav-label">boopurnoes <span className="sub">· watch</span></span>
          </Link>
        </div>
        <nav className="snav-nav">
          <NavLink to="/" end className="snav-link" title="All titles">
            <Icon name="film" size={16} /><span className="snav-label">All titles</span>
          </NavLink>
          <NavLink to="/schedule" className="snav-link" title="Schedule">
            <Icon name="calendar" size={16} /><span className="snav-label">Schedule</span>
          </NavLink>
          <NavLink to="/library" className="snav-link" title="Library">
            <Icon name="bookmark" size={16} /><span className="snav-label">Library</span>
          </NavLink>
          {user?.isAdmin && (
            <NavLink to="/manage" className="snav-link" title="Manage">
              <Icon name="gear" size={16} /><span className="snav-label">Manage</span>
            </NavLink>
          )}
        </nav>
        <button
          className="snav-link snav-collapse" type="button"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggle}
        >
          <Icon name="back" size={15} /><span className="snav-label">Collapse</span>
        </button>
      </div>
    </aside>
  )
}

/** Bottom tab bar shown on phones (where the side nav is hidden). Shared. */
export function MobileNav() {
  const { user } = useAuth()
  return (
    <nav className="mob-nav">
      <NavLink to="/" end className="mob-link" title="All titles">
        <Icon name="film" size={20} /><span>Home</span>
      </NavLink>
      <NavLink to="/schedule" className="mob-link" title="Schedule">
        <Icon name="calendar" size={20} /><span>Schedule</span>
      </NavLink>
      <NavLink to="/library" className="mob-link" title="Library">
        <Icon name="bookmark" size={20} /><span>Library</span>
      </NavLink>
      {user?.isAdmin && (
        <NavLink to="/manage" className="mob-link" title="Manage">
          <Icon name="gear" size={20} /><span>Manage</span>
        </NavLink>
      )}
    </nav>
  )
}

/** Public portal shell: Kagura-scoped side nav + header. The side nav sticks
 * to the viewport and collapses to an icon rail (remembered per browser). */
export function PortalLayout({ crumb, children }: { crumb?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const { user } = useAuth()

  // Discord "Browsing the library" presence for opted-in users. We beat on
  // mount and every 60s while the tab is visible; the server throttles the
  // actual Discord posts. Intra-portal navigation remounts this shell, so we
  // deliberately *don't* stop on unmount — the next page's beat (or the Watch
  // page's playback beat) updates the same session in place, no flicker. Only
  // leaving the tab (pagehide) clears the activity.
  useEffect(() => {
    if (!user) return
    presenceBrowse()
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') presenceBrowse()
    }, 60000)
    const onHide = () => presenceStop()
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(iv)
      window.removeEventListener('pagehide', onHide)
    }
  }, [user])

  return (
    <div className="kagura shell" data-collapsed={collapsed}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="shell-main">
        <Chrome crumb={crumb} />
        {children}
      </div>
      <MobileNav />
    </div>
  )
}

export function UserCrumb() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const ref = useRef<HTMLDetailsElement>(null)

  // Close the menu on outside click or Escape.
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current) ref.current.open = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!user) {
    return (
      <Link className="crumb" to="/login">
        <Icon name="user" size={15} /> Log in
      </Link>
    )
  }

  const go = (to: string) => {
    if (ref.current) ref.current.open = false
    navigate(to)
  }

  return (
    <details className="umenu" ref={ref}>
      <summary className="crumb crumb-avatar" title={user.username} aria-label={user.username}>
        <Avatar user={user} />
      </summary>
      <div className="umenu-pop">
        <div className="umenu-head">
          <Avatar user={user} size={30} />
          <span className="umenu-name">{user.username}</span>
        </div>
        <button className="popitem" type="button" onClick={() => go('/profile')}>
          <Icon name="user" size={15} /><span className="pi-main">Profile</span>
        </button>
        <button className="popitem" type="button" onClick={() => go('/library')}>
          <Icon name="bookmark" size={15} /><span className="pi-main">My library</span>
        </button>
        {user.isAdmin && (
          <button className="popitem" type="button" onClick={() => go('/manage')}>
            <Icon name="gear" size={15} /><span className="pi-main">Manage</span>
          </button>
        )}
        <div className="umenu-sep" />
        <button
          className="popitem"
          type="button"
          onClick={async () => {
            if (ref.current) ref.current.open = false
            await logout()
            navigate('/')
          }}
        >
          <Icon name="logout" size={15} /><span className="pi-main">Log out</span>
        </button>
      </div>
    </details>
  )
}

/** Profile photo (Google/Discord OAuth) when we have one, else the user's
 * initial, else a generic user icon. */
export function Avatar({ user, size = 34 }: { user: { username: string; avatarUrl: string | null }; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (user.avatarUrl && !broken) {
    return (
      <img
        className="avatar-img" src={user.avatarUrl} alt="" width={size} height={size}
        onError={() => setBroken(true)}
      />
    )
  }
  const initial = user.username?.[0]?.toUpperCase()
  if (initial) {
    return (
      <span className="avatar-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
        {initial}
      </span>
    )
  }
  return <Icon name="user" size={15} />
}

export const BackCrumb = (
  <Link className="crumb" to="/"><Icon name="back" size={15} /> All titles</Link>
)
