import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCheck, diffMeasures, measure, parseTestCounts } from '../src/measure.mjs';
import { fakeRun, has } from './helpers.mjs';

// A fake filesystem holding { path: contents } relative to the working copy.
const fakeFs = (files) => ({
  existsSync: (path) => Object.hasOwn(files, path.replace('/repo/', '')),
  readFileSync: (path) => {
    const key = path.replace('/repo/', '');
    if (!Object.hasOwn(files, key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[key];
  },
  readdirSync: (path) => {
    const prefix = path === '/repo' ? '' : `${path.replace('/repo/', '')}/`;
    const names = new Map();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue;
      const [first, ...rest] = file.slice(prefix.length).split('/');
      names.set(first, rest.length > 0);
    }
    return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
  },
});
const pkg = (scripts) => JSON.stringify({ scripts });

test('detectCheck prefers ci/run.sh', () => {
  assert.deepEqual(detectCheck('/repo', fakeFs({ 'ci/run.sh': '', 'package.json': pkg({ ci: 'x', test: 'y' }) })), ['bash', 'ci/run.sh']);
});
test('detectCheck uses the ci script, then the test script', () => {
  assert.deepEqual(detectCheck('/repo', fakeFs({ 'package.json': pkg({ ci: 'x', test: 'y' }) })), ['npm', 'run', 'ci']);
  assert.deepEqual(detectCheck('/repo', fakeFs({ 'package.json': pkg({ test: 'y' }) })), ['npm', 'test']);
});
test('detectCheck ignores the placeholder test script npm writes', () => {
  assert.equal(detectCheck('/repo', fakeFs({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })), null);
});
test('detectCheck uses swift test for a Swift package', () => {
  assert.deepEqual(detectCheck('/repo', fakeFs({ 'Package.swift': '' })), ['swift', 'test']);
});
test('detectCheck returns null when it recognizes nothing, or package.json is broken', () => {
  assert.equal(detectCheck('/repo', fakeFs({})), null);
  assert.equal(detectCheck('/repo', fakeFs({ 'package.json': '{ nope' })), null);
  assert.equal(detectCheck('/repo', fakeFs({ 'package.json': '{}' })), null);
});

test('parseTestCounts reads the summary of several test runners', () => {
  assert.deepEqual(parseTestCounts('# tests 12\n# suites 0\n# pass 11\n# fail 1\n'), { ran: 12, passed: 11 });
  assert.deepEqual(parseTestCounts('ℹ tests 8\nℹ suites 0\nℹ pass 8\nℹ fail 0\n'), { ran: 8, passed: 8 });
  assert.deepEqual(parseTestCounts('Tests:       1 failed, 11 passed, 12 total\n'), { ran: 12, passed: 11 });
  assert.deepEqual(parseTestCounts('Tests:       12 passed, 12 total\n'), { ran: 12, passed: 12 });
  assert.deepEqual(parseTestCounts(' Test Files  2 passed (2)\n      Tests  1 failed | 11 passed (12)\n'), { ran: 12, passed: 11 });
  assert.deepEqual(parseTestCounts('      Tests  7 passed (7)\n'), { ran: 7, passed: 7 });
  assert.deepEqual(parseTestCounts('Executed 12 tests, with 1 failure (0 unexpected) in 0.5 seconds\n'), { ran: 12, passed: 11 });
});
test('parseTestCounts adds up several test runs in one output, and is null when there is none', () => {
  assert.deepEqual(parseTestCounts('# tests 3\n# pass 3\nmore\n# tests 12\n# pass 11\n'), { ran: 15, passed: 14 });
  assert.deepEqual(parseTestCounts('      Tests  200 passed | 8 skipped (208)\nbuild\n      Tests  2 passed (2)\n'), { ran: 210, passed: 202 });
  assert.deepEqual(parseTestCounts('# tests 5\n# pass 5\n      Tests  2 passed (2)\n'), { ran: 7, passed: 7 });
  assert.equal(parseTestCounts('all good, trust me'), null);
  assert.equal(parseTestCounts(''), null);
});

test('parseTestCounts takes the final total from XCTest, which repeats itself', () => {
  const output = 'Executed 5 tests, with 0 failures (0 unexpected) in 0.1 seconds\nExecuted 12 tests, with 1 failure (0 unexpected) in 0.5 seconds\n';
  assert.deepEqual(parseTestCounts(output), { ran: 12, passed: 11 });
});

test('parseTestCounts reads coloured output', () => {
  const coloured = '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m200 passed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[33m8 skipped\u001b[39m\u001b[90m (208)\u001b[39m\n';
  assert.deepEqual(parseTestCounts(coloured), { ran: 208, passed: 200 });
});

test('measure runs npm ci, then the check, then the audit, and reads the counts', async () => {
  const fs = fakeFs({ 'package.json': pkg({ test: 'node --test' }), 'package-lock.json': '{}' });
  const { run, calls } = fakeRun([
    [has('npm', 'ci'), {}],
    [has('npm', 'test'), { stdout: '# tests 12\n# pass 11\n', code: 1 }],
    [has('npm', 'audit'), { code: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 3 } } }) }],
  ]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.deepEqual(m, {
    checkCommand: ['npm', 'test'], checksPass: false, tests: { ran: 12, passed: 11 }, vulnerabilities: 3, failureOutput: '# tests 12\n# pass 11',
  });
  assert.deepEqual(calls.map((c) => c.argv.join(' ')), ['npm ci', 'npm test', 'npm audit --json']);
  assert.ok(calls.every((c) => c.options.cwd === '/repo'));
  assert.equal(calls[1].options.timeoutMs, 1000);
});

