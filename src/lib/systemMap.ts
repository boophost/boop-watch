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
    else if (facts.planner) lines.push(`plans gaps · ${facts.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(', ') || 'search'}`)
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
    })
    // A switched-off flow's links are real but not live; draw them muted.
    const soft = (t: EdgeTone): EdgeTone => (off ? 'soft' : t)

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
    if (facts.planner) for (const c of categories) if (isMediaCategory(c) && facts.qbWrite.some((w) => w.endsWith('-dev') === c.endsWith('-dev'))) addEdge({ from: 'qbit', fromPort: c, to: flowBox(flow.id), label: 'held', tone: 'soft', dashed: true })

    if (facts.imports.length || facts.jellyfin) addEdge({ from: flowBox(flow.id), to: 'jellyfin', tone: 'normal' })
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

  return { boxes, edges, components }
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
const GAP = 52
const PAD_X = 16
const HEAD_H = 34
const LANE_PAD = 18
const LANE_GAP = 10
const STACK_GAP = 18
const PORT_H = 22

function heightOf(b: SysBox): number {
  switch (b.kind) {
    case 'event':
    case 'timer': return 30
    case 'job': return 22 + b.lines.length * 14
    case 'wants': return 76
    default: return 28 + b.lines.length * 14 + 16
  }
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

  const lanes = LANES.filter((l) => model.boxes.some((b) => b.lane === l.id))
  const placed = new Map<string, PlacedBox>()
  const neighbours = (id: string) =>
    model.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []))

  // Order inside a stack: flows before the wants store and jobs, heals last,
  // then by name, so related cards sit near each other across columns.
  const rank = (b: SysBox) =>
    (b.kind === 'wants' ? 2 : b.kind === 'job' ? 3 : b.tone === 'heal' ? 4 : b.off ? 5 : 1)
  const order: Column[] = ['intent', 'acquire', 'import', 'trigger']

  const placedLanes: PlacedLane[] = []
  let y = HEAD_H
  for (const lane of lanes) {
    const top = y + LANE_PAD
    let bottom = top
    for (const col of order) {
      const c = colOf.get(col)!
      const stack = model.boxes
        .filter((b) => b.lane === lane.id && b.column === col)
        .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
      // Greedy alignment: each card wants to sit level with what it connects
      // to that is already placed, but never above the previous card.
      if (col === 'trigger') {
        stack.sort((a, b) => prefY(a) - prefY(b) || a.title.localeCompare(b.title))
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

  function prefY(b: SysBox): number {
    const ys = neighbours(b.id)
      .map((id) => placed.get(id))
      .filter((p): p is PlacedBox => Boolean(p))
      .map((p) => p.y + p.h / 2)
    return ys.length ? Math.min(...ys) : Number.NaN
  }

  // Spanning boxes: qBittorrent across the lanes it serves; Jellyfin + portal
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

  // --- Edge routing: orthogonal, one vertical channel per edge in the gap
  // beside its target, with offsets so parallel edges don't overlap.
  const sideCount = new Map<string, number>()
  const sideIndex = new Map<string, number>()
  const anchorKey = (box: string, side: string) => `${box}|${side}`
  const routes: { e: SysEdge; a: PlacedBox; b: PlacedBox; dir: 'fwd' | 'back' | 'same' }[] = []
  for (const e of model.edges) {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    if (!a || !b) continue
    const dir = b.x > a.x + 1 ? 'fwd' : b.x < a.x - 1 ? 'back' : 'same'
    routes.push({ e, a, b, dir })
    const outSide = dir === 'fwd' ? 'R' : 'L'
    const inSide = dir === 'back' ? 'R' : 'L'
    if (!e.fromPort) sideCount.set(anchorKey(a.id, outSide), (sideCount.get(anchorKey(a.id, outSide)) ?? 0) + 1)
    if (!e.toPort) sideCount.set(anchorKey(b.id, inSide), (sideCount.get(anchorKey(b.id, inSide)) ?? 0) + 1)
  }
  const anchorY = (box: PlacedBox, side: string, port?: string, toward?: number): number => {
    if (port && box.portY?.[port] != null) return box.portY[port]
    if (box.kind === 'qbit' || box.kind === 'jellyfin') {
      const t = toward ?? box.y + box.h / 2
      return Math.min(box.y + box.h - 14, Math.max(box.y + 14, t))
    }
    const k = anchorKey(box.id, side)
    const n = sideCount.get(k) ?? 1
    const i = sideIndex.get(k) ?? 0
    sideIndex.set(k, i + 1)
    const step = Math.min(10, (box.h - 12) / Math.max(1, n))
    return box.y + box.h / 2 + (i - (n - 1) / 2) * step
  }
  const channelUse = new Map<number, number>()
  const channel = (base: number) => {
    const n = channelUse.get(base) ?? 0
    channelUse.set(base, n + 1)
    return base - (n % 6) * 6
  }

  const edges: PlacedEdge[] = []
  for (const { e, a, b, dir } of routes) {
    const ay0 = anchorY(a, dir === 'fwd' ? 'R' : 'L', e.fromPort, b.y + b.h / 2)
    const by0 = anchorY(b, dir === 'back' ? 'R' : 'L', e.toPort, ay0)
    let d: string
    let labelAt: PlacedEdge['labelAt']
    if (dir === 'fwd') {
      const sx = a.x + a.w
      const tx = b.x - 4
      const cx = channel(b.x - 14)
      if (Math.abs(ay0 - by0) < 1) d = `M${sx} ${ay0} H${tx}`
      else d = `M${sx} ${ay0} H${cx} V${by0} H${tx}`
      labelAt = Math.abs(ay0 - by0) < 1 || cx - sx > 70
        ? { x: (sx + (Math.abs(ay0 - by0) < 1 ? tx : cx)) / 2, y: ay0 - 5, anchor: 'middle' }
        : { x: cx - 4, y: (ay0 + by0) / 2 + 3, anchor: 'end' }
    } else if (dir === 'back') {
      const sx = a.x
      const tx = b.x + b.w + 4
      const cx = channel(a.x - 14)
      d = Math.abs(ay0 - by0) < 1 ? `M${sx} ${ay0} H${tx}` : `M${sx} ${ay0} H${cx} V${by0} H${tx}`
      labelAt = { x: (cx + tx) / 2, y: by0 + 12, anchor: 'middle' }
    } else if (a.y >= b.y + b.h || b.y >= a.y + a.h ? Math.abs(a.x - b.x) < 1 && (a.kind === 'jellyfin' || a.kind === 'portal') : false) {
      // Stacked in one column (Jellyfin → portal): a short vertical arrow.
      const up = b.y + b.h <= a.y
      const xm = a.x + a.w / 2
      d = up ? `M${xm} ${a.y} V${b.y + b.h + 4}` : `M${xm} ${a.y + a.h} V${b.y - 4}`
      labelAt = { x: xm + 6, y: up ? (a.y + b.y + b.h) / 2 : (a.y + a.h + b.y) / 2, anchor: 'start' }
    } else {
      // Same column (an intent flow writing the wants store below it): loop
      // down the left side, which only carries trigger edges, rather than the
      // busy channel on the right.
      const ax = a.x
      const cx = a.x - 10 - (channelUse.get(-a.x) ?? 0) * 5
      channelUse.set(-a.x, (channelUse.get(-a.x) ?? 0) + 1)
      d = `M${ax} ${ay0} H${cx} V${by0} H${b.x - 4}`
      labelAt = { x: cx - 4, y: (ay0 + by0) / 2 + 3, anchor: 'end' }
    }
    edges.push({ ...e, d, labelAt: e.label ? labelAt : undefined })
  }

  return { width, height, columns, lanes: placedLanes, boxes: [...placed.values()], edges }
}
