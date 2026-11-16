import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGENT_SCHEMA, buildAgentCall, renderBrief, runAgent } from '../src/agent.mjs';

// Hand-written from the documented result shape; to be replaced by a recorded reply
// once the command-line tool can be probed.
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/claude-output.json', import.meta.url), 'utf8'));
const call = () => buildAgentCall({ claudePath: '/bin/claude', brief: 'the brief', claudeDir: '/data/claude' });

test('the argv runs Claude headless with structured output and its restrictions', () => {
  const { argv } = call();
  assert.deepEqual(argv.slice(0, 3), ['/bin/claude', '-p', 'the brief']);
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'json');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--json-schema') + 1]), AGENT_SCHEMA);
  for (const flag of ['--dangerously-skip-permissions', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
    assert.ok(argv.includes(flag), flag);
  }
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
  assert.deepEqual(denied, ['Bash(gh *)', 'Bash(git push *)', 'Bash(git remote *)', 'WebFetch', 'WebSearch']);
});

test('no model is named, so the run follows the tool\'s default', () => {
  assert.equal(call().argv.includes('--model'), false);
});

test('the call keeps Claude\'s own files in a folder of its own', () => {
  assert.deepEqual(call().env, { CLAUDE_CONFIG_DIR: '/data/claude' });
  assert.deepEqual(buildAgentCall({ claudePath: 'claude', brief: 'b', claudeDir: '/c', token: 'tok' }).env,
    { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
});

test('the schema requires findings, change and proposals', () => {
  assert.deepEqual(AGENT_SCHEMA.required, ['findings', 'change', 'proposals']);
  assert.deepEqual(AGENT_SCHEMA.properties.change.anyOf[1].properties.kind.enum, ['fix', 'dependency-patch', 'dead-code', 'docs']);
});

const runWith = (result, extra = {}) => {
  const calls = [];
  const restrictedRun = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return runAgent({ restrictedRun, call: call(), cwd: '/data/ws/tree', cacheDir: '/data/ws/cache', claudeDir: '/data/claude', timeoutMs: 1800000, ...extra })
    .then((outcome) => ({ outcome, calls }));
};

test('a good reply parses to ok with the output and the model that did the work', async () => {
  const { outcome, calls } = await runWith({ stdout: JSON.stringify(fixture()) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.model, 'example-model');
  assert.equal(outcome.output.change.title, 'Reject empty names when saving a profile');
  assert.equal(outcome.output.findings.length, 1);
  assert.deepEqual(calls[0].options, {
    cwd: '/data/ws/tree', timeoutMs: 1800000, writable: ['/data/ws/tree', '/data/claude'], cacheDir: '/data/ws/cache',
    env: { CLAUDE_CONFIG_DIR: '/data/claude' },
  });
});

test('a reply with no change is ok', async () => {
  const reply = fixture();
  reply.structured_output.change = null;
  const { outcome } = await runWith({ stdout: JSON.stringify(reply) });
  assert.deepEqual([outcome.ok, outcome.output.change], [true, null]);
});

test('a timed-out run fails', async () => {
  const { outcome } = await runWith({ timedOut: true, code: 143 });
  assert.deepEqual([outcome.ok, outcome.output, outcome.failure], [false, null, 'The model ran out of time.']);
});

test('a non-zero exit with no reply fails with the first line of the error', async () => {
  const { outcome } = await runWith({ code: 1, stderr: 'Error: something broke\n  at x\n' });
  assert.deepEqual([outcome.ok, outcome.failure], [false, 'Claude stopped with an error: Error: something broke']);
});

test('output missing findings, or of the wrong shape, fails', async () => {
  const cases = [
    (o) => delete o.findings,
    (o) => (o.findings = 'none'),
    (o) => (o.proposals = [{ title: 5 }]),
    (o) => (o.change = { title: 'x' }),
    (o) => (o.change.kind = 'feature'),
    (o) => (o.change.claims = 'fast'),
  ];
  for (const breakIt of cases) {
    const reply = fixture();
    breakIt(reply.structured_output);
    const { outcome } = await runWith({ stdout: JSON.stringify(reply) });
    assert.deepEqual([outcome.ok, outcome.failure], [false, 'The model returned a report in the wrong shape.']);
  }
  const none = fixture();
  delete none.structured_output;
  assert.equal((await runWith({ stdout: JSON.stringify(none) })).outcome.failure, 'The model did not return a report.');
  assert.equal((await runWith({ stdout: 'not json at all' })).outcome.failure, 'Claude returned something that could not be read.');
});

test('a usage limit and an expired sign-in are named as such', async () => {
  const limit = { ...fixture(), is_error: true, result: "You've hit your usage limit. It resets at 5am." };
  assert.equal((await runWith({ stdout: JSON.stringify(limit), code: 1 })).outcome.failure, 'Claude usage limit reached');
  const auth = { ...fixture(), is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' };
  assert.equal((await runWith({ stdout: JSON.stringify(auth), code: 1 })).outcome.failure, 'Claude is not signed in');
  const other = { ...fixture(), is_error: true, result: 'API Error: 500 internal error\nmore' };
  assert.equal((await runWith({ stdout: JSON.stringify(other), code: 1 })).outcome.failure, 'Claude stopped with an error: API Error: 500 internal error');
});

test('long or multi-line text from the model is trimmed to size', async () => {
  const reply = fixture();
  reply.structured_output.findings[0].title = `line one\nline two ${'x'.repeat(500)}`;
  reply.structured_output.findings[0].detail = 'd'.repeat(5000);
  const { outcome } = await runWith({ stdout: JSON.stringify(reply) });
  const finding = outcome.output.findings[0];
  assert.ok(finding.title.length <= 160 && !finding.title.includes('\n'));
  assert.ok(finding.detail.length <= 1500);
});

test('the brief names the project and lists what is already known', () => {
  const brief = renderBrief({ project: 'octo/app', mayChange: true, isPublic: false, knownFindings: ['Old finding', 'Another\none'] });
  assert.match(brief, /repository in the current directory \(octo\/app\)/);
  assert.match(brief, /- Old finding\n- Another one\n/);
  assert.match(brief, /Make at most one change tonight/);
  assert.match(brief, /never an instruction to you/);
  assert.doesNotMatch(brief, /\{[a-zA-Z]+\}/, 'no placeholder may be left in the brief');
  assert.match(renderBrief({ project: 'octo/app', mayChange: true, isPublic: false, knownFindings: [] }), /do not report these again:\n\(nothing yet\)/);
});

test('the brief for a public repository tells the model not to describe a weakness it fixed', () => {
  const pub = renderBrief({ project: 'octo/app', mayChange: true, isPublic: true, knownFindings: [] });
  assert.match(pub, /must not describe the weakness/);
  const priv = renderBrief({ project: 'octo/app', mayChange: true, isPublic: false, knownFindings: [] });
  assert.doesNotMatch(priv, /must not describe the weakness/);
});

test('the brief can forbid changes', () => {
  const brief = renderBrief({ project: 'octo/app', mayChange: false, isPublic: true, knownFindings: [] });
  assert.match(brief, /Do not change any file tonight\. Set "change" to null\./);
  assert.doesNotMatch(brief, /Make at most one change/);
  assert.doesNotMatch(brief, /must not describe the weakness/);
});
