import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  Play,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SeriesEntry } from '@/components/SeriesList'
import { fetchAuth, parseAuthJson } from '@/lib/api'

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

interface Banner {
  id: number
  source: string
  selected: boolean
  width: number | null
  height: number | null
  preview: string
}

interface EpisodeAudio { lang: string; label: string; codec: string; channels: string; def: boolean }
interface EpisodeMedia {
  id: string
  episode: number | null
  resolution: string
  videoCodec: string
  audio: EpisodeAudio[]
  subLangs: string[]
  sizeBytes: number | null
  container: string
  runtimeMin: number | null
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

// Compact per-episode media summary for the library file: resolution + codec,
// audio-track badges, and size. Renders "—" when the episode isn't in the library.
function MediaCell({ m }: { m: EpisodeMedia | undefined }) {
  if (!m) return <span className="text-muted-foreground">—</span>
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {m.resolution ? <span className="font-medium">{m.resolution}</span> : null}
        {m.videoCodec ? <span className="text-muted-foreground">{m.videoCodec}</span> : null}
        {m.sizeBytes ? (
          <span className="text-muted-foreground">· {formatBytes(m.sizeBytes)}</span>
        ) : null}
      </div>
      {m.audio.length ? (
        <div className="flex flex-wrap gap-1">
          {m.audio.map((a, i) => (
            <span
              key={i}
              className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
              title={`${a.label} ${a.codec}${a.channels ? ' ' + a.channels : ''}${a.def ? ' (default)' : ''}`}
            >
              {(a.lang || 'und').toUpperCase()} {a.codec}
            </span>
          ))}
        </div>
      ) : null}
      {m.subLangs.length ? (
        <div className="text-[10px] text-muted-foreground">Subs: {m.subLangs.join(', ')}</div>
      ) : null}
    </div>
  )
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

type StageTone = 'done' | 'active' | 'pending' | 'idle'
interface Stage {
  label: string
  detail: string
  tone: StageTone
}

// A one-glance "where is this title in the pipeline" strip, derived entirely from
// data the page already loads (catalog → download → library → on site) so there's
// no flow-chasing to see progress.
function pipelineStages(args: {
  expected: number | null
  libCount: number
  torrents: SeriesDownload[]
  onSiteCount: number
  qbitConfigured: boolean
}): Stage[] {
  const { expected, libCount, torrents, onSiteCount, qbitConfigured } = args
  const active = torrents.filter((t) => t.progress < 1 && !t.state.includes('paused'))
  const complete = torrents.filter((t) => t.progress >= 1)
  const maxPct = active.length ? Math.max(...active.map((t) => t.progress)) : 0

  const download: Stage = !qbitConfigured
    ? { label: 'Download', detail: 'qBittorrent off', tone: 'idle' }
    : active.length
      ? { label: 'Download', detail: `Downloading ${Math.round(maxPct * 100)}%`, tone: 'active' }
      : complete.length
        ? { label: 'Download', detail: 'Complete', tone: 'done' }
        : libCount > 0
          ? { label: 'Download', detail: 'Done', tone: 'done' }
          : { label: 'Download', detail: 'No release yet', tone: 'pending' }

  const library: Stage =
    expected && libCount >= expected
      ? { label: 'Library', detail: `${libCount}/${expected} imported`, tone: 'done' }
      : libCount > 0
        ? {
            label: 'Library',
            detail: `${libCount}${expected ? `/${expected}` : ''} imported`,
            tone: 'active',
          }
        : { label: 'Library', detail: expected ? `0/${expected}` : 'None yet', tone: 'pending' }

  const onSite: Stage =
    onSiteCount > 0
      ? {
          label: 'On site',
          detail: `${onSiteCount}${expected ? `/${expected}` : ''} playable`,
          tone: expected && onSiteCount >= expected ? 'done' : 'active',
        }
      : { label: 'On site', detail: 'Not yet', tone: 'pending' }

  return [{ label: 'Catalog', detail: 'Added', tone: 'done' }, download, library, onSite]
}

const TONE_STYLES: Record<StageTone, { dot: string; text: string }> = {
  done: { dot: 'text-emerald-500', text: 'text-foreground' },
  active: { dot: 'text-sky-500', text: 'text-foreground' },
  pending: { dot: 'text-muted-foreground', text: 'text-muted-foreground' },
  idle: { dot: 'text-muted-foreground', text: 'text-muted-foreground' },
}

function StageIcon({ tone }: { tone: StageTone }) {
  const cls = `size-4 shrink-0 ${TONE_STYLES[tone].dot}`
  if (tone === 'done') return <Check className={cls} />
  if (tone === 'active') return <Loader2 className={`${cls} animate-spin`} />
  return <Circle className={cls} />
}

function PipelineStrip(props: {
  expected: number | null
  libCount: number
  torrents: SeriesDownload[]
  onSiteCount: number
  qbitConfigured: boolean
}) {
  const stages = pipelineStages(props)
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
      {stages.map((s, i) => (
        <div key={s.label} className="flex items-center gap-1">
          <div className="flex items-center gap-2">
            <StageIcon tone={s.tone} />
            <div className="leading-tight">
              <div className="text-xs font-medium text-muted-foreground">{s.label}</div>
              <div className={`text-sm ${TONE_STYLES[s.tone].text}`}>{s.detail}</div>
            </div>
          </div>
          {i < stages.length - 1 ? (
            <ChevronRight className="mx-2 size-4 shrink-0 text-muted-foreground/40" />
          ) : null}
        </div>
      ))}
    </div>
  )
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
  // 'jikan' = live MAL; 'cache'/'synthesized' = fallback while MAL is unreachable.
  const [epSource, setEpSource] = useState('')

