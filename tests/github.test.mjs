import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithub, pickMergeMethod } from '../src/github.mjs';
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
    { number: 7, url: 'https://github.com/octo/app/pull/7', headRefName: 'nightshift/2026-01-03', headRefOid: 'ddd', isCrossRepository: true },
  ];
  const { run, calls } = fakeRun([[has('pr', 'list'), { stdout: JSON.stringify(prs) }]]);
  const found = await createGithub({ run, ghPath: 'gh' }).listNightshiftPrs('octo', 'app');
  assert.deepEqual(found.map((p) => p.number), [4]);
  const argv = calls[0].argv;
  assert.equal(argv[argv.indexOf('--repo') + 1], 'octo/app');
  assert.equal(argv[argv.indexOf('--state') + 1], 'open');
  assert.match(argv[argv.indexOf('--json') + 1], /isCrossRepository/, 'a fork can name its branch anything, so forks must be told apart');
  assert.deepEqual(Object.keys(found[0]).sort(), ['headRefName', 'headRefOid', 'number', 'url']);
});

test('listNightshiftPrs throws when gh fails', async () => {
  const { run } = fakeRun([[has('pr', 'list'), { code: 1, stderr: 'boom' }]]);
  await assert.rejects(() => createGithub({ run, ghPath: 'gh' }).listNightshiftPrs('octo', 'app'), /pull requests/);
});

// ---- pull request operations ----