test('measure with passing checks and unrecognized output', async () => {
  const fs = fakeFs({ 'ci/run.sh': '' });
  const { run, calls } = fakeRun([[has('bash', 'ci/run.sh'), { stdout: 'ok' }]]);
  assert.deepEqual(await measure({ run, dir: '/repo', fs, timeoutMs: 1000 }),
    { checkCommand: ['bash', 'ci/run.sh'], checksPass: true, tests: null, vulnerabilities: null });
  assert.equal(calls.length, 1);
});

test('a timed-out check gives checksPass false', async () => {
  const fs = fakeFs({ 'ci/run.sh': '' });
  const { run } = fakeRun([[has('bash'), { code: 0, timedOut: true }]]);
  assert.equal((await measure({ run, dir: '/repo', fs, timeoutMs: 1 })).checksPass, false);
});

test('a failed npm ci means the checks do not pass, and the check itself is not run', async () => {
  const fs = fakeFs({ 'package.json': pkg({ test: 'x' }), 'package-lock.json': '{}' });
  const { run, calls } = fakeRun([[has('npm', 'ci'), { code: 1 }], [has('npm', 'audit'), { stdout: 'not json' }]]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.deepEqual([m.checksPass, m.tests, m.vulnerabilities], [false, null, null]);
  assert.equal(calls.some((c) => c.argv.join(' ') === 'npm test'), false);
});

test('with no recognizable check, checksPass is null', async () => {
  const { run, calls } = fakeRun([]);
  assert.deepEqual(await measure({ run, dir: '/repo', fs: fakeFs({}), timeoutMs: 1000 }),
    { checkCommand: null, checksPass: null, tests: null, vulnerabilities: null });
  assert.equal(calls.length, 0);
});

test('diffMeasures lists only what changed, in plain words', () => {
  const before = { checksPass: true, tests: { ran: 41, passed: 41 }, vulnerabilities: 3 };
  const after = { checksPass: true, tests: { ran: 42, passed: 42 }, vulnerabilities: 3 };
  assert.deepEqual(diffMeasures(before, after), [
    { name: 'Tests run', before: 41, after: 42 },
    { name: 'Tests passed', before: 41, after: 42 },
  ]);
  assert.deepEqual(diffMeasures(before, before), []);
  assert.deepEqual(diffMeasures({ ...before, checksPass: false }, { ...before, vulnerabilities: 0 }), [
    { name: 'Checks pass', before: 'no', after: 'yes' },
    { name: 'Known vulnerable dependencies', before: 3, after: 0 },
  ]);
});

test('diffMeasures shows a side that could not be read as "not measured"', () => {
  const before = { checksPass: null, tests: null, vulnerabilities: null };
  const after = { checksPass: true, tests: { ran: 5, passed: 5 }, vulnerabilities: null };
  assert.deepEqual(diffMeasures(before, after), [
    { name: 'Checks pass', before: 'not measured', after: 'yes' },
    { name: 'Tests run', before: 'not measured', after: 5 },
    { name: 'Tests passed', before: 'not measured', after: 5 },
  ]);
});

test('dependencies are installed for every package in the repository, not only the root one', async () => {
  const fs = fakeFs({
    'package.json': pkg({ ci: 'x' }), 'package-lock.json': '{}',
    'apps/web/package.json': '{}', 'apps/web/package-lock.json': '{}',
    'tools/gen/package-lock.json': '{}',
    'node_modules/dep/package-lock.json': '{}', '.cache/x/package-lock.json': '{}', 'a/b/c/d/package-lock.json': '{}',
  });
  const { run, calls } = fakeRun([[() => true, {}]]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.equal(m.checksPass, true);
  assert.deepEqual(calls.map((c) => `${c.argv.join(' ')} @ ${c.options.cwd}`), [
    'npm ci @ /repo', 'npm ci @ /repo/apps/web', 'npm ci @ /repo/tools/gen', 'npm run ci @ /repo', 'npm audit --json @ /repo',
  ]);
});

test('an install that fails in a nested package also stops the check', async () => {
  const fs = fakeFs({ 'package.json': pkg({ test: 'x' }), 'package-lock.json': '{}', 'apps/web/package-lock.json': '{}' });
  const { run, calls } = fakeRun([
    [(argv, options) => argv.join(' ') === 'npm ci' && options.cwd === '/repo/apps/web', { code: 1 }],
    [() => true, {}],
  ]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.equal(m.checksPass, false);
  assert.equal(calls.some((c) => c.argv.join(' ') === 'npm test'), false);
});

test('a repository with its own ci/run.sh is left to install its own dependencies', async () => {
  const fs = fakeFs({ 'ci/run.sh': '', 'package.json': pkg({ test: 'x' }), 'package-lock.json': '{}', 'apps/web/package-lock.json': '{}' });
  const { run, calls } = fakeRun([[() => true, {}]]);
  await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.deepEqual(calls.map((c) => c.argv.join(' ')), ['bash ci/run.sh', 'npm audit --json']);
});

test('a failing check keeps the end of its output, without colour codes', async () => {
  const fs = fakeFs({ 'ci/run.sh': '' });
  const noisy = `${'x'.repeat(9000)}\n\u001b[31mFAIL\u001b[0m tests/a.test.js`;
  const { run } = fakeRun([[has('bash', 'ci/run.sh'), { code: 1, stdout: noisy, stderr: 'boom' }]]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.equal(m.checksPass, false);
  assert.match(m.failureOutput, /FAIL tests\/a\.test\.js\nboom$/);
  assert.equal(m.failureOutput.length <= 4000, true);
});

test('a failed install keeps the end of the install output', async () => {
  const fs = fakeFs({ 'package.json': pkg({ test: 'x' }), 'package-lock.json': '{}' });
  const { run } = fakeRun([[has('npm', 'ci'), { code: 1, stderr: 'npm error missing lockfile entry' }], [has('npm', 'audit'), { stdout: 'not json' }]]);
  const m = await measure({ run, dir: '/repo', fs, timeoutMs: 1000 });
  assert.match(m.failureOutput, /missing lockfile entry$/);
});
