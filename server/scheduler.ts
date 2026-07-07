// In-process scheduler for flow runs. A single setInterval tick fires any
// flow_schedules row whose next_run is due, honouring the same global flow lock
// as the manual /run route (one flow at a time). Safe as an in-process loop
// because the app runs a single replica — see CLAUDE.md.

import { FlowGraph, validateGraph } from './flowExecutor.js'
import type { RunReport } from './flowExecutor.js'
import {
  acquireFlowLock,
  releaseFlowLock,
  runFlowAndRecord,
  getLastRecordedRunId,
  fireTrigger,
  fireEvent,
} from './flowRoutes.js'
import { buildSpecResolver } from './flowComponents.js'
import {
  dueSchedules,
  getFlow,
  markScheduleFired,
  flowsWithTriggerType,
  triggerStateHas,
  triggerStateAdd,
  triggerStateSeeded,
  markTriggerSeeded,
  type FlowSchedule,
  type ScheduleKind,
  type ScheduleSpec,
  type WeekDay,
} from './flowsDb.js'
import { listSeries } from './db.js'
import { getAllPortalItems } from './portalDb.js'
import { SCHEDULE_TZ, libraryAirings } from './schedule.js'
import type { FlowItem } from './flowNodes.js'

const DAY_INDEX: Record<WeekDay, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

// Wall-clock parts of an instant as seen in SCHEDULE_TZ (mo is 0-based; dow is
// 0=Sun). The weekday is derived from the tz-local calendar date, so it is
// stable regardless of the runtime's own timezone.
function localParts(date: Date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TZ,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  const y = +m.year, mo = +m.month - 1, d = +m.day, h = +m.hour, mi = +m.minute
  const dow = new Date(Date.UTC(y, mo, d)).getUTCDay()
  return { y, mo, d, h, mi, dow }
}

// Offset (ms) to add to a UTC instant to get its SCHEDULE_TZ wall clock.
function tzOffsetMs(date: Date): number {
  const p = localParts(date)
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60000) * 60000
}

// The UTC instant (ms) at which the given SCHEDULE_TZ wall time occurs. Date.UTC
// normalises out-of-range day values, so callers can pass d+1 / d+delta freely.
// One refinement pass handles DST offset changes across the target instant.
function fromZonedWall(y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo, d, h, mi)
  let ts = naive - tzOffsetMs(new Date(naive))
  ts = naive - tzOffsetMs(new Date(ts))
  return ts
}

function parseHHMM(at: string): [number, number] {
  const [h, m] = at.split(':').map(Number)
  return [h, m]
}

// The next instant (ISO) this schedule should fire after `from`, or null if it
// never will again (a spent one-time schedule / a past runAt). Interval is
// measured from `from`, so a fire reschedules relative to when it ran.
export function computeNextRun(
  kind: ScheduleKind,
  spec: ScheduleSpec,
  from: Date = new Date(),
): string | null {
  const fromMs = from.getTime()

  if (kind === 'interval') {
    const s = spec as { every: number; unit: 'minutes' | 'hours' }
    const ms = (s.unit === 'hours' ? 3_600_000 : 60_000) * s.every
    return new Date(fromMs + ms).toISOString()
  }

  if (kind === 'once') {
    const t = Date.parse((spec as { runAt: string }).runAt)
    if (!Number.isFinite(t) || t <= fromMs) return null
    return new Date(t).toISOString()
  }

  // daily / weekly — both hang off an HH:MM wall time in SCHEDULE_TZ.
  const at = (spec as { at: string }).at
  const [h, mi] = parseHHMM(at)
  const lp = localParts(from)

  if (kind === 'daily') {
    let cand = fromZonedWall(lp.y, lp.mo, lp.d, h, mi)
    if (cand <= fromMs) cand = fromZonedWall(lp.y, lp.mo, lp.d + 1, h, mi)
    return new Date(cand).toISOString()
  }

  // weekly
  const target = DAY_INDEX[(spec as { day: WeekDay }).day]
  const delta = (target - lp.dow + 7) % 7
  let cand = fromZonedWall(lp.y, lp.mo, lp.d + delta, h, mi)
  if (cand <= fromMs) cand = fromZonedWall(lp.y, lp.mo, lp.d + delta + 7, h, mi)
  return new Date(cand).toISOString()
}

