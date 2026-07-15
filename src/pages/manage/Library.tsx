import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { AnimeSearch } from '@/components/AnimeSearch'
import { AddSeriesModal } from '@/components/AddSeriesModal'
import { SeriesList, type SeriesEntry } from '@/components/SeriesList'
import { Button } from '@/components/ui/button'
import { fetchAuth } from '@/lib/api'

export default function Library() {
  const [series, setSeries] = useState<SeriesEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchAuth('/api/series')
      if (!r.ok) throw new Error('load failed')
      const d = (await r.json()) as { series: SeriesEntry[] }
      setSeries(d.series)
    } catch {
      setSeries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openModal = (query: string) => {
    setModalQuery(query)
    setModalOpen(true)
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-3 border-b px-4 py-3 md:px-6">
        <h1 className="shrink-0 text-lg font-semibold md:text-xl">Catalog</h1>
        <div className="flex min-w-0 flex-1 justify-center">
          <AnimeSearch
            className="w-full max-w-xl"
            catalog={series}
            onChanged={() => void load()}
            onOpenAddModal={openModal}
          />
        </div>
        <Button type="button" size="sm" className="shrink-0 gap-1" onClick={() => openModal('')}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">Add series</span>
        </Button>
      </header>
      <main className="p-4 md:p-6">
        <SeriesList
          series={series}
          loading={loading}
          onChanged={() => void load()}
          onAddClick={() => openModal('')}
        />
      </main>
      <AddSeriesModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onAdded={() => void load()}
        initialQuery={modalQuery}
      />
    </div>
  )
}
