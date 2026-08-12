// App configuration that lives in the database instead of the deployment.
//
// Settings used to be env vars set in `link`, which meant a redeploy and a pod
// roll to change a value the app is the only consumer of. They now live in
// `app_config` and are edited from /manage/settings — with one hard rule about
// precedence, explained below, that exists to protect preview isolation.
//
// Secrets are encrypted at rest: the DB file gets copied around routinely (a
// staging or prod `series.sqlite` is two SSH commands away), and a copy that
// carries every third-party credential in plaintext is a bad trade for the
// convenience.

import crypto from 'node:crypto'
import { getDb } from './db.js'

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------
//
// **A present env var wins over the database, even when its value is empty.**
//
// This is not the obvious choice, and it is load-bearing. Both isolation
// mechanisms in this repo disable the flow sink by injecting *explicit empty*
// env vars over the inherited ones — `scripts/preview-env.mjs` for PR previews
// ("explicit blanks win over any envFrom") and `scripts/agent-env.mjs` for
// local agent worktrees. Previews also seed their `series.sqlite` from the live
// dev DB. So if QBIT_PASSWORD lived only in the database, every preview would
// inherit dev's real qBittorrent credentials from the seed and could queue into
// the shared instance — exactly the collision those scripts exist to prevent.
//
// Testing presence rather than truthiness keeps that working untouched, and has
// two happy side effects: migrating a var is reversible (put it back in `link`
// to override the DB), and nothing changes at all until a var is actually
// removed from the deployment.
const envHas = (key: string): boolean => Object.prototype.hasOwnProperty.call(process.env, key)

export type ConfigSource = 'env' | 'database' | 'default'

export interface ConfigFieldSpec {
  key: string
  label: string
  /** Grouping for the settings page. */
  group: string
  /** Secrets are write-only over the API and encrypted at rest. */
  secret?: boolean
  /** Used when neither env nor database supplies a value. */
  default?: string
  help?: string
  /** Free-text hint rendered as the input's placeholder. */
  placeholder?: string
}

/**
 * Every key the settings page can manage.
 *
 * Bootstrap vars are deliberately absent — DATA_DIR, DATABASE_PATH, PORT,
 * NODE_ENV, JWT_SECRET, SUPABASE_* and CONFIG_KEY are all needed before the
 * database, or before the login that guards this page, exists. Putting them
 * here would promise something the app cannot deliver.
 */
