import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLauncherApp, goLive } from '../src/golive.mjs';
import { fakeRun, has } from './helpers.mjs';

const project = { owner: 'octo', repo: 'app', defaultBranch: 'trunk' };
const app = { id: 'app', cwd: '/code/app', port: 8801, healthPath: '/health', build: [['/bin/npm', 'run', 'build']] };
const registry = { version: 1, apps: [{ id: 'other', cwd: '/code/other', port: 8800 }, app] };
const settings = { hold: [], launcherDir: '/code/launcher' };

// Everything goLive touches, faked. `over` adjusts the story.
function world(over = {}) {
  const o = {
    runsOnMerge: { state: 'pass', failed: [] }, runsOnRevert: { state: 'pass', failed: [] },
    status: '', branch: 'trunk', pull: {}, lockChanged: false, build: {}, npmCi: {}, restart: {},
    health: [200], revertChecks: { state: 'pass', detail: null }, revertMerge: { ok: true, mergeSha: 'rev999', reason: null },
    revertThrows: false, registry, ...over,
  };
  const health = [...o.health];
  const fetched = [];
  const githubCalls = [];
  const record = (name, value) => async (args) => { githubCalls.push([name, args]); return typeof value === 'function' ? value(args) : value; };
  let clock = 0;
  const { run, calls } = fakeRun([
    [has('remote', 'get-url'), (_argv, options) => ({ stdout: options.cwd === '/code/app' ? 'https://github.com/Octo/App.git\n' : 'git@github.com:octo/other.git\n' })],
    [has('status', '--porcelain'), { stdout: o.status }],
    [has('rev-parse', '--abbrev-ref'), { stdout: `${o.branch}\n` }],
    [has('rev-parse', 'HEAD'), () => ({ stdout: calls.some((c) => c.argv.includes('pull')) && !calls.some((c) => c.argv.includes('reset')) ? 'new222\n' : 'old111\n' })],
    [has('pull'), o.pull],
    [has('diff', '--name-only'), { stdout: o.lockChanged ? 'package-lock.json\n' : '' }],
    [has('reset', '--hard'), {}],
    [(argv) => argv.join(' ') === 'npm ci', o.npmCi],
    [(argv) => argv[0] === '/bin/npm', o.build],
    [has('restart'), o.restart],
  ]);
  const deps = {
    run, gitPath: 'git', nodePath: '/bin/node',
    readRegistry: () => o.registry,
    fetch: async (url) => { fetched.push(url); const next = health.length > 1 ? health.shift() : health[0]; if (next === 'down') throw new Error('ECONNREFUSED'); return { status: next }; },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    github: {
      waitForRunsOn: record('waitForRunsOn', ({ sha }) => (sha === 'merge123' ? o.runsOnMerge : o.runsOnRevert)),
      revert: record('revert', () => { if (o.revertThrows) throw new Error('The change could not be reverted cleanly: conflict'); return { number: 13, url: 'https://github.com/octo/app/pull/13', sha: 'rev111', branch: 'nightshift/revert-2026-01-05' }; }),
      waitForChecks: record('waitForChecks', o.revertChecks),
      merge: record('merge', o.revertMerge),
    },
  };
  const go = (extra = {}) => goLive({ project, mergeSha: 'merge123', settings: { ...settings, ...(over.settings ?? {}) }, deps, repoDir: '/ws/repo', date: '2026-01-05', mergeMethod: 'squash', admin: false, ...extra });
  const ran = () => calls.map((c) => c.argv.join(' '));
  return { go, calls, ran, fetched, githubCalls, did: (name) => githubCalls.filter(([n]) => n === name).length };
}

test('findLauncherApp finds the app whose checkout comes from this repository', async () => {
  const w = world();
  const found = await findLauncherApp({ registry, run: (argv, options) => w.calls && fakeRun([[has('remote'), { stdout: options.cwd === '/code/app' ? 'https://github.com/Octo/App.git\n' : 'https://github.com/octo/other\n' }]]).run(argv, options), gitPath: 'git', project });
  assert.deepEqual(found, { id: 'app', cwd: '/code/app', port: 8801, healthPath: '/health', build: [['/bin/npm', 'run', 'build']] });
});

