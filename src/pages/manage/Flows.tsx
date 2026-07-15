import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Map as MapIcon, Plus, Trash2, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listFlows, createFlow, deleteFlow, saveFlow, type FlowSummary } from '@/lib/flows'

export default function Flows() {
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const d = await listFlows()
      setFlows(d.flows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load flows')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await createFlow(name)
      setNewName('')
      setCreating(false)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create flow')
    }
  }

  const remove = async (id: number) => {
    try {
      await deleteFlow(id)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete flow')
    }
  }

  const toggleEnabled = async (f: FlowSummary) => {
    // Optimistic flip; reload reconciles on failure.
    setFlows((fs) => fs.map((x) => (x.id === f.id ? { ...x, enabled: !f.enabled } : x)))
    try {
      await saveFlow(f.id, { enabled: !f.enabled })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update flow')
      void load()
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Flows</h1>
        <Button size="sm" variant="outline" className="gap-1" asChild>
          <Link to="/manage/flows/map">
            <MapIcon className="size-4" />
            Map
          </Link>
        </Button>
        {creating ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Flow name"
              className="h-8 w-44"
            />
            <Button type="submit" size="sm" disabled={!newName.trim()}>
              Create
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button size="sm" className="gap-1" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New flow
          </Button>
        )}
      </header>
      <main className="p-4 md:p-6">
        {error ? (
          <p className="mb-4 text-sm text-destructive">{error}</p>
        ) : null}
        {loading && flows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading flows…</p>
        ) : flows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
            <Workflow className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No flows yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Flows describe how portal metadata and images are sourced. Create
                one to open the graph editor.
              </p>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {flows.map((f) => (
              <li key={f.id}>
                <Link
                  to={`/manage/flows/${f.id}`}
                  className={`flex h-full flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:bg-muted/40 ${f.enabled ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      <Workflow className="size-4 shrink-0 text-muted-foreground" />
                      {f.name}
                      {f.published ? (
                        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-300">
                          Component
                        </span>
                      ) : null}
                    </span>
                    <span className="relative z-10 flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          f.enabled
                            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70'
                        }`}
                        title={
                          f.enabled
                            ? 'Automation on — schedules and event triggers fire this flow. Click to turn off.'
                            : 'Automation off — schedules skip it and event triggers ignore it (manual runs still work). Click to turn on.'
                        }
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          void toggleEnabled(f)
                        }}
                      >
                        {f.enabled ? 'On' : 'Off'}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        aria-label={`Delete ${f.name}`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          void remove(f.id)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                  {f.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{f.description}</p>
                  ) : null}
                  <p className="mt-auto text-[10px] text-muted-foreground">
                    {f.node_count} nodes · updated {f.updated_at}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
