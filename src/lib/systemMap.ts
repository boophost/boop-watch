// The Flow Map's system view: every flow as one card, laid out by what it
// does rather than by its nodes.
//
// The node-level canvas answers "what is inside this flow". It cannot answer
// "how does a title get from the catalog to the portal", because the answer
// lives *between* flows: a `trigger.fire` in one starts another, a sink queues
// into a qBittorrent category that a different flow imports from, three flows
// write the wants table a fourth reads. This module derives those links from
// the saved graphs and schedules, so the picture stays true as flows change,
// and lays them out in the same lanes × stages grid the sourcing audit used.
//
// Pure: no React, no fetches. `buildSystemModel` → `layoutSystemModel`.
import type { FlowGraph, FlowMapEntry, FlowSchedule } from './flows'

export type Lane = 'anime' | 'media' | 'other'
export type Column = 'trigger' | 'intent' | 'acquire' | 'shared' | 'import' | 'publish'
export type Tone = 'anime' | 'media' | 'other' | 'infra' | 'heal' | 'code' | 'trigger' | 'neutral'

export const COLUMNS: { id: Column; label: string }[] = [
  { id: 'trigger', label: 'Trigger' },
  { id: 'intent', label: 'Intent' },
  { id: 'acquire', label: 'Acquire' },
  { id: 'shared', label: 'Shared' },
  { id: 'import', label: 'Import' },
  { id: 'publish', label: 'Publish' },
]
export const LANES: { id: Lane; label: string }[] = [
  { id: 'anime', label: 'Anime' },
  { id: 'media', label: 'TV & movies' },
  { id: 'other', label: 'Other' },
]

export type BoxKind = 'flow' | 'job' | 'event' | 'timer' | 'wants' | 'qbit' | 'jellyfin' | 'portal'

export interface SysBox {
  id: string
  kind: BoxKind
  /** `null` = spans every lane it touches (qBittorrent, Jellyfin, portal). */
  lane: Lane | null
  column: Column
  title: string
  lines: string[]
  tone: Tone
  flowId?: number
  /** A flow whose only way to run is a disabled schedule. */
  off?: boolean
  /** Published components this flow runs as subflows (hover detail). */
  uses?: string[]
  /** qBittorrent only: one row per category any flow touches. */
  ports?: string[]
  /** Schedules that start this flow, drawn as a badge on the card rather
   * than as trigger pills: a pill per schedule sent an edge across the whole
   * lane for every 3-hourly import. */
  schedules?: { label: string; off: boolean; dry: boolean }[]
  /** `trigger.start` names this flow listens on (what schedules fire). */
  starts?: string[]
}

export type EdgeTone = 'normal' | 'heal' | 'soft'

export interface SysEdge {
  id: string
  from: string
  to: string
  /** Category row on the qBittorrent box this edge leaves from / lands on. */
  fromPort?: string
  toPort?: string
  label?: string
  tone: EdgeTone
  dashed?: boolean
  /** Two flows that link both ways (Chase ↔ wants: open / miss) are one
   * double-headed line, not two lines laid side by side. */
  both?: boolean
  /** Belongs to a switched-off flow: real, but not live — drawn on hover only. */
  muted?: boolean
}

export interface SystemModel {
  boxes: SysBox[]
  edges: SysEdge[]
  components: { id: number; name: string }[]
}

// --- Facts from one graph ----------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

interface FlowFacts {
  starts: string[]
  events: ('new-item' | 'release' | 'new-portal')[]
  qbitComplete: boolean
  fires: string[]
  qbWrite: string[]
  qbRead: string[]
  qbDelete: boolean
  wantUpsert: boolean
  wantUpdate: string[]
  wantsRead: string[]
  imports: string[]
  jellyfin: boolean
  providers: string[]
  planner: boolean
  subflows: number[]
  sections: string[]
  animeHints: boolean
  nodeCount: number
}

