// Flow persistence in series.sqlite. On first use the table is seeded with a
// flow that mirrors the hardcoded image-sourcing chain in sync.ts, so the
// editor opens onto something real instead of a blank canvas.

import { getDb } from './db.js'
import type { FlowComponentMeta } from './flowComponents.js'
import type { FlowGraph } from './flowExecutor.js'

export interface FlowRow {
  id: number
  name: string
  description: string | null
  graph: string // JSON FlowGraph
  component: string | null
  enabled: number // 0 = automation off (schedules + event triggers skip it)
  created_at: string
  updated_at: string
}

export interface FlowSummary {
  id: number
  name: string
  description: string | null
  node_count: number
  published: boolean
  enabled: boolean
  updated_at: string
}

let ready = false

function db() {
  const instance = getDb()
  if (!ready) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        graph TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Rolling activity log: one row per flow run (editor or MCP), pruned to
      -- the most recent RUN_LOG_LIMIT. activity is a distilled JSON array of the
      -- meaningful per-node notes (metadata writes, downloads, imports, …).
      CREATE TABLE IF NOT EXISTS flow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id INTEGER,
        flow_name TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        activity TEXT NOT NULL DEFAULT '[]'
      );
      -- Scheduled flow runs: the scheduler (server/scheduler.ts) ticks these and
      -- fires the referenced flow when next_run is due. kind/spec describe the
      -- cadence (interval | daily | weekly | once); see computeNextRun.
      CREATE TABLE IF NOT EXISTS flow_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id INTEGER NOT NULL,
        name TEXT,
        kind TEXT NOT NULL,
        spec TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run TEXT,
        last_run TEXT,
        last_run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Event-trigger watermark: which events (item ids / airing keys) an event
      -- trigger has already fired for, so the watcher (server/scheduler.ts)
      -- doesn't re-fire. See triggerStateHas/Add.
      CREATE TABLE IF NOT EXISTS trigger_state (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (kind, key)
      );
      -- Marks that an event-trigger kind's first watcher pass has seeded current
      -- state (so a deploy doesn't fire for the whole existing library at once).
      CREATE TABLE IF NOT EXISTS trigger_seeded (
        kind TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Singleton Flow Map layout: group positions + freeform sticky notes.
      -- Shared across admins (unlike localStorage). id is always 1.
      CREATE TABLE IF NOT EXISTS flow_map (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    const cols = instance.prepare(`PRAGMA table_info(flows)`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'component')) {
      instance.exec(`ALTER TABLE flows ADD COLUMN component TEXT`)
    }
    // enabled = 0 turns a flow's automation off: its schedules roll forward
    // without running and event triggers (trigger.new-item / trigger.release /
    // …) no longer treat it as a subscriber. Manual runs stay allowed.
    if (!cols.some((c) => c.name === 'enabled')) {
      instance.exec(`ALTER TABLE flows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`)
    }
    // A schedule can target a trigger name (fires every flow with that trigger)
    // instead of a single flow_id; legacy flow_id rows keep working.
    const schedCols = instance.prepare(`PRAGMA table_info(flow_schedules)`).all() as { name: string }[]
    if (!schedCols.some((c) => c.name === 'trigger_name')) {
      instance.exec(`ALTER TABLE flow_schedules ADD COLUMN trigger_name TEXT`)
    }
    ready = true
    seedFlows(instance)
  }
  return instance
}