// Fire a due schedule from the tick. Never throws: a thrown run is logged and the
// schedule still rolls forward so a failing flow can't hot-loop the tick. Assumes
// the flow lock is already held.
async function fireScheduled(sched: FlowSchedule): Promise<void> {
  const now = new Date()
  const flow = getFlow(sched.flow_id)
  if (!flow) {
    console.warn(`scheduler: flow #${sched.flow_id} for schedule #${sched.id} is gone — disabling`)
    markScheduleFired(sched.id, {
      last_run: now.toISOString(),
      last_run_id: null,
      next_run: null,
      enabled: false,
    })
    return
  }
  let runId: number | null = null
  try {
    const graph = JSON.parse(flow.graph) as FlowGraph
    const resolver = buildSpecResolver(flow.id, getFlow)
    const invalid = validateGraph(graph, resolver)
    if (invalid) throw new Error(invalid)
    await runFlowAndRecord(graph, {
      dryRun: sched.dry_run,
      flowId: flow.id,
      flowName: flow.name,
      resolveSpec: resolver,
    })
    runId = getLastRecordedRunId()
  } catch (e) {
    console.error(`scheduler: schedule #${sched.id} threw`, e)
  }
  const next = sched.kind === 'once' ? null : computeNextRun(sched.kind, sched.spec, now)
  markScheduleFired(sched.id, {
    last_run: now.toISOString(),
    last_run_id: runId,
    next_run: next,
    enabled: sched.kind === 'once' ? false : sched.enabled,
  })
}

// Manual "Run now" (REST / MCP). Runs the flow and stamps last_run without
// touching the cadence (next_run / enabled are preserved). Assumes the flow lock
// is held by the caller; surfaces run errors so the caller can 500.
export async function runScheduleNow(sched: FlowSchedule): Promise<RunReport> {
  const flow = getFlow(sched.flow_id)
  if (!flow) throw new Error('Flow not found for this schedule')
  const graph = JSON.parse(flow.graph) as FlowGraph
  const resolver = buildSpecResolver(flow.id, getFlow)
  const invalid = validateGraph(graph, resolver)
  if (invalid) throw new Error(invalid)
  const report = await runFlowAndRecord(graph, {
    dryRun: sched.dry_run,
    flowId: flow.id,
    flowName: flow.name,
    resolveSpec: resolver,
  })
  markScheduleFired(sched.id, {
    last_run: new Date().toISOString(),
    last_run_id: getLastRecordedRunId(),
    next_run: sched.next_run,
    enabled: sched.enabled,
  })
  return report
}

// Roll a schedule's cadence forward without recording a specific run id (used
// for name-based fires, which may fan out to several flows).
function rollSchedule(sched: FlowSchedule, now: Date): void {
  markScheduleFired(sched.id, {
    last_run: now.toISOString(),
    last_run_id: null,
    next_run: sched.kind === 'once' ? null : computeNextRun(sched.kind, sched.spec, now),
    enabled: sched.kind === 'once' ? false : sched.enabled,
  })
}

// The soonest-due schedule, if any (the rest wait for the next tick).
async function fireDueSchedule(): Promise<void> {
  const due = dueSchedules(new Date().toISOString())
  if (due.length === 0) return
  const sched = due[0]
  if (sched.trigger_name) {
    // Name-based: roll the cadence now, then publish — fireTrigger takes the
    // flow lock per subscribing run itself (so the tick must NOT hold it).
    rollSchedule(sched, new Date())
    await fireTrigger(sched.trigger_name, []).catch((e) =>
      console.error(`scheduler: fireTrigger("${sched.trigger_name}") threw`, e),
    )
    return
  }
  // Legacy flow-id schedule — one flow at a time; back off if a run is in progress.
  if (!acquireFlowLock()) return
  try {
    await fireScheduled(sched)
  } finally {
    releaseFlowLock()
  }
}

