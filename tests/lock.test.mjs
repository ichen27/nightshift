import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock, isProcessAlive } from '../src/lock.mjs';
import { createStore } from '../src/store.mjs';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-lock-'));
  return { dir, store: createStore(dir) };
};

test('the first run takes the lock and release removes it', () => {
  const { store } = fresh();
  const lock = acquireLock(store, { pid: 100, isAlive: () => true });
  assert.equal(store.read('run.lock', null).pid, 100);
  lock.release();
  assert.equal(store.read('run.lock', null), null);
});

test('a lock held by a live pid returns null', () => {
  const { store } = fresh();
  acquireLock(store, { pid: 100, isAlive: () => true });
  assert.equal(acquireLock(store, { pid: 200, isAlive: (pid) => pid === 100 }), null);
  assert.equal(store.read('run.lock', null).pid, 100);
});

test('a lock held by a dead pid is replaced', () => {
  const { store } = fresh();
  acquireLock(store, { pid: 100, isAlive: () => true });
  const lock = acquireLock(store, { pid: 200, isAlive: () => false });
  assert.notEqual(lock, null);
  assert.equal(store.read('run.lock', null).pid, 200);
});

test('a lock file that cannot be read is replaced', () => {
  const { dir, store } = fresh();
  writeFileSync(join(dir, 'run.lock'), 'not json');
  assert.notEqual(acquireLock(store, { pid: 200, isAlive: () => true }), null);
  assert.equal(store.read('run.lock', null).pid, 200);
});

test('release leaves a lock that now belongs to another run', () => {
  const { store } = fresh();
  const first = acquireLock(store, { pid: 100, isAlive: () => true });
  acquireLock(store, { pid: 200, isAlive: () => false });
  first.release();
  assert.equal(store.read('run.lock', null).pid, 200);
});

test('isProcessAlive knows this process is alive and a finished one is not', async () => {
  const { spawnSync } = await import('node:child_process');
  assert.equal(isProcessAlive(process.pid), true);
  const done = spawnSync(process.execPath, ['-e', '']);
  assert.equal(isProcessAlive(done.pid), false);
});
