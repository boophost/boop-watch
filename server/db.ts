import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const dbPath = process.env.DATABASE_PATH ?? path.join(dataDir, 'series.sqlite')

export interface SeriesRow {
  id: number
  mal_id: number
  title: string
  synopsis: string | null
  image_url: string | null
  url: string | null
  added_at: string
  // Richer metadata (populated by the enrich.metadata flow node) — the
  // groundwork for our own catalog to replace Jellyfin as the source of truth.
  title_english: string | null
  title_japanese: string | null
  type: string | null
  episodes: number | null
  status: string | null
  score: number | null
  year: number | null
  season: string | null
  aired: string | null
  studios: string | null // JSON array of names
  genres: string | null // JSON array of names
  metadata_updated_at: string | null
  // Multi-season placement. A single Jellyfin/TVDB show is often several MAL
  // cours (Mushoku Tensei S1c1/S1c2/S2/…), each a separate mal_id row. tvdb_id
  // groups the cours as one show; tvdb_season is the Jellyfin season number the
  // cour's episodes belong to; episode_offset is added to each release's
  // (per-cour) episode number to land it at the right absolute slot in that
  // season (e.g. S1 cour 2 → offset 11). Populated from the season-map dataset
  // unless mapping_source='manual' (an admin override the auto-enrich won't
  // clobber). See server/seasonMap.ts.
  tvdb_id: number | null
  tvdb_season: number | null
  episode_offset: number | null
  mapping_source: string | null // 'auto' | 'manual' | null
  // MAL weekly broadcast (JSON: { day, time, timezone, string }) for estimating
  // next-episode air times when Jikan hasn't listed the episode yet.
  broadcast: string | null
}

// Columns added after the original 5-field schema. Applied as additive ALTERs so
// existing series.sqlite files migrate in place (ADD COLUMN is a no-op-safe when
// guarded by the table_info check below).
const SERIES_EXTRA_COLUMNS: [string, string][] = [
  ['title_english', 'TEXT'],
  ['title_japanese', 'TEXT'],
  ['type', 'TEXT'],
  ['episodes', 'INTEGER'],
  ['status', 'TEXT'],
  ['score', 'REAL'],
  ['year', 'INTEGER'],
  ['season', 'TEXT'],
  ['aired', 'TEXT'],
  ['studios', 'TEXT'],
  ['genres', 'TEXT'],
  ['metadata_updated_at', 'TEXT'],
  ['tvdb_id', 'INTEGER'],
  ['tvdb_season', 'INTEGER'],
  ['episode_offset', 'INTEGER'],
  ['mapping_source', 'TEXT'],
  ['broadcast', 'TEXT'],
  // Cached airing-status lookups (enrich.anime-status writes these so flows
  // read our DB instead of re-polling TsukiHime per run; 'finished' is
  // terminal and never re-checked).
  ['air_status', 'TEXT'],
  ['total_episodes', 'INTEGER'],
  ['is_movie', 'INTEGER'],
  ['anidb_id', 'INTEGER'],
  ['tsuki_id', 'INTEGER'],
  ['anilist_id', 'INTEGER'],
  ['status_checked_at', 'TEXT'],
]

export interface SeriesMetadata {
  title_english?: string | null
  title_japanese?: string | null
  type?: string | null
  episodes?: number | null
  status?: string | null
  score?: number | null
  year?: number | null
  season?: string | null
  aired?: string | null
  studios?: string | null
  genres?: string | null
  broadcast?: string | null
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const instance = new Database(dbPath)
  instance.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      synopsis TEXT,
      image_url TEXT,
      url TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_series_mal_id ON series(mal_id);

    CREATE TABLE IF NOT EXISTS saved_animes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      item_id TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(username, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_animes(username);

    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      item_id TEXT NOT NULL,
      watched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(username, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_history_user ON watch_history(username);

    -- Epics that bundle several related suggestions under one admin-authored
    -- writeup. Suggestions attach via suggestions.group_id (nullable). Created and
    -- edited by admins / the boop-suggestions MCP driver, never by portal users.
    CREATE TABLE IF NOT EXISTS suggestion_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-text suggestions from logged-in portal users, reviewed on the
    -- /manage "Suggestions" kanban. user_id is the Supabase account id; email is
    -- captured at submit time so admins can see who asked without a lookup.
    -- status is the kanban column (unread | todo | working | staged | done);
    -- resolved is kept for back-compat and mirrors status = 'done'.
    -- body is the user's verbatim words and is never edited; title and notes
    -- are admin-authored triage/resolution metadata. duplicate_of points at the
    -- canonical suggestion this one duplicates; group_id links it to an epic.
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email TEXT,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unread',
      title TEXT,
      notes TEXT,
      duplicate_of INTEGER,
      group_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at);

    -- MAL episode titles, cached so the portal can show real episode names
    -- without hitting Jikan on every sync. Keyed by (mal_id, episode number).
    CREATE TABLE IF NOT EXISTS series_episodes (
      mal_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      -- Which source the title came from ('jikan' | 'kitsu' | 'anilist' |
      -- 'jellyfin'). Provenance decides whether the title is *proper* or a
      -- provisional stand-in still worth re-checking — see server/episodes.ts.
      title_source TEXT,
      title_japanese TEXT,
      aired TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mal_id, number)
    );

    -- Candidate season art per series, gathered from multiple sources plus admin
    -- uploads. "kind" splits the wide hero ('banner') from the portrait poster
    -- ('poster'); at most one row per (mal_id, kind) is 'selected' (the one the
    -- portal serves). Remote candidates store a url; uploads store a local_file
    -- under DATA_DIR/banners.
    CREATE TABLE IF NOT EXISTS series_banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'banner',
      source TEXT NOT NULL,
      url TEXT,
      thumb_url TEXT,
      local_file TEXT,
      width INTEGER,
      height INTEGER,
      selected INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_banners_mal ON series_banners(mal_id);
    -- Dedupe remote candidates by URL within a kind; uploads (url NULL) stay
    -- distinct since SQLite treats NULLs as unequal in a UNIQUE index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_banners_url ON series_banners(mal_id, kind, url);

    -- Per-episode comments on the public player page. item_id is the Jellyfin
    -- episode/movie id (same key as watch progress); user_id is the Supabase
    -- account id. Display name + avatar are still snapshotted at post time as a
    -- fallback, but reads prefer user_profiles (synced on auth) so a later
    -- profile change shows up on existing comments without a Supabase lookup.
    CREATE TABLE IF NOT EXISTS episode_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      avatar_url TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_item ON episode_comments(item_id, created_at);

