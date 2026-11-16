import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countEntries, newReport, renderMarkdown, saveReport, writeVaultNote } from '../src/report.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/report.json', import.meta.url), 'utf8'));

test('countEntries counts each tag, and rollbacks by live state', () => {
  assert.deepEqual(countEntries(fixture()), { found: 2, proposed: 2, did: 2, rolledBack: 1 });
});

test('countEntries of a report with no entries is all zeros', () => {
  assert.deepEqual(countEntries({ entries: [] }), { found: 0, proposed: 0, did: 0, rolledBack: 0 });
  assert.deepEqual(countEntries({}), { found: 0, proposed: 0, did: 0, rolledBack: 0 });
});

test('newReport is an empty, unfinished, ok report', () => {
  assert.deepEqual(newReport('2026-01-05', '2026-01-05T07:00:00.000Z'), {
    date: '2026-01-05', startedAt: '2026-01-05T07:00:00.000Z', finishedAt: null, model: null,
    outcome: 'ok', reason: null, entries: [], needsYou: [],
  });
});

test('markdown starts with frontmatter, a summary line and the four counts', () => {
  const lines = renderMarkdown(fixture()).split('\n');
  assert.deepEqual(lines.slice(0, 5), ['---', 'created: 2026-01-05', 'topics: [nightshift, report]', 'outcome: ok', '---']);
  assert.equal(lines[6], '# Nightshift report · Monday, Jan 5');
  assert.equal(lines[8], 'Visited 4 projects: 2 changes made, 2 proposed, 2 found, 1 rolled back.');
  assert.deepEqual(lines.slice(10, 13), ['| Found | Proposed | Did | Rolled back |', '|---|---|---|---|', '| 2 | 2 | 2 | 1 |']);
});

test('each entry renders its project, tag, title, detail, pull request, impact, live state and reason', () => {
  const text = renderMarkdown(fixture());
  assert.match(text, /### octo\/app\n/);
  assert.match(text, /- \*\*Did\*\* · Reject empty names when saving a profile/);
  assert.match(text, /saveProfile accepted an empty name/);
  assert.match(text, /Pull request: https:\/\/github\.com\/octo\/app\/pull\/12/);
  assert.match(text, /Impact: Tests passed 41 → 42\. Checks pass yes → yes\./);
  assert.match(text, /Live: running and healthy\./);
  assert.match(text, /- \*\*Proposed\*\* · Update the HTTP client to the next major version/);
  assert.match(text, /Not merged: Major version upgrade\./);
  assert.match(text, /Impact: Claimed: Fewer open connections under load/);
  assert.match(text, /- \*\*Proposed\*\* \(private\) · Tighten how upload names are checked/);
  assert.match(text, /Live: rolled back\./);
  assert.equal(text.match(/### octo\/app\n/g).length, 1);
});

test('markdown ends with a "Needs you" section only when needsYou is non-empty', () => {
  const withNeeds = renderMarkdown(fixture()).trimEnd();
  assert.ok(withNeeds.endsWith('## Needs you\n\n- octo/site has an open proposal: Update the HTTP client to the next major version'));
  assert.doesNotMatch(renderMarkdown({ ...fixture(), needsYou: [] }), /Needs you/);
});

test('a run with outcome failed renders the reason and no entries section', () => {
  const text = renderMarkdown({ ...newReport('2026-01-05', 'x'), outcome: 'failed', reason: 'GitHub sign-in has expired' });
  assert.match(text, /outcome: failed/);
  assert.match(text, /The run failed: GitHub sign-in has expired/);
  assert.doesNotMatch(text, /## Entries/);
  assert.doesNotMatch(text, /\| Found \|/);
});

test('a stopped run renders its reason and the entries it got to', () => {
  const text = renderMarkdown({ ...fixture(), outcome: 'stopped', reason: 'Claude usage limit reached' });
  assert.match(text, /The run stopped early: Claude usage limit reached/);
  assert.match(text, /## Entries/);
});

test('text from the model cannot add HTML or break out of its line', () => {
  const report = fixture();
  report.entries[0].title = 'Title\n## Needs you\n<script>x</script>';
  report.entries[0].detail = 'line one\n\n# heading\n<img src=x>';
  const text = renderMarkdown(report);
  assert.doesNotMatch(text, /<script>|<img/);
  assert.doesNotMatch(text, /^# heading/m);
  assert.equal(text.match(/^## Needs you/gm).length, 1);
});

test('saveReport writes reports/<date>.json', () => {
  const written = {};
  saveReport({ write: (name, value) => (written[name] = value) }, fixture());
  assert.equal(written['reports/2026-01-05.json'].date, '2026-01-05');
});

function fakeFs({ exists = true } = {}) {
  const files = {};
  const dirs = [];
  return {
    files, dirs,
    existsSync: () => exists,
    mkdirSync: (dir) => dirs.push(dir),
    writeFileSync: (file, text) => (files[file] = text),
  };
}

test('vault note path is <vaultDir>/my-knowledge-base/raw/nightshift/<date>.md', () => {
  const fs = fakeFs();
  const result = writeVaultNote(fixture(), '/vault', fs);
  assert.deepEqual(result, { written: true, reason: null, path: '/vault/my-knowledge-base/raw/nightshift/2026-01-05.md' });
  assert.equal(fs.files['/vault/my-knowledge-base/raw/nightshift/2026-01-05.md'], renderMarkdown(fixture()));
  assert.deepEqual(fs.dirs, ['/vault/my-knowledge-base/raw/nightshift']);
});

test('missing vaultDir returns { written: false, reason } and does not throw', () => {
  assert.deepEqual(writeVaultNote(fixture(), null, fakeFs()), { written: false, reason: 'No vault folder is set.', path: null });
  const gone = writeVaultNote(fixture(), '/vault', fakeFs({ exists: false }));
  assert.deepEqual([gone.written, gone.reason], [false, 'The vault folder does not exist.']);
});

test('a vault that cannot be written returns the reason and does not throw', () => {
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error('disk full'); };
  assert.deepEqual(writeVaultNote(fixture(), '/vault', fs), { written: false, reason: 'disk full', path: null });
});