const sleeps = [];
function gh(answers) {
  const { run, calls } = fakeRun(answers);
  let clock = 0;
  const github = createGithub({
    run, ghPath: 'gh', gitPath: 'git',
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  return { github, calls, argvs: () => calls.map((c) => c.argv.join(' ')) };
}
const pr = { owner: 'octo', repo: 'app', number: 12 };
const noChecks = { code: 1, stderr: "no checks reported on the 'nightshift/2026-01-05' branch" };

test('pickMergeMethod prefers squash, then merge, then rebase', () => {
  assert.equal(pickMergeMethod(['rebase', 'merge', 'squash']), 'squash');
  assert.equal(pickMergeMethod(['rebase', 'merge']), 'merge');
  assert.equal(pickMergeMethod(['rebase']), 'rebase');
  assert.equal(pickMergeMethod([]), 'squash');
});

test('pushBranch pushes only the named nightshift branch from the job\'s clone', async () => {
  const { github, calls } = gh([[has('push'), {}]]);
  assert.deepEqual(await github.pushBranch({ repoDir: '/ws/repo', branch: 'nightshift/2026-01-05', defaultBranch: 'trunk' }), { ok: true, reason: null });
  assert.equal(calls[0].options.cwd, '/ws/repo');
  assert.deepEqual(calls[0].argv.slice(-3), ['--force', 'origin', 'refs/heads/nightshift/2026-01-05:refs/heads/nightshift/2026-01-05']);
});

test('pushBranch refuses the default branch and anything that is not a nightshift branch', async () => {
  const { github, calls } = gh([[has('push'), {}]]);
  for (const branch of ['trunk', 'main', 'feature/x', '', 'nightshift', 'refs/heads/trunk']) {
    const result = await github.pushBranch({ repoDir: '/ws/repo', branch, defaultBranch: 'trunk' });
    assert.equal(result.ok, false, branch);
  }
  const sneaky = await github.pushBranch({ repoDir: '/ws/repo', branch: 'nightshift/x', defaultBranch: 'nightshift/x' });
  assert.equal(sneaky.ok, false);
  assert.equal(calls.length, 0);
});

test('pushBranch reports a failed push', async () => {
  const { github } = gh([[has('push'), { code: 1, stderr: 'remote: Permission denied\nfatal: unable to access' }]]);
  assert.deepEqual(await github.pushBranch({ repoDir: '/ws/repo', branch: 'nightshift/a', defaultBranch: 'main' }), { ok: false, reason: 'fatal: unable to access' });
});

test('openPr targets the base it is given and returns the number and address', async () => {
  const { github, calls } = gh([[has('pr', 'create'), { stdout: 'https://github.com/octo/app/pull/12\n' }]]);
  const opened = await github.openPr({ owner: 'octo', repo: 'app', branch: 'nightshift/2026-01-05', base: 'trunk', title: 'Reject empty names', body: 'Body text' });
  assert.deepEqual(opened, { number: 12, url: 'https://github.com/octo/app/pull/12' });
  const argv = calls[0].argv;
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  assert.deepEqual([value('--repo'), value('--head'), value('--base'), value('--title'), value('--body')],
    ['octo/app', 'nightshift/2026-01-05', 'trunk', 'Reject empty names', 'Body text']);
});

test('openPr throws when gh fails', async () => {
  const { github } = gh([[has('pr', 'create'), { code: 1, stderr: 'pull request create failed: something' }]]);
  await assert.rejects(() => github.openPr({ owner: 'octo', repo: 'app', branch: 'nightshift/a', base: 'main', title: 't', body: 'b' }), /pull request/);
});

test('waitForChecks: passing checks', async () => {
  const { github, argvs } = gh([
    [has('pr', 'checks', '--json'), { stdout: JSON.stringify([{ name: 'test', bucket: 'pending' }]), code: 8 }],
    [has('pr', 'checks', '--watch'), { code: 0 }],
  ]);
  assert.deepEqual(await github.waitForChecks({ ...pr, timeoutMs: 60000 }), { state: 'pass', detail: null });
  assert.ok(argvs().some((a) => a.includes('--watch') && a.includes('--fail-fast') && a.includes('--repo octo/app') && a.includes(' 12 ')));
});

test('waitForChecks: a failing check is named', async () => {
  let asked = 0;
  const { github } = gh([
    [has('pr', 'checks', '--watch'), { code: 1 }],
    [has('pr', 'checks', '--json'), () => ({ code: asked++ ? 1 : 8, stdout: JSON.stringify([{ name: 'test', bucket: asked > 1 ? 'fail' : 'pending' }, { name: 'lint', bucket: 'pass' }]) })],
  ]);
  assert.deepEqual(await github.waitForChecks({ ...pr, timeoutMs: 60000 }), { state: 'fail', detail: 'test' });
});

test('waitForChecks: checks that never appear are "none", after waiting for them to start', async () => {
  sleeps.length = 0;
  const { github, argvs } = gh([[has('pr', 'checks'), noChecks]]);
  assert.deepEqual(await github.waitForChecks({ ...pr, timeoutMs: 30 * 60000 }), { state: 'none', detail: null });
  assert.ok(sleeps.length >= 5, 'it must give checks time to start');
  assert.equal(argvs().some((a) => a.includes('--watch')), false);
});

test('waitForChecks: checks that start late are still watched', async () => {
  let asked = 0;
  const { github } = gh([
    [has('pr', 'checks', '--json'), () => (asked++ < 3 ? noChecks : { code: 8, stdout: JSON.stringify([{ name: 'test', bucket: 'pending' }]) })],
    [has('pr', 'checks', '--watch'), { code: 0 }],
  ]);
  assert.equal((await github.waitForChecks({ ...pr, timeoutMs: 30 * 60000 })).state, 'pass');
});

test('waitForChecks: checks still pending at the time limit are "timeout"', async () => {
  const { github, calls } = gh([
    [has('pr', 'checks', '--json'), { code: 8, stdout: JSON.stringify([{ name: 'test', bucket: 'pending' }]) }],
    [has('pr', 'checks', '--watch'), { code: 143, timedOut: true }],
  ]);
  assert.deepEqual(await github.waitForChecks({ ...pr, timeoutMs: 60000 }), { state: 'timeout', detail: null });
  assert.equal(calls.find((c) => c.argv.includes('--watch')).options.timeoutMs, 60000);
});

const merged = [has('pr', 'view'), { stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'abc123' } }) }];

