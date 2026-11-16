import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStore } from '../src/store.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'nightshift-store-'));

test('read returns the fallback when the file is missing', () => {
  assert.deepEqual(createStore(fresh()).read('projects.json', []), []);
});

test('write then read round-trips, creating folders as needed', () => {
  const store = createStore(fresh());
  store.write('reports/2026-01-02.json', { date: '2026-01-02' });
  assert.deepEqual(store.read('reports/2026-01-02.json', null), { date: '2026-01-02' });
});

test('a failed write leaves the old file readable and no temporary file behind', () => {
  const dir = fresh();
  const store = createStore(dir);
  store.write('projects.json', [{ repo: 'app' }]);
  const circular = {};
  circular.self = circular;
  assert.throws(() => store.write('projects.json', circular));
  assert.deepEqual(store.read('projects.json', null), [{ repo: 'app' }]);
  assert.deepEqual(readdirSync(dir), ['projects.json']);
});

test('a successful write leaves no temporary file behind', () => {
  const dir = fresh();
  createStore(dir).write('a.json', 1);
  assert.deepEqual(readdirSync(dir), ['a.json']);
});

test('a file that is not valid JSON is an error, not the fallback', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'projects.json'), '{ broken');
  assert.throws(() => createStore(dir).read('projects.json', []), /projects\.json/);
});

test('list returns the JSON file names in a folder, sorted, and [] when it is missing', () => {
  const store = createStore(fresh());
  assert.deepEqual(store.list('reports'), []);
  store.write('reports/2026-01-03.json', {});
  store.write('reports/2026-01-01.json', {});
  assert.deepEqual(store.list('reports'), ['2026-01-01.json', '2026-01-03.json']);
});

test('remove deletes a file or a whole folder and ignores what is not there', () => {
  const dir = fresh();
  const store = createStore(dir);
  store.write('run.lock', { pid: 1 });
  mkdirSync(join(dir, 'workspaces', 'octo__app', 'src'), { recursive: true });
  writeFileSync(join(dir, 'workspaces', 'octo__app', 'src', 'x.txt'), 'x');
  store.remove('run.lock');
  store.remove('workspaces/octo__app');
  store.remove('never-existed.json');
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  assert.equal(existsSync(join(dir, 'workspaces', 'octo__app')), false);
});

test('names that leave the data folder are refused', () => {
  const store = createStore(fresh());
  for (const name of ['../outside.json', '/etc/passwd', 'reports/../../x.json', '', '.']) {
    assert.throws(() => store.read(name, null), /data folder/);
    assert.throws(() => store.write(name, 1), /data folder/);
    assert.throws(() => store.remove(name), /data folder/);
  }
});
