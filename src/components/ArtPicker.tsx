import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Trash2, Upload } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fetchAuth, parseAuthJson } from '@/lib/api'

export type ArtKind = 'banner' | 'poster'

export interface Art {
  id: number
  kind: ArtKind
  source: string
  selected: boolean
  width: number | null
  height: number | null
  preview: string
  thumb: string
}

/** Everything that differs between the wide hero and the portrait poster. */
const KINDS: Record<ArtKind, { title: string; blurb: string; empty: string; aspect: string; cols: string }> = {
  banner: {
    title: 'Season banner',
    blurb: 'Shown behind the title on the public page',
    empty: 'No banners found for this title',
    aspect: 'aspect-[16/5]',
    cols: 'sm:grid-cols-2',
  },
  poster: {
    title: 'Season poster',
    blurb: "Shown on the browse grid and this season's card — defaults to Jellyfin's own poster",
    empty: 'No posters found for this title',
    aspect: 'aspect-[2/3]',
    // Three across, not four: these sit two-pickers-wide, so a fourth column
    // put each poster at ~150px — too small to judge artwork on, which is what
    // the dialog above is for, but the grid should not need rescuing either.
    cols: 'grid-cols-2 sm:grid-cols-3',
  },
}

/**
 * Candidate art picker for one series and one kind. Owns its own fetch/select
 * state, so the two pickers on a series page don't fight over one list.
 */
export function ArtPicker({ seriesId, kind }: { seriesId: number; kind: ArtKind }) {
  const copy = KINDS[kind]
  const [art, setArt] = useState<Art[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Clicking a thumbnail opens it large instead of selecting it outright.
  // The thumbnails are ~150px wide inside a two-column layout, which is not
  // enough to judge artwork by, and the old behaviour committed the choice on
  // that glance — with no undo beyond picking a different one. The full-size
  // `preview` URL was already coming back from the API and going unused.
  const [previewing, setPreviewing] = useState<Art | null>(null)

  const load = useCallback(async () => {
    if (!Number.isFinite(seriesId)) return
    setLoading(true)
    try {
      const r = await fetchAuth(`/api/series/${seriesId}/banners?kind=${kind}`)
      if (r.ok) setArt(((await r.json()) as { banners: Art[] }).banners)
    } catch {
      /* leave prior state */
    } finally {
      setLoading(false)
    }
  }, [seriesId, kind])

  useEffect(() => {
    void load()
  }, [load])

  // select/upload/delete all return the fresh list for this kind.
  const apply = async (r: Response) => {
    const d = await parseAuthJson<{ banners?: Art[]; error?: string }>(r)
    if (!r.ok) throw new Error(d.error ?? 'Request failed')
    setArt(d.banners ?? [])
  }

  const run = async (fn: () => Promise<Response>, fallback: string) => {
    setBusy(true)
    setError('')
    try {
      await apply(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const choose = (id: number) => {
    setPreviewing(null)
    return run(
      () =>
        fetchAuth(`/api/series/${seriesId}/banners/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bannerId: id }),
        }),
      'Failed to select',
    )
  }

  const upload = (file: File) =>
    run(
      () =>
        fetchAuth(`/api/series/${seriesId}/banners/upload?kind=${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        }),
      'Upload failed',
    )

  const remove = (id: number) =>
    run(() => fetchAuth(`/api/series/${seriesId}/banners/${id}`, { method: 'DELETE' }), 'Delete failed')

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <span className="text-xs text-muted-foreground">
          {copy.blurb}
          {art.length > 0 ? ` · ${art.length} options` : ''}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
            e.target.value = ''
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-4" />
          Upload
        </Button>
      </div>

      {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}

      {loading && art.length === 0 ? (
        <p className="text-sm text-muted-foreground">Gathering {kind} options…</p>
      ) : art.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {copy.empty} — the artwork sources are keyed on the season mapping, so check this series
          has a tvdb id, or upload one to set it.
        </p>
      ) : (
        <div className={`grid max-h-[26rem] grid-cols-1 gap-3 overflow-y-auto ${copy.cols}`}>
          {art.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={busy}
              onClick={() => setPreviewing(b)}
              title={b.selected ? `Selected ${kind} — click to view full size` : `View this ${b.source} ${kind} full size`}
              className={`group relative block overflow-hidden rounded-lg border text-left transition disabled:opacity-60 ${
                b.selected ? 'border-ring ring-2 ring-ring/40' : 'border-border hover:border-ring/60'
              }`}
            >
              <img
                src={b.thumb}
                alt={`${b.source} ${kind}`}
                loading="lazy"
                className={`${copy.aspect} w-full bg-muted object-cover`}
              />
              <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                {b.source}
              </span>
              {b.width && b.height ? (
                <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {b.width}×{b.height}
                </span>
              ) : null}
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
                  aria-label={`Delete this ${kind}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(b.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      void remove(b.id)
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

      {/* Preview-then-commit. Deliberately a dialog rather than hover-to-expand:
          hover does not exist on a phone, and this page is used on one. The
          image is capped by viewport height so a tall poster cannot push the
          Save button off-screen. */}
      <Dialog open={previewing != null} onOpenChange={(o) => { if (!o) setPreviewing(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="capitalize">{previewing?.source} {kind}</DialogTitle>
            <DialogDescription>
              {previewing?.width && previewing?.height
                ? `${previewing.width}×${previewing.height}`
                : 'Dimensions unknown'}
              {previewing?.selected ? ' · currently selected' : ''}
            </DialogDescription>
          </DialogHeader>
          {previewing ? (
            <img
              src={previewing.preview}
              alt={`${previewing.source} ${kind}, full size`}
              className="max-h-[60vh] w-full rounded-lg bg-muted object-contain"
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setPreviewing(null)} disabled={busy}>
              Cancel
            </Button>
            {previewing?.source === 'upload' ? (
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={busy}
                onClick={() => {
                  const id = previewing.id
                  setPreviewing(null)
                  void remove(id)
                }}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            ) : null}
            <Button
              disabled={busy || !previewing || previewing.selected}
              onClick={() => previewing && void choose(previewing.id)}
            >
              <Check className="size-4" />
              {previewing?.selected ? `Already the ${kind}` : `Use this ${kind}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
