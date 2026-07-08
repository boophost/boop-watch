import { useCallback, useEffect, useState } from 'react'
import { Lightbulb, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  deleteSuggestion,
  listSuggestions,
  setSuggestionStatus,
  type SuggestionRow,
  type SuggestionStatus,
} from '@/lib/suggestions'

const COLUMNS: { status: SuggestionStatus; label: string }[] = [
  { status: 'unread', label: 'Unread' },
  { status: 'todo', label: 'To-do' },
  { status: 'working', label: 'Working on' },
  { status: 'staged', label: 'Staged' },
  { status: 'done', label: 'Done' },
]

function formatWhen(iso: string): string {
  // SQLite datetime('now') stores UTC without a zone marker; tag it so the
  // browser renders it in local time rather than treating it as local already.
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function Card({
  row,
  busy,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  row: SuggestionRow
  busy: boolean
  onDelete: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm active:cursor-grabbing',
        busy && 'pointer-events-none opacity-50',
      )}
    >
      {/* Absolute so it never sits on top of the wrapped meta text below. */}
      <button
        type="button"
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        title="Delete suggestion"
        aria-label="Delete suggestion"
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
      </button>
      <p className="whitespace-pre-wrap break-words pr-6 text-sm">{row.body}</p>
      <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span className="truncate">{row.email ?? row.user_id}</span>
        <span>{formatWhen(row.created_at)}</span>
      </div>
    </div>
  )
}

export default function Suggestions() {
  const [rows, setRows] = useState<SuggestionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<SuggestionStatus | null>(null)

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

  const move = async (id: number, status: SuggestionStatus) => {
    const current = rows.find((r) => r.id === id)
    if (!current || current.status === status) return
    // Optimistic: move the card immediately, roll back if the server rejects.
    const prev = rows
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)))
    setBusyId(id)
    setError('')
    try {
      const updated = await setSuggestionStatus(id, status)
      setRows((rs) => rs.map((r) => (r.id === updated.id ? updated : r)))
    } catch (e) {
      setRows(prev)
      setError(e instanceof Error ? e.message : 'Failed to move suggestion')
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
      setRows((rs) => rs.filter((r) => r.id !== row.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete suggestion')
    } finally {
      setBusyId(null)
    }
  }

  const dropOnColumn = (status: SuggestionStatus) => {
    if (dragId != null) void move(dragId, status)
    setDragId(null)
    setDragOver(null)
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Suggestions</h1>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {rows.length > 0 ? `${rows.length} total` : null}
        </span>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <main className="flex-1 p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading suggestions…</p>
        ) : rows.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <Lightbulb className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No suggestions yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Suggestions submitted by logged-in users from the portal will appear here. Drag cards
                between columns to track their status.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {COLUMNS.map((col) => {
              const items = rows.filter((r) => r.status === col.status)
              return (
                <section
                  key={col.status}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragOver !== col.status) setDragOver(col.status)
                  }}
                  onDragLeave={(e) => {
                    // Only clear when leaving the column, not when crossing a child.
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
                  }}
                  onDrop={() => dropOnColumn(col.status)}
                  className={cn(
                    'flex flex-col rounded-xl border border-border bg-muted/20 transition-colors',
                    dragOver === col.status && 'border-violet-500/60 bg-violet-500/5',
                  )}
                >
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <span className="text-sm font-medium">{col.label}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {items.length}
                    </span>
                  </div>
                  <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
                    {items.map((row) => (
                      <Card
                        key={row.id}
                        row={row}
                        busy={busyId === row.id}
                        onDelete={() => void remove(row)}
                        onDragStart={() => setDragId(row.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setDragOver(null)
                        }}
                      />
                    ))}
                    {items.length === 0 ? (
                      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                        Drop here
                      </p>
                    ) : null}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