test('findLauncherApp returns null when no app comes from this repository, or there is no registry', async () => {
  const { run } = fakeRun([[has('remote'), { stdout: 'https://github.com/someone/else.git\n' }]]);
  assert.equal(await findLauncherApp({ registry, run, gitPath: 'git', project }), null);
  assert.equal(await findLauncherApp({ registry: null, run, gitPath: 'git', project }), null);
  const broken = fakeRun([[has('remote'), { code: 128, stderr: 'not a git repository' }]]);
  assert.equal(await findLauncherApp({ registry, run: broken.run, gitPath: 'git', project }), null);
});

test('a healthy launcher app ends up running on the merged commit', async () => {
  const w = world();
  const result = await w.go();
  assert.deepEqual(result, { liveState: 'running', needsYou: null, detail: 'app restarted and healthy.' });
  const ran = w.ran();
  assert.ok(ran.some((c) => /pull .*--ff-only origin trunk$/.test(c)));
  assert.ok(ran.includes('/bin/npm run build'));
  assert.ok(ran.includes('/bin/node /code/launcher/src/cli.mjs restart app'));
  assert.equal(ran.includes('npm ci'), false, 'dependencies are reinstalled only when the lockfile changed');
  assert.deepEqual(w.fetched, ['http://127.0.0.1:8801/health']);
  assert.equal(w.did('revert'), 0);
  assert.ok(w.calls.filter((c) => c.argv[0] === 'git' && !c.argv.includes('remote')).every((c) => c.options.cwd === '/code/app'));
});

test('dependencies are reinstalled when the lockfile changed', async () => {
  const w = world({ lockChanged: true });
  await w.go();
  const ran = w.ran();
  assert.ok(ran.indexOf('npm ci') > -1 && ran.indexOf('npm ci') < ran.indexOf('/bin/npm run build'));
});

test('an app that takes a while to come up is waited for', async () => {
  const w = world({ health: ['down', 503, 'down', 302] });
  assert.equal((await w.go()).liveState, 'running');
  assert.equal(w.fetched.length, 4);
});

test('failed runs after the merge lead to a merged revert and "rolled-back"', async () => {
  const w = world({ runsOnMerge: { state: 'fail', failed: ['Deploy'] } });
  const result = await w.go();
  assert.deepEqual([result.liveState, result.needsYou], ['rolled-back', null]);
  assert.match(result.detail, /Deploy/);
  const [, revertArgs] = w.githubCalls.find(([n]) => n === 'revert');
  assert.deepEqual(revertArgs, { repoDir: '/ws/repo', owner: 'octo', repo: 'app', mergeSha: 'merge123', base: 'trunk', date: '2026-01-05' });
  const [, mergeArgs] = w.githubCalls.find(([n]) => n === 'merge');
  assert.deepEqual(mergeArgs, { owner: 'octo', repo: 'app', number: 13, sha: 'rev111', method: 'squash', admin: false });
  assert.equal(w.ran().some((c) => c.includes('pull')), false, 'a change being reverted is not pulled into the live checkout');
});

test('a revert whose checks do not pass is left open and needs you', async () => {
  for (const revertChecks of [{ state: 'fail', detail: 'test' }, { state: 'none', detail: null }, { state: 'timeout', detail: null }]) {
    const w = world({ runsOnMerge: { state: 'fail', failed: ['Deploy'] }, revertChecks });
    const result = await w.go();
    assert.equal(result.liveState, 'rolled-back');
    assert.equal(result.needsYou, 'trunk still contains the change; the revert PR did not pass: https://github.com/octo/app/pull/13');
    assert.equal(w.did('merge'), 0);
  }
});

test('a revert that cannot be made or merged needs you', async () => {
  const thrown = await world({ runsOnMerge: { state: 'fail', failed: ['Deploy'] }, revertThrows: true }).go();
  assert.match(thrown.needsYou, /^trunk still contains the change; it could not be reverted automatically/);
  const refused = await world({ runsOnMerge: { state: 'fail', failed: ['Deploy'] }, revertMerge: { ok: false, mergeSha: null, reason: 'not mergeable' } }).go();
  assert.match(refused.needsYou, /trunk still contains the change; the revert PR could not be merged/);
});

