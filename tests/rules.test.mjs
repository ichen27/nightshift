import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';
import { changeStats, decide, isMajorUpgrade, isTestFile, provesItself, sensitiveReason } from '../src/rules.mjs';

test('isTestFile recognizes test folders and test file names', () => {
  for (const path of ['tests/a.mjs', 'src/test/a.js', 'pkg/__tests__/a.js', 'AppTests/LoginTests.swift', 'src/a.test.ts',
    'src/a.spec.js', 'pkg/thing_test.go', 'Sources/FooTests.swift', 'test/a.py']) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ['src/a.js', 'src/contest/a.js', 'src/latest.js', 'README.md', 'src/testing-helpers.js']) {
    assert.equal(isTestFile(path), false, path);
  }
});

const reasons = {
  'Changes CI workflows': ['.github/workflows/checks.yml', '.github/dependabot.yml', 'ci/run.sh'],
  'Changes deploy configuration': ['Dockerfile', 'api/Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yaml', 'wrangler.toml',
    'worker/wrangler.jsonc', 'launcher.json', 'fly.toml', 'vercel.json', 'netlify.toml'],
  'Changes environment files': ['.env', '.env.example', 'api/.env.production'],
  'Changes database migrations': ['db/migrations/001.sql', 'src/migrate/run.js', 'migrations/a.py'],
  'Touches sign-in or payment code': ['src/auth/index.js', 'src/Login.tsx', 'lib/session.js', 'src/reset-password.js',
    'src/tokens.js', 'src/payment/charge.js', 'src/Billing.swift', 'src/stripe.js', 'jobs/payouts.js'],
};
for (const [reason, paths] of Object.entries(reasons)) {
  test(`sensitive: ${reason}`, () => {
    for (const path of paths) assert.equal(sensitiveReason(['src/ok.js', path]), reason, path);
  });
}
test('ordinary files are not sensitive', () => {
  assert.equal(sensitiveReason(['src/profile.js', 'tests/profile.test.js', 'README.md', 'package.json', 'docs/environment.md']), null);
  assert.equal(sensitiveReason([]), null);
});

const pkg = (dependencies, devDependencies = {}) => ({ dependencies, devDependencies });
test('a higher major version of a dependency is a major upgrade', () => {
  assert.equal(isMajorUpgrade(pkg({ a: '^1.4.0' }), pkg({ a: '^2.0.0' })), true);
  assert.equal(isMajorUpgrade(pkg({ a: '^1.4.0' }), pkg({ a: '^1.9.0' })), false);
  assert.equal(isMajorUpgrade(pkg({}, { a: '~3.1.0' }), pkg({}, { a: '4.0.1' })), true);
  assert.equal(isMajorUpgrade(pkg({ a: '>=1.2 <2' }), pkg({ a: '>=1.5 <2' })), false);
});
test('before 1.0 a minor bump counts as major; other cases do not', () => {
  assert.equal(isMajorUpgrade(pkg({ a: '^0.4.2' }), pkg({ a: '^0.5.0' })), true);
  assert.equal(isMajorUpgrade(pkg({ a: '^0.4.2' }), pkg({ a: '^0.4.9' })), false);
  assert.equal(isMajorUpgrade(pkg({ a: '^2.0.0' }), pkg({ a: '^1.0.0' })), false);
  assert.equal(isMajorUpgrade(pkg({ a: '^1.0.0' }), pkg({ a: '^1.0.0', b: '^9.0.0' })), false);
  assert.equal(isMajorUpgrade(pkg({ a: 'latest' }), pkg({ a: 'github:octo/a' })), false);
  assert.equal(isMajorUpgrade(null, pkg({ a: '^1.0.0' })), false);
  assert.equal(isMajorUpgrade(pkg({ a: '^1.0.0' }), null), false);
});

