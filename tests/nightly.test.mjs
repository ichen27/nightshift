import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunInProgress, runNight } from '../src/nightly.mjs';
import { createStore } from '../src/store.mjs';

const DATE = '2026-01-05';
const ok = { checkCommand: ['npm', 'test'], checksPass: true, tests: { ran: 41, passed: 41 }, vulnerabilities: 0 };
const finding = { title: 'saveProfile accepts an empty name', detail: 'It stores whatever it is given.', security: false };
const proposal = { title: 'Split the date helpers', detail: 'Two helpers do the same thing.', security: false };
const change = { title: 'Reject empty names when saving a profile', summary: 'saveProfile now returns a validation error.', kind: 'fix', security: false, majorUpgrade: false, claims: ['Fewer bad rows'] };
const project = (repo, over = {}) => ({ owner: 'octo', repo, defaultBranch: 'trunk', isPublic: true, addedAt: '2026-01-01T00:00:00.000Z', lastVisitAt: null, lastResult: null, status: 'healthy', ...over });

// A whole night with every outside thing faked. `over` changes the story.
function world(over = {}) {
  const o = {
    projects: [project('app')],
    settings: {},
    repo: {}, openPrs: [], history: null,
    agent: { ok: true, output: { findings: [finding], change, proposals: [proposal] }, model: 'example-model', failure: null },
    measures: [ok, { ...ok, tests: { ran: 42, passed: 42 } }],
    imported: { sha: 'new111' },
    stats: { files: ['src/profile.js', 'tests/profile.test.js'], addedLines: 12, onlyRemovals: false },
    proof: { proven: true, note: 'The new test fails without the change.' },
    push: { ok: true, reason: null }, checks: { state: 'pass', detail: null }, merge: { ok: true, mergeSha: 'merge123', reason: null },
    live: { liveState: 'running', needsYou: null, detail: 'app restarted and healthy.' },
    ghAuth: { stdout: 'octo\n' }, claudeVersion: {}, token: 'tok', sandboxOk: true, lockPid: null, vaultFails: false,
    ...over,
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'nightshift-night-'));
  const store = createStore(dataDir);
  store.write('projects.json', o.projects);
  if (o.history) store.write('history/octo__app.json', o.history);
  if (o.lockPid) store.write('run.lock', { pid: o.lockPid });
  const calls = [];
  const rec = (name, value) => async (args) => { calls.push([name, args]); return typeof value === 'function' ? value(args) : value; };
  const measures = [...o.measures];
  let clock = new Date(2026, 0, 5, 2, 0).getTime();
  const vault = {};
  const deps = {
    dataDir, gitPath: 'git', ghPath: 'gh', claudePath: 'claude', nodePath: 'node',
    settings: { projectsPerNight: 3, hold: [], adminMerge: [], vaultDir: '/vault', identity: { name: 'Octo Cat', email: 'octo@example.com' }, launcherDir: '/code/launcher', ...o.settings },
    store,
    projects: {
      list: () => store.read('projects.json', []),
      update: (owner, repo, patch) => { const list = store.read('projects.json', []); const p = list.find((x) => x.repo === repo); Object.assign(p, patch); store.write('projects.json', list); return p; },
    },
    github: {
      getRepo: rec('getRepo', ({}) => ({})),
      listNightshiftPrs: async (owner, repo) => { calls.push(['listNightshiftPrs', { owner, repo }]); return typeof o.openPrs === 'function' ? o.openPrs(repo) : o.openPrs; },
      pushBranch: rec('pushBranch', o.push),
      openPr: rec('openPr', { number: 12, url: 'https://github.com/octo/app/pull/12' }),
      waitForChecks: rec('waitForChecks', o.checks),
      merge: rec('merge', o.merge),
      closePr: rec('closePr', undefined),
    },
    run: async (argv) => {
      calls.push(['run', argv]);
      const answer = argv.join(' ') === 'gh api user --jq .login' ? o.ghAuth : argv.includes('--version') ? o.claudeVersion : {};
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer };
    },
    restrictedRun: async (argv, options) => { calls.push(['restrictedRun', { argv, options }]); return { code: 0, stdout: '', stderr: '', timedOut: false }; },
    fs: {
      existsSync: () => !o.vaultFails,
      mkdirSync: () => {},
      writeFileSync: (path, text) => { vault[path] = text; },
    },
    now: () => new Date(clock), pid: 4242, isAlive: (pid) => pid === 1,
    fetch: async () => ({ status: 200 }), sleep: async () => {},
    readRegistry: () => null, claudeToken: o.token, sandboxOk: o.sandboxOk, blockedHosts: () => [], log: () => {},
    steps: {
      prepareWorkspace: rec('prepareWorkspace', (args) => ({ repoDir: '/ws/repo', dir: '/ws/tree', cacheDir: '/ws/cache', branch: args.branch ?? `nightshift/${args.date}`, baseSha: 'base000' })),
      resetTree: rec('resetTree', undefined),
      measure: rec('measure', () => (measures.length > 1 ? measures.shift() : measures[0])),
      runAgent: rec('runAgent', (args) => (typeof o.agent === 'function' ? o.agent(args) : o.agent)),
      importChange: rec('importChange', () => o.imported),
      changeStats: rec('changeStats', o.stats),
      readManifests: rec('readManifests', {}),
      provesItself: rec('provesItself', o.proof),
      goLive: rec('goLive', o.live),
    },
  };
  deps.github.getRepo = async (owner, repo) => {
    calls.push(['getRepo', { owner, repo }]);
    if (typeof o.repo === 'function') return o.repo(repo);
    return { exists: true, owner, repo, archived: false, canPush: true, isPublic: true, defaultBranch: 'trunk', mergeMethods: ['squash', 'merge'], ...o.repo };
  };
  const night = (extra = {}) => runNight({ deps, date: DATE, only: null, dryRun: false, ...extra });
  const did = (name) => calls.filter(([n]) => n === name);
  return { night, calls, did, store, vault, deps, tick: (ms) => { clock += ms; } };
}
const entriesOf = (report, tag) => report.entries.filter((e) => e.tag === tag);

