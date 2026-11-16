import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createProjects } from '../src/projects.mjs';
import { createServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
const servers = [];
after(() => servers.forEach((s) => s.close()));

// Times are built from local parts so the tests do not depend on the machine's time zone.
const at = (day, hour, minute = 0) => new Date(2026, 0, day, hour, minute);

async function start({ now = at(5, 6), scheduleOn = true, github, projects, allowedHosts } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'nightshift-server-')));
  if (scheduleOn) store.write('schedule.json', { hour: 2, minute: 0 });
  const fakeGithub = github ?? {
    getRepo: async (owner, repo) => ({
      exists: repo !== 'gone', owner, repo, archived: false, canPush: true, isPublic: true,
      defaultBranch: 'main', mergeMethods: ['squash'],
    }),
    listNightshiftPrs: async () => [{ number: 3, url: 'https://github.com/octo/app/pull/3' }],
  };
  const clock = { now };
  const list = projects ?? createProjects({ store, github: fakeGithub, now: () => clock.now });
  const server = createServer({ projects: list, store, now: () => clock.now, allowedHosts, isAlive: (pid) => pid === 1 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;

  // Raw request, so paths such as /../x reach the server exactly as written.
  const request = ({ method = 'GET', path = '/', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  const json = { 'content-type': 'application/json', origin: `http://${host}` };
  const post = (link, headers = json) =>
    request({ method: 'POST', path: '/api/projects', headers, body: JSON.stringify({ link }) });
  const del = (path, headers = json) => request({ method: 'DELETE', path, headers });
  return { store, request, post, del, host, clock, json };
}

test('GET /health', async () => {
  const { request } = await start();
  const res = await request({ path: '/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('GET /api/state lists projects, the next run and report dates newest first', async () => {
  const { request, post, store } = await start({ now: at(5, 6) });
  await post('octo/app');
  store.write('reports/2026-01-03.json', { ...fixture(), date: '2026-01-03' });
  store.write('reports/2026-01-05.json', fixture());
  store.write('reports/not-a-date.json', {});
  const { status, json, headers } = await request({ path: '/api/state' });
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(json.projects.map((p) => `${p.owner}/${p.repo}`), ['octo/app']);
  assert.equal(json.nextRunAt, at(6, 2).toISOString());
  assert.deepEqual(json.reportDates, ['2026-01-05', '2026-01-03']);
  assert.deepEqual(json.lastNight, { date: '2026-01-05', state: 'ok', reason: null });
});

test('the next run is later today when the scheduled time has not passed yet', async () => {
  const { request } = await start({ now: at(5, 1, 30) });
  assert.equal((await request({ path: '/api/state' })).json.nextRunAt, at(5, 2).toISOString());
});

test('with the schedule off there is no next run and a missing night is not reported', async () => {
  const { request } = await start({ now: at(5, 6), scheduleOn: false });
  const { json } = await request({ path: '/api/state' });
  assert.equal(json.nextRunAt, null);
  assert.deepEqual(json.lastNight, { date: null, state: 'none', reason: null });
});

test('last night is missing at 06:00 when the 02:00 run left no report', async () => {
  const { request, store } = await start({ now: at(5, 6) });
  store.write('reports/2026-01-04.json', { ...fixture(), date: '2026-01-04' });
  const { json } = await request({ path: '/api/state' });
  assert.equal(json.lastNight.date, '2026-01-05');
  assert.equal(json.lastNight.state, 'missing');
  assert.match(json.lastNight.reason, /did not run/);
});

test('last night is not called missing until three hours after the scheduled time', async () => {
  const { request, store } = await start({ now: at(5, 4) });
  store.write('reports/2026-01-04.json', { ...fixture(), date: '2026-01-04' });
  assert.deepEqual((await request({ path: '/api/state' })).json.lastNight, { date: '2026-01-04', state: 'ok', reason: null });
});

test('before tonight\'s run, last night is yesterday\'s scheduled run', async () => {
  const { request, store } = await start({ now: at(5, 1) });
  store.write('reports/2026-01-04.json', { ...fixture(), date: '2026-01-04' });
  assert.equal((await request({ path: '/api/state' })).json.lastNight.date, '2026-01-04');
});

test('a report with no finish time is running while the lock exists, and interrupted when it does not', async () => {
  const { request, store } = await start({ now: at(5, 2, 30) });
  store.write('reports/2026-01-05.json', { ...fixture(), finishedAt: null });
  store.write('run.lock', { pid: 1 });
  assert.equal((await request({ path: '/api/state' })).json.lastNight.state, 'running');
  store.remove('run.lock');
  assert.deepEqual((await request({ path: '/api/state' })).json.lastNight, {
    date: '2026-01-05', state: 'stopped', reason: 'The run was interrupted before it finished.',
  });
});

test('a failed run carries its reason', async () => {
  const { request, store } = await start({ now: at(5, 6) });
  store.write('reports/2026-01-05.json', { ...fixture(), outcome: 'failed', reason: 'GitHub sign-in has expired', entries: [] });
  assert.deepEqual((await request({ path: '/api/state' })).json.lastNight, {
    date: '2026-01-05', state: 'failed', reason: 'GitHub sign-in has expired',
  });
});

test('GET /api/reports/:date returns the report with counts', async () => {
  const { request, store } = await start();
  store.write('reports/2026-01-05.json', fixture());
  const { status, json } = await request({ path: '/api/reports/2026-01-05' });
  assert.equal(status, 200);
  assert.deepEqual(json.counts, { found: 2, proposed: 2, did: 2, rolledBack: 1 });
  assert.equal(json.entries.length, 6);
});

test('GET /api/reports/:date is 404 for an unknown or malformed date', async () => {
  const { request, store } = await start();
  store.write('projects.json', []);
  for (const path of ['/api/reports/2026-01-09', '/api/reports/..%2Fprojects', '/api/reports/projects', '/api/reports/']) {
    assert.equal((await request({ path })).status, 404, path);
  }
});

test('POST /api/projects adds a project: 201 the first time, 200 after', async () => {
  const { post } = await start();
  const first = await post('https://github.com/octo/app');
  assert.equal(first.status, 201);
  assert.deepEqual([first.json.owner, first.json.repo, first.json.status], ['octo', 'app', 'healthy']);
  const second = await post('octo/app');
  assert.equal(second.status, 200);
  assert.equal(second.json.addedAt, first.json.addedAt);
});

test('POST /api/projects answers 400 with the plain reason', async () => {
  const { post, request, json } = await start();
  const bad = await post('not a link');
  assert.deepEqual([bad.status, bad.json], [400, { error: "That isn't a GitHub repository link." }]);
  const gone = await post('octo/gone');
  assert.deepEqual([gone.status, gone.json], [400, { error: "That repository doesn't exist or you can't see it." }]);
  for (const body of ['{ nope', '[]', '{}', '{"link": 5}']) {
    const res = await request({ method: 'POST', path: '/api/projects', headers: json, body });
    assert.deepEqual([res.status, res.json], [400, { error: "That isn't a GitHub repository link." }], body);
  }
});

test('POST /api/projects answers 502 when GitHub cannot be reached', async () => {
  const github = { getRepo: async () => { throw new Error('GitHub could not be reached: timeout'); }, listNightshiftPrs: async () => [] };
  const { post } = await start({ github });
  const res = await post('octo/app');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: "GitHub couldn't be reached. Try again in a minute." });
});

test('POST /api/projects refuses a body that is too large', async () => {
  const { request, json } = await start();
  const res = await request({ method: 'POST', path: '/api/projects', headers: json, body: JSON.stringify({ link: 'x'.repeat(20000) }) });
  assert.equal(res.status, 413);
});

test('changes are refused with 403 unless they are JSON from this site', async () => {
  const { post, del, host, request } = await start();
  const cases = {
    'no content type': { origin: `http://${host}` },
    'form content type': { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${host}` },
    'text content type': { 'content-type': 'text/plain', origin: `http://${host}` },
    'no origin': { 'content-type': 'application/json' },
    'another origin': { 'content-type': 'application/json', origin: 'https://evil.example' },
    'null origin': { 'content-type': 'application/json', origin: 'null' },
    'same host name on another port': { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' },
  };
  for (const [name, headers] of Object.entries(cases)) {
    assert.equal((await post('octo/app', headers)).status, 403, `POST with ${name}`);
    assert.equal((await del('/api/projects/octo/app', headers)).status, 403, `DELETE with ${name}`);
  }
  assert.deepEqual((await request({ path: '/api/state' })).json.projects, []);
});

test('an origin that matches x-forwarded-host is accepted', async () => {
  const { post } = await start();
  const res = await post('octo/app', {
    'content-type': 'application/json; charset=utf-8',
    origin: 'https://app-nightshift.example.com',
    'x-forwarded-host': 'app-nightshift.example.com',
  });
  assert.equal(res.status, 201);
});

test('DELETE /api/projects/:owner/:repo removes the project and lists its open pull requests', async () => {
  const { post, del, request } = await start();
  await post('octo/app');
  const res = await del('/api/projects/octo/app');
  assert.deepEqual([res.status, res.json], [200, { removed: true, openPrs: ['https://github.com/octo/app/pull/3'] }]);
  assert.deepEqual((await request({ path: '/api/state' })).json.projects, []);
});

test('DELETE is 404 for a project that is not listed or a path that is not a project', async () => {
  const { del } = await start();
  for (const path of ['/api/projects/octo/app', '/api/projects/octo', '/api/projects/octo/app/extra', '/api/projects/..%2F..%2Fx/app']) {
    assert.equal((await del(path)).status, 404, path);
  }
});

test('the page and its two files are served with safe headers', async () => {
  const { request } = await start();
  const page = await request({ path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.text, /<title>Nightshift<\/title>/);
  assert.match((await request({ path: '/app.js' })).headers['content-type'], /javascript/);
  assert.match((await request({ path: '/styles.css' })).headers['content-type'], /^text\/css/);
  assert.equal((await request({ path: '/?x=1' })).status, 200);
  const icon = await request({ path: '/favicon.svg' });
  assert.deepEqual([icon.status, icon.headers['content-type']], [200, 'image/svg+xml']);
  assert.match(page.text, /<link rel="icon" href="\/favicon\.svg"/);
});

test('the page has no inline scripts or styles', async () => {
  const { request } = await start();
  const { text } = await request({ path: '/' });
  assert.doesNotMatch(text, /<style/i);
  assert.doesNotMatch(text, /\sstyle=/i);
  assert.doesNotMatch(text, /\son[a-z]+=/i);
  for (const tag of text.match(/<script[^>]*>/gi) ?? []) assert.match(tag, /\ssrc="\/app\.js"/);
});

test('nothing outside the three static files is served', async () => {
  const { request } = await start();
  for (const path of ['/../package.json', '/package.json', '/src/server.mjs', '/%2e%2e/package.json', '/..%2fpackage.json',
    '/index.html/../../package.json', '/app.js/', '//app.js', '/styles.css%00', '/api/nope']) {
    assert.equal((await request({ path })).status, 404, path);
  }
});

test('other methods are refused', async () => {
  const { request, json } = await start();
  assert.equal((await request({ method: 'PUT', path: '/api/projects', headers: json, body: '{}' })).status, 405);
  assert.equal((await request({ method: 'POST', path: '/health', headers: json, body: '{}' })).status, 405);
});

test('an unexpected failure is a 500 with no detail', async () => {
  const projects = { list: () => { throw new Error('secret path /private/x'); } };
  const { request } = await start({ projects });
  const res = await request({ path: '/api/state' });
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'Something went wrong.' });
});

test('with a host allow-list, requests for any other host are refused', async () => {
  const { request, host } = await start({ allowedHosts: ['app.example.com'] });
  assert.equal((await request({ path: '/api/state', headers: { host } })).status, 403);
  assert.equal((await request({ path: '/', headers: { host: 'rebound.evil.example' } })).status, 403);
  assert.equal((await request({ path: '/api/state', headers: { host: 'app.example.com' } })).status, 200);
  assert.equal((await request({ path: '/api/state', headers: { host: 'APP.example.com' } })).status, 200);
  const spoofed = { host: 'rebound.evil.example', 'x-forwarded-host': 'app.example.com' };
  assert.equal((await request({ path: '/api/state', headers: spoofed })).status, 403);
  const forwardedElsewhere = { host: 'app.example.com', 'x-forwarded-host': 'rebound.evil.example' };
  assert.equal((await request({ path: '/api/state', headers: forwardedElsewhere })).status, 403);
});

test('with a host allow-list, changes need an origin on the list', async () => {
  const { post } = await start({ allowedHosts: ['app.example.com'] });
  const base = { host: 'app.example.com', 'content-type': 'application/json' };
  assert.equal((await post('octo/app', { ...base, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('octo/app', { ...base })).status, 403);
  assert.equal((await post('octo/app', { ...base, origin: 'https://app.example.com' })).status, 201);
});
