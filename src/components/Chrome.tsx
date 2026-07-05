import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SearchBar } from './SearchBar'
import { UserCrumb } from './PortalLayout'

export function Chrome({ crumb }: { crumb?: ReactNode }) {
  return (
    <header className="chrome">
      <Link className="brand" to="/">
        <span className="brand-mark">B</span>
        <span className="label">boopurnoes <span className="sub">· watch</span></span>
      </Link>
      <SearchBar />
      <div className="chrome-right">
        {crumb}
        <UserCrumb />
      </div>
    </header>
  )
}