// The sync.ts image-sourcing chain as a graph: items missing art that Jellyfin
// can't supply go through the indexer-title match, then Jikan, and every
// branch converges on the portal write.
const SEED_GRAPH: FlowGraph = {
  nodes: [
    { id: 'src', type: 'source.jellyfin', position: { x: 0, y: 160 }, config: { itemTypes: 'Movie,Series' } },
    { id: 'noimg', type: 'filter.field', position: { x: 280, y: 60 }, config: { field: 'image_url', mode: 'empty', value: '' } },
    { id: 'nojf', type: 'filter.field', position: { x: 560, y: 0 }, config: { field: 'has_primary_image', mode: 'equals', value: '0' } },
    { id: 'match', type: 'enrich.indexer-match', position: { x: 840, y: 0 }, config: { setField: 'image_url', fromField: 'image_url' } },
    { id: 'jikan', type: 'enrich.jikan', position: { x: 1120, y: 60 }, config: { setField: 'image_url', queryField: 'name', maxItems: 25 } },
    { id: 'merge', type: 'combine.merge', position: { x: 1400, y: 220 }, config: {} },
    { id: 'sink', type: 'sink.portal-upsert', position: { x: 1660, y: 220 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'src', sourceHandle: 'items', target: 'noimg', targetHandle: 'in' },
    { id: 'e2', source: 'noimg', sourceHandle: 'pass', target: 'nojf', targetHandle: 'in' },
    { id: 'e3', source: 'noimg', sourceHandle: 'fail', target: 'merge', targetHandle: 'in' },
    { id: 'e4', source: 'nojf', sourceHandle: 'pass', target: 'match', targetHandle: 'in' },
    { id: 'e5', source: 'nojf', sourceHandle: 'fail', target: 'merge', targetHandle: 'in' },
    { id: 'e6', source: 'match', sourceHandle: 'matched', target: 'merge', targetHandle: 'in' },
    { id: 'e7', source: 'match', sourceHandle: 'unmatched', target: 'jikan', targetHandle: 'in' },
    { id: 'e8', source: 'jikan', sourceHandle: 'found', target: 'merge', targetHandle: 'in' },
    { id: 'e9', source: 'jikan', sourceHandle: 'missed', target: 'merge', targetHandle: 'in' },
    { id: 'e10', source: 'merge', sourceHandle: 'items', target: 'sink', targetHandle: 'in' },
  ],
}

// Indexer titles that Jellyfin doesn't have → look up airing status → torrent
// search on TsukiHime (season pack if finished, recent episodes if airing;
// 1080p, dual audio preferred) → qBittorrent. TsukiHime because it season-pins
// reliably via the status node's tsuki_id. Ends at qbit; never touches the
// portal DB.
const MISSING_VIDEOS_GRAPH: FlowGraph = {
  nodes: [
    { id: 'idx', type: 'source.indexer', position: { x: 0, y: 0 }, config: {} },
    { id: 'por', type: 'source.portal', position: { x: 0, y: 240 }, config: { type: '' } },
    { id: 'diff', type: 'combine.diff', position: { x: 280, y: 110 }, config: { fieldA: 'title', fieldB: 'name', fieldB2: 'original_title' } },
    { id: 'lim', type: 'filter.limit', position: { x: 560, y: 60 }, config: { count: 5 } },
    { id: 'st', type: 'enrich.anime-status', position: { x: 820, y: 60 }, config: { malField: 'mal_id', maxItems: 0 } },
    { id: 'tpl', type: 'transform.template', position: { x: 1100, y: 20 }, config: { field: 'torrent_query', template: '{title} 1080p' } },
    // TsukiHime: it tags each release with its per-season anime id (so the season
    // pin from the Anime status node's tsuki_id is reliable — AnimeTosho mis-tags
    // some seasons) and structured audio langs. It reports no seeders, so
    // minSeeders=0.
    { id: 'tor', type: 'enrich.torrent-search', position: { x: 1380, y: 20 }, config: { provider: 'tsukihime', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, preferDualAudio: true, requireDualAudio: false, excludeCodecs: 'av1', minSeeders: 0, minTitleMatch: 0.5, maxEpisodes: 26, maxItems: 0 } },
    { id: 'qb', type: 'sink.qbittorrent', position: { x: 1680, y: 90 }, config: { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false } },
  ],
  edges: [
    { id: 'e1', source: 'idx', sourceHandle: 'items', target: 'diff', targetHandle: 'a' },
    { id: 'e2', source: 'por', sourceHandle: 'items', target: 'diff', targetHandle: 'b' },
    { id: 'e3', source: 'diff', sourceHandle: 'missing', target: 'lim', targetHandle: 'in' },
    { id: 'e4', source: 'lim', sourceHandle: 'items', target: 'st', targetHandle: 'in' },
    { id: 'e5', source: 'st', sourceHandle: 'out', target: 'tpl', targetHandle: 'in' },
    { id: 'e6', source: 'st', sourceHandle: 'unknown', target: 'tpl', targetHandle: 'in' },
    { id: 'e7', source: 'tpl', sourceHandle: 'items', target: 'tor', targetHandle: 'in' },
    { id: 'e8', source: 'tor', sourceHandle: 'found', target: 'qb', targetHandle: 'in' },
  ],
}

// Completed qBittorrent downloads → placed in the media library, and kept at the
// best *playable* quality. Expands each torrent into its files, matches back to
// the catalog for a mal_id, pulls metadata (year → import path), probes each
// file's audio/video/subtitle facts, then:
//   • scores each file playability-first: import_score = playable*2 + dual, where
//     "playable" = video codec the Tesla T4 can HW-decode (anything but AV1) and
//     "dual" = carries an English dub. So a playable sub-only (2) beats an AV1
//     dual (1): we never import an unplayable AV1 as the winner;
//   • picks the best per episode. When the winner is a playable sub (score 2) and
//     a dual loser exists for that episode, it MUXES the loser's English track
//     onto the playable video (stream copy, no re-encode → h264+jpn+eng) and
//     imports that — manufacturing a playable dual-audio file. Dual losers used
//     this way are kept (donors), not deleted;
//   • for playable-sub shows with no dual on hand, searches for a dual release
//     (AV1 allowed — it's only a donor) and queues it; next run it downloads and
//     becomes the donor for the mux;
//   • keeps or fetches a wanted-language subtitle, hardlinks the winner into the
//     library (overwriting a superseded file), deletes non-donor superseded
//     torrents, and refreshes Jellyfin.
// Run on a schedule: each pass imports new downloads, muxes where it can, and
// hunts donors, settling once every show is playable dual-audio. Needs the
// downloads + library dirs mounted into the pod (see mcp/README.md / CLAUDE.md).
const LIBRARY_IMPORT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'qb', type: 'source.qbittorrent', position: { x: 0, y: 300 }, config: { category: 'anime', completedOnly: true, pathFrom: '', pathTo: '' } },
    { id: 'exp', type: 'transform.expand-files', position: { x: 260, y: 300 }, config: { pathField: 'content_path', extensions: 'mkv,mp4' } },
    // Parse the season from the torrent name so match can route a file to the
    // right cour of a franchise whose per-season titles are identical (e.g.
    // Mushoku Tensei S1/S2/S3 all share "Mushoku Tensei").
    { id: 'pseason', type: 'transform.parse-season', position: { x: 390, y: 300 }, config: { sourceField: 'name', targetField: 'release_season' } },
    { id: 'match', type: 'enrich.indexer-match', position: { x: 520, y: 300 }, config: { setField: 'mal_id', fromField: 'mal_id', queryField: 'name', matchMode: 'tokens', threshold: 0.6, seasonField: 'release_season' } },
    { id: 'meta', type: 'enrich.metadata', position: { x: 780, y: 220 }, config: { malField: 'mal_id', writeDb: true, maxItems: 0 } },
    { id: 'probe', type: 'enrich.media-probe', position: { x: 1040, y: 300 }, config: { fileField: 'file_path' } },
    // Split identified files (scorable/upgradable) from unmatched ones (import as-is).
    { id: 'hasId', type: 'filter.field', position: { x: 1300, y: 300 }, config: { field: 'mal_id', mode: 'not-empty', value: '' } },
    // Flag dual audio (has an English dub) as dualFlag 1/0.
    { id: 'dualCmp', type: 'filter.compare', position: { x: 1560, y: 220 }, config: { field: 'audio_langs', op: 'contains', value: 'eng' } },
    { id: 'dualT1', type: 'transform.template', position: { x: 1820, y: 140 }, config: { field: 'dualFlag', template: '1' } },
    { id: 'dualT0', type: 'transform.template', position: { x: 1820, y: 300 }, config: { field: 'dualFlag', template: '0' } },
    // Flag playability (T4 can HW-decode anything but AV1) as playFlag 1/0.
    { id: 'playCmp', type: 'filter.compare', position: { x: 2080, y: 220 }, config: { field: 'video_codec', op: 'ne', value: 'av1' } },
    { id: 'playT1', type: 'transform.template', position: { x: 2340, y: 140 }, config: { field: 'playFlag', template: '1' } },
    { id: 'playT0', type: 'transform.template', position: { x: 2340, y: 300 }, config: { field: 'playFlag', template: '0' } },
    // import_score = playable*2 + dual → playable-dual 3 > playable-sub 2 > av1-dual 1 > av1-sub 0.
    { id: 'scoreC', type: 'transform.compute', position: { x: 2600, y: 220 }, config: { field: 'import_score', expr: '{playFlag} * 2 + {dualFlag}' } },
    { id: 'keyTpl', type: 'transform.template', position: { x: 2860, y: 220 }, config: { field: 'group_key', template: '{mal_id}|{torrent_episode}' } },
    // Best playable release per episode. Losers ("rest") are donors or deletion candidates.
    { id: 'pick', type: 'combine.group-pick', position: { x: 3120, y: 220 }, config: { groupField: 'group_key', sortField: 'import_score', direction: 'desc', perGroup: 1 } },
    // Winners needing a dub: playable but sub-only (import_score == 2) → try to mux.
    { id: 'needMux', type: 'filter.compare', position: { x: 3380, y: 120 }, config: { field: 'import_score', op: 'eq', value: '2' } },
    // Losers with a dub (dualFlag == 1) can donate their English track; the rest are deletable.
    { id: 'restDonor', type: 'filter.compare', position: { x: 3380, y: 460 }, config: { field: 'dualFlag', op: 'eq', value: '1' } },
    // Pair each mux candidate with a same-episode donor, copying its path to donor_path.
    { id: 'donorJoin', type: 'combine.join', position: { x: 3640, y: 200 }, config: { keyField: 'group_key', copyFrom: 'file_path', copyTo: 'donor_path' } },
    // Manufacture the playable dual file: primary video + donor eng audio, -c copy.
    { id: 'mux', type: 'enrich.mux-tracks', position: { x: 3900, y: 140 }, config: { fileField: 'file_path', donorField: 'donor_path', audioLang: 'eng', subLang: '', audioOffset: 0, setDefaultAudio: 'jpn', outDir: '' } },
    // Only delete a torrent none of whose episodes we're keeping, and never a donor.
    { id: 'safeDel', type: 'combine.diff', position: { x: 3640, y: 560 }, config: { fieldA: 'torrent_hash', fieldB: 'torrent_hash', fieldB2: '' } },
    { id: 'delDed', type: 'filter.dedupe', position: { x: 3900, y: 560 }, config: { field: 'torrent_hash' } },
    { id: 'del', type: 'sink.qbittorrent-delete', position: { x: 4160, y: 560 }, config: { hashField: 'torrent_hash', deleteFiles: true } },
    // Donor hunt: playable-sub shows with no dub on hand → find a dual release.
    { id: 'upDed', type: 'filter.dedupe', position: { x: 3900, y: 720 }, config: { field: 'mal_id' } },
    { id: 'status', type: 'enrich.anime-status', position: { x: 4160, y: 720 }, config: { malField: 'mal_id', maxItems: 0 } },
    { id: 'upTpl', type: 'transform.template', position: { x: 4420, y: 720 }, config: { field: 'torrent_query', template: '{title_english} 1080p' } },
    // TsukiHime: per-season anime id (reliable season pin) + structured audio
    // langs (dual detected without title-guessing); no seeders → minSeeders=0.
    // AV1 is allowed here — the donor is only muxed for its audio, never played.
    { id: 'search', type: 'enrich.torrent-search', position: { x: 4680, y: 720 }, config: { provider: 'tsukihime', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, preferDualAudio: true, requireDualAudio: true, excludeCodecs: '', minSeeders: 0, minTitleMatch: 0.4, maxEpisodes: 26, maxItems: 0 } },
    { id: 'upQb', type: 'sink.qbittorrent', position: { x: 4940, y: 720 }, config: { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false } },
    // Import path (winners: as-is, muxed, or sub-only-no-donor + unmatched files).
    { id: 'preSub', type: 'combine.merge', position: { x: 4160, y: 220 }, config: {} },
    { id: 'cmp', type: 'filter.compare', position: { x: 4420, y: 220 }, config: { field: 'sub_langs', op: 'contains', value: 'eng' } },
    { id: 'ext', type: 'enrich.extract-subs', position: { x: 4680, y: 140 }, config: { fileField: 'file_path', lang: 'eng' } },
    { id: 'fetch', type: 'enrich.fetch-subs', position: { x: 4680, y: 300 }, config: { queryField: 'title_english', episodeField: 'torrent_episode', lang: 'eng' } },
    { id: 'mg', type: 'combine.merge', position: { x: 4940, y: 220 }, config: {} },
    // overwrite=true so a manufactured/upgraded dual replaces the old sub-only
    // file; the sink skips re-placing an unchanged file so re-runs don't churn.
    { id: 'imp', type: 'sink.library-import', position: { x: 5200, y: 220 }, config: { fileField: 'file_path', libraryRoot: '', showField: 'title_english', method: 'hardlink', overwrite: true } },
    { id: 'scan', type: 'sink.jellyfin-scan', position: { x: 5460, y: 220 }, config: {} },
    { id: 'coll', type: 'sink.jellyfin-collection', position: { x: 5720, y: 220 }, config: { nameField: 'title_english', itemType: 'Series', waitSeconds: 120 } },
  ],
  edges: [
    { id: 'e1', source: 'qb', sourceHandle: 'items', target: 'exp', targetHandle: 'in' },
    { id: 'e2', source: 'exp', sourceHandle: 'files', target: 'pseason', targetHandle: 'in' },
    { id: 'e2b', source: 'pseason', sourceHandle: 'out', target: 'match', targetHandle: 'in' },
    { id: 'e3', source: 'match', sourceHandle: 'matched', target: 'meta', targetHandle: 'in' },
    // Unmatched files still import (just without our metadata / clean year).
    { id: 'e4', source: 'match', sourceHandle: 'unmatched', target: 'probe', targetHandle: 'in' },
    { id: 'e5', source: 'meta', sourceHandle: 'enriched', target: 'probe', targetHandle: 'in' },
    { id: 'e6', source: 'meta', sourceHandle: 'skipped', target: 'probe', targetHandle: 'in' },
    { id: 'e7', source: 'probe', sourceHandle: 'probed', target: 'hasId', targetHandle: 'in' },
    // Identified files go through quality scoring; unmatched ones import as-is.
    { id: 'e8', source: 'hasId', sourceHandle: 'pass', target: 'dualCmp', targetHandle: 'in' },
    { id: 'e9', source: 'hasId', sourceHandle: 'fail', target: 'preSub', targetHandle: 'in' },
    // Dual flag, then play flag (filter nodes merge all inbound edges, so the
    // pass/fail halves reconverge implicitly without a merge node).
    { id: 'e10', source: 'dualCmp', sourceHandle: 'pass', target: 'dualT1', targetHandle: 'in' },
    { id: 'e11', source: 'dualCmp', sourceHandle: 'fail', target: 'dualT0', targetHandle: 'in' },
    { id: 'e12', source: 'dualT1', sourceHandle: 'items', target: 'playCmp', targetHandle: 'in' },
    { id: 'e13', source: 'dualT0', sourceHandle: 'items', target: 'playCmp', targetHandle: 'in' },
    { id: 'e14', source: 'playCmp', sourceHandle: 'pass', target: 'playT1', targetHandle: 'in' },
    { id: 'e15', source: 'playCmp', sourceHandle: 'fail', target: 'playT0', targetHandle: 'in' },
    { id: 'e16', source: 'playT1', sourceHandle: 'items', target: 'scoreC', targetHandle: 'in' },
    { id: 'e17', source: 'playT0', sourceHandle: 'items', target: 'scoreC', targetHandle: 'in' },
    { id: 'e18', source: 'scoreC', sourceHandle: 'ok', target: 'keyTpl', targetHandle: 'in' },
    { id: 'e19', source: 'keyTpl', sourceHandle: 'items', target: 'pick', targetHandle: 'in' },
    // Winners → split by "needs a dub"; all winners protect their torrent from deletion.
    { id: 'e20', source: 'pick', sourceHandle: 'picked', target: 'needMux', targetHandle: 'in' },
    { id: 'e21', source: 'pick', sourceHandle: 'picked', target: 'safeDel', targetHandle: 'b' },
    { id: 'e22', source: 'needMux', sourceHandle: 'pass', target: 'donorJoin', targetHandle: 'primary' },
    { id: 'e23', source: 'needMux', sourceHandle: 'fail', target: 'preSub', targetHandle: 'in' },
    // Losers: dubbed ones become donors (kept); the rest are deletion candidates.
    { id: 'e24', source: 'pick', sourceHandle: 'rest', target: 'restDonor', targetHandle: 'in' },
    { id: 'e25', source: 'restDonor', sourceHandle: 'pass', target: 'donorJoin', targetHandle: 'donor' },
    { id: 'e26', source: 'restDonor', sourceHandle: 'fail', target: 'safeDel', targetHandle: 'a' },
    // Paired → mux; unpaired sub-only → import as-is *and* hunt a donor.
    { id: 'e27', source: 'donorJoin', sourceHandle: 'joined', target: 'mux', targetHandle: 'in' },
    { id: 'e28', source: 'donorJoin', sourceHandle: 'unmatched', target: 'preSub', targetHandle: 'in' },
    { id: 'e29', source: 'donorJoin', sourceHandle: 'unmatched', target: 'upDed', targetHandle: 'in' },
    { id: 'e30', source: 'mux', sourceHandle: 'muxed', target: 'preSub', targetHandle: 'in' },
    { id: 'e31', source: 'mux', sourceHandle: 'skipped', target: 'preSub', targetHandle: 'in' },
    // Superseded non-donor losers whose torrent keeps no winning episode → delete.
    { id: 'e32', source: 'safeDel', sourceHandle: 'missing', target: 'delDed', targetHandle: 'in' },
    { id: 'e33', source: 'delDed', sourceHandle: 'items', target: 'del', targetHandle: 'in' },
    // Donor hunt: one search per still-dubless show → queue the dual release.
    { id: 'e34', source: 'upDed', sourceHandle: 'items', target: 'status', targetHandle: 'in' },
    { id: 'e35', source: 'status', sourceHandle: 'out', target: 'upTpl', targetHandle: 'in' },
    { id: 'e36', source: 'status', sourceHandle: 'unknown', target: 'upTpl', targetHandle: 'in' },
    { id: 'e37', source: 'upTpl', sourceHandle: 'items', target: 'search', targetHandle: 'in' },
    { id: 'e38', source: 'search', sourceHandle: 'found', target: 'upQb', targetHandle: 'in' },
    // Subtitle handling on the import stream: keep an embedded track or fetch one.
    { id: 'e39', source: 'preSub', sourceHandle: 'items', target: 'cmp', targetHandle: 'in' },
    { id: 'e40', source: 'cmp', sourceHandle: 'pass', target: 'ext', targetHandle: 'in' },
    { id: 'e41', source: 'cmp', sourceHandle: 'fail', target: 'fetch', targetHandle: 'in' },
    // Every branch converges on import — never drop a file just because subs failed.
    { id: 'e42', source: 'ext', sourceHandle: 'extracted', target: 'mg', targetHandle: 'in' },
    { id: 'e43', source: 'ext', sourceHandle: 'none', target: 'mg', targetHandle: 'in' },
    { id: 'e44', source: 'fetch', sourceHandle: 'found', target: 'mg', targetHandle: 'in' },
    { id: 'e45', source: 'fetch', sourceHandle: 'missed', target: 'mg', targetHandle: 'in' },
    { id: 'e46', source: 'mg', sourceHandle: 'items', target: 'imp', targetHandle: 'in' },
    { id: 'e47', source: 'imp', sourceHandle: 'imported', target: 'scan', targetHandle: 'in' },
    { id: 'e48', source: 'scan', sourceHandle: 'items', target: 'coll', targetHandle: 'in' },
  ],
}

