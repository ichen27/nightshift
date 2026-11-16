// The nightly report: its shape, its counts and how it is written out.

export function countEntries(report) {
  const counts = { found: 0, proposed: 0, did: 0, rolledBack: 0 };
  for (const entry of report.entries ?? []) {
    if (entry.tag === 'found') counts.found += 1;
    else if (entry.tag === 'proposed') counts.proposed += 1;
    else if (entry.tag === 'did') counts.did += 1;
    if (entry.liveState === 'rolled-back') counts.rolledBack += 1;
  }
  return counts;
}

export function newReport(date, startedAt) {
  return {
    date,
    startedAt,
    finishedAt: null,
    model: null,
    outcome: 'ok',
    reason: null,
    entries: [],
    needsYou: [],
  };
}

export function saveReport(store, report) {
  store.write(`reports/${report.date}.json`, report);
}

const TAG_WORDS = { found: 'Found', proposed: 'Proposed', did: 'Did' };
const LIVE_WORDS = {
  running: 'running and healthy',
  'merged-not-running': 'merged, not yet running',
  'rolled-back': 'rolled back',
  'not-applicable': 'merged; nothing to deploy',
};

// Report text comes from a model that has read other people's repositories, so it is kept
// on one line and cannot introduce HTML or new markdown blocks.
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').replace(/</g, '&lt;').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function heading(date) {
  const [year, month, day] = date.split('-').map(Number);
  const when = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return `# Nightshift report · ${when}`;
}

function impactLine(impact) {
  const parts = [];
  for (const m of impact?.measured ?? []) parts.push(`${clean(m.name)} ${clean(m.before)} → ${clean(m.after)}.`);
  for (const claim of impact?.claims ?? []) parts.push(`Claimed: ${clean(claim)}`);
  return parts.length ? `Impact: ${parts.join(' ')}` : null;
}

function entryLines(entry) {
  const tag = TAG_WORDS[entry.tag] ?? clean(entry.tag);
  const lines = [`- **${tag}**${entry.security ? ' (private)' : ''} · ${clean(entry.title)}`];
  if (entry.detail) lines.push(`  - ${clean(entry.detail)}`);
  if (entry.reason) lines.push(`  - Not merged: ${clean(entry.reason)}.`);
  const impact = impactLine(entry.impact);
  if (impact) lines.push(`  - ${impact}`);
  if (LIVE_WORDS[entry.liveState]) lines.push(`  - Live: ${LIVE_WORDS[entry.liveState]}.`);
  if (entry.prUrl) lines.push(`  - Pull request: ${clean(entry.prUrl)}`);
  return lines;
}

export function renderMarkdown(report) {
  const counts = countEntries(report);
  const entries = report.entries ?? [];
  const projects = [...new Set(entries.map((entry) => entry.project))];
  const lines = ['---', `created: ${report.date}`, 'topics: [nightshift, report]', `outcome: ${report.outcome}`, '---', '', heading(report.date), ''];

  if (report.outcome === 'failed') {
    lines.push(`The run failed: ${clean(report.reason) || 'no reason was recorded'}.`, '');
  } else {
    if (report.outcome === 'stopped') {
      lines.push(`The run stopped early: ${clean(report.reason) || 'no reason was recorded'}.`, '');
    }
    lines.push(
      `Visited ${plural(projects.length, 'project', 'projects')}: ${plural(counts.did, 'change made', 'changes made')}, ` +
        `${counts.proposed} proposed, ${counts.found} found, ${counts.rolledBack} rolled back.`,
      '',
      '| Found | Proposed | Did | Rolled back |',
      '|---|---|---|---|',
      `| ${counts.found} | ${counts.proposed} | ${counts.did} | ${counts.rolledBack} |`,
      '',
    );
    if (report.model) lines.push(`Model: ${clean(report.model)}`, '');
    if (entries.length) {
      lines.push('## Entries', '');
      for (const project of projects) {
        lines.push(`### ${clean(project)}`, '');
        for (const entry of entries.filter((e) => e.project === project)) lines.push(...entryLines(entry));
        lines.push('');
      }
    }
  }
  if (report.needsYou?.length) {
    lines.push('## Needs you', '', ...report.needsYou.map((item) => `- ${clean(item)}`), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// Writes the night's note into the vault. Never throws: a vault problem must not stop the run.
export function writeVaultNote(report, vaultDir, fs) {
  if (!vaultDir) return { written: false, reason: 'No vault folder is set.', path: null };
  try {
    if (!fs.existsSync(vaultDir)) return { written: false, reason: 'The vault folder does not exist.', path: null };
    const dir = `${vaultDir.replace(/\/+$/, '')}/my-knowledge-base/raw/nightshift`;
    const path = `${dir}/${report.date}.md`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, renderMarkdown(report));
    return { written: true, reason: null, path };
  } catch (error) {
    return { written: false, reason: error.message, path: null };
  }
}
