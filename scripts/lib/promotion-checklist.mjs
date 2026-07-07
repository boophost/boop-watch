// Shared markdown-checkbox parsing for the rolling promotion PR body.
// Used by update-promotion-pr.mjs (build the body) and
// check-promotion-checklist.mjs (gate on it) so the two never disagree on
// what counts as a checkbox or a section boundary.

export const CHECKBOX_RE = /^-\s*\[([ xX])\]\s*(.+)$/
export const HEADING_BOUNDARY_RE = /^##\s/
export const INCLUDED_PR_HEADING_RE = /^###\s+\[#(\d+)\]\([^)]*\)\s*(.+)$/

export function extractSection(body, heading) {
  if (!body) return null
  const lines = body.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.trim() === heading)
  if (startIdx === -1) return null
  const rest = lines.slice(startIdx + 1)
  const endIdx = rest.findIndex((l) => HEADING_BOUNDARY_RE.test(l))
  return endIdx === -1 ? rest : rest.slice(0, endIdx)
}

export function findUncheckedInLines(lines) {
  const unchecked = []
  for (const line of lines ?? []) {
    const m = line.match(CHECKBOX_RE)
    if (!m) continue
    if (m[1].trim() === '') unchecked.push(m[2].trim())
  }
  return unchecked
}

export function findCheckedInLines(lines) {
  const checked = new Set()
  for (const line of lines ?? []) {
    const m = line.match(CHECKBOX_RE)
    if (m && m[1].trim() !== '') checked.add(m[2].trim())
  }
  return checked
}

// Splits an "## Included changes" section into per-feature-PR groups
// ({ title, lines }), keyed by PR number, in source order.
export function splitIncludedByPr(lines) {
  const groups = new Map()
  let currentPr = null
  let currentGroup = null

  const flush = () => {
    if (currentPr !== null) groups.set(currentPr, currentGroup)
  }

  for (const line of lines ?? []) {
    const m = line.match(INCLUDED_PR_HEADING_RE)
    if (m) {
      flush()
      currentPr = Number(m[1])
      currentGroup = { title: m[2].trim(), lines: [] }
      continue
    }
    if (currentGroup) currentGroup.lines.push(line)
  }
  flush()

  return groups
}
