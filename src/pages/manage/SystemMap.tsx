// Flow Map — system view. One card per flow, placed by lane (anime / TV &
// movies) and stage (trigger → intent → acquire → shared → import → publish),
// with the links *between* flows drawn: schedules and events that start them,
// `trigger.fire` chains, the wants table, qBittorrent categories, Jellyfin.
// The model and layout are derived in src/lib/systemMap.ts; this file only
// draws them and overlays live run state from the activity stream.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2, Map as MapIcon, RefreshCw, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { relPast } from '@/lib/format'
import {
  getFlowMap,
  getQueueStats,
  listSchedules,
  streamActivity,
  type FlowMapEntry,
  type FlowSchedule,
  type QueuedRun,
} from '@/lib/flows'
import {
  buildSystemModel,
  layoutSystemModel,
  type EdgeTone,
  type PlacedBox,
  type SystemLayout,
  type Tone,
} from '@/lib/systemMap'

export interface LiveState {
  running: Map<number, { node?: string; dryRun: boolean }>
  queued: Map<number, number>
  lastRun: Map<number, { ok: boolean; at: string; dryRun: boolean }>
}

const EMPTY_LIVE: LiveState = { running: new Map(), queued: new Map(), lastRun: new Map() }

const TONE_STROKE: Record<Tone, string> = {
  anime: 'stroke-violet-400',
  media: 'stroke-teal-400',
  other: 'stroke-zinc-500',
  infra: 'stroke-amber-400',
  heal: 'stroke-orange-400',
  code: 'stroke-zinc-500',
  trigger: 'stroke-zinc-500',
  neutral: 'stroke-zinc-500',
}
const EDGE_STROKE: Record<EdgeTone, string> = {
  normal: 'stroke-zinc-400',
  heal: 'stroke-orange-400',
  soft: 'stroke-zinc-600',
}
const EDGE_TEXT: Record<EdgeTone, string> = {
  normal: 'fill-zinc-400',
  heal: 'fill-orange-400',
  soft: 'fill-zinc-500',
}
const LANE_FILL: Record<string, string> = {
  anime: 'fill-violet-500/[0.06]',
  media: 'fill-teal-500/[0.06]',
  other: 'fill-zinc-500/[0.06]',
}
const LANE_TEXT: Record<string, string> = {
  anime: 'fill-violet-400',
  media: 'fill-teal-400',
  other: 'fill-zinc-400',
}
const PORT_STROKE = (c: string) =>
  /^anime/.test(c) ? 'stroke-violet-400' : /^(tv|movies)/.test(c) ? 'stroke-teal-400' : 'stroke-zinc-500'

const MONO = 'font-mono text-[10.5px]'

function statusLine(b: PlacedBox, live: LiveState): { text: string; cls: string } | null {
  if (b.kind !== 'flow' || b.flowId == null) return null
  const run = live.running.get(b.flowId)
  if (run) return { text: `running${run.dryRun ? ' (dry)' : ''}${run.node ? ` · ${run.node}` : ''}`, cls: 'fill-violet-300' }
  const q = live.queued.get(b.flowId)
  if (q) return { text: q > 1 ? `queued ×${q}` : 'queued', cls: 'fill-amber-300' }
  if (b.off) return { text: 'not running · schedule off', cls: 'fill-zinc-500' }
  const last = live.lastRun.get(b.flowId)
  if (last)
    return {
      text: `${last.ok ? 'ok' : 'failed'} ${relPast(last.at)}${last.dryRun ? ' · dry' : ''}`,
      cls: last.ok ? 'fill-zinc-500' : 'fill-red-400',
    }
  return { text: 'no recent runs', cls: 'fill-zinc-600' }
}

