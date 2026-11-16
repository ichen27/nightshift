import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, loadSettings, DEFAULT_SETTINGS } from '../src/config.mjs';

test('data dir prefers NIGHTSHIFT_DATA_DIR, then APP_DATA_DIR', () => {
  assert.equal(loadConfig({ NIGHTSHIFT_DATA_DIR: '/a', APP_DATA_DIR: '/b' }).dataDir, '/a');
  assert.equal(loadConfig({ APP_DATA_DIR: '/b' }).dataDir, '/b');
  assert.throws(() => loadConfig({}), /data folder/);
});

test('host and port default to loopback 8950', () => {
  const c = loadConfig({ APP_DATA_DIR: '/b' });
  assert.deepEqual([c.host, c.port], ['127.0.0.1', 8950]);
});

test('host and port follow HOST and PORT', () => {
  const c = loadConfig({ APP_DATA_DIR: '/b', HOST: '0.0.0.0', PORT: '9001' });
  assert.deepEqual([c.host, c.port], ['0.0.0.0', 9001]);
});

test('a PORT that is not a port number is rejected', () => {
  assert.throws(() => loadConfig({ APP_DATA_DIR: '/b', PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ APP_DATA_DIR: '/b', PORT: '70000' }), /PORT/);
});

test('tool paths default to bare command names and follow NIGHTSHIFT_* overrides', () => {
  const d = loadConfig({ APP_DATA_DIR: '/b' });
  assert.deepEqual([d.ghPath, d.gitPath, d.claudePath, d.nodePath], ['gh', 'git', 'claude', 'node']);
  const o = loadConfig({
    APP_DATA_DIR: '/b',
    NIGHTSHIFT_GH: '/x/gh',
    NIGHTSHIFT_GIT: '/x/git',
    NIGHTSHIFT_CLAUDE: '/x/claude',
    NIGHTSHIFT_NODE: '/x/node',
  });
  assert.deepEqual([o.ghPath, o.gitPath, o.claudePath, o.nodePath], ['/x/gh', '/x/git', '/x/claude', '/x/node']);
});

test('settings are the defaults when no file exists', () => {
  const store = { read: (_name, fallback) => fallback };
  assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.projectsPerNight, 3);
});

test('settings file values override the defaults and unknown keys are dropped', () => {
  const store = { read: () => ({ projectsPerNight: 1, hold: ['octo/app'], surprise: true }) };
  const s = loadSettings(store);
  assert.equal(s.projectsPerNight, 1);
  assert.deepEqual(s.hold, ['octo/app']);
  assert.deepEqual(s.adminMerge, []);
  assert.equal('surprise' in s, false);
});

test('a settings file that is not an object falls back to the defaults', () => {
  assert.deepEqual(loadSettings({ read: () => 'nonsense' }), DEFAULT_SETTINGS);
});
