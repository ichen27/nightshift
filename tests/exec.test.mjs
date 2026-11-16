import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/exec.mjs';

const node = process.execPath;

test('returns code, stdout and stderr', async () => {
  const r = await run([node, '-e', 'console.log("out"); console.error("err")']);
  assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim(), r.timedOut], [0, 'out', 'err', false]);
});

test('a non-zero exit is returned, not thrown', async () => {
  const r = await run([node, '-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('a command that does not exist is returned as a failure, not thrown', async () => {
  const r = await run(['nightshift-no-such-command-xyz']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /nightshift-no-such-command-xyz/);
  assert.equal(r.timedOut, false);
});

test('arguments are passed as they are, with no shell', async () => {
  const r = await run([node, '-e', 'console.log(process.argv[1])', '$(echo hacked); `id` && x']);
  assert.equal(r.stdout.trim(), '$(echo hacked); `id` && x');
});

test('a run past its timeout is stopped and marked timedOut', async () => {
  const started = Date.now();
  const r = await run([node, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 10000);
});

test('cwd and env are used', async () => {
  const r = await run([node, '-e', 'console.log(process.cwd() + "|" + process.env.NS_TEST)'], {
    cwd: '/',
    env: { ...process.env, NS_TEST: 'yes' },
  });
  assert.equal(r.stdout.trim(), '/|yes');
});

test('an empty argv is rejected', async () => {
  await assert.rejects(() => run([]), /argv/);
  await assert.rejects(() => run('ls -la'), /argv/);
});