    -- Cached display identity for comment authors. Upserted on authenticated
    -- requests from Supabase user_metadata so public comment reads can join
    -- current name/avatar/admin without calling Supabase.
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- What sink.library-import placed, and where it came from. Keyed on the
    -- library-relative path because that is what survives: a file rewritten in
    -- place (trim-audio writes to the PVC, so the import copies across
    -- filesystems) gets a fresh inode and loses its hardlink back to the
    -- torrent. Without this row, a file's season/episode can only be guessed
    -- back from its content.
    CREATE TABLE IF NOT EXISTS library_files (
      path TEXT PRIMARY KEY,
      mal_id INTEGER,
      tvdb_id INTEGER,
      tvdb_season INTEGER,
      episode INTEGER,
      torrent_hash TEXT,
      source_path TEXT,
      inode INTEGER,
      size INTEGER,
      method TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_library_files_ep ON library_files(mal_id, tvdb_season, episode);
    CREATE INDEX IF NOT EXISTS idx_library_files_hash ON library_files(torrent_hash);
    CREATE TABLE IF NOT EXISTS fetch_attempts (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );

    -- One row per episode (or season pack) the system has decided it needs.
    -- This is the persistent memory the sourcing flows work from: a search
    -- miss leaves the want open (with backoff) instead of vanishing, and a
    -- fulfilled want never gets re-queued. episode is the MAL per-cour number
    -- (what torrent search and release triggers speak) — NOT the post-offset
    -- tvdb episode that library_files stores.
    CREATE TABLE IF NOT EXISTS wants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                    -- 'episode' | 'batch'
      episode INTEGER,                       -- MAL per-cour number; NULL for batch
      status TEXT NOT NULL DEFAULT 'open',   -- open | sourced | fulfilled | abandoned
      reason TEXT,                           -- show-added | release-aired | upgrade | backfill | manual
      torrent_hash TEXT,                     -- torrents.hash currently sourcing it
      library_path TEXT,                     -- library_files.path that fulfilled it
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT,                  -- backoff gate: skip while in the future
      note TEXT,                             -- last miss reason
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One want per target, ever — re-needing something reopens the row.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wants_episode ON wants(mal_id, episode) WHERE kind = 'episode';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wants_batch ON wants(mal_id) WHERE kind = 'batch';
    CREATE INDEX IF NOT EXISTS idx_wants_status ON wants(status, next_attempt_at);

    -- Lifecycle ledger for every torrent the flows queue: nothing gets queued
    -- twice (sink.qbittorrent refuses hashes already tracked) and nothing gets
    -- lost (a completed torrent that imports nothing is marked exhausted
    -- instead of re-firing the import forever). library_files stays the
    -- per-file ledger; this is the per-torrent one.
    CREATE TABLE IF NOT EXISTS torrents (
      hash TEXT PRIMARY KEY,                 -- lowercased info-hash
      mal_id INTEGER,
      kind TEXT,                             -- 'episode' | 'batch'
      episode INTEGER,                       -- MAL per-cour number for single-ep grabs
      tvdb_season INTEGER,
      want_id INTEGER,                       -- wants.id it was queued to satisfy
      name TEXT,
      category TEXT,
      provider TEXT,                         -- tsukihime | animetosho | manual | backfill
      size INTEGER,
      status TEXT NOT NULL DEFAULT 'queued', -- queued | downloading | completed | imported | exhausted | superseded | cleaned | failed
      imported_files INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      imported_at TEXT,
      cleaned_at TEXT,
      note TEXT,                             -- why exhausted/failed/superseded
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_torrents_status ON torrents(status);
    CREATE INDEX IF NOT EXISTS idx_torrents_mal ON torrents(mal_id, episode);
  `)

  // Additive migration for the richer metadata columns.
  const existing = new Set(
    (instance.prepare(`PRAGMA table_info(series)`).all() as { name: string }[]).map((c) => c.name),
  )
  for (const [name, type] of SERIES_EXTRA_COLUMNS) {
    if (!existing.has(name)) instance.exec(`ALTER TABLE series ADD COLUMN ${name} ${type}`)
  }

  // Additive migration: the suggestions kanban `status` column landed after the
  // table already existed on some deployments. Add it, then backfill from the
  // older `resolved` flag so previously-resolved items open in the Done column.
  const suggestionCols = new Set(
    (instance.prepare(`PRAGMA table_info(suggestions)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!suggestionCols.has('status')) {
    instance.exec(`ALTER TABLE suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'`)
    instance.exec(`UPDATE suggestions SET status = 'done' WHERE resolved = 1`)
  }
  // Additive migration: admin triage metadata (title/notes), duplicate links, and
  // epic grouping landed with the boop-suggestions MCP driver. All nullable, so a
  // plain ADD COLUMN backfills existing rows with NULL (untriaged, ungrouped).
  for (const [name, type] of [
    ['title', 'TEXT'],
    ['notes', 'TEXT'],
    ['duplicate_of', 'INTEGER'],
    ['group_id', 'INTEGER'],
    ['updated_at', 'TEXT'],
  ] as const) {
    if (!suggestionCols.has(name)) instance.exec(`ALTER TABLE suggestions ADD COLUMN ${name} ${type}`)
  }
  // Index on group_id lives here, not in the schema block above: on an existing
  // DB the CREATE TABLE IF NOT EXISTS is a no-op, so group_id only exists once the
  // ALTER above has run. Creating it in the schema block would reference a column
  // that isn't there yet on already-provisioned deployments.
  instance.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_group ON suggestions(group_id)`)

  // Additive migration: `thumb_url` arrived with the provider-artwork sources,
  // whose candidate lists are far too large to cache in full (see banners.ts).
  const bannerCols = new Set(
    (instance.prepare(`PRAGMA table_info(series_banners)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!bannerCols.has('thumb_url')) {
    instance.exec(`ALTER TABLE series_banners ADD COLUMN thumb_url TEXT`)
  }