test('merge uses the given method, pins the head commit, and reads back the merge commit', async () => {
  const { github, calls } = gh([[has('pr', 'merge'), {}], merged]);
  const result = await github.merge({ ...pr, sha: 'deadbeef', method: 'merge', admin: false });
  assert.deepEqual(result, { ok: true, mergeSha: 'abc123', reason: null });
  const argv = calls[0].argv;
  assert.ok(argv.includes('--merge') && !argv.includes('--squash') && !argv.includes('--rebase'));
  assert.equal(argv[argv.indexOf('--match-head-commit') + 1], 'deadbeef');
  assert.equal(argv[argv.indexOf('--repo') + 1], 'octo/app');
  assert.equal(argv.includes('--admin'), false);
  assert.equal(argv.includes('--auto'), false);
});

test('merge adds --admin only when asked', async () => {
  const { github, calls } = gh([[has('pr', 'merge'), {}], merged]);
  await github.merge({ ...pr, sha: 'deadbeef', method: 'squash', admin: true });
  assert.ok(calls[0].argv.includes('--admin') && calls[0].argv.includes('--squash'));
});

test('merge reports why it did not happen, and never claims a merge it cannot confirm', async () => {
  const refused = gh([[has('pr', 'merge'), { code: 1, stderr: 'X Pull request is not mergeable: the base branch policy prohibits the merge.' }]]);
  assert.deepEqual(await refused.github.merge({ ...pr, sha: 'd', method: 'squash', admin: false }),
    { ok: false, mergeSha: null, reason: 'X Pull request is not mergeable: the base branch policy prohibits the merge.' });
  const unconfirmed = gh([[has('pr', 'merge'), {}], [has('pr', 'view'), { stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }) }]]);
  const result = await unconfirmed.github.merge({ ...pr, sha: 'd', method: 'squash', admin: false });
  assert.deepEqual([result.ok, result.mergeSha], [false, null]);
  await assert.rejects(() => unconfirmed.github.merge({ ...pr, sha: 'd', method: 'fast-forward', admin: false }), /method/);
});

test('closePr closes, and deletes the branch only when asked', async () => {
  const { github, calls } = gh([[has('pr', 'close'), {}]]);
  await github.closePr({ ...pr, deleteBranch: true });
  await github.closePr({ ...pr, deleteBranch: false });
  assert.deepEqual(calls.map((c) => c.argv.includes('--delete-branch')), [true, false]);
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--repo') + 1], 'octo/app');
});

const runs = (list) => ({ stdout: JSON.stringify(list) });
test('waitForRunsOn: every run succeeded', async () => {
  const { github, calls } = gh([[has('run', 'list'), runs([{ name: 'Deploy', status: 'completed', conclusion: 'success' }, { name: 'Notify', status: 'completed', conclusion: 'skipped' }])]]);
  assert.deepEqual(await github.waitForRunsOn({ owner: 'octo', repo: 'app', sha: 'abc123', timeoutMs: 60000 }), { state: 'pass', failed: [] });
  const argv = calls[0].argv;
  assert.deepEqual([argv[argv.indexOf('--commit') + 1], argv[argv.indexOf('--repo') + 1]], ['abc123', 'octo/app']);
});

test('waitForRunsOn: a failed run is named', async () => {
  const { github } = gh([[has('run', 'list'), runs([{ name: 'Deploy', status: 'completed', conclusion: 'failure' }, { name: 'Checks', status: 'completed', conclusion: 'success' }])]]);
  assert.deepEqual(await github.waitForRunsOn({ owner: 'octo', repo: 'app', sha: 'abc123', timeoutMs: 60000 }), { state: 'fail', failed: ['Deploy'] });
});

test('waitForRunsOn: no runs at all is "none", after waiting for them to start', async () => {
  sleeps.length = 0;
  const { github } = gh([[has('run', 'list'), runs([])]]);
  assert.deepEqual(await github.waitForRunsOn({ owner: 'octo', repo: 'app', sha: 'abc123', timeoutMs: 30 * 60000 }), { state: 'none', failed: [] });
  assert.ok(sleeps.length >= 3);
});

