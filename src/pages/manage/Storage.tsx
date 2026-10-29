import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Folder, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import {
  deleteStorage,
  folderKey,
  getStorage,
  type StorageFolder,
  type StorageReport,
  type StorageTorrent,
} from '@/lib/storage'

// Hardlinks mean a folder and its torrents are the same bytes: deleting one
// side frees only what the other side doesn't also hold.
function estimateFreed(
  report: StorageReport,
  folders: Set<string>,
  torrents: Set<string>,
): number {
  let n = 0
  for (const f of report.folders) {
    if (!folders.has(folderKey(f))) continue
    const allLinkedGone = f.torrents.every((h) => torrents.has(h))
    n += allLinkedGone ? f.bytes : f.bytes - f.linkedBytes
  }
  for (const t of report.torrents) {
    if (!torrents.has(t.hash)) continue
    // Linked bytes are freed only with the folder, and counted there.
    n += t.bytes - t.linkedBytes
  }
  return n
}

function CatalogCell({ c }: { c: StorageFolder['catalog'] }) {
  return c ? (
    <Link to={`/manage/series/${c.id}`} className="truncate text-muted-foreground hover:underline">
      {c.title}
    </Link>
  ) : (
    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
      not in catalog
    </span>
  )
}

function torrentState(t: StorageTorrent): string {
  return t.progress < 1 ? `${t.state} ${Math.floor(t.progress * 100)}%` : t.state
}