  const [dl, setDl] = useState<DownloadStatus | null>(null)
  const [busyHash, setBusyHash] = useState<string | null>(null)
  const [researchMsg, setResearchMsg] = useState('')

  // Season-mapping editor (multi-season placement override).
  const [mapEdit, setMapEdit] = useState<{ tvdb_id: string; tvdb_season: string; episode_offset: string } | null>(null)
  const [mapBusy, setMapBusy] = useState(false)
  const [mapMsg, setMapMsg] = useState('')

  const [banners, setBanners] = useState<Banner[]>([])
  const [bannersLoading, setBannersLoading] = useState(true)
  const [bannerBusy, setBannerBusy] = useState(false)
  const [bannerError, setBannerError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadBanners = useCallback(async () => {
    if (!Number.isFinite(id)) return
    setBannersLoading(true)
    try {
      const r = await fetchAuth(`/api/series/${id}/banners`)
      if (r.ok) setBanners(((await r.json()) as { banners: Banner[] }).banners)
    } catch {
      /* leave prior state */
    } finally {
      setBannersLoading(false)
    }
  }, [id])

  // Apply a banners response (select/upload/delete all return the fresh list).
  const applyBanners = async (r: Response) => {
    const d = await parseAuthJson<{ banners?: Banner[]; error?: string }>(r)
    if (!r.ok) throw new Error(d.error ?? 'Request failed')
    setBanners(d.banners ?? [])
  }

  const chooseBanner = async (bannerId: number) => {
    setBannerBusy(true)
    setBannerError('')
    try {
      await applyBanners(
        await fetchAuth(`/api/series/${id}/banners/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bannerId }),
        }),
      )
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'Failed to select')
    } finally {
      setBannerBusy(false)
    }
  }

  const uploadBanner = async (file: File) => {
    setBannerBusy(true)
    setBannerError('')
    try {
      await applyBanners(
        await fetchAuth(`/api/series/${id}/banners/upload`, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        }),
      )
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBannerBusy(false)
    }
  }

  const removeBanner = async (bannerId: number) => {
    setBannerBusy(true)
    setBannerError('')
    try {
      await applyBanners(await fetchAuth(`/api/series/${id}/banners/${bannerId}`, { method: 'DELETE' }))
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBannerBusy(false)
    }
  }

  const [libMedia, setLibMedia] = useState<Map<number, EpisodeMedia>>(new Map())

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

  const loadLibrary = useCallback(async () => {
    if (!Number.isFinite(id)) return
    try {
      const r = await fetchAuth(`/api/series/${id}/library`)
      if (!r.ok) return
      const { episodes } = (await r.json()) as { episodes: EpisodeMedia[] }
      setLibMedia(new Map(episodes.filter((e) => e.episode != null).map((e) => [e.episode as number, e])))
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
    setResearchMsg('')
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
      // Blacklisting a source implies "find me a better one" — kick off a
      // one-series re-search that skips the blacklisted hash and queues a fresh,
      // playable (non-AV1) release. Shows up in the Activity tab too.
      setResearchMsg('Searching for a replacement…')
      const r = await fetchAuth(`/api/series/${id}/research`, { method: 'POST' })
      const d = await parseAuthJson<{ queued?: number; notes?: string[]; error?: string }>(r)
      if (!r.ok) throw new Error(d.error ?? 'Re-search failed')
      const note = d.notes?.[0] ?? ''
      setResearchMsg(
        d.queued && d.queued > 0
          ? `Queued a replacement in qBittorrent${note ? ` — ${note}` : ''}`
          : `No replacement release found${note ? ` — ${note}` : ''}`,
      )
      await loadDownloads()
    } catch (e) {
      setResearchMsg(e instanceof Error ? e.message : 'Re-search failed')
    } finally {
      setBusyHash(null)
    }
  }

  // Save (or reset) the multi-season placement override. `reset` re-resolves
  // from the season-map dataset; otherwise the edited values are pinned as a
  // manual override the auto-enrich won't clobber.
  const saveMapping = async (reset = false) => {
    setMapBusy(true)
    setMapMsg('')
    try {
      const body = reset
        ? { source: 'auto' }
        : {
            tvdb_id: mapEdit?.tvdb_id ?? '',
            tvdb_season: mapEdit?.tvdb_season ?? '',
            episode_offset: mapEdit?.episode_offset ?? '',
          }
      const r = await fetchAuth(`/api/series/${id}/mapping`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await parseAuthJson<{ series?: SeriesEntry; error?: string }>(r)
      if (!r.ok || !d.series) throw new Error(d.error ?? 'Update failed')
      setSeries(d.series)
      setMapEdit(null)
      setMapMsg(reset ? 'Reset to dataset mapping' : 'Saved manual mapping')
    } catch (e) {
      setMapMsg(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setMapBusy(false)
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
        const raw = await parseAuthJson<{
          episodes?: EpisodeRow[]
          pagination?: { has_next_page: boolean }
          source?: string
          error?: string
        }>(r)
        if (!r.ok) throw new Error(raw.error ?? 'Episodes failed')
        const next = raw.episodes ?? []
        setEpisodes((prev) => (replace ? next : [...prev, ...next]))
        setEpPage(page)
        setEpHasNext(raw.pagination?.has_next_page ?? false)
        if (replace) setEpSource(raw.source ?? '')
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
    if (!series) return
    void loadBanners()
  }, [series, loadBanners])

  useEffect(() => {
    if (!series) return
    void loadLibrary()
  }, [series, loadLibrary])

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

        <PipelineStrip
          expected={mal?.episodes ?? series.episodes ?? null}
          libCount={libMedia.size}
          torrents={dl?.torrents ?? []}
          onSiteCount={dl ? Object.keys(dl.siteEpisodes).length : 0}
          qbitConfigured={dl?.qbitConfigured ?? false}
        />

        <section>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Season banner</h2>
            <span className="text-xs text-muted-foreground">Shown behind the title on the public page</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadBanner(f)
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="ml-auto gap-1"
              disabled={bannerBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" />
              Upload
            </Button>
          </div>

          {bannerError ? <p className="mb-3 text-sm text-destructive">{bannerError}</p> : null}

          {bannersLoading && banners.length === 0 ? (
            <p className="text-sm text-muted-foreground">Gathering banner options…</p>
          ) : banners.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No banners found from AniList or Kitsu for this title — upload one to set it.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {banners.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  disabled={bannerBusy}
                  onClick={() => void chooseBanner(b.id)}
                  title={b.selected ? 'Selected banner' : `Use this ${b.source} banner`}
                  className={`group relative block overflow-hidden rounded-lg border text-left transition disabled:opacity-60 ${
                    b.selected
                      ? 'border-ring ring-2 ring-ring/40'
                      : 'border-border hover:border-ring/60'
                  }`}
                >
                  <img
                    src={b.preview}
                    alt={`${b.source} banner`}
                    loading="lazy"
                    className="aspect-[16/5] w-full bg-muted object-cover"
                  />
                  <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                    {b.source}
                  </span>
                  {b.selected ? (
                    <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      <Check className="size-3" />
                      Selected
                    </span>
                  ) : null}
                  {b.source === 'upload' ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Delete this banner"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeBanner(b.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          void removeBanner(b.id)
                        }
                      }}
                      className="absolute bottom-2 right-2 rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Downloads</h2>
            <p className="text-xs text-muted-foreground">
              qBittorrent sources — not the library files below.
            </p>
          </div>
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
            <p className="text-sm text-muted-foreground">No active torrents.</p>
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
                          title="Blacklist and remove this source, then search for a replacement release"
                          onClick={() => void blacklistSource(t)}
                        >
                          <Ban className="size-3.5" />
                          <span className="hidden sm:inline">
                            {busy ? 'Working…' : 'Blacklist & replace'}
                          </span>
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

          {researchMsg ? (
            <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {researchMsg}
            </p>
          ) : null}

          {/* Multi-season placement: which Jellyfin season this cour's episodes
              land in, and the offset added to each release's episode number. */}
          <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">Season mapping</h3>
              {series?.mapping_source ? (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    series.mapping_source === 'manual'
                      ? 'bg-amber-500/15 text-amber-500'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {series.mapping_source}
                </span>
              ) : null}
            </div>
            {mapEdit ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {([
                  ['TVDB id', 'tvdb_id'],
                  ['Season', 'tvdb_season'],
                  ['Ep offset', 'episode_offset'],
                ] as const).map(([label, key]) => (
                  <label key={key} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    {label}
                    <input
                      type="number"
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      value={mapEdit[key]}
                      onChange={(e) => setMapEdit({ ...mapEdit, [key]: e.target.value })}
                    />
                  </label>
                ))}
                <Button size="sm" disabled={mapBusy} onClick={() => void saveMapping(false)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" disabled={mapBusy} onClick={() => setMapEdit(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  TVDB <span className="text-foreground">{series?.tvdb_id ?? '—'}</span>
                </span>
                <span>
                  Season <span className="text-foreground">{series?.tvdb_season ?? '—'}</span>
                </span>
                <span>
                  Offset <span className="text-foreground">{series?.episode_offset ?? 0}</span>
                </span>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() =>
                      setMapEdit({
                        tvdb_id: series?.tvdb_id != null ? String(series.tvdb_id) : '',
                        tvdb_season: series?.tvdb_season != null ? String(series.tvdb_season) : '',
                        episode_offset: series?.episode_offset != null ? String(series.episode_offset) : '',
                      })
                    }
                  >
                    Edit
                  </button>
                  {series?.mapping_source === 'manual' ? (
                    <button
                      type="button"
                      className="underline-offset-2 hover:text-foreground hover:underline"
                      disabled={mapBusy}
                      onClick={() => void saveMapping(true)}
                    >
                      Reset to auto
                    </button>
                  ) : null}
                </div>
              </div>
            )}
            {mapMsg ? <p className="mt-1.5 text-[11px] text-muted-foreground">{mapMsg}</p> : null}
          </div>

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
          {epSource === 'synthesized' || epSource === 'cache' ? (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-500">
              MyAnimeList is unreachable right now, so episode titles are{' '}
              {epSource === 'cache' ? 'from our last cached copy' : 'placeholders'}. Library and
              download status below is still live.
            </p>
          ) : null}

          <div className="hidden overflow-hidden rounded-lg border border-border md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="w-14 px-3 py-2 font-medium">Ep</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="w-48 px-3 py-2 font-medium">Library file</th>
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
                    <td className="px-3 py-2 align-top">
                      <MediaCell m={ep.episode != null ? libMedia.get(ep.episode) : undefined} />
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
                {ep.episode != null && libMedia.get(ep.episode) ? (
                  <div className="mt-2">
                    <MediaCell m={libMedia.get(ep.episode)} />
                  </div>
                ) : null}
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
