#!/usr/bin/env node
/**
 * Fails if the promotion PR still has unchecked boxes in its aggregated
 * feature test plans, or in the non-"Post-merge:" items of its production
 * promotion checklist. Used as a required status check on the rolling
 * dev -> main promotion PR (see .github/workflows/promotion-checklist-gate.yml).
 *
 * Usage: node scripts/check-promotion-checklist.mjs <pr-number>
 * Requires: gh (authenticated via GH_TOKEN/GITHUB_TOKEN)
 */

import { execFileSync } from 'node:child_process'

function sh(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' })
}

function shJson(cmd, args = []) {
  return JSON.parse(sh(cmd, args))
}

const CHECKBOX_RE = /^-\s*\[([ xX])\]\s*(.+)$/
const POST_MERGE_RE = /^post-merge:/i
const HEADING_BOUNDARY_RE = /^##\s/
const INCLUDED_PR_HEADING_RE = /^###\s+\[#(\d+)\]\([^)]*\)\s*(.+)$/

function extractSection(body, heading) {
  const lines = body.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.trim() === heading)
  if (startIdx === -1) return null
  const rest = lines.slice(startIdx + 1)
  const endIdx = rest.findIndex((l) => HEADING_BOUNDARY_RE.test(l))
  return endIdx === -1 ? rest : rest.slice(0, endIdx)
}

function findUncheckedInLines(lines) {
  const unchecked = []
  for (const line of lines) {
    const m = line.match(CHECKBOX_RE)
    if (!m) continue
    const [, mark, text] = m
    if (mark.trim() === '') unchecked.push(text.trim())
  }
  return unchecked
}

function checkProductionChecklist(body) {
  const lines = extractSection(body, '## Production promotion checklist')
  if (!lines) return []
  return findUncheckedInLines(lines).filter((text) => !POST_MERGE_RE.test(text))
}

function checkIncludedChanges(body) {
  const lines = extractSection(body, '## Included changes')
  if (!lines) return []

  const issues = []
  let currentPr = null
  let currentLines = []

  const flush = () => {
    if (!currentPr) return
    const unchecked = findUncheckedInLines(currentLines)
    if (unchecked.length > 0) issues.push({ pr: currentPr, unchecked })
  }

  for (const line of lines) {
    const headingMatch = line.match(INCLUDED_PR_HEADING_RE)
    if (headingMatch) {
      flush()
      currentPr = `#${headingMatch[1]} ${headingMatch[2]}`.trim()
      currentLines = []
      continue
    }
    currentLines.push(line)
  }
  flush()

  return issues
}

function main() {
  const prNumber = process.argv[2]
  if (!prNumber) {
    console.error('Usage: check-promotion-checklist.mjs <pr-number>')
    process.exit(2)
  }

  const pr = shJson('gh', ['pr', 'view', prNumber, '--json', 'body,title'])
  const body = pr.body ?? ''

  const checklistIssues = checkProductionChecklist(body)
  const includedIssues = checkIncludedChanges(body)

  if (checklistIssues.length === 0 && includedIssues.length === 0) {
    console.log('All promotion checklists complete (staging verified for every included change).')
    return
  }

  console.error(`Promotion checklist incomplete on "${pr.title}":\n`)

  if (checklistIssues.length > 0) {
    console.error('Production promotion checklist — unchecked:')
    for (const item of checklistIssues) console.error(`  - [ ] ${item}`)
    console.error('')
  }

  if (includedIssues.length > 0) {
    console.error('Included changes with unfinished staging test plans:')
    for (const { pr: prLabel, unchecked } of includedIssues) {
      console.error(`  ${prLabel}:`)
      for (const item of unchecked) console.error(`    - [ ] ${item}`)
    }
  }

  process.exit(1)
}

main()