  // Additive migration: episode-title provenance. Rows written before this
  // column existed keep a NULL source — readers treat that as "unknown", and
  // fall back to inspecting the title text itself (see isProperTitle).
  const episodeCols = new Set(
    (instance.prepare(`PRAGMA table_info(series_episodes)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!episodeCols.has('title_source')) {
    instance.exec(`ALTER TABLE series_episodes ADD COLUMN title_source TEXT`)
  }
  // `kind` splits banners from posters. The dedupe index has to widen with it,
  // or a poster could never share a URL with its series' banner. An existing DB
  // still carries the two-column index under the same name, so replace it.
  if (!bannerCols.has('kind')) {
    instance.exec(`ALTER TABLE series_banners ADD COLUMN kind TEXT NOT NULL DEFAULT 'banner'`)
    instance.exec(`DROP INDEX IF EXISTS idx_banners_url`)
    instance.exec(`CREATE UNIQUE INDEX idx_banners_url ON series_banners(mal_id, kind, url)`)
  }

  db = instance
  return instance
}

/**
 * Upsert a catalog series by mal_id and set its richer metadata. Creates the
 * row (with title/synopsis/image/url) if the mal_id is new, otherwise updates
 * only the provided metadata fields. Returns the resulting row.
 */
export function upsertSeriesMetadata(
  base: { mal_id: number; title: string; synopsis?: string | null; image_url?: string | null; url?: string | null },
  meta: SeriesMetadata,
): SeriesRow {
  const db = getDb()
  const existing = findByMalId(base.mal_id)
  if (!existing) {
    db.prepare(
      `INSERT INTO series (mal_id, title, synopsis, image_url, url) VALUES (@mal_id, @title, @synopsis, @image_url, @url)`,
    ).run({
      mal_id: base.mal_id,
      title: base.title,
      synopsis: base.synopsis ?? null,
      image_url: base.image_url ?? null,
      url: base.url ?? null,
    })
  }
  const cols = Object.keys(meta).filter((k) => (meta as Record<string, unknown>)[k] !== undefined)
  const assignments = [
    ...cols.map((c) => `${c} = @${c}`),
    // Fill the base presentation fields when the row is missing them (rows
    // added by id-only paths — flows, the CLI — have no poster/synopsis until
    // an enrich runs). Never overwrites an existing value.
    `synopsis = COALESCE(synopsis, @b_synopsis)`,
    `image_url = COALESCE(image_url, @b_image_url)`,
    `url = COALESCE(url, @b_url)`,
    `metadata_updated_at = datetime('now')`,
  ]
  db.prepare(`UPDATE series SET ${assignments.join(', ')} WHERE mal_id = @mal_id`).run({
    ...meta,
    mal_id: base.mal_id,
    b_synopsis: base.synopsis ?? null,
    b_image_url: base.image_url ?? null,
    b_url: base.url ?? null,
  })
  return findByMalId(base.mal_id)!
}

/**
 * Set (or clear) the multi-season placement mapping on a catalog row. `source`
 * distinguishes an admin override ('manual') from a dataset-derived value
 * ('auto'); callers doing an auto-enrich must not overwrite a 'manual' row (see
 * seasonMap.enrichSeasonMapping). Pass null fields to clear.
 */
export function setSeasonMapping(
  mal_id: number,
  m: { tvdb_id?: number | null; tvdb_season?: number | null; episode_offset?: number | null; source?: string | null },
): SeriesRow | undefined {
  getDb()
    .prepare(
      `UPDATE series SET
         tvdb_id = @tvdb_id,
         tvdb_season = @tvdb_season,
         episode_offset = @episode_offset,
         mapping_source = @mapping_source
       WHERE mal_id = @mal_id`,
    )
    .run({
      mal_id,
      tvdb_id: m.tvdb_id ?? null,
      tvdb_season: m.tvdb_season ?? null,
      episode_offset: m.episode_offset ?? null,
      mapping_source: m.source ?? null,
    })
  return findByMalId(mal_id)
}

export function getSavedAnimes(username: string): { item_id: string; added_at: string }[] {
  return getDb().prepare('SELECT item_id, added_at FROM saved_animes WHERE username = ? ORDER BY added_at DESC').all(username) as any[]
}

export function saveAnime(username: string, item_id: string) {
  getDb().prepare('INSERT OR IGNORE INTO saved_animes (username, item_id) VALUES (?, ?)').run(username, item_id)
}

export function unsaveAnime(username: string, item_id: string) {
  getDb().prepare('DELETE FROM saved_animes WHERE username = ? AND item_id = ?').run(username, item_id)
}

export type SuggestionStatus = 'unread' | 'todo' | 'working' | 'staged' | 'done'
export const SUGGESTION_STATUSES: SuggestionStatus[] = ['unread', 'todo', 'working', 'staged', 'done']

export interface SuggestionRow {
  id: number
  user_id: string
  email: string | null
  body: string
  resolved: number
  status: SuggestionStatus
  /** Admin-authored short title (the user's `body` stays verbatim). */
  title: string | null
  /** Admin-authored triage / resolution notes. */
  notes: string | null
  /** Canonical suggestion id this one duplicates, or null. */
  duplicate_of: number | null
  /** Epic (suggestion_groups.id) this belongs to, or null. */
  group_id: number | null
  created_at: string
  updated_at: string | null
}

export interface SuggestionGroupRow {
  id: number
  title: string
  description: string | null
  created_at: string
  updated_at: string
}

export function addSuggestion(user_id: string, email: string | null, body: string): SuggestionRow {
  // Land new suggestions in the 'unread' column explicitly — DBs that migrated
  // the status column earlier baked in a 'todo' default we don't want to inherit.
  const info = getDb()
    .prepare("INSERT INTO suggestions (user_id, email, body, status) VALUES (?, ?, ?, 'unread')")
    .run(user_id, email, body)
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(info.lastInsertRowid)) as SuggestionRow
}

/** All suggestions, newest first (the board groups them into columns client-side). */
export function listSuggestions(): SuggestionRow[] {
  return getDb()
    .prepare('SELECT * FROM suggestions ORDER BY created_at DESC')
    .all() as SuggestionRow[]
}

export function getSuggestion(id: number): SuggestionRow | undefined {
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
}

/** Fields an admin (or the MCP driver) may edit on a suggestion. `body` is never
 * editable — it's the user's verbatim words. Every key is optional; only the ones
 * present in the patch are written. Pass `null` to clear a nullable field. */
export interface SuggestionPatch {
  status?: SuggestionStatus
  title?: string | null
  notes?: string | null
  duplicate_of?: number | null
  group_id?: number | null
}

/**
 * Apply a partial edit to a suggestion. `resolved` is kept in sync with status
 * (= 'done'), and `updated_at` is stamped. Returns the fresh row, or undefined if
 * the id doesn't exist.
 */
export function updateSuggestion(id: number, patch: SuggestionPatch): SuggestionRow | undefined {
  const existing = getSuggestion(id)
  if (!existing) return undefined
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?', 'resolved = ?')
    vals.push(patch.status, patch.status === 'done' ? 1 : 0)
  }
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    vals.push(patch.notes)
  }
  if (patch.duplicate_of !== undefined) {
    sets.push('duplicate_of = ?')
    vals.push(patch.duplicate_of)
  }
  if (patch.group_id !== undefined) {
    sets.push('group_id = ?')
    vals.push(patch.group_id)
  }
  if (sets.length === 0) return existing
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE suggestions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getSuggestion(id)
}

/** Back-compat shim for the status-only move (kanban drag). */
export function setSuggestionStatus(id: number, status: SuggestionStatus): SuggestionRow | undefined {
  return updateSuggestion(id, { status })
}

export function deleteSuggestion(id: number): boolean {
  const db = getDb()
  return db.transaction((): boolean => {
    // Don't leave dangling references: clear this id from any suggestion that
    // pointed at it as a duplicate canonical.
    db.prepare('UPDATE suggestions SET duplicate_of = NULL WHERE duplicate_of = ?').run(id)
    return db.prepare('DELETE FROM suggestions WHERE id = ?').run(id).changes > 0
  })()
}

// --- Suggestion groups (epics) ---------------------------------------------

export function listSuggestionGroups(): SuggestionGroupRow[] {
  return getDb()
    .prepare('SELECT * FROM suggestion_groups ORDER BY created_at DESC')
    .all() as SuggestionGroupRow[]
}

export function getSuggestionGroup(id: number): SuggestionGroupRow | undefined {
  return getDb().prepare('SELECT * FROM suggestion_groups WHERE id = ?').get(id) as SuggestionGroupRow | undefined
}

export function addSuggestionGroup(title: string, description: string | null): SuggestionGroupRow {
  const info = getDb()
    .prepare('INSERT INTO suggestion_groups (title, description) VALUES (?, ?)')
    .run(title, description)
  return getSuggestionGroup(Number(info.lastInsertRowid))!
}

export function updateSuggestionGroup(
  id: number,
  patch: { title?: string; description?: string | null },
): SuggestionGroupRow | undefined {
  const existing = getSuggestionGroup(id)
  if (!existing) return undefined
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    vals.push(patch.description)
  }
  if (sets.length === 0) return existing
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE suggestion_groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getSuggestionGroup(id)
}

/** Delete an epic; detach (not delete) its member suggestions. */
export function deleteSuggestionGroup(id: number): boolean {
  const db = getDb()
  return db.transaction((): boolean => {
    db.prepare('UPDATE suggestions SET group_id = NULL WHERE group_id = ?').run(id)
    return db.prepare('DELETE FROM suggestion_groups WHERE id = ?').run(id).changes > 0
  })()
}

export interface CommentRow {
  id: number
  item_id: string
  user_id: string
  user_name: string
  avatar_url: string | null
  body: string
  created_at: string
  /** 1 when the author is currently an admin (from user_profiles join). */
  is_admin: number
}

export interface UserProfileRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  is_admin: number
  updated_at: string
}

// Prefer the live profile cache when present; fall back to the write-time
// snapshot for authors who haven't authenticated since profiles were added.
const COMMENT_SELECT = `
  SELECT
    c.id, c.item_id, c.user_id, c.body, c.created_at,
    CASE WHEN p.user_id IS NOT NULL THEN p.display_name ELSE c.user_name END AS user_name,
    CASE WHEN p.user_id IS NOT NULL THEN p.avatar_url ELSE c.avatar_url END AS avatar_url,
    COALESCE(p.is_admin, 0) AS is_admin
  FROM episode_comments c
  LEFT JOIN user_profiles p ON p.user_id = c.user_id
`

/** Comments on one episode/movie, newest first. */
export function listComments(item_id: string): CommentRow[] {
  return getDb()
    .prepare(`${COMMENT_SELECT} WHERE c.item_id = ? ORDER BY c.id DESC`)
    .all(item_id) as CommentRow[]
}

export function addComment(c: {
  item_id: string
  user_id: string
  user_name: string
  avatar_url: string | null
  body: string
}): CommentRow {
  const info = getDb()
    .prepare(
      'INSERT INTO episode_comments (item_id, user_id, user_name, avatar_url, body) VALUES (?, ?, ?, ?, ?)',
    )
    .run(c.item_id, c.user_id, c.user_name, c.avatar_url, c.body)
  return getComment(Number(info.lastInsertRowid))!
}

export function getComment(id: number): CommentRow | undefined {
  return getDb().prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as CommentRow | undefined
}

export function deleteComment(id: number): boolean {
  return getDb().prepare('DELETE FROM episode_comments WHERE id = ?').run(id).changes > 0
}

export function upsertUserProfile(p: {
  user_id: string
  display_name: string
  avatar_url: string | null
  is_admin: boolean
}): void {
  getDb()
    .prepare(
      `INSERT INTO user_profiles (user_id, display_name, avatar_url, is_admin, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         is_admin = excluded.is_admin,
         updated_at = datetime('now')`,
    )
    .run(p.user_id, p.display_name, p.avatar_url, p.is_admin ? 1 : 0)
}

/** Keep the comment-author admin badge in sync when /manage toggles admin. */
export function setUserProfileAdmin(user_id: string, is_admin: boolean): void {
  getDb()
    .prepare(
      `UPDATE user_profiles SET is_admin = ?, updated_at = datetime('now') WHERE user_id = ?`,
    )
    .run(is_admin ? 1 : 0, user_id)
}

export function listSeries(): SeriesRow[] {
  return getDb()
    .prepare('SELECT * FROM series ORDER BY added_at DESC')
    .all() as SeriesRow[]
}

export function insertSeries(
  row: Pick<SeriesRow, 'mal_id' | 'title' | 'synopsis' | 'image_url' | 'url'>,
): SeriesRow {
  const stmt = getDb().prepare(`
    INSERT INTO series (mal_id, title, synopsis, image_url, url)
    VALUES (@mal_id, @title, @synopsis, @image_url, @url)
  `)
  const info = stmt.run(row)
  const id = Number(info.lastInsertRowid)
  return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow
}

export function deleteSeries(id: number): boolean {
  const r = getDb().prepare('DELETE FROM series WHERE id = ?').run(id)
  return r.changes > 0
}

export function findByMalId(mal_id: number): SeriesRow | undefined {
  return getDb().prepare('SELECT * FROM series WHERE mal_id = ?').get(mal_id) as
    | SeriesRow
    | undefined
}

export function getSeriesById(id: number): SeriesRow | undefined {
  return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id) as
    | SeriesRow
    | undefined
}

export interface EpisodeRow {
  number: number
  title: string | null
  /** Which source supplied `title`; NULL on rows written before provenance was
   * tracked. See `isProperTitle` in server/episodes.ts. */
  title_source?: string | null
  title_japanese?: string | null
  aired?: string | null
}

// Throttle ledger for external fetches (banner gathers, poster searches,
// episode-title fetches). Persisted so a pod restart doesn't refire every
// gather at once — deploys roll the pod many times a day, and the old
// in-process maps made each roll a burst of AniList/Kitsu/fanart/Jikan
// requests (observed 429s when dev and prod rolled together).
/** Last recorded attempt (ms epoch) for a throttled fetch, or 0 if never tried. */
export function lastFetchAttempt(kind: string, key: string): number {
  const row = getDb()
    .prepare('SELECT attempted_at FROM fetch_attempts WHERE kind = ? AND key = ?')
    .get(kind, key) as { attempted_at: number } | undefined
  return row?.attempted_at ?? 0
}

export function recordFetchAttempt(kind: string, key: string): void {
  getDb()
    .prepare(
      `INSERT INTO fetch_attempts (kind, key, attempted_at) VALUES (?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET attempted_at = excluded.attempted_at`,
    )
    .run(kind, key, Date.now())
}

/** How many episode titles are cached for a series (0 = never fetched). */
export function countCachedEpisodes(mal_id: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM series_episodes WHERE mal_id = ?').get(mal_id) as {
      c: number
    }
  ).c
}

/** Cached episode number -> title for a series. */
export function getEpisodeTitles(mal_id: number): Map<number, string> {
  const rows = getDb()
    .prepare('SELECT number, title FROM series_episodes WHERE mal_id = ?')
    .all(mal_id) as { number: number; title: string | null }[]
  return new Map(rows.filter((r) => r.title).map((r) => [r.number, r.title as string]))
}

/** All cached episode rows for a series, ordered by number (the fallback the
 * episodes API serves when Jikan is unreachable). */
export function getCachedEpisodes(mal_id: number): EpisodeRow[] {
  return getDb()
    .prepare(
      'SELECT number, title, title_source, title_japanese, aired FROM series_episodes WHERE mal_id = ? ORDER BY number',
    )
    .all(mal_id) as EpisodeRow[]
}

/** The two art kinds a cour can carry: the wide hero and the portrait poster. */
export type ArtKind = 'banner' | 'poster'

export const isArtKind = (v: unknown): v is ArtKind => v === 'banner' || v === 'poster'

export interface BannerRow {
  id: number
  mal_id: number
  kind: ArtKind
  source: string
  url: string | null
  /** A small preview of `url`, when the source offers one. Never cached to disk. */
  thumb_url: string | null
  local_file: string | null
  width: number | null
  height: number | null
  selected: number
  added_at: string
}

export function listBanners(mal_id: number, kind: ArtKind = 'banner'): BannerRow[] {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? ORDER BY selected DESC, id ASC')
    .all(mal_id, kind) as BannerRow[]
}

export function getBanner(id: number): BannerRow | undefined {
  return getDb().prepare('SELECT * FROM series_banners WHERE id = ?').get(id) as BannerRow | undefined
}

export function getSelectedBanner(mal_id: number, kind: ArtKind = 'banner'): BannerRow | undefined {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? AND selected = 1 LIMIT 1')
    .get(mal_id, kind) as BannerRow | undefined
}

/**
 * Add an art candidate. Remote candidates dedupe by URL within their kind
 * (returns the existing row); uploads (no url) always insert. Never changes the
 * current selection.
 */
export function addBanner(b: {
  mal_id: number
  kind?: ArtKind
  source: string
  url?: string | null
  thumb_url?: string | null
  local_file?: string | null
  width?: number | null
  height?: number | null
}): BannerRow {
  const db = getDb()
  const kind = b.kind ?? 'banner'
  if (b.url) {
    const existing = db
      .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? AND url = ?')
      .get(b.mal_id, kind, b.url) as BannerRow | undefined
    if (existing) return existing
  }
  const info = db
    .prepare(
      `INSERT INTO series_banners (mal_id, kind, source, url, thumb_url, local_file, width, height)
       VALUES (@mal_id, @kind, @source, @url, @thumb_url, @local_file, @width, @height)`,
    )
    .run({
      mal_id: b.mal_id,
      kind,
      source: b.source,
      url: b.url ?? null,
      thumb_url: b.thumb_url ?? null,
      local_file: b.local_file ?? null,
      width: b.width ?? null,
      height: b.height ?? null,
    })
  return getBanner(Number(info.lastInsertRowid))!
}

export interface LibraryFileRow {
  path: string
  mal_id: number | null
  tvdb_id: number | null
  tvdb_season: number | null
  episode: number | null
  torrent_hash: string | null
  source_path: string | null
  inode: number | null
  size: number | null
  method: string | null
  imported_at: string
}

/** Record (or re-record) what a library path holds. Re-importing the same path
 * overwrites the row, so the ledger always describes the file that is there. */
export function recordLibraryFile(row: Omit<LibraryFileRow, 'imported_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO library_files (path, mal_id, tvdb_id, tvdb_season, episode, torrent_hash, source_path, inode, size, method, imported_at)
       VALUES (@path, @mal_id, @tvdb_id, @tvdb_season, @episode, @torrent_hash, @source_path, @inode, @size, @method, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         mal_id=excluded.mal_id, tvdb_id=excluded.tvdb_id, tvdb_season=excluded.tvdb_season,
         episode=excluded.episode, torrent_hash=excluded.torrent_hash, source_path=excluded.source_path,
         inode=excluded.inode, size=excluded.size, method=excluded.method, imported_at=datetime('now')`,
    )
    .run(row)
}

/** Drop a ledger row (the file was removed or superseded under another name). */
export function forgetLibraryFile(p: string): void {
  getDb().prepare('DELETE FROM library_files WHERE path = ?').run(p)
}

export function getLibraryFile(p: string): LibraryFileRow | undefined {
  return getDb().prepare('SELECT * FROM library_files WHERE path = ?').get(p) as LibraryFileRow | undefined
}

export function listLibraryFiles(): LibraryFileRow[] {
  return getDb().prepare('SELECT * FROM library_files ORDER BY path').all() as LibraryFileRow[]
}

/** Distinct torrent hashes that already have at least one imported library file.
 * Lets `source.qbittorrent` drop already-imported torrents up front — before the
 * expensive ffprobe/ffmpeg probe+mux nodes — instead of re-doing all that work
 * only for `sink.library-import` to skip it at the finish line. Backed by the
 * `idx_library_files_hash` index. */
export function importedTorrentHashes(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT torrent_hash AS h FROM library_files WHERE torrent_hash IS NOT NULL AND torrent_hash <> ''`,
    )
    .all() as { h: string }[]
  return new Set(rows.map((r) => r.h))
}

// --- Cached external lookups (status + episode air dates) --------------------

export interface SeriesStatusCache {
  air_status: string | null
  total_episodes: number | null
  is_movie: number | null
  anidb_id: number | null
  tsuki_id: number | null
  anilist_id: number | null
  status_checked_at: string | null
}

export function getSeriesStatus(mal_id: number): SeriesStatusCache | undefined {
  return getDb()
    .prepare(
      `SELECT air_status, total_episodes, is_movie, anidb_id, tsuki_id, anilist_id, status_checked_at
       FROM series WHERE mal_id = ?`,
    )
    .get(mal_id) as SeriesStatusCache | undefined
}

/** Cache a status lookup on the catalog row (no-op for non-catalog mal_ids). */
export function saveSeriesStatus(
  mal_id: number,
  s: Omit<SeriesStatusCache, 'status_checked_at'>,
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE series SET air_status = ?, total_episodes = ?, is_movie = ?,
           anidb_id = ?, tsuki_id = ?, anilist_id = ?, status_checked_at = datetime('now')
         WHERE mal_id = ?`,
      )
      .run(s.air_status, s.total_episodes, s.is_movie, s.anidb_id, s.tsuki_id, s.anilist_id, mal_id)
      .changes > 0
  )
}

/** Merge air dates into the episode cache without clobbering Jikan-fetched
 * titles (upsertEpisodes overwrites every column; this one only sets `aired`). */
export function upsertEpisodeAirDates(
  mal_id: number,
  rows: { number: number; aired: string }[],
): void {
  if (rows.length === 0) return
  const stmt = getDb().prepare(`
    INSERT INTO series_episodes (mal_id, number, aired, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(mal_id, number) DO UPDATE SET aired = excluded.aired, updated_at = excluded.updated_at
  `)
  const tx = getDb().transaction((rs: { number: number; aired: string }[]) => {
    for (const r of rs) if (Number.isFinite(r.number)) stmt.run(mal_id, r.number, r.aired)
  })
  tx(rows)
}

/** Merge episode titles (and air dates for rows that lack one) into the cache
 * without clobbering an air date AniList already set. Titles come from a merge
 * of several sources (see server/episodes.ts); the caller controls which episode
 * numbers to write — for an airing show only numbers already in the cache
 * (AniList owns existence), for a finished show any number a source knows. */
export function upsertEpisodeTitles(mal_id: number, rows: EpisodeRow[]): void {
  if (rows.length === 0) return
  const stmt = getDb().prepare(`
    INSERT INTO series_episodes (mal_id, number, title, title_source, title_japanese, aired, updated_at)
    VALUES (@mal_id, @number, @title, @title_source, @title_japanese, @aired, datetime('now'))
    ON CONFLICT(mal_id, number) DO UPDATE SET
      title = COALESCE(excluded.title, series_episodes.title),
      -- Tied to the title above: a NULL incoming title leaves the stored title
      -- alone, so its source must stay too or provenance drifts off the text.
      title_source = CASE WHEN excluded.title IS NULL
                          THEN series_episodes.title_source
                          ELSE excluded.title_source END,
      title_japanese = COALESCE(excluded.title_japanese, series_episodes.title_japanese),
      aired = COALESCE(series_episodes.aired, excluded.aired),
      updated_at = datetime('now')
  `)
  const tx = getDb().transaction((rs: EpisodeRow[]) => {
    for (const r of rs) {
      if (!Number.isFinite(r.number)) continue
      stmt.run({
        mal_id,
        number: r.number,
        title: r.title ?? null,
        title_source: r.title_source ?? null,
        title_japanese: r.title_japanese ?? null,
        aired: r.aired ?? null,
      })
    }
  })
  tx(rows)
}

/** How complete/fresh the episode cache is for a series. */
export function episodesCacheInfo(mal_id: number): { count: number; updated_at: string | null } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at FROM series_episodes WHERE mal_id = ?`,
    )
    .get(mal_id) as { count: number; updated_at: string | null }
}

// --- Wants (what the sourcing flows are trying to obtain) -------------------

export type WantKind = 'episode' | 'batch'
export type WantStatus = 'open' | 'sourced' | 'fulfilled' | 'abandoned'

export interface WantRow {
  id: number
  mal_id: number
  kind: WantKind
  episode: number | null // MAL per-cour number; NULL for batch
  status: WantStatus
  reason: string | null
  torrent_hash: string | null
  library_path: string | null
  attempts: number
  last_attempt_at: string | null
  next_attempt_at: string | null
  note: string | null
  created_at: string
  updated_at: string
}

function findWant(mal_id: number, kind: WantKind, episode: number | null): WantRow | undefined {
  return (
    kind === 'episode'
      ? getDb()
          .prepare(`SELECT * FROM wants WHERE mal_id = ? AND kind = 'episode' AND episode = ?`)
          .get(mal_id, episode)
      : getDb().prepare(`SELECT * FROM wants WHERE mal_id = ? AND kind = 'batch'`).get(mal_id)
  ) as WantRow | undefined
}

/**
 * Create a want, or revive an existing one. There is only ever one want per
 * target: an open/sourced want is left untouched, a fulfilled/abandoned one is
 * reopened only when `reopen` says so (a re-aired trigger must not re-source
 * an episode we already have).
 */
export function upsertWant(args: {
  mal_id: number
  kind: WantKind
  episode?: number | null
  reason?: string
  reopen?: boolean
}): { want: WantRow; created: boolean; reopened: boolean } {
  const db = getDb()
  const episode = args.kind === 'episode' ? (args.episode ?? null) : null
  const tx = db.transaction(() => {
    const existing = findWant(args.mal_id, args.kind, episode)
    if (!existing) {
      const info = db
        .prepare(`INSERT INTO wants (mal_id, kind, episode, reason) VALUES (?, ?, ?, ?)`)
        .run(args.mal_id, args.kind, episode, args.reason ?? null)
      const want = db.prepare('SELECT * FROM wants WHERE id = ?').get(info.lastInsertRowid) as WantRow
      return { want, created: true, reopened: false }
    }
    const revivable = existing.status === 'fulfilled' || existing.status === 'abandoned'
    if (revivable && args.reopen) {
      db.prepare(
        `UPDATE wants SET status = 'open', reason = ?, torrent_hash = NULL, library_path = NULL,
           attempts = 0, next_attempt_at = NULL, note = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(args.reason ?? existing.reason, existing.id)
      return { want: db.prepare('SELECT * FROM wants WHERE id = ?').get(existing.id) as WantRow, created: false, reopened: true }
    }
    return { want: existing, created: false, reopened: false }
  })
  return tx()
}

