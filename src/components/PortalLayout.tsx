import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Chrome } from './Chrome'
import { Icon } from './Icon'
import { useAuth } from '@/lib/AuthContext'

/** Public portal shell: Kagura-scoped side nav + header. The side nav sticks
 * to the viewport and collapses to an icon rail (remembered per browser). */
export function PortalLayout({ crumb, children }: { crumb?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('snav-collapsed') === '1')
  useEffect(() => {
    localStorage.setItem('snav-collapsed', collapsed ? '1' : '0')
  }, [collapsed])

  return (
    <div className="kagura shell" data-collapsed={collapsed}>
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
          </nav>
          <button
            className="snav-link snav-collapse" type="button"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <Icon name="back" size={15} /><span className="snav-label">Collapse</span>
          </button>
        </div>
      </aside>
      <div className="shell-main">
        <Chrome crumb={crumb} />
        {children}
      </div>
    </div>
  )
}

export function UserCrumb() {
  const { user } = useAuth()
  if (user) {
    return (
      <Link className="crumb crumb-avatar" to="/profile" title={user.username} aria-label={user.username}>
        <Avatar user={user} />
      </Link>
    )
  }
  return (
    <Link className="crumb" to="/login">
      <Icon name="user" size={15} /> Log in
    </Link>
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
