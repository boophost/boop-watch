// The one gate every "add a torrent to qBittorrent" passes through.
//
// Two incidents put this here. Sourcing flows kept queueing season packs until
// the shared media disk hit 0 bytes free, and qBittorrent spent two weeks
// seeding over the home ISP connection instead of the VPN (it now binds to the
// VPN interface, but that is a qBittorrent setting a reset silently undoes).
// Before this, the only protection was a `minFreeGB` on one planner node; every
// other producer queued blind.
//
// `qbitAddTorrents()` is the only code that POSTs to `torrents/add`, and it
// refuses unless `checkQbitGuard()` passes for the instance the add is going
// to. Callers that want to route refusals visibly (the sink node) call
// `checkQbitGuard()` first; the add re-checks from the short-lived cache, so
// the second check costs no requests.
//
// Kept free of any qBittorrent login logic: the shared client (server/qbit.ts)
// and the sink node (per-node connection) each authenticate their own way and
// hand the guard a cookie.

import { cfgNum, cfgSafe } from './config.js'

export interface QbitGuardStatus {
  ok: boolean
  /** Free space qBittorrent reports for its default save path. */
  freeGB: number | null
  /** 0 = capacity check off. */
  floorGB: number
  /** `current_network_interface` — '' means qBittorrent binds to any interface. */
  interface: string | null
  /** Empty = interface check off. */
  requiredInterface: string
  /**
   * qBittorrent's last-seen public IPv4. Omitted when it IS the home IP, so the
   * status never carries the home address.
   */
  externalIp?: string
  reasons: string[]
}

/** `null` = not read (that check was off when the state was fetched). */
interface QbitState {
  free: number | null
  iface: string | null
  extIp: string | null
}

/** Long enough that one flow adding a batch reads qBittorrent once; short
 *  enough that a fixed setting is noticed on the next run. */
const CACHE_MS = 5_000
const cache = new Map<string, { at: number; state: QbitState }>()

export function clearQbitGuardCache(): void {
  cache.clear()
}

const GiB = 2 ** 30

function settings() {
  const floor = cfgNum('QBIT_MIN_FREE_GB', 100)
  return {
    floorGB: Number.isFinite(floor) && floor > 0 ? floor : 0,
    requiredInterface: cfgSafe('QBIT_REQUIRED_INTERFACE').trim(),
    homeIp: cfgSafe('HOME_PUBLIC_IP').trim(),
  }
}

async function readJson(base: string, path: string, cookie: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function readState(
  base: string,
  getCookie: () => Promise<string>,
  need: { maindata: boolean; prefs: boolean },
): Promise<QbitState> {
  const hit = cache.get(base)
  if (
    hit &&
    Date.now() - hit.at < CACHE_MS &&
    (!need.maindata || hit.state.extIp !== null) &&
    (!need.prefs || hit.state.iface !== null)
  ) {
    return hit.state
  }
  const cookie = await getCookie()
  const state: QbitState = { free: null, iface: null, extIp: null }
  if (need.maindata) {
    const md = await readJson(base, '/api/v2/sync/maindata', cookie)
    const ss = (md.server_state ?? {}) as Record<string, unknown>
    state.free = typeof ss.free_space_on_disk === 'number' ? ss.free_space_on_disk : null
    state.extIp = typeof ss.last_external_address_v4 === 'string' ? ss.last_external_address_v4.trim() : ''
  }
  if (need.prefs) {
    const prefs = await readJson(base, '/api/v2/app/preferences', cookie)
    state.iface = typeof prefs.current_network_interface === 'string' ? prefs.current_network_interface : ''
  }
  cache.set(base, { at: Date.now(), state })
  return state
}

/**
 * Would an add to the qBittorrent at `base` be allowed right now?
 *
 * `getCookie` is only called on a cache miss. Settings are read on every call
 * (only qBittorrent's state is cached), so a config edit applies immediately.
 * A failed read refuses — an unverifiable guard is not a passed one.
 */
export async function checkQbitGuard(
  base: string,
  getCookie: () => Promise<string>,
): Promise<QbitGuardStatus> {
  const s = settings()
  const status: QbitGuardStatus = {
    ok: true,
    freeGB: null,
    floorGB: s.floorGB,
    interface: null,
    requiredInterface: s.requiredInterface,
    reasons: [],
  }
  const need = { maindata: s.floorGB > 0 || s.homeIp !== '', prefs: s.requiredInterface !== '' }
  if (!need.maindata && !need.prefs) return status

  let state: QbitState
  try {
    state = await readState(base.replace(/\/$/, ''), getCookie, need)
  } catch (e) {
    status.ok = false
    status.reasons.push(`could not read qBittorrent state: ${e instanceof Error ? e.message : String(e)}`)
    return status
  }

  status.freeGB = state.free === null ? null : Math.round((state.free / GiB) * 10) / 10
  status.interface = state.iface
  if (state.extIp && state.extIp !== s.homeIp) status.externalIp = state.extIp

  if (s.floorGB > 0) {
    if (state.free === null) status.reasons.push('qBittorrent did not report free space')
    else if (state.free < s.floorGB * GiB)
      status.reasons.push(`only ${status.freeGB} GB free on the download disk (floor ${s.floorGB} GB)`)
  }
  if (s.requiredInterface && state.iface !== s.requiredInterface) {
    status.reasons.push(
      `qBittorrent is bound to ${state.iface ? `"${state.iface}"` : 'any interface'}, not "${s.requiredInterface}"`,
    )
  }
  if (s.homeIp && state.extIp === s.homeIp) {
    status.reasons.push('qBittorrent’s external IP is the home connection, not the VPN')
  }
  status.ok = status.reasons.length === 0
  return status
}

export class QbitGuardRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`qBittorrent add refused — ${reasons.join('; ')}`)
    this.name = 'QbitGuardRefused'
  }
}

/**
 * The only `torrents/add` call in the codebase. Throws `QbitGuardRefused`
 * without sending anything when the guard fails.
 */
export async function qbitAddTorrents(base: string, cookie: string, form: URLSearchParams): Promise<void> {
  const b = base.replace(/\/$/, '')
  const guard = await checkQbitGuard(b, async () => cookie)
  if (!guard.ok) throw new QbitGuardRefused(guard.reasons)
  const add = await fetch(`${b}/api/v2/torrents/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  if (!add.ok) throw new Error(`qBittorrent add failed (${add.status})`)
}
