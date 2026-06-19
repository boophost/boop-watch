import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Icon, type IconName } from '@/components/Icon'
import { getWatch, type WatchData } from '@/lib/api'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { Hls?: any; JASSUB?: any }
}

const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1'
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

// ── localStorage helpers (preferences, watched set, resume position) ──
const PREF_KEY = 'bw:pref'
const WATCHED_KEY = 'bw:watched'
type Pref = { audioLang?: string; quality?: string; subGroup?: string }
const readPref = (): Pref => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') } catch { return {} } }
const savePref = (patch: Pref) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPref(), ...patch })) } catch { /* ignore */ } }
const readWatched = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}') } catch { return {} } }
const markWatched = (id: string) => {
  const w = readWatched()
  if (!w[id]) { w[id] = 1; try { localStorage.setItem(WATCHED_KEY, JSON.stringify(w)) } catch { /* ignore */ } }
}

export default function Watch() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState<WatchData | null>(null)
  const [error, setError] = useState('')
  const [libsReady, setLibsReady] = useState(false)
  const [theater, setTheater] = useState(false)

  // selections
  const [audioIndex, setAudioIndex] = useState<string | null>(null)
  const [subIndex, setSubIndex] = useState<string>('') // '' = off
  const [qKey, setQKey] = useState<string>('auto')

  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<any>(null)
  const subRef = useRef<any>(null)
  const firstLoad = useRef(true)

  // Load the player libraries once. A CDN hiccup is non-fatal: the page chrome
  // (back link, controls, episode list) still renders; only playback waits.
  useEffect(() => {
    let alive = true
    Promise.all([loadScript(HLS_SRC), loadScript(JASSUB_SRC)])
      .then(() => { if (alive) setLibsReady(true) })
      .catch(() => { if (alive) console.warn('player libraries failed to load') })
    return () => { alive = false }
  }, [])

  // Fetch metadata when the episode changes.
  useEffect(() => {
    setData(null); setError('')
    firstLoad.current = true
    getWatch(id).then(setData).catch((e: Error) => setError(e.message))
  }, [id])

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
  }, [data])

  const quality = useMemo(() => data?.quality.find((q) => q.key === qKey) || { h: 0, vb: 0, key: 'auto', label: 'Auto' }, [data, qKey])

  // (Re)load the HLS source. Audio + quality are muxed into the transcode, so
  // changing them reloads; the first load seeks the saved resume point.
  useEffect(() => {
    if (!data || !libsReady) return
    const v = videoRef.current
    if (!v) return
    const Hls = window.Hls

    const params = new URLSearchParams()
    if (audioIndex != null && audioIndex !== '') params.set('audio', audioIndex)
    if (quality.h) params.set('h', String(quality.h))
    if (quality.vb) params.set('vb', String(quality.vb))
    const qs = params.toString()
    const src = `/api/play/${encodeURIComponent(data.id)}/master.m3u8${qs ? `?${qs}` : ''}`

    const initial = firstLoad.current
    firstLoad.current = false
    let resumeAt = 0
    if (initial) {
      const n = parseInt(localStorage.getItem(`bw:pos:${data.id}`) || '', 10)
      resumeAt = Number.isInteger(n) && n > 5 ? n : 0
    }
    const t = initial ? resumeAt : (v.currentTime || 0)
    const wasPlaying = initial ? true : !v.paused
    const restore = () => {
      if (t > 0) { try { v.currentTime = t } catch { /* ignore */ } }
      if (wasPlaying) v.play().catch(() => {})
    }

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true })
      hlsRef.current = hls
      hls.loadSource(src)
      hls.attachMedia(v)
      hls.on(Hls.Events.MANIFEST_PARSED, restore)
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src
      const h2 = () => { v.removeEventListener('loadedmetadata', h2); restore() }
      v.addEventListener('loadedmetadata', h2)
    } else {
      setError('Your browser cannot play HLS.')
    }
  }, [data, libsReady, audioIndex, quality])

  // Client-side subtitles (JASSUB overlay) — independent of the transcode.
  useEffect(() => {
    if (!data || !libsReady) return
    const v = videoRef.current
    if (!v) return
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
        video: v,
        subUrl: url,
        workerUrl: jassubWorker(),
        wasmUrl: JASSUB_CDN + 'jassub-worker.wasm',
        legacyWasmUrl: JASSUB_CDN + 'jassub-worker.wasm.js',
        // The fallback font default ('./default.woff2') is relative; inside a blob
        // worker it has no valid base, so point it at the CDN. Our subs name fonts
        // that aren't embedded (e.g. "Cronos Pro") and fall back to this.
        availableFonts: { 'liberation sans': JASSUB_CDN + 'default.woff2' },
        fallbackFont: 'liberation sans',
      })
    }
  }, [data, libsReady, subIndex])

  // Persist resume position; finish -> mark watched.
  useEffect(() => {
    if (!data) return
    const v = videoRef.current
    if (!v) return
    const POS_KEY = `bw:pos:${data.id}`
    const savePos = () => {
      const d = v.duration
      if (!d || isNaN(d)) return
      const t = v.currentTime || 0
      try {
        if (t > 5 && t < d - 15) localStorage.setItem(POS_KEY, String(Math.floor(t)))
        else { localStorage.removeItem(POS_KEY); if (t >= d - 15) markWatched(data.id) }
      } catch { /* ignore */ }
    }
    const iv = setInterval(savePos, 5000)
    const onHide = () => savePos()
    const onVis = () => { if (document.hidden) savePos() }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); window.removeEventListener('pagehide', onHide); document.removeEventListener('visibilitychange', onVis); savePos() }
  }, [data])

  // Auto-advance when the episode ends.
  useEffect(() => {
    if (!data) return
    const v = videoRef.current
    if (!v) return
    const onEnded = () => { markWatched(data.id); if (data.nextId) navigate(`/watch/${data.nextId}`) }
    v.addEventListener('ended', onEnded)
    return () => v.removeEventListener('ended', onEnded)
  }, [data, navigate])

  // Theater mode reflects onto <body> (CSS targets body.theater).
  useEffect(() => {
    document.body.classList.toggle('theater', theater)
    return () => { document.body.classList.remove('theater') }
  }, [theater])

  // Keyboard: 't' toggles theater, Esc exits (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const tag = el && el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return
      if (e.key === 'Escape') setTheater(false)
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

  // Tear down players on unmount.
  useEffect(() => () => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    if (subRef.current) { subRef.current.destroy(); subRef.current = null }
  }, [])

  if (error) {
    return <div className="player"><div className="topbar"><Link className="back" to="/"><Icon name="back" size={15} /> All titles</Link></div><p style={{ padding: 20 }}>{error}</p></div>
  }
  if (!data) {
    return <div className="player"><div className="topbar"><span className="t">Loading…</span></div></div>
  }

  const watched = readWatched()
  const closeMenu = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')

  const audioLabel = data.audio.tracks.find((t) => String(t.index) === audioIndex)?.label || 'Audio'
  const subLabel = subIndex === '' ? 'Off' : (data.subs.find((s) => String(s.index) === subIndex)?.group || 'English')
  const qualityLabel = data.quality.find((q) => q.key === qKey)?.label || 'Auto'

  return (
    <div className="player">
      <div className="topbar">
        <Link className="back" to={data.back.href}><Icon name="back" size={15} /> {data.back.label}</Link>
        <span className="sep">/</span>
        {data.epNum && <span className="ep">{data.epNum}</span>}
        <span className="t">{data.title}</span>
      </div>

      <div className={`wrap${data.episodes.length ? '' : ' no-eps'}`}>
        <div className="col-video">
          <div className="vid"><video id="v" ref={videoRef} controls autoPlay playsInline /></div>
          <div className="pbar">
            {data.nextId && (
              <Link className="pctl" to={`/watch/${data.nextId}`} title="Next episode"><Icon name="next" size={16} /><span>Next</span></Link>
            )}
            <div className="spacer" />

            {data.audio.tracks.length > 1 && (
              <Menu kind="audio" icon="audio" title="Audio" label={audioLabel}>
                {data.audio.tracks.map((t) => (
                  <PopItem key={t.index} active={String(t.index) === audioIndex} label={t.label} detail={t.detail}
                    onClick={(e) => { closeMenu(e); setAudioIndex(String(t.index)); savePref({ audioLang: t.lang || '' }) }} />
                ))}
              </Menu>
            )}

            {data.subs.length > 0 && (
              <Menu kind="subs" icon="captions" title="Subtitles" label={`Subtitles: ${subLabel}`}>
                <PopItem active={subIndex === ''} label="Off"
                  onClick={(e) => { closeMenu(e); setSubIndex(''); savePref({ subGroup: 'off' }) }} />
                {data.subs.map((s, i) => (
                  <PopItem key={s.index} active={String(s.index) === subIndex} label="English"
                    detail={s.group || (data.subs.length > 1 ? `Track ${i + 1}` : 'Full')}
                    onClick={(e) => { closeMenu(e); setSubIndex(String(s.index)); savePref({ subGroup: s.group || 'on' }) }} />
                ))}
              </Menu>
            )}

            <Menu kind="quality" icon="gear" title="Quality" label={qualityLabel}>
              {data.quality.map((q) => (
                <PopItem key={q.key} active={q.key === qKey} label={q.label}
                  onClick={(e) => { closeMenu(e); setQKey(q.key); savePref({ quality: q.key }) }} />
              ))}
            </Menu>

            <button type="button" className="pctl" onClick={() => setTheater((t) => !t)}>
              <Icon name={theater ? 'shrink' : 'theater'} size={16} /><span>{theater ? 'Exit theater' : 'Theater'}</span>
            </button>
          </div>
        </div>

        {data.episodes.length > 0 && (
          <aside className="col-eps panel">
            <div className="eps-head"><Icon name="tv" size={15} /><span>Episodes</span><span className="badge">{data.episodes.length}</span></div>
            <div className="eps-list">
              {data.episodes.map((ep) => (
                <Link
                  key={ep.id}
                  className={`eprow${ep.current ? ' current' : ''}${!ep.current && watched[ep.id] ? ' watched' : ''}`}
                  to={`/watch/${ep.id}`}
                  aria-current={ep.current ? 'true' : undefined}
                  ref={ep.current ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined}
                >
                  <span className="epn">{ep.num}</span>
                  <span className="ept">{ep.name}</span>
                  {ep.current && <span className="epnow"><Icon name="play" size={12} fill="currentColor" /></span>}
                </Link>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
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