// Seeds are versioned via SQLite's user_version so later releases can add
// flows to existing databases without re-creating deleted ones.
const SEED_VERSION = 4

function seedFlows(instance: ReturnType<typeof getDb>) {
  const insert = instance.prepare('INSERT INTO flows (name, description, graph) VALUES (?, ?, ?)')
  const count = (instance.prepare('SELECT COUNT(*) AS c FROM flows').get() as { c: number }).c
  const version = instance.pragma('user_version', { simple: true }) as number
  if (count === 0 && version < 1) {
    insert.run(
      'Image sourcing',
      'How portal artwork is filled in: Jellyfin first, then the indexer catalog, then Jikan. Mirrors the built-in sync.',
      JSON.stringify(SEED_GRAPH),
    )
  }
  if (version < 2) {
    insert.run(
      'Missing videos',
      'Finds indexer titles with no matching portal item, picks a 1080p dual-audio release (season pack if finished, recent episodes if airing) with live seeders, and queues it in qBittorrent.',
      JSON.stringify(MISSING_VIDEOS_GRAPH),
    )
  }
  if (version < 3) {
    insert.run(
      'Library import',
      'Places completed qBittorrent downloads into the media library and keeps them at the best *playable* quality: expand to files, score playability-first (a playable sub-only beats an unplayable AV1 dual), pick the best per episode, and manufacture a playable dual-audio file by muxing a dual loser’s English track onto the playable video (stream copy, no re-encode). Hunts a dual donor for still-dubless shows (AV1 allowed — donors are never played), keeps or fetches a subtitle, hardlinks into the library (replacing superseded files, deleting non-donor torrents), refreshes Jellyfin. Needs the downloads + library dirs mounted into the pod.',
      JSON.stringify(LIBRARY_IMPORT_GRAPH),
    )
  }
  if (version < SEED_VERSION) instance.pragma(`user_version = ${SEED_VERSION}`)
}

