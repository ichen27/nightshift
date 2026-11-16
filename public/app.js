// The Nightshift page. All content is set as text, never as HTML, because report
// entries are written by a model that has read other people's repositories.
'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function trashIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3');
  svg.append(path);
  return svg;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.method ? { 'content-type': 'application/json' } : {},
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // No JSON body.
  }
  return { ok: response.ok, status: response.status, body };
}

// 'YYYY-MM-DD' is a calendar date, so it is formatted without a time zone shift.
function calendarDate(date, options) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}
const longDate = (date) => calendarDate(date, { weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function nextRunText(nextRunAt) {
  if (!nextRunAt) return 'The nightly schedule is off';
  const next = new Date(nextRunAt);
  const time = next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const hoursAway = (next - Date.now()) / 3600000;
  if (hoursAway <= 24) return `Next run tonight, ${time}`;
  return `Next run ${next.toLocaleDateString('en-US', { weekday: 'long' })}, ${time}`;
}

const LIVE_WORDS = {
  running: 'Live: running and healthy.',
  'merged-not-running': 'Live: merged, not yet running.',
  'rolled-back': 'Live: rolled back.',
  'not-applicable': 'Live: merged; nothing to deploy.',
};
const TAGS = {
  found: ['Found', ''],
  proposed: ['Proposed', 'warn'],
  did: ['Did', 'good'],
};
const RUN_PROBLEMS = {
  failed: 'The run failed.',
  stopped: 'The run stopped early.',
  missing: 'The run did not happen.',
};

let state = null;
let shownDate = null;
let refreshTimer = null;

function githubLink(url, text) {
  // Only real GitHub links become links.
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) return null;
  return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: text ?? url });
}

function renderProjects() {
  const list = $('projects');
  $('projects-heading').textContent = `Projects (${state.projects.length})`;
  list.replaceChildren();
  if (state.projects.length === 0) {
    list.append(el('li', { class: 'empty', text: 'No projects yet. Paste a GitHub repository link above to add one.' }));
    return;
  }
  for (const project of state.projects) {
    const name = `${project.owner}/${project.repo}`;
    const visit = project.lastVisitAt
      ? `Last visit ${shortDay(project.lastVisitAt)}${project.lastResult ? ` · ${project.lastResult}` : ''}`
      : 'Not visited yet';
    const needsYou = project.status === 'needs-you';
    const remove = el('button', { type: 'button', class: 'remove', 'aria-label': `Remove ${name}`, title: `Remove ${name}` }, trashIcon());
    remove.addEventListener('click', () => removeProject(project, remove));
    list.append(
      el('li', { class: 'project' },
        el('div', { class: 'who' }, el('div', { class: 'name', text: name }), el('div', { class: 'visit', text: visit })),
        el('span', { class: `pill ${needsYou ? 'warn' : 'good'}`, text: needsYou ? 'Needs you' : 'Healthy' }),
        remove),
    );
  }
}

function impactText(impact) {
  const parts = [];
  for (const m of impact?.measured ?? []) parts.push(`${m.name} ${m.before} → ${m.after}.`);
  for (const claim of impact?.claims ?? []) parts.push(`Claimed: ${claim}`);
  return parts.length ? `Impact: ${parts.join(' ')}` : null;
}

function renderEntry(entry) {
  const [tagText, tagClass] = TAGS[entry.tag] ?? [entry.tag, ''];
  const impact = impactText(entry.impact);
  const prNumber = /\/pull\/(\d+)$/.exec(entry.prUrl ?? '');
  const link = githubLink(entry.prUrl, prNumber ? `Pull request #${prNumber[1]}` : 'Pull request');
  return el('li', { class: 'entry' },
    el('div', { class: 'head' },
      el('span', { class: `pill ${tagClass}`, text: tagText }),
      entry.security && el('span', { class: 'pill bad', text: 'Private' }),
      el('span', { class: 'title', text: `${entry.project} · ${entry.title}` })),
    entry.detail && el('p', { class: 'detail', text: entry.detail }),
    entry.reason && el('p', { class: 'reason', text: `Not merged: ${entry.reason}.` }),
    impact && el('p', { class: 'impact', text: impact }),
    LIVE_WORDS[entry.liveState] && el('p', { class: 'live', text: LIVE_WORDS[entry.liveState] }),
    link && el('p', {}, link));
}

function showRunStatus(strong, text, problem) {
  const box = $('run-status');
  box.className = problem ? 'notice problem' : 'notice';
  box.replaceChildren(el('strong', { text: strong }), text ? document.createTextNode(text) : '');
  box.hidden = false;
}

