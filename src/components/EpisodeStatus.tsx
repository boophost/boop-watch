import { Icon, type IconName } from '@/components/Icon'
import {
  publicChaseLabel,
  type ChaseState,
  type EpisodeChase,
} from '@/lib/chase'

const STATE_ICON: Record<Exclude<ChaseState, 'ready'>, IconName> = {
  waiting: 'calendar',
  searching: 'search',
  downloading: 'download',
  importing: 'spinner',
}

const STATE_CLASS: Record<Exclude<ChaseState, 'ready'>, string> = {
  waiting: 'ep-status waiting',
  searching: 'ep-status searching',
  downloading: 'ep-status downloading',
  importing: 'ep-status importing',
}

export function EpisodeStatus({
  chase,
  prefix,
}: {
  chase: Pick<EpisodeChase, 'state' | 'airsAt' | 'episode'>
  /** Optional "Ep 2 ·" prefix for badges */
  prefix?: boolean
}) {
  if (chase.state === 'ready') return null
  const label = publicChaseLabel(chase)
  const text = prefix ? `Ep ${chase.episode} · ${label}` : label
  return (
    <span className={STATE_CLASS[chase.state]} title={text}>
      <span className="ep-status-ico" aria-hidden>
        <Icon name={STATE_ICON[chase.state]} size={13} />
      </span>
      <span>{text}</span>
    </span>
  )
}
