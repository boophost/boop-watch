import { useState } from 'react'
import { AnimeSearch } from '@/components/AnimeSearch'
import { SeriesList } from '@/components/SeriesList'

export default function Library() {
  const [listRev, setListRev] = useState(0)

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="shrink-0 text-lg font-semibold md:text-xl">Library</h1>
        <div className="flex min-w-0 flex-1 justify-center">
          <AnimeSearch
            className="w-full max-w-xl"
            onAdded={() => setListRev((n) => n + 1)}
          />
        </div>
      </header>
      <main className="p-4 md:p-6">
        <SeriesList refreshKey={listRev} />
      </main>
    </div>
  )
}