export function listFlows(): FlowSummary[] {
  const rows = db().prepare('SELECT * FROM flows ORDER BY updated_at DESC').all() as FlowRow[]
  return rows.map((r) => {
    let nodeCount = 0
    try {
      nodeCount = (JSON.parse(r.graph) as FlowGraph).nodes.length
    } catch {
      /* corrupt graph JSON — surfaced as 0 nodes */
    }
    const meta = parseComponent(r.component)
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      node_count: nodeCount,
      published: !!meta?.published,
      enabled: !!r.enabled,
      updated_at: r.updated_at,
    }
  })
}

export function listFlowGraphs(): { id: number; name: string; graph: string }[] {
  return db().prepare('SELECT id, name, graph FROM flows').all() as {
    id: number
    name: string
    graph: string
  }[]
}

/** Full graphs for the read-only Flow Map (sorted by name). */
export function listFlowsForMap(): {
  id: number
  name: string
  description: string | null
  published: boolean
  updated_at: string
  graph: FlowGraph
}[] {
  const rows = db().prepare('SELECT * FROM flows ORDER BY name COLLATE NOCASE ASC').all() as FlowRow[]
  return rows.map((r) => {
    let graph: FlowGraph = { nodes: [], edges: [] }
    try {
      graph = JSON.parse(r.graph) as FlowGraph
    } catch {
      /* corrupt — empty */
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      published: !!parseComponent(r.component)?.published,
      updated_at: r.updated_at,
      graph,
    }
  })
}