async function renderReport(date) {
  const last = state.lastNight;
  shownDate = date;
  $('run-status').hidden = true;
  $('counts').hidden = true;
  $('needs-you').hidden = true;
  $('entries').replaceChildren();
  $('entries').hidden = true;
  $('report-heading').textContent = date ? `Report · ${longDate(date)}` : 'Report';

  const isLast = date === last.date;
  if (isLast && RUN_PROBLEMS[last.state]) showRunStatus(RUN_PROBLEMS[last.state], last.reason, true);
  if (isLast && last.state === 'running') showRunStatus('Running now', 'This report fills in as each project finishes.', false);
  if (!date) {
    showRunStatus('No reports yet', 'The first one appears after the first nightly run.', false);
    return;
  }
  if (!state.reportDates.includes(date)) return;

  const { ok, body: report } = await api(`/api/reports/${date}`);
  if (shownDate !== date) return;
  if (!ok) {
    showRunStatus('This report could not be loaded.', null, true);
    return;
  }
  if (!isLast && report.outcome !== 'ok') showRunStatus(RUN_PROBLEMS[report.outcome] ?? 'The run did not finish.', report.reason, true);

  $('count-found').textContent = report.counts.found;
  $('count-proposed').textContent = report.counts.proposed;
  $('count-did').textContent = report.counts.did;
  $('count-rolled-back').textContent = report.counts.rolledBack;
  $('counts').hidden = false;

  if (report.needsYou?.length) {
    $('needs-you-list').replaceChildren(...report.needsYou.map((text) => el('li', { text })));
    $('needs-you').hidden = false;
  }
  if (report.entries.length) {
    $('entries').replaceChildren(...report.entries.map(renderEntry));
    $('entries').hidden = false;
  }
  if (report.model) {
    $('entries').append(el('li', { class: 'empty', text: `Model: ${report.model}` }));
    $('entries').hidden = false;
  }
}

function renderEarlier() {
  const select = $('earlier');
  select.replaceChildren(el('option', { value: '', text: 'Earlier reports' }));
  for (const date of state.reportDates) select.append(el('option', { value: date, text: longDate(date) }));
  select.value = '';
  select.hidden = state.reportDates.length < 2;
}

async function load({ keepDate = false } = {}) {
  const { ok, body } = await api('/api/state');
  if (!ok) {
    showRunStatus('Nightshift could not load.', 'Reload the page to try again.', true);
    return;
  }
  state = body;
  $('next-run').textContent = nextRunText(state.nextRunAt);
  renderProjects();
  renderEarlier();
  const stillThere = keepDate && shownDate && state.reportDates.includes(shownDate);
  await renderReport(stillThere ? shownDate : state.lastNight.date);
  clearTimeout(refreshTimer);
  if (state.lastNight.state === 'running') refreshTimer = setTimeout(() => load({ keepDate: true }), 30000);
}

function showAddMessage(text) {
  $('add-message').textContent = text ?? '';
  $('add-message').hidden = !text;
}

async function addProject(event) {
  event.preventDefault();
  const input = $('link');
  const link = input.value.trim();
  if (!link) {
    showAddMessage('Paste a GitHub repository link first.');
    return;
  }
  showAddMessage(null);
  $('notice').hidden = true;
  $('add-button').disabled = true;
  try {
    const { ok, body } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ link }) });
    if (!ok) {
      showAddMessage(body?.error ?? 'That did not work. Try again.');
      return;
    }
    input.value = '';
    await load({ keepDate: true });
  } catch {
    showAddMessage('Nightshift could not be reached. Try again.');
  } finally {
    $('add-button').disabled = false;
  }
}

async function removeProject(project, button) {
  const name = `${project.owner}/${project.repo}`;
  if (!window.confirm(`Remove ${name} from Nightshift? Its past reports stay.`)) return;
  button.disabled = true;
  const path = `/api/projects/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}`;
  const { ok, body } = await api(path, { method: 'DELETE' });
  const notice = $('notice');
  if (!ok) {
    notice.className = 'notice problem';
    notice.replaceChildren(el('strong', { text: `${name} could not be removed.` }));
  } else {
    notice.className = 'notice';
    notice.replaceChildren(el('strong', { text: `Removed ${name}.` }));
    if (body.openPrs === null) notice.append(el('span', { text: ' Its open pull requests could not be checked.' }));
    else if (body.openPrs.length) {
      notice.append(el('span', { text: ' Nightshift left these pull requests open:' }));
      for (const url of body.openPrs) notice.append(githubLink(url) ?? el('span', { text: url }));
    }
  }
  notice.hidden = false;
  await load({ keepDate: true });
}

$('add-form').addEventListener('submit', addProject);
$('earlier').addEventListener('change', (event) => {
  const date = event.target.value;
  event.target.value = '';
  if (date) renderReport(date);
});
load();
