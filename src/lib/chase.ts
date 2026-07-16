export type ChaseState = 'waiting' | 'searching' | 'downloading' | 'importing' | 'ready'

export interface EpisodeChase {
  episode: number
  title?: string | null
  airsAt: string | null
  state: ChaseState
  progress?: number | null
  /** Persisted want backing this state (absent on pre-wants series). */
  wantId?: number
  attempts?: number
  nextAttemptAt?: string | null
  note?: string | null
}

/** "retry in 5h" / "retrying now" for a searching chase backed by a want. */
export function formatRetry(nextAttemptAt: string | null | undefined, now = Date.now()): string | null {
  if (!nextAttemptAt) return null
  const t = Date.parse(nextAttemptAt.endsWith('Z') ? nextAttemptAt : nextAttemptAt + 'Z')
  if (!Number.isFinite(t)) return null
  const delta = t - now
  if (delta <= 60_000) return 'retrying now'
  const hours = Math.floor(delta / 3_600_000)
  if (hours < 1) return `retry in ${Math.max(1, Math.round(delta / 60_000))}m`
  if (hours < 48) return `retry in ${hours}h`
  return `retry in ${Math.floor(hours / 24)}d`
}

export function formatCountdown(airsAt: string | null | undefined, now = Date.now()): string | null {
  if (!airsAt) return null
  const t = Date.parse(airsAt)
  if (!Number.isFinite(t)) return null
  const delta = t - now
  if (delta <= 0) {
    const ago = now - t
    const hours = Math.floor(ago / 3_600_000)
    if (hours < 1) return 'aired just now'
    if (hours < 48) return `aired ${hours}h ago`
    const days = Math.floor(hours / 24)
    return `aired ${days}d ago`
  }
  const hours = Math.floor(delta / 3_600_000)
  if (hours < 1) return 'airs soon'
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  const remH = hours % 24
  return remH ? `${days}d ${remH}h` : `${days}d`
}

export function formatAirShort(airsAt: string | null | undefined): string | null {
  if (!airsAt) return null
  const d = new Date(airsAt)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Public icon+label text (no torrent %). */
export function publicChaseLabel(
  chase: Pick<EpisodeChase, 'state' | 'airsAt' | 'episode'>,
  now = Date.now(),
): string {
  switch (chase.state) {
    case 'waiting': {
      const cd = formatCountdown(chase.airsAt, now)
      if (cd && !cd.startsWith('aired')) return cd.startsWith('airs') ? cd : `airs in ${cd}`
      if (chase.airsAt) return formatAirShort(chase.airsAt) ?? 'upcoming'
      return 'upcoming'
    }
    case 'searching':
      return 'searching'
    case 'downloading':
      return 'downloading'
    case 'importing':
      return 'almost ready'
    case 'ready':
      return 'ready'
  }
}

/** Admin list chip / panel timing line. */
export function adminChaseChipLabel(chase: EpisodeChase, now = Date.now()): string {
  const ep = `Ep ${chase.episode}`
  switch (chase.state) {
    case 'waiting': {
      const cd = formatCountdown(chase.airsAt, now)
      if (cd && !cd.startsWith('aired')) return `${ep} · ${cd}`
      return chase.airsAt ? `${ep} · upcoming` : `${ep} · upcoming`
    }
    case 'searching':
      return `${ep} · searching`
    case 'downloading': {
      const pct = chase.progress != null ? ` ${Math.round(chase.progress * 100)}%` : ''
      return `${ep} · downloading${pct}`
    }
    case 'importing':
      return `${ep} · importing`
    case 'ready':
      return `${ep} · ready`
  }
}
