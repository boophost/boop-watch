import { Icon } from '@/components/Icon'
import { useAuth } from '@/lib/AuthContext'
import { setWatched, type Progress } from '@/lib/progress'
import { track } from '@/lib/analytics'

// Per-episode "mark as watched" toggle. Lives inside the episode-row <Link>, so
// its click is stopped from bubbling up into a navigation to the player. The
// local write is synchronous (onChange fires instantly); the account upsert, if
// signed in, runs in the background inside setWatched.
export function WatchedToggle({
  id, watched, onChange,
}: {
  id: string
  watched: boolean
  onChange: (id: string, prog: Progress) => void
}) {
  const { user } = useAuth()

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next = !watched
    const prog = setWatched(id, next, user?.id ?? null)
    onChange(id, prog)
    track('watched_toggled', {
      item_id: id,
      watched: next,
      auth_state: user ? 'authenticated' : 'anonymous',
    })
  }

  return (
    <button
      type="button"
      className={`epwatch${watched ? ' on' : ''}`}
      onClick={toggle}
      aria-pressed={watched}
      title={watched ? 'Mark as unwatched' : 'Mark as watched'}
      aria-label={watched ? 'Mark as unwatched' : 'Mark as watched'}
    >
      <Icon name="check" size={14} />
    </button>
  )
}