const good = {
  change: { kind: 'fix', majorUpgrade: false },
  files: ['src/profile.js', 'tests/profile.test.js'],
  addedLines: 12,
  before: { checksPass: true, tests: { ran: 41, passed: 41 } },
  after: { checksPass: true, tests: { ran: 42, passed: 42 } },
  proof: { proven: true, note: 'The new test fails without the change.' },
  pkgBefore: { scripts: { test: 'node --test' }, dependencies: { a: '^1.0.0' } },
  pkgAfter: { scripts: { test: 'node --test' }, dependencies: { a: '^1.0.0' } },
};
const verdict = (over) => decide({ ...good, ...over });

test('a proven fix with passing checks is merged', () => {
  assert.deepEqual(verdict({}), { merge: true, reason: null });
});
test('no changed files means no change was made', () => {
  assert.deepEqual(verdict({ files: [] }), { merge: false, reason: 'No change was made' });
});
test('checks that fail, or could not be run, block the merge', () => {
  const reason = "The repository's checks do not pass with the change";
  assert.deepEqual(verdict({ after: { checksPass: false, tests: null } }), { merge: false, reason });
  assert.deepEqual(verdict({ after: { checksPass: null, tests: null } }), { merge: false, reason });
});
test('a change after which fewer tests run is proposed', () => {
  assert.deepEqual(verdict({ after: { checksPass: true, tests: { ran: 30, passed: 30 } } }), { merge: false, reason: 'Fewer tests ran than before' });
  assert.equal(verdict({ before: { checksPass: true, tests: null } }).merge, true);
});
test('a sensitive file blocks the merge with its reason', () => {
  assert.deepEqual(verdict({ files: ['src/login.js', 'tests/login.test.js'] }), { merge: false, reason: 'Touches sign-in or payment code' });
});
test('a change to package.json scripts is proposed', () => {
  assert.deepEqual(verdict({ pkgAfter: { ...good.pkgAfter, scripts: { test: 'true' } } }), { merge: false, reason: 'Changes how the checks run' });
});
test('a major upgrade is proposed, whether the model says so or the versions do', () => {
  assert.deepEqual(verdict({ change: { kind: 'dependency-patch', majorUpgrade: true } }), { merge: false, reason: 'Major version upgrade' });
  assert.deepEqual(verdict({ pkgAfter: { ...good.pkgAfter, dependencies: { a: '^2.0.0' } } }), { merge: false, reason: 'Major version upgrade' });
});
test('a fix without proof is proposed', () => {
  assert.deepEqual(verdict({ proof: { proven: false, note: 'The new test passes without the change.' } }), { merge: false, reason: 'No test proves the change' });
});
test('a dependency patch without a test merges when checks pass', () => {
  const patch = { change: { kind: 'dependency-patch', majorUpgrade: false }, files: ['package.json', 'package-lock.json'],
    proof: { proven: false, note: 'The change has no test.' }, pkgAfter: { ...good.pkgAfter, dependencies: { a: '^1.0.4' } } };
  assert.deepEqual(verdict(patch), { merge: true, reason: null });
});
test('documentation and pure deletions merge without a test', () => {
  const unproven = { proven: false, note: 'The change has no test.' };
  assert.equal(verdict({ change: { kind: 'docs', majorUpgrade: false }, files: ['README.md', 'docs/setup.md'], proof: unproven }).merge, true);
  assert.equal(verdict({ change: { kind: 'dead-code', majorUpgrade: false }, files: ['src/old.js', 'src/index.js'], addedLines: 0, proof: unproven }).merge, true);
});
test('a label that does not match what changed does not skip the test rule', () => {
  const unproven = { proven: false, note: 'The change has no test.' };
  const reason = 'No test proves the change';
  assert.deepEqual(verdict({ change: { kind: 'docs', majorUpgrade: false }, files: ['README.md', 'src/profile.js'], proof: unproven }), { merge: false, reason });
  assert.deepEqual(verdict({ change: { kind: 'dependency-patch', majorUpgrade: false }, files: ['package.json', 'src/profile.js'], proof: unproven }), { merge: false, reason });
  assert.deepEqual(verdict({ change: { kind: 'dead-code', majorUpgrade: false }, files: ['src/index.js'], addedLines: 3, proof: unproven }), { merge: false, reason });
});