/** Shared Flow Map layout + sticky notes (singleton row). */
export interface FlowMapNote {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  color?: string
}

export interface FlowMapState {
  /** flowId string → absolute group position on the map canvas. */
  layout: Record<string, { x: number; y: number }>
  notes: FlowMapNote[]
}

const EMPTY_MAP_STATE: FlowMapState = { layout: {}, notes: [] }

function parseMapState(raw: string | undefined | null): FlowMapState {
  if (!raw) return { ...EMPTY_MAP_STATE, layout: {}, notes: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<FlowMapState>
    const layout =
      parsed.layout && typeof parsed.layout === 'object' && !Array.isArray(parsed.layout)
        ? (parsed.layout as FlowMapState['layout'])
        : {}
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter(
          (n): n is FlowMapNote =>
            !!n &&
            typeof n === 'object' &&
            typeof (n as FlowMapNote).id === 'string' &&
            typeof (n as FlowMapNote).x === 'number' &&
            typeof (n as FlowMapNote).y === 'number',
        )
      : []
    return { layout, notes }
  } catch {
    return { ...EMPTY_MAP_STATE, layout: {}, notes: [] }
  }
}

export function getFlowMapState(): FlowMapState {
  const row = db().prepare('SELECT state FROM flow_map WHERE id = 1').get() as
    | { state: string }
    | undefined
  return parseMapState(row?.state)
}

