#!/usr/bin/env node
/**
 * Deploy watchdog: re-runs a deploy job that built an image but never rolled it.
 *
 * `deploy` / `deploy-dev` run on the self-hosted runner inside the cluster
 * (the k3s API is LAN-only), so they depend on GitHub's job broker reaching
 * that runner. When the broker has a bad day the job sits queued and is
 * eventually **cancelled**: the build succeeded and pushed the image, but
 * nothing rolled the Deployment, and nothing failed loudly — the cluster just
 * keeps serving the previous image. That happened on 2026-08-06 (114
 * `acquirejob` 5xx retries; `deploy-dev` sat queued 22 minutes and a
 * `preview-down` job was cancelled outright).
 *
 * Re-running a single job replays it with the original run's context, so
 * `needs.build.outputs.digest` still resolves to the image that build pushed
 * — the roll targets the right digest, not a newer or moving one.
 *
 * Usage: node scripts/deploy-watchdog.mjs [--dry-run]
 * Requires: gh (authenticated via GH_TOKEN/GITHUB_TOKEN)
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { DEPLOY_JOBS, decide } from './lib/deploy-watchdog.mjs'

const DRY_RUN = process.argv.includes('--dry-run')
const REPO = process.env.GITHUB_REPOSITORY || 'boophost/boop-watch'
const WORKFLOW = 'docker-publish.yml'

function gh(path, args = []) {
  return JSON.parse(execFileSync('gh', ['api', path, ...args], { encoding: 'utf8' }))
}

function latestPushRun(branch) {
  const q = `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=${branch}&event=push&per_page=1`
  const { workflow_runs: runs = [] } = gh(q)
  return runs[0] ?? null
}

function jobsFor(runId) {
  const { jobs = [] } = gh(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`)
  return jobs
}

function main() {
  const lines = [`### Deploy watchdog${DRY_RUN ? ' (dry run)' : ''}`, '']
  let reran = 0

  for (const [branch, jobName] of Object.entries(DEPLOY_JOBS)) {
    const run = latestPushRun(branch)
    const verdict = decide(run, run && run.status === 'completed' ? jobsFor(run.id) : [], jobName)
    const where = run ? `[${run.id}](${run.html_url})` : '(no run)'

    if (verdict.action === 'ok') {
      lines.push(`- \`${branch}\`: ✅ ${verdict.reason} on ${where}.`)
      continue
    }
    if (verdict.action === 'skip') {
      lines.push(`- \`${branch}\`: ${verdict.reason} — ${where}.`)
      continue
    }

    if (DRY_RUN) {
      lines.push(`- \`${branch}\`: ⚠️ would re-run — ${verdict.reason} on ${where}.`)
      continue
    }
    try {
      execFileSync('gh', ['api', '-X', 'POST', `repos/${REPO}/actions/jobs/${verdict.jobId}/rerun`], {
        encoding: 'utf8',
      })
      reran++
      lines.push(`- \`${branch}\`: 🔁 re-ran — ${verdict.reason} on ${where}.`)
    } catch (err) {
      // A re-run can be legitimately refused (e.g. the run aged past GitHub's
      // re-run window). Surface it instead of exiting non-zero every tick.
      lines.push(`- \`${branch}\`: ❌ re-run failed — ${verdict.reason} on ${where}. ${err.message.trim()}`)
    }
  }

  if (reran > 0) lines.push('', `Re-ran ${reran} stalled deploy job(s).`)
  const body = lines.join('\n')
  console.log(body)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n')
}

main()
