// The web app: a small JSON API over the project list and reports, plus one static page.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { isProcessAlive } from './lock.mjs';
import { ProjectError } from './projects.mjs';
import { LinkError } from './repo-link.mjs';
import { countEntries } from './report.mjs';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
const MAX_BODY_BYTES = 8 * 1024;
const MISSING_AFTER_MS = 3 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The scheduled times on either side of `now`, in the machine's local time.
function scheduleTimes(now, { hour, minute }) {
  const on = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute);
  const today = on(0);
  return today <= now ? { previous: today, next: on(1) } : { previous: on(-1), next: today };
}

function readSchedule(store) {
  const saved = store.read('schedule.json', null);
  const valid =
    saved && Number.isInteger(saved.hour) && saved.hour >= 0 && saved.hour <= 23 &&
    Number.isInteger(saved.minute) && saved.minute >= 0 && saved.minute <= 59;
  return valid ? { hour: saved.hour, minute: saved.minute } : null;
}

export function createServer({ projects, store, now = () => new Date(), allowedHosts = null, isAlive = isProcessAlive }) {
  const allowed = allowedHosts ? new Set(allowedHosts.map((host) => host.toLowerCase())) : null;

  const reportDates = () =>
    store
      .list('reports')
      .map((name) => name.replace(/\.json$/, ''))
      .filter((name) => DATE.test(name))
      .sort()
      .reverse();

  function lastNight(dates, schedule, time) {
    const newest = dates[0] ?? null;
    if (schedule) {
      const { previous } = scheduleTimes(time, schedule);
      const expected = localDate(previous);
      if ((!newest || newest < expected) && time - previous > MISSING_AFTER_MS) {
        return {
          date: expected,
          state: 'missing',
          reason: 'The nightly run did not run. The computer may have been asleep, offline or signed out.',
        };
      }
    }
    if (!newest) return { date: null, state: 'none', reason: null };
    const report = store.read(`reports/${newest}.json`, null) ?? {};
    if (!report.finishedAt) {
      const lock = store.read('run.lock', null);
      if (lock && isAlive(lock.pid)) return { date: newest, state: 'running', reason: null };
      return { date: newest, state: 'stopped', reason: 'The run was interrupted before it finished.' };
    }
    return { date: newest, state: report.outcome ?? 'ok', reason: report.reason ?? null };
  }

  function state() {
    const time = now();
    const schedule = readSchedule(store);
    const dates = reportDates();
    return {
      projects: projects.list(),
      nextRunAt: schedule ? scheduleTimes(time, schedule).next.toISOString() : null,
      reportDates: dates,
      lastNight: lastNight(dates, schedule, time),
    };
  }

  function hostAllowed(req) {
    if (!allowed) return true;
    const host = String(req.headers.host || '').toLowerCase();
    const forwarded = req.headers['x-forwarded-host'];
    if (!allowed.has(host)) return false;
    return forwarded === undefined || allowed.has(String(forwarded).toLowerCase());
  }

  // A change must come from this site's own page: JSON, with an Origin that is ours.
  function changeAllowed(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return false;
    let originHost;
    try {
      originHost = new URL(req.headers.origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (allowed) return allowed.has(originHost);
    const ownHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase();
    return ownHost !== '' && originHost === ownHost;
  }

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    });
    res.end(text);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    }
    if (size > MAX_BODY_BYTES) return { tooLarge: true };
    try {
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { value: null };
    }
  }

  async function addProject(req, res) {
    const body = await readJson(req);
    if (body.tooLarge) return send(res, 413, { error: 'That request is too large.' });
    try {
      const { project, created } = await projects.add(body.value?.link);
      return send(res, created ? 201 : 200, project);
    } catch (error) {
      if (error instanceof LinkError || error instanceof ProjectError) {
        return send(res, 400, { error: error.message });
      }
      return send(res, 502, { error: "GitHub couldn't be reached. Try again in a minute." });
    }
  }

  async function removeProject(res, owner, repo) {
    const result = await projects.remove(owner, repo);
    if (!result.removed) return send(res, 404, { error: 'That project is not on the list.' });
    return send(res, 200, result);
  }

  // Path segments of an /api/projects/<owner>/<repo> request, or null.
  function projectPath(segments) {
    if (segments.length !== 5) return null;
    let owner;
    let repo;
    try {
      owner = decodeURIComponent(segments[3]);
      repo = decodeURIComponent(segments[4]);
    } catch {
      return null;
    }
    return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..' ? { owner, repo } : null;
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) return send(res, 403, { error: 'Not allowed.' });
    const path = String(req.url).split('?')[0];
    const segments = path.split('/');
    const method = req.method;
    const read = method === 'GET' || method === 'HEAD';

    if (STATIC[path]) {
      if (!read) return send(res, 405, { error: 'Method not allowed.' });
      const [file, type] = STATIC[path];
      return send(res, 200, await readFile(new URL(file, PUBLIC_DIR)), { 'content-type': type });
    }
    if (path === '/health') {
      return read ? send(res, 200, { ok: true }) : send(res, 405, { error: 'Method not allowed.' });
    }
    if (path === '/api/state') {
      return read ? send(res, 200, state()) : send(res, 405, { error: 'Method not allowed.' });
    }
    if (segments.length === 4 && path.startsWith('/api/reports/')) {
      if (!read) return send(res, 405, { error: 'Method not allowed.' });
      const date = segments[3];
      const report = DATE.test(date) ? store.read(`reports/${date}.json`, null) : null;
      if (!report) return send(res, 404, { error: 'There is no report for that date.' });
      return send(res, 200, { ...report, counts: countEntries(report) });
    }
    if (path === '/api/projects') {
      if (method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
      if (!changeAllowed(req)) return send(res, 403, { error: 'Not allowed.' });
      return addProject(req, res);
    }
    if (path.startsWith('/api/projects/')) {
      const target = projectPath(segments);
      if (!target) return send(res, 404, { error: 'Not found.' });
      if (method !== 'DELETE') return send(res, 405, { error: 'Method not allowed.' });
      if (!changeAllowed(req)) return send(res, 403, { error: 'Not allowed.' });
      return removeProject(res, target.owner, target.repo);
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`Request failed: ${req.method} ${String(req.url).split('?')[0]}: ${error.message}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: 'Something went wrong.' });
    });
  });
}
