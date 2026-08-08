// `{{config.KEY}}` references inside flow-node configuration.
//
// This is the *secret-safe* way for a flow to use a managed setting. The value
// is substituted into a node's config at the instant it runs and never becomes
// an item, so — unlike a value node — it cannot reach `NodeReport.samples`,
// which the editor renders and the run API returns verbatim.
//
// Resolution happens once, centrally, in server/flowExecutor.ts just before
// `impl.run(...)`. That is the single point every node's config passes through,
// so all 60+ nodes get this without a line of per-node code.

import { CONFIG_SPEC, cfgSafe, isKnownConfigKey, isSecretKey } from './config.js'

/** `{{config.KEY}}` / `{{ config.KEY }}` — keys are the CONFIG_SPEC spelling. */
const REF = /\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}/g

export const hasConfigRef = (s: string): boolean => {
  REF.lastIndex = 0
  return REF.test(s)
}

export interface ResolveResult {
  /** Config with every `{{config.KEY}}` replaced. */
  config: Record<string, unknown>
  /** Keys that were substituted, for the run note. Secrets included — the
   *  *name* is not sensitive and knowing which one was used is the point. */
  used: string[]
  /** Referenced keys that aren't in CONFIG_SPEC — a typo, surfaced not swallowed. */
  unknown: string[]
  /** Referenced keys that resolve to nothing right now. */
  empty: string[]
}

/**
 * Replace `{{config.KEY}}` in every string in a node's config (recursing into
 * arrays and objects, since `json` fields hold structures).
 *
 * An unknown key is left **verbatim** rather than replaced with an empty
 * string: silently blanking a typo'd reference turns "you misspelled
 * TMDB_API_KEY" into "the provider is unauthenticated", which is a much worse
 * hour. The caller reports it as a note instead.
 */
export function resolveConfigRefs(config: Record<string, unknown>): ResolveResult {
  const used = new Set<string>()
  const unknown = new Set<string>()
  const empty = new Set<string>()

  const sub = (s: string): string =>
    s.replace(REF, (whole, key: string) => {
      if (!isKnownConfigKey(key)) {
        unknown.add(key)
        return whole
      }
      used.add(key)
      const v = cfgSafe(key)
      if (v === '') empty.add(key)
      return v
    })

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return hasConfigRef(v) ? sub(v) : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }

  // Cheap exit: most nodes have no references at all, and this runs per node
  // per run. Only rebuild the object when there is something to substitute.
  let touched = false
  for (const v of Object.values(config)) {
    if (typeof v === 'string' ? hasConfigRef(v) : v !== null && typeof v === 'object') {
      touched = true
      break
    }
  }
  if (!touched) return { config, used: [], unknown: [], empty: [] }

  return {
    config: walk(config) as Record<string, unknown>,
    used: [...used],
    unknown: [...unknown],
    empty: [...empty],
  }
}

// ---------------------------------------------------------------------------
// Redaction backstop
// ---------------------------------------------------------------------------

/**
 * Every secret value currently in effect, longest first.
 *
 * Longest-first matters: if one secret happens to be a substring of another,
 * replacing the short one first would leave a fragment of the long one behind.
 */
function activeSecrets(): string[] {
  const out: string[] = []
  for (const spec of CONFIG_SPEC) {
    if (!spec.secret) continue
    let v = ''
    try {
      v = cfgSafe(spec.key)
    } catch {
      continue
    }
    // Short values would mangle unrelated text far more often than they would
    // hide a credential — a 4-character secret is not one worth protecting at
    // the cost of corrupting every report that happens to contain those chars.
    if (v && v.length >= 8) out.push(v)
  }
  return out.sort((a, b) => b.length - a.length)
}

/**
 * Scrub any live secret value out of an arbitrary structure.
 *
 * Defence in depth, not the primary protection: `{{config.KEY}}` already keeps
 * secrets out of the item stream. This catches the case where a node echoes a
 * credential into a note or an error — e.g. an HTTP node reporting the URL it
 * called with a key in the query string.
 */
export function redactSecrets<T>(value: T): T {
  const secrets = activeSecrets()
  if (secrets.length === 0) return value

  const scrub = (s: string): string => {
    let out = s
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('«redacted»')
    }
    return out
  }

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return walk(value) as T
}

export const isSecretConfigKey = isSecretKey
