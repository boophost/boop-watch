import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  MediaPlayer, MediaProvider, canFullscreen, isHLSProvider, isVideoProvider,
  type MediaPlayerInstance, type MediaProviderAdapter,
} from '@vidstack/react'
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default'
import HLS from 'hls.js'
import { Icon, type IconName } from '@/components/Icon'
import { Comments } from '@/components/Comments'
import { EpisodeStatus } from '@/components/EpisodeStatus'
import { SearchBar } from '@/components/SearchBar'
import { UserCrumb, Sidebar, MobileNav, useSidebarCollapsed } from '@/components/PortalLayout'
import { useAuth } from '@/lib/AuthContext'
import { getWatch, getThemes, type Segment, type WatchData, type ThemeSong } from '@/lib/api'
import {
  loadProgressMap, localProgress, saveLocalProgress, saveAccountProgress, backfillAccountProgress,
  type Progress,
} from '@/lib/progress'
import { presenceBeat, presenceStop } from '@/lib/presence'
import { track } from '@/lib/analytics'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'

// The player page reuses the portal's side nav (Kagura-scoped, so it composes
// with the .player styles already on the root). The topbar spans the full
// viewport width above the nav; .shell-body puts the nav beside a .shell-main
// column holding the subbar/player. Theater + pseudo-fullscreen still fill the
// viewport (their .col-video is position:fixed).
function PlayerShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  return (
    <div className="kagura player shell" data-collapsed={collapsed}>
      <PlayerTopbar />
      <div className="shell-body">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        <div className="shell-main">{children}</div>
      </div>
      <MobileNav />
    </div>
  )
}

// Main player header: brand · centered search · account crumb. The brand lives
// here now (the side nav is links-only). The series back-link + episode title
// live in the .subbar row below it.
function PlayerTopbar() {
  return (
    <header className="topbar">
      <Link className="brand" to="/">
        <span className="brand-mark">B</span>
        <span className="label">boopurnoes <span className="sub">· watch</span></span>
      </Link>
      <SearchBar />
      <UserCrumb />
    </header>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { JASSUB?: any }
}

const JASSUB_CDN = 'https://cdn.jsdelivr.net/npm/jassub@1.8.8/dist/'
const JASSUB_SRC = JASSUB_CDN + 'jassub.umd.js'

// JASSUB does `new Worker(workerUrl)` directly, but a classic Worker can't be
// constructed from a cross-origin (CDN) script URL — the browser throws a
// SecurityError and subtitles silently never render. Wrap the CDN worker in a
// same-origin blob that importScripts() it (cross-origin importScripts is allowed
// since jsdelivr serves permissive CORS); the wasm is fetched from its absolute
// URL by the worker, so no relative-path resolution is needed.
let jassubWorkerUrl: string | null = null
function jassubWorker(): string {
  return (jassubWorkerUrl ??= URL.createObjectURL(
    new Blob([`importScripts(${JSON.stringify(JASSUB_CDN + 'jassub-worker.js')})`], { type: 'text/javascript' }),
  ))
}

const scriptCache: Record<string, Promise<void>> = {}
function loadScript(src: string): Promise<void> {
  return (scriptCache[src] ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  }))
}

// ── localStorage helpers (playback preferences) ──
// No element-fullscreen API (iPhone): fullscreen/PiP go through the *native*
// video player, which presents the bare <video> layer — a DOM subtitle overlay
// (JASSUB) can never follow it there. On these devices the selected subtitle is
// burned into the transcode instead (?sub= on the stream URL; Jellyfin encodes
// with libass, so styling matches). Costs a transcode restart on sub toggle,
// which the pendingSeek restore already handles.
const BURN_IN_SUBS = !canFullscreen()

const PREF_KEY = 'bw:pref'
type Pref = { audioLang?: string; quality?: string; subGroup?: string }
const readPref = (): Pref => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') } catch { return {} } }
const savePref = (patch: Pref) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPref(), ...patch })) } catch { /* ignore */ } }