/** A search pass came up empty: bump attempts and push the next try out with
 * exponential backoff (base * 2^attempts, capped at 2^5 = 32x). */
export function recordWantAttempt(id: number, backoffBaseMinutes: number, note?: string): void {
  const row = getDb().prepare('SELECT attempts FROM wants WHERE id = ?').get(id) as
    | { attempts: number }
    | undefined
  if (!row) return
  const minutes = Math.round(backoffBaseMinutes * 2 ** Math.min(row.attempts, 5))
  getDb()
    .prepare(
      `UPDATE wants SET attempts = attempts + 1, last_attempt_at = datetime('now'),
         next_attempt_at = datetime('now', '+' || ? || ' minutes'), note = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(minutes, note ?? null, id)
}

/** A torrent was queued for this want. */
export function markWantSourced(id: number, torrentHash: string): void {
  getDb()
    .prepare(
      `UPDATE wants SET status = 'sourced', torrent_hash = ?, note = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(torrentHash.toLowerCase(), id)
}

export function updateWantStatus(id: number, status: WantStatus, note?: string): void {
  getDb()
    .prepare(`UPDATE wants SET status = ?, note = COALESCE(?, note), updated_at = datetime('now') WHERE id = ?`)
    .run(status, note ?? null, id)
}

/** An episode landed in the library — fulfil its want, whatever state it was
 * in. `episode` is the MAL per-cour number (pre episode_offset), matching how
 * the want was minted. */
export function fulfilEpisodeWant(
  mal_id: number,
  episode: number,
  torrentHash: string | null,
  libraryPath: string | null,
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE wants SET status = 'fulfilled',
           torrent_hash = COALESCE(?, torrent_hash), library_path = COALESCE(?, library_path),
           note = NULL, updated_at = datetime('now')
         WHERE mal_id = ? AND kind = 'episode' AND episode = ? AND status <> 'fulfilled'`,
      )
      .run(torrentHash ? torrentHash.toLowerCase() : null, libraryPath, mal_id, episode).changes > 0
  )
}

/** A season pack imported — fulfil the batch want it was sourcing. */
export function fulfilBatchWant(mal_id: number, torrentHash: string | null): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE wants SET status = 'fulfilled', torrent_hash = COALESCE(?, torrent_hash),
           note = NULL, updated_at = datetime('now')
         WHERE mal_id = ? AND kind = 'batch' AND status <> 'fulfilled'`,
      )
      .run(torrentHash ? torrentHash.toLowerCase() : null, mal_id).changes > 0
  )
}