export function saveFlowMapState(state: FlowMapState): FlowMapState {
  const cleaned: FlowMapState = {
    layout: state.layout ?? {},
    notes: (state.notes ?? []).map((n) => ({
      id: String(n.id),
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.max(80, Math.round(n.width || 180)),
      height: Math.max(60, Math.round(n.height || 120)),
      text: String(n.text ?? ''),
      ...(n.color ? { color: String(n.color) } : {}),
    })),
  }
  db()
    .prepare(
      `INSERT INTO flow_map (id, state, updated_at) VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(cleaned))
  return cleaned
}

// Only flows whose automation is on — what schedules and event triggers fan
// out over. Structural consumers (component references, the editor) keep using
// listFlowGraphs: a disabled flow still exists, it just doesn't fire.
function listActiveFlowGraphs(): { id: number; name: string; graph: string }[] {
  return db().prepare('SELECT id, name, graph FROM flows WHERE enabled = 1').all() as {
    id: number
    name: string
    graph: string
  }[]
}

export function getFlow(id: number): FlowRow | undefined {
  return db().prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined
}

// The trigger.start names declared in a flow graph (deduped, non-empty).
function triggerNamesOf(graphJson: string): string[] {
  try {
    const g = JSON.parse(graphJson) as { nodes?: { type?: string; config?: Record<string, unknown> }[] }
    const names = (g.nodes ?? [])
      .filter((n) => n.type === 'trigger.start')
      .map((n) => String(n.config?.name ?? '').trim())
      .filter(Boolean)
    return [...new Set(names)]
  } catch {
    return []
  }
}

// Enabled flows whose graph contains a trigger.start with the given name — the
// subscribers a fireTrigger(name) publish fans out to (server/flowRoutes.ts).
export function flowsWithTrigger(name: string): { id: number; name: string; graph: string }[] {
  return listActiveFlowGraphs().filter((f) => triggerNamesOf(f.graph).includes(name))
}

// Distinct trigger names across all flows, sorted — for the schedule target
// picker (GET /api/flows/triggers).
export function listTriggerNames(): string[] {
  const names = new Set<string>()
  for (const f of listFlowGraphs()) for (const n of triggerNamesOf(f.graph)) names.add(n)
  return [...names].sort()
}

// Does a graph contain a node of the given type? (event-trigger subscriber check)
function graphHasNodeType(graphJson: string, type: string): boolean {
  try {
    const g = JSON.parse(graphJson) as { nodes?: { type?: string }[] }
    return (g.nodes ?? []).some((n) => n.type === type)
  } catch {
    return false
  }
}

// Enabled flows whose graph contains a node of the given type — the subscribers
// an event trigger (trigger.new-item / trigger.release) fires
// (server/flowRoutes.ts). Disabled flows also stop their watcher from polling
// (server/scheduler.ts gates each watcher on this being non-empty).
export function flowsWithTriggerType(type: string): { id: number; name: string; graph: string }[] {
  return listActiveFlowGraphs().filter((f) => graphHasNodeType(f.graph, type))
}

// --- Event-trigger watermark state ---------------------------------------
// Records which events an event trigger has already fired for, so a watcher
// tick doesn't re-fire (see server/scheduler.ts). `kind` is the trigger kind
// ('new-item' | 'release'); `key` identifies the event (item id / airing key).

export function triggerStateHas(kind: string, key: string): boolean {
  return (
    db().prepare('SELECT 1 FROM trigger_state WHERE kind = ? AND key = ?').get(kind, key) !== undefined
  )
}

export function triggerStateAdd(kind: string, keys: string[]): void {
  if (keys.length === 0) return
  const stmt = db().prepare('INSERT OR IGNORE INTO trigger_state (kind, key) VALUES (?, ?)')
  const tx = db().transaction((ks: string[]) => {
    for (const k of ks) stmt.run(kind, k)
  })
  tx(keys)
}

// True once a kind has been seeded — the first watcher pass records current
// state without firing (so a deploy doesn't fire for the whole existing library
// / everything already aired this week).
export function triggerStateSeeded(kind: string): boolean {
  return (
    db().prepare('SELECT 1 FROM trigger_seeded WHERE kind = ?').get(kind) !== undefined
  )
}

export function markTriggerSeeded(kind: string): void {
  db().prepare('INSERT OR IGNORE INTO trigger_seeded (kind) VALUES (?)').run(kind)
}

export function parseComponent(raw: string | null): FlowComponentMeta | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as FlowComponentMeta
  } catch {
    return null
  }
}

export function listPublishedComponents(): { row: FlowRow; graph: FlowGraph; meta: FlowComponentMeta }[] {
  const rows = db().prepare(`SELECT * FROM flows WHERE component IS NOT NULL`).all() as FlowRow[]
  return rows
    .map((row) => {
      const meta = parseComponent(row.component)
      if (!meta?.published) return null
      try {
        return { row, graph: JSON.parse(row.graph) as FlowGraph, meta }
      } catch {
        return null
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

export function createFlow(name: string, description: string | null): FlowRow {
  const empty: FlowGraph = { nodes: [], edges: [] }
  const info = db()
    .prepare('INSERT INTO flows (name, description, graph) VALUES (?, ?, ?)')
    .run(name, description, JSON.stringify(empty))
  return getFlow(Number(info.lastInsertRowid))!
}

export function updateFlow(
  id: number,
  patch: {
    name?: string
    description?: string | null
    graph?: FlowGraph
    component?: FlowComponentMeta | null
    enabled?: boolean
  },
): FlowRow | undefined {
  const existing = getFlow(id)
  if (!existing) return undefined
  db()
    .prepare(
      `UPDATE flows SET name = ?, description = ?, graph = ?, component = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(
      patch.name ?? existing.name,
      patch.description === undefined ? existing.description : patch.description,
      patch.graph ? JSON.stringify(patch.graph) : existing.graph,
      patch.component === undefined
        ? existing.component
        : patch.component
          ? JSON.stringify(patch.component)
          : null,
      patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
      id,
    )
  return getFlow(id)
}

export function deleteFlow(id: number): boolean {
  const instance = db()
  // Cascade: a schedule pointing at a deleted flow can never run.
  instance.prepare('DELETE FROM flow_schedules WHERE flow_id = ?').run(id)
  return instance.prepare('DELETE FROM flows WHERE id = ?').run(id).changes > 0
}

// --- Activity log --------------------------------------------------------

// One node's contribution to a run, as shown in the activity feed.
export interface RunActivity {
  node: string // human label, e.g. "Import to library"
  type: string // node type, e.g. "sink.library-import"
  status: 'ok' | 'error' | 'skipped'
  notes: string[]
  error?: string
}

export interface FlowRunRecord {
  flow_id: number | null
  flow_name: string
  dry_run: boolean
  ok: boolean
  error: string | null
  started_at: string
  duration_ms: number
  activity: RunActivity[]
}

export interface FlowRunRow {
  id: number
  flow_id: number | null
  flow_name: string
  dry_run: boolean
  ok: boolean
  error: string | null
  started_at: string
  duration_ms: number
  activity: RunActivity[]
}

// Sized for the wants era: an hourly chase + event fires churn history faster
// than the old 3h schedules did.
const RUN_LOG_LIMIT = 400

// Returns the id of the inserted flow_runs row (so a scheduled fire can record
// which run it produced in flow_schedules.last_run_id).
export function recordRun(run: FlowRunRecord): number {
  const instance = db()
  const info = instance
    .prepare(
      `INSERT INTO flow_runs (flow_id, flow_name, dry_run, ok, error, started_at, duration_ms, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.flow_id,
      run.flow_name,
      run.dry_run ? 1 : 0,
      run.ok ? 1 : 0,
      run.error,
      run.started_at,
      Math.round(run.duration_ms),
      JSON.stringify(run.activity),
    )
  // Keep the log rolling: drop everything past the newest RUN_LOG_LIMIT rows.
  instance
    .prepare(
      `DELETE FROM flow_runs WHERE id NOT IN (SELECT id FROM flow_runs ORDER BY id DESC LIMIT ?)`,
    )
    .run(RUN_LOG_LIMIT)
  return Number(info.lastInsertRowid)
}

export function listRuns(limit = 100): FlowRunRow[] {
  const rows = db()
    .prepare('SELECT * FROM flow_runs ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(limit, RUN_LOG_LIMIT))) as (Omit<FlowRunRow, 'dry_run' | 'ok' | 'activity'> & {
    dry_run: number
    ok: number
    activity: string
  })[]
  return rows.map((r) => {
    let activity: RunActivity[] = []
    try {
      activity = JSON.parse(r.activity) as RunActivity[]
    } catch {
      /* corrupt activity JSON — surfaced as empty */
    }
    return { ...r, dry_run: r.dry_run === 1, ok: r.ok === 1, activity }
  })
}

// --- Schedules -----------------------------------------------------------

// Cadence spec, discriminated by ScheduleRow.kind. Validated at the REST edge
// (parseScheduleInput in flowRoutes.ts); stored as JSON in flow_schedules.spec.
export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'once'
export type WeekDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export type ScheduleSpec =
  | { every: number; unit: 'minutes' | 'hours' } // interval
  | { at: string } // daily, 'HH:MM'
  | { day: WeekDay; at: string } // weekly
  | { runAt: string } // once, ISO instant

export interface ScheduleInput {
  // Legacy target: a single flow. 0 when the schedule fires a trigger name.
  flow_id: number
  // Preferred target: fire this trigger name across every subscribing flow.
  trigger_name: string | null
  name: string | null
  kind: ScheduleKind
  spec: ScheduleSpec
  dry_run: boolean
  enabled: boolean
  next_run: string | null
}

export interface FlowSchedule {
  id: number
  flow_id: number
  trigger_name: string | null // when set, fires this trigger name (not flow_id)
  flow_name: string | null // joined from flows; null if the flow was deleted
  name: string | null
  kind: ScheduleKind
  spec: ScheduleSpec
  dry_run: boolean
  enabled: boolean
  next_run: string | null
  last_run: string | null
  last_run_id: number | null
  last_run_ok: boolean | null // joined from flow_runs
  created_at: string
  updated_at: string
}

// Raw DB shape before booleans/JSON are decoded.
interface ScheduleRaw {
  id: number
  flow_id: number
  trigger_name: string | null
  flow_name: string | null
  name: string | null
  kind: ScheduleKind
  spec: string
  dry_run: number
  enabled: number
  next_run: string | null
  last_run: string | null
  last_run_id: number | null
  last_run_ok: number | null
  created_at: string
  updated_at: string
}

const SCHEDULE_SELECT = `
  SELECT s.*, f.name AS flow_name, r.ok AS last_run_ok
  FROM flow_schedules s
  LEFT JOIN flows f ON f.id = s.flow_id
  LEFT JOIN flow_runs r ON r.id = s.last_run_id
`

function decodeSchedule(r: ScheduleRaw): FlowSchedule {
  let spec: ScheduleSpec
  try {
    spec = JSON.parse(r.spec) as ScheduleSpec
  } catch {
    spec = { at: '00:00' } // corrupt spec — surfaced as a harmless default
  }
  return {
    id: r.id,
    flow_id: r.flow_id,
    trigger_name: r.trigger_name,
    flow_name: r.flow_name,
    name: r.name,
    kind: r.kind,
    spec,
    dry_run: r.dry_run === 1,
    enabled: r.enabled === 1,
    next_run: r.next_run,
    last_run: r.last_run,
    last_run_id: r.last_run_id,
    last_run_ok: r.last_run_ok === null ? null : r.last_run_ok === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function listSchedules(): FlowSchedule[] {
  const rows = db()
    .prepare(`${SCHEDULE_SELECT} ORDER BY s.enabled DESC, s.next_run ASC`)
    .all() as ScheduleRaw[]
  return rows.map(decodeSchedule)
}

export function getSchedule(id: number): FlowSchedule | undefined {
  const row = db().prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(id) as ScheduleRaw | undefined
  return row ? decodeSchedule(row) : undefined
}

// Schedules whose next_run has arrived, soonest first. Disabled or once-fired
// (next_run NULL) schedules never appear.
export function dueSchedules(nowIso: string): FlowSchedule[] {
  const rows = db()
    .prepare(
      `${SCHEDULE_SELECT} WHERE s.enabled = 1 AND s.next_run IS NOT NULL AND s.next_run <= ? ORDER BY s.next_run ASC`,
    )
    .all(nowIso) as ScheduleRaw[]
  return rows.map(decodeSchedule)
}

export function createSchedule(input: ScheduleInput): FlowSchedule {
  const info = db()
    .prepare(
      `INSERT INTO flow_schedules (flow_id, trigger_name, name, kind, spec, dry_run, enabled, next_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.flow_id,
      input.trigger_name,
      input.name,
      input.kind,
      JSON.stringify(input.spec),
      input.dry_run ? 1 : 0,
      input.enabled ? 1 : 0,
      input.next_run,
    )
  return getSchedule(Number(info.lastInsertRowid))!
}

export function updateSchedule(
  id: number,
  patch: Partial<ScheduleInput>,
): FlowSchedule | undefined {
  const existing = getSchedule(id)
  if (!existing) return undefined
  db()
    .prepare(
      `UPDATE flow_schedules
       SET flow_id = ?, trigger_name = ?, name = ?, kind = ?, spec = ?, dry_run = ?, enabled = ?, next_run = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      patch.flow_id ?? existing.flow_id,
      patch.trigger_name === undefined ? existing.trigger_name : patch.trigger_name,
      patch.name === undefined ? existing.name : patch.name,
      patch.kind ?? existing.kind,
      JSON.stringify(patch.spec ?? existing.spec),
      (patch.dry_run === undefined ? existing.dry_run : patch.dry_run) ? 1 : 0,
      (patch.enabled === undefined ? existing.enabled : patch.enabled) ? 1 : 0,
      patch.next_run === undefined ? existing.next_run : patch.next_run,
      id,
    )
  return getSchedule(id)
}

export function deleteSchedule(id: number): boolean {
  return db().prepare('DELETE FROM flow_schedules WHERE id = ?').run(id).changes > 0
}

// Record the outcome of a fire: stamp last_run/last_run_id and roll next_run
// forward (null + disabled for a spent one-time schedule).
export function markScheduleFired(
  id: number,
  fields: { last_run: string; last_run_id: number | null; next_run: string | null; enabled: boolean },
): void {
  db()
    .prepare(
      `UPDATE flow_schedules
       SET last_run = ?, last_run_id = ?, next_run = ?, enabled = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(fields.last_run, fields.last_run_id, fields.next_run, fields.enabled ? 1 : 0, id)
}