function factsOf(graph: FlowGraph): FlowFacts {
  const f: FlowFacts = {
    starts: [], events: [], qbitComplete: false, fires: [], qbWrite: [], qbRead: [], qbDelete: false,
    wantUpsert: false, wantUpdate: [], wantsRead: [], imports: [], jellyfin: false, providers: [],
    planner: false, subflows: [], sections: [], animeHints: false, nodeCount: graph.nodes.length,
  }
  for (const n of graph.nodes) {
    const c = n.config ?? {}
    if (c.section) f.sections.push(str(c.section))
    switch (n.type) {
      case 'trigger.start': if (str(c.name)) f.starts.push(str(c.name)); break
      case 'trigger.new-item': f.events.push('new-item'); break
      case 'trigger.release': f.events.push('release'); break
      case 'trigger.new-portal': f.events.push('new-portal'); break
      case 'trigger.qbit-complete': f.qbitComplete = true; break
      case 'trigger.fire': if (str(c.name)) f.fires.push(str(c.name)); break
      case 'sink.qbittorrent': f.qbWrite.push(str(c.category) || 'anime'); break
      case 'source.qbittorrent': f.qbRead.push(str(c.category) || 'anime'); break
      case 'sink.qbittorrent-delete': f.qbDelete = true; break
      case 'sink.want-upsert': f.wantUpsert = true; f.animeHints = true; break
      case 'sink.want-update': f.wantUpdate.push(str(c.action) || 'update'); f.animeHints = true; break
      case 'source.wants': f.wantsRead.push(str(c.status) || 'open'); f.animeHints = true; break
      case 'sink.library-import': f.imports.push(str(c.section) || 'anime'); break
      case 'sink.jellyfin-scan':
      case 'sink.jellyfin-collection': f.jellyfin = true; break
      case 'enrich.torrent-search': if (str(c.provider)) f.providers.push(str(c.provider)); break
      case 'enrich.sourcing-gaps': f.planner = true; break
      case 'flow.subflow': { const id = Number(c.flowId); if (Number.isFinite(id)) f.subflows.push(id); break }
      case 'enrich.anime-status':
      case 'enrich.episodes':
      case 'enrich.episode-titles': f.animeHints = true; break
      case 'filter.field':
        // The import flows gate the shared "download finished" event on their
        // own category: that gate *is* their qBittorrent read.
        if (str(c.field) === 'torrent_category' && str(c.value)) f.qbRead.push(str(c.value))
        break
    }
  }
  return f
}

const isMediaCategory = (c: string) => /^(tv|movies)(-|$)/.test(c)
const isAnimeCategory = (c: string) => /^anime(-|$)/.test(c)

function laneOf(f: FlowFacts): Lane {
  const cats = [...f.qbWrite, ...f.qbRead]
  if (f.planner || f.sections.some((s) => s === 'tv' || s === 'movies') || cats.some(isMediaCategory)) return 'media'
  if (f.animeHints || cats.some(isAnimeCategory) || f.imports.includes('anime')) return 'anime'
  return 'other'
}

type Role = 'intent' | 'acquire' | 'heal' | 'import'
function roleOf(f: FlowFacts): Role {
  if (f.imports.length) return 'import'
  const reopens = f.wantUpdate.includes('reopen')
  if ((reopens || f.qbDelete) && !f.qbWrite.length && !f.providers.length) return 'heal'
  if (f.qbWrite.length || f.providers.length) return 'acquire'
  return 'intent'
}

const PROVIDER_LABEL: Record<string, string> = { animetosho: 'Tosho', tsukihime: 'Tsuki', apibay: 'apibay' }

export function cadence(s: Pick<FlowSchedule, 'kind' | 'spec'>): string {
  const spec = s.spec as Record<string, unknown>
  if (s.kind === 'interval') return `every ${spec.every} ${spec.unit === 'hours' ? 'h' : 'm'}`
  if (s.kind === 'daily') return `daily ${str(spec.at)}`
  if (s.kind === 'weekly') return `${str(spec.day)} ${str(spec.at)}`
  return 'once'
}

const EVENT_LABEL: Record<FlowFacts['events'][number], string> = {
  'new-item': 'Catalog add',
  release: 'Episode airs',
  'new-portal': 'Lands on portal',
}

const CATEGORY_ORDER = (c: string) => {
  const base = c.replace(/-dev$/, '')
  const i = ['anime', 'tv', 'movies'].indexOf(base)
  return (i < 0 ? 9 : i) * 2 + (c.endsWith('-dev') ? 1 : 0)
}

// --- Model -------------------------------------------------------------------

