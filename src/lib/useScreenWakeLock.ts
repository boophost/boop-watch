import { useEffect, useRef } from 'react'

/**
 * Hold the screen awake while something is playing.
 *
 * Browsers already keep the display on for **fullscreen** video, but our
 * player runs inline with its own controls (the episode list sits under it, so
 * inline is the normal way to watch on a phone) — and inline playback does not
 * get that treatment. The screen dims and locks mid-episode.
 *
 * Two behaviours of the API do most of the work here:
 *
 *  - **The lock is released whenever the page is hidden**, and is *not*
 *    restored when it comes back. A single notification, app-switch or
 *    accidental lock would otherwise end the wake lock for the rest of the
 *    episode, so `visibilitychange` re-acquires it.
 *  - **A request only succeeds while the document is visible.** Asking from a
 *    hidden page throws, which is why the effect checks before requesting
 *    rather than requesting and hoping.
 *
 * Everything here degrades to nothing: no `navigator.wakeLock` (older iOS),
 * an insecure context, or battery saver refusing the request all end with the
 * screen behaving exactly as it does today. A failure is never worth telling
 * the viewer about — they came here to watch something.
 */

interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
}

export function useScreenWakeLock(active: boolean): void {
  // Held across renders so the visibility listener can release the previous
  // sentinel before asking for another, rather than stacking them.
  const sentinel = useRef<WakeLockSentinelLike | null>(null)

  useEffect(() => {
    const api = (navigator as WakeLockNavigator).wakeLock
    if (!api) return

    // Set false on cleanup so a request still in flight when the effect tears
    // down (episode change, pause, unmount) releases instead of leaking a lock
    // nothing will ever let go of.
    let wanted = active

    const release = () => {
      const held = sentinel.current
      sentinel.current = null
      if (held && !held.released) void held.release().catch(() => {})
    }

    const acquire = async () => {
      if (!wanted || document.visibilityState !== 'visible') return
      if (sentinel.current && !sentinel.current.released) return
      try {
        const held = await api.request('screen')
        if (!wanted) {
          void held.release().catch(() => {})
          return
        }
        sentinel.current = held
      } catch {
        // Battery saver, an insecure context, or a browser that declines.
        // Nothing to do and nothing worth saying.
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
      // Hidden needs no branch: the browser has already released the lock and
      // marked the sentinel released. Re-acquiring is the only job.
    }

    if (active) void acquire()
    else release()

    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      wanted = false
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [active])
}
