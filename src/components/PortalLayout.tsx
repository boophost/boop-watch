import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Chrome } from './Chrome'
import { Icon } from './Icon'

/** Public portal shell: Kagura-scoped wrapper + header. */
export function PortalLayout({ crumb, children }: { crumb?: ReactNode; children: ReactNode }) {
  return (
    <div className="kagura">
      <Chrome crumb={crumb} />
      {children}
    </div>
  )
}

export const ScheduleCrumb = (
  <Link className="crumb" to="/schedule"><Icon name="calendar" size={15} /> Schedule</Link>
)
export const BackCrumb = (
  <Link className="crumb" to="/"><Icon name="back" size={15} /> All titles</Link>
)