export default function Watch() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const isAdmin = user?.isAdmin ?? false

  const [data, setData] = useState<WatchData | null>(null)
  // Watch progress for this series' episodes (account rows when logged in,
  // local otherwise); drives the episode-list bars and the resume position.
  const [progMap, setProgMap] = useState<Record<string, Progress>>({})
  const [error, setError] = useState('')
  const [subsReady, setSubsReady] = useState(false) // JASSUB library loaded
  const [theater, setTheater] = useState(false)
  // Pseudo-fullscreen (CSS viewport fill): last-resort fallback for devices with
  // no element-fullscreen API where the native video fullscreen call also fails.
  // On iPhone the fullscreen button normally goes native instead (see below) —
  // CSS can't hide the browser URL bar or keep iOS's swipe-home pop-out working.
  const [pseudoFs, setPseudoFs] = useState(false)
  // Gate the source URL until audio/quality are initialised from the response, so
  // the player loads once with the final selection instead of reloading the
  // transcode (which loses the resume position).
  const [selReady, setSelReady] = useState(false)
  // The underlying <video> element, captured from the provider for JASSUB.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  // The intro/outro segment the playhead is currently inside (drives the skip button).
  const [activeSeg, setActiveSeg] = useState<Segment | null>(null)
  const [showNext, setShowNext] = useState(false)
  // Media duration, needed to place the segment marks on the timeline.
  const [duration, setDuration] = useState(0)

  // selections
  const [audioIndex, setAudioIndex] = useState<string | null>(null)
  const [subIndex, setSubIndex] = useState<string>('') // '' = off
  const [qKey, setQKey] = useState<string>('auto')

  const playerRef = useRef<MediaPlayerInstance | null>(null)
  const subRef = useRef<any>(null)
  const firstLoad = useRef(true)
  // Position + play-state to restore after a transcode reload (audio/quality switch).
  const pendingSeek = useRef<{ time: number; play: boolean } | null>(null)
  // Resume point from saved progress (account or local), applied on first canplay.
  const resumePos = useRef<number | null>(null)
  const epsListRef = useRef<HTMLDivElement>(null)

  // Load the subtitle library (JASSUB) once. A CDN hiccup is non-fatal: the
  // player and page chrome still work; only subtitle rendering waits. Skipped
  // where subs are burned in — JASSUB is never used there.
  useEffect(() => {
    if (BURN_IN_SUBS) return
    let alive = true
    loadScript(JASSUB_SRC)
      .then(() => { if (alive) setSubsReady(true) })
      .catch(() => { if (alive) console.warn('subtitle library failed to load') })
    return () => { alive = false }
  }, [])

  // Fetch metadata when the episode changes.
  useEffect(() => {
    setData(null); setError(''); setSelReady(false); setActiveSeg(null); setDuration(0); setShowNext(false)
    firstLoad.current = true
    pendingSeek.current = null
    resumePos.current = null
    getWatch(id).then(setData).catch((e: Error) => setError(e.message))
  }, [id])

  // Load progress for this episode + its siblings (episode-list bars and the
  // resume point). Waits for auth so a logged-in reload reads account rows.
  useEffect(() => {
    if (!data || authLoading) return
    let alive = true
    const ids = [data.id, ...data.episodes.map((e) => e.id)]
    if (user) {
      backfillAccountProgress(user.id)
    }
    loadProgressMap(ids, !!user).then((m) => {
      if (!alive) return
      setProgMap(m)
      const cur = m[data.id]
      if (cur && !cur.watched && cur.position > 5) resumePos.current = cur.position
    })
    return () => { alive = false }
  }, [data, user, authLoading])

  // Initialise selections from the response + saved preferences.
  useEffect(() => {
    if (!data) return
    const pref = readPref()
    let audio = data.audio.default == null ? null : String(data.audio.default)
    if (pref.audioLang) {
      const m = data.audio.tracks.find((t) => t.lang === pref.audioLang)
      if (m) audio = String(m.index)
    }
    setAudioIndex(audio)
    setQKey(pref.quality && data.quality.some((q) => q.key === pref.quality) ? pref.quality : 'auto')
    let sub = ''
    if (pref.subGroup && pref.subGroup !== 'off' && data.subs.length) {
      const m = data.subs.find((s) => s.group === pref.subGroup) || data.subs[0]
      if (m) sub = String(m.index)
    }
    setSubIndex(sub)
    setSelReady(true)
  }, [data])

  // Center the playing episode in the list, once per episode. Scrolls only the
  // list element — scrollIntoView also scrolls the page, and the progress bar
  // re-render made that fire every few seconds (dragging mobile down the page).
  useEffect(() => {
    if (!data) return
    const list = epsListRef.current
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (list && row) {
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top
        - (list.clientHeight - row.clientHeight) / 2
    }
  }, [data])

  const quality = useMemo(() => data?.quality.find((q) => q.key === qKey) || { h: 0, vb: 0, key: 'auto', label: 'Auto' }, [data, qKey])

  // The HLS source. Audio + quality are muxed into the transcode (and on burn-in
  // devices the subtitle track too), so changing them changes the URL and
  // Vidstack reloads; position is restored on canplay.
  const src = useMemo(() => {
    if (!data || !selReady) return ''
    const params = new URLSearchParams()
    if (audioIndex != null && audioIndex !== '') params.set('audio', audioIndex)
    if (quality.h) params.set('h', String(quality.h))
    if (quality.vb) params.set('vb', String(quality.vb))
    if (BURN_IN_SUBS && subIndex !== '') params.set('sub', subIndex)
    const qs = params.toString()
    return `/api/play/${encodeURIComponent(data.id)}/master.m3u8${qs ? `?${qs}` : ''}`
  }, [data, selReady, audioIndex, quality, subIndex])

  // Use our bundled hls.js (not Vidstack's CDN default) and grab the real <video>
  // element so JASSUB can render the ASS overlay onto it.
  const onProviderChange = (provider: MediaProviderAdapter | null) => {
    if (isHLSProvider(provider)) {
      provider.library = HLS
      provider.config = { enableWorker: true }
      setVideoEl(provider.video)
    } else if (isVideoProvider(provider)) {
      setVideoEl(provider.video) // Safari native HLS fallback
    }
  }

  // First load seeks the saved resume point; later loads (audio/quality switch)
  // restore the position + play-state captured before the source changed.
  const onCanPlay = () => {
    const p = playerRef.current
    if (!p || !data) return
    if (Number.isFinite(p.duration) && p.duration > 0) setDuration((d) => d || p.duration)
    if (firstLoad.current) {
      firstLoad.current = false
      // Account/local progress when it loaded in time, else the sync local view
      // (the HLS transcode start usually outlasts the progress fetch).
      const n = resumePos.current ?? (() => {
        const l = localProgress(data.id)
        return l && !l.watched && l.position > 5 ? l.position : null
      })()
      if (n != null && n > 5) p.currentTime = n
    } else if (pendingSeek.current) {
      const { time, play } = pendingSeek.current
      pendingSeek.current = null
      if (time > 0) p.currentTime = time
      if (play) p.play().catch(() => {})
    }
  }

  // Surface a skip button while the playhead sits inside an intro/outro segment.
  const onTimeUpdate = () => {
    const p = playerRef.current
    if (!p) return
    const d = p.duration
    if (Number.isFinite(d) && d > 0) setDuration((prev) => prev || d)
    const t = p.currentTime
    
    let seg: Segment | null = null
    if (data?.segments?.length) {
      seg = data.segments.find((s) => t >= s.start && t < s.end - 1) || null
    }
    setActiveSeg((prev) => (prev?.type === seg?.type && prev?.start === seg?.start ? prev : seg))
    
    const isOutro = seg?.type === 'outro'
    const isNearEnd = Number.isFinite(d) && d > 0 && d - t <= 60
    setShowNext(isOutro || isNearEnd)
  }

  const skip = () => {
    const p = playerRef.current
    if (p && activeSeg) { p.currentTime = activeSeg.end; setActiveSeg(null) }
  }

  // Mark the current episode fully finished (position = duration), then optionally
  // advance. Used by both Next controls and onEnded — must write the complete
  // marker *before* navigate, because the progress-effect cleanup would otherwise
  // flush the mid-episode playhead and clear watched.
  const markComplete = async (nextId: string | null) => {
    if (!data) return
    const p = playerRef.current
    const d = (p && Number.isFinite(p.duration) && p.duration > 0)
      ? p.duration
      : duration
    const prog: Progress = { position: d, duration: d, watched: true }
    saveLocalProgress(data.id, prog)
    setProgMap((m) => ({ ...m, [data.id]: prog }))
    if (user) {
      try { await saveAccountProgress(user.id, data.id, prog) } catch { /* local still set */ }
    }
    if (nextId) navigate(`/watch/${nextId}`)
  }

  const goNext = () => {
    if (!data?.nextId) return
    void markComplete(data.nextId)
  }

  // Intro/outro marks on the timeline: a gradient with a stop pair per segment,
  // painted over the seek bar by kagura.css (.vds-time-slider::after).
  const segMarksStyle = useMemo(() => {
    if (!data?.segments.length || !duration) return undefined
    const stops = [...data.segments]
      .sort((a, b) => a.start - b.start)
      .flatMap((s) => {
        const a = Math.min(100, Math.max(0, (s.start / duration) * 100)).toFixed(2)
        const b = Math.min(100, Math.max(0, (s.end / duration) * 100)).toFixed(2)
        if (Number(b) <= Number(a)) return []
        return [`transparent ${a}%`, `var(--accent-deep) ${a}%`, `var(--accent-deep) ${b}%`, `transparent ${b}%`]
      })
    if (!stops.length) return undefined
    return { '--seg-marks': `linear-gradient(to right, ${stops.join(', ')})` }
  }, [data, duration])

  // Capture position + play-state before an audio/quality switch reloads the
  // transcode, so onCanPlay can restore them.
  const captureSeek = () => {
    const p = playerRef.current
    pendingSeek.current = p ? { time: p.currentTime, play: !p.paused } : null
  }

  // Auto-advance when the episode ends.
  const onEnded = () => {
    if (!data) return
    void markComplete(data.nextId)
  }

  // Client-side subtitles (JASSUB overlay) — independent of the transcode.
  // Burn-in devices never reach this: their subs are in the video itself.
  useEffect(() => {
    if (BURN_IN_SUBS || !data || !subsReady || !videoEl) return
    if (subIndex === '') {
      if (subRef.current) { subRef.current.destroy(); subRef.current = null }
      return
    }
    // Absolute URL: JASSUB fetches this from inside the (blob:) worker, where a
    // root-relative path has no resolvable base and throws "Invalid URL".
    const url = `${location.origin}/api/sub/${encodeURIComponent(data.id)}/${encodeURIComponent(subIndex)}`
    if (subRef.current) {
      subRef.current.setTrackByUrl(url)
    } else if (window.JASSUB) {
      subRef.current = new window.JASSUB({
        video: videoEl,
        subUrl: url,
        workerUrl: jassubWorker(),
        wasmUrl: JASSUB_CDN + 'jassub-worker.wasm',
        legacyWasmUrl: JASSUB_CDN + 'jassub-worker.wasm.js',
        // The fallback font default ('./default.woff2') is relative; inside a blob
        // worker it has no valid base, so point it at the CDN. Our subs name fonts
        // that aren't embedded (e.g. "Cronos Pro") and fall back to this. Liberation
        // Sans is Latin-only, so Japanese-only sub tracks (common here — JP audio,
        // JP-only subs) rendered as tofu boxes. Ship a full-coverage Noto Sans JP
        // (also covers Latin) as the fallback so CJK glyphs resolve.
        availableFonts: {
          'liberation sans': JASSUB_CDN + 'default.woff2',
          'noto sans jp': `${location.origin}/fonts/NotoSansJP-Regular.woff2`,
        },
        fallbackFont: 'noto sans jp',
      })
    }
  }, [data, subsReady, subIndex, videoEl])

  // Persist progress: locally every tick (resume), to the account on a longer
  // cadence + flush points (tab hide, unmount, near-end), and into progMap so
  // the episode list's bar tracks the playhead. Past the -15s mark it counts
  // as watched. Never downgrade a completed mark — Next/onEnded write
  // watched:true with position=duration, and the unmount flush would otherwise
  // overwrite that with the mid-episode playhead.
  useEffect(() => {
    if (!data) return
    let lastPush = 0
    const savePos = (flush = false) => {
      if (localProgress(data.id)?.watched) return
      const p = playerRef.current
      if (!p) return
      const d = p.duration
      if (!d || isNaN(d)) return
      const t = p.currentTime || 0
      if (t <= 5) return
      const prog: Progress = { position: t, duration: d, watched: t >= d - 15 }
      saveLocalProgress(data.id, prog)
      setProgMap((m) => ({ ...m, [data.id]: prog }))
      const now = Date.now()
      if (user && (flush || prog.watched || now - lastPush >= 15000)) {
        lastPush = now
        saveAccountProgress(user.id, data.id, prog).catch(() => {})
      }
    }
    const iv = setInterval(() => savePos(), 5000)
    const onHide = () => savePos(true)
    const onVis = () => { if (document.hidden) savePos(true) }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(iv)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVis)
      savePos(true)
    }
  }, [data, user])

  // Discord watch status: logged-in users who opted in on the profile page get
  // a "Watching …" activity while playing. The server throttles the actual
  // Discord traffic, so this just ticks every 30s and reports play/pause edges
  // promptly. Stopping lives in a separate unmount-only effect: on episode
  // change the next beat *updates* the session in place instead (no flicker,
  // and no stop/beat ordering race).
  const presenceRef = useRef<(paused?: boolean) => void>(() => {})
  const playbackTracked = useRef(false)

  useEffect(() => {
    playbackTracked.current = false
  }, [id])
  useEffect(() => {
    if (!data || !user) {
      presenceRef.current = () => {}
      return
    }
    const send = (pausedOverride?: boolean) => {
      const p = playerRef.current
      if (!p) return
      const d = p.duration
      if (!d || isNaN(d)) return
      presenceBeat(data.id, p.currentTime || 0, d, pausedOverride ?? p.paused).catch(() => {})
    }
    presenceRef.current = send
    // Beat regardless of play/pause state (send() reports the real paused
    // flag) so the paused "⏸ Paused" activity stays alive within its TTL.
    const t0 = setTimeout(() => { if (playerRef.current) send() }, 4000)
    const iv = setInterval(() => { if (playerRef.current) send() }, 30000)
    return () => {
      clearTimeout(t0)
      clearInterval(iv)
      presenceRef.current = () => {}
    }
  }, [data, user])

  useEffect(() => {
    const onHide = () => { presenceStop() }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      presenceStop()
    }
  }, [])

  // Theater + pseudo-fullscreen reflect onto <body> (CSS targets body.theater /
  // body.fs; pseudo-fullscreen is the theater layout plus a hidden control bar).
  useEffect(() => {
    document.body.classList.toggle('theater', theater || pseudoFs)
    document.body.classList.toggle('fs', pseudoFs)
    return () => { document.body.classList.remove('theater', 'fs') }
  }, [theater, pseudoFs])

  // Where element fullscreen doesn't exist (iPhone), catch Vidstack's fullscreen
  // request before its own handler runs (capture phase on document; the handler
  // bails on defaultPrevented) and present the *native* video fullscreen player.
  // Only the native layer hides the browser URL bar, and it's what iOS pops into
  // picture-in-picture when the user swipes home mid-play. It presents the bare
  // <video> — fine here, because on these devices the subtitle track is burned
  // into the stream (BURN_IN_SUBS). If the native call fails (metadata not
  // ready), fall back to pseudo-fullscreen; Vidstack's fullscreen state never
  // turns on, so every button press dispatches an *enter* request — hence toggle.
  useEffect(() => {
    if (canFullscreen()) return
    const onRequest = (e: Event) => {
      e.preventDefault()
      const v = videoEl as (HTMLVideoElement & {
        webkitSupportsFullscreen?: boolean; webkitEnterFullscreen?: () => void
      }) | null
      if (v?.webkitSupportsFullscreen && v.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); return } catch { /* not ready — fall through */ }
      }
      setPseudoFs((s) => !s)
    }
    document.addEventListener('media-enter-fullscreen-request', onRequest, true)
    return () => document.removeEventListener('media-enter-fullscreen-request', onRequest, true)
  }, [videoEl])

  // Opt the inline video into iOS auto-PiP: leaving the browser while playing
  // pops the video out instead of pausing it (Safari honors this per element).
  useEffect(() => {
    if (videoEl) (videoEl as HTMLVideoElement & { autoPictureInPicture?: boolean }).autoPictureInPicture = true
  }, [videoEl])

  // Keyboard: 't' toggles theater, Esc exits (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const tag = el && el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return
      if (e.key === 'Escape') { setTheater(false); setPseudoFs(false) }
      else if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setTheater((t) => !t) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Close any open control menu when clicking elsewhere.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      document.querySelectorAll('details.pmenu[open]').forEach((m) => {
        if (!m.contains(e.target as Node)) m.removeAttribute('open')
      })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Tear down JASSUB on unmount (Vidstack disposes itself).
  useEffect(() => () => {
    if (subRef.current) { subRef.current.destroy(); subRef.current = null }
  }, [])

  if (error) {
    return <PlayerShell><div className="subbar"><Link className="back" to="/"><Icon name="back" size={15} /><span className="bl">All titles</span></Link></div><p style={{ padding: 20 }}>{error}</p></PlayerShell>
  }
  if (!data) {
    // Skeleton with the final page geometry — the .vid box reserves its 16/9
    // slot (kagura.css), so the player mounting never reflows the layout.
    return (
      <PlayerShell>
        <div className="subbar"><span className="t">Loading…</span></div>
        <div className="wrap">
          <div className="col-video">
            <div className="vid vid-loading" />
            <div className="pbar">
              <span className="skel-pill" />
              <div className="spacer" />
              <span className="skel-pill" />
              <span className="skel-pill" />
            </div>
          </div>
          <aside className="col-eps panel">
            <div className="eps-head"><Icon name="tv" size={15} /><span>Episodes</span></div>
            <div className="eps-list">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="eprow">
                  <span className="epn"><span className="skel-box" style={{ width: 38 }} /></span>
                  <span className="ept"><span className="skel-box" style={{ width: `${55 + ((i * 17) % 35)}%` }} /></span>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </PlayerShell>
    )
  }

  const closeMenu = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')

  // The next-episode chase stub belongs to the current episode's season (the
  // sidebar list is season-scoped), so number it "S1·E3" like its siblings —
  // bare "E3" only when the season isn't known (epNum empty).
  const seasonPrefix = /^S\d+/.exec(data.epNum)?.[0]
  const stubNum = (n: number) => (seasonPrefix ? `${seasonPrefix}·E${n}` : `E${n}`)

  const audioLabel = data.audio.tracks.find((t) => String(t.index) === audioIndex)?.label || 'Audio'
  const subLabel = subIndex === '' ? 'Off' : (data.subs.find((s) => String(s.index) === subIndex)?.group || 'English')
  const qualityLabel = data.quality.find((q) => q.key === qKey)?.label || 'Auto'

  return (
    <PlayerShell>
      <div className="subbar">
        <Link className="back" to={data.back.href}><Icon name="back" size={15} /><span className="bl">{data.back.label}</span></Link>
        {data.epNum && <span className="ep">{data.epNum}</span>}
        <span className="t">{data.title}</span>
        {isAdmin && data.manageId != null && (
          <Link className="manage-link" to={`/manage/series/${data.manageId}`} title="Library settings">
            <Icon name="gear" size={15} />
            <span className="bl">Library</span>
          </Link>
        )}
      </div>

      <div className={`wrap${data.episodes.length ? '' : ' no-eps'}`}>
        <div className="col-main">
        <div className="col-video">
          <div className="vid">
            {src && (
              <MediaPlayer
                ref={playerRef}
                className="vds-player"
                title={data.title}
                src={{ src, type: 'application/x-mpegurl' }}
                style={segMarksStyle}
                aspectRatio="16/9"
                autoPlay
                playsInline
                onProviderChange={onProviderChange}
                onCanPlay={onCanPlay}
                onTimeUpdate={onTimeUpdate}
                onEnded={onEnded}
                onPlay={() => {
                  presenceRef.current(false)
                  if (!playbackTracked.current && data) {
                    playbackTracked.current = true
                    track('playback_started', {
                      item_id: data.id,
                      auth_state: user ? 'authenticated' : 'anonymous',
                    })
                  }
                }}
                onPause={() => presenceRef.current(true)}
              >
                <MediaProvider />
                <DefaultVideoLayout icons={defaultLayoutIcons} />
                <div className="vds-overlay-btns">
                  {activeSeg && (
                    <button type="button" className="skip-btn" onClick={skip}>
                      Skip {activeSeg.type === 'intro' ? 'Intro' : 'Outro'} <Icon name="next" size={15} />
                    </button>
                  )}
                  {showNext && data.nextId && (
                    <button type="button" className="skip-btn" onClick={goNext}>
                      Next Episode <Icon name="next" size={15} />
                    </button>
                  )}
                </div>
              </MediaPlayer>
            )}
          </div>
          <div className="pbar">
            {data.nextId && (
              <button type="button" className="pctl" title="Next episode" onClick={goNext}>
                <Icon name="next" size={16} /><span>Next</span>
              </button>
            )}
            <div className="spacer" />

            {data.audio.tracks.length > 1 && (
              <Menu kind="audio" icon="audio" title="Audio" label={audioLabel}>
                {data.audio.tracks.map((t) => (
                  <PopItem key={t.index} active={String(t.index) === audioIndex} label={t.label} detail={t.detail}
                    onClick={(e) => { closeMenu(e); captureSeek(); setAudioIndex(String(t.index)); savePref({ audioLang: t.lang || '' }) }} />
                ))}
              </Menu>
            )}

            {data.subs.length > 0 && (
              <Menu kind="subs" icon="captions" title="Subtitles" label={`Subtitles: ${subLabel}`}>
                <PopItem active={subIndex === ''} label="Off"
                  onClick={(e) => { closeMenu(e); if (BURN_IN_SUBS) captureSeek(); setSubIndex(''); savePref({ subGroup: 'off' }) }} />
                {data.subs.map((s, i) => (
                  <PopItem key={s.index} active={String(s.index) === subIndex} label="English"
                    detail={s.group || (data.subs.length > 1 ? `Track ${i + 1}` : 'Full')}
                    onClick={(e) => { closeMenu(e); if (BURN_IN_SUBS) captureSeek(); setSubIndex(String(s.index)); savePref({ subGroup: s.group || 'on' }) }} />
                ))}
              </Menu>
            )}

            <Menu kind="quality" icon="gear" title="Quality" label={qualityLabel}>
              {data.quality.map((q) => (
                <PopItem key={q.key} active={q.key === qKey} label={q.label}
                  onClick={(e) => { closeMenu(e); captureSeek(); setQKey(q.key); savePref({ quality: q.key }) }} />
              ))}
            </Menu>

            <button type="button" className="pctl" onClick={() => setTheater((t) => !t)}>
              <Icon name={theater ? 'shrink' : 'theater'} size={16} /><span>{theater ? 'Exit theater' : 'Theater'}</span>
            </button>
          </div>
        </div>
        <Comments itemId={data.id} />
        </div>

        <div className="col-side">
        {data.episodes.length > 0 && (
          <aside className="col-eps panel">
            <div className="eps-head"><Icon name="tv" size={15} /><span>Episodes</span><span className="badge">{data.episodes.length}</span></div>
            <div className="eps-list" ref={epsListRef}>
              {data.episodes.map((ep) => {
                const prog = progMap[ep.id]
                const watched = !!prog?.watched
                const pct = watched ? 100
                  : prog && prog.duration > 0 ? Math.min(100, (prog.position / prog.duration) * 100) : 0
                return (
                  <Link
                    key={ep.id}
                    className={`eprow${ep.current ? ' current' : ''}${!ep.current && watched ? ' watched' : ''}`}
                    to={`/watch/${ep.id}`}
                    aria-current={ep.current ? 'true' : undefined}
                  >
                    <span className="epn">{ep.num}</span>
                    <span className="ept">{ep.name}</span>
                    {ep.current && <span className="epnow"><Icon name="play" size={12} fill="currentColor" /></span>}
                    {pct > 0 && <span className="epprog" style={{ width: `${pct.toFixed(1)}%` }} />}
                  </Link>
                )
              })}
              {data.nextEpisode ? (
                <div className="eprow chasing">
                  <span className="epn">{stubNum(data.nextEpisode.episode)}</span>
                  <span className="ept">{data.nextEpisode.title || `Episode ${data.nextEpisode.episode}`}</span>
                  <span className="epnow">
                    <EpisodeStatus chase={data.nextEpisode} />
                  </span>
                </div>
              ) : null}
            </div>
          </aside>
        )}
        {data.episodes.length === 0 && data.nextEpisode ? (
          <aside className="col-eps panel">
            <div className="eps-head"><Icon name="tv" size={15} /><span>Episodes</span></div>
            <div className="eps-list">
              <div className="eprow chasing">
                <span className="epn">{stubNum(data.nextEpisode.episode)}</span>
                <span className="ept">{data.nextEpisode.title || `Episode ${data.nextEpisode.episode}`}</span>
                <span className="epnow"><EpisodeStatus chase={data.nextEpisode} /></span>
              </div>
            </div>
          </aside>
        ) : null}

        <OstPanel titleId={data.seriesId ?? data.id} season={data.season} />
        </div>
      </div>
    </PlayerShell>
  )
}

