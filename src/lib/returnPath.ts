import type { Location } from 'react-router-dom'

// Return-path plumbing for the auth flow. Route guards stash the page the user
// was on in redirect `state.from`; Login/Signup read it back and send the user
// there instead of always dumping them on /profile. OAuth can't carry in-memory
// router state across the provider round-trip, so the target rides along in the
// redirectTo URL as a `?next=` query param and is read back on landing.

/** The page to fall back to when no return target was captured. */
export const DEFAULT_AUTH_TARGET = '/profile'

/**
 * Only allow internal, absolute paths as a return target — blocks open-redirect
 * payloads like `//evil.com` or `https://evil.com` from being followed. Returns
 * null for anything that isn't a same-origin path.
 */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (!path) return null
  // Must be root-relative, and not protocol-relative (`//host`) or a `/\` trick.
  if (path[0] !== '/' || path[1] === '/' || path[1] === '\\') return null
  return path
}

/** Full path (pathname + search + hash) of a router Location. */
export function locationToPath(loc: Location): string {
  return `${loc.pathname}${loc.search}${loc.hash}`
}

/**
 * The return target for a Login/Signup page: the `from` location a guard stashed
 * in navigation state, validated as an internal path, or DEFAULT_AUTH_TARGET.
 */
export function returnTarget(location: Location): string {
  const from = (location.state as { from?: Location } | null)?.from
  const path = from ? safeInternalPath(locationToPath(from)) : null
  return path ?? DEFAULT_AUTH_TARGET
}
