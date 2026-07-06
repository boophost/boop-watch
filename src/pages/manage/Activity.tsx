import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity as ActivityIcon,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FlaskConical,
  FolderInput,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { listRuns, type FlowRun, type RunActivity } from '@/lib/flows'

// How often the feed refetches while the tab is open.
const POLL_MS = 5000

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
        {item.error ? (
          <p className="text-xs text-red-400">{item.error}</p>
        ) : null}
        {item.notes.map((note, i) => (
          <p key={i} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
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
        {run.dry_run ? (
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            <FlaskConical className="size-3" />
            dry run
          </span>
        ) : (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
            live
          </span>
        )}
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

export default function Activity() {
  const [runs, setRuns] = useState<FlowRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Keep the ref so the poll can refetch without re-subscribing.
  const load = useCallback(async () => {
    try {
      const d = await listRuns(100)
      setRuns(d.runs)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    void loadRef.current()
    // Pause polling while the tab is hidden; resume (and refetch) on focus.
    const tick = () => {
      if (!document.hidden) void loadRef.current()
    }
    const timer = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Activity</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          auto-refreshing · last {runs.length}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </header>
      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {loading && runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <ActivityIcon className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No activity yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Runs from the flow editor and scheduled flows show up here —
                metadata updates, new downloads, imports, and cleanup.
              </p>
            </div>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-3">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
