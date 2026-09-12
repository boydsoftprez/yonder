// SPDX-License-Identifier: GPL-3.0-or-later
// R-HW-04/R-SEC-07: release bytes must identify a reviewed, checked revision.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGETS = Object.freeze(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const VERSION = /^(20\d{2})\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

export function releaseRequest({ event, ref, version, target = 'all' }) {
  if (!VERSION.test(version ?? '')) throw new Error('Invalid source CalVer');
  if (target !== 'all' && !TARGETS.includes(target)) throw new Error('Unknown image target');
  if (event !== 'workflow_dispatch' && event !== 'push') throw new Error('Unsupported release event');
  const tag = `v${version}`;
  if (event === 'push' && (ref !== `refs/tags/${tag}` || target !== 'all')) {
    throw new Error('A release tag must match the source version and build every target');
  }
  if (event === 'workflow_dispatch' && ref !== 'refs/heads/main' && ref !== `refs/tags/${tag}`) {
    throw new Error('Manual release builds require main or the matching release tag');
  }
  return { version, tag, targets: target === 'all' ? [...TARGETS] : [target], fullRelease: target === 'all' };
}

export function successfulSourceCi(runs, revision, repository, workflowId) {
  if (!SHA.test(revision ?? '') || !Number.isSafeInteger(workflowId) || workflowId < 1) {
    throw new Error('Invalid source or CI workflow identity');
  }
  if (!Array.isArray(runs)) throw new Error('Invalid CI response');
  const matching = runs.filter(run => run.head_sha === revision && run.event === 'push'
    && run.head_branch === 'main' && run.repository?.full_name === repository
    && run.workflow_id === workflowId);
  matching.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
  const latest = matching[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('The latest main CI run for this exact source revision has not succeeded');
  }
  if (!Number.isSafeInteger(latest.id) || !Number.isSafeInteger(latest.run_attempt)) {
    throw new Error('Invalid CI run identity');
  }
  return { runId: latest.id, attempt: latest.run_attempt, workflowId, conclusion: 'success' };
}

export function verifyReleaseSource({ cwd = process.cwd(), event, ref, target, repository,
  git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  })), version = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).version,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const request = releaseRequest({ event, ref, version, target });
  const revision = git(['rev-parse', 'HEAD']);
  if (!SHA.test(revision)) throw new Error('Invalid checked-out revision');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Release source tree is not clean');
  // The caller fetches origin/main and signed tags from the trusted repository.
  git(['merge-base', '--is-ancestor', revision, 'refs/remotes/origin/main']);
  // GitHub verifies both maintainer and web-flow merge signatures. A fresh
  // runner has neither public key in its local GPG keyring; do not silently
  // skip that check or depend on keys inherited from a persistent runner.
  const commit = api(`repos/${repository}/commits/${revision}`);
  if (commit.sha !== revision || commit.commit?.verification?.verified !== true
    || commit.commit.verification.reason !== 'valid') throw new Error('Source commit signature is not verified');
  if (ref.startsWith('refs/tags/')) {
    if (git(['rev-parse', `${request.tag}^{commit}`]) !== revision) throw new Error('Tag does not identify the checkout');
    const tagObject = git(['rev-parse', `${request.tag}^{tag}`]);
    if (!SHA.test(tagObject)) throw new Error('Release tag is not annotated');
    const tag = api(`repos/${repository}/git/tags/${tagObject}`);
    if (tag.sha !== tagObject || tag.tag !== request.tag || tag.object?.type !== 'commit'
      || tag.object.sha !== revision || tag.verification?.verified !== true
      || tag.verification.reason !== 'valid') throw new Error('Release tag signature is not verified');
  }
  const workflow = api(`repos/${repository}/actions/workflows/ci.yml`);
  // Include queued/in-progress runs: an older green run must not conceal a rerun.
  const result = api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${revision}&event=push&branch=main&per_page=100`);
  if (!Number.isSafeInteger(result.total_count) || result.total_count > 100) {
    throw new Error('CI run listing is incomplete; refuse ambiguous release evidence');
  }
  const ci = successfulSourceCi(result.workflow_runs, revision, repository, workflow.id);
  return { schemaVersion: 1, ...request, repository, sourceRevision: revision, ci };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = process.argv[2];
    if (!output || process.argv.length !== 3) throw new Error('Usage: node image/lib/release-source.mjs OUTPUT.json');
    const result = verifyReleaseSource({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      target: process.env.IMAGE_TARGET || 'all', repository: process.env.GITHUB_REPOSITORY });
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Verified ${result.sourceRevision} for ${result.targets.join(', ')}`);
  } catch (error) {
    // Child stderr can contain remote response bodies; expose only our fixed errors.
    console.error(error?.status !== undefined ? 'Release source verification command failed' : error.message);
    process.exitCode = 1;
  }
}
