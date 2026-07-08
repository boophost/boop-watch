import { useCallback, useEffect, useState } from 'react'
import { Check, Lightbulb, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  deleteSuggestion,
  listSuggestions,
  setSuggestionResolved,
  type SuggestionRow,
} from '@/lib/suggestions'

function formatWhen(iso: string): string {
  // SQLite datetime('now') stores UTC without a zone marker; tag it so the
  // browser renders it in local time rather than treating it as local already.
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function Suggestions() {
  const [rows, setRows] = useState<SuggestionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setRows(await listSuggestions())
    } catch (e) {
      setRows([])
      setError(e instanceof Error ? e.message : 'Failed to load suggestions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleResolved = async (row: SuggestionRow) => {
    setBusyId(row.id)
    setError('')
    try {
      const updated = await setSuggestionResolved(row.id, !row.resolved)
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update suggestion')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (row: SuggestionRow) => {
    if (!window.confirm('Delete this suggestion? This cannot be undone.')) return
    setBusyId(row.id)
    setError('')
    try {
      await deleteSuggestion(row.id)
      setRows((prev) => prev.filter((r) => r.id !== row.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete suggestion')
    } finally {
      setBusyId(null)
    }
  }

  const openCount = rows.filter((r) => !r.resolved).length

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Suggestions</h1>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {rows.length > 0 ? `${openCount} open · ${rows.length} total` : null}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading suggestions…</p>
        ) : rows.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <Lightbulb className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No suggestions yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Suggestions submitted by logged-in users from the portal will appear here.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const busy = busyId === row.id
              return (
                <li
                  key={row.id}
                  className={cn(
                    'rounded-lg border border-border bg-card p-4 shadow-sm',
                    row.resolved && 'opacity-60',
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words text-sm">{row.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="truncate">{row.email ?? row.user_id}</span>
                        <span>·</span>
                        <span className="whitespace-nowrap">{formatWhen(row.created_at)}</span>
                        {row.resolved ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">
                            resolved
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        disabled={busy}
                        title={row.resolved ? 'Reopen' : 'Mark resolved'}
                        aria-label={row.resolved ? 'Reopen suggestion' : 'Mark suggestion resolved'}
                        onClick={() => void toggleResolved(row)}
                      >
                        {row.resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-destructive hover:text-destructive"
                        disabled={busy}
                        title="Delete suggestion"
                        aria-label="Delete suggestion"
                        onClick={() => void remove(row)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