export const CONFIG_SPEC: ConfigFieldSpec[] = [
  // --- Jellyfin -------------------------------------------------------------
  { key: 'JELLYFIN_URL', label: 'Jellyfin URL', group: 'Jellyfin', default: 'http://jellyfin:8096' },
  { key: 'JELLYFIN_API_KEY', label: 'Jellyfin API key', group: 'Jellyfin', secret: true,
    help: 'Admin key. Server-side only — it never reaches the browser.' },
  { key: 'WATCH_COLLECTION_ID', label: 'Anime collection id', group: 'Jellyfin',
    help: 'BoxSet id for the anime portal section.' },
  { key: 'WATCH_COLLECTION_ID_TV', label: 'TV collection id', group: 'Jellyfin',
    help: 'Unset hides the TV section from the portal.' },
  { key: 'WATCH_COLLECTION_ID_MOVIES', label: 'Movies collection id', group: 'Jellyfin',
    help: 'Unset hides the Movies section from the portal.' },

  // --- Libraries ------------------------------------------------------------
  { key: 'LIBRARY_DIR', label: 'Anime library path', group: 'Libraries', default: '/library',
    help: 'Where the import flow places anime files.' },
  { key: 'LIBRARY_DIR_TV', label: 'TV library path', group: 'Libraries', default: '/library-tv' },
  { key: 'LIBRARY_DIR_MOVIES', label: 'Movies library path', group: 'Libraries', default: '/library-movies' },

  // --- Metadata providers ---------------------------------------------------
  { key: 'TMDB_API_KEY', label: 'TMDB API key', group: 'Metadata', secret: true,
    help: 'themoviedb.org — powers the TV and Movies sections. A v3 key or a v4 read token both work.' },
  { key: 'TMDB_URL', label: 'TMDB base URL', group: 'Metadata', default: 'https://api.themoviedb.org/3' },
  { key: 'JIKAN_URL', label: 'Jikan base URL', group: 'Metadata', default: 'https://api.jikan.moe/v4' },
  { key: 'JIKAN_SEARCH_URL', label: 'Jikan search URL', group: 'Metadata',
    help: 'Search needs a Typesense index; a self-hosted Jikan without one 500s. Leave on the public API.' },
  { key: 'FANART_API_KEY', label: 'fanart.tv API key', group: 'Metadata', secret: true,
    help: 'Extra season-banner candidates. Unset just drops that one source.' },
  { key: 'FANART_URL', label: 'fanart.tv base URL', group: 'Metadata' },
  { key: 'JIMAKU_API_KEY', label: 'Jimaku API key', group: 'Metadata', secret: true,
    help: 'Subtitle fallback. Unset routes every item to "missed"; the embedded-sub branch still works.' },
  { key: 'JIMAKU_URL', label: 'Jimaku base URL', group: 'Metadata' },

  // --- Downloads ------------------------------------------------------------
  { key: 'QBIT_URL', label: 'qBittorrent URL', group: 'Downloads' },
  { key: 'QBIT_USERNAME', label: 'qBittorrent username', group: 'Downloads' },
  { key: 'QBIT_PASSWORD', label: 'qBittorrent password', group: 'Downloads', secret: true },
  { key: 'QBIT_CATEGORY', label: 'qBittorrent category', group: 'Downloads', default: 'anime',
    help: 'Category the code-built research flow queues into. Use anime-dev on staging so it never lands in prod’s queue.' },
  { key: 'TORRENT_TOSHO_URL', label: 'AnimeTosho URL', group: 'Downloads', default: 'https://feed.animetosho.xyz' },
  { key: 'TORRENT_TSUKI_URL', label: 'TsukiHime URL', group: 'Downloads', default: 'https://api.tsukihime.org' },
  { key: 'TORRENT_APBAY_URL', label: 'apibay (TPB) URL', group: 'Downloads', default: 'https://apibay.org',
    help: 'Public Western TV/movie index used by Torrent search’s apibay provider. Anime stays on Tosho/TsukiHime.' },

  // --- Analytics + integrations --------------------------------------------
  { key: 'POSTHOG_KEY', label: 'PostHog project token', group: 'Integrations',
    help: 'Public token, exposed to the browser via /config.js. Unset makes analytics a no-op.' },
  { key: 'POSTHOG_HOST', label: 'PostHog host', group: 'Integrations' },
  { key: 'POSTHOG_UI_HOST', label: 'PostHog UI host', group: 'Integrations' },
  { key: 'GITHUB_APP_ID', label: 'GitHub App id', group: 'Integrations',
    help: 'The suggestion bot. Unset makes POST /api/suggestions 503 rather than silently drop a suggestion.' },
  { key: 'GITHUB_APP_PRIVATE_KEY', label: 'GitHub App private key', group: 'Integrations', secret: true,
    help: 'PEM. Escaped \\n is accepted.' },
  { key: 'GITHUB_REPO', label: 'GitHub repo', group: 'Integrations', default: 'boophost/boop-watch' },

  // --- Scheduling -----------------------------------------------------------
  { key: 'SCHEDULE_TZ', label: 'Schedule timezone', group: 'Scheduling',
    help: 'Defaults to TZ, else America/New_York.' },

  // --- Flow scratch ---------------------------------------------------------
  // Managing WORK_DIR here is the fix for #224: a live-set env var gets
  // reverted by a link redeploy, silently putting multi-GB scratch back on the
  // small node PVC. A database row survives the redeploy.
  { key: 'WORK_DIR', label: 'Flow scratch directory', group: 'Flow scratch',
    help: 'Must be on the media NFS (e.g. /data/.boopwork), not the node PVC — extract/mux write multi-GB files here. Empty falls back to DATA_DIR.' },
  { key: 'WORK_MIN_GIB', label: 'Minimum free space (GiB)', group: 'Flow scratch', default: '10',
    help: 'Startup refuses to run scratch-writing flows below this, so a misconfigured scratch dir fails loudly at deploy rather than filling the node.' },
  { key: 'WORK_TTL_HOURS', label: 'Scratch retention (hours)', group: 'Flow scratch',
    help: 'How long work directories survive before pruning.' },
]