// --- Event-trigger watchers ------------------------------------------------
// Poll each event source; fire flows whose entry point is the matching event
// trigger for genuinely-new events. Guarded by subscriber existence so nothing
// is polled when no flow listens. The first pass per kind seeds current state
// without firing (so a deploy doesn't fire for the whole existing library).

// New catalog titles (the /manage Catalog = series table) since last seen.
// Keyed by mal_id under state kind 'catalog-item' — a fresh kind so it seeds
// silently on first tick rather than re-firing history (the old 'new-item'
// watermark held portal ids).
async function watchNewItems(): Promise<void> {
  if (flowsWithTriggerType('trigger.new-item').length === 0) return
  const series = listSeries()
  const key = (s: { mal_id: number }) => String(s.mal_id)
  if (!triggerStateSeeded('catalog-item')) {
    triggerStateAdd('catalog-item', series.map(key))
    markTriggerSeeded('catalog-item')
    return
  }
  const fresh = series.filter((s) => !triggerStateHas('catalog-item', key(s)))
  if (fresh.length === 0) return
  triggerStateAdd('catalog-item', fresh.map(key))
  await fireEvent('new-item', fresh as unknown as FlowItem[]).catch((e) =>
    console.error('scheduler: fireEvent(new-item) threw', e),
  )
}

// New public-portal titles (Series/Movie in the Jellyfin collection) since last
// seen — the "landed on the site" event, distinct from a catalog add.
async function watchNewPortalItems(): Promise<void> {
  if (flowsWithTriggerType('trigger.new-portal').length === 0) return
  const titles = getAllPortalItems().filter((p) => p.type === 'Series' || p.type === 'Movie')
  if (!triggerStateSeeded('portal-item')) {
    triggerStateAdd('portal-item', titles.map((t) => t.id))
    markTriggerSeeded('portal-item')
    return
  }
  const fresh = titles.filter((t) => !triggerStateHas('portal-item', t.id))
  if (fresh.length === 0) return
  triggerStateAdd('portal-item', fresh.map((t) => t.id))
  await fireEvent('new-portal', fresh as unknown as FlowItem[]).catch((e) =>
    console.error('scheduler: fireEvent(new-portal) threw', e),
  )
}

// Library airings whose air time has passed since last seen.
async function watchReleases(): Promise<void> {
  if (flowsWithTriggerType('trigger.release').length === 0) return
  const airings = await libraryAirings()
  const aired = airings.filter((a) => a.aired)
  if (!triggerStateSeeded('release')) {
    triggerStateAdd('release', aired.map((a) => a.key))
    markTriggerSeeded('release')
    return
  }
  const fresh = aired.filter((a) => !triggerStateHas('release', a.key))
  if (fresh.length === 0) return
  triggerStateAdd('release', fresh.map((a) => a.key))
  // One fire per newly-aired episode so downstream sees a single airing.
  for (const a of fresh) {
    await fireEvent('release', [a.item as unknown as FlowItem]).catch((e) =>
      console.error('scheduler: fireEvent(release) threw', e),
    )
  }
}

async function tick(): Promise<void> {
  await fireDueSchedule()
  // Watchers run after the schedule pass (they take the flow lock per run).
  await watchNewItems().catch((e) => console.error('scheduler: watchNewItems threw', e))
  await watchNewPortalItems().catch((e) => console.error('scheduler: watchNewPortalItems threw', e))
  await watchReleases().catch((e) => console.error('scheduler: watchReleases threw', e))
}

let timer: ReturnType<typeof setInterval> | null = null
const TICK_MS = 30_000

export function startScheduler(): void {
  if (timer) return
  void tick().catch((e) => console.error('scheduler: initial tick failed', e))
  timer = setInterval(() => {
    void tick().catch((e) => console.error('scheduler: tick failed', e))
  }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
}
