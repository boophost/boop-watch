import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Ban, ChevronLeft, ExternalLink, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SeriesEntry } from '@/components/SeriesList'
import { fetchAuth } from '@/lib/api'

interface SeriesDownload {
  hash: string
  name: string
  state: string
  progress: number
  dlspeed: number
  size: number
  numSeeds: number
  eta: number
  isBatch: boolean
  episode: number | null
}

interface BlacklistRow {
  id: number
  info_hash: string
  name: string | null
  reason: string | null
  created_at: string
}

interface DownloadStatus {
  qbitConfigured: boolean
  qbitError: string | null
  torrents: SeriesDownload[]
  siteEpisodes: Record<string, string>
  blacklist: BlacklistRow[]
}

// The best torrent covering a given episode: a batch (covers all) or a
// single-episode release matching that number; most-complete wins.
function episodeDownload(
  epNum: number | null,
  torrents: SeriesDownload[],
): SeriesDownload | null {
  if (epNum == null) return null
  const covering = torrents.filter((t) => t.isBatch || t.episode === epNum)
  return covering.sort((a, b) => b.progress - a.progress)[0] ?? null
}

function formatBytes(n: number): string {
  if (!n || n < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

// qBittorrent states → short label + tone.
function stateLabel(state: string, progress: number): { text: string; tone: string } {
  if (progress >= 1) {
    if (state.includes('UP') || state === 'uploading' || state === 'stalledUP')
      return { text: 'Complete · seeding', tone: 'text-emerald-500' }
    return { text: 'Complete', tone: 'text-emerald-500' }
  }
  if (state.startsWith('stalled')) return { text: 'Stalled (no peers)', tone: 'text-amber-500' }
  if (state.includes('DL') || state === 'downloading')
    return { text: 'Downloading', tone: 'text-sky-500' }
  if (state.includes('paused') || state.includes('stopped'))
    return { text: 'Paused', tone: 'text-muted-foreground' }
  if (state === 'error' || state === 'missingFiles')
    return { text: 'Error', tone: 'text-destructive' }
  return { text: state, tone: 'text-muted-foreground' }
}

interface MalImages {
  jpg?: { large_image_url?: string | null; image_url?: string | null }
  webp?: { large_image_url?: string | null; image_url?: string | null }
}

interface MalDetail {
  mal_id: number
  url: string
  title: string
  title_english?: string | null
  title_japanese?: string | null
  type?: string
  source?: string
  episodes?: number | null
  status?: string
  duration?: string
  rating?: string
  score?: number | null
  synopsis?: string | null
  aired?: { string?: string | null }
  season?: string | null
  year?: number | null
  images: MalImages
  studios?: { name: string }[]
  genres?: { name: string }[]
}

interface EpisodeRow {
  mal_id: number
  url: string
  title: string
  title_japanese: string | null
  aired: string | null
  filler: boolean
  recap: boolean
  episode: number | null
}

function heroImage(mal: MalDetail | null, series: SeriesEntry): string | null {
  if (mal?.images) {
    const w = mal.images.webp?.large_image_url || mal.images.webp?.image_url
    const j = mal.images.jpg?.large_image_url || mal.images.jpg?.image_url
    const u = w || j
    if (u) return u
  }
  return series.image_url
}

function formatAired(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function SeriesDetail() {
  const { seriesId } = useParams<{ seriesId: string }>()
  const navigate = useNavigate()
  const id = Number(seriesId)

  const [series, setSeries] = useState<SeriesEntry | null>(null)
  const [mal, setMal] = useState<MalDetail | null>(null)
  const [malError, setMalError] = useState('')
  const [detailLoading, setDetailLoading] = useState(true)

  const [episodes, setEpisodes] = useState<EpisodeRow[]>([])
  const [epPage, setEpPage] = useState(1)
  const [epHasNext, setEpHasNext] = useState(false)
  const [epLoading, setEpLoading] = useState(false)
  const [epError, setEpError] = useState('')

  const [dl, setDl] = useState<DownloadStatus | null>(null)
  const [busyHash, setBusyHash] = useState<string | null>(null)

  const loadDownloads = useCallback(async () => {
    if (!Number.isFinite(id)) return
    try {
      const r = await fetchAuth(`/api/series/${id}/downloads`)
      if (!r.ok) return
      setDl((await r.json()) as DownloadStatus)
    } catch {
      /* leave prior state */
    }
  }, [id])

  const removeDownload = async (hash: string, deleteFiles: boolean) => {
    setBusyHash(hash)
    try {
      await fetchAuth(`/api/series/${id}/downloads/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, deleteFiles }),
      })
      await loadDownloads()
    } finally {
      setBusyHash(null)
    }
  }

  const blacklistSource = async (t: SeriesDownload) => {
    setBusyHash(t.hash)
    try {
      await fetchAuth(`/api/series/${id}/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          info_hash: t.hash,
          name: t.name,
          alsoDelete: true,
          deleteFiles: true,
        }),
      })
      await loadDownloads()
    } finally {
      setBusyHash(null)
    }
  }

  const unblacklist = async (entryId: number) => {
    await fetchAuth(`/api/blacklist/${entryId}`, { method: 'DELETE' })
    await loadDownloads()
  }

  useEffect(() => {
    if (!Number.isFinite(id)) {
      navigate('/manage', { replace: true })
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setMalError('')
    void (async () => {
      try {
        const r = await fetchAuth(`/api/series/${id}/detail`)
        if (r.status === 404) {
          navigate('/manage', { replace: true })
          return
        }
        if (!r.ok) throw new Error('Failed to load series')
        const d = (await r.json()) as {
          series: SeriesEntry
          mal: MalDetail | null
          malError?: string
        }
        if (cancelled) return
        setSeries(d.series)
        setMal(d.mal)
        if (d.malError) setMalError(d.malError)
      } catch {
        if (!cancelled) navigate('/manage', { replace: true })
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, navigate])

  const loadEpisodes = useCallback(
    async (page: number, replace: boolean) => {
      if (!Number.isFinite(id)) return
      setEpLoading(true)
      setEpError('')
      try {
        const r = await fetchAuth(`/api/series/${id}/episodes?page=${page}`)
        const raw = (await r.json()) as {
          episodes?: EpisodeRow[]
          pagination?: { has_next_page: boolean }
          error?: string
        }
        if (!r.ok) throw new Error(raw.error ?? 'Episodes failed')
        const next = raw.episodes ?? []
        setEpisodes((prev) => (replace ? next : [...prev, ...next]))
        setEpPage(page)
        setEpHasNext(raw.pagination?.has_next_page ?? false)
      } catch (e) {
        setEpError(e instanceof Error ? e.message : 'Episodes failed')
      } finally {
        setEpLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    if (!series) return
    setEpisodes([])
    setEpPage(1)
    setEpHasNext(false)
    void loadEpisodes(1, true)
  }, [series, loadEpisodes])

  // Load downloads once, then poll while a torrent is actively downloading.
  useEffect(() => {
    if (!series) return
    void loadDownloads()
  }, [series, loadDownloads])

  useEffect(() => {
    const active = dl?.torrents.some((t) => t.progress < 1 && !t.state.includes('paused'))
    if (!active) return
    const h = setInterval(() => void loadDownloads(), 5000)
    return () => clearInterval(h)
  }, [dl, loadDownloads])

  if (detailLoading || !series) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading series…</p>
      </div>
    )
  }

  const img = heroImage(mal, series)
  const displayTitle = mal?.title ?? series.title
  const synopsis = mal?.synopsis ?? series.synopsis
  const metaLine = [
    mal?.type,
    mal?.episodes != null ? `${mal.episodes} eps` : null,
    mal?.status,
    mal?.aired?.string,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3 md:px-6">
        <Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2" asChild>
          <Link to="/manage">
            <ChevronLeft className="size-4" />
            Back
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">
          {displayTitle}
        </h1>
      </header>

      <main className="mx-auto max-w-5xl space-y-10 p-4 md:p-6">
        <section className="flex flex-col gap-6 md:flex-row md:gap-8">
          <div className="mx-auto w-48 shrink-0 self-start overflow-hidden rounded-lg border border-border bg-muted md:mx-0 md:w-56">
            {img ? (
              // Natural aspect ratio — posters aren't all exactly 2:3, and
              // object-cover was cropping them.
              <img src={img} alt="" className="block h-auto w-full" />
            ) : (
              <div className="flex aspect-[2/3] items-center justify-center text-sm text-muted-foreground">
                No poster
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            {mal?.title_english &&
            mal.title_english !== displayTitle &&
            mal.title_english !== mal.title ? (
              <p className="text-sm text-muted-foreground">{mal.title_english}</p>
            ) : null}
            {mal?.title_japanese ? (
              <p className="text-sm text-muted-foreground">{mal.title_japanese}</p>
            ) : null}

            {metaLine ? (
              <p className="text-sm text-muted-foreground">{metaLine}</p>
            ) : null}

            {mal?.score != null ? (
              <p className="text-sm">
                <span className="font-medium text-foreground">MAL score:</span>{' '}
                {mal.score}
              </p>
            ) : null}

            {mal?.genres?.length ? (
              <p className="text-sm">
                <span className="font-medium">Genres:</span>{' '}
                {mal.genres.map((g) => g.name).join(', ')}
              </p>
            ) : null}

            {mal?.studios?.length ? (
              <p className="text-sm">
                <span className="font-medium">Studios:</span>{' '}
                {mal.studios.map((s) => s.name).join(', ')}
              </p>
            ) : null}

            {mal?.source ? (
              <p className="text-sm">
                <span className="font-medium">Source:</span> {mal.source}
              </p>
            ) : null}

            {mal?.duration ? (
              <p className="text-sm">
                <span className="font-medium">Duration:</span> {mal.duration}
              </p>
            ) : null}

            {mal?.rating ? (
              <p className="text-sm">
                <span className="font-medium">Rating:</span> {mal.rating}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              {(mal?.url ?? series.url) ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={mal?.url ?? series.url!} target="_blank" rel="noreferrer">
                    MyAnimeList
                    <ExternalLink className="ml-1 size-3.5 opacity-70" />
                  </a>
                </Button>
              ) : null}
            </div>

            {malError ? (
              <p className="text-sm text-amber-600 dark:text-amber-500">{malError}</p>
            ) : null}

            {synopsis ? (
              <div className="pt-2">
                <h2 className="mb-2 text-sm font-medium text-foreground">Synopsis</h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {synopsis.replace(/\r\n/g, '\n')}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold">Downloads</h2>
          {!dl ? (
            <p className="text-sm text-muted-foreground">Loading downloads…</p>
          ) : !dl.qbitConfigured ? (
            <p className="text-sm text-muted-foreground">
              qBittorrent isn’t configured, so download status is unavailable.
            </p>
          ) : dl.qbitError ? (
            <p className="text-sm text-amber-600 dark:text-amber-500">
              qBittorrent: {dl.qbitError}
            </p>
          ) : dl.torrents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No downloads for this series. The “Missing videos” flow queues them
              in qBittorrent.
            </p>
          ) : (
            <ul className="space-y-3">
              {dl.torrents.map((t) => {
                const st = stateLabel(t.state, t.progress)
                const busy = busyHash === t.hash
                return (
                  <li
                    key={t.hash}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={t.name}>
                          {t.name}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span className={st.tone}>{st.text}</span>
                          <span>·</span>
                          <span>{(t.progress * 100).toFixed(t.progress >= 1 ? 0 : 1)}%</span>
                          <span>·</span>
                          <span>{formatBytes(t.size)}</span>
                          <span>·</span>
                          <span>{t.numSeeds} seeds</span>
                          <span>·</span>
                          <span>{t.isBatch ? 'Batch' : t.episode != null ? `Ep ${t.episode}` : 'Single'}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 px-2 text-amber-600 dark:text-amber-500"
                          disabled={busy}
                          title="Blacklist this source and remove it — the flow won't pick it again"
                          onClick={() => void blacklistSource(t)}
                        >
                          <Ban className="size-3.5" />
                          <span className="hidden sm:inline">Blacklist</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 px-2 text-destructive"
                          disabled={busy}
                          title="Remove this download and its files"
                          onClick={() => void removeDownload(t.hash, true)}
                        >
                          <Trash2 className="size-3.5" />
                          <span className="hidden sm:inline">Remove</span>
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${t.progress >= 1 ? 'bg-emerald-500' : 'bg-sky-500'}`}
                        style={{ width: `${Math.round(t.progress * 100)}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {dl && dl.blacklist.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                Blacklisted sources
              </h3>
              <ul className="space-y-1.5">
                {dl.blacklist.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs"
                  >
                    <Ban className="size-3.5 shrink-0 text-amber-500" />
                    <span className="min-w-0 flex-1 truncate" title={b.name ?? b.info_hash}>
                      {b.name ?? b.info_hash}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => void unblacklist(b.id)}
                    >
                      Un-blacklist
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold">Episodes</h2>
          {epError ? (
            <p className="text-sm text-destructive">{epError}</p>
          ) : null}

          <div className="hidden overflow-hidden rounded-lg border border-border md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="w-14 px-3 py-2 font-medium">Ep</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="w-28 px-3 py-2 font-medium">Aired</th>
                  <th className="w-24 px-3 py-2 font-medium">On site</th>
                  <th className="w-44 px-3 py-2 font-medium">Download</th>
                  <th className="w-16 px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {episodes.map((ep) => (
                  <tr
                    key={`${ep.mal_id}-${ep.episode ?? ep.title}`}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {ep.episode ?? '—'}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="font-medium">{ep.title}</span>
                      {ep.title_japanese ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {ep.title_japanese}
                        </span>
                      ) : null}
                      {ep.filler || ep.recap ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {ep.filler ? (
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-secondary-foreground">
                              Filler
                            </span>
                          ) : null}
                          {ep.recap ? (
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-secondary-foreground">
                              Recap
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {formatAired(ep.aired)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {dl?.siteEpisodes[String(ep.episode)] ? (
                        <a
                          href={`/watch/${dl.siteEpisodes[String(ep.episode)]}`}
                          className="inline-flex items-center gap-1 text-emerald-600 underline-offset-4 hover:underline dark:text-emerald-500"
                        >
                          <Play className="size-3" />
                          Watch
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {(() => {
                        const t = episodeDownload(ep.episode, dl?.torrents ?? [])
                        if (!t) return <span className="text-muted-foreground">—</span>
                        const st = stateLabel(t.state, t.progress)
                        return (
                          <div className="min-w-0">
                            <span className={`text-xs ${st.tone}`}>
                              {t.progress >= 1 ? st.text : `${(t.progress * 100).toFixed(0)}%`}
                            </span>
                            {t.progress < 1 ? (
                              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-sky-500"
                                  style={{ width: `${Math.round(t.progress * 100)}%` }}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })()}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <a
                        href={ep.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                      >
                        MAL
                        <ExternalLink className="size-3" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 md:hidden">
            {episodes.map((ep) => (
              <li
                key={`${ep.mal_id}-${ep.episode ?? ep.title}`}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Ep {ep.episode ?? '?'}
                  </span>
                  <a
                    href={ep.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-primary"
                  >
                    MAL ↗
                  </a>
                </div>
                <p className="mt-1 font-medium">{ep.title}</p>
                {ep.title_japanese ? (
                  <p className="text-xs text-muted-foreground">{ep.title_japanese}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatAired(ep.aired)}
                </p>
                {(() => {
                  const t = episodeDownload(ep.episode, dl?.torrents ?? [])
                  const watchId = dl?.siteEpisodes[String(ep.episode)]
                  if (!t && !watchId) return null
                  const st = t ? stateLabel(t.state, t.progress) : null
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {watchId ? (
                        <a
                          href={`/watch/${watchId}`}
                          className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-500"
                        >
                          <Play className="size-3" />
                          Watch on site
                        </a>
                      ) : null}
                      {t && st ? (
                        <span className={st.tone}>
                          {t.progress >= 1 ? st.text : `Downloading ${(t.progress * 100).toFixed(0)}%`}
                        </span>
                      ) : null}
                    </div>
                  )
                })()}
              </li>
            ))}
          </ul>

          {epLoading && episodes.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading episodes…</p>
          ) : null}

          {!epLoading && episodes.length === 0 && !epError ? (
            <p className="text-sm text-muted-foreground">
              No episode list from MyAnimeList for this entry (some formats omit
              episodes).
            </p>
          ) : null}

          {epHasNext ? (
            <div className="mt-4">
              <Button
                type="button"
                variant="secondary"
                disabled={epLoading}
                onClick={() => void loadEpisodes(epPage + 1, false)}
              >
                {epLoading ? 'Loading…' : 'Load more episodes'}
              </Button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  )
}
