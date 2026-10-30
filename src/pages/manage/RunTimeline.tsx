// Live run timeline under the Flow Map's system view: past runs as bars at
// their real start and length, the running one growing to "now", scheduled
// fires as ticks ahead, and a lock row counting runs per 15-minute slot.
// Hover anything for its details.
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { relPast, relTime } from '@/lib/format'
import { runHighlights, runTrigger, SLOT_MS, type Timeline, type TimelineMark } from '@/lib/runTimeline'
import type { Tone } from '@/lib/systemMap'

const LABEL_W = 210
const ROW_H = 24
const HEAD_H = 22
const PAD_R = 14

const TONE_FILL: Record<Tone, string> = {
  anime: 'fill-violet-400',
  media: 'fill-teal-400',
  other: 'fill-zinc-400',
  infra: 'fill-amber-400',
  heal: 'fill-orange-400',
  code: 'fill-zinc-500',
  trigger: 'fill-zinc-400',
  neutral: 'fill-zinc-400',
}
const TONE_STROKE: Record<Tone, string> = {
  anime: 'stroke-violet-400',
  media: 'stroke-teal-400',
  other: 'stroke-zinc-400',
  infra: 'stroke-amber-400',
  heal: 'stroke-orange-400',
  code: 'stroke-zinc-500',
  trigger: 'stroke-zinc-400',
  neutral: 'stroke-zinc-400',
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

type Hover =
  | { kind: 'mark'; mark: TimelineMark; x: number; y: number }
  | { kind: 'slot'; t0: number; count: number; future: boolean; x: number; y: number }
  | { kind: 'busy'; t0: number; t1: number; x: number; y: number }

function MarkDetail({ m, title }: { m: TimelineMark; title: string }) {
  const head = (status: string, cls: string) => (
    <div className="flex items-baseline gap-2">
      <span className="font-semibold text-foreground">{title}</span>
      <span className={cn('font-mono text-[11px]', cls)}>{status}</span>
    </div>
  )
  if (m.kind === 'run' && m.run) {
    const r = m.run
    const trig = runTrigger(r)
    const notes = runHighlights(r)
    return (
      <>
        {head(`${r.ok ? 'ok' : 'failed'}${r.dry_run ? ' · dry run' : ''}`, r.ok ? 'text-emerald-400' : 'text-red-400')}
        <div className="font-mono text-[11px] text-muted-foreground">
          {clock(m.t0)} · {relPast(r.started_at)} · took {duration(r.duration_ms)}
        </div>
        {trig && <div className="text-[11px] text-muted-foreground">trigger: {trig}</div>}
        {r.error && <div className="text-[11px] text-red-400">{r.error}</div>}
        {notes.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px] text-foreground/90">
            {notes.map((n) => (
              <li key={n} className="line-clamp-2">
                {n}
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }
  if (m.kind === 'running')
    return (
      <>
        {head(`running${m.dryRun ? ' · dry run' : ''}`, 'text-violet-300')}
        <div className="font-mono text-[11px] text-muted-foreground">
          started {clock(m.t0)} · {duration(Date.now() - m.t0)} so far
        </div>
        {m.note && <div className="text-[11px] text-foreground/90">now at: {m.note}</div>}
      </>
    )
  if (m.kind === 'queued')
    return (
      <>
        {head('queued', 'text-amber-300')}
        <div className="text-[11px] text-muted-foreground">
          waiting for the run lock{m.note ? ` · fired by ${m.note}` : ''}
          {m.coalesced ? ` · ${m.coalesced} identical fire(s) merged` : ''}
        </div>
      </>
    )
  return (
    <>
      {head(`scheduled${m.dryRun ? ' · dry' : ''}`, 'text-zinc-300')}
      <div className="font-mono text-[11px] text-muted-foreground">
        {clock(m.t0)} · {relTime(new Date(m.t0).toISOString())} · {m.note}
      </div>
    </>
  )
}

export default function RunTimeline({
  timeline,
  onOpenFlow,
}: {
  timeline: Timeline
  onOpenFlow?: (id: number) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(640, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { from, to, now, rows, marks, slots, busy } = timeline
  const plotW = width - LABEL_W - PAD_R
  const x = (t: number) => LABEL_W + ((t - from) / (to - from)) * plotW
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.flowId, i])), [rows])
  const titleOf = useMemo(() => new Map(rows.map((r) => [r.flowId, r.title])), [rows])
  const toneOf = useMemo(() => new Map(rows.map((r) => [r.flowId, r.tone])), [rows])

  const bodyH = rows.length * ROW_H
  const lockY = HEAD_H + bodyH + 14
  const barMax = 34
  const maxCount = Math.max(3, ...slots.map((s) => s.count))
  const height = lockY + 12 + barMax + 26

  const hourStep = to - from > 12 * 3_600_000 ? 3 : 1
  const ticks: number[] = []
  const h0 = new Date(from)
  h0.setMinutes(0, 0, 0)
  for (let t = h0.getTime() + 3_600_000; t < to; t += 3_600_000) if (new Date(t).getHours() % hourStep === 0) ticks.push(t)

  const point = (e: React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} className="block select-none" role="img" aria-label="Run timeline: one row per flow with past runs as bars, scheduled runs as ticks, and runs per 15-minute slot along the bottom.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={HEAD_H - 4} y2={lockY + 12 + barMax} className="stroke-border" />
            <text x={x(t)} y={13} textAnchor="middle" className="fill-muted-foreground font-mono text-[10.5px]">
              {clock(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={r.flowId}>
            {i % 2 === 1 && <rect x={0} y={HEAD_H + i * ROW_H} width={width} height={ROW_H} className="fill-muted/20" />}
            <text
              x={10}
              y={HEAD_H + i * ROW_H + 16}
              className={cn('text-[12px]', r.tone === 'code' ? 'fill-zinc-500' : 'fill-foreground', onOpenFlow && 'cursor-pointer hover:underline')}
              onClick={onOpenFlow ? () => onOpenFlow(r.flowId) : undefined}
            >
              {r.title.length > 22 ? `${r.title.slice(0, 21)}…` : r.title}
              <tspan className="fill-muted-foreground font-mono text-[10px]">{r.cadences.length ? `  ${r.cadences.join(', ')}` : '  events'}</tspan>
            </text>
          </g>
        ))}

        {marks.map((m) => {
          const i = rowIndex.get(m.flowId)
          if (i == null) return null
          const cy = HEAD_H + i * ROW_H + ROW_H / 2
          const tone = toneOf.get(m.flowId) ?? 'neutral'
          const x0 = Math.max(LABEL_W, x(m.t0))
          const x1 = Math.min(width - PAD_R, x(m.t1))
          const enter = (e: React.MouseEvent) => setHover({ kind: 'mark', mark: m, ...point(e) })
          const common = { onMouseEnter: enter, onMouseMove: enter, onClick: onOpenFlow ? () => onOpenFlow(m.flowId) : undefined, className: 'cursor-pointer' }
          if (m.kind === 'scheduled')
            return (
              <g key={m.id} {...common}>
                <rect x={x0 - 1.5} y={cy - 6} width={3} height={12} rx={1} className={cn('fill-transparent', TONE_STROKE[tone])} strokeWidth={1.2} strokeDasharray="2 1.5" />
                <rect x={x0 - 5} y={cy - 9} width={10} height={18} className="fill-transparent" />
              </g>
            )
          if (m.kind === 'queued')
            return (
              <g key={m.id} {...common}>
                <path d={`M${x0} ${cy - 6} L${x0 + 6} ${cy} L${x0} ${cy + 6} L${x0 - 6} ${cy} z`} className="fill-amber-300" />
              </g>
            )
          const w = Math.max(3, x1 - x0)
          const failed = m.kind === 'run' && m.ok === false
          return (
            <g key={m.id} {...common}>
              <rect
                x={x0}
                y={cy - 7}
                width={w}
                height={14}
                rx={2}
                className={cn(
                  m.dryRun ? 'fill-transparent' : failed ? 'fill-red-400' : TONE_FILL[tone],
                  m.dryRun && (failed ? 'stroke-red-400' : TONE_STROKE[tone]),
                  m.kind === 'running' && 'animate-pulse',
                )}
                strokeWidth={m.dryRun ? 1.3 : 0}
              />
              <rect x={x0 - 3} y={cy - 9} width={w + 6} height={18} className="fill-transparent" />
            </g>
          )
        })}

        {/* The run lock: busy spans, then runs per 15-minute slot. */}
        <text x={10} y={lockY + 9} className="fill-foreground text-[12px]">
          Run lock
          <tspan className="fill-muted-foreground font-mono text-[10px]">  busy · runs per 15 m</tspan>
        </text>
        <rect x={LABEL_W} y={lockY} width={plotW} height={8} rx={2} className="fill-muted/40" />
        {busy.map(([a, b]) => {
          const bx = Math.max(LABEL_W, x(a))
          const bw = Math.max(2, Math.min(width - PAD_R, x(b)) - bx)
          return (
            <rect
              key={a}
              x={bx}
              y={lockY}
              width={bw}
              height={8}
              rx={1}
              className="fill-violet-400/80"
              onMouseEnter={(e) => setHover({ kind: 'busy', t0: a, t1: b, ...point(e) })}
              onMouseMove={(e) => setHover({ kind: 'busy', t0: a, t1: b, ...point(e) })}
            />
          )
        })}
        {slots.map((s) => {
          if (s.t0 + SLOT_MS < from) return null
          const sx = Math.max(LABEL_W, x(s.t0))
          const sw = Math.max(0, Math.min(width - PAD_R, x(s.t0 + SLOT_MS)) - sx - 2)
          const h = (s.count / maxCount) * barMax
          const by = lockY + 12 + barMax - h
          const enter = (e: React.MouseEvent) => setHover({ kind: 'slot', t0: s.t0, count: s.count, future: s.future, ...point(e) })
          return (
            <g key={s.t0} onMouseEnter={enter} onMouseMove={enter}>
              <rect x={sx} y={lockY + 12} width={sw} height={barMax} className="fill-transparent" />
              {s.count > 0 && (
                <rect
                  x={sx}
                  y={by}
                  width={sw}
                  height={h}
                  rx={1}
                  className={cn(s.future ? 'fill-transparent stroke-zinc-500' : s.count >= 4 ? 'fill-orange-400/80' : 'fill-zinc-500/70')}
                  strokeDasharray={s.future ? '2 2' : undefined}
                />
              )}
            </g>
          )
        })}

        <line x1={x(now)} x2={x(now)} y1={HEAD_H - 6} y2={lockY + 12 + barMax} className="stroke-violet-300" strokeWidth={1.5} />
        <text x={x(now)} y={height - 8} textAnchor="middle" className="fill-violet-300 font-mono text-[10.5px]">
          now
        </text>
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-72 rounded-md border bg-popover p-2.5 text-xs shadow-lg"
          style={{
            left: Math.min(hover.x + 14, width - 300),
            top: hover.y + 14,
          }}
        >
          {hover.kind === 'mark' ? (
            <MarkDetail m={hover.mark} title={titleOf.get(hover.mark.flowId) ?? `flow #${hover.mark.flowId}`} />
          ) : hover.kind === 'slot' ? (
            <>
              <div className="font-semibold text-foreground">
                {clock(hover.t0)}–{clock(hover.t0 + SLOT_MS)}
              </div>
              <div className="text-muted-foreground">
                {hover.count} run{hover.count === 1 ? '' : 's'} {hover.future ? 'scheduled' : 'started'} · one at a time, the rest wait in the queue
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold text-foreground">Lock held</div>
              <div className="font-mono text-muted-foreground">
                {clock(hover.t0)}–{clock(hover.t1)} · {duration(hover.t1 - hover.t0)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
