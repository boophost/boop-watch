import { useState } from 'react'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatAired, formatBytes, relTime } from '@/lib/format'
import {
  ISSUE_DISPLAY, STAGE_DISPLAY,
  type EpisodeStatus,
} from '@/lib/seriesStatus'

/**
 * One episode, everywhere.
 *
 * The page used to carry two separate implementations of this — a desktop
 * `<table>` and a mobile card list — and they had already drifted: mobile
 * silently dropped the Filler/Recap badges and the download progress bar. This
 * is one component with responsive classes so they cannot diverge again.
 *
 * Collapsed it answers "where is this episode?"; expanded it answers "why?".
 * That split is deliberate — the day-to-day job is scanning a season, not
 * reading five ledgers, so the diagnostic depth is one click away rather than
 * spread across the default view.
 */

function MediaSummary({ m, outlier }: { m: EpisodeStatus['media']; outlier: boolean }) {
  if (!m) return <span className="text-muted-foreground">—</span>
  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
        {m.resolution ? <span className="font-medium text-foreground">{m.resolution}</span> : null}
        {m.videoCodec ? <span>{m.videoCodec}</span> : null}
        {m.sizeBytes ? <span>· {formatBytes(m.sizeBytes)}</span> : null}
      </div>
      {m.audio.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {m.audio.map((a, i) => (
            <Badge key={`${a.lang}-${i}`} shape="tag" tone="muted" title={`${a.label} ${a.codec} ${a.channels}`}>
              {a.lang}
            </Badge>
          ))}
          {/* The reason this marker exists: two episodes of Re:Zero lacked an
              English dub and nothing said so — you had to read every row's
              language pills and notice two were short. */}
          {outlier ? <Badge shape="tag" tone="warn">audio differs</Badge> : null}
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words text-xs">{children}</div>
    </div>
  )
}

export function EpisodeRow({
  ep,
  malUrl,
  onWantAction,
  onRemoveTorrent,
  onBlacklist,
}: {
  ep: EpisodeStatus
  malUrl?: string | null
  onWantAction?: (wantId: number, action: 'retry-now' | 'abandon') => void
  onRemoveTorrent?: (hash: string, deleteFiles: boolean) => void
  onBlacklist?: (hash: string) => void
}) {
  const [open, setOpen] = useState(false)
  const stage = STAGE_DISPLAY[ep.stage]
  const Chevron = open ? ChevronDown : ChevronRight
  const outlier = ep.issues.some((i) => i.code === 'audio-outlier')
  const downloading = ep.torrent?.progress != null && ep.torrent.progress < 1

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 md:flex-nowrap md:items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide details' : 'Show details'}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground md:mt-0"
        >
          <Chevron className="size-4" />
        </button>

        <span className="w-8 shrink-0 tabular-nums text-sm text-muted-foreground">{ep.episode}</span>

        <div className="min-w-0 flex-1 basis-full md:basis-auto">
          <div className="truncate text-sm">
            {ep.title ?? <span className="text-muted-foreground">Untitled</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground md:hidden">{formatAired(ep.airedAt)}</div>
        </div>

        <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block">
          {formatAired(ep.airedAt)}
        </span>

        <div className="flex w-auto shrink-0 flex-wrap items-center gap-1 md:w-44">
          <Badge tone={stage.tone} title={stage.hint}>{stage.label}</Badge>
          {ep.issues.length > 0 ? (
            <span
              className="size-1.5 rounded-full bg-amber-400"
              title={ep.issues.map((i) => i.detail).join('\n')}
              aria-label={`${ep.issues.length} issue(s)`}
            />
          ) : null}
          {downloading ? (
            <span className="tabular-nums text-[10px] text-sky-400">
              {Math.round((ep.torrent!.progress ?? 0) * 100)}%
            </span>
          ) : null}
        </div>

        <div className="w-full min-w-0 md:w-52">
          <MediaSummary m={ep.media} outlier={outlier} />
        </div>

        <div className="shrink-0">
          {ep.portal ? (
            <a
              href={`/watch/${ep.portal.itemId}`}
              className="inline-flex items-center gap-1 text-xs text-emerald-400 underline-offset-4 hover:underline"
            >
              <Play className="size-3" />
              Watch
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {downloading ? (
        <div className="mx-3 mb-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-sky-500"
            style={{ width: `${Math.round((ep.torrent!.progress ?? 0) * 100)}%` }}
          />
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-border bg-muted/20 px-3 py-3">
          {ep.issues.length > 0 ? (
            <ul className="mb-3 space-y-1">
              {ep.issues.map((i) => (
                <li key={i.code} className="flex items-start gap-2 text-xs">
                  <Badge tone={ISSUE_DISPLAY[i.code].tone}>{ISSUE_DISPLAY[i.code].label}</Badge>
                  <span className="text-muted-foreground">{i.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Want">
              {ep.want ? (
                <>
                  <div>
                    {ep.want.status}
                    {ep.want.attempts > 0 ? ` · ${ep.want.attempts} attempt${ep.want.attempts === 1 ? '' : 's'}` : ''}
                  </div>
                  {ep.want.nextAttemptAt ? (
                    <div className="text-muted-foreground">retry {relTime(ep.want.nextAttemptAt)}</div>
                  ) : null}
                  {ep.want.note ? <div className="text-muted-foreground">{ep.want.note}</div> : null}
                  {onWantAction && ep.want.status === 'open' ? (
                    <div className="mt-1.5 flex gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onWantAction(ep.want!.id, 'retry-now')}
                      >
                        Retry now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onWantAction(ep.want!.id, 'abandon')}
                      >
                        Abandon
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Field>

            <Field label="Download">
              {ep.torrent ? (
                <>
                  <div className="break-all">{ep.torrent.name ?? ep.torrent.hash.slice(0, 12)}</div>
                  <div className="text-muted-foreground">
                    {ep.torrent.status}
                    {ep.torrent.liveState ? ` · ${ep.torrent.liveState}` : ' · not in qBittorrent'}
                    {ep.torrent.provider ? ` · ${ep.torrent.provider}` : ''}
                  </div>
                  {ep.torrent.note ? <div className="text-muted-foreground">{ep.torrent.note}</div> : null}
                  {ep.torrent.liveState ? (
                    <div className="mt-1.5 flex gap-1">
                      {onBlacklist ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-amber-400"
                          onClick={() => onBlacklist(ep.torrent!.hash)}
                        >
                          Blacklist &amp; replace
                        </Button>
                      ) : null}
                      {onRemoveTorrent ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-destructive"
                          onClick={() => onRemoveTorrent(ep.torrent!.hash, false)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Field>

            <Field label="Library file">
              {ep.file ? (
                <>
                  <div className="break-all">{ep.file.path}</div>
                  <div className={ep.file.existsOnDisk ? 'text-muted-foreground' : 'text-destructive'}>
                    {ep.file.existsOnDisk ? 'on disk' : 'MISSING from disk'}
                    {ep.file.sizeBytes ? ` · ${formatBytes(ep.file.sizeBytes)}` : ''}
                    {ep.file.method ? ` · ${ep.file.method}` : ''}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Field>

            <Field label="Published">
              <div className="text-muted-foreground">
                Jellyfin: {ep.jellyfin ? 'indexed' : 'not indexed'}
              </div>
              <div className="text-muted-foreground">
                Portal: {ep.portal ? 'on site' : 'not on site'}
              </div>
              {malUrl ? (
                <a
                  href={malUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Episode page
                </a>
              ) : null}
            </Field>
          </div>
        </div>
      ) : null}
    </div>
  )
}