function Box({
  b,
  live,
  dim,
  onEnter,
  onLeave,
  onOpen,
}: {
  b: PlacedBox
  live: LiveState
  dim: boolean
  onEnter: () => void
  onLeave: () => void
  onOpen?: () => void
}) {
  const pill = b.kind === 'event' || b.kind === 'timer'
  const running = b.flowId != null && live.running.has(b.flowId)
  const status = statusLine(b, live)
  const cx = b.x + b.w / 2
  return (
    <g
      className={cn('transition-opacity', dim && 'opacity-30', onOpen && 'cursor-pointer')}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onOpen}
      role={onOpen ? 'link' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => (e.key === 'Enter' ? onOpen() : undefined) : undefined}
      aria-label={onOpen ? `Open ${b.title}` : undefined}
    >
      <title>{[b.title, ...b.lines, b.uses?.length ? `uses ${[...new Set(b.uses)].join(', ')}` : ''].filter(Boolean).join('\n')}</title>
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={pill ? b.h / 2 : 6}
        className={cn(
          'fill-card',
          b.off ? 'stroke-zinc-600' : TONE_STROKE[b.tone],
          running && 'stroke-violet-300',
        )}
        strokeWidth={running ? 2.5 : b.kind === 'qbit' ? 1.6 : 1.3}
        strokeDasharray={b.off || b.kind === 'job' ? '4 3' : undefined}
      />
      {running && (
        <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx={8} className="animate-pulse fill-none stroke-violet-400/40" strokeWidth={4} />
      )}
      {b.kind === 'wants' && <line x1={b.x} x2={b.x + b.w} y1={b.y + 10} y2={b.y + 10} className="stroke-violet-400/50" />}
      <text
        x={cx}
        y={pill ? b.y + b.h / 2 + 4 : b.y + (b.kind === 'wants' ? 32 : 19)}
        textAnchor="middle"
        className={cn('text-[12.5px] font-semibold', b.off ? 'fill-zinc-500' : 'fill-foreground')}
      >
        {b.title}
      </text>
      {!pill &&
        b.lines.map((l, i) => (
          <text key={l} x={cx} y={b.y + (b.kind === 'wants' ? 48 : 34) + i * 14} textAnchor="middle" className={cn(MONO, 'fill-muted-foreground')}>
            {l}
          </text>
        ))}
      {status && (
        <text x={cx} y={b.y + b.h - 8} textAnchor="middle" className={cn(MONO, status.cls)}>
          {status.text.length > 30 ? `${status.text.slice(0, 29)}…` : status.text}
        </text>
      )}
      {b.schedules?.map((s, i) => {
        const label = `${s.label}${s.off ? ' · off' : s.dry ? ' · dry' : ''}`
        const w = label.length * 6.1 + 14
        const x = b.x + b.w - w - 8 - i * (w + 4)
        return (
          <g key={`${s.label}${i}`}>
            <rect x={x} y={b.y - 8} width={w} height={15} rx={7.5} className={cn('fill-background', s.off ? 'stroke-zinc-600' : 'stroke-zinc-400')} strokeWidth={1} strokeDasharray={s.off ? '3 2' : undefined} />
            <text x={x + w / 2} y={b.y + 3} textAnchor="middle" className={cn('font-mono text-[9.5px]', s.off ? 'fill-zinc-500' : 'fill-zinc-300')}>
              {label}
            </text>
          </g>
        )
      })}
      {b.ports?.map((p) => {
        const y = b.portY?.[p] ?? 0
        return (
          <g key={p}>
            <rect x={b.x + 12} y={y - 11} width={b.w - 24} height={22} rx={3} className={cn('fill-background', PORT_STROKE(p))} strokeWidth={1.2} strokeDasharray={p.endsWith('-dev') ? '3 3' : undefined} />
            <text x={b.x + 20} y={y + 4} className={cn(MONO, 'fill-muted-foreground')}>
              {p}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export function SystemMapView({
  layout,
  live = EMPTY_LIVE,
  onOpenFlow,
}: {
  layout: SystemLayout
  live?: LiveState
  onOpenFlow?: (id: number) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const linked = useMemo(() => {
    if (!hover) return null
    const ids = new Set([hover])
    for (const e of layout.edges) {
      if (e.from === hover) ids.add(e.to)
      if (e.to === hover) ids.add(e.from)
    }
    return ids
  }, [hover, layout.edges])

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="Flow system map: every flow as a card, grouped by anime and TV & movies lanes and by stage, with the schedules, events, wants table, qBittorrent categories and Jellyfin links between them."
      className="block max-w-none select-none"
    >
      <defs>
        {(['normal', 'heal', 'soft'] as EdgeTone[]).map((t) => (
          <marker key={t} id={`sm-ah-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={cn(EDGE_STROKE[t].replace('stroke-', 'fill-'))} />
          </marker>
        ))}
      </defs>

      {layout.columns.map((c) => (
        <text key={c.id} x={c.x + c.w / 2} y={20} textAnchor="middle" className={cn(MONO, 'fill-muted-foreground tracking-[0.12em] uppercase')}>
          {c.label}
        </text>
      ))}
      {layout.lanes.map((l) => (
        <g key={l.id}>
          <rect x={0} y={l.y} width={layout.width} height={l.h} rx={8} className={LANE_FILL[l.id]} />
          <text x={10} y={l.y + 12} className={cn(MONO, 'font-semibold uppercase tracking-[0.08em]', LANE_TEXT[l.id])}>
            {l.label} lane
          </text>
        </g>
      ))}

      {layout.edges.map((e) => {
        const on = !linked || (linked.has(e.from) && linked.has(e.to) && (e.from === hover || e.to === hover))
        return (
          <g key={e.id} className={cn('transition-opacity', !on && 'opacity-15')}>
            <path
              d={e.d}
              fill="none"
              className={EDGE_STROKE[e.tone]}
              strokeWidth={on && linked ? 1.8 : 1.3}
              strokeDasharray={e.dashed ? '4 3' : undefined}
              markerEnd={`url(#sm-ah-${e.tone})`}
            />
            {e.label && e.labelAt && (
              <text
                x={e.labelAt.x}
                y={e.labelAt.y}
                textAnchor={e.labelAt.anchor}
                className={cn(MONO, EDGE_TEXT[e.tone])}
                style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 4, strokeLinejoin: 'round' }}
              >
                {e.label}
              </text>
            )}
          </g>
        )
      })}

      {layout.boxes.map((b) => (
        <Box
          key={b.id}
          b={b}
          live={live}
          dim={Boolean(linked && !linked.has(b.id))}
          onEnter={() => setHover(b.id)}
          onLeave={() => setHover((h) => (h === b.id ? null : h))}
          onOpen={b.flowId != null && onOpenFlow ? () => onOpenFlow(b.flowId!) : undefined}
        />
      ))}
    </svg>
  )
}

function Legend() {
  const item = (cls: string, label: string, extra?: string) => (
    <span className="inline-flex items-center gap-2">
      <span className={cn('inline-block h-3 w-5 rounded-sm border-[1.5px]', cls, extra)} />
      {label}
    </span>
  )
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11.5px] text-muted-foreground">
      {item('rounded-full border-zinc-500', 'event')}
      <span className="inline-flex items-center gap-2">
        <span className="rounded-full border border-zinc-400 px-1.5 text-[9.5px] text-zinc-300">every 15 m</span>
        schedule
      </span>
      {item('border-violet-400', 'anime flow')}
      {item('border-teal-400', 'TV / movie flow')}
      {item('border-amber-400', 'shared infrastructure')}
      {item('border-orange-400', 'healer or destructive edge')}
      {item('border-dashed border-zinc-500', 'scheduler code or switched off')}
      <span>hover a card to trace its links · click a flow to open it</span>
    </div>
  )
}

/** Applies one activity-stream event to the live overlay. */
function applyEvent(prev: LiveState, ev: Parameters<Parameters<typeof streamActivity>[0]>[0], tokens: Map<string, number>): LiveState {
  switch (ev.type) {
    case 'snapshot': {
      const lastRun = new Map(prev.lastRun)
      for (const r of ev.runs) if (r.flow_id != null && !lastRun.has(r.flow_id)) lastRun.set(r.flow_id, { ok: r.ok, at: r.started_at, dryRun: r.dry_run })
      return { ...prev, lastRun }
    }
    case 'start': {
      if (ev.flowId == null) return prev
      tokens.set(ev.runToken, ev.flowId)
      const running = new Map(prev.running)
      running.set(ev.flowId, { dryRun: ev.dryRun })
      return { ...prev, running }
    }
    case 'node': {
      const id = tokens.get(ev.runToken)
      if (id == null || !prev.running.has(id)) return prev
      const running = new Map(prev.running)
      running.set(id, { ...prev.running.get(id)!, node: ev.node })
      return { ...prev, running }
    }
    case 'done':
    case 'aborted': {
      const id = tokens.get(ev.runToken)
      tokens.delete(ev.runToken)
      if (id == null) return prev
      const running = new Map(prev.running)
      running.delete(id)
      const lastRun = new Map(prev.lastRun)
      if (ev.type === 'done') lastRun.set(id, { ok: ev.run.ok, at: ev.run.started_at, dryRun: ev.run.dry_run })
      else lastRun.set(id, { ok: false, at: new Date().toISOString(), dryRun: false })
      return { ...prev, running, lastRun }
    }
    case 'queue':
      return { ...prev, queued: queuedCounts(ev.pending) }
    default:
      return prev
  }
}

function queuedCounts(pending: QueuedRun[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const q of pending) if (q.flowId != null) m.set(q.flowId, (m.get(q.flowId) ?? 0) + 1 + q.coalesced)
  return m
}

export default function SystemMap({ onShowGraphs }: { onShowGraphs: () => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<{ flows: FlowMapEntry[]; schedules: FlowSchedule[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gen, setGen] = useState(0)
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE)
  const [connected, setConnected] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [map, sched, queue] = await Promise.all([getFlowMap(), listSchedules(), getQueueStats().catch(() => null)])
      setData({ flows: map.flows, schedules: sched.schedules })
      if (queue) setLive((l) => ({ ...l, queued: queuedCounts(queue.runs?.pending ?? []) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load flows')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, gen])

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    const tokens = new Map<string, number>()
    const loop = async () => {
      while (!cancelled) {
        try {
          await streamActivity((ev) => {
            if (cancelled) return
            setConnected(true)
            setLive((prev) => applyEvent(prev, ev, tokens))
          }, ac.signal)
        } catch {
          if (cancelled) return
        }
        setConnected(false)
        if (cancelled) return
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void loop()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [gen])

  const model = useMemo(() => (data ? buildSystemModel(data.flows, data.schedules) : null), [data])
  const layout = useMemo(() => (model ? layoutSystemModel(model) : null), [model])

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:px-6">
        <MapIcon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Flow Map</h1>
        <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Map view">
          <button type="button" role="tab" aria-selected className="rounded px-2.5 py-1 font-medium bg-muted text-foreground">
            System
          </button>
          <button type="button" role="tab" aria-selected={false} className="rounded px-2.5 py-1 text-muted-foreground hover:text-foreground" onClick={onShowGraphs}>
            Graphs
          </button>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400')} />
          {connected ? 'live' : 'reconnecting…'}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => setGen((g) => g + 1)}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/manage/flows">Flows</Link>
        </Button>
      </header>
      <main className="grid min-w-0 gap-4 p-4 md:p-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!layout && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading flows…
          </p>
        ) : null}
        {layout ? (
          <>
            <div className="overflow-x-auto rounded-lg border bg-background">
              <SystemMapView layout={layout} live={live} onOpenFlow={(id) => navigate(`/manage/flows/${id}`)} />
            </div>
            <Legend />
            {model && model.components.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Workflow className="size-3.5" />
                <span>Components</span>
                {model.components.map((c) => (
                  <Link key={c.id} to={`/manage/flows/${c.id}`} className="rounded border px-2 py-0.5 text-foreground hover:bg-muted">
                    {c.name}
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}
