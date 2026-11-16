import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithub } from '../src/github.mjs';
import { fakeRun, has } from './helpers.mjs';

const repoJson = (over = {}) =>
  JSON.stringify({
    name: 'App',
    owner: { login: 'Octo' },
    archived: false,
    private: false,
    default_branch: 'trunk',
    permissions: { push: true },
    allow_squash_merge: false,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    ...over,
  });

test('getRepo reads the repository through gh api', async () => {
  const { run, calls } = fakeRun([[has('api', 'repos/octo/app'), { stdout: repoJson() }]]);
  const repo = await createGithub({ run, ghPath: '/bin/gh' }).getRepo('octo', 'app');
  assert.deepEqual(repo, {
    exists: true,
    owner: 'Octo',
    repo: 'App',
    archived: false,
    canPush: true,
    isPublic: true,
    defaultBranch: 'trunk',
    mergeMethods: ['merge', 'rebase'],
  });
  assert.equal(calls[0].argv[0], '/bin/gh');
});

test('getRepo reports a private, archived, read-only repository', async () => {
  const { run } = fakeRun([
    [has('api'), { stdout: repoJson({ private: true, archived: true, permissions: { push: false } }) }],
  ]);
  const repo = await createGithub({ run, ghPath: 'gh' }).getRepo('octo', 'app');
  assert.deepEqual([repo.isPublic, repo.archived, repo.canPush], [false, true, false]);
});

test('getRepo assumes every merge method when GitHub does not say', async () => {
  const { run } = fakeRun([
    [
      has('api'),
      { stdout: repoJson({ allow_squash_merge: undefined, allow_merge_commit: undefined, allow_rebase_merge: undefined }) },
    ],
  ]);
  const repo = await createGithub({ run, ghPath: 'gh' }).getRepo('octo', 'app');
  assert.deepEqual(repo.mergeMethods, ['squash', 'merge', 'rebase']);
});

test('getRepo says a repository does not exist on a 404', async () => {
  const { run } = fakeRun([[has('api'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' }]]);
  assert.deepEqual(await createGithub({ run, ghPath: 'gh' }).getRepo('octo', 'gone'), { exists: false });
});

test('getRepo throws when GitHub cannot be reached, instead of saying the repository is missing', async () => {
  const { run } = fakeRun([[has('api'), { code: 1, stderr: 'error connecting to api.github.com' }]]);
  await assert.rejects(() => createGithub({ run, ghPath: 'gh' }).getRepo('octo', 'app'), /GitHub/);
});

test('listNightshiftPrs returns only open pull requests from nightshift/ branches', async () => {
  const prs = [
    { number: 4, url: 'https://github.com/octo/app/pull/4', headRefName: 'nightshift/2026-01-02', headRefOid: 'aaa' },
    { number: 5, url: 'https://github.com/octo/app/pull/5', headRefName: 'feature/x', headRefOid: 'bbb' },
    { number: 6, url: 'https://github.com/octo/app/pull/6', headRefName: 'nightshift-lookalike', headRefOid: 'ccc' },
  ];
  const { run, calls } = fakeRun([[has('pr', 'list'), { stdout: JSON.stringify(prs) }]]);
  const found = await createGithub({ run, ghPath: 'gh' }).listNightshiftPrs('octo', 'app');
  assert.deepEqual(found.map((p) => p.number), [4]);
  const argv = calls[0].argv;
  assert.equal(argv[argv.indexOf('--repo') + 1], 'octo/app');
  assert.equal(argv[argv.indexOf('--state') + 1], 'open');
});

test('listNightshiftPrs throws when gh fails', async () => {
  const { run } = fakeRun([[has('pr', 'list'), { code: 1, stderr: 'boom' }]]);
  await assert.rejects(() => createGithub({ run, ghPath: 'gh' }).listNightshiftPrs('octo', 'app'), /pull requests/);
});
