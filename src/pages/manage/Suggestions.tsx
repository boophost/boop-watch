import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronRight, Copy, Layers, Lightbulb, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  createSuggestionGroup,
  deleteSuggestion,
  deleteSuggestionGroup,
  listSuggestions,
  setSuggestionStatus,
  updateSuggestion,
  updateSuggestionGroup,
  type SuggestionGroup,
  type SuggestionPatch,
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

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function Card({
  row,
  group,
  busy,
  onEdit,
  onDelete,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  row: SuggestionRow
  group: SuggestionGroup | undefined
  busy: boolean
  onEdit: () => void
  onDelete: () => void
  onContextMenu: (e: ReactMouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      className={cn(
        'group relative cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm active:cursor-grabbing',
        busy && 'pointer-events-none opacity-50',
        row.duplicate_of != null && 'opacity-70',
      )}
    >
      {/* Absolute so they never sit on top of the wrapped meta text below. */}
      <div className="absolute right-1.5 top-1.5 flex gap-0.5">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          title="Edit suggestion"
          aria-label="Edit suggestion"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          title="Delete suggestion"
          aria-label="Delete suggestion"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {(row.duplicate_of != null || group) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1 pr-12">
          {row.duplicate_of != null && (
            <span
              className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-500"
              title={`Duplicate of suggestion #${row.duplicate_of}`}
            >
              <Copy className="size-3" />dup of #{row.duplicate_of}
            </span>
          )}
          {group && (
            <span
              className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-400"
              title={group.description ?? group.title}
            >
              <Layers className="size-3" />
              {group.title}
            </span>
          )}
        </div>
      )}

      {row.title && <p className="pr-12 text-sm font-semibold">{row.title}</p>}
      <p className={cn('whitespace-pre-wrap break-words text-sm', !row.title && 'pr-12')}>{row.body}</p>

      {row.notes && (
        <p className="mt-2 whitespace-pre-wrap break-words rounded border-l-2 border-violet-500/50 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          {row.notes}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span className="truncate">
          #{row.id} · {row.email ?? row.user_id}
        </span>
        <span>{formatWhen(row.created_at)}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="my-8 w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">{children}</div>
    </div>
  )
}

function EditDialog({
  row,
  groups,
  suggestions,
  onClose,
  onSaved,
}: {
  row: SuggestionRow
  groups: SuggestionGroup[]
  suggestions: SuggestionRow[]
  onClose: () => void
  onSaved: (updated: SuggestionRow) => void
}) {
  const [title, setTitle] = useState(row.title ?? '')
  const [notes, setNotes] = useState(row.notes ?? '')
  const [status, setStatus] = useState<SuggestionStatus>(row.status)
  const [groupId, setGroupId] = useState<string>(row.group_id != null ? String(row.group_id) : '')
  const [dup, setDup] = useState<string>(row.duplicate_of != null ? String(row.duplicate_of) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const updated = await updateSuggestion(row.id, {
        title: title.trim() || null,
        notes: notes.trim() || null,
        status,
        group_id: groupId ? Number(groupId) : null,
        duplicate_of: dup.trim() ? Number(dup.trim()) : null,
      })
      onSaved(updated)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Edit suggestion #{row.id}</h2>
        <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* The user's words are read-only context for triage. */}
        <div>
          <Label className="text-xs text-muted-foreground">Submitted by {row.email ?? row.user_id}</Label>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-sm">
            {row.body}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sg-title">Title</Label>
          <Input
            id="sg-title"
            value={title}
            maxLength={200}
            placeholder="Short admin title (optional)"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sg-notes">Notes</Label>
          <textarea
            id="sg-notes"
            value={notes}
            maxLength={5000}
            placeholder="Triage / resolution notes (optional)"
            onChange={(e) => setNotes(e.target.value)}
            className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sg-status">Status</Label>
            <select
              id="sg-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as SuggestionStatus)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sg-group">Epic</Label>
            <select
              id="sg-group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— none —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sg-dup">Duplicate of (suggestion #)</Label>
          <Input
            id="sg-dup"
            value={dup}
            inputMode="numeric"
            placeholder="e.g. 12 — leave blank if not a duplicate"
            onChange={(e) => setDup(e.target.value.replace(/[^0-9]/g, ''))}
          />
          {dup.trim() && !suggestions.some((s) => s.id === Number(dup.trim())) && (
            <p className="text-xs text-amber-500">No suggestion #{dup.trim()} exists.</p>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
// Epics panel
// ---------------------------------------------------------------------------

function EpicsPanel({
  groups,
  counts,
  onClose,
  onChanged,
}: {
  groups: SuggestionGroup[]
  counts: Map<number, number>
  onClose: () => void
  onChanged: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const create = () => {
    if (!title.trim()) return
    void run(async () => {
      await createSuggestionGroup(title.trim(), description.trim() || null)
      setTitle('')
      setDescription('')
    })
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Layers className="size-4" />
          Epics
        </h2>
        <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-3 p-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No epics yet. Group related suggestions under a themed epic with its own description.
          </p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => (
              <EpicRow key={g.id} group={g} count={counts.get(g.id) ?? 0} busy={busy} run={run} />
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
          <Label htmlFor="epic-title" className="text-xs text-muted-foreground">
            New epic
          </Label>
          <Input
            id="epic-title"
            value={title}
            maxLength={200}
            placeholder="Title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Input
            value={description}
            maxLength={5000}
            placeholder="Description (optional)"
            onChange={(e) => setDescription(e.target.value)}
          />
          <Button size="sm" className="gap-1" onClick={create} disabled={busy || !title.trim()}>
            <Plus className="size-4" />
            Create epic
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Overlay>
  )
}

function EpicRow({
  group,
  count,
  busy,
  run,
}: {
  group: SuggestionGroup
  count: number
  busy: boolean
  run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(group.title)
  const [description, setDescription] = useState(group.description ?? '')

  if (editing) {
    return (
      <li className="space-y-2 rounded-lg border border-border p-3">
        <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <Input
          value={description}
          maxLength={5000}
          placeholder="Description"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !title.trim()}
            onClick={() =>
              void run(async () => {
                await updateSuggestionGroup(group.id, {
                  title: title.trim(),
                  description: description.trim() || null,
                })
                setEditing(false)
              })
            }
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-start justify-between gap-2 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {group.title} <span className="text-xs font-normal text-muted-foreground">({count})</span>
        </p>
        {group.description && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{group.description}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-0.5">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Edit epic"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:text-destructive"
          title="Delete epic"
          onClick={() => {
            if (window.confirm(`Delete epic "${group.title}"? Its suggestions are kept but detached.`))
              void run(() => deleteSuggestionGroup(group.id))
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Right-click context menu
// ---------------------------------------------------------------------------

const MENU_W = 224 // w-56

function MenuItem({
  label,
  danger,
  active,
  hasSub,
  onClick,
  onMouseEnter,
}: {
  label: string
  danger?: boolean
  active?: boolean
  hasSub?: boolean
  onClick?: () => void
  onMouseEnter?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
        danger && 'text-destructive hover:bg-destructive/10',
      )}
    >
      <span className="truncate">{label}</span>
      {hasSub ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : active ? (
        <Check className="size-3.5 shrink-0 text-violet-400" />
      ) : null}
    </button>
  )
}

function Flyout({ openLeft, children }: { openLeft: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'absolute top-0 max-h-[70vh] w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl',
        openLeft ? 'right-full mr-1' : 'left-full ml-1',
      )}
    >
      {children}
    </div>
  )
}

function CardContextMenu({
  menu,
  rows,
  groups,
  onClose,
  onPatch,
  onEdit,
  onDelete,
}: {
  menu: { x: number; y: number; row: SuggestionRow }
  rows: SuggestionRow[]
  groups: SuggestionGroup[]
  onClose: () => void
  onPatch: (id: number, patch: SuggestionPatch) => void
  onEdit: (row: SuggestionRow) => void
  onDelete: (row: SuggestionRow) => void
}) {
  const { x, y, row } = menu
  const [sub, setSub] = useState<'status' | 'epic' | 'dup' | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Keep the menu on-screen; flip submenus to the left near the right edge.
  const left = Math.min(x, window.innerWidth - MENU_W - 8)
  const top = Math.min(y, window.innerHeight - 300)
  const openLeft = x > window.innerWidth - MENU_W - 240

  const act = (patch: SuggestionPatch) => {
    onPatch(row.id, patch)
    onClose()
  }
  const others = rows.filter((r) => r.id !== row.id)

  return (
    // Full-screen catcher: any click/right-click outside the menu dismisses it.
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="absolute w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        style={{ left, top }}
      >
        <div className="truncate px-2 py-1 text-xs text-muted-foreground">
          #{row.id} · {row.title ?? row.body}
        </div>
        <div className="my-1 h-px bg-border" />

        <div className="relative" onMouseEnter={() => setSub('status')}>
          <MenuItem label="Move to" hasSub />
          {sub === 'status' && (
            <Flyout openLeft={openLeft}>
              {COLUMNS.map((c) => (
                <MenuItem
                  key={c.status}
                  label={c.label}
                  active={row.status === c.status}
                  onClick={() => act({ status: c.status })}
                />
              ))}
            </Flyout>
          )}
        </div>

        <div className="relative" onMouseEnter={() => setSub('epic')}>
          <MenuItem label="Set epic" hasSub />
          {sub === 'epic' && (
            <Flyout openLeft={openLeft}>
              <MenuItem label="None" active={row.group_id == null} onClick={() => act({ group_id: null })} />
              {groups.length > 0 && <div className="my-1 h-px bg-border" />}
              {groups.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No epics yet</div>
              ) : (
                groups.map((g) => (
                  <MenuItem
                    key={g.id}
                    label={g.title}
                    active={row.group_id === g.id}
                    onClick={() => act({ group_id: g.id })}
                  />
                ))
              )}
            </Flyout>
          )}
        </div>

        <div className="relative" onMouseEnter={() => setSub('dup')}>
          <MenuItem label="Mark duplicate of" hasSub />
          {sub === 'dup' && (
            <Flyout openLeft={openLeft}>
              {row.duplicate_of != null && (
                <>
                  <MenuItem label="Clear duplicate" onClick={() => act({ duplicate_of: null })} />
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              {others.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No other suggestions</div>
              ) : (
                others.map((o) => (
                  <MenuItem
                    key={o.id}
                    label={`#${o.id} ${o.title ?? o.body}`}
                    active={row.duplicate_of === o.id}
                    onClick={() => act({ duplicate_of: o.id })}
                  />
                ))
              )}
            </Flyout>
          )}
        </div>

        <div className="my-1 h-px bg-border" onMouseEnter={() => setSub(null)} />
        <div onMouseEnter={() => setSub(null)}>
          <MenuItem
            label="Edit…"
            onClick={() => {
              onEdit(row)
              onClose()
            }}
          />
          <MenuItem
            label="Delete"
            danger
            onClick={() => {
              onClose()
              onDelete(row)
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Suggestions() {
  const [rows, setRows] = useState<SuggestionRow[]>([])
  const [groups, setGroups] = useState<SuggestionGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<SuggestionStatus | null>(null)
  const [editing, setEditing] = useState<SuggestionRow | null>(null)
  const [showEpics, setShowEpics] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; row: SuggestionRow } | null>(null)

  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const groupCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of rows) if (r.group_id != null) m.set(r.group_id, (m.get(r.group_id) ?? 0) + 1)
    return m
  }, [rows])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listSuggestions()
      setRows(data.suggestions)
      setGroups(data.groups)
    } catch (e) {
      setRows([])
      setGroups([])
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

  // General optimistic patch (context-menu actions: status / epic / duplicate).
  const patchRow = async (id: number, patch: SuggestionPatch) => {
    const prev = rows
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setBusyId(id)
    setError('')
    try {
      const updated = await updateSuggestion(id, patch)
      setRows((rs) => rs.map((r) => (r.id === updated.id ? updated : r)))
    } catch (e) {
      setRows(prev)
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
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => setShowEpics(true)}>
          <Layers className="size-4" />
          Epics
          {groups.length > 0 ? <span className="text-muted-foreground">({groups.length})</span> : null}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <main className="flex-1 p-4 md:p-6">
        {/* New suggestions open a GitHub issue (the portal's suggest button files
            one via the App bot). These rows pre-date that move — kept for history. */}
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="font-medium">Archive.</span>{' '}
          New suggestions now open a{' '}
          <a
            className="underline underline-offset-2"
            href="https://github.com/boophost/boop-watch/issues?q=is%3Aissue+label%3Asuggestion"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub issue
          </a>
          {' '}— tracked on the{' '}
          <a
            className="underline underline-offset-2"
            href="https://github.com/orgs/boophost/projects/1"
            target="_blank"
            rel="noreferrer noopener"
          >
            project board
          </a>
          . The items below were submitted before that change.
        </div>

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
                        group={row.group_id != null ? groupById.get(row.group_id) : undefined}
                        busy={busyId === row.id}
                        onEdit={() => setEditing(row)}
                        onDelete={() => void remove(row)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setMenu({ x: e.clientX, y: e.clientY, row })
                        }}
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

      {editing && (
        <EditDialog
          row={editing}
          groups={groups}
          suggestions={rows}
          onClose={() => setEditing(null)}
          onSaved={(updated) => setRows((rs) => rs.map((r) => (r.id === updated.id ? updated : r)))}
        />
      )}
      {showEpics && (
        <EpicsPanel
          groups={groups}
          counts={groupCounts}
          onClose={() => setShowEpics(false)}
          onChanged={() => void load()}
        />
      )}
      {menu && (
        <CardContextMenu
          menu={menu}
          rows={rows}
          groups={groups}
          onClose={() => setMenu(null)}
          onPatch={(id, patch) => void patchRow(id, patch)}
          onEdit={(row) => setEditing(row)}
          onDelete={(row) => void remove(row)}
        />
      )}
    </div>
  )
}
