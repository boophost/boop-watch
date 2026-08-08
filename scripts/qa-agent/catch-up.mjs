#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { extractSection, splitIncludedByPr, findUncheckedInLines } from '../lib/promotion-checklist.mjs'
import { filterCredentials, getEarliestReset, credentialPool } from './cooldown.mjs'
import { ghApi } from './gh.mjs'

// This runs on the self-hosted k3s-cp runner, which has **no `gh` CLI** — only
// ubuntu-latest ships one. Everything here goes through the REST helper the
// other self-hosted steps already use. Shelling out to `gh` fails ENOENT on the
// first call and takes the whole job with it, which is what hid the fact that
// catch-up QA had never run at all.
const REPO = process.env.GITHUB_REPOSITORY || process.env.QA_REPO

/** PR body, or '' when the PR can't be read. */
const prBody = async (pr) => (await ghApi('GET', `/repos/${REPO}/pulls/${pr}`)).body || ''

/** Post a marked comment, editing the existing one when it's already there. */
async function upsertComment(pr, marker, body) {
  const comments = await ghApi('GET', `/repos/${REPO}/issues/${pr}/comments`)
  const existing = comments.find((c) => c.body && c.body.includes(marker))
  if (existing) await ghApi('PATCH', `/repos/${REPO}/issues/comments/${existing.id}`, { body })
  else await ghApi('POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
}

/** Convert a PR back to a draft. REST needs the node id + GraphQL for this. */
async function toDraft(pr) {
  const { node_id: id } = await ghApi('GET', `/repos/${REPO}/pulls/${pr}`)
  await ghApi('POST', '/graphql', {
    query: 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}',
    variables: { id },
  })
}

/** Fire a workflow_dispatch. */
const dispatch = (workflow, ref, inputs) =>
  ghApi('POST', `/repos/${REPO}/actions/workflows/${workflow}/dispatches`, { ref, inputs })

async function main() {
  const prNumber = process.argv[2]
  if (!prNumber) {
    console.error('Usage: catch-up.mjs <prNumber>')
    process.exit(2)
  }

  const body = await prBody(prNumber)
  const incLines = extractSection(body, '## Included changes')
  const uncheckedPrs = []

  if (incLines) {
    for (const [featPr, { lines: prLines }] of splitIncludedByPr(incLines)) {
      if (findUncheckedInLines(prLines).length > 0) {
        uncheckedPrs.push(featPr)
      }
    }
  }

  const prodLines = extractSection(body, '## Production promotion checklist')
  const prodUnchecked = (prodLines ? findUncheckedInLines(prodLines) : []).filter(t => !/^post-merge:/i.test(t))
  
  const commentMarker = '<!-- promotion-qa-trigger -->'

  if (uncheckedPrs.length === 0 && prodUnchecked.length === 0) {
    console.log('No unchecked items. Promotion ready.')
    const commentBody = `${commentMarker}\n### ✅ All items verified\n\nNothing to QA — ok to merge if gate green.`
    try {
      await upsertComment(prNumber, commentMarker, commentBody)
    } catch (e) {
      console.error('Failed to comment:', e.message)
    }
    process.exit(0)
  }

  // Check cooldown before attempting QA
  const creds = credentialPool()
  if (creds.length > 0 && filterCredentials(creds).length === 0) {
    const earliest = getEarliestReset(creds) || 'unknown'
    console.log('All credentials cooling down until ' + earliest)
    const commentBody = `${commentMarker}\n### ⚠️ QA paused\n\nQA paused — all credentials rate limited until ${earliest} (UTC). This PR is converted back to a draft.`

    try { await toDraft(prNumber) } catch (e) { console.error('Failed to draft:', e.message) }
    try {
      await upsertComment(prNumber, commentMarker, commentBody)
    } catch (e) {
      console.error('Failed to comment:', e.message)
    }

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
            // The runner is a process on the k3s node, not a pod, so it has no
            // CoreDNS resolver and *.svc.cluster.local resolves to nothing.
            // Staging's own IngressRoute is reachable from anywhere.
            BASE_URL: process.env.QA_STAGING_URL || 'https://dev-watch.boopurno.es',
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
      // `ref` is the git ref the workflow runs on (its default branch), and the
      // `ref` *input* is the branch it summarises — they are not the same thing.
      await dispatch('rolling-dev-main-pr.yml', 'main', { ref: 'dev' })
    } catch (e) {
      console.error('Failed to trigger refresh:', e.message)
    }

    if (hasFailures) {
      console.log('Some catch-up QA had failures. Converting to draft.')
      try { await toDraft(prNumber) } catch (e) { console.error('Failed to draft:', e.message) }
    }
  } else {
    // If only production checklist items are unchecked (like manual steps), we still convert to draft
    console.log('Only production checklist items remain. Converting to draft.')
    try { await toDraft(prNumber) } catch (e) { console.error('Failed to draft:', e.message) }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
