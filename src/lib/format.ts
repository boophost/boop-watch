// Small display formatters shared across the admin UI.
//
// Each of these existed two or three times over before this file: `relTime` in
// Activity, Schedules and Comments, and `formatBytes`/`formatAired`/`formatEpNum`
// privately inside SeriesDetail — the only definitions in the repo, invisible to
// anything that wanted them.
//
// Note that the two `relTime`s were *not* the same function, so they are both
// here under honest names rather than merged into one that would have quietly
// changed how one of the two pages reads.

/** `1.4 GB`. Whole numbers below 10 units keep one decimal; `—` for nothing. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

/** `Mar 8, 2026`, falling back to the raw date part when unparseable. */
export function formatAired(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** `S04E07` when a season is known, else the bare episode number. */
export function formatEpNum(ep: { season?: number | null; episode: number | null }): string {
  if (ep.episode == null) return '—'
  if (ep.season != null) {
    return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`
  }
  return String(ep.episode)
}

/**
 * How long ago, seconds-precise near zero: `12s ago` / `4m ago` / `3h ago`.
 * Clamps to the past — for something that may be in the future use `relTime`.
 */
export function relPast(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/**
 * Signed distance from now: `in 5m` / `5m ago` / `now`. Minute-precision — for
 * a scheduled time, "in 43s" reads as false precision.
 */
export function relTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diff = t - Date.now()
  const mins = Math.round(Math.abs(diff) / 60000)
  if (mins < 1) return 'now'
  const s =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
  return diff >= 0 ? `in ${s}` : `${s} ago`
}
