import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Chrome } from './Chrome'
import { Icon } from './Icon'
import { useAuth } from '@/lib/AuthContext'

/** Public portal shell: Kagura-scoped wrapper + header. */
export function PortalLayout({ crumb, children }: { crumb?: ReactNode; children: ReactNode }) {
  return (
    <div className="kagura flex min-h-screen">
      <aside className="w-64 border-r border-white/10 hidden md:block">
        <div className="p-4 pt-[18px]">
          <Link className="brand" to="/" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, fontSize: '16px', letterSpacing: '-0.02em' }}>
            <span className="brand-mark" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '4px', background: 'var(--accent)', color: 'var(--accent-fg)', fontSize: '13px', fontWeight: 700 }}>B</span>
            <span className="label">boopurnoes <span className="sub" style={{ opacity: 0.6, fontWeight: 400 }}>· watch</span></span>
          </Link>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          <Link to="/" className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md hover:bg-white/5 text-white/80 hover:text-white transition-colors">
            <Icon name="film" size={16} /> All titles
          </Link>
          <Link to="/schedule" className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md hover:bg-white/5 text-white/80 hover:text-white transition-colors">
            <Icon name="calendar" size={16} /> Schedule
          </Link>
        </nav>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
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
      <Link className="crumb" to="/profile">
        <Icon name="user" size={15} /> {user.username}
      </Link>
    )
  }
  return (
    <Link className="crumb" to="/login">
      <Icon name="user" size={15} /> Log in
    </Link>
  )
}

export const BackCrumb = (
  <Link className="crumb" to="/"><Icon name="back" size={15} /> All titles</Link>
)
