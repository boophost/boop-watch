import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  FlaskConical,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runScheduleNow,
  listFlows,
  getTriggers,
  type FlowSchedule,
  type FlowSummary,
  type ScheduleKind,
  type ScheduleSpec,
  type WeekDay,
} from '@/lib/flows'

const WEEK_DAYS: { value: WeekDay; label: string }[] = [
  { value: 'sun', label: 'Sun' },
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
]
const DAY_LABEL = Object.fromEntries(WEEK_DAYS.map((d) => [d.value, d.label]))

// Relative time that reads for both future ("in 5m") and past ("5m ago").
function relTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diff = t - Date.now()
  const mins = Math.round(Math.abs(diff) / 60000)
  if (mins < 1) return 'now'
  const s =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
  return diff >= 0 ? `in ${s}` : `${s} ago`
}

function absTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// One-line human summary of a schedule's cadence.
function cadenceText(s: FlowSchedule): string {
  const spec = s.spec as Record<string, unknown>
  if (s.kind === 'interval') {
    const unit = spec.unit === 'hours' ? 'h' : 'm'
    return `every ${spec.every}${unit}`
  }
  if (s.kind === 'daily') return `daily ${spec.at}`
  if (s.kind === 'weekly') return `weekly ${DAY_LABEL[spec.day as WeekDay]} ${spec.at}`
  return `once ${absTime(spec.runAt as string)}`
}

// --- Form ---------------------------------------------------------------

interface FormState {
  id: number | null // null = create
  triggerName: string // the trigger.start name this schedule fires
  name: string
  kind: ScheduleKind
  every: number
  unit: 'minutes' | 'hours'
  at: string // 'HH:MM'
  day: WeekDay
  runAt: string // datetime-local value
  dryRun: boolean
  enabled: boolean
}

function blankForm(triggerName: string): FormState {
  return {
    id: null,
    triggerName,
    name: '',
    kind: 'interval',
    every: 30,
    unit: 'minutes',
    at: '03:00',
    day: 'sun',
    runAt: '',
    dryRun: true,
    enabled: true,
  }
}

// ISO instant -> value for <input type="datetime-local"> (local wall clock).
function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formFromSchedule(s: FlowSchedule): FormState {
  const base = blankForm(s.trigger_name ?? '')
  const spec = s.spec as Record<string, unknown>
  return {
    ...base,
    id: s.id,
    triggerName: s.trigger_name ?? '',
    name: s.name ?? '',
    kind: s.kind,
    every: s.kind === 'interval' ? (spec.every as number) : base.every,
    unit: s.kind === 'interval' ? (spec.unit as 'minutes' | 'hours') : base.unit,
    at: s.kind === 'daily' || s.kind === 'weekly' ? (spec.at as string) : base.at,
    day: s.kind === 'weekly' ? (spec.day as WeekDay) : base.day,
    runAt: s.kind === 'once' ? isoToLocalInput(spec.runAt as string) : base.runAt,
    dryRun: s.dry_run,
    enabled: s.enabled,
  }
}

function specFromForm(f: FormState): ScheduleSpec {
  if (f.kind === 'interval') return { every: f.every, unit: f.unit }
  if (f.kind === 'daily') return { at: f.at }
  if (f.kind === 'weekly') return { day: f.day, at: f.at }
  return { runAt: new Date(f.runAt).toISOString() }
}

const selectClass =
  'h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'

