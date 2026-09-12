// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseRequest, successfulSourceCi, verifyReleaseSource } from './release-source.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/yonder';
const run = { id: 20, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push',
  repository: { full_name: repository }, workflow_id: 7, status: 'completed', conclusion: 'success' };
test('manual single-board selection is explicitly partial; tag builds require all three', () => {
  assert.deepEqual(releaseRequest({ event: 'workflow_dispatch', ref: 'refs/heads/main',
    version: '2026.9.0', target: 'radxa-zero3w' }).targets, ['radxa-zero3w']);
  assert.equal(releaseRequest({ event: 'workflow_dispatch', ref: 'refs/heads/main',
    version: '2026.9.0', target: 'rpi' }).fullRelease, false);
  assert.equal(releaseRequest({ event: 'push', ref: 'refs/tags/v2026.9.0', version: '2026.9.0' }).targets.length, 3);
  for (const value of [
    { event: 'push', ref: 'refs/tags/v2026.9.1' },
    { event: 'push', ref: 'refs/tags/v2026.9.0', target: 'rpi' },
    { event: 'workflow_dispatch', ref: 'refs/heads/unreviewed' },
    { event: 'pull_request', ref: 'refs/heads/main' },
    { event: 'workflow_dispatch', ref: 'refs/heads/main', target: 'shell;command' },
  ]) assert.throws(() => releaseRequest({ version: '2026.9.0', ...value }));
  assert.throws(() => releaseRequest({ event: 'push', ref: 'refs/tags/v2026.09.0', version: '2026.09.0' }));
});
test('only the exact latest main CI from the expected repository and workflow authorizes release', () => {
  assert.equal(successfulSourceCi([run], sha, repository, 7).runId, 20);
  for (const changed of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' },
    { head_branch: 'feature' }, { repository: { full_name: 'fork/yonder' } },
    { workflow_id: 8 }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
    assert.throws(() => successfulSourceCi([{ ...run, ...changed }], sha, repository, 7));
  }
  assert.throws(() => successfulSourceCi([run, { ...run, id: 21, status: 'queued', conclusion: null }], sha, repository, 7));
  assert.throws(() => successfulSourceCi([run, { ...run, run_attempt: 2, conclusion: 'failure' }], sha, repository, 7));
});
test('source verification checks cleanliness, ancestry, signatures and resolved tag before CI', () => {
  const calls = [];
  const git = args => {
    calls.push(args);
    if (args[0] === 'rev-parse') return sha;
    return '';
  };
  const options = { event: 'push', ref: 'refs/tags/v2026.9.0', version: '2026.9.0', repository, git,
    api: endpoint => {
      if (endpoint.includes('/commits/')) return { sha, commit: { verification: { verified: true, reason: 'valid' } } };
      if (endpoint.includes('/git/tags/')) return { sha, tag: 'v2026.9.0', object: { sha, type: 'commit' }, verification: { verified: true, reason: 'valid' } };
      return endpoint.includes('/runs?') ? { total_count: 1, workflow_runs: [run] } : { id: 7 };
    } };
  assert.equal(verifyReleaseSource(options).sourceRevision, sha);
  assert.ok(calls.some(args => args.join(' ') === `merge-base --is-ancestor ${sha} refs/remotes/origin/main`));
  assert.ok(calls.some(args => args.join(' ') === 'rev-parse v2026.9.0^{tag}'));
  assert.throws(() => verifyReleaseSource({ ...options, git: args => args[0] === 'status' ? ' M file' : git(args) }));
  assert.throws(() => verifyReleaseSource({ ...options, git: args => {
    if (args[0] === 'merge-base') throw new Error('not on main');
    return git(args);
  } }));
  for (const section of ['/commits/', '/git/tags/']) {
    assert.throws(() => verifyReleaseSource({ ...options, api: endpoint => endpoint.includes(section)
      ? { ...options.api(endpoint), verification: { verified: false }, commit: { verification: { verified: false } } }
      : options.api(endpoint) }));
  }
  assert.throws(() => verifyReleaseSource({ ...options, api: endpoint => endpoint.includes('/runs?')
    ? { total_count: 101, workflow_runs: [run] } : options.api(endpoint) }));
});
