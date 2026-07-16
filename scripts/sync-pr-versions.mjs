#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function sh(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

function shJson(cmd, args = []) {
  return JSON.parse(sh(cmd, args));
}

function getBumpType(baseVersion, prVersion) {
  const [bM, bm, bp] = baseVersion.split('.').map(Number);
  const [pM, pm, pp] = prVersion.split('.').map(Number);
  
  if (pM > bM) return 'major';
  if (pm > bm && pM === bM) return 'minor';
  if (pp > bp && pM === bM && pm === bm) return 'patch';
  return null;
}

function bumpVersion(version, type) {
  const [M, m, p] = version.split('.').map(Number);
  if (type === 'major') return `${M + 1}.0.0`;
  if (type === 'minor') return `${M}.${m + 1}.0`;
  if (type === 'patch') return `${M}.${m}.${p + 1}`;
  return version;
}

function main() {
  const currentBranch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  
  // Ensure we have latest origin/dev
  sh('git', ['fetch', 'origin', 'dev']);
  
  const currentDevVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  console.log(`Current base version (${currentBranch}): ${currentDevVersion}`);

  // Get open PRs targeting dev
  const prs = shJson('gh', [
    'pr', 'list', '--base', 'dev', '--state', 'open', '--json', 'number,headRefName,headRepository'
  ]);

  for (const pr of prs) {
    const branch = pr.headRefName;
    console.log(`\nChecking PR #${pr.number} (branch: ${branch})`);
    
    try {
      sh('gh', ['pr', 'checkout', String(pr.number)]);
      
      const prVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
      
      // Get base commit against origin/dev
      const baseCommit = sh('git', ['merge-base', 'origin/dev', 'HEAD']);
      
      const basePkgStr = sh('git', ['show', `${baseCommit}:package.json`]);
      const baseVersion = JSON.parse(basePkgStr).version;
      
      console.log(`Base version: ${baseVersion}, PR version: ${prVersion}`);
      
      const bumpType = getBumpType(baseVersion, prVersion);
      if (!bumpType) {
        console.log(`No version bump detected in PR, skipping.`);
        continue;
      }
      
      console.log(`Detected ${bumpType} bump.`);
      
      const newVersion = bumpVersion(currentDevVersion, bumpType);
      if (newVersion === prVersion) {
        console.log(`Version is already up to date (${newVersion}).`);
        continue;
      }
      
      let hadConflicts = false;
      try {
        sh('git', ['merge', 'origin/dev', '-m', `chore: sync with dev and bump version`]);
      } catch (e) {
        hadConflicts = true;
        const unmerged = sh('git', ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
        const onlyPackage = unmerged.every(f => f === 'package.json' || f === 'package-lock.json');
        
        if (!onlyPackage) {
          console.log(`PR #${pr.number} has non-package conflicts (${unmerged.join(', ')}). Aborting merge.`);
          sh('git', ['merge', '--abort']);
          continue;
        }
        
        console.log(`Resolving package.json conflict automatically...`);
        let pkgStr = readFileSync('package.json', 'utf8');
        const conflictRegex = /<<<<<<< HEAD\r?\n\s*"version":\s*"[^"]+",?\r?\n(?:\|\|\|\|\|\|\| [^\r\n]+\r?\n\s*"version":\s*"[^"]+",?\r?\n)?=======\r?\n\s*"version":\s*"[^"]+",?\r?\n>>>>>>> [^\r\n]+\r?\n/g;
        
        if (conflictRegex.test(pkgStr)) {
           pkgStr = pkgStr.replace(conflictRegex, `  "version": "${newVersion}",\n`);
           writeFileSync('package.json', pkgStr);
        } else {
           console.log(`Complex package.json conflict. Aborting.`);
           sh('git', ['merge', '--abort']);
           continue;
        }
        
        console.log(`Regenerating package-lock.json...`);
        sh('git', ['checkout', '--theirs', 'package-lock.json']);
        sh('npm', ['install', '--package-lock-only']);
        
        sh('git', ['add', 'package.json', 'package-lock.json']);
        sh('git', ['commit', '--no-edit']);
      }
      
      if (!hadConflicts) {
        const prVersionPostMerge = JSON.parse(readFileSync('package.json', 'utf8')).version;
        if (prVersionPostMerge !== newVersion) {
           sh('npm', ['--no-git-tag-version', 'version', newVersion]);
           sh('git', ['add', 'package.json', 'package-lock.json']);
           sh('git', ['commit', '--amend', '--no-edit']);
        }
      }
      
      sh('git', ['push']);
    } catch (e) {
      console.error(`Failed to update PR #${pr.number}: ${e.message}`);
    } finally {
      // Ensure we go back to the original branch
      try { sh('git', ['checkout', currentBranch]); } catch (e) {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
