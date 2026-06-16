// Schedule — weekly anime airings scraped from animeschedule.net's homepage,
// filtered to titles in the Public library. Ported from the legacy server.
import { getCollectionItems, type JfItem } from './jellyfin.js'

const SCHEDULE_TZ = process.env.SCHEDULE_TZ || process.env.TZ || 'America/New_York'
const SCHEDULE_TTL_MS = 30 * 60 * 1000

interface WeekRef { year: number; week: number }
interface Airing { title: string; ep: string; when: Date; localDate: string; img: string | null; type: string }
interface ParsedWeek { airings: Airing[]; prev: WeekRef | null; next: WeekRef | null }

const scheduleCache = new Map<string, { result?: ParsedWeek; at: number; loading: Promise<ParsedWeek> | null }>()

const decodeEntities = (s: string): string => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Title normalization for matching airings against the library.
const normTitle = (s: string): string => String(s).toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
  .replace(/[^a-z0-9]+/g, ' ').trim()
// Drop trailing season/part markers so "Frieren Season 2" matches "Frieren".
const baseTitle = (s: string): string => normTitle(s)
  .replace(/\b(season|cour|part|s)\s*\d+\b/g, ' ')
  .replace(/\b\d+(st|nd|rd|th)?\s+(season|cour|part)\b/g, ' ')
  .replace(/\b(i{1,3}|iv|v|vi{1,3}|ix|x)$/, ' ')        // trailing roman numeral
  .replace(/\s+\d+$/, ' ')                              // trailing number
  .replace(/\s+/g, ' ').trim()

// Generic words that don't identify a show (so they can't bridge two titles).
const TITLE_STOP = new Set(('the and of to in on at as is or no na ni wa ga de da wo desu ka mo ' +
  'season cour part story life world another isekai again after final movie special ova ' +
  'time your hero saga arc days kara shitara datta').split(/\s+/))
// Distinctive tokens of a title: 4+ chars, not a generic word.
const sigTokens = (s: string): string[] => baseTitle(s).split(' ').filter((w) => w.length >= 4 && !TITLE_STOP.has(w))

// Manual romaji aliases. Some library shows store an English name (TheTVDB) and a
// *kanji* OriginalTitle, which yields no Latin tokens — so they can't bridge to
// animeschedule's romaji title. Map English base-title -> romaji, to seed extra
// signature tokens. Add an entry when a known airing show won't match.
const TITLE_ALIASES: [string, string][] = [
  ['classroom of the elite', 'youkoso jitsuryoku shijou shugi no kyoushitsu e'],
]

// Keep only airings whose show is in the library. animeschedule uses romaji; the
// library often stores English (TheTVDB), so fall back to a shared distinctive
// token (e.g. "slime", "zero"), restricted to library *series*.
function libraryMatcher(items: JfItem[]): (title: string) => boolean {
  const exact = new Set<string>()
  const seriesSig: Set<string>[] = []
  for (const it of items) {
    for (const name of [it.Name, it.OriginalTitle].filter(Boolean) as string[]) {
      exact.add(normTitle(name))
      const b = baseTitle(name)
      if (b) exact.add(b)
    }
    if (it.Type === 'Series') {
      const names = [it.Name, it.OriginalTitle].filter(Boolean) as string[]
      const sig = new Set(names.flatMap(sigTokens))
      const bases = names.map(baseTitle)
      for (const [en, romaji] of TITLE_ALIASES) {
        if (bases.includes(en)) for (const t of sigTokens(romaji)) sig.add(t)
      }
      if (sig.size) seriesSig.push(sig)
    }
  }
  return (title: string) => {
    const n = normTitle(title)
    const b = baseTitle(title)
    if (exact.has(n) || exact.has(b)) return true
    const ts = sigTokens(title)
    return ts.length > 0 && seriesSig.some((set) => ts.some((t) => set.has(t)))
  }
}

// Collapse to one entry per show: its most recent episode, preferring SUB > RAW > DUB.
const TYPE_RANK: Record<string, number> = { sub: 0, raw: 1, dub: 2 }
function latestPerShow(items: Airing[]): Airing[] {
  const byShow = new Map<string, Airing & { epNum: number }>()
  for (const it of items) {
    const key = normTitle(it.title)
    const cand = { ...it, epNum: parseInt(String(it.ep).replace(/[^0-9]/g, ''), 10) }
    const cur = byShow.get(key)
    if (!cur) { byShow.set(key, cand); continue }
    const a = cand.epNum, b = cur.epNum
    let win: boolean
    if (!isNaN(a) && !isNaN(b) && a !== b) win = a > b
    else {
      const rc = TYPE_RANK[cand.type] ?? 9, rk = TYPE_RANK[cur.type] ?? 9
      win = rc !== rk ? rc < rk : cand.when < cur.when
    }
    if (win) byShow.set(key, cand)
  }
  return [...byShow.values()]
}

