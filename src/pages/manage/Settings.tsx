import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Eye, EyeOff, KeyRound, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { deleteConfig, getConfig, putConfig, type ConfigRow, type ConfigSource } from '@/lib/config'

/**
 * Where a value is coming from, as a badge.
 *
 * This is the load-bearing bit of the page. A present env var overrides the
 * database — including an empty one — so without saying so, editing a field
 * that an env var shadows would silently do nothing. The badge is how that
 * rule stays visible instead of surprising.
 */
const SOURCE_STYLE: Record<ConfigSource, { label: string; className: string; title: string }> = {
  env: {
    label: 'env',
    className: 'bg-amber-500/15 text-amber-300',
    title:
      'Set by an environment variable on the deployment, which overrides anything saved here — ' +
      'even when the variable is empty. Remove it from the deployment to manage the value on this page.',
  },
  database: {
    label: 'database',
    className: 'bg-violet-500/15 text-violet-300',
    title: 'Saved here, in the app’s own database.',
  },
  default: {
    label: 'default',
    className: 'bg-muted text-muted-foreground',
    title: 'Not set anywhere — the app’s built-in default applies.',
  },
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function SettingRow({
  row,
  onSaved,
  canWriteSecrets,
}: {
  row: ConfigRow
  onSaved: (next: ConfigRow) => void
  canWriteSecrets: boolean
}) {
  // A secret's value is never sent to us, so its input always starts empty and
  // a blank submit means "leave it alone" rather than "set it to empty".
  const [draft, setDraft] = useState(row.secret ? '' : (row.value ?? ''))
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    setDraft(row.secret ? '' : (row.value ?? ''))
  }, [row])

  const dirty = row.secret ? draft.length > 0 : draft !== (row.value ?? '')
  const blockedSecret = row.secret && !canWriteSecrets

  // The `env` badge already says a deployment variable is in charge, and the
  // header says it once for the page. Repeating a paragraph on all 20 shadowed
  // rows turns the normal pre-migration state into a wall of alarm, which
  // trains you to ignore exactly the two cases that *are* surprising:
  //   - a saved value is being silently overridden (a real conflict), or
  //   - the override is empty, so the row looks unset but is actively blanked
  //     (this is how previews disable the flow sink — worth spelling out).
  const shadowedConflict = row.source === 'env' && row.updatedAt != null
  const shadowedEmpty = row.source === 'env' && row.value === ''

  const run = async (fn: () => Promise<ConfigRow>) => {
    setBusy(true)
    setError('')
    try {
      onSaved(await fn())
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
      if (row.secret) setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
        <div className="min-w-0 md:w-72 md:shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.label}</span>
            <span
              className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', SOURCE_STYLE[row.source].className)}
              title={SOURCE_STYLE[row.source].title}
            >
              {SOURCE_STYLE[row.source].label}
            </span>
            {row.secret ? (
              <span
                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="Encrypted at rest. Its value is never sent to the browser."
              >
                <KeyRound className="size-3" />
                secret
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.key}</p>
          {row.help ? <p className="mt-1 text-xs text-muted-foreground">{row.help}</p> : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Input
              type={row.secret && !reveal ? 'password' : 'text'}
              value={draft}
              disabled={busy || blockedSecret}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                row.secret
                  ? row.isSet
                    ? '•••••••• (set — type to replace)'
                    : 'not set'
                  : (row.placeholder ?? row.default ?? '')
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty && !busy) void run(() => putConfig(row.key, draft))
              }}
              className="font-mono text-sm"
            />
            {row.secret ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 shrink-0 px-2"
                disabled={draft.length === 0}
                title={reveal ? 'Hide' : 'Show what you typed'}
                aria-label={reveal ? 'Hide value' : 'Show value'}
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-9 shrink-0"
              disabled={!dirty || busy || blockedSecret}
              onClick={() => void run(() => putConfig(row.key, draft))}
            >
              {justSaved ? <Check className="size-4" /> : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 shrink-0 px-2"
              // Keyed on "a row exists", not "the row is winning": a value
              // shadowed by an env var is still stored and still needs
              // clearing, and disabling the button would strand it.
              disabled={busy || row.updatedAt == null}
              title={
                row.updatedAt == null
                  ? 'Nothing saved here to clear'
                  : 'Remove the saved value and fall back to the default'
              }
              aria-label={`Clear ${row.label}`}
              onClick={() => void run(() => deleteConfig(row.key))}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>

          {shadowedConflict ? (
            <p className="mt-1 text-xs text-amber-400/90">
              A value is saved here, but an environment variable on the deployment is overriding it.
              Remove it from the deployment for the saved value to take effect.
            </p>
          ) : shadowedEmpty ? (
            <p className="mt-1 text-xs text-amber-400/90">
              Set to empty by the deployment, which disables this. (PR previews and agent worktrees
              blank the download settings this way on purpose.)
            </p>
          ) : null}
          {row.error ? <p className="mt-1 text-xs text-destructive">{row.error}</p> : null}
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
          {row.updatedAt ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Saved {formatWhen(row.updatedAt)}
              {row.updatedBy ? ` by ${row.updatedBy}` : ''}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default function Settings() {
  const [rows, setRows] = useState<ConfigRow[]>([])
  const [configKeyConfigured, setConfigKeyConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await getConfig()
      setRows(d.config)
      setConfigKeyConfigured(d.configKeyConfigured)
    } catch (e) {
      setRows([])
      setError(e instanceof Error ? e.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => {
    const byGroup = new Map<string, ConfigRow[]>()
    for (const r of rows) {
      const list = byGroup.get(r.group) ?? []
      list.push(r)
      byGroup.set(r.group, list)
    }
    return [...byGroup.entries()]
  }, [rows])

  const onSaved = (next: ConfigRow) =>
    setRows((prev) => prev.map((r) => (r.key === next.key ? next : r)))

  const envCount = rows.filter((r) => r.source === 'env').length
  const brokenSecrets = rows.filter((r) => r.error).length

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Settings</h1>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {!configKeyConfigured ? (
          <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <div>
              <p className="font-medium text-amber-300">Secrets can’t be saved</p>
              <p className="mt-0.5 text-muted-foreground">
                <code className="font-mono text-xs">CONFIG_KEY</code> isn’t set on this deployment, so
                there’s nothing to encrypt secrets with. Non-secret settings work normally. Generate one
                with{' '}
                <code className="font-mono text-xs">
                  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
                </code>
                .
              </p>
            </div>
          </div>
        ) : null}

        {brokenSecrets > 0 ? (
          <div className="mb-4 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">
                {brokenSecrets} stored {brokenSecrets === 1 ? 'secret' : 'secrets'} can’t be decrypted
              </p>
              <p className="mt-0.5 text-muted-foreground">
                <code className="font-mono text-xs">CONFIG_KEY</code> has changed since they were saved.
                Restore the original key, or clear and re-enter the affected values.
              </p>
            </div>
          </div>
        ) : null}

        {envCount > 0 ? (
          <p className="mb-4 text-xs text-muted-foreground">
            {envCount} {envCount === 1 ? 'setting is' : 'settings are'} set by environment variables on
            the deployment, which override anything saved here — including when the variable is empty.
            Remove one from the deployment to manage it on this page.
          </p>
        ) : null}

        {loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading settings…</p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map(([group, groupRows]) => (
              <section key={group} className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                <h2 className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group}
                </h2>
                {groupRows.map((row) => (
                  <SettingRow
                    key={row.key}
                    row={row}
                    onSaved={onSaved}
                    canWriteSecrets={configKeyConfigured}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