test('a proven change is pushed, merged on green, put live and reported as did', async () => {
  const w = world();
  const report = await w.night();
  assert.equal(report.outcome, 'ok');
  assert.equal(report.model, 'example-model');
  assert.ok(report.finishedAt);
  const [did] = entriesOf(report, 'did');
  assert.deepEqual(did, {
    project: 'octo/app', tag: 'did', title: 'Reject empty names when saving a profile',
    detail: 'saveProfile now returns a validation error. app restarted and healthy.',
    prUrl: 'https://github.com/octo/app/pull/12', security: false, reason: null,
    impact: { measured: [{ name: 'Tests run', before: 41, after: 42 }, { name: 'Tests passed', before: 41, after: 42 }], claims: ['Fewer bad rows'] },
    liveState: 'running',
  });
  assert.deepEqual(entriesOf(report, 'found').map((e) => e.title), ['saveProfile accepts an empty name']);
  assert.deepEqual(entriesOf(report, 'proposed').map((e) => e.title), ['Split the date helpers']);
  const [, importArgs] = w.did('importChange')[0];
  assert.equal(importArgs.message, 'Reject empty names when saving a profile');
  assert.deepEqual(importArgs.identity, { name: 'Octo Cat', email: 'octo@example.com' });
  assert.deepEqual(w.did('pushBranch')[0][1], { repoDir: '/ws/repo', branch: 'nightshift/2026-01-05', defaultBranch: 'trunk' });
  const [, pr] = w.did('openPr')[0];
  assert.deepEqual([pr.base, pr.branch, pr.title], ['trunk', 'nightshift/2026-01-05', 'Reject empty names when saving a profile']);
  assert.equal(pr.body, 'saveProfile now returns a validation error.\n\nMeasured before and after:\n- Tests run: 41 → 42\n- Tests passed: 41 → 42');
  assert.deepEqual(w.did('merge')[0][1], { owner: 'octo', repo: 'app', number: 12, sha: 'new111', method: 'squash', admin: false });
  assert.equal(w.did('goLive')[0][1].mergeSha, 'merge123');
  const saved = w.store.read('projects.json', [])[0];
  assert.deepEqual([saved.status, saved.lastResult, Boolean(saved.lastVisitAt)], ['healthy', '1 change merged and running', true]);
  assert.deepEqual(w.store.read(`reports/${DATE}.json`, null), report);
  assert.match(w.vault['/vault/my-knowledge-base/raw/nightshift/2026-01-05.md'], /Reject empty names/);
  assert.equal(w.store.read('run.lock', null), null);
});

