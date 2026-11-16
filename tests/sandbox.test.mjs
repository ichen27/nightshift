import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';
import { createRestrictedRun, restrictedEnv, sandboxProfile, sandboxSupported } from '../src/sandbox.mjs';
import { fakeRun } from './helpers.mjs';

test('the profile denies all writes except the listed places', () => {
  const profile = sandboxProfile({ writable: ['/data/tree', '/data/cache'], denyRead: [], readable: [] });
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\*[^)]*\(subpath "\/data\/tree"\)/s);
  assert.match(profile, /\(subpath "\/data\/cache"\)/);
});

test('the profile denies reading the listed places, then re-allows the readable ones', () => {
  const profile = sandboxProfile({ writable: ['/data/tree'], denyRead: ['/data', '/home/me/.ssh'], readable: ['/data/tree'] });
  const deny = profile.indexOf('(deny file-read-data');
  const allow = profile.indexOf('(allow file-read-data');
  assert.ok(deny > 0 && allow > deny, 'the allow rule must come after the deny rule');
  assert.match(profile.slice(deny, allow), /\(subpath "\/data"\)\s*\(subpath "\/home\/me\/\.ssh"\)/);
  assert.match(profile.slice(allow), /\(subpath "\/data\/tree"\)/);
});

test('a path that could break out of the profile is refused', () => {
  for (const bad of ['/data/"tree', '/data/tree\n(allow default)', 'relative/path', '']) {
    assert.throws(() => sandboxProfile({ writable: [bad], denyRead: [], readable: [] }), /path/);
  }
});

test('the restricted environment is a short allow-list with credentials switched off', () => {
  const env = restrictedEnv(
    { PATH: '/bin', HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', GH_TOKEN: 'x', GITHUB_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_BASE_URL: 'x', AWS_SECRET_ACCESS_KEY: 'x',
      NPM_TOKEN: 'x', SSH_AUTH_SOCK: '/sock', SOME_APP_SECRET: 'x' },
    { emptyDir: '/data/empty', cacheDir: '/data/cache' },
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'CI', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH',
    'TMPDIR', 'USER', 'XDG_CACHE_HOME', 'npm_config_cache', 'npm_config_userconfig',
  ]);
  assert.equal(env.GH_CONFIG_DIR, '/data/empty');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.npm_config_cache, '/data/cache/npm');
  assert.equal(env.TMPDIR, '/data/cache/tmp');
});

test('extra variables can be added to the restricted environment', () => {
  const env = restrictedEnv({ PATH: '/bin' }, { emptyDir: '/e', cacheDir: '/c', extra: { CLAUDE_CONFIG_DIR: '/data/claude' } });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/data/claude');
});

test('sandboxSupported is true only on macOS with sandbox-exec present', () => {
  assert.equal(sandboxSupported({ platform: 'darwin', existsSync: () => true }), true);
  assert.equal(sandboxSupported({ platform: 'darwin', existsSync: () => false }), false);
  assert.equal(sandboxSupported({ platform: 'linux', existsSync: () => true }), false);
});

const options = (over = {}) => ({
  ensureDir: () => {}, home: '/home/me', dataDir: '/data', emptyDir: '/data/empty', env: { PATH: '/bin', HOME: '/home/me', GH_TOKEN: 'x' },
  settings: { sandbox: { allowWrite: ['/opt/extra-write'], allowRead: ['/vol/tools/browsers'], denyRead: ['/vol/tools'] } },
  ...over,
});

test('a restricted run wraps the command in sandbox-exec with the restricted environment', async () => {
  const { run: fake, calls } = fakeRun([[() => true, {}]]);
  const restricted = createRestrictedRun({ run: fake, sandbox: true, ...options() });
  await restricted(['npm', 'test'], { cwd: '/data/workspaces/octo__app/tree', timeoutMs: 5, writable: ['/data/workspaces/octo__app/tree'], cacheDir: '/data/workspaces/octo__app/cache' });
  const { argv, options: passed } = calls[0];
  assert.deepEqual([argv[0], argv[1]], ['/usr/bin/sandbox-exec', '-p']);
  assert.deepEqual(argv.slice(3), ['npm', 'test']);
  const profile = argv[2];
  for (const path of ['/data/workspaces/octo__app/tree', '/data/workspaces/octo__app/cache', '/opt/extra-write']) {
    assert.match(profile.slice(profile.indexOf('(allow file-write*'), profile.indexOf('(deny file-read-data')), new RegExp(`\\(subpath "${path}"\\)`));
  }
  const denied = profile.slice(profile.indexOf('(deny file-read-data'), profile.indexOf('(allow file-read-data'));
  for (const path of ['/data', '/vol/tools', '/home/me/.config/gh', '/home/me/.ssh', '/home/me/.claude', '/home/me/Documents']) {
    assert.match(denied, new RegExp(`"${path.replaceAll('.', '\\.')}"`), path);
  }
  const reallowed = profile.slice(profile.indexOf('(allow file-read-data'));
  assert.match(reallowed, /"\/data\/workspaces\/octo__app\/tree"/);
  assert.match(reallowed, /"\/vol\/tools\/browsers"/);
  assert.equal(passed.cwd, '/data/workspaces/octo__app/tree');
  assert.equal(passed.timeoutMs, 5);
  assert.equal(passed.env.GH_TOKEN, undefined);
  assert.equal(passed.env.GH_CONFIG_DIR, '/data/empty');
});

test('without a sandbox the command runs as it is, still with the restricted environment', async () => {
  const { run: fake, calls } = fakeRun([[() => true, {}]]);
  const restricted = createRestrictedRun({ run: fake, sandbox: false, ...options() });
  await restricted(['npm', 'test'], { cwd: '/t', writable: ['/t'], cacheDir: '/c', env: { CLAUDE_CONFIG_DIR: '/data/claude' } });
  assert.deepEqual(calls[0].argv, ['npm', 'test']);
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/data/claude');
});

test('on macOS the sandbox really blocks outside writes and denied reads', { skip: process.platform !== 'darwin' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nightshift-sbx-')));
  const outside = realpathSync(mkdtempSync(join(process.env.HOME, '.nightshift-sbx-test-')));
  try {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'token');
    const restricted = createRestrictedRun({
      run, sandbox: true, home: process.env.HOME, dataDir: join(root, 'data'), emptyDir: join(root, 'empty'),
      env: process.env, settings: { sandbox: { allowWrite: [], allowRead: [], denyRead: [outside] } },
    });
    const opts = { cwd: root, writable: [join(root, 'tree')], cacheDir: join(root, 'cache'), timeoutMs: 20000 };
    const node = process.execPath;
    const write = (path) => restricted([node, '-e', `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(path)}),{recursive:true});require('fs').writeFileSync(${JSON.stringify(path)},'x')`], opts);
    assert.equal((await write(join(root, 'tree', 'ok.txt'))).code, 0);
    assert.equal(existsSync(join(root, 'tree', 'ok.txt')), true);
    assert.notEqual((await write(join(outside, 'written.txt'))).code, 0);
    assert.equal(existsSync(join(outside, 'written.txt')), false);
    const read = await restricted([node, '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(secret)},'utf8'))`], opts);
    assert.notEqual(read.code, 0);
    assert.doesNotMatch(read.stdout, /token/);
  } finally {
    await run(['rm', '-rf', outside, root]);
  }
});
