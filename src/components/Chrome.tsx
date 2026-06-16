import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Icon } from './Icon'
import { loadCatalog, imgUrl, type CatalogItem } from '@/lib/api'

const initials = (n: string) =>
  (String(n).match(/[A-Za-z0-9]+/g) || []).slice(0, 2).map((s) => s[0]).join('').toUpperCase()
const hrefFor = (it: CatalogItem) => (it.type === 'Series' ? `/series/${it.id}` : `/movie/${it.id}`)

// Ranking ported from the legacy search palette: exact > prefix > word-prefix >
// substring > subsequence.
function score(name: string, q: string): number {
  name = name.toLowerCase()
  if (name === q) return 1000
  if (name.indexOf(q) === 0) return 850 - name.length
  const words = name.split(/[^a-z0-9]+/)
  for (let i = 0; i < words.length; i++) if (words[i] && words[i].indexOf(q) === 0) return 700 - i
  const at = name.indexOf(q)
  if (at > 0) return 500 - at
  let qi = 0
  for (let j = 0; j < name.length && qi < q.length; j++) if (name[j] === q[qi]) qi++
  return qi === q.length ? 150 - name.length : 0
}

export function Chrome({ crumb }: { crumb?: ReactNode }) {
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    loadCatalog().then((c) => setCatalog(c.items)).catch(() => {})
  }, [])

  // "/" focuses the search bar from anywhere (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      const tag = el && el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Click outside closes the dropdown.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return []
    return catalog
      .map((it) => ({ it, s: score(it.name, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.name.localeCompare(b.it.name))
      .slice(0, 8)
      .map((x) => x.it)
  }, [q, catalog])

  const showBox = open && q.trim().length > 0
  useEffect(() => { setActive(0) }, [q])

  const go = (it: CatalogItem) => { setOpen(false); navigate(hrefFor(it)) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!showBox) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { if (results[active]) { e.preventDefault(); go(results[active]) } }
    else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
  }

  return (
    <header className="chrome">
      <Link className="brand" to="/">
        <span className="brand-mark">B</span>
        <span className="label">boopurnoes <span className="sub">· watch</span></span>
      </Link>
      <form
        ref={formRef}
        className="searchbar"
        role="search"
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); if (results[active]) go(results[active]) }}
      >
        <span className="search-icon"><Icon name="search" size={16} /></span>
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          name="q"
          placeholder="Search the library…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search the library"
          role="combobox"
          aria-expanded={showBox}
          aria-controls="search-results"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <span className="search-kbd"><span className="kbd">/</span></span>
        {showBox && (
          <div className="search-results" id="search-results" role="listbox">
            {results.length === 0 ? (
              <div className="sr-empty">No matches for “{q.trim()}”</div>
            ) : (
              results.map((it, i) => (
                <Link
                  key={it.id}
                  className="sr-row"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  to={hrefFor(it)}
                  onClick={() => setOpen(false)}
                  onMouseEnter={() => setActive(i)}
                >
                  <div className="sr-thumb">
                    <span>{initials(it.name)}</span>
                    <img src={imgUrl(it.id)} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
                  </div>
                  <div className="sr-main">
                    <div className="sr-title">{it.name}</div>
                    <div className="sr-meta font-mono">
                      {[it.type === 'Series' ? 'Series' : 'Movie',
                        ...(it.genres?.length ? [it.genres.slice(0, 2).join(' · ')] : []),
                        ...(it.year ? [String(it.year)] : [])].join('  ·  ')}
                    </div>
                  </div>
                  <span className="sr-go"><Icon name={it.type === 'Series' ? 'tv' : 'play'} size={it.type === 'Series' ? 14 : 13} fill={it.type === 'Series' ? 'none' : 'currentColor'} /></span>
                </Link>
              ))
            )}
          </div>
        )}
      </form>
      <div className="chrome-right">{crumb}</div>
    </header>
  )
}
