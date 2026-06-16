import { useState } from 'react'
import { useAuth } from '@/lib/AuthContext'
import { Button } from '@/components/ui/button'
import { AnimeSearch } from '@/components/AnimeSearch'
import { SeriesList } from '@/components/SeriesList'

export default function Dashboard() {
  const { user, logout } = useAuth()
  const [listRev, setListRev] = useState(0)

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="shrink-0 text-lg font-semibold md:text-xl">
          Anime Indexer
        </h1>
        <div className="flex min-w-0 flex-1 justify-center">
          <AnimeSearch
            className="w-full max-w-xl"
            onAdded={() => setListRev((n) => n + 1)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 md:gap-4">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {user?.username}
          </span>
          <Button variant="outline" size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="p-4 md:p-6">
        <h2 className="mb-4 text-lg font-medium">Your series</h2>
        <SeriesList refreshKey={listRev} />
      </main>
    </div>
  )
}