test('a failed deploy after the revert asks for the rollback workflow', async () => {
  const w = world({ runsOnMerge: { state: 'fail', failed: ['Deploy'] }, runsOnRevert: { state: 'fail', failed: ['Deploy'] } });
  const result = await w.go();
  assert.equal(result.liveState, 'rolled-back');
  assert.equal(result.needsYou, "The deploy after the revert failed; run the repository's rollback workflow.");
});

test('a held project is merged but not put live, and the launcher is never called', async () => {
  const w = world({ settings: { hold: ['Octo/App'] } });
  const result = await w.go();
  assert.deepEqual(result, { liveState: 'merged-not-running', needsYou: null, detail: 'Pull the checkout and restart the service to go live.' });
  assert.equal(w.calls.length, 0);
  assert.equal(w.fetched.length, 0);
});

test('a project with no launcher app has nothing to put live', async () => {
  const none = await world({ registry: { version: 1, apps: [] } }).go();
  assert.deepEqual(none, { liveState: 'not-applicable', needsYou: null, detail: 'The runs the merge triggered passed.' });
  const quiet = await world({ registry: null, runsOnMerge: { state: 'none', failed: [] } }).go();
  assert.deepEqual(quiet, { liveState: 'not-applicable', needsYou: null, detail: 'Nothing to deploy.' });
});

test('a dirty checkout is not touched: no pull, no restart', async () => {
  const w = world({ status: ' M src/server.js\n' });
  const result = await w.go();
  assert.deepEqual([result.liveState, result.needsYou], ['merged-not-running', 'The checkout has local work; not touched.']);
  const ran = w.ran();
  assert.equal(ran.some((c) => c.includes('pull') || c.includes('restart') || c.includes('reset')), false);
});

test('a checkout on another branch is not touched, and a default branch named trunk is compared correctly', async () => {
  const other = await world({ branch: 'main' }).go();
  assert.deepEqual([other.liveState, other.needsYou], ['merged-not-running', 'The checkout has local work; not touched.']);
  assert.equal((await world({ branch: 'trunk' }).go()).liveState, 'running');
});

test('a pull that fails leaves the app as it was and says why', async () => {
  const w = world({ pull: { code: 1, stderr: 'fatal: Not possible to fast-forward, aborting.' } });
  const result = await w.go();
  assert.equal(result.liveState, 'merged-not-running');
  assert.match(result.needsYou, /could not be updated: fatal: Not possible to fast-forward/);
  assert.equal(w.ran().some((c) => c.includes('restart')), false);
});

test('an app that does not come back healthy is put back on the previous commit and the change reverted', async () => {
  // Unhealthy for the whole first minute, healthy once the old commit is back.
  const health = [...Array(40).fill('down'), 200];
  const w = world({ health });
  const result = await w.go();
  assert.deepEqual([result.liveState, result.needsYou], ['rolled-back', null]);
  const ran = w.ran();
  const reset = ran.findIndex((c) => /reset .*--hard old111$/.test(c));
  assert.ok(reset > -1, 'the checkout is reset to the commit recorded before the pull');
  assert.equal(ran.filter((c) => c.includes('restart app')).length, 2);
  assert.ok(ran.lastIndexOf('/bin/npm run build') > reset, 'the old commit is rebuilt');
  assert.equal(w.did('revert'), 1);
  assert.equal(w.did('merge'), 1);
});

test('a build that fails on the new commit also rolls back', async () => {
  const w = world({ build: { code: 1, stderr: 'build broke' } });
  const result = await w.go();
  assert.equal(result.liveState, 'rolled-back');
  assert.ok(w.ran().some((c) => /reset .*--hard old111$/.test(c)));
});

test('an app still down after the rollback is called out', async () => {
  const w = world({ health: ['down'] });
  const result = await w.go();
  assert.equal(result.liveState, 'rolled-back');
  assert.match(result.needsYou, /^app is down after rollback/);
  assert.equal(w.did('revert'), 1);
});

test('runs that do not finish in time are noted, and the app still goes live', async () => {
  const w = world({ runsOnMerge: { state: 'timeout', failed: [] } });
  const result = await w.go();
  assert.equal(result.liveState, 'running');
  assert.equal(result.needsYou, 'The runs the merge triggered did not finish in 30 minutes.');
});
