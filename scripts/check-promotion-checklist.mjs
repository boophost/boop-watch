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
import { extractSection, findUncheckedInLines, splitIncludedByPr } from './lib/promotion-checklist.mjs'

function sh(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' })
}

function shJson(cmd, args = []) {
  return JSON.parse(sh(cmd, args))
}

const POST_MERGE_RE = /^post-merge:/i

function checkProductionChecklist(body) {
  const lines = extractSection(body, '## Production promotion checklist')
  if (!lines) return []
  return findUncheckedInLines(lines).filter((text) => !POST_MERGE_RE.test(text))
}

function checkIncludedChanges(body) {
  const lines = extractSection(body, '## Included changes')
  if (!lines) return []

  const issues = []
  for (const [prNumber, { title, lines: prLines }] of splitIncludedByPr(lines)) {
    const unchecked = findUncheckedInLines(prLines)
    if (unchecked.length > 0) issues.push({ prNumber, title, unchecked })
  }
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
    for (const { prNumber: num, title, unchecked } of includedIssues) {
      console.error(`  #${num} ${title}:`)
      for (const item of unchecked) console.error(`    - [ ] ${item}`)
    }
  }

  process.exit(1)
}

main()