export function buildSystemModel(flows: FlowMapEntry[], schedules: FlowSchedule[]): SystemModel {
  const boxes: SysBox[] = []
  const edges: SysEdge[] = []
  const edgeIds = new Set<string>()
  const addEdge = (e: Omit<SysEdge, 'id'>) => {
    const id = `${e.from}>${e.to}:${e.fromPort ?? ''}:${e.toPort ?? ''}:${e.label ?? ''}`
    if (edgeIds.has(id)) return
    edgeIds.add(id)
    edges.push({ id, ...e })
  }

  const byId = new Map(flows.map((f) => [f.id, f]))
  const components = flows.filter((f) => f.published).map((f) => ({ id: f.id, name: f.name }))
  const working = flows.filter((f) => !f.published).map((f) => ({ flow: f, facts: factsOf(f.graph) }))

  const categories = new Set<string>()
  for (const { facts } of working) for (const c of [...facts.qbWrite, ...facts.qbRead]) categories.add(c)
  const usesWants = working.some(({ facts }) => facts.wantUpsert || facts.wantUpdate.length || facts.wantsRead.length)
  // The anime category this environment queues into — what the code-side
  // Reconcile watches (QBIT_CATEGORY, which the client can't read directly).
  const animeCat =
    working.flatMap(({ facts }) => facts.qbWrite).find(isAnimeCategory) ??
    [...categories].find(isAnimeCategory)

  const startOwners = new Map<string, number[]>()
  for (const { flow, facts } of working)
    for (const s of facts.starts) startOwners.set(s, [...(startOwners.get(s) ?? []), flow.id])

  const flowBox = (id: number) => `flow:${id}`

  for (const { flow, facts } of working) {
    const lane = laneOf(facts)
    const role = roleOf(facts)
    const own = schedules.filter((s) => (s.trigger_name ? facts.starts.includes(s.trigger_name) : s.flow_id === flow.id))
    const hasEvents = facts.events.length > 0 || facts.qbitComplete || facts.starts.some((s) => s !== '' && working.some((w) => w.facts.fires.includes(s)))
    const off = !hasEvents && own.length > 0 && own.every((s) => !s.enabled)

    const lines: string[] = []
    if (role === 'import') lines.push(`imports ${[...new Set(facts.imports)].join(', ')} · ${facts.nodeCount} nodes`)
    else if (facts.planner) lines.push(`plans gaps · ${[...new Set(facts.providers)].map((p) => PROVIDER_LABEL[p] ?? p).join(', ') || 'search'}`)
    else if (facts.providers.length) lines.push(`search: ${[...new Set(facts.providers)].map((p) => PROVIDER_LABEL[p] ?? p).join(' → ')}`)
    else if (role === 'heal') lines.push(`reopens stuck wants${facts.qbDelete ? ' · deletes' : ''}`)
    else if (facts.wantUpsert) lines.push('records wants')
    else lines.push(`${facts.nodeCount} nodes`)

    boxes.push({
      id: flowBox(flow.id),
      kind: 'flow',
      lane,
      column: role === 'import' ? 'import' : role === 'intent' ? 'intent' : 'acquire',
      title: flow.name,
      lines,
      tone: role === 'heal' ? 'heal' : lane,
      flowId: flow.id,
      off,
      uses: facts.subflows.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n)),
      schedules: own.map((s) => ({ label: cadence(s), off: !s.enabled, dry: s.dry_run })),
      starts: facts.starts,
    })
    // A switched-off flow's links are real but not live; draw them muted.
    const soft = (t: EdgeTone): EdgeTone => (off ? 'soft' : t)
    const before = edges.length

    // Triggers: one pill per event kind per lane, one per schedule.
    for (const ev of new Set(facts.events)) {
      const id = `event:${ev}:${lane}`
      if (!boxes.some((b) => b.id === id))
        boxes.push({ id, kind: 'event', lane, column: 'trigger', title: EVENT_LABEL[ev], lines: [], tone: 'trigger' })
      addEdge({ from: id, to: flowBox(flow.id), tone: 'normal' })
    }

    for (const name of new Set(facts.fires))
      for (const target of startOwners.get(name) ?? [])
        if (target !== flow.id) addEdge({ from: flowBox(flow.id), to: flowBox(target), label: 'fires', tone: 'soft', dashed: true })

    if (facts.wantUpsert) addEdge({ from: flowBox(flow.id), to: 'wants', label: 'upsert', tone: 'normal' })
    for (const a of new Set(facts.wantUpdate))
      addEdge({ from: flowBox(flow.id), to: 'wants', label: a === 'attempt' ? 'miss' : a, tone: soft(a === 'reopen' ? 'heal' : 'soft'), dashed: off || a !== 'reopen' })
    for (const st of new Set(facts.wantsRead)) addEdge({ from: 'wants', to: flowBox(flow.id), label: st, tone: soft('normal'), dashed: off })

    for (const c of new Set(facts.qbWrite)) addEdge({ from: flowBox(flow.id), to: 'qbit', toPort: c, label: role === 'import' ? 'upgrade' : 'queue', tone: soft(role === 'import' ? 'heal' : 'normal'), dashed: off })
    for (const c of new Set(facts.qbRead))
      addEdge({ from: 'qbit', fromPort: c, to: flowBox(flow.id), label: role === 'import' ? 'done' : 'reads', tone: soft(role === 'import' ? 'normal' : 'soft'), dashed: off })
    if (facts.qbDelete && role !== 'import') addEdge({ from: flowBox(flow.id), to: 'qbit', toPort: facts.qbRead[0], label: 'delete', tone: soft('heal'), dashed: off })

    if (facts.imports.length || facts.jellyfin) addEdge({ from: flowBox(flow.id), to: 'jellyfin', tone: 'normal' })
    if (off) for (let i = before; i < edges.length; i++) edges[i].muted = true
  }

  if (usesWants) {
    // Imports also mark wants fulfilled; that edge would cross the whole lane
    // backwards for one word, so the store says it instead.
    boxes.push({ id: 'wants', kind: 'wants', lane: 'anime', column: 'intent', title: 'wants', lines: ['open · sourced · fulfilled', 'imports fulfil'], tone: 'anime' })
    // Scheduler-code jobs (server/scheduler.ts, server/sourcing.ts). Not flows,
    // so no graph to read them from — but leaving them out would hide two of
    // the busiest writers to the wants table.
    boxes.push({ id: 'job:sweep', kind: 'job', lane: 'anime', column: 'trigger', title: 'Air-date sweep', lines: ['every 15 m · code'], tone: 'code' })
    addEdge({ from: 'job:sweep', to: 'wants', label: 'opens', tone: 'normal' })
    for (const target of startOwners.get('chase-wants') ?? []) addEdge({ from: 'job:sweep', to: flowBox(target), label: 'fires', tone: 'soft', dashed: true })
    boxes.push({ id: 'job:reconcile', kind: 'job', lane: 'anime', column: 'acquire', title: 'Reconcile', lines: ['every 15 m · code', 'stalled 24 h · never error'], tone: 'heal' })
    addEdge({ from: 'job:reconcile', to: 'wants', label: 'reopen', tone: 'heal' })
    if (animeCat) {
      addEdge({ from: 'qbit', fromPort: animeCat, to: 'job:reconcile', label: 'reads', tone: 'soft' })
      addEdge({ from: 'job:reconcile', to: 'qbit', toPort: animeCat, label: 'remove', tone: 'heal' })
    }
  }

  if (categories.size) {
    boxes.push({
      id: 'qbit',
      kind: 'qbit',
      lane: null,
      column: 'shared',
      title: 'qBittorrent',
      lines: ['add guard on every queue'],
      tone: 'infra',
      ports: [...categories].sort((a, b) => CATEGORY_ORDER(a) - CATEGORY_ORDER(b) || a.localeCompare(b)),
    })
  }
  if (edges.some((e) => e.to === 'jellyfin')) {
    boxes.push({ id: 'jellyfin', kind: 'jellyfin', lane: null, column: 'publish', title: 'Jellyfin', lines: ['Public collection'], tone: 'neutral' })
    boxes.push({ id: 'portal', kind: 'portal', lane: null, column: 'publish', title: 'Portal', lines: ['public site'], tone: 'neutral' })
    addEdge({ from: 'jellyfin', to: 'portal', tone: 'normal' })
  }

  return { boxes, edges: mergeReciprocal(edges), components }
}