/** Fulfil a specific want with the torrent that (already) provides it. */
export function fulfilWantById(id: number, torrentHash: string | null, note?: string): void {
  getDb()
    .prepare(
      `UPDATE wants SET status = 'fulfilled', torrent_hash = COALESCE(?, torrent_hash),
         note = COALESCE(?, note), updated_at = datetime('now')
       WHERE id = ? AND status <> 'fulfilled'`,
    )
    .run(torrentHash ? torrentHash.toLowerCase() : null, note ?? null, id)
}

export function getWant(id: number): WantRow | undefined {
  return getDb().prepare('SELECT * FROM wants WHERE id = ?').get(id) as WantRow | undefined
}

export interface WantWithSeries extends WantRow {
  title: string | null
  title_english: string | null
  tvdb_id: number | null
  tvdb_season: number | null
  episode_offset: number | null
  air_status: string | null
  is_movie: number | null
  series_total_episodes: number | null
}

/** Wants for the chase flow, joined to their catalog rows for the fields the
 * search pipeline needs (titles, season mapping, cached status). Least-tried
 * first so a fresh want isn't starved behind a hopeless one. */
export function listWantsJoined(args: {
  status: WantStatus
  kind?: WantKind
  respectBackoff?: boolean
}): WantWithSeries[] {
  const clauses = ['w.status = @status']
  if (args.kind) clauses.push('w.kind = @kind')
  if (args.respectBackoff !== false) {
    clauses.push(`(w.next_attempt_at IS NULL OR w.next_attempt_at <= datetime('now'))`)
  }
  return getDb()
    .prepare(
      `SELECT w.*, s.title, s.title_english, s.tvdb_id, s.tvdb_season, s.episode_offset,
              s.air_status, s.is_movie, s.total_episodes AS series_total_episodes
       FROM wants w LEFT JOIN series s ON s.mal_id = w.mal_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY w.attempts ASC, w.id ASC`,
    )
    .all({ status: args.status, kind: args.kind }) as WantWithSeries[]
}

