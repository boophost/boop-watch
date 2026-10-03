// Decision logic for the deploy watchdog, kept free of `gh`/IO so it can be
// exercised directly (see deploy-watchdog.mjs for the API calls that feed it).
//
// The question it answers, per auto-deploying branch: did the newest push
// build an image and then fail to roll it onto the cluster?

// branch -> the docker-publish job that rolls the matching k3s Deployment.
export const DEPLOY_JOBS = {
  main: 'deploy',
  dev: 'deploy-dev',
}

// Conclusions that mean "this deploy never rolled, but could have". `skipped`
// is deliberately excluded — every run skips the deploy job for the *other*
// branch, so treating it as broken would re-run deploys forever.
export const RERUNNABLE = new Set(['cancelled', 'failure', 'timed_out', 'stale'])

/**
 * @param {object|null} run   newest push run of the build workflow, or null
 * @param {Array<{name:string,id:number,conclusion:string|null}>} jobs
 * @param {string} deployJobName
 * @returns {{action:'rerun'|'ok'|'skip', jobId?:number, reason:string}}
 */
export function decide(run, jobs, deployJobName) {
  if (!run) return { action: 'skip', reason: 'no push run found' }

  // An in-flight run's deploy may simply not have started yet, and re-running
  // a job of an incomplete run is rejected by the API anyway.
  if (run.status !== 'completed') {
    return { action: 'skip', reason: `run still ${run.status}` }
  }

  const build = jobs.find((j) => j.name === 'build')
  const deploy = jobs.find((j) => j.name === deployJobName)

  // No image was pushed, so there is nothing to roll. A red build belongs to
  // whoever pushed it — the watchdog must not paper over it.
  if (!build || build.conclusion !== 'success') {
    return { action: 'skip', reason: 'build did not succeed — not a deploy problem' }
  }
  if (!deploy) return { action: 'skip', reason: `no \`${deployJobName}\` job on this run` }
  if (deploy.conclusion === 'success') {
    return { action: 'ok', reason: `\`${deployJobName}\` succeeded` }
  }
  if (!RERUNNABLE.has(deploy.conclusion)) {
    return { action: 'skip', reason: `\`${deployJobName}\` is \`${deploy.conclusion}\`` }
  }

  return {
    action: 'rerun',
    jobId: deploy.id,
    reason: `\`${deployJobName}\` is \`${deploy.conclusion}\` though build succeeded`,
  }
}
