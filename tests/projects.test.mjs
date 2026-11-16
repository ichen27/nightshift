import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjects, ProjectError } from '../src/projects.mjs';
import { createStore } from '../src/store.mjs';

const okRepo = { exists: true, owner: 'octo', repo: 'app', archived: false, canPush: true, isPublic: true, defaultBranch: 'trunk', mergeMethods: ['squash'] };

function setup({ repo = okRepo, prs = [], prsFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-projects-'));
  const store = createStore(dir);
  const github = {
    getRepo: async () => (repo instanceof Error ? Promise.reject(repo) : repo),
    listNightshiftPrs: async () => {
      if (prsFail) throw new Error('boom');
      return prs;
    },
  };
  const projects = createProjects({ store, github, now: () => new Date('2026-01-02T03:04:05Z') });
  return { dir, store, projects };
}

test('add stores a healthy project', async () => {
  const { projects } = setup();
  const { project, created } = await projects.add('https://github.com/octo/app');
  assert.equal(created, true);
  assert.deepEqual(project, {
    owner: 'octo',
    repo: 'app',
    defaultBranch: 'trunk',
    isPublic: true,
    addedAt: '2026-01-02T03:04:05.000Z',
    lastVisitAt: null,
    lastResult: null,
    status: 'healthy',
  });
  assert.deepEqual(projects.list(), [project]);
});

test('adding twice returns the same project, list length 1', async () => {
  const { projects } = setup();
  const first = await projects.add('octo/app');
  const second = await projects.add('git@github.com:OCTO/App.git');
  assert.equal(second.created, false);
  assert.deepEqual(second.project, first.project);
  assert.equal(projects.list().length, 1);
});

test('the stored name uses GitHub\'s own spelling, not the pasted one', async () => {
  const { projects } = setup({ repo: { ...okRepo, owner: 'Octo', repo: 'App' } });
  const { project } = await projects.add('octo/app');
  assert.deepEqual([project.owner, project.repo], ['Octo', 'App']);
});

test('a link that is not a repository link', async () => {
  const { projects } = setup();
  await assert.rejects(() => projects.add('not a link'), { message: "That isn't a GitHub repository link." });
});

test('missing repo', async () => {
  const { projects } = setup({ repo: { exists: false } });
  await assert.rejects(() => projects.add('octo/app'), (e) =>
    e instanceof ProjectError && e.message === "That repository doesn't exist or you can't see it.");
});

test('archived repo', async () => {
  const { projects } = setup({ repo: { ...okRepo, archived: true } });
  await assert.rejects(() => projects.add('octo/app'), { message: 'That repository is archived.' });
});

test('no write access', async () => {
  const { projects } = setup({ repo: { ...okRepo, canPush: false } });
  await assert.rejects(() => projects.add('octo/app'), { message: "You don't have write access to that repository." });
  assert.equal(projects.list().length, 0);
});

test('GitHub being unreachable is not reported as a problem with the link', async () => {
  const { projects } = setup({ repo: new Error('GitHub could not be reached') });
  await assert.rejects(() => projects.add('octo/app'), (e) => !(e instanceof ProjectError));
});

test('remove keeps reports, deletes workspaces/<owner>__<repo>, returns open Nightshift PR urls', async () => {
  const { dir, store, projects } = setup({ prs: [{ number: 4, url: 'https://github.com/octo/app/pull/4' }] });
  await projects.add('octo/app');
  store.write('reports/2026-01-01.json', { date: '2026-01-01' });
  mkdirSync(join(dir, 'workspaces', 'octo__app'), { recursive: true });
  writeFileSync(join(dir, 'workspaces', 'octo__app', 'file.txt'), 'x');
  const result = await projects.remove('OCTO', 'APP');
  assert.deepEqual(result, { removed: true, openPrs: ['https://github.com/octo/app/pull/4'] });
  assert.equal(projects.list().length, 0);
  assert.equal(existsSync(join(dir, 'workspaces', 'octo__app')), false);
  assert.deepEqual(store.read('reports/2026-01-01.json', null), { date: '2026-01-01' });
});

test('remove still removes the project when open pull requests cannot be listed', async () => {
  const { projects } = setup({ prsFail: true });
  await projects.add('octo/app');
  assert.deepEqual(await projects.remove('octo', 'app'), { removed: true, openPrs: null });
  assert.equal(projects.list().length, 0);
});

test('removing a project that is not listed changes nothing', async () => {
  const { projects } = setup();
  await projects.add('octo/app');
  assert.deepEqual(await projects.remove('octo', 'other'), { removed: false, openPrs: [] });
  assert.equal(projects.list().length, 1);
});

test('update changes only the visit fields of the named project', async () => {
  const { projects } = setup();
  await projects.add('octo/app');
  const updated = projects.update('octo', 'app', {
    lastVisitAt: '2026-01-03T07:00:00.000Z',
    lastResult: 'Merged 1 fix',
    status: 'needs-you',
    owner: 'evil',
  });
  assert.deepEqual([updated.lastVisitAt, updated.lastResult, updated.status, updated.owner],
    ['2026-01-03T07:00:00.000Z', 'Merged 1 fix', 'needs-you', 'octo']);
  assert.deepEqual(projects.list()[0], updated);
  assert.equal(projects.update('octo', 'other', { status: 'needs-you' }), null);
});