test('the tree is rebuilt from the imported commit before the change is measured', async () => {
  const w = world();
  await w.night();
  const order = w.calls.map(([name]) => name).filter((n) => ['measure', 'runAgent', 'importChange', 'resetTree', 'provesItself'].includes(n));
  assert.deepEqual(order, ['measure', 'runAgent', 'importChange', 'resetTree', 'measure', 'provesItself']);
  assert.equal(w.did('resetTree')[0][1].ref, 'new111');
  assert.equal(w.did('provesItself')[0][1].baselinePass, true);
});

test('a repository that is gone or read-only is reported and nothing else happens', async () => {
  for (const repo of [{ exists: false }, { canPush: false }, { archived: true }]) {
    const w = world({ repo: () => ({ exists: true, archived: false, canPush: true, isPublic: true, defaultBranch: 'trunk', mergeMethods: ['squash'], ...repo }) });
    const report = await w.night();
    assert.deepEqual(report.entries.map((e) => [e.tag, e.title]), [['found', "Can't reach this repository"]]);
    assert.equal(w.did('prepareWorkspace').length, 0);
    assert.equal(w.store.read('projects.json', [])[0].status, 'needs-you');
  }
});

test('a model that fails gives one "Inspection did not finish" entry, nothing is pushed, and the run moves on', async () => {
  const w = world({
    projects: [project('app'), project('site', { addedAt: '2026-01-02T00:00:00.000Z' })],
    agent: ({ cwd }) => (w.did('runAgent').length === 1
      ? { ok: false, output: null, model: null, failure: 'The model ran out of time.' }
      : { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'example-model', failure: null }),
  });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => [e.project, e.tag, e.title, e.detail]), [
    ['octo/app', 'found', 'Inspection did not finish', 'The model ran out of time.'],
    ['octo/site', 'found', 'Nothing worth changing tonight', 'The checks pass and nothing stood out.'],
  ]);
  assert.equal(w.did('pushBranch').length, 0);
  assert.equal(report.outcome, 'ok');
  assert.deepEqual(w.store.read('projects.json', []).map((p) => p.status), ['needs-you', 'healthy']);
});

test('a usage limit stops the night with what finished so far', async () => {
  const w = world({
    projects: [project('app'), project('site', { addedAt: '2026-01-02T00:00:00.000Z' })],
    agent: { ok: false, output: null, model: null, failure: 'Claude usage limit reached' },
  });
  const report = await w.night();
  assert.deepEqual([report.outcome, report.reason], ['stopped', 'Claude usage limit reached']);
  assert.equal(w.did('runAgent').length, 1);
  assert.ok(report.finishedAt);
});

