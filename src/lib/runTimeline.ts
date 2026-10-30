// The Flow Map's run timeline: what actually ran (from the run log), what is
// running and queued now (activity stream), and what the schedules will fire
// next — one row per flow, in the same lane order as the map above it.
//
// Pure: the view measures, draws and handles hover. Schedule projection only
// knows what a schedule row says (`next_run` + cadence); event-driven runs
// (a finished download, a catalog add) appear once they happen, never ahead.
import type { FlowRun, FlowSchedule, QueuedRun } from './flows'
import type { SystemModel, Tone } from './systemMap'
import { cadence } from './systemMap'

export interface TimelineRow {
  flowId: number
  title: string
  tone: Tone
  cadences: string[]
}

export type MarkKind = 'run' | 'running' | 'scheduled' | 'queued'

export interface TimelineMark {
  id: string
  flowId: number
  kind: MarkKind
  /** Epoch ms. A scheduled mark is an instant (t0 === t1). */
  t0: number
  t1: number
  ok?: boolean
  dryRun?: boolean
  run?: FlowRun
  /** Running: the node it is on. Queued: what fired it. Scheduled: cadence. */
  note?: string
  coalesced?: number
}

export interface SlotCount {
  t0: number
  /** Runs that started in this slot (past) or are scheduled to (future). */
  count: number
  future: boolean
}

export interface Timeline {
  from: number
  to: number
  now: number
  rows: TimelineRow[]
  marks: TimelineMark[]
  slots: SlotCount[]
  /** Merged intervals in which some flow held the run lock. */
  busy: [number, number][]
}

export interface TimelineInput {
  model: SystemModel
  schedules: FlowSchedule[]
  runs: FlowRun[]
  running: Map<number, { startedAt: string; node?: string; dryRun: boolean }>
  queued: QueuedRun[]
  now: number
  pastMs: number
  futureMs: number
}

export const SLOT_MS = 15 * 60_000

function stepMs(s: FlowSchedule): number | null {
  const spec = s.spec as Record<string, unknown>
  if (s.kind === 'interval') return Number(spec.every) * (spec.unit === 'hours' ? 3_600_000 : 60_000) || null
  if (s.kind === 'daily') return 86_400_000
  if (s.kind === 'weekly') return 7 * 86_400_000
  return null
}

const LANE_ORDER = { anime: 0, media: 1, other: 2 } as const
const COL_ORDER = { trigger: 0, intent: 1, acquire: 2, shared: 3, import: 4, publish: 5 } as const

export function buildTimeline(input: TimelineInput): Timeline {
  const { model, schedules, runs, running, queued, now } = input
  const from = now - input.pastMs
  const to = now + input.futureMs

  // Flow ids each schedule starts: a name-based schedule fires every flow with
  // a matching trigger.start; a legacy one names its flow.
  const flowBoxes = model.boxes.filter((b) => b.kind === 'flow' && b.flowId != null)
  const startersOf = new Map<number, number[]>()
  for (const s of schedules)
    startersOf.set(
      s.id,
      flowBoxes
        .filter((b) => (s.trigger_name ? b.starts?.includes(s.trigger_name) : s.flow_id === b.flowId))
        .map((b) => b.flowId!),
    )

  const rows: TimelineRow[] = flowBoxes
    .slice()
    .sort(
      (a, b) =>
        LANE_ORDER[a.lane ?? 'other'] - LANE_ORDER[b.lane ?? 'other'] ||
        COL_ORDER[a.column] - COL_ORDER[b.column] ||
        a.title.localeCompare(b.title),
    )
    .map((b) => ({
      flowId: b.flowId!,
      title: b.title,
      tone: b.off ? 'code' : b.tone,
      cadences: (b.schedules ?? []).map((s) => `${s.label}${s.off ? ' · off' : ''}`),
    }))
  const known = new Set(rows.map((r) => r.flowId))

  const marks: TimelineMark[] = []
  for (const r of runs) {
    if (r.flow_id == null || !known.has(r.flow_id)) continue
    const t0 = Date.parse(r.started_at)
    const t1 = t0 + Math.max(0, r.duration_ms)
    if (!Number.isFinite(t0) || t1 < from || t0 > to) continue
    marks.push({ id: `run:${r.id}`, flowId: r.flow_id, kind: 'run', t0, t1, ok: r.ok, dryRun: r.dry_run, run: r })
  }
  for (const [flowId, r] of running) {
    if (!known.has(flowId)) continue
    const t0 = Date.parse(r.startedAt)
    marks.push({ id: `running:${flowId}`, flowId, kind: 'running', t0: Number.isFinite(t0) ? t0 : now, t1: now, dryRun: r.dryRun, note: r.node })
  }
  for (const q of queued) {
    if (q.flowId == null || !known.has(q.flowId)) continue
    marks.push({ id: `queued:${q.id}`, flowId: q.flowId, kind: 'queued', t0: now, t1: now, dryRun: q.dryRun, note: q.trigger, coalesced: q.coalesced })
  }
  for (const s of schedules) {
    if (!s.enabled || !s.next_run) continue
    const step = stepMs(s)
    let t = Date.parse(s.next_run)
    if (!Number.isFinite(t)) continue
    // A schedule overdue by a tick (the scheduler fires within 30 s) still
    // belongs at "now", not in the past.
    if (t < now) t = now
    for (let i = 0; t <= to && i < 500; i++) {
      for (const flowId of startersOf.get(s.id) ?? [])
        marks.push({ id: `sched:${s.id}:${i}:${flowId}`, flowId, kind: 'scheduled', t0: t, t1: t, dryRun: s.dry_run, note: cadence(s) })
      if (step == null) break
      t += step
    }
  }

  const slots: SlotCount[] = []
  const first = Math.floor(from / SLOT_MS) * SLOT_MS
  for (let t = first; t < to; t += SLOT_MS) slots.push({ t0: t, count: 0, future: t >= now })
  for (const m of marks) {
    if (m.kind === 'queued') continue
    const i = Math.floor((m.t0 - first) / SLOT_MS)
    if (slots[i]) slots[i].count++
  }

  const spans = marks
    .filter((m) => m.kind === 'run' || m.kind === 'running')
    .map((m) => [m.t0, Math.max(m.t1, m.t0 + 1000)] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const busy: [number, number][] = []
  for (const sp of spans) {
    const last = busy[busy.length - 1]
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1])
    else busy.push([...sp])
  }

  return { from, to, now, rows, marks, slots, busy }
}

/** The trigger that started a run, from its first trigger node's notes. */
export function runTrigger(run: FlowRun): string | null {
  for (const a of run.activity) {
    if (!a.type.startsWith('trigger.')) continue
    const note = a.notes.find((n) => !/^idle/.test(n))
    if (note) return note
  }
  return null
}

/** The few notes worth showing on hover: errors first, then what sinks did. */
export function runHighlights(run: FlowRun, max = 4): string[] {
  const out: string[] = []
  for (const a of run.activity) if (a.status === 'error') out.push(`${a.node}: ${a.error ?? a.notes[0] ?? 'error'}`)
  for (const a of run.activity)
    if (a.type.startsWith('sink.') && a.status !== 'error')
      for (const n of a.notes) if (!/^idle|^dry run — would attempt 0/.test(n)) out.push(`${a.node}: ${n}`)
  for (const a of run.activity)
    if (a.type.startsWith('enrich.') && a.status !== 'error' && out.length < max && a.notes[0]) out.push(`${a.node}: ${a.notes[0]}`)
  return out.slice(0, max)
}
