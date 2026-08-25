import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { SearchBar } from './SearchBar'
import { SectionSwitch } from './SectionSwitch'
import { UserCrumb } from './PortalLayout'
import { Icon } from './Icon'
import { useAuth } from '@/lib/AuthContext'
import { useSuggest } from './SuggestModal'
import { sectionFromPath } from '@/lib/sections'

export function Chrome({ crumb }: { crumb?: ReactNode }) {
  const { user } = useAuth()
  const { open } = useSuggest()
  const { pathname } = useLocation()
  // The browse pages — `/`, `/tv`, `/movies` — are one component behind a tab
  // control, so search is offered on all three rather than the root alone:
  // having it vanish when you switch section would read as a bug. Everywhere
  // else (a title, the player, /manage) the phone gets no search row at all.
  const onBrowse = sectionFromPath(pathname) !== null
  return (
    <>
    <header className="chrome">
      <div className="chrome-left">
        <Link className="brand" to="/">
          <span className="brand-mark">B</span>
          <span className="label">boopurnoes <span className="sub">· watch</span></span>
        </Link>
        <SectionSwitch />
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
    {/* Phone-only second row. The header row is full at this width once the
        section switcher is in it, so search moves out from under the brand
        rather than being squeezed beside it. Rendered (and styled) only for
        phones; the desktop header keeps its own centred bar above. */}
    {onBrowse && (
      <div className="chrome-search-row">
        <SearchBar />
      </div>
    )}
    </>
  )
}