test('waitForRunsOn: waits for runs in progress, and gives up at the time limit', async () => {
  let asked = 0;
  const finishing = gh([[has('run', 'list'), () => runs([{ name: 'Deploy', status: asked++ < 2 ? 'in_progress' : 'completed', conclusion: asked > 2 ? 'success' : null }])]]);
  assert.equal((await finishing.github.waitForRunsOn({ owner: 'octo', repo: 'app', sha: 'a', timeoutMs: 30 * 60000 })).state, 'pass');
  const stuck = gh([[has('run', 'list'), runs([{ name: 'Deploy', status: 'in_progress', conclusion: null }])]]);
  assert.deepEqual(await stuck.github.waitForRunsOn({ owner: 'octo', repo: 'app', sha: 'a', timeoutMs: 5 * 60000 }), { state: 'timeout', failed: [] });
});

const revertAnswers = (parents) => [
  [has('rev-list', '--parents'), { stdout: `${['abc123', ...parents].join(' ')}\n` }],
  [has('log', '--format=%s'), { stdout: 'Reject empty names (#12)\n' }],
  [has('rev-parse', 'HEAD'), { stdout: 'fff000\n' }],
  [has('pr', 'create'), { stdout: 'https://github.com/octo/app/pull/13\n' }],
  [(argv) => argv[0] === 'git', {}],
];
const revertArgs = { repoDir: '/ws/repo', owner: 'octo', repo: 'app', mergeSha: 'abc123', base: 'trunk', date: '2026-01-05' };

test('revert makes a revert branch from the given base, pushes it and opens a pull request', async () => {
  const { github, calls, argvs } = gh(revertAnswers(['p1']));
  assert.deepEqual(await github.revert(revertArgs), { number: 13, url: 'https://github.com/octo/app/pull/13', sha: 'fff000', branch: 'nightshift/revert-2026-01-05' });
  const all = argvs();
  assert.ok(all.some((a) => a.includes('checkout') && a.includes('-B nightshift/revert-2026-01-05 origin/trunk')));
  const revert = calls.find((c) => c.argv.includes('revert'));
  assert.equal(revert.argv.includes('-m'), false);
  assert.ok(revert.argv.includes('--no-edit') && revert.argv.includes('abc123'));
  assert.ok(calls.filter((c) => c.argv[0] === 'git').every((c) => c.options.cwd === '/ws/repo'));
  const create = calls.find((c) => c.argv.includes('create')).argv;
  assert.equal(create[create.indexOf('--base') + 1], 'trunk');
  assert.equal(create[create.indexOf('--title') + 1], 'Revert "Reject empty names (#12)"');
  assert.ok(all.some((a) => a.includes('push') && a.includes('refs/heads/nightshift/revert-2026-01-05')));
});

test('revert adds -m 1 for a commit with two parents', async () => {
  const { github, calls } = gh(revertAnswers(['p1', 'p2']));
  await github.revert(revertArgs);
  const argv = calls.find((c) => c.argv.includes('revert')).argv;
  assert.equal(argv[argv.indexOf('-m') + 1], '1');
});

test('a revert that does not apply is abandoned cleanly and reported', async () => {
  const answers = revertAnswers(['p1']);
  answers.unshift([has('revert', '--no-edit'), { code: 1, stderr: 'error: could not revert abc123' }]);
  const { github, argvs } = gh(answers);
  await assert.rejects(() => github.revert(revertArgs), /could not be reverted/);
  assert.ok(argvs().some((a) => a.includes('revert --abort')));
  assert.equal(argvs().some((a) => a.includes('push')), false);
});

test('no command the job sends to git or gh carries an attribution line', async () => {
  const { github, calls } = gh([...revertAnswers(['p1']), [has('pr', 'merge'), {}], merged, [has('pr', 'close'), {}], [() => true, {}]]);
  await github.revert(revertArgs);
  await github.pushBranch({ repoDir: '/ws/repo', branch: 'nightshift/a', defaultBranch: 'main' });
  await github.openPr({ owner: 'octo', repo: 'app', branch: 'nightshift/a', base: 'main', title: 'Reject empty names', body: 'Summary.' });
  await github.merge({ ...pr, sha: 'd', method: 'squash', admin: false });
  await github.closePr({ ...pr, deleteBranch: true });
  for (const call of calls) {
    assert.doesNotMatch(call.argv.join('\n'), /co-authored-by|generated with|claude|anthropic|🤖/i);
  }
});