/** Fold A→B + B→A (same qBittorrent row, if any) into one double-headed edge.
 * The heal tone wins only when both halves are heals, so a normal "done"
 * paired with an "upgrade" doesn't paint the whole line orange. */
function mergeReciprocal(edges: SysEdge[]): SysEdge[] {
  const out: SysEdge[] = []
  const used = new Set<string>()
  for (const e of edges) {
    if (used.has(e.id)) continue
    const back = edges.find(
      (r) => !used.has(r.id) && r.id !== e.id && r.from === e.to && r.to === e.from && (r.fromPort ?? '') === (e.toPort ?? '') && (r.toPort ?? '') === (e.fromPort ?? ''),
    )
    used.add(e.id)
    if (!back) {
      out.push(e)
      continue
    }
    used.add(back.id)
    out.push({
      ...e,
      both: true,
      label: [e.label, back.label].filter(Boolean).join(' · ') || undefined,
      tone: e.tone === 'heal' && back.tone === 'heal' ? 'heal' : e.tone === 'soft' && back.tone === 'soft' ? 'soft' : 'normal',
      dashed: Boolean(e.dashed && back.dashed),
      muted: Boolean(e.muted && back.muted),
    })
  }
  return out
}

// --- Layout ------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }
export interface PlacedBox extends SysBox, Rect {
  /** Absolute y of each qBittorrent category row. */
  portY?: Record<string, number>
}
export interface PlacedEdge extends SysEdge {
  d: string
  labelAt?: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }
  /** The label fit without touching a card or another label, so it is shown
   * at rest. The rest appear when one of the edge's cards is hovered. */
  labelAtRest?: boolean
}
export interface PlacedLane { id: Lane; label: string; y: number; h: number }
export interface SystemLayout {
  width: number
  height: number
  columns: { id: Column; label: string; x: number; w: number }[]
  lanes: PlacedLane[]
  boxes: PlacedBox[]
  edges: PlacedEdge[]
}