function ScheduleForm({
  form,
  triggers,
  onChange,
  onSubmit,
  onCancel,
  saving,
}: {
  form: FormState
  triggers: string[]
  onChange: (f: FormState) => void
  onSubmit: () => void
  onCancel: () => void
  saving: boolean
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => onChange({ ...form, [k]: v })
  const validRunAt = form.kind !== 'once' || form.runAt !== ''
  const canSave = form.triggerName !== '' && validRunAt && !saving
  // A schedule editing a legacy/removed trigger still needs it in the list.
  const triggerOptions = form.triggerName && !triggers.includes(form.triggerName)
    ? [form.triggerName, ...triggers]
    : triggers

  return (
    <form
      className="mb-6 grid gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) onSubmit()
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Trigger</span>
          <select
            className={cn(selectClass, 'min-w-44')}
            value={form.triggerName}
            onChange={(e) => set('triggerName', e.target.value)}
          >
            <option value="">Select a trigger…</option>
            {triggerOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">When</span>
          <select
            className={selectClass}
            value={form.kind}
            onChange={(e) => set('kind', e.target.value as ScheduleKind)}
          >
            <option value="interval">Every…</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="once">Once</option>
          </select>
        </label>

        {form.kind === 'interval' && (
          <div className="flex items-center gap-2 text-sm">
            <Input
              type="number"
              min={1}
              value={form.every}
              onChange={(e) => set('every', Math.max(1, Number(e.target.value)))}
              className="h-8 w-20"
            />
            <select
              className={selectClass}
              value={form.unit}
              onChange={(e) => set('unit', e.target.value as 'minutes' | 'hours')}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </div>
        )}

        {form.kind === 'weekly' && (
          <select
            className={selectClass}
            value={form.day}
            onChange={(e) => set('day', e.target.value as WeekDay)}
          >
            {WEEK_DAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        )}

        {(form.kind === 'daily' || form.kind === 'weekly') && (
          <Input
            type="time"
            value={form.at}
            onChange={(e) => set('at', e.target.value)}
            className="h-8 w-28"
          />
        )}

        {form.kind === 'once' && (
          <Input
            type="datetime-local"
            value={form.runAt}
            onChange={(e) => set('runAt', e.target.value)}
            className="h-8 w-52"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Label (optional)"
          className="h-8 w-52"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.dryRun}
            onChange={(e) => set('dryRun', e.target.checked)}
          />
          <span className="text-muted-foreground">Dry run (no side effects)</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span className="text-muted-foreground">Enabled</span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            {form.id === null ? 'Create' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  )
}

// --- Page ---------------------------------------------------------------

export default function Schedules() {
  const [schedules, setSchedules] = useState<FlowSchedule[]>([])
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [triggers, setTriggers] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = async () => {
    setError('')
    try {
      const [s, f, t] = await Promise.all([listSchedules(), listFlows(), getTriggers()])
      setSchedules(s.schedules)
      setFlows(f.flows)
      setTriggers(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const flowName = useMemo(() => new Map(flows.map((f) => [f.id, f.name])), [flows])

  const submitForm = async () => {
    if (!form || form.triggerName === '') return
    setSaving(true)
    setError('')
    try {
      const spec = specFromForm(form)
      const payload = {
        triggerName: form.triggerName,
        name: form.name.trim() || null,
        kind: form.kind,
        spec,
        dryRun: form.dryRun,
        enabled: form.enabled,
      }
      if (form.id === null) await createSchedule(payload)
      else await updateSchedule(form.id, payload)
      setForm(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (s: FlowSchedule) => {
    setBusyId(s.id)
    try {
      await updateSchedule(s.id, { enabled: !s.enabled })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update schedule')
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (s: FlowSchedule) => {
    setBusyId(s.id)
    setError('')
    try {
      await runScheduleNow(s.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: number) => {
    setBusyId(id)
    try {
      await deleteSchedule(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete schedule')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Schedules</h1>
        {form === null && (
          <Button
            size="sm"
            className="gap-1"
            disabled={triggers.length === 0}
            onClick={() => setForm(blankForm(triggers[0] ?? ''))}
          >
            <Plus className="size-4" />
            New schedule
          </Button>
        )}
      </header>

      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {form && (
          <ScheduleForm
            form={form}
            triggers={triggers}
            onChange={setForm}
            onSubmit={submitForm}
            onCancel={() => setForm(null)}
            saving={saving}
          />
        )}

        {loading && schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading schedules…</p>
        ) : schedules.length === 0 && !form ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <CalendarClock className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No schedules yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                A schedule fires a <span className="font-medium">Trigger</span> name on a repeat
                (interval / daily / weekly) or once at a set time — every flow with that trigger
                runs. Add a Trigger node to a flow first. Runs land in the Activity feed.
              </p>
            </div>
          </div>
        ) : (
          <ul className="grid gap-3">
            {schedules.map((s) => {
              const busy = busyId === s.id
              const target = s.trigger_name ?? flowName.get(s.flow_id) ?? s.flow_name ?? `Flow #${s.flow_id}`
              const name = s.name || target
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3 pl-4 shadow-sm',
                    !s.enabled && 'opacity-60',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{name}</span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                          s.dry_run
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-amber-500/15 text-amber-500',
                        )}
                      >
                        {s.dry_run ? (
                          <>
                            <FlaskConical className="size-3" /> dry
                          </>
                        ) : (
                          <>
                            <Zap className="size-3" /> live
                          </>
                        )}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {cadenceText(s)}
                      {' · '}
                      {s.enabled ? (
                        <span title={absTime(s.next_run)}>next {relTime(s.next_run)}</span>
                      ) : (
                        'paused'
                      )}
                      {s.last_run ? (
                        <span title={absTime(s.last_run)}>
                          {' · '}last {relTime(s.last_run)}
                          {s.last_run_ok === false ? ' (failed)' : ''}
                        </span>
                      ) : null}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2"
                      disabled={busy}
                      title="Run now"
                      onClick={() => void runNow(s)}
                    >
                      <Play className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn('h-7 gap-1 px-2', s.enabled && 'text-emerald-500')}
                      disabled={busy}
                      title={s.enabled ? 'Disable' : 'Enable'}
                      onClick={() => void toggleEnabled(s)}
                    >
                      <Power className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      title="Edit"
                      onClick={() => setForm(formFromSchedule(s))}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      disabled={busy}
                      title="Delete"
                      onClick={() => void remove(s.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
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