const SPEC_BY_KEY = new Map(CONFIG_SPEC.map((f) => [f.key, f]))
export const isKnownConfigKey = (key: string): boolean => SPEC_BY_KEY.has(key)
export const isSecretKey = (key: string): boolean => SPEC_BY_KEY.get(key)?.secret === true
export const configSpec = (key: string): ConfigFieldSpec | undefined => SPEC_BY_KEY.get(key)

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

const CIPHER = 'aes-256-gcm'
const PREFIX = 'v1:'

/** 32 bytes, base64 or hex. Absent ⇒ secrets cannot be stored or read. */
function masterKey(): Buffer | null {
  const raw = process.env.CONFIG_KEY
  if (!raw) return null
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buf.length === 32 ? buf : null
}

export const configKeyConfigured = (): boolean => masterKey() !== null

/** Generate a valid CONFIG_KEY — used by the docs and the setup error message. */
export const generateConfigKey = (): string => crypto.randomBytes(32).toString('base64')

export function encryptSecret(plain: string): string {
  const key = masterKey()
  if (!key) {
    throw new Error(
      'CONFIG_KEY is not set (or is not 32 bytes) — cannot store secrets. ' +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    )
  }
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv(CIPHER, key, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
}

/**
 * Decrypt a stored secret.
 *
 * Throws rather than returning null on failure, and the caller surfaces it.
 * A rotated or missing CONFIG_KEY must not look like "this provider was never
 * configured" — that sends you debugging TMDB when the actual problem is a
 * key change, which is a genuinely miserable hour.
 */
export function decryptSecret(stored: string, keyName = 'a secret'): string {
  if (!stored.startsWith(PREFIX)) return stored // pre-encryption row; read as-is
  const key = masterKey()
  if (!key) {
    throw new Error(`Cannot decrypt ${keyName}: CONFIG_KEY is not set. The stored value is encrypted.`)
  }
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':')
  try {
    const d = crypto.createDecipheriv(CIPHER, key, Buffer.from(ivB64, 'base64'))
    d.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new Error(
      `Cannot decrypt ${keyName}: CONFIG_KEY does not match the key it was stored with. ` +
        'Restore the original CONFIG_KEY, or clear and re-enter this value.',
    )
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ConfigRow {
  key: string
  value: string
  is_secret: number
  updated_at: string
  updated_by: string | null
}

// Single pod, and flows already run one at a time behind a lock, so an
// in-process cache needs no coordination — same reasoning as httpQueue.ts.
// Invalidated wholesale on any write; the map is tiny.
let cache: Map<string, ConfigRow> | null = null

function rows(): Map<string, ConfigRow> {
  if (cache) return cache
  const all = getDb().prepare('SELECT * FROM app_config').all() as ConfigRow[]
  cache = new Map(all.map((r) => [r.key, r]))
  return cache
}

export const invalidateConfigCache = (): void => {
  cache = null
}

/** Where a key's effective value comes from right now. */
export function configSource(key: string): ConfigSource {
  if (envHas(key)) return 'env'
  if (rows().has(key)) return 'database'
  return 'default'
}

/**
 * The effective value for a key: env (if present, even empty) → database →
 * spec default → ''. Secrets are decrypted here, so a decrypt failure throws
 * to the caller rather than degrading to "unset".
 */
export function cfg(key: string): string {
  if (envHas(key)) return process.env[key] ?? ''
  const row = rows().get(key)
  if (row) return row.is_secret ? decryptSecret(row.value, key) : row.value
  return SPEC_BY_KEY.get(key)?.default ?? ''
}

/** cfg() but never throws — a decrypt failure logs and falls back. For hot paths. */
export function cfgSafe(key: string): string {
  try {
    return cfg(key)
  } catch (e) {
    console.error(`[config] ${key}:`, e instanceof Error ? e.message : e)
    return SPEC_BY_KEY.get(key)?.default ?? ''
  }
}

export function cfgNum(key: string, fallback: number): number {
  const n = Number(cfgSafe(key))
  return Number.isFinite(n) ? n : fallback
}

export function cfgBool(key: string, fallback: boolean): boolean {
  const v = cfgSafe(key).trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return fallback
}

export function setConfig(key: string, value: string, updatedBy: string | null = null): void {
  const spec = SPEC_BY_KEY.get(key)
  if (!spec) throw new Error(`Unknown config key: ${key}`)
  const secret = spec.secret === true
  const stored = secret ? encryptSecret(value) : value
  getDb()
    .prepare(
      `INSERT INTO app_config (key, value, is_secret, updated_at, updated_by)
       VALUES (@key, @value, @is_secret, datetime('now'), @updated_by)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, is_secret = excluded.is_secret,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run({ key, value: stored, is_secret: secret ? 1 : 0, updated_by: updatedBy })
  invalidateConfigCache()
}

export function clearConfig(key: string): boolean {
  const r = getDb().prepare('DELETE FROM app_config WHERE key = ?').run(key)
  invalidateConfigCache()
  return r.changes > 0
}

export interface ConfigView {
  key: string
  label: string
  group: string
  secret: boolean
  help?: string
  placeholder?: string
  default?: string
  /** Effective source right now — what makes the precedence rule legible in the UI. */
  source: ConfigSource
  /** Present only for non-secret keys. A secret's value never leaves the server. */
  value?: string
  /** Secrets report only whether something is stored. */
  isSet: boolean
  updatedAt: string | null
  updatedBy: string | null
  /** Set when the stored secret can't be decrypted, so the UI can say why. */
  error?: string
}

/**
 * Every known key with its metadata and current source.
 *
 * Secret *values* are never included — not masked, absent. A masked value is
 * still a value that travelled over the wire and sat in a browser's memory and
 * devtools; "is it set" is all the page actually needs to render.
 */
export function listConfig(): ConfigView[] {
  return CONFIG_SPEC.map((spec) => {
    const row = rows().get(spec.key)
    const source = configSource(spec.key)
    const view: ConfigView = {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      secret: spec.secret === true,
      help: spec.help,
      placeholder: spec.placeholder,
      default: spec.default,
      source,
      isSet: source === 'env' ? (process.env[spec.key] ?? '') !== '' : row != null,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    }
    if (!spec.secret) {
      try {
        view.value = cfg(spec.key)
      } catch (e) {
        view.error = e instanceof Error ? e.message : String(e)
      }
    } else if (row) {
      // Surface an undecryptable secret rather than showing it as merely "set".
      try {
        decryptSecret(row.value, spec.key)
      } catch (e) {
        view.error = e instanceof Error ? e.message : String(e)
      }
    }
    return view
  })
}

/**
 * Every secret value currently in effect, for redacting run reports and logs.
 * Short values are skipped — scrubbing a 3-character string out of a report
 * would mangle unrelated text far more often than it would hide a credential.
 */
export function secretValues(): string[] {
  const out: string[] = []
  for (const spec of CONFIG_SPEC) {
    if (!spec.secret) continue
    let v = ''
    try {
      v = cfg(spec.key)
    } catch {
      continue
    }
    if (v && v.length >= 8) out.push(v)
  }
  return out
}