const COL_W: Record<Column, number> = { trigger: 168, intent: 184, acquire: 184, shared: 168, import: 184, publish: 124 }
const GAP = 88
const PAD_X = 16
const HEAD_H = 34
const LANE_PAD = 18
const LANE_GAP = 10
const STACK_GAP = 22
const PORT_H = 22
/** Spacing between parallel vertical tracks in a column gap. */
const TRACK = 7
const CHAR_W = 6.3

function heightOf(b: SysBox): number {
  switch (b.kind) {
    case 'event':
    case 'timer': return 30
    case 'job': return 22 + b.lines.length * 14
    case 'wants': return 76
    default: return 28 + b.lines.length * 14 + 16
  }
}

/** One edge's route before vertical tracks are assigned: horizontal from
 * `start`, then for each leg a vertical run inside a column gap, then
 * horizontal into `end`. */
interface Route {
  edge: SysEdge
  start: [number, number]
  legs: { gap: number; key: string; y1: number; y2: number; x?: number }[]
  end: [number, number]
  /** Pre-built path for the stacked-in-one-column case. */
  direct?: string
}

export function layoutSystemModel(model: SystemModel): SystemLayout {
  const columns: SystemLayout['columns'] = []
  let x = PAD_X
  for (const c of COLUMNS) {
    columns.push({ ...c, x, w: COL_W[c.id] })
    x += COL_W[c.id] + GAP
  }
  const width = x - GAP + PAD_X
  const colOf = new Map(columns.map((c) => [c.id, c]))
  const colIdx = new Map(columns.map((c, i) => [c.id, i]))

  const lanes = LANES.filter((l) => model.boxes.some((b) => b.lane === l.id))
  const placed = new Map<string, PlacedBox>()
  const neighbours = (id: string) =>
    model.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []))
  const rank = (b: SysBox) => (b.kind === 'job' ? 3 : b.tone === 'heal' ? 4 : b.off ? 5 : 1)
  const order: Column[] = ['intent', 'acquire', 'import', 'trigger']

  function prefY(b: SysBox): number {
    const ys = neighbours(b.id)
      .map((id) => placed.get(id))
      .filter((p): p is PlacedBox => Boolean(p))
      .map((p) => p.y + p.h / 2)
    return ys.length ? Math.min(...ys) : Number.NaN
  }

  const placedLanes: PlacedLane[] = []
  let y = HEAD_H
  for (const lane of lanes) {
    const top = y + LANE_PAD
    let bottom = top
    for (const col of order) {
      const c = colOf.get(col)!
      let stack = model.boxes
        .filter((b) => b.lane === lane.id && b.column === col)
        .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
      if (col === 'trigger') stack.sort((a, b) => prefY(a) - prefY(b) || a.title.localeCompare(b.title))
      // A store sits in the middle of the flows that write it, so each writer
      // reaches it with a short straight arrow instead of a loop round the side.
      const store = stack.find((b) => b.kind === 'wants')
      if (store) {
        const rest = stack.filter((b) => b !== store)
        const flows = rest.filter((b) => b.kind === 'flow')
        const half = Math.ceil(flows.length / 2)
        stack = [...flows.slice(0, half), store, ...flows.slice(half), ...rest.filter((b) => b.kind !== 'flow')]
      }
      let cursor = top
      for (const b of stack) {
        const h = heightOf(b)
        const want = col === 'intent' ? cursor : Math.max(cursor, prefY(b) - h / 2)
        const py = Number.isFinite(want) ? want : cursor
        placed.set(b.id, { ...b, x: c.x, y: py, w: c.w, h })
        cursor = py + h + STACK_GAP
      }
      bottom = Math.max(bottom, cursor - STACK_GAP)
    }
    const h = bottom - top + LANE_PAD * 2
    placedLanes.push({ id: lane.id, label: lane.label, y, h })
    y += h + LANE_GAP
  }
  const height = y - LANE_GAP + 16

  // Spanning boxes: qBittorrent across the sourcing lanes, Jellyfin + portal
  // down the publish column.
  const qbit = model.boxes.find((b) => b.kind === 'qbit')
  if (qbit) {
    const c = colOf.get('shared')!
    const lanesUsed = placedLanes.filter((l) => l.id !== 'other')
    const top = (lanesUsed[0] ?? placedLanes[0]).y + LANE_PAD
    const last = lanesUsed[lanesUsed.length - 1] ?? placedLanes[placedLanes.length - 1]
    const ports = qbit.ports ?? []
    const minH = 58 + ports.length * (PORT_H + 4) + 20
    const h = Math.max(minH, last.y + last.h - LANE_PAD - top)
    const portY: Record<string, number> = {}
    ports.forEach((p, i) => { portY[p] = top + 58 + i * (PORT_H + 4) + PORT_H / 2 })
    placed.set(qbit.id, { ...qbit, x: c.x, y: top, w: c.w, h, portY })
  }
  const portal = model.boxes.find((b) => b.kind === 'portal')
  const jelly = model.boxes.find((b) => b.kind === 'jellyfin')
  if (portal && jelly) {
    const c = colOf.get('publish')!
    const top = (placedLanes[0]?.y ?? HEAD_H) + LANE_PAD
    placed.set(portal.id, { ...portal, x: c.x, y: top, w: c.w, h: 46 })
    const jTop = top + 46 + 24
    placed.set(jelly.id, { ...jelly, x: c.x, y: jTop, w: c.w, h: Math.max(80, height - 16 - LANE_PAD - jTop) })
  }

  const boxes = [...placed.values()]
  const ci = (b: PlacedBox) => colIdx.get(b.column)!
  /** Centre x of the gap to the right of column k. */
  const gapCentre = (k: number) => columns[k].x + columns[k].w + GAP / 2
  /** True when nothing in columns `cols` covers height y (with clearance). */
  const freeAt = (y: number, cols: number[]) =>
    cols.every((k) => !boxes.some((b) => ci(b) === k && y > b.y - 8 && y < b.y + b.h + 8))
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i)
  /** The y to cross intermediate columns at: the source row if it's clear,
   * else the target row, else the nearest gap between cards. */
  function corridor(sy: number, ty: number, cols: number[]): number {
    if (!cols.length || freeAt(sy, cols)) return sy
    if (freeAt(ty, cols)) return ty
    const cands = boxes
      .filter((b) => cols.includes(ci(b)))
      .flatMap((b) => [b.y - 11, b.y + b.h + 11])
      .filter((c) => c > HEAD_H && c < height - 4 && freeAt(c, cols))
    cands.sort((p, q) => Math.abs(p - sy) + Math.abs(p - ty) - (Math.abs(q - sy) + Math.abs(q - ty)))
    return cands[0] ?? sy
  }

  // Anchor points: edges sharing a card side are spread down that side; edges
  // on one qBittorrent row are spread within the row.
  const dirOf = (a: PlacedBox, b: PlacedBox) => (ci(b) > ci(a) ? 'fwd' : ci(b) < ci(a) ? 'back' : 'same')
  const sideCount = new Map<string, number>()
  const bump = (k: string) => sideCount.set(k, (sideCount.get(k) ?? 0) + 1)
  const sideKey = (box: string, side: string, port?: string) => `${box}|${side}|${port ?? ''}`
  for (const e of model.edges) {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    if (!a || !b) continue
    const dir = dirOf(a, b)
    bump(sideKey(a.id, dir === 'fwd' ? 'R' : 'L', e.fromPort))
    bump(sideKey(b.id, dir === 'back' ? 'R' : 'L', e.toPort))
  }
  const sideUsed = new Map<string, number>()
  const anchorY = (box: PlacedBox, side: string, port: string | undefined, toward: number): number => {
    const k = sideKey(box.id, side, port)
    const n = sideCount.get(k) ?? 1
    const i = sideUsed.get(k) ?? 0
    sideUsed.set(k, i + 1)
    if (port && box.portY?.[port] != null) return box.portY[port] + (i - (n - 1) / 2) * 5
    if (box.kind === 'qbit' || box.kind === 'jellyfin') return Math.min(box.y + box.h - 14, Math.max(box.y + 14, toward))
    const step = Math.min(10, (box.h - 12) / Math.max(1, n))
    return box.y + box.h / 2 + (i - (n - 1) / 2) * step
  }

  // Legs that may share one vertical track: a fan-in of the same meaning
  // (three "fires" into Chase), or a fan-out from one qBittorrent row.
  const sameMeaningIn = new Map<string, number>()
  for (const e of model.edges) sameMeaningIn.set(`${e.to}|${e.label ?? ''}`, (sameMeaningIn.get(`${e.to}|${e.label ?? ''}`) ?? 0) + 1)
  const legKey = (e: SysEdge, end: 'first' | 'last' | 'only', i: number) => {
    if ((end === 'last' || end === 'only') && (sameMeaningIn.get(`${e.to}|${e.label ?? ''}`) ?? 0) > 1) return `in:${e.to}:${e.label ?? ''}`
    if ((end === 'first' || end === 'only') && e.fromPort) return `out:${e.from}:${e.fromPort}`
    return `e:${e.id}:${i}`
  }

  const routes: Route[] = []
  for (const e of model.edges) {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    if (!a || !b) continue
    const dir = dirOf(a, b)
    const ka = ci(a)
    const kb = ci(b)
    if (dir === 'fwd') {
      const sy = anchorY(a, 'R', e.fromPort, b.y + b.h / 2)
      const ty = anchorY(b, 'L', e.toPort, sy)
      const start: [number, number] = [a.x + a.w, sy]
      const end: [number, number] = [b.x - 4, ty]
      if (kb === ka + 1) routes.push({ edge: e, start, end, legs: [{ gap: ka, key: legKey(e, 'only', 0), y1: sy, y2: ty }] })
      else {
        const c = corridor(sy, ty, range(ka + 1, kb - 1))
        routes.push({ edge: e, start, end, legs: [
          { gap: ka, key: legKey(e, 'first', 0), y1: sy, y2: c },
          { gap: kb - 1, key: legKey(e, 'last', 1), y1: c, y2: ty },
        ] })
      }
    } else if (dir === 'back') {
      const sy = anchorY(a, 'L', e.fromPort, b.y + b.h / 2)
      const ty = anchorY(b, 'R', e.toPort, sy)
      const start: [number, number] = [a.x, sy]
      const end: [number, number] = [b.x + b.w + 4, ty]
      if (ka === kb + 1) routes.push({ edge: e, start, end, legs: [{ gap: kb, key: legKey(e, 'only', 0), y1: sy, y2: ty }] })
      else {
        const c = corridor(sy, ty, range(kb + 1, ka - 1))
        routes.push({ edge: e, start, end, legs: [
          { gap: ka - 1, key: legKey(e, 'first', 0), y1: sy, y2: c },
          { gap: kb, key: legKey(e, 'last', 1), y1: c, y2: ty },
        ] })
      }
    } else {
      const top = a.y < b.y ? a : b
      const bot = top === a ? b : a
      const between = boxes.some((o) => o !== a && o !== b && ci(o) === ka && o.y >= top.y + top.h - 1 && o.y + o.h <= bot.y + 1)
      if (!between) {
        // Stacked neighbours (a writer and the store, Jellyfin and portal): a
        // short straight arrow between them.
        const xm = a.x + a.w / 2 + (a.kind === 'flow' || b.kind === 'flow' ? 0 : 0)
        const down = a === top
        const d = down ? `M${xm} ${a.y + a.h} V${b.y - 4}` : `M${xm} ${a.y} V${b.y + b.h + 4}`
        routes.push({ edge: e, start: [xm, 0], end: [xm, 0], legs: [], direct: d })
      } else {
        const sy = anchorY(a, 'L', e.fromPort, b.y)
        const ty = anchorY(b, 'L', e.toPort, sy)
        routes.push({ edge: e, start: [a.x, sy], end: [b.x - 4, ty], legs: [{ gap: ka - 1, key: legKey(e, 'only', 0), y1: sy, y2: ty }] })
      }
    }
  }

  // Track assignment, per gap: legs whose vertical spans overlap get separate
  // x positions; legs with the same key share one (and their span is merged).
  const byGap = new Map<number, Map<string, { lo: number; hi: number; legs: Route['legs'] }>>()
  for (const r of routes)
    for (const l of r.legs) {
      if (Math.abs(l.y1 - l.y2) < 0.5) continue
      const g = byGap.get(l.gap) ?? new Map()
      byGap.set(l.gap, g)
      const grp = g.get(l.key) ?? { lo: Infinity, hi: -Infinity, legs: [] }
      grp.lo = Math.min(grp.lo, l.y1, l.y2)
      grp.hi = Math.max(grp.hi, l.y1, l.y2)
      grp.legs.push(l)
      g.set(l.key, grp)
    }
  for (const [gap, groups] of byGap) {
    const list = [...groups.values()].sort((p, q) => p.lo - q.lo || q.hi - p.hi)
    const trackEnds: number[] = []
    const assigned: number[] = []
    for (const grp of list) {
      let t = trackEnds.findIndex((end) => end < grp.lo - 6)
      if (t < 0) { t = trackEnds.length; trackEnds.push(grp.hi) } else trackEnds[t] = grp.hi
      assigned.push(t)
    }
    const n = trackEnds.length
    const step = Math.min(TRACK, (GAP - 16) / Math.max(1, n))
    list.forEach((grp, i) => {
      const xTrack = gapCentre(gap) + (assigned[i] - (n - 1) / 2) * step
      for (const l of grp.legs) l.x = xTrack
    })
  }
  for (const r of routes)
    for (const l of r.legs) if (l.x == null) l.x = gapCentre(l.gap)

  // Paths, then labels: each label goes on the edge's longest horizontal run
  // (or beside its vertical) and is kept at rest only if it collides with no
  // card and no label already placed.
  const placedLabels: Rect[] = []
  const boxRects = boxes.map((b) => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }))
  const hit = (r: Rect, list: Rect[]) => list.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h)
  const importance = (e: SysEdge) => (e.muted ? 3 : e.tone === 'heal' ? 0 : e.tone === 'normal' ? 1 : 2)
  const edges: PlacedEdge[] = []
  for (const r of [...routes].sort((p, q) => importance(p.edge) - importance(q.edge))) {
    let d: string
    const hs: { x1: number; x2: number; y: number }[] = []
    const vs: { x: number; y1: number; y2: number }[] = []
    if (r.direct) {
      d = r.direct
      const m = /M([\d.-]+) ([\d.-]+) V([\d.-]+)/.exec(d)
      if (m) vs.push({ x: Number(m[1]), y1: Number(m[2]), y2: Number(m[3]) })
    } else {
      let [cx, cy] = r.start
      const parts = [`M${cx} ${cy}`]
      for (const l of r.legs) {
        if (Math.abs(l.y1 - l.y2) < 0.5 && Math.abs(cy - l.y2) < 0.5) continue
        hs.push({ x1: cx, x2: l.x!, y: cy })
        parts.push(`H${l.x}`, `V${l.y2}`)
        vs.push({ x: l.x!, y1: cy, y2: l.y2 })
        cx = l.x!
        cy = l.y2
      }
      hs.push({ x1: cx, x2: r.end[0], y: cy })
      parts.push(`H${r.end[0]}`)
      d = parts.join(' ')
    }
    let labelAt: PlacedEdge['labelAt']
    let labelAtRest = false
    const label = r.edge.label
    if (label) {
      const w = label.length * CHAR_W + 6
      const cands: { at: NonNullable<PlacedEdge['labelAt']>; rect: Rect }[] = []
      for (const h of [...hs].sort((p, q) => Math.abs(q.x2 - q.x1) - Math.abs(p.x2 - p.x1)))
        if (Math.abs(h.x2 - h.x1) >= w + 8) {
          const mx = (h.x1 + h.x2) / 2
          for (const dy of [-5, 13])
            cands.push({ at: { x: mx, y: h.y + dy, anchor: 'middle' }, rect: { x: mx - w / 2, y: h.y + dy - 10, w, h: 12 } })
        }
      for (const v of vs) {
        const my = (v.y1 + v.y2) / 2 + 3
        cands.push({ at: { x: v.x + 4, y: my, anchor: 'start' }, rect: { x: v.x + 2, y: my - 10, w, h: 12 } })
        cands.push({ at: { x: v.x - 4, y: my, anchor: 'end' }, rect: { x: v.x - 2 - w, y: my - 10, w, h: 12 } })
      }
      const ok = r.edge.muted ? undefined : cands.find((c) => !hit(c.rect, boxRects) && !hit(c.rect, placedLabels))
      const pick = ok ?? cands[0]
      if (pick) {
        labelAt = pick.at
        if (ok) {
          labelAtRest = true
          placedLabels.push(ok.rect)
        }
      }
    }
    edges.push({ ...r.edge, d, labelAt, labelAtRest })
  }

  return { width, height, columns, lanes: placedLanes, boxes, edges }
}
