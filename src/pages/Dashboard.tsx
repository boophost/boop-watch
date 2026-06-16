import { useState } from 'react'
import { Link } from 'react-router-dom'
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
        <h1 className="flex shrink-0 items-baseline gap-1.5 text-lg font-semibold md:text-xl">
          boopurnoes
          <span className="text-sm font-medium text-muted-foreground">· manage</span>
        </h1>
        <div className="flex min-w-0 flex-1 justify-center">
          <AnimeSearch
            className="w-full max-w-xl"
            onAdded={() => setListRev((n) => n + 1)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 md:gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">View site</Link>
          </Button>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {user?.username}
          </span>
          <Button variant="outline" size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="p-4 md:p-6">
        <h2 className="mb-4 text-lg font-medium">Library</h2>
        <SeriesList refreshKey={listRev} />
      </main>
    </div>
  )
}
