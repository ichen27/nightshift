// These tests use real git against a bare repository in a temporary folder. No network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';
import { prepareWorkspace, squashBranch } from '../src/workspace.mjs';

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

test('the first visit clones into workspaces/<owner>__<repo> on a nightshift/<date> branch from the default branch', async () => {
  const o = await origin();
  const ws = await prepare(o);
  assert.equal(ws.dir, join(o.dataDir, 'workspaces', 'octo__app'));
  assert.equal(ws.branch, 'nightshift/2026-01-05');
  assert.equal(await git(ws.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightshift/2026-01-05');
  assert.equal(ws.baseSha, await git(o.seed, 'rev-parse', 'trunk'));
  assert.equal(await git(ws.dir, 'config', '--local', 'user.name'), 'Octo Cat');
  assert.equal(await git(ws.dir, 'config', '--local', 'user.email'), 'octo@example.com');
});

test('a later visit picks up new commits and discards a leftover edit and an untracked file', async () => {
  const o = await origin();
  const first = await prepare(o, '2026-01-05');
  writeFileSync(join(first.dir, 'README.md'), 'edited by a run that died\n');
  writeFileSync(join(first.dir, 'leftover.txt'), 'junk\n');
  await git(first.dir, 'add', 'README.md');

  writeFileSync(join(o.seed, 'new.txt'), 'new\n');
  await git(o.seed, 'add', '-A');
  await git(o.seed, 'commit', '-q', '-m', 'second');
  await git(o.seed, 'push', '-q', 'origin', 'trunk');

  const second = await prepare(o, '2026-01-08');
  assert.equal(second.baseSha, await git(o.seed, 'rev-parse', 'trunk'));
  assert.equal(await git(second.dir, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(second.dir, 'leftover.txt')), false);
  assert.equal(existsSync(join(second.dir, 'new.txt')), true);
  assert.equal(await git(second.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightshift/2026-01-08');
  assert.equal(await git(second.dir, 'branch', '--list', 'nightshift/*', '--format=%(refname:short)'), 'nightshift/2026-01-08');
});

test('visiting twice on one date starts the branch again from the default branch', async () => {
  const o = await origin();
  const first = await prepare(o);
  writeFileSync(join(first.dir, 'a.txt'), 'a\n');
  await git(first.dir, 'add', '-A');
  await git(first.dir, 'commit', '-q', '-m', 'work from an earlier run');
  const again = await prepare(o);
  assert.equal(await git(again.dir, 'rev-parse', 'HEAD'), again.baseSha);
});

test('a branch name can be given', async () => {
  const o = await origin();
  assert.equal((await prepare(o, '2026-01-05', { branch: 'nightshift/2026-01-05-2' })).branch, 'nightshift/2026-01-05-2');
});

test('a clone that fails is an error that names the project and leaves no half-made folder', async () => {
  const o = await origin();
  await assert.rejects(() => prepare({ ...o, bare: join(o.root, 'nowhere.git') }), /octo\/app/);
  assert.equal(existsSync(join(o.dataDir, 'workspaces', 'octo__app')), false);
});

test('squashBranch turns the commits on the branch into one commit by the given identity', async () => {
  const o = await origin();
  const ws = await prepare(o);
  writeFileSync(join(ws.dir, 'a.txt'), 'a\n');
  await git(ws.dir, 'add', '-A');
  await git(ws.dir, 'commit', '-q', '-m', 'Fix a\n\nCo-Authored-By: Some Tool <tool@example.com>');
  writeFileSync(join(ws.dir, 'b.txt'), 'b\n');
  await git(ws.dir, 'add', '-A');
  await git(ws.dir, 'commit', '-q', '-m', 'Fix b\n\nCo-Authored-By: Some Tool <tool@example.com>');

  const result = await squashBranch({ run, gitPath: 'git', dir: ws.dir, baseSha: ws.baseSha, message: 'Reject empty names', identity });
  assert.equal(result.sha, await git(ws.dir, 'rev-parse', 'HEAD'));
  assert.equal(await git(ws.dir, 'rev-list', '--count', `${ws.baseSha}..HEAD`), '1');
  assert.equal(await git(ws.dir, 'log', '-1', '--format=%B'), 'Reject empty names');
  assert.equal(await git(ws.dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Octo Cat <octo@example.com>|Octo Cat <octo@example.com>');
  assert.equal(await git(ws.dir, 'diff', '--name-only', ws.baseSha, 'HEAD'), 'a.txt\nb.txt');
  assert.equal(await git(ws.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'nightshift/2026-01-05');
});

test('squashBranch includes edits the model left uncommitted', async () => {
  const o = await origin();
  const ws = await prepare(o);
  writeFileSync(join(ws.dir, 'README.md'), 'changed\n');
  writeFileSync(join(ws.dir, 'new.txt'), 'new\n');
  const result = await squashBranch({ run, gitPath: 'git', dir: ws.dir, baseSha: ws.baseSha, message: 'Tidy', identity });
  assert.notEqual(result, null);
  assert.equal(await git(ws.dir, 'diff', '--name-only', ws.baseSha, 'HEAD'), 'README.md\nnew.txt');
  assert.equal(await git(ws.dir, 'status', '--porcelain'), '');
});

test('squashBranch returns null when nothing changed, including commits that cancel out', async () => {
  const o = await origin();
  const ws = await prepare(o);
  assert.equal(await squashBranch({ run, gitPath: 'git', dir: ws.dir, baseSha: ws.baseSha, message: 'x', identity }), null);
  writeFileSync(join(ws.dir, 'README.md'), 'changed\n');
  await git(ws.dir, 'commit', '-q', '-am', 'change');
  writeFileSync(join(ws.dir, 'README.md'), 'hello\n');
  await git(ws.dir, 'commit', '-q', '-am', 'change back');
  assert.equal(await squashBranch({ run, gitPath: 'git', dir: ws.dir, baseSha: ws.baseSha, message: 'x', identity }), null);
  assert.equal(await git(ws.dir, 'rev-parse', 'HEAD'), ws.baseSha);
});
