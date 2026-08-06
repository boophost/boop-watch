import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { loadCatalog } from '@/lib/api'
import { SECTION_LABELS, SECTION_PATHS, type Section } from '@/lib/sections'

/** Header segmented control for swapping between the portal sections
 * (Anime / TV / Movies). Renders nothing until the catalog answers, and stays
 * hidden entirely when fewer than two sections are configured server-side —
 * a single-collection deployment keeps its old single-library header. */
export function SectionSwitch() {
  const [sections, setSections] = useState<Section[]>([])

  useEffect(() => {
    loadCatalog().then((c) => setSections(c.sections ?? [])).catch(() => {})
  }, [])

  if (sections.length < 2) return null

  return (
    <nav className="sect-switch" aria-label="Library section">
      {sections.map((s) => (
        <NavLink key={s} to={SECTION_PATHS[s]} end className="sect-btn">
          {SECTION_LABELS[s]}
        </NavLink>
      ))}
    </nav>
  )
}