// Parse a week page -> { airings, prev, next }.
function parseTimetable(html: string): ParsedWeek {
  const body = html.slice(html.indexOf('</head>'))

  const nav = [...new Set(html.match(/\?year=\d+&week=\d+/g) || [])]
    .map((q) => { const m = q.match(/year=(\d+)&week=(\d+)/)!; return { year: +m[1], week: +m[2] } })
    .sort((a, b) => (a.year - b.year) || (a.week - b.week))
  const prev = nav[0] || null
  const next = nav[nav.length - 1] || null

  const re = /<h2 class="show-title-bar[^"]*">([^<]+)<\/h2>[\s\S]{0,500}?<span class="show-episode">([^<]*)<\/span>[\s\S]{0,400}?<time datetime="([^"]+)"[\s\S]{0,500}?airType="([^"]+)"/g
  const airings: Airing[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const title = decodeEntities(m[1]).trim()
    const ep = decodeEntities(m[2]).trim()
    const iso = decodeEntities(m[3]).trim()
    const when = new Date(iso)
    if (isNaN(when.getTime())) continue
    const localDate = iso.slice(0, 10)   // site-local date — lines up with the columns
    const at = decodeEntities(m[4]).toLowerCase()
    const type = at.includes('sub') ? 'sub' : at.includes('dub') ? 'dub' : 'raw'
    const key = `${normTitle(title)}|${ep}|${iso}|${type}`
    if (seen.has(key)) continue
    seen.add(key)
    const pre = body.slice(Math.max(0, m.index - 2600), m.index)
    const imgs = pre.match(/https:\/\/img\.animeschedule\.net\/[^\s"']+?\.jpg/g)
    let img = imgs ? imgs[imgs.length - 1] : null
    if (img) img = img.replace(/&amp;/g, '&') + '?w=120&q=85'
    airings.push({ title, ep, when, localDate, img, type })
  }
  return { airings, prev, next }
}

// Fetch + cache one week. weekParam '' = current week; else 'year=Y&week=W'.
async function getWeek(weekParam: string): Promise<ParsedWeek> {
  const k = weekParam || 'current'
  const hit = scheduleCache.get(k)
  if (hit && hit.result && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.result
  if (hit && hit.loading) return hit.loading
  const url = 'https://animeschedule.net/' + (weekParam ? `?${weekParam}` : '')
  const loading = fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`animeschedule -> ${res.status}`)
      const result = parseTimetable(await res.text())
      scheduleCache.set(k, { result, at: Date.now(), loading: null })
      return result
    })
    .catch((e) => {
      scheduleCache.set(k, { result: hit && hit.result, at: 0, loading: null })
      throw e
    })
  scheduleCache.set(k, { result: hit && hit.result, at: hit ? hit.at : 0, loading })
  return loading
}

// tz-aware formatters (one absolute instant -> parts in SCHEDULE_TZ)
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: SCHEDULE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit' })

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface ScheduleEvent {
  title: string; ep: string; img: string | null; type: string
  time: string; aired: boolean; now: boolean
}
export interface ScheduleDay {
  iso: string; dow: string; label: string; today: boolean
  events: ScheduleEvent[]; count: number
}
export interface SchedulePayload {
  days: ScheduleDay[]
  range: string
  isCurrent: boolean
  prev: WeekRef | null
  next: WeekRef | null
  stats: { total: number; today: number; aired: number; upcoming: number }
}

// Build the Mon..Sun window for the fetched week, derived from the airings' own
// site-local dates (the homepage reorders/special-cases today), bucket the items.
function buildDays(items: Airing[], allAirings: Airing[], now: Date): ScheduleDay[] {
  if (!allAirings.length) return []
  const sorted = allAirings.map((a) => a.localDate).sort()
  const [y, mo, d] = sorted[Math.floor(sorted.length / 2)].split('-').map(Number)
  const ref = new Date(Date.UTC(y, mo - 1, d))
  const mondayMs = ref.getTime() - ((ref.getUTCDay() + 6) % 7) * 86400000
  const todayKey = fmtKey.format(now)

  interface DayBuild { iso: string; dow: string; label: string; today: boolean; events: (Airing & { aired: boolean; now: boolean })[] }
  const days: DayBuild[] = []
  for (let i = 0; i < 7; i++) {
    const dt = new Date(mondayMs + i * 86400000)
    const iso = dt.toISOString().slice(0, 10)
    days.push({
      iso, dow: DOW_SHORT[dt.getUTCDay()],
      label: `${dt.getUTCDate()} ${MON_SHORT[dt.getUTCMonth()]}`,
      today: iso === todayKey, events: [],
    })
  }
  const byIso = Object.fromEntries(days.map((dd) => [dd.iso, dd]))
  for (const a of items) {
    const b = byIso[a.localDate]
    if (b) b.events.push({ ...a, aired: false, now: false })
  }
  let next: (Airing & { aired: boolean; now: boolean }) | null = null
  for (const dd of days) {
    dd.events.sort((a, b) => a.when.getTime() - b.when.getTime())
    for (const e of dd.events) {
      e.aired = e.when < now
      if (!e.aired && (!next || e.when < next.when)) next = e
    }
  }
  if (next) next.now = true
  return days.map((dd) => ({
    iso: dd.iso, dow: dd.dow, label: dd.label, today: dd.today, count: dd.events.length,
    events: dd.events.map((e) => ({
      title: e.title, ep: e.ep, img: e.img, type: e.type,
      time: fmtTime.format(e.when), aired: e.aired, now: e.now,
    })),
  }))
}

/** weekParam: '' for the current week, or 'year=Y&week=W'. */
export async function getSchedule(weekParam: string): Promise<SchedulePayload> {
  const week = await getWeek(weekParam)
  const inLibrary = libraryMatcher(getCollectionItems())
  const items = latestPerShow(week.airings.filter((it) => inLibrary(it.title)))
  const now = new Date()
  const days = buildDays(items, week.airings, now)

  const total = days.reduce((n, d) => n + d.count, 0)
  const today = days.find((d) => d.today)
  const aired = days.reduce((n, d) => n + d.events.filter((e) => e.aired).length, 0)
  const range = days.length ? `${days[0].label} — ${days[days.length - 1].label}` : ''
  return {
    days,
    range,
    isCurrent: weekParam === '',
    prev: week.prev,
    next: week.next,
    stats: { total, today: today ? today.count : 0, aired, upcoming: total - aired },
  }
}

export { SCHEDULE_TZ }
