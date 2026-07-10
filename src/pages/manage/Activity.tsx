import { useEffect, useState } from 'react'
import {
  Activity as ActivityIcon,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FlaskConical,
  FolderInput,
  Loader2,
  Network,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getQueueStats, streamActivity,
  type ActivityStreamEvent, type FlowRun, type QueueStat, type RequestLogEntry,
  type RunActivity, type SyncSummary,
} from '@/lib/flows'

// A run being watched live: lifecycle events accumulate here until it resolves
// into a completed FlowRun (or is aborted).
interface InProgress {
  runToken: string
  flowName: string
  dryRun: boolean
  startedAt: string
  nodes: RunActivity[]
}

// Relative timestamp like "3m ago" from an ISO string.
function relTime(iso: string): string {
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

// A node-type-appropriate icon for the activity line (the events the log is for:
// downloads, imports, metadata writes, cleanup).
function activityIcon(type: string) {
  if (type === 'sink.qbittorrent') return Download
  if (type === 'sink.library-import') return FolderInput
  if (type === 'sink.qbittorrent-delete') return Trash2
  if (type === 'enrich.metadata' || type === 'sink.portal-upsert') return Database
  if (type.startsWith('sink.jellyfin')) return RefreshCw
  return ActivityIcon
}

function DryLiveBadge({ dryRun }: { dryRun: boolean }) {
  return dryRun ? (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <FlaskConical className="size-3" />
      dry run
    </span>
  ) : (
    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
      live
    </span>
  )
}

function ActivityLine({ item }: { item: RunActivity }) {
  const Icon = activityIcon(item.type)
  const failed = item.status === 'error'
  return (
    <li className="flex gap-2.5">
      <Icon
        className={cn('mt-0.5 size-3.5 shrink-0', failed ? 'text-red-400' : 'text-muted-foreground')}
      />
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{item.node}</span>
        {item.error ? <p className="text-xs text-red-400">{item.error}</p> : null}
        {item.notes.map((note, i) => (
          <p key={i} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
    </li>
  )
}

// The card for a run that's currently executing — fills in node-by-node.
function InProgressCard({ ip }: { ip: InProgress }) {
  return (
    <li className="rounded-lg border border-violet-500/40 bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Loader2 className="size-4 shrink-0 animate-spin text-violet-400" />
        <span className="font-medium">{ip.flowName}</span>
        <DryLiveBadge dryRun={ip.dryRun} />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          running · {ip.nodes.length} {ip.nodes.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
      {ip.nodes.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 border-t pt-3">
          {ip.nodes.map((item, i) => (
            <ActivityLine key={i} item={item} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">Starting…</p>
      )}
    </li>
  )
}

function RunCard({ run }: { run: FlowRun }) {
  const StatusIcon = run.ok ? CheckCircle2 : AlertTriangle
  return (
    <li
      className={cn(
        'rounded-lg border bg-card p-4 shadow-sm',
        run.ok ? 'border-border' : 'border-red-500/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusIcon
          className={cn('size-4 shrink-0', run.ok ? 'text-emerald-400' : 'text-red-400')}
        />
        <span className="font-medium">{run.flow_name}</span>
        <DryLiveBadge dryRun={run.dry_run} />
        <span
          className="ml-auto shrink-0 text-xs text-muted-foreground"
          title={new Date(run.started_at).toLocaleString()}
        >
          {relTime(run.started_at)} · {(run.duration_ms / 1000).toFixed(1)}s
        </span>
      </div>
      {run.error ? <p className="mt-2 text-xs text-red-400">{run.error}</p> : null}
      {run.activity.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 border-t pt-3">
          {run.activity.map((item, i) => (
            <ActivityLine key={i} item={item} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No activity reported.</p>
      )}
    </li>
  )
}

// Live snapshot of the outbound-request limiter (server/httpQueue.ts): one chip
// per service that's been used, showing in-flight/queued and lifetime totals so
// the admin can see rate-limited traffic (Jikan, TsukiHime, AniList, …) as it
// flows. Hidden entirely until at least one request has gone out.
const QUEUE_LABELS: Record<string, string> = {
  jikan: 'Jikan', tsukihime: 'TsukiHime', tosho: 'AnimeTosho', anilist: 'AniList',
  kitsu: 'Kitsu', fanart: 'fanart.tv', jimaku: 'Jimaku', aniskip: 'AniSkip', other: 'Other',
}

// Status color for a logged outbound request: ok / client error / server error
// or transport failure.
function statusClass(e: RequestLogEntry): string {
  if (e.error || e.status == null || e.status >= 500) return 'text-red-400'
  if (e.status >= 400) return 'text-amber-400'
  return 'text-emerald-400'
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

// The last outbound requests, newest first — the "what exactly did we call"
// view the per-service counters can't answer.
function RequestLog({ requests }: { requests: RequestLogEntry[] }) {
  return (
    <ul className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto border-t pt-3">
      {requests.length === 0 ? (
        <li className="text-xs text-muted-foreground">No outbound requests since the server started.</li>
      ) : (
        requests.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex items-baseline gap-2 font-mono text-[11px]">
            <span className="w-14 shrink-0 text-muted-foreground" title={new Date(e.at).toLocaleString()}>
              {relTime(new Date(e.at).toISOString())}
            </span>
            <span className="w-20 shrink-0 truncate text-muted-foreground">{QUEUE_LABELS[e.key] ?? e.key}</span>
            <span className={cn('w-10 shrink-0 tabular-nums', statusClass(e))} title={e.error ?? undefined}>
              {e.status ?? 'ERR'}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground" title={`${e.method} ${e.url}`}>
              {e.method !== 'GET' ? `${e.method} ` : ''}
              {shortUrl(e.url)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{e.ms}ms</span>
          </li>
        ))
      )}
    </ul>
  )
}

// Recent portal-sync passes: the 5-minute Jellyfin → portal cache refresh is
// the main background job that isn't a flow run, and it's what drives most of
// the outbound traffic above (banner gathers, poster searches).
function SyncPanel({ syncs }: { syncs: SyncSummary[] }) {
  const [open, setOpen] = useState(false)
  if (syncs.length === 0) return null
  const latest = syncs[0]
  const Chevron = open ? ChevronDown : ChevronRight
  const line = (s: SyncSummary): string => {
    const parts = [`${s.items} items`, `${s.episodes} episodes`]
    if (s.pruned > 0) parts.push(`${s.pruned} pruned`)
    if (s.posterSearches > 0) parts.push(`${s.posterSearches} poster search${s.posterSearches === 1 ? '' : 'es'}`)
    return parts.join(' · ')
  }
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        onClick={() => setOpen((o) => !o)}
      >
        <RefreshCw className={cn('size-3.5 shrink-0', latest.error ? 'text-red-400' : 'text-muted-foreground')} />
        <span className="font-medium text-muted-foreground">Portal sync</span>
        {latest.error ? (
          <span className="min-w-0 truncate text-red-400">{latest.error}</span>
        ) : (
          <span className="min-w-0 truncate text-foreground">{line(latest)}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {relTime(new Date(latest.at).toISOString())} · {(latest.ms / 1000).toFixed(1)}s
        </span>
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <ul className="mt-3 flex flex-col gap-1 border-t pt-3">
          {syncs.map((s, i) => (
            <li key={`${s.at}-${i}`} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-14 shrink-0 text-muted-foreground" title={new Date(s.at).toLocaleString()}>
                {relTime(new Date(s.at).toISOString())}
              </span>
              {s.error ? (
                <span className="min-w-0 flex-1 truncate text-red-400" title={s.error}>{s.error}</span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{line(s)}</span>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground">{(s.ms / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function QueueStrip({
  queues,
  requests,
}: {
  queues: Record<string, QueueStat>
  requests: RequestLogEntry[]
}) {
  const [open, setOpen] = useState(false)
  const entries = Object.entries(queues)
    .filter(([, q]) => q.total > 0 || q.inFlight > 0 || q.queued > 0)
    .sort((a, b) => b[1].recent - a[1].recent || b[1].total - a[1].total)
  if (entries.length === 0 && requests.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        className="mb-2 flex w-full items-center gap-2 text-left text-xs font-medium text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <Network className="size-3.5" />
        Outbound requests
        <span className="ml-auto font-normal">{open ? 'hide' : 'show'} log</span>
        <Chevron className="size-3.5" />
      </button>
      <div className="flex flex-wrap gap-2">
        {entries.map(([key, q]) => {
          const busy = q.inFlight > 0 || q.queued > 0
          return (
            <div
              key={key}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
                busy ? 'border-violet-500/50 bg-violet-500/10' : 'border-border',
              )}
              title={
                q.lastError
                  ? `last error ${relTime(new Date(q.lastError.at).toISOString())}: ${q.lastError.message}`
                  : `${q.concurrency}× concurrent, ${q.minGapMs}ms gap`
              }
            >
              {busy ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-400" />
              ) : q.lastError ? (
                <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
              ) : (
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
              )}
              <span className="font-medium text-foreground">{QUEUE_LABELS[key] ?? key}</span>
              {busy ? (
                <span className="tabular-nums text-violet-300">
                  {q.inFlight}▶ {q.queued > 0 ? `${q.queued}⏳` : ''}
                </span>
              ) : null}
              <span className="tabular-nums text-muted-foreground">
                {q.recent > 0 ? `${q.recent} in 10m · ` : ''}
                {q.total} total
                {q.retried > 0 ? ` · ${q.retried} retried` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {open ? <RequestLog requests={requests} /> : null}
    </div>
  )
}

// Consecutive runs of the same flow collapse behind the newest one — an
// event-triggered import can fire dozens of times in an hour, and a wall of
// identical cards buries everything else.
interface RunGroup {
  key: string
  runs: FlowRun[]
}

function groupRuns(runs: FlowRun[]): RunGroup[] {
  const groups: RunGroup[] = []
  for (const run of runs) {
    const last = groups[groups.length - 1]
    if (last && last.runs[0].flow_name === run.flow_name && last.runs[0].dry_run === run.dry_run) {
      last.runs.push(run)
    } else {
      groups.push({ key: String(run.id), runs: [run] })
    }
  }
  return groups
}

function RunGroupCards({ group }: { group: RunGroup }) {
  const [expanded, setExpanded] = useState(false)
  const [latest, ...earlier] = group.runs
  const failed = earlier.filter((r) => !r.ok).length
  return (
    <>
      <RunCard run={latest} />
      {earlier.length > 0 ? (
        expanded ? (
          earlier.map((run) => <RunCard key={run.id} run={run} />)
        ) : (
          <li>
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-4 py-2 text-xs',
                failed > 0 ? 'text-red-400' : 'text-muted-foreground',
              )}
              onClick={() => setExpanded(true)}
            >
              <ChevronRight className="size-3.5" />
              {earlier.length} earlier {latest.flow_name} run{earlier.length === 1 ? '' : 's'}
              {failed > 0 ? ` · ${failed} failed` : ''}
              <span className="ml-auto">{relTime(earlier[earlier.length - 1].started_at)} – {relTime(earlier[0].started_at)}</span>
            </button>
          </li>
        )
      ) : null}
    </>
  )
}

export default function Activity() {
  const [runs, setRuns] = useState<FlowRun[]>([])
  const [inProgress, setInProgress] = useState<InProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [queues, setQueues] = useState<Record<string, QueueStat>>({})
  const [requests, setRequests] = useState<RequestLogEntry[]>([])
  const [syncs, setSyncs] = useState<SyncSummary[]>([])
  // Bump to force a reconnect (drops the current stream and refetches snapshot).
  const [gen, setGen] = useState(0)

  // Poll the background-work snapshot (queues + request log + sync passes —
  // not part of the activity stream).
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const { queues, requests, syncs } = await getQueueStats()
        if (!cancelled) {
          setQueues(queues)
          setRequests(requests ?? [])
          setSyncs(syncs ?? [])
        }
      } catch {
        /* transient — keep the last snapshot */
      }
    }
    void tick()
    const iv = setInterval(() => {
      if (!document.hidden) void tick()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [gen])

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()

    const handle = (ev: ActivityStreamEvent) => {
      setConnected(true)
      switch (ev.type) {
        case 'snapshot':
          setRuns(ev.runs)
          setLoading(false)
          break
        case 'start':
          setInProgress({
            runToken: ev.runToken,
            flowName: ev.flowName,
            dryRun: ev.dryRun,
            startedAt: ev.startedAt,
            nodes: [],
          })
          break
        case 'node':
          setInProgress((p) =>
            p && p.runToken === ev.runToken
              ? {
                  ...p,
                  nodes: [
                    ...p.nodes,
                    { node: ev.node, type: ev.nodeType, status: ev.status, notes: ev.notes, error: ev.error },
                  ],
                }
              : p,
          )
          break
        case 'done':
          setInProgress((p) => (p && p.runToken !== ev.runToken ? p : null))
          setRuns((prev) => [ev.run, ...prev.filter((r) => r.id !== ev.run.id)].slice(0, 100))
          break
        case 'aborted':
          setInProgress((p) => (p && p.runToken === ev.runToken ? null : p))
          break
        default:
          break // node-start, ping
      }
    }

    // Reconnect loop: the stream is long-lived, but survive drops (proxy idle,
    // pod roll) by reconnecting with a short backoff.
    const loop = async () => {
      while (!cancelled) {
        try {
          await streamActivity((ev) => {
            if (!cancelled) handle(ev)
          }, ac.signal)
        } catch {
          if (cancelled) return
          setConnected(false)
        }
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

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Activity</h1>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <span
            className={cn(
              'size-1.5 rounded-full',
              connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400',
            )}
          />
          {connected ? 'live' : 'reconnecting…'}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => setGen((g) => g + 1)}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </header>
      <main className="p-4 md:p-6">
        <div className="mx-auto max-w-2xl">
          <QueueStrip queues={queues} requests={requests} />
          <SyncPanel syncs={syncs} />
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : runs.length === 0 && !inProgress ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <ActivityIcon className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No flow runs yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Runs from the flow editor and scheduled flows show up here —
                metadata updates, new downloads, imports, and cleanup. Background
                work (portal sync, outbound API requests) appears above.
              </p>
            </div>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-3">
            {inProgress ? <InProgressCard ip={inProgress} /> : null}
            {groupRuns(runs).map((group) => (
              <RunGroupCards key={group.key} group={group} />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