test('findings and proposals already recorded are not reported again, and new ones are remembered', async () => {
  const w = world({ history: { seenTitles: ['SaveProfile accepts an empty name '], prs: [] }, agent: { ok: true, output: { findings: [finding], change: null, proposals: [proposal] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => e.title), ['Split the date helpers']);
  assert.deepEqual(w.store.read('history/octo__app.json', null).seenTitles, ['SaveProfile accepts an empty name ', 'Split the date helpers']);
  assert.deepEqual(w.did('runAgent')[0][1].call.argv[2].includes('- SaveProfile accepts an empty name'), true);
});

test('with nothing found, proposed or changed there is one "Nothing worth changing tonight" entry', async () => {
  const w = world({ agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => [e.tag, e.title]), [['found', 'Nothing worth changing tonight']]);
  assert.equal(w.store.read('projects.json', [])[0].lastResult, 'Nothing worth changing');
});

test('a change the rules reject stays open as a proposal with the reason', async () => {
  const w = world({ proof: { proven: false, note: 'The new test passes without the change.' } });
  const report = await w.night();
  const proposed = entriesOf(report, 'proposed').find((e) => e.prUrl);
  assert.deepEqual([proposed.title, proposed.reason, proposed.prUrl, proposed.liveState], ['Reject empty names when saving a profile', 'No test proves the change', 'https://github.com/octo/app/pull/12', null]);
  assert.equal(w.did('merge').length, 0);
  assert.equal(w.did('waitForChecks').length, 0);
  assert.deepEqual(w.store.read('history/octo__app.json', null).prs, [{ number: 12, sha: 'new111', eligible: false, security: false, title: 'Reject empty names when saving a profile', url: 'https://github.com/octo/app/pull/12' }]);
  assert.equal(w.store.read('projects.json', [])[0].status, 'needs-you');
  assert.deepEqual(report.needsYou, ['octo/app has an open proposal: Reject empty names when saving a profile']);
});

test('checks that fail, never run, or run out of time leave a proposal and never a merge', async () => {
  const cases = [
    [{ state: 'fail', detail: 'test' }, 'Checks failed: test'],
    [{ state: 'none', detail: null }, 'Checks did not run'],
    [{ state: 'timeout', detail: null }, 'Checks did not finish in time'],
  ];
  for (const [checks, reason] of cases) {
    const w = world({ checks });
    const report = await w.night();
    const proposed = entriesOf(report, 'proposed').find((e) => e.prUrl);
    assert.equal(proposed.reason, reason);
    assert.equal(w.did('merge').length, 0);
    assert.equal(w.did('goLive').length, 0);
    assert.equal(w.store.read('history/octo__app.json', null).prs[0].eligible, true, 'it may still be merged on a later visit');
  }
});

test('a merge GitHub refuses is reported as a proposal', async () => {
  const w = world({ merge: { ok: false, mergeSha: null, reason: 'not mergeable' } });
  const report = await w.night();
  assert.equal(entriesOf(report, 'proposed').find((e) => e.prUrl).reason, 'Could not be merged: not mergeable');
  assert.equal(w.did('goLive').length, 0);
});

test('a rejected security change in a public repository is never pushed and stays private', async () => {
  const w = world({ agent: { ok: true, output: { findings: [], change: { ...change, security: true }, proposals: [] }, model: 'm', failure: null }, proof: { proven: false, note: 'x' } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => [e.tag, e.security, e.prUrl, e.reason]), [['proposed', true, null, 'No test proves the change']]);
  assert.equal(w.did('pushBranch').length, 0);
  assert.equal(w.did('openPr').length, 0);
  assert.deepEqual(report.needsYou, ['octo/app has a private security proposal: Reject empty names when saving a profile']);
});

test('a security change in a public repository whose checks do not pass is closed and its branch deleted', async () => {
  const w = world({ agent: { ok: true, output: { findings: [], change: { ...change, security: true }, proposals: [] }, model: 'm', failure: null }, checks: { state: 'fail', detail: 'test' } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => [e.tag, e.security, e.prUrl, e.reason]), [['proposed', true, null, 'Checks failed: test']]);
  assert.deepEqual(w.did('closePr')[0][1], { owner: 'octo', repo: 'app', number: 12, deleteBranch: true });
  assert.deepEqual(w.store.read('history/octo__app.json', null).prs, []);
});

test('the same security change in a private repository is left open like any other proposal', async () => {
  const w = world({ repo: { isPublic: false }, agent: { ok: true, output: { findings: [], change: { ...change, security: true }, proposals: [] }, model: 'm', failure: null }, proof: { proven: false, note: 'x' } });
  const report = await w.night();
  assert.equal(report.entries[0].prUrl, 'https://github.com/octo/app/pull/12');
  assert.equal(w.did('runAgent')[0][1].call.argv[2].includes('must not describe the weakness'), false);
});

test('a change the model described but did not commit is reported and nothing is pushed', async () => {
  const w = world({ imported: null });
  const report = await w.night();
  assert.ok(report.entries.some((e) => e.tag === 'found' && /did not commit/.test(e.detail)));
  assert.equal(w.did('pushBranch').length, 0);
});

test('a rollback is reported as did, rolled back, and needs you', async () => {
  const w = world({ live: { liveState: 'rolled-back', needsYou: 'app is down after rollback.', detail: 'app did not come back healthy.' } });
  const report = await w.night();
  assert.equal(entriesOf(report, 'did')[0].liveState, 'rolled-back');
  assert.deepEqual(report.needsYou, ['octo/app: app is down after rollback.']);
  const saved = w.store.read('projects.json', [])[0];
  assert.deepEqual([saved.status, saved.lastResult], ['needs-you', '1 change rolled back']);
});

test('an earlier pull request that was eligible and is green now is merged first, and no second change is made', async () => {
  const earlier = { number: 9, url: 'https://github.com/octo/app/pull/9', headRefName: 'nightshift/2026-01-02', headRefOid: 'old999' };
  const w = world({ openPrs: [earlier], history: { seenTitles: [], prs: [{ number: 9, sha: 'old999', eligible: true, security: false, title: 'Earlier change', url: earlier.url }] } });
  const report = await w.night();
  assert.deepEqual(w.did('merge')[0][1], { owner: 'octo', repo: 'app', number: 9, sha: 'old999', method: 'squash', admin: false });
  assert.deepEqual(entriesOf(report, 'did').map((e) => [e.title, e.prUrl, e.liveState]), [['Earlier change', earlier.url, 'running']]);
  assert.match(w.did('runAgent')[0][1].call.argv[2], /Do not change any file tonight/);
  assert.equal(w.did('importChange').length, 0);
  assert.deepEqual(w.store.read('history/octo__app.json', null).prs, []);
});

test('an earlier pull request is left alone when it was not eligible, its head moved, or its checks are not green', async () => {
  const earlier = { number: 9, url: 'https://github.com/octo/app/pull/9', headRefName: 'nightshift/2026-01-02', headRefOid: 'old999' };
  const record = { number: 9, sha: 'old999', eligible: true, security: false, title: 'Earlier change', url: earlier.url };
  const stories = [
    { history: { seenTitles: [], prs: [{ ...record, eligible: false }] } },
    { history: { seenTitles: [], prs: [{ ...record, sha: 'someone-pushed' }] } },
    { history: { seenTitles: [], prs: [record] }, checks: { state: 'fail', detail: 'test' } },
    { history: { seenTitles: [], prs: [] } },
  ];
  for (const story of stories) {
    const w = world({ openPrs: [earlier], agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null }, ...story });
    await w.night();
    assert.equal(w.did('merge').length, 0);
    assert.equal(w.store.read('projects.json', [])[0].status, 'needs-you', 'an open pull request still waits for a person');
  }
});

test('with three pull requests already open the model is told not to change anything', async () => {
  const open = [2, 3, 4].map((n) => ({ number: n, url: `https://github.com/octo/app/pull/${n}`, headRefName: `nightshift/2026-01-0${n}`, headRefOid: `sha${n}` }));
  const w = world({ openPrs: open });
  await w.night();
  assert.match(w.did('runAgent')[0][1].call.argv[2], /Do not change any file tonight/);
  assert.equal(w.did('pushBranch').length, 0);
});

test('a second run on one date uses a branch name no open pull request has', async () => {
  const open = [{ number: 2, url: 'u', headRefName: 'nightshift/2026-01-05', headRefOid: 's' }, { number: 3, url: 'u', headRefName: 'nightshift/2026-01-05-2', headRefOid: 's' }];
  const w = world({ openPrs: open });
  await w.night();
  assert.equal(w.did('prepareWorkspace')[0][1].branch, 'nightshift/2026-01-05-3');
});

test('--dry-run inspects and reports but never changes, pushes, or moves the rotation', async () => {
  const w = world();
  const report = await w.night({ dryRun: true });
  assert.match(w.did('runAgent')[0][1].call.argv[2], /Do not change any file tonight/);
  for (const name of ['importChange', 'pushBranch', 'openPr', 'merge', 'goLive']) assert.equal(w.did(name).length, 0, name);
  assert.deepEqual(report.entries.map((e) => e.tag).sort(), ['found', 'proposed']);
  assert.equal(w.store.read('projects.json', [])[0].lastVisitAt, null);
});

test('--only visits that project whatever the rotation says, and an unknown one is a failed run', async () => {
  const w = world({ projects: [project('app'), project('site', { addedAt: '2026-01-02T00:00:00.000Z' })] });
  const report = await w.night({ only: 'OCTO/site' });
  assert.deepEqual([...new Set(report.entries.map((e) => e.project))], ['octo/site']);
  const missing = await world().night({ only: 'octo/nope' });
  assert.deepEqual([missing.outcome, missing.reason], ['failed', 'octo/nope is not on the project list.']);
});

test('only the configured number of projects is visited, longest unvisited first', async () => {
  const projects = ['a', 'b', 'c'].map((repo, i) => project(repo, { addedAt: `2026-01-0${i + 1}T00:00:00.000Z`, lastVisitAt: i === 0 ? '2026-01-04T07:00:00.000Z' : null }));
  const w = world({ projects, settings: { projectsPerNight: 2 }, agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => e.project), ['octo/b', 'octo/c']);
});

test('the report is saved after the first project even when the second throws', async () => {
  const w = world({ projects: [project('app'), project('site', { addedAt: '2026-01-02T00:00:00.000Z' })], agent: { ok: true, output: { findings: [finding], change: null, proposals: [] }, model: 'm', failure: null } });
  const real = w.deps.steps.prepareWorkspace;
  let saw = null;
  w.deps.steps.prepareWorkspace = async (args) => {
    if (args.project.repo === 'site') { saw = w.store.read(`reports/${DATE}.json`, null); throw new Error('Could not prepare a working copy of octo/site: disk full'); }
    return real(args);
  };
  const report = await w.night();
  assert.deepEqual(saw.entries.map((e) => e.project), ['octo/app']);
  assert.equal(saw.finishedAt, null);
  assert.deepEqual(report.entries.map((e) => [e.project, e.title]), [['octo/app', finding.title], ['octo/site', 'Visit did not finish']]);
  assert.match(report.entries[1].detail, /disk full/);
  assert.equal(report.outcome, 'ok');
  assert.equal(w.store.read('run.lock', null), null);
});

test('a lock left by a dead process is cleared, and one held by a live process stops the run', async () => {
  const dead = world({ lockPid: 99999 });
  assert.equal((await dead.night()).outcome, 'ok');
  const live = world({ lockPid: 1 });
  await assert.rejects(() => live.night(), RunInProgress);
  assert.equal(live.store.read(`reports/${DATE}.json`, null), null);
  assert.equal(live.store.read('run.lock', null).pid, 1);
});

test('a failed prerequisite writes a failed report and a vault note, and visits nothing', async () => {
  const cases = [
    [{ ghAuth: { code: 1, stderr: 'not logged in' } }, /GitHub sign-in/],
    [{ ghAuth: { code: 0, stdout: '\n' } }, /GitHub sign-in/],
    [{ token: null }, /Claude token/],
    [{ claudeVersion: { code: 127 } }, /Claude Code/],
    [{ sandboxOk: false }, /sandbox/],
    [{ settings: { identity: null } }, /identity/],
  ];
  for (const [over, reason] of cases) {
    const w = world(over);
    const report = await w.night();
    assert.equal(report.outcome, 'failed');
    assert.match(report.reason, reason);
    assert.ok(report.finishedAt);
    assert.equal(w.did('getRepo').length, 0);
    assert.match(w.vault['/vault/my-knowledge-base/raw/nightshift/2026-01-05.md'], /The run failed/);
    assert.equal(w.store.read(`reports/${DATE}.json`, null).outcome, 'failed');
    assert.equal(w.store.read('run.lock', null), null);
  }
});

test('a second run on the same date adds to that date\'s report', async () => {
  const w = world({ agent: { ok: true, output: { findings: [finding], change: null, proposals: [] }, model: 'm', failure: null } });
  await w.night({ dryRun: true });
  w.deps.steps.runAgent = async () => ({ ok: true, output: { findings: [{ ...finding, title: 'A second finding' }], change: null, proposals: [] }, model: 'm', failure: null });
  const report = await w.night({ dryRun: true });
  assert.deepEqual(report.entries.map((e) => e.title), [finding.title, 'A second finding']);
});

test('a project that runs out of its 45 minutes keeps what was learned and pushes nothing', async () => {
  const w = world();
  w.deps.steps.runAgent = async () => { w.tick(46 * 60 * 1000); return { ok: true, output: { findings: [finding], change, proposals: [] }, model: 'm', failure: null }; };
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => e.title), [finding.title, 'Ran out of time']);
  assert.equal(w.did('importChange').length, 0);
  assert.equal(w.did('pushBranch').length, 0);
});