export function listWants(status?: WantStatus): WantRow[] {
  return (
    status
      ? getDb().prepare('SELECT * FROM wants WHERE status = ? ORDER BY id').all(status)
      : getDb().prepare('SELECT * FROM wants ORDER BY id').all()
  ) as WantRow[]
}

// --- Torrent lifecycle ledger ------------------------------------------------

export type TorrentStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'imported'
  | 'exhausted'
  | 'superseded'
  | 'cleaned'
  | 'failed'

export interface TorrentRow {
  hash: string
  mal_id: number | null
  kind: string | null
  episode: number | null
  tvdb_season: number | null
  want_id: number | null
  name: string | null
  category: string | null
  provider: string | null
  size: number | null
  status: TorrentStatus
  imported_files: number
  queued_at: string
  completed_at: string | null
  imported_at: string | null
  cleaned_at: string | null
  note: string | null
  updated_at: string
}

export interface TorrentIdentity {
  hash: string
  mal_id?: number | null
  kind?: string | null
  episode?: number | null
  tvdb_season?: number | null
  want_id?: number | null
  name?: string | null
  category?: string | null
  provider?: string | null
  size?: number | null
}

/** Ledger a torrent at queue time. Re-queuing a hash we already track resets
 * it to `queued` (only reachable for `failed` rows — sink.qbittorrent refuses
 * every other status via blockedTorrentHashes). */