// OST rail under the episode list — fully self-sourcing: the server pulls
// MAL's OP/ED themes for this season's cour(s) and iTunes cover art, so
// nothing renders until it has something real.
function OstPanel({ titleId, season }: { titleId: string; season: number | null }) {
  const [themes, setThemes] = useState<ThemeSong[]>([])

  useEffect(() => {
    let cancelled = false
    setThemes([])
    getThemes(titleId, season)
      .then((r) => { if (!cancelled) setThemes(r.themes) })
      .catch(() => { /* cosmetic — the rail just stays hidden */ })
    return () => { cancelled = true }
  }, [titleId, season])

  if (themes.length === 0) return null
  return (
    <aside className="col-ost panel">
      <div className="eps-head"><Icon name="music" size={15} /><span>OST</span><span className="badge">{themes.length}</span></div>
      <div className="ost-list">
        {themes.map((t, i) => (
          <div key={`${t.kind}${i}`} className="ostrow">
            <span className="ost-art">
              <Icon name="music" size={16} />
              {t.art && (
                <img src={t.art} alt="" loading="lazy"
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />
              )}
            </span>
            <span className="ost-main">
              <span className="ost-title">{t.title}</span>
              {t.artist && <span className="ost-artist">{t.artist}</span>}
            </span>
            <span className="ost-meta">
              <span className="ost-kind">{t.kind.toUpperCase()}{t.index ?? ''}</span>
              {t.episodes && <span className="ost-eps">{t.episodes}</span>}
            </span>
          </div>
        ))}
      </div>
    </aside>
  )
}

function Menu({ kind, icon, title, label, children }: { kind: string; icon: IconName; title: string; label: string; children: React.ReactNode }) {
  return (
    <details className="pmenu" data-kind={kind}>
      <summary><Icon name={icon} size={16} /><span className="pmlabel">{label}</span><Icon name="chevron" size={14} /></summary>
      <div className="pop" role="listbox">
        <div className="pop-head">{title}</div>
        {children}
      </div>
    </details>
  )
}

function PopItem({ active, label, detail, onClick }: { active: boolean; label: string; detail?: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" className="popitem" role="option" data-active={active} aria-selected={active} onClick={onClick}>
      <span className="pi-main">{label}</span>
      {detail && <span className="pi-detail">{detail}</span>}
    </button>
  )
}
