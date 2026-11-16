// These tests use real git against a bare repository in a temporary folder. No network.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';
import { createRestrictedRun } from '../src/sandbox.mjs';
import { importChange, prepareWorkspace, resetTree } from '../src/workspace.mjs';

const identity = { name: 'Octo Cat', email: 'octo@example.com' };
const project = { owner: 'octo', repo: 'app', defaultBranch: 'trunk' };

async function git(cwd, ...args) {
  const result = await run(['git', '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A bare "origin" whose default branch is trunk, with one commit.
async function origin() {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-ws-'));
  const bare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  await git(root, 'init', '-q', '--bare', '-b', 'trunk', bare);
  await git(root, 'clone', '-q', bare, seed);
  await git(seed, 'checkout', '-q', '-b', 'trunk');
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-q', '-m', 'first');
  await git(seed, 'push', '-q', 'origin', 'trunk');
  return { root, bare, seed, dataDir: join(root, 'data') };
}

const prepare = (o, date = '2026-01-05', extra = {}) =>
  prepareWorkspace({ run, gitPath: 'git', dataDir: o.dataDir, project, date, identity, cloneUrl: o.bare, ...extra });

// In these tests the "restricted" runner is plain run: there is no sandbox on the CI runner.
const restrictedRun = (argv, { cwd, timeoutMs } = {}) => run(argv, { cwd, timeoutMs });
const importIt = (ws, message = 'Reject empty names', runner = run) =>
  importChange({ run: runner, restrictedRun, gitPath: 'git', repoDir: ws.repoDir, dir: ws.dir, cacheDir: ws.cacheDir, baseSha: ws.baseSha, message, identity });

test('the first visit makes a trusted clone and a separate tree for the model, both on a nightshift/<date> branch', async () => {
  const o = await origin();
  const ws = await prepare(o);
  const home = join(o.dataDir, 'workspaces', 'octo__app');
  assert.deepEqual([ws.repoDir, ws.dir, ws.cacheDir], [join(home, 'repo'), join(home, 'tree'), join(home, 'cache')]);
  assert.equal(ws.branch, 'nightshift/2026-01-05');
  assert.equal(ws.baseSha, await git(o.seed, 'rev-parse', 'trunk'));
  for (const dir of [ws.repoDir, ws.dir]) {
    assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightshift/2026-01-05');
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), ws.baseSha);
  }
  assert.equal(await git(ws.dir, 'config', '--local', 'user.name'), 'Octo Cat');
  assert.equal(await git(ws.dir, 'config', '--local', 'user.email'), 'octo@example.com');
  assert.equal(await git(ws.dir, 'remote'), '', 'the tree must not point back at the trusted clone or at GitHub');
});

test('a later visit picks up new commits and starts from a clean tree', async () => {
  const o = await origin();
  const first = await prepare(o, '2026-01-05');
  writeFileSync(join(first.dir, 'README.md'), 'edited by a run that died\n');
  writeFileSync(join(first.dir, 'leftover.txt'), 'junk\n');

  writeFileSync(join(o.seed, 'new.txt'), 'new\n');
  await git(o.seed, 'add', '-A');
  await git(o.seed, 'commit', '-q', '-m', 'second');
  await git(o.seed, 'push', '-q', 'origin', 'trunk');

  const second = await prepare(o, '2026-01-08');
  assert.equal(second.baseSha, await git(o.seed, 'rev-parse', 'trunk'));
  for (const dir of [second.repoDir, second.dir]) {
    assert.equal(await git(dir, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(dir, 'leftover.txt')), false);
    assert.equal(existsSync(join(dir, 'new.txt')), true);
    assert.equal(await git(dir, 'branch', '--list', '--format=%(refname:short)'), 'nightshift/2026-01-08');
  }
});

test('visiting twice on one date starts the branch again from the default branch', async () => {
  const o = await origin();
  const first = await prepare(o);
  writeFileSync(join(first.dir, 'a.txt'), 'a\n');
  await git(first.dir, 'add', '-A');
  await git(first.dir, 'commit', '-q', '-m', 'work from an earlier run');
  await importIt(first);
  const again = await prepare(o);
  assert.equal(await git(again.repoDir, 'rev-parse', 'HEAD'), again.baseSha);
  assert.equal(await git(again.dir, 'rev-parse', 'HEAD'), again.baseSha);
});

test('a branch name can be given', async () => {
  const o = await origin();
  assert.equal((await prepare(o, '2026-01-05', { branch: 'nightshift/2026-01-05-2' })).branch, 'nightshift/2026-01-05-2');
});

test('a clone that fails is an error that names the project and leaves no half-made folder', async () => {
  const o = await origin();
  await assert.rejects(() => prepare({ ...o, bare: join(o.root, 'nowhere.git') }), /octo\/app/);
  assert.equal(existsSync(join(o.dataDir, 'workspaces', 'octo__app', 'repo')), false);
});

async function twoCommits(ws) {
  writeFileSync(join(ws.dir, 'a.txt'), 'a\n');
  await git(ws.dir, 'add', '-A');
  await git(ws.dir, 'commit', '-q', '-m', 'Fix a\n\nCo-Authored-By: Some Tool <tool@example.com>');
  writeFileSync(join(ws.dir, 'b.txt'), 'b\n');
  await git(ws.dir, 'add', '-A');
  await git(ws.dir, 'commit', '-q', '-m', 'Fix b\n\nCo-Authored-By: Some Tool <tool@example.com>');
}

test('importChange brings the tree\'s commits into the trusted clone as one commit by the given identity', async () => {
  const o = await origin();
  const ws = await prepare(o);
  await twoCommits(ws);
  const result = await importIt(ws);
  const repo = ws.repoDir;
  assert.equal(result.sha, await git(repo, 'rev-parse', 'HEAD'));
  assert.equal(await git(repo, 'rev-parse', 'HEAD^'), ws.baseSha);
  assert.equal(await git(repo, 'rev-list', '--count', `${ws.baseSha}..HEAD`), '1');
  assert.equal(await git(repo, 'log', '-1', '--format=%B'), 'Reject empty names');
  assert.equal(await git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Octo Cat <octo@example.com>|Octo Cat <octo@example.com>');
  assert.equal(await git(repo, 'diff', '--name-only', ws.baseSha, 'HEAD'), 'a.txt\nb.txt');
  assert.equal(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightshift/2026-01-05');
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('importChange takes only what was committed, not files left lying in the tree', async () => {
  const o = await origin();
  const ws = await prepare(o);
  await twoCommits(ws);
  writeFileSync(join(ws.dir, 'coverage.out'), 'left behind by a test run\n');
  await importIt(ws);
  assert.equal(await git(ws.repoDir, 'diff', '--name-only', ws.baseSha, 'HEAD'), 'a.txt\nb.txt');
});

test('importChange returns null when nothing was committed, or the commits cancel out', async () => {
  const o = await origin();
  const ws = await prepare(o);
  writeFileSync(join(ws.dir, 'uncommitted.txt'), 'x\n');
  assert.equal(await importIt(ws), null);
  writeFileSync(join(ws.dir, 'README.md'), 'changed\n');
  await git(ws.dir, 'commit', '-q', '-am', 'change');
  writeFileSync(join(ws.dir, 'README.md'), 'hello\n');
  await git(ws.dir, 'commit', '-q', '-am', 'change back');
  assert.equal(await importIt(ws), null);
  assert.equal(await git(ws.repoDir, 'rev-parse', 'HEAD'), ws.baseSha);
});

test('importChange never runs the job\'s own git inside the tree, so hooks and settings planted there do nothing', async () => {
  const o = await origin();
  const ws = await prepare(o);
  const marker = join(o.root, 'planted-code-ran');
  const script = join(o.root, 'planted.sh');
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(script, 0o755);
  await twoCommits(ws);
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction', 'post-merge', 'pre-push', 'post-rewrite']) {
    writeFileSync(join(ws.dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(ws.dir, '.git', 'hooks', hook), 0o755);
  }
  await git(ws.dir, 'config', 'core.fsmonitor', script);
  await git(ws.dir, 'config', 'core.sshCommand', script);
  await git(ws.dir, 'config', 'alias.fetch', `!${script}`);

  const trustedCwds = [];
  const spy = (argv, options = {}) => {
    trustedCwds.push(options.cwd);
    assert.equal(argv.some((part) => part.startsWith(ws.dir + '/.git') || part === ws.dir), false, `trusted git was pointed at the tree: ${argv.join(' ')}`);
    return run(argv, options);
  };
  const result = await importIt(ws, 'Reject empty names', spy);
  assert.notEqual(result, null);
  assert.equal(trustedCwds.includes(ws.dir), false);
  assert.equal(existsSync(marker), false, 'code planted in the tree ran');
});

test('importChange reports a tree it cannot read instead of guessing', async () => {
  const o = await origin();
  const ws = await prepare(o);
  await run(['rm', '-rf', join(ws.dir, '.git')]);
  await assert.rejects(() => importIt(ws), /could not be read/);
});

test('resetTree rebuilds the tree at a commit of the trusted clone, leaving nothing behind', async () => {
  const o = await origin();
  const ws = await prepare(o);
  await twoCommits(ws);
  const { sha } = await importIt(ws);
  writeFileSync(join(ws.dir, 'stray.txt'), 'x\n');
  await resetTree({ run, gitPath: 'git', repoDir: ws.repoDir, dir: ws.dir, ref: sha, identity });
  assert.equal(await git(ws.dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(existsSync(join(ws.dir, 'stray.txt')), false);
  assert.equal(existsSync(join(ws.dir, 'a.txt')), true);
  assert.equal(await git(ws.dir, 'remote'), '');
});

test('on macOS importChange works through the real sandbox', { skip: process.platform !== 'darwin' }, async () => {
  const o = await origin();
  const ws = await prepare(o);
  await twoCommits(ws);
  const sandboxed = createRestrictedRun({
    run, sandbox: true, home: process.env.HOME, dataDir: o.dataDir, emptyDir: join(o.dataDir, 'empty'),
    env: process.env, settings: {},
  });
  const result = await importChange({
    run, restrictedRun: sandboxed, gitPath: 'git', repoDir: ws.repoDir, dir: ws.dir, cacheDir: ws.cacheDir,
    baseSha: ws.baseSha, message: 'Reject empty names', identity,
  });
  assert.equal(await git(ws.repoDir, 'diff', '--name-only', ws.baseSha, result.sha), 'a.txt\nb.txt');
  const blocked = await sandboxed(['git', 'commit', '--allow-empty', '-m', 'x'], { cwd: ws.repoDir, writable: [ws.dir], cacheDir: ws.cacheDir });
  assert.notEqual(blocked.code, 0, 'the sandbox must not be able to write to the trusted clone');
});
