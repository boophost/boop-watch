#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { extractSection, splitIncludedByPr, findUncheckedInLines } from '../lib/promotion-checklist.mjs'
import { filterCredentials, getEarliestReset, credentialPool } from './cooldown.mjs'

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function shJson(cmd, args) {
  return JSON.parse(sh(cmd, args))
}

async function main() {
  const prNumber = process.argv[2]
  if (!prNumber) {
    console.error('Usage: catch-up.mjs <prNumber>')
    process.exit(2)
  }

  const pr = shJson('gh', ['pr', 'view', prNumber, '--json', 'body'])
  const incLines = extractSection(pr.body, '## Included changes')
  const uncheckedPrs = []

  if (incLines) {
    for (const [featPr, { lines: prLines }] of splitIncludedByPr(incLines)) {
      if (findUncheckedInLines(prLines).length > 0) {
        uncheckedPrs.push(featPr)
      }
    }
  }

  const prodLines = extractSection(pr.body, '## Production promotion checklist')
  const prodUnchecked = (prodLines ? findUncheckedInLines(prodLines) : []).filter(t => !/^post-merge:/i.test(t))
  
  const commentMarker = '<!-- promotion-qa-trigger -->'

  if (uncheckedPrs.length === 0 && prodUnchecked.length === 0) {
    console.log('No unchecked items. Promotion ready.')
    const commentBody = `${commentMarker}\n### ✅ All items verified\n\nNothing to QA — ok to merge if gate green.`
    try {
      const comments = shJson('gh', ['api', `/repos/{owner}/{repo}/issues/${prNumber}/comments`])
      const existing = comments.find(c => c.body && c.body.includes(commentMarker))
      if (existing) {
        sh('gh', ['api', '-X', 'PATCH', `/repos/{owner}/{repo}/issues/comments/${existing.id}`, '-f', `body=${commentBody}`])
      } else {
        sh('gh', ['pr', 'comment', prNumber, '-b', commentBody])
      }
    } catch (e) {}
    process.exit(0)
  }

  // Check cooldown before attempting QA
  const creds = credentialPool()
  if (creds.length > 0 && filterCredentials(creds).length === 0) {
    const earliest = getEarliestReset(creds) || 'unknown'
    console.log('All credentials cooling down until ' + earliest)
    const commentBody = `${commentMarker}\n### ⚠️ QA paused\n\nQA paused — all credentials rate limited until ${earliest} (UTC). This PR is converted back to a draft.`
    
    // Convert to draft
    try { sh('gh', ['pr', 'ready', prNumber, '--undo']) } catch (e) {}
    
    try {
      const comments = shJson('gh', ['api', `/repos/{owner}/{repo}/issues/${prNumber}/comments`])
      const existing = comments.find(c => c.body && c.body.includes(commentMarker))
      if (existing) {
        sh('gh', ['api', '-X', 'PATCH', `/repos/{owner}/{repo}/issues/comments/${existing.id}`, '-f', `body=${commentBody}`])
      } else {
        sh('gh', ['pr', 'comment', prNumber, '-b', commentBody])
      }
    } catch (e) {}
    
    process.exit(0) // Successful job exit
  }

  if (uncheckedPrs.length > 0) {
    console.log(`Need to catch up feature PRs: ${uncheckedPrs.join(', ')}`)
    let hasFailures = false
    
    for (const featPr of uncheckedPrs) {
      console.log(`\n--- Catching up QA for #${featPr} ---`)
      try {
        // Run qa-agent against staging!
        execFileSync('node', ['scripts/qa-agent/run.mjs', String(featPr), '--catch-up'], { 
          stdio: 'inherit',
          env: {
            ...process.env,
            BASE_URL: 'http://boop-watch-dev.link-apps.svc.cluster.local',
            QA_REFRESH_PROMOTION: '0' // don't refresh after each PR, we do it at the end
          }
        })
      } catch (e) {
        console.error(`Failed to run QA for #${featPr}: ${e.message}`)
        hasFailures = true
      }
    }

    // After all PRs are QA'd, trigger the promotion refresh manually once.
    console.log('Triggering promotion refresh...')
    try {
      sh('gh', ['workflow', 'run', 'rolling-dev-main-pr.yml', '-f', 'ref=dev'])
    } catch (e) {
      console.error('Failed to trigger refresh:', e.message)
    }

    if (hasFailures) {
      console.log('Some catch-up QA had failures. Converting to draft.')
      try { sh('gh', ['pr', 'ready', prNumber, '--undo']) } catch (e) {}
    }
  } else {
    // If only production checklist items are unchecked (like manual steps), we still convert to draft
    console.log('Only production checklist items remain. Converting to draft.')
    try { sh('gh', ['pr', 'ready', prNumber, '--undo']) } catch (e) {}
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