export function recordTorrentQueued(t: TorrentIdentity): void {
  getDb()
    .prepare(
      `INSERT INTO torrents (hash, mal_id, kind, episode, tvdb_season, want_id, name, category, provider, size, status)
       VALUES (@hash, @mal_id, @kind, @episode, @tvdb_season, @want_id, @name, @category, @provider, @size, 'queued')
       ON CONFLICT(hash) DO UPDATE SET
         mal_id=excluded.mal_id, kind=excluded.kind, episode=excluded.episode, tvdb_season=excluded.tvdb_season,
         want_id=excluded.want_id, name=excluded.name, category=excluded.category, provider=excluded.provider,
         size=excluded.size, status='queued', queued_at=datetime('now'), note=NULL, updated_at=datetime('now')`,
    )
    .run({
      hash: t.hash.toLowerCase(),
      mal_id: t.mal_id ?? null,
      kind: t.kind ?? null,
      episode: t.episode ?? null,
      tvdb_season: t.tvdb_season ?? null,
      want_id: t.want_id ?? null,
      name: t.name ?? null,
      category: t.category ?? null,
      provider: t.provider ?? null,
      size: t.size ?? null,
    })
}

/** Ledger an *observed* outcome (imported/exhausted) even for torrents queued
 * before the ledger existed — the row is created on the spot so pre-ledger
 * junk stops re-firing the import too. */
