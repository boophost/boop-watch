import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { TitleSearch } from '@/components/TitleSearch'
import { AddSeriesModal } from '@/components/AddSeriesModal'
import { SeriesList, type SeriesEntry } from '@/components/SeriesList'
import { Button } from '@/components/ui/button'
import { fetchAuth, parseAuthJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SECTION_LABELS, isSection, type Section } from '@/lib/sections'

interface SectionInfo {
  section: Section
  label: string
  provider: string
  providerConfigured: boolean
  providerUnavailableReason?: string
  count: number
}

export default function Library() {
  // Section lives in the URL so a view is linkable and survives a refresh —
  // "the TV catalog" should be a thing you can send someone.
  const [params, setParams] = useSearchParams()
  const raw = params.get('section') ?? ''
  const section: Section = isSection(raw) ? raw : 'anime'

  const [series, setSeries] = useState<SeriesEntry[]>([])
  const [sections, setSections] = useState<SectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState('')

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

  const openModal = (query: string) => {
    setModalQuery(query)
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
                  onClick={() => setParams(s.section === 'anime' ? {} : { section: s.section })}
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
        <SeriesList
          section={section}
          series={series}
          loading={loading}
          onChanged={refresh}
          onAddClick={() => openModal('')}
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
