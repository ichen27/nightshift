import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ALLOWED_HOSTS, UsageError, localDate, parseArgs, readToken } from '../src/cli.mjs';

test('run with no options', () => {
  assert.deepEqual(parseArgs(['run']), { command: 'run', only: null, dryRun: false });
});

test('run --only takes a repository in any of the usual forms', () => {
  assert.deepEqual(parseArgs(['run', '--only', 'octo/app']), { command: 'run', only: 'octo/app', dryRun: false });
  assert.deepEqual(parseArgs(['run', '--dry-run', '--only', 'https://github.com/octo/app.git']), { command: 'run', only: 'octo/app', dryRun: true });
});

test('anything else is a usage error', () => {
  for (const argv of [[], ['walk'], ['run', '--only'], ['run', '--only', 'not a repo'], ['run', '--fast'], ['run', 'extra']]) {
    assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
  }
});

test('localDate is the calendar date where the machine is', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 2, 0)), '2026-01-05');
  assert.equal(localDate(new Date(2026, 10, 30, 23, 59)), '2026-11-30');
});

test('the token is read from claude-token in the data folder, trimmed, or null', () => {
  const files = { '/data/claude-token': '  tok-123\n' };
  const fs = { readFileSync: (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; } };
  assert.equal(readToken('/data', fs), 'tok-123');
  assert.equal(readToken('/elsewhere', fs), null);
  files['/data/claude-token'] = '   \n';
  assert.equal(readToken('/data', fs), null);
});

test('by default the sandbox can reach only the model and the npm registry', () => {
  assert.deepEqual(DEFAULT_ALLOWED_HOSTS, ['api.anthropic.com', 'registry.npmjs.org']);
});
