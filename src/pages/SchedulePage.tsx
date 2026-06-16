import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { PortalLayout } from '@/components/PortalLayout'
import { getSchedule, type SchedulePayload, type ScheduleEvent, type ScheduleDay } from '@/lib/api'

const LANG: Record<string, string> = { sub: 'SUB', dub: 'DUB', raw: 'RAW' }

function EventCard({ e }: { e: ScheduleEvent }) {
  return (
    <div className={`evt${e.now ? ' now' : ''}${e.aired ? ' aired' : ''}`}>
      <div className="evt-main">
        <div className="evt-thumb">
          {e.img && <img src={e.img} alt="" loading="lazy" onError={(ev) => ev.currentTarget.remove()} />}
        </div>
        <div className="evt-body">
          <div className="evt-title">{e.title}</div>
          <div className="evt-meta">
            <span className="evt-time">{e.time}</span>
            {e.ep && <span className="badge badge-mono badge-square">{e.ep}</span>}
            <span className={`lang lang-${e.type}`}>{LANG[e.type] || 'RAW'}</span>
          </div>
          <div className="evt-meta">
            <span className={`evt-label${e.aired ? '' : ' up'}`}>{e.aired ? 'Aired' : 'Upcoming'}</span>
            {e.now && <span className="badge badge-accent badge-square">Next</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SchedulePage() {
  const [params] = useSearchParams()
  const year = params.get('year') || ''
  const week = params.get('week') || ''
  const weekParam = (/^\d{4}$/.test(year) && /^\d{1,2}$/.test(week)) ? `year=${year}&week=${week}` : ''

  const [sched, setSched] = useState<SchedulePayload | null>(null)
  const [error, setError] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    setSched(null); setError('')
    getSchedule(weekParam).then((s) => {
      setSched(s)
      let idx = s.days.findIndex((d) => d.today)
      if (idx < 0) idx = s.days.findIndex((d) => d.events.length)
      setActiveIdx(idx < 0 ? 0 : idx)
    }).catch((e: Error) => setError(e.message))
  }, [weekParam])

  const today = useMemo(() => sched?.days.find((d) => d.today), [sched])

  if (error) {
    return <PortalLayout><main><p className="empty">{error}</p></main></PortalLayout>
  }
  if (!sched) {
    return <PortalLayout><main><p className="empty">Loading…</p></main></PortalLayout>
  }

  const prevHref = sched.prev ? `/schedule?year=${sched.prev.year}&week=${sched.prev.week}` : ''
  const nextHref = sched.next ? `/schedule?year=${sched.next.year}&week=${sched.next.week}` : ''
  const stat = (k: string, v: number | string, s: string) => (
    <div className="cal-stat">
      <div className="h-eyebrow" style={{ fontSize: 10 }}>{k}</div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
    </div>
  )

  return (
    <PortalLayout>
      <main>
        <div className="section-head">
          <div className="h-eyebrow">{sched.isCurrent ? 'This week' : 'Week of'} · {sched.range}</div>
          <h1 className="k-h1">Schedule</h1>
          <p>The latest episode of each title in your library, via animeschedule.net.</p>
        </div>

        <div className="cal-nav">
          {prevHref
            ? <Link className="btn btn-secondary btn-icon" to={prevHref} aria-label="Previous week"><Icon name="back" size={16} /></Link>
            : <span className="btn btn-secondary btn-icon disabled" aria-hidden><Icon name="back" size={16} /></span>}
          {sched.isCurrent
            ? <span className="btn btn-secondary disabled">Today</span>
            : <Link className="btn btn-secondary" to="/schedule">Today</Link>}
          {nextHref
            ? <Link className="btn btn-secondary btn-icon" to={nextHref} aria-label="Next week"><Icon name="fwd" size={16} /></Link>
            : <span className="btn btn-secondary btn-icon disabled" aria-hidden><Icon name="fwd" size={16} /></span>}
          <span className="cal-range">{sched.range}</span>
        </div>

        <div className="cal-stats">
          {stat('This week', sched.stats.total, 'episodes')}
          {stat('Today', today ? today.count : 0, today ? today.label : '')}
          {stat('Aired', sched.stats.aired, 'already out')}
          {stat('Upcoming', sched.stats.upcoming, 'still to air')}
        </div>

        <div className="cal-tabs">
          {sched.days.map((d: ScheduleDay, i) => (
            <button
              key={d.iso} className={`cal-tab${d.today ? ' today' : ''}`} type="button"
              data-active={i === activeIdx} onClick={() => setActiveIdx(i)}
            >
              <span className="d">{d.dow}</span>
              <span className="n">{(d.label.match(/\d+/) || [''])[0]}</span>
              <span className="c">{d.count ? `${d.count} ep` : '—'}</span>
            </button>
          ))}
        </div>

        <div className="cal-scroll">
          <div className="cal-week">
            {sched.days.map((d, i) => (
              <div key={d.iso} className={`cal-day${d.today ? ' today' : ''}`} data-active={i === activeIdx}>
                <div className="cal-day-head">
                  <div>
                    <div className="cal-dow">{d.dow}</div>
                    <div className="cal-date">{d.label}</div>
                  </div>
                  {d.count > 0 && <span className="badge badge-mono">{d.count}</span>}
                </div>
                <div className="cal-events">
                  {d.events.length
                    ? d.events.map((e, j) => <EventCard key={j} e={e} />)
                    : <div className="cal-empty">No episodes</div>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {sched.stats.total === 0 && (
          <p className="empty">No episodes this week for titles in your library. Add airing series to the “Public” collection to see them here.</p>
        )}
      </main>
    </PortalLayout>
  )
}
