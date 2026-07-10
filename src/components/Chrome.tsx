import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SearchBar } from './SearchBar'
import { UserCrumb } from './PortalLayout'
import { Icon } from './Icon'
import { useAuth } from '@/lib/AuthContext'
import { useSuggest } from './SuggestModal'

export function Chrome({ crumb }: { crumb?: ReactNode }) {
  const { user } = useAuth()
  const { open } = useSuggest()
  return (
    <header className="chrome">
      <div className="chrome-left">
        <Link className="brand" to="/">
          <span className="brand-mark">B</span>
          <span className="label">boopurnoes <span className="sub">· watch</span></span>
        </Link>
        {user && (
          <button
            className="chrome-suggest"
            type="button"
            onClick={open}
            title="Send a suggestion"
            aria-label="Send a suggestion"
          >
            <Icon name="alert" size={18} />
          </button>
        )}
      </div>
      <SearchBar />
      <div className="chrome-right">
        {crumb}
        <UserCrumb />
      </div>
    </header>
  )
}