export default function Storage() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [orphansOnly, setOrphansOnly] = useState(false)
  const [selFolders, setSelFolders] = useState<Set<string>>(new Set())
  const [selTorrents, setSelTorrents] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await getStorage())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load storage')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const torrentByHash = useMemo(
    () => new Map((report?.torrents ?? []).map((t) => [t.hash, t])),
    [report],
  )
  const folders = useMemo(
    () => (report?.folders ?? []).filter((f) => !orphansOnly || !f.catalog),
    [report, orphansOnly],
  )
  const loose = useMemo(
    () =>
      (report?.torrents ?? []).filter((t) => t.folders.length === 0 && (!orphansOnly || !t.catalog)),
    [report, orphansOnly],
  )

  // Selecting a folder selects its torrents too — alone it frees almost nothing.
  const toggleFolder = (f: StorageFolder) => {
    const key = folderKey(f)
    const on = !selFolders.has(key)
    setSelFolders((s) => {
      const n = new Set(s)
      if (on) n.add(key)
      else n.delete(key)
      return n
    })
    setSelTorrents((s) => {
      const n = new Set(s)
      for (const h of f.torrents) on ? n.add(h) : n.delete(h)
      return n
    })
  }
  const toggleTorrent = (hash: string) =>
    setSelTorrents((s) => {
      const n = new Set(s)
      if (n.has(hash)) n.delete(hash)
      else n.add(hash)
      return n
    })

  const count = selFolders.size + selTorrents.size
  const freed = report ? estimateFreed(report, selFolders, selTorrents) : 0

  async function runDelete() {
    if (!report) return
    setDeleting(true)
    try {
      const r = await deleteStorage({
        folders: report.folders.filter((f) => selFolders.has(folderKey(f))).map((f) => ({ section: f.section, name: f.name })),
        torrents: [...selTorrents],
      })
      setNotice(
        `Deleted ${r.deletedFolders.length} folder(s) and ${r.deletedTorrents} torrent(s)` +
          (r.errors.length ? ` — ${r.errors.join('; ')}` : ''),
      )
      setSelFolders(new Set())
      setSelTorrents(new Set())
      setConfirming(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
      setConfirming(false)
    } finally {
      setDeleting(false)
    }
  }

  const checkbox = 'size-4 shrink-0 accent-primary'

  return (
    <div className="min-h-screen pb-20">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-xl">Storage</h1>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className={checkbox}
            checked={orphansOnly}
            onChange={(e) => setOrphansOnly(e.target.checked)}
          />
          Not in catalog
        </label>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()} title="Refresh">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
      </header>

      <main className="grid grid-cols-1 gap-6 p-4 md:p-6">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        {report?.qbitError ? <p className="text-sm text-destructive">qBittorrent: {report.qbitError}</p> : null}
        {report?.missingRoots.map((m) => (
          <p key={m.section} className="text-sm text-destructive">
            {m.section} library not readable at {m.root || '(unset)'}
          </p>
        ))}

        {loading && !report ? (
          <p className="text-sm text-muted-foreground">Reading disks…</p>
        ) : report ? (
          <>
            <section className="grid grid-cols-1 gap-3">
              {report.volumes.map((v) => {
                const used = v.totalBytes - v.freeBytes
                const pct = v.totalBytes ? (used / v.totalBytes) * 100 : 0
                return (
                  <div key={v.paths.join()} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                    <div className="flex items-baseline gap-2">
                      <HardDrive className="size-4 self-center text-muted-foreground" />
                      <span className="font-medium">{formatBytes(v.freeBytes)} free</span>
                      <span className="text-sm text-muted-foreground">
                        of {formatBytes(v.totalBytes)}
                      </span>
                      <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{v.paths.join(' · ')}</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded bg-muted">
                      <div
                        className={cn('h-full', pct > 95 ? 'bg-destructive' : 'bg-primary')}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Library</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {folders.map((f) => {
                  const key = folderKey(f)
                  return (
                    <li key={key} className="px-4 py-2.5">
                      <label className="flex items-center gap-3 text-sm">
                        <input type="checkbox" className={checkbox} checked={selFolders.has(key)} onChange={() => toggleFolder(f)} />
                        <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                        <span className="hidden w-16 text-xs text-muted-foreground sm:inline">{f.section}</span>
                        <span className="hidden w-48 truncate sm:inline">
                          <CatalogCell c={f.catalog} />
                        </span>
                        <span className="w-20 text-right tabular-nums">{formatBytes(f.bytes)}</span>
                      </label>
                      {f.torrents.map((h) => {
                        const t = torrentByHash.get(h)
                        if (!t) return null
                        return (
                          <label key={h} className="mt-1.5 ml-7 flex items-center gap-3 text-xs text-muted-foreground">
                            <input type="checkbox" className={checkbox} checked={selTorrents.has(h)} onChange={() => toggleTorrent(h)} />
                            <span className="min-w-0 flex-1 truncate">{t.name}</span>
                            <span className="hidden w-28 truncate sm:inline">{t.category}</span>
                            <span className="w-20 text-right tabular-nums">{formatBytes(t.bytes)}</span>
                          </label>
                        )
                      })}
                    </li>
                  )
                })}
                {folders.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing here</li>}
              </ul>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Downloads not in the library</h2>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {loose.map((t) => (
                  <li key={t.hash} className="px-4 py-2.5">
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" className={checkbox} checked={selTorrents.has(t.hash)} onChange={() => toggleTorrent(t.hash)} />
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="hidden w-28 truncate text-xs text-muted-foreground sm:inline">{t.category}</span>
                      <span className="hidden w-32 truncate text-xs text-muted-foreground md:inline">{torrentState(t)}</span>
                      <span className="hidden w-48 truncate sm:inline">
                        <CatalogCell c={t.catalog} />
                      </span>
                      <span className="w-20 text-right tabular-nums">{formatBytes(t.bytes)}</span>
                    </label>
                  </li>
                ))}
                {loose.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing here</li>}
              </ul>
            </section>
          </>
        ) : null}
      </main>

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:left-56 md:px-6">
          <span className="flex-1 text-sm">
            {count} selected · frees ≈ <span className="font-medium">{formatBytes(freed)}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => { setSelFolders(new Set()); setSelTorrents(new Set()) }}>
            Clear
          </Button>
          <Button size="sm" variant="destructive" className="gap-1" onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={(o) => !deleting && setConfirming(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete {count} item(s)?</DialogTitle>
            <DialogDescription>
              Files are removed from disk and cannot be recovered. Frees ≈ {formatBytes(freed)}.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 overflow-y-auto text-sm">
            {[...selFolders].map((k) => (
              <li key={k} className="flex items-center gap-2 truncate"><Folder className="size-3.5 shrink-0" />{k}</li>
            ))}
            {[...selTorrents].map((h) => (
              <li key={h} className="flex items-center gap-2 truncate text-muted-foreground"><Download className="size-3.5 shrink-0" />{torrentByHash.get(h)?.name ?? h}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={deleting} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void runDelete()}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