test('a title that names an AI tool is replaced before it reaches a commit or pull request', async () => {
  const w = world({ agent: { ok: true, output: { findings: [], change: { ...change, title: 'Fix validation (generated with Claude)', summary: 'Co-Authored-By: Claude fixed it.' }, proposals: [] }, model: 'm', failure: null } });
  await w.night();
  assert.equal(w.did('importChange')[0][1].message, 'Maintenance update');
  const [, pr] = w.did('openPr')[0];
  assert.doesNotMatch(`${pr.title}\n${pr.body}`, /claude|co-authored/i);
});

test('failing checks before any change are reported and need you', async () => {
  const w = world({ measures: [{ ...ok, checksPass: false }], agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(report.entries.map((e) => e.title), ["The repository's checks are failing"]);
  assert.deepEqual(report.needsYou, ['octo/app: the checks are failing on trunk, so nothing can be merged.']);
});

test('admin merge is used only for projects on the admin list', async () => {
  const w = world({ settings: { adminMerge: ['Octo/App'] } });
  await w.night();
  assert.equal(w.did('merge')[0][1].admin, true);
});

test('a security change in a public repository is closed, not left open, when the merge is refused or a later step throws', async () => {
  const secure = { ok: true, output: { findings: [], change: { ...change, security: true }, proposals: [] }, model: 'm', failure: null };
  const refused = world({ agent: secure, merge: { ok: false, mergeSha: null, reason: 'not mergeable' } });
  const report = await refused.night();
  assert.deepEqual(report.entries.map((e) => [e.tag, e.security, e.prUrl, e.reason]), [['proposed', true, null, 'Could not be merged: not mergeable']]);
  assert.deepEqual(refused.did('closePr')[0][1], { owner: 'octo', repo: 'app', number: 12, deleteBranch: true });
  assert.deepEqual(refused.store.read('history/octo__app.json', null).prs, []);
  assert.deepEqual(report.needsYou, ['octo/app has a private security proposal: Reject empty names when saving a profile']);

  const thrown = world({ agent: secure });
  thrown.deps.github.waitForChecks = async () => { throw new Error('gh crashed'); };
  const second = await thrown.night();
  assert.equal(thrown.did('closePr').length, 1, 'the pull request is closed before the error is reported');
  assert.deepEqual(second.entries.map((e) => e.title), ['Visit did not finish']);
});

test('an ordinary change is left open when a later step throws', async () => {
  const w = world();
  w.deps.github.waitForChecks = async () => { throw new Error('gh crashed'); };
  await w.night();
  assert.equal(w.did('closePr').length, 0);
});

test('a pull request this job has no record of is reported as such and still counts toward the limit', async () => {
  const stranger = { number: 30, url: 'https://github.com/octo/app/pull/30', headRefName: 'nightshift/hand-made', headRefOid: 'x' };
  const w = world({ openPrs: [stranger], agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(report.needsYou, ['octo/app has an open pull request on a nightshift branch that this job did not record: https://github.com/octo/app/pull/30']);
});

test('a project\'s tool folders are put on the PATH of everything run for it', async () => {
  const w = world({ settings: { toolPaths: { 'Octo/App': ['/opt/node22/bin'] } } });
  w.deps.steps.measure = async ({ run }) => { await run(['npm', 'test'], { cwd: '/ws/tree', timeoutMs: 5 }); return ok; };
  w.deps.steps.runAgent = async ({ restrictedRun, call, cwd, cacheDir }) => {
    await restrictedRun(call.argv, { cwd, cacheDir, writable: [cwd], env: call.env });
    return { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null };
  };
  await w.night();
  const runs = w.did('restrictedRun').map(([, r]) => r);
  assert.ok(runs.length >= 2);
  assert.ok(runs.every((r) => JSON.stringify(r.options.pathPrefix) === '["/opt/node22/bin"]'), 'checks and the model both get the project\'s tools');
  const plain = world();
  plain.deps.steps.measure = async ({ run }) => { await run(['npm', 'test'], { cwd: '/ws/tree' }); return ok; };
  await plain.night();
  assert.deepEqual(plain.did('restrictedRun')[0][1].options.pathPrefix, []);
});

test('the end of a failing check\'s output is kept in the data folder, and the report says where', async () => {
  const failing = { ...ok, checksPass: false, failureOutput: 'FAIL tests/a.test.js' };
  const w = world({ measures: [failing], agent: { ok: true, output: { findings: [], change: null, proposals: [] }, model: 'm', failure: null } });
  const report = await w.night();
  assert.deepEqual(w.store.read('logs/2026-01-05/octo__app-before.json', null), { checkCommand: ['npm', 'test'], output: 'FAIL tests/a.test.js' });
  assert.match(report.entries[0].detail, /logs\/2026-01-05\/octo__app-before\.json/);
});

test('checks that fail with the change also keep the end of their output', async () => {
  const w = world({ measures: [ok, { ...ok, checksPass: false, failureOutput: 'FAIL tests/b.test.js' }] });
  await w.night();
  assert.equal(w.store.read('logs/2026-01-05/octo__app-after.json', null).output, 'FAIL tests/b.test.js');
});
