import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Plus, Search, X } from 'lucide-react'
import { TitleSearch } from '@/components/TitleSearch'
import { AddSeriesModal } from '@/components/AddSeriesModal'
import { SeriesList, type CatalogView, type SeriesEntry } from '@/components/SeriesList'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchAuth, parseAuthJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SECTION_LABELS, isSection, type Section } from '@/lib/sections'
import { SORT_LABELS, isCatalogSort, type CatalogSort } from '@/lib/seriesGroups'

interface SectionInfo {
  section: Section
  label: string
  provider: string
  providerConfigured: boolean
  providerUnavailableReason?: string
  count: number
}

const VIEWS: Array<{ value: CatalogView; label: string; Icon: typeof List }> = [
  { value: 'list', label: 'List', Icon: List },
  { value: 'grid', label: 'Grid', Icon: LayoutGrid },
]

export default function Library() {
  // Section, view and sort live in the URL so a view is linkable and survives
  // a refresh — "the TV catalog, as a grid, newest release first" should be a
  // thing you can send someone.
  const [params, setParams] = useSearchParams()
  const raw = params.get('section') ?? ''
  const section: Section = isSection(raw) ? raw : 'anime'
  // `?group=flat` came from the short-lived By show / Flat toggle (v2.103–2.106).
  // Flat's per-cour cards are gone — every view is by show now — so an old
  // link lands on the grid, the closest thing to what it used to show.
  const legacyGroup = params.get('group')
  const view: CatalogView = params.get('view') === 'grid' || legacyGroup === 'flat' ? 'grid' : 'list'
  const rawSort = params.get('sort') ?? ''
  const sort: CatalogSort = isCatalogSort(rawSort) ? rawSort : 'added'

  const [series, setSeries] = useState<SeriesEntry[]>([])
  const [sections, setSections] = useState<SectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState('')
  // The filter is deliberately *not* in the URL: it changes on every keystroke,
  // and a history entry per letter would make Back useless.
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchAuth(`/api/series?section=${section}`)
      if (!r.ok) throw new Error('load failed')
      const d = (await r.json()) as { series: SeriesEntry[] }
      setSeries(d.series)
    } catch {
      setSeries([])
      setError('Could not load this section’s catalog.')
    } finally {
      setLoading(false)
    }
  }, [section])

  // The registry is section-independent, so it loads once and carries the
  // per-section counts the switcher shows.
  const loadSections = useCallback(async () => {
    try {
      const r = await fetchAuth('/api/sections')
      const d = await parseAuthJson<{ sections?: SectionInfo[] }>(r)
      setSections(d.sections ?? [])
    } catch {
      setSections([])
    }
  }, [])

  // One writer for the URL, so no control can silently reset another. The
  // section is always written, including the default — a /manage link should
  // say which catalog it opens. View and sort are written only when they
  // differ from their defaults, to keep ordinary links short.
  const writeParams = useCallback(
    (next: { section: Section; view: CatalogView; sort: CatalogSort }, replace = false) => {
      const p: Record<string, string> = { section: next.section }
      if (next.view !== 'list') p.view = next.view
      if (next.sort !== 'added') p.sort = next.sort
      setParams(p, { replace })
    },
    [setParams],
  )

  // Normalise the address bar: a bare /manage or an unknown ?section= becomes
  // explicit, and a legacy ?group= is translated rather than left to linger.
  useEffect(() => {
    if (isSection(raw) && legacyGroup == null) return
    writeParams({ section, view, sort }, true)
  }, [raw, legacyGroup, section, view, sort, writeParams])

  // A filter typed in one section means nothing in another.
  useEffect(() => {
    setQuery('')
  }, [section])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadSections()
  }, [loadSections])

  const refresh = () => {
    void load()
    void loadSections()
  }

  const openModal = (q: string) => {
    setModalQuery(q)
    setModalOpen(true)
  }

  const current = useMemo(() => sections.find((s) => s.section === section), [sections, section])
  const addLabel = section === 'movies' ? 'Add movie' : section === 'tv' ? 'Add show' : 'Add series'

  return (
    <div className="min-h-screen">
      <header className="flex flex-col gap-3 border-b px-4 py-3 md:flex-row md:items-center md:px-6">
        <div className="flex items-center gap-3">
          <h1 className="shrink-0 text-lg font-semibold md:text-xl">Catalog</h1>
          {/* Only render the switcher when there is something to switch
              between — a single-section deployment shouldn't grow chrome. */}
          {sections.length > 1 ? (
            <div className="flex shrink-0 rounded-md border border-border p-0.5" role="tablist">
              {sections.map((s) => (
                <button
                  key={s.section}
                  type="button"
                  role="tab"
                  aria-selected={s.section === section}
                  onClick={() => writeParams({ section: s.section, view, sort })}
                  className={cn(
                    'rounded px-2.5 py-1 text-sm font-medium transition-colors',
                    s.section === section
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s.label}
                  <span className="ml-1.5 text-xs text-muted-foreground">{s.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Find-or-add: jumps to a title already in the catalog, or searches
            the section's provider for one to add. The toolbar below filters
            the list in place — a different job, so a different control. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <TitleSearch
            section={section}
            className="w-full max-w-xl"
            catalog={series}
            onChanged={refresh}
            onOpenAddModal={openModal}
          />
        </div>

        <Button type="button" size="sm" className="shrink-0 gap-1 self-start md:self-auto" onClick={() => openModal('')}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">{addLabel}</span>
        </Button>
      </header>

      <main className="p-4 md:p-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        {/* A section whose provider has no credentials can still be browsed —
            it just can't be added to, and saying which variable is missing is
            more useful than an add button that fails on click. */}
        {current && !current.providerConfigured ? (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
            {current.providerUnavailableReason ||
              `${SECTION_LABELS[section]} metadata is unavailable — its provider (${current.provider}) is not configured.`}
          </p>
        ) : null}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${SECTION_LABELS[section].toLowerCase()}…`}
              aria-label="Filter this list"
              // type=search gives the right keyboard and Escape-to-clear, but
              // Chromium also draws its own clear button — which sat next to
              // ours as a second, differently-styled ✕.
              className="h-9 pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Sort
            <select
              value={sort}
              onChange={(e) => {
                const v = e.target.value
                if (isCatalogSort(v)) writeParams({ section, view, sort: v })
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              {(Object.keys(SORT_LABELS) as CatalogSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Layout">
            {VIEWS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => writeParams({ section, view: value, sort })}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  view === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <SeriesList
          section={section}
          series={series}
          loading={loading}
          view={view}
          sort={sort}
          query={query}
          onChanged={refresh}
          onAddClick={(q) => openModal(q ?? '')}
        />
      </main>

      <AddSeriesModal
        section={section}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onAdded={refresh}
        initialQuery={modalQuery}
      />
    </div>
  )
}