export function recordTorrentOutcome(
  t: TorrentIdentity,
  status: 'imported' | 'exhausted',
  extra?: { imported_files?: number; note?: string },
): void {
  const db = getDb()
  const hash = t.hash.toLowerCase()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO torrents (hash, mal_id, kind, episode, tvdb_season, name, category, provider, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill', 'completed')`,
    ).run(hash, t.mal_id ?? null, t.kind ?? null, t.episode ?? null, t.tvdb_season ?? null, t.name ?? null, t.category ?? null)
    db.prepare(
      `UPDATE torrents SET status = ?, imported_files = COALESCE(?, imported_files), note = COALESCE(?, note),
         mal_id = COALESCE(mal_id, ?),
         imported_at = CASE WHEN ? = 'imported' THEN datetime('now') ELSE imported_at END,
         updated_at = datetime('now')
       WHERE hash = ?`,
    ).run(status, extra?.imported_files ?? null, extra?.note ?? null, t.mal_id ?? null, status, hash)
  })
  tx()
}

/** Status transition for hashes we already track; timestamps follow the status. */
export function setTorrentStatus(
  hash: string,
  status: TorrentStatus,
  note?: string,
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE torrents SET status = ?, note = COALESCE(?, note),
           completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
           cleaned_at   = CASE WHEN ? IN ('cleaned','superseded') THEN datetime('now') ELSE cleaned_at END,
           updated_at = datetime('now')
         WHERE hash = ?`,
      )
      .run(status, note ?? null, status, status, hash.toLowerCase()).changes > 0
  )
}

/** Observation backstop: torrents seen completed in qBittorrent move off
 * queued/downloading even when no qbit-complete watcher is running. */
export function markTorrentsCompleted(hashes: string[]): void {
  if (hashes.length === 0) return
  const stmt = getDb().prepare(
    `UPDATE torrents SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
     WHERE hash = ? AND status IN ('queued', 'downloading')`,
  )
  const tx = getDb().transaction((hs: string[]) => {
    for (const h of hs) stmt.run(h.toLowerCase())
  })
  tx(hashes)
}

export function getTorrent(hash: string): TorrentRow | undefined {
  return getDb().prepare('SELECT * FROM torrents WHERE hash = ?').get(hash.toLowerCase()) as
    | TorrentRow
    | undefined
}

/** Hashes sink.qbittorrent must refuse to re-queue: everything we track except
 * `failed` (queued-but-vanished, worth retrying). Re-queuing an `exhausted`
 * torrent would loop the same junk forever; re-queuing an `imported`/`cleaned`
 * one re-downloads data the library already has. */
export function blockedTorrentHashes(): Set<string> {
  const rows = getDb().prepare(`SELECT hash FROM torrents WHERE status <> 'failed'`).all() as {
    hash: string
  }[]
  return new Set(rows.map((r) => r.hash))
}

/** Hashes whose processing is finished (nothing left for the import flow to
 * do) — union with importedTorrentHashes() for pre-ledger history. */
export function processedTorrentHashes(): Set<string> {
  const rows = getDb()
    .prepare(`SELECT hash FROM torrents WHERE status IN ('imported','exhausted','superseded','cleaned')`)
    .all() as { hash: string }[]
  return new Set(rows.map((r) => r.hash))
}

/** Record the on-disk copy of a candidate's art (see banners.ts `cacheBannerFile`). */
export function setBannerLocalFile(bannerId: number, local_file: string): void {
  getDb().prepare('UPDATE series_banners SET local_file = ? WHERE id = ?').run(local_file, bannerId)
}

/**
 * Make one candidate the selected art for its series. Clears only the rest of
 * *its own kind* — a series' banner and poster are selected independently.
 */
export function selectBanner(mal_id: number, bannerId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT id, kind FROM series_banners WHERE id = ? AND mal_id = ?')
    .get(bannerId, mal_id) as { id: number; kind: ArtKind } | undefined
  if (!row) return false
  const tx = db.transaction(() => {
    db.prepare('UPDATE series_banners SET selected = 0 WHERE mal_id = ? AND kind = ?').run(mal_id, row.kind)
    db.prepare('UPDATE series_banners SET selected = 1 WHERE id = ?').run(bannerId)
  })
  tx()
  return true
}

/** Delete a candidate; returns the deleted row (so callers can drop its file). */
export function deleteBanner(mal_id: number, bannerId: number): BannerRow | undefined {
  const row = getBanner(bannerId)
  if (!row || row.mal_id !== mal_id) return undefined
  getDb().prepare('DELETE FROM series_banners WHERE id = ?').run(bannerId)
  return row
}

export function upsertEpisodes(mal_id: number, episodes: EpisodeRow[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO series_episodes (mal_id, number, title, title_japanese, aired, updated_at)
    VALUES (@mal_id, @number, @title, @title_japanese, @aired, datetime('now'))
    ON CONFLICT(mal_id, number) DO UPDATE SET
      title = excluded.title,
      title_japanese = excluded.title_japanese,
      aired = excluded.aired,
      updated_at = excluded.updated_at
  `)
  const tx = getDb().transaction((rows: EpisodeRow[]) => {
    for (const e of rows) {
      if (!Number.isFinite(e.number)) continue
      stmt.run({
        mal_id,
        number: e.number,
        title: e.title ?? null,
        title_japanese: e.title_japanese ?? null,
        aired: e.aired ?? null,
      })
    }
  })
  tx(episodes)
}