// provesItself and changeStats against a real repository in a temporary folder.
async function git(cwd, ...args) {
  const result = await run(['git', '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
async function repoWith({ testPassesOnBase }) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-rules-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  await git(root, 'init', '-q', '-b', 'trunk', repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test tests/*.test.mjs' } }));
  writeFileSync(join(repo, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'tests', 'old.test.mjs'), "import test from 'node:test';\ntest('old', () => {});\n");
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'value.mjs'), 'export const value = 2;\n');
  const expected = testPassesOnBase ? 'true' : 'value === 2';
  writeFileSync(join(repo, 'tests', 'value.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert';\nimport { value } from '../value.mjs';\ntest('value', () => assert.ok(${expected}));\n`);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'change');
  return { root, repo, baseSha, sha: await git(repo, 'rev-parse', 'HEAD') };
}
// A test run started from inside another test run reports to its parent instead of failing,
// so the nested runs get an environment without the outer runner's marker.
const { NODE_TEST_CONTEXT: _outer, ...cleanEnv } = process.env;
const checkRun = (argv, options) => run(argv, { ...options, env: cleanEnv });
const prove = (r, files) => provesItself({
  run, checkRunFor: () => checkRun, gitPath: 'git', repoDir: r.repo, proofDir: join(r.root, 'proof'),
  baseSha: r.baseSha, sha: r.sha, files, fs: realFs, timeoutMs: 60000,
});

test('changeStats lists the changed files and counts added lines', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  assert.deepEqual(await changeStats({ run, gitPath: 'git', repoDir: r.repo, baseSha: r.baseSha, sha: r.sha }),
    { files: ['tests/value.test.mjs', 'value.mjs'], addedLines: 5 });
  assert.deepEqual(await changeStats({ run, gitPath: 'git', repoDir: r.repo, baseSha: r.baseSha, sha: r.baseSha }), { files: [], addedLines: 0 });
});

test('a new test that fails on the old code proves the change', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  assert.deepEqual(await prove(r, ['tests/value.test.mjs', 'value.mjs']), { proven: true, note: 'The new test fails without the change.' });
  assert.equal(existsSync(join(r.root, 'proof')), false, 'the proof folder is removed afterwards');
  assert.equal(await git(r.repo, 'rev-parse', 'HEAD'), r.sha, 'the job\'s clone is left where it was');
});

test('a new test that passes on the old code proves nothing', async () => {
  const r = await repoWith({ testPassesOnBase: true });
  assert.deepEqual(await prove(r, ['tests/value.test.mjs', 'value.mjs']), { proven: false, note: 'The new test passes without the change.' });
});

test('with no test files, or no checks to run, nothing is proven and the note says which', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  assert.deepEqual(await prove(r, ['value.mjs']), { proven: false, note: 'The change has no test.' });
  const noChecks = { ...realFs, existsSync: (path) => (path.endsWith('package.json') || path.endsWith('run.sh') || path.endsWith('Package.swift') ? false : realFs.existsSync(path)),
    readFileSync: (path, enc) => { if (String(path).endsWith('package.json')) throw new Error('ENOENT'); return realFs.readFileSync(path, enc); } };
  const result = await provesItself({ run, checkRunFor: () => checkRun, gitPath: 'git', repoDir: r.repo, proofDir: join(r.root, 'proof2'),
    baseSha: r.baseSha, sha: r.sha, files: ['tests/value.test.mjs'], fs: noChecks, timeoutMs: 60000 });
  assert.deepEqual(result, { proven: false, note: 'The repository has no checks to run the test with.' });
});
