// One night: check the run can start, take the lock, visit the chosen projects one at a
// time, and write the report after each. Every step that reaches outside this file comes in
// through `deps`, so the whole flow can be exercised with fakes.
import { join } from 'node:path';
import { buildAgentCall, renderBrief, runAgent } from './agent.mjs';
import { pickMergeMethod } from './github.mjs';
import { goLive } from './golive.mjs';
import { acquireLock } from './lock.mjs';
import { diffMeasures, measure } from './measure.mjs';
import { projectKey } from './projects.mjs';
import { newReport, saveReport, writeVaultNote } from './report.mjs';
import { pickProjects } from './rotation.mjs';
import { changeStats, decide, provesItself, readManifests } from './rules.mjs';
import { importChange, prepareWorkspace, resetTree } from './workspace.mjs';

const PROJECT_LIMIT_MS = 45 * 60 * 1000;
const AGENT_LIMIT_MS = 30 * 60 * 1000;
const CHECK_LIMIT_MS = 15 * 60 * 1000;
const PR_CHECKS_LIMIT_MS = 30 * 60 * 1000;
const EARLIER_PR_CHECKS_LIMIT_MS = 10 * 60 * 1000;
const MAX_OPEN_PRS = 3;
const MAX_REMEMBERED_TITLES = 400;
const STOP_THE_NIGHT = ['Claude usage limit reached', 'Claude is not signed in'];
const NAMES_A_TOOL = /claude|anthropic|chatgpt|openai|copilot|codex|gemini|co-authored-by|generated (with|by)|\bAI\b/i;

export class RunInProgress extends Error {
  constructor() {
    super('A Nightshift run is already in progress.');
    this.name = 'RunInProgress';
  }
}

// The real implementations of the steps a visit is made of.
export const realSteps = {
  prepareWorkspace, resetTree, importChange, measure, runAgent, changeStats, readManifests, provesItself, goLive,
};

const fold = (title) => String(title).toLowerCase().replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function entry(project, tag, title, detail, extra = {}) {
  return {
    project, tag, title, detail,
    prUrl: null, security: false, reason: null,
    impact: { measured: [], claims: [] },
    liveState: null,
    ...extra,
  };
}

function prBody(summary, measured) {
  if (measured.length === 0) return `${summary}\n\nNo measurable difference in checks, test counts or known-vulnerable dependencies.`;
  return `${summary}\n\nMeasured before and after:\n${measured.map((m) => `- ${m.name}: ${m.before} → ${m.after}`).join('\n')}`;
}

function lastResultOf(entries) {
  const did = entries.filter((e) => e.tag === 'did');
  if (did.length) {
    const n = plural(did.length, 'change', 'changes');
    if (did.some((e) => e.liveState === 'rolled-back')) return `${n} rolled back`;
    if (did.some((e) => e.liveState === 'merged-not-running')) return `${n} merged, not yet running`;
    if (did.some((e) => e.liveState === 'running')) return `${n} merged and running`;
    return `${n} merged`;
  }
  if (entries.some((e) => e.title === 'Inspection did not finish' || e.title === 'Visit did not finish')) return 'Inspection did not finish';
  const proposed = entries.filter((e) => e.tag === 'proposed').length;
  if (proposed) return `${proposed} proposed`;
  const found = entries.filter((e) => e.tag === 'found' && e.title !== 'Nothing worth changing tonight').length;
  return found ? `${found} found` : 'Nothing worth changing';
}

// Returns { entries, needsYou, lastResult, status, model, stop }.
export async function visitProject({ project, deps, date, dryRun }) {
  const { store, github, settings, steps, run, restrictedRun, fs, gitPath } = deps;
  const name = `${project.owner}/${project.repo}`;
  const entries = [];
  const needsYou = [];
  let needsPerson = false;
  let model = null;
  let stop = null;
  const started = deps.now().getTime();
  const left = (limit) => Math.max(1000, Math.min(limit, started + PROJECT_LIMIT_MS - deps.now().getTime()));
  const outOfTime = () => deps.now().getTime() - started >= PROJECT_LIMIT_MS;
  const finish = () => ({
    entries, needsYou, model, stop,
    lastResult: lastResultOf(entries),
    status: needsPerson || needsYou.length > 0 ? 'needs-you' : 'healthy',
  });

  // 1. Is the repository still there, and can we still write to it?
  const repo = await github.getRepo(project.owner, project.repo);
  if (!repo.exists || repo.archived || !repo.canPush) {
    const why = !repo.exists ? 'It no longer exists or can no longer be seen.' : repo.archived ? 'It has been archived.' : 'Write access to it has been removed.';
    entries.push(entry(name, 'found', "Can't reach this repository", why));
    needsPerson = true;
    return finish();
  }
  const current = { ...project, defaultBranch: repo.defaultBranch, isPublic: repo.isPublic };
  const base = current.defaultBranch;
  const method = pickMergeMethod(repo.mergeMethods);
  const admin = (settings.adminMerge ?? []).some((listed) => sameName(listed, name));
  const liveDeps = {
    run, gitPath, nodePath: deps.nodePath, github, fetch: deps.fetch, sleep: deps.sleep,
    now: () => deps.now().getTime(), readRegistry: deps.readRegistry,
  };
  const putLive = (mergeSha, repoDir) =>
    steps.goLive({ project: current, mergeSha, settings, deps: liveDeps, repoDir, date, mergeMethod: method, admin });

  // 2. Pull requests this job opened on earlier nights.
  const historyFile = `history/${projectKey(project.owner, project.repo)}.json`;
  const history = store.read(historyFile, { seenTitles: [], prs: [] });
  const saveHistory = () => store.write(historyFile, { seenTitles: history.seenTitles.slice(-MAX_REMEMBERED_TITLES), prs: history.prs });
  const open = await github.listNightshiftPrs(project.owner, project.repo);
  history.prs = history.prs.filter((record) => open.some((pr) => pr.number === record.number));
  let mergedEarlier = false;
  let stillOpen = open.length;
  if (!dryRun) {
    for (const pr of open) {
      const record = history.prs.find((item) => item.number === pr.number);
      if (mergedEarlier || !record?.eligible || record.sha !== pr.headRefOid) continue;
      const checks = await github.waitForChecks({ owner: project.owner, repo: project.repo, number: pr.number, timeoutMs: left(EARLIER_PR_CHECKS_LIMIT_MS) });
      if (checks.state !== 'pass') continue;
      const merged = await github.merge({ owner: project.owner, repo: project.repo, number: pr.number, sha: pr.headRefOid, method, admin });
      if (!merged.ok) continue;
      mergedEarlier = true;
      stillOpen -= 1;
      history.prs = history.prs.filter((item) => item.number !== pr.number);
      saveHistory();
      // The job's clone must exist for a revert; it does once any earlier visit has run.
      const repoDir = join(deps.dataDir, 'workspaces', projectKey(project.owner, project.repo), 'repo');
      const live = await putLive(merged.mergeSha, repoDir);
      entries.push(entry(name, 'did', record.title, `Merged on a later visit, once its checks passed. ${live.detail}`, {
        prUrl: record.url, security: record.security === true, liveState: live.liveState,
      }));
      if (live.needsYou) needsYou.push(`${name}: ${live.needsYou}`);
    }
  }
  for (const pr of open.filter((item) => !entries.some((e) => e.prUrl === item.url))) {
    if (history.prs.some((record) => record.number === pr.number)) {
      needsYou.push(`${name} still has an open pull request from an earlier night: ${pr.url}`);
    } else if (pr.headRefName.startsWith('nightshift/revert-')) {
      needsYou.push(`${name} has an open revert pull request: ${pr.url}`);
    } else {
      needsYou.push(`${name} has an open pull request on a nightshift branch that this job did not record: ${pr.url}`);
    }
  }
  const mayChange = !dryRun && !mergedEarlier && stillOpen < MAX_OPEN_PRS;

  // 3. A fresh working copy, and how things stand before any change.
  let branch = `nightshift/${date}`;
  for (let n = 2; open.some((pr) => pr.headRefName === branch); n += 1) branch = `nightshift/${date}-${n}`;
  const identity = settings.identity;
  const ws = await steps.prepareWorkspace({ run, gitPath, dataDir: deps.dataDir, project: current, date, identity, branch });
  // Everything run for this project gets the project's own tool folders first on PATH.
  const listedTools = Object.entries(settings.toolPaths ?? {}).find(([listed]) => sameName(listed, name));
  const pathPrefix = listedTools ? listedTools[1] : [];
  const sandboxed = (argv, options = {}) => restrictedRun(argv, { ...options, pathPrefix });
  const checkRunFor = (dir) => (argv, options = {}) => sandboxed(argv, { ...options, writable: [dir], cacheDir: ws.cacheDir });
  // Keeps the end of a failing check's output in the data folder and returns where, or null.
  const keepFailure = (measured, when) => {
    if (measured.checksPass !== false || !measured.failureOutput) return null;
    const file = `logs/${date}/${projectKey(project.owner, project.repo)}-${when}.json`;
    store.write(file, { checkCommand: measured.checkCommand, output: measured.failureOutput });
    return file;
  };
  const baseline = await steps.measure({ run: checkRunFor(ws.dir), dir: ws.dir, fs, timeoutMs: left(CHECK_LIMIT_MS) });
  const baselineLog = keepFailure(baseline, 'before');
  if (baseline.checksPass === false) {
    needsYou.push(`${name}: the checks are failing on ${base}, so nothing can be merged.`);
  }

  // 4. The model inspects, and may make one change.
  const brief = renderBrief({ project: name, mayChange, isPublic: current.isPublic, knownFindings: history.seenTitles });
  const claudeDir = join(ws.cacheDir, 'claude');
  const call = buildAgentCall({ claudePath: deps.claudePath, brief, claudeDir, token: deps.claudeToken });
  const agent = await steps.runAgent({ restrictedRun: sandboxed, call, cwd: ws.dir, cacheDir: ws.cacheDir, claudeDir, timeoutMs: left(AGENT_LIMIT_MS) });
  model = agent.model;
  if (!agent.ok) {
    entries.push(entry(name, 'found', 'Inspection did not finish', agent.failure));
    needsPerson = true;
    if (STOP_THE_NIGHT.includes(agent.failure)) stop = agent.failure;
    return finish();
  }

  // 5. What it noticed, minus what earlier visits already recorded.
  const seen = new Set(history.seenTitles.map(fold));
  const fresh = (item) => {
    if (seen.has(fold(item.title))) return false;
    seen.add(fold(item.title));
    history.seenTitles.push(item.title);
    return true;
  };
  if (baseline.checksPass === false && fresh({ title: "The repository's checks are failing" })) {
    const where = baselineLog ? ` The end of the output is kept in the data folder at ${baselineLog}.` : '';
    entries.push(entry(name, 'found', "The repository's checks are failing", `They fail before any change is made.${where}`));
  }
  for (const item of agent.output.findings.filter(fresh)) {
    entries.push(entry(name, 'found', item.title, item.detail, { security: item.security }));
  }
  for (const item of agent.output.proposals.filter(fresh)) {
    entries.push(entry(name, 'proposed', item.title, item.detail, { security: item.security }));
  }
  saveHistory();

  // 6. The change, if there is one and one is allowed tonight.
  const change = mayChange ? agent.output.change : null;
  if (change && outOfTime()) {
    entries.push(entry(name, 'found', 'Ran out of time', 'The 45-minute limit for one project was reached before the change could be checked. What was learned is kept.'));
  } else if (change) {
    await handleChange(change);
  }

  // 8. A visit with nothing to say still says so.
  if (entries.length === 0) {
    const detail = baseline.checksPass === true ? 'The checks pass and nothing stood out.' : 'No checks were found to run, and nothing stood out.';
    entries.push(entry(name, 'found', 'Nothing worth changing tonight', detail));
  }
  return finish();

  async function handleChange(described) {
    const title = NAMES_A_TOOL.test(described.title) ? 'Maintenance update' : described.title;
    const summary = NAMES_A_TOOL.test(described.summary) ? 'A maintenance change. See the diff for what it does.' : described.summary;
    const security = described.security === true;
    const keepPrivate = security && current.isPublic;

    const imported = await steps.importChange({
      run, restrictedRun: sandboxed, gitPath, repoDir: ws.repoDir, dir: ws.dir, cacheDir: ws.cacheDir, baseSha: ws.baseSha, message: title, identity,
    });
    if (!imported) {
      entries.push(entry(name, 'found', title, 'The model described this change but did not commit it, so nothing was pushed.', { security }));
      return;
    }
    const { sha } = imported;
    // Measure exactly what would be pushed: a clean tree at the imported commit.
    await steps.resetTree({ run, gitPath, repoDir: ws.repoDir, dir: ws.dir, ref: sha, identity });
    const after = await steps.measure({ run: checkRunFor(ws.dir), dir: ws.dir, fs, timeoutMs: left(CHECK_LIMIT_MS) });
    keepFailure(after, 'after');
    const stats = await steps.changeStats({ run, gitPath, repoDir: ws.repoDir, baseSha: ws.baseSha, sha });
    const manifests = await steps.readManifests({ run, gitPath, repoDir: ws.repoDir, baseSha: ws.baseSha, sha, files: stats.files });
    const proof = await steps.provesItself({
      run, checkRunFor, gitPath, repoDir: ws.repoDir, proofDir: join(ws.cacheDir, '..', 'proof'), baseSha: ws.baseSha, sha,
      files: stats.files, fs, timeoutMs: left(CHECK_LIMIT_MS), baselinePass: baseline.checksPass === true,
    });
    const verdict = decide({ change: described, stats, before: baseline, after, proof, manifests });
    const measured = diffMeasures(baseline, after);
    const impact = { measured, claims: described.claims };
    const detail = measured.length ? summary : `${summary} No measurable impact.`;
    const proposed = (reason, prUrl) => entry(name, 'proposed', title, detail, { prUrl, security, reason, impact });

    // A security change in a public repository is either merged tonight or never shown there.
    if (keepPrivate && !verdict.merge) {
      entries.push(proposed(verdict.reason, null));
      needsYou.push(`${name} has a private security proposal: ${title}`);
      return;
    }
    if (outOfTime()) {
      entries.push(entry(name, 'found', 'Ran out of time', 'The 45-minute limit for one project was reached before the change could be pushed. What was learned is kept.'));
      return;
    }
    const pushed = await github.pushBranch({ repoDir: ws.repoDir, branch: ws.branch, defaultBranch: base });
    if (!pushed.ok) {
      entries.push(proposed(`Could not be pushed: ${pushed.reason}`, null));
      needsYou.push(`${name}: a change could not be pushed.`);
      return;
    }
    const pr = await github.openPr({ owner: project.owner, repo: project.repo, branch: ws.branch, base, title, body: prBody(summary, measured) });
    const forget = () => {
      history.prs = history.prs.filter((item) => item.number !== pr.number);
      saveHistory();
    };
    history.prs.push({ number: pr.number, sha, eligible: verdict.merge, security, title, url: pr.url });
    saveHistory();
    const leftOpen = (reason) => {
      entries.push(proposed(reason, pr.url));
      needsYou.push(`${name} has an open proposal: ${title}`);
    };
    if (!verdict.merge) return leftOpen(verdict.reason);

    // A security change in a public repository that does not get merged tonight is taken
    // back down, whatever the reason, so it is never left sitting in public.
    const target = { owner: project.owner, repo: project.repo, number: pr.number };
    const withdraw = async (reason) => {
      await github.closePr({ ...target, deleteBranch: true });
      forget();
      entries.push(proposed(reason, null));
      needsYou.push(`${name} has a private security proposal: ${title}`);
    };
    const notMerged = (reason) => (keepPrivate ? withdraw(reason) : leftOpen(reason));
    let merged;
    try {
      const checks = await github.waitForChecks({ ...target, timeoutMs: left(PR_CHECKS_LIMIT_MS) });
      if (checks.state !== 'pass') {
        return notMerged({ fail: checks.detail ? `Checks failed: ${checks.detail}` : 'Checks failed', none: 'Checks did not run', timeout: 'Checks did not finish in time' }[checks.state]);
      }
      merged = await github.merge({ ...target, sha, method, admin });
      if (!merged.ok) return notMerged(`Could not be merged: ${merged.reason}`);
    } catch (error) {
      if (keepPrivate) {
        await github.closePr({ ...target, deleteBranch: true }).then(forget, () => {});
      }
      throw error;
    }
    forget();
    const live = await putLive(merged.mergeSha, ws.repoDir);
    entries.push(entry(name, 'did', title, `${detail} ${live.detail}`, { prUrl: pr.url, security, impact, liveState: live.liveState }));
    if (live.needsYou) needsYou.push(`${name}: ${live.needsYou}`);
  }
}

// What must be true before any project is touched. Returns a reason, or null.
async function prerequisite(deps) {
  const { settings, store, run } = deps;
  try {
    store.write('.write-test.json', { ok: true });
    store.remove('.write-test.json');
  } catch (error) {
    return `The data folder cannot be written: ${error.message}`;
  }
  if (!settings.identity?.name || !settings.identity?.email) {
    return 'Set identity (a name and an email for commits) in settings.json.';
  }
  if (!deps.sandboxOk) {
    return 'This computer cannot sandbox the model. The nightly run needs macOS, or allowUnsandboxed in settings.json.';
  }
  // Asks GitHub who the active account is. `gh auth status` is not used: it fails when any
  // other stored account has a problem, even if the active one works.
  const gh = await run([deps.ghPath, 'api', 'user', '--jq', '.login'], { timeoutMs: 60000 });
  if (gh.code !== 0 || gh.stdout.trim() === '') return 'GitHub sign-in is not working. Run: gh auth login';
  if (!deps.claudeToken) return 'No Claude token. Run claude setup-token and save the token as claude-token in the data folder.';
  const claude = await run([deps.claudePath, '--version'], { timeoutMs: 60000 });
  if (claude.code !== 0) return 'Claude Code is not installed, or not where NIGHTSHIFT_CLAUDE points.';
  return null;
}

export async function runNight({ deps, date, only = null, dryRun = false }) {
  const { store, settings, projects } = deps;
  const lock = acquireLock(store, { pid: deps.pid, isAlive: deps.isAlive });
  if (!lock) throw new RunInProgress();

  // A second run on one date adds to that date's report.
  const earlier = store.read(`reports/${date}.json`, null);
  const report = earlier?.finishedAt
    ? { ...earlier, finishedAt: null, outcome: 'ok', reason: null }
    : newReport(date, deps.now().toISOString());
  const close = (outcome, reason) => {
    report.outcome = outcome;
    report.reason = reason;
    report.finishedAt = deps.now().toISOString();
    saveReport(store, report);
    const note = writeVaultNote(report, settings.vaultDir, deps.fs);
    if (!note.written) deps.log(`The vault note was not written: ${note.reason}`);
    return report;
  };

  try {
    const blocker = await prerequisite(deps);
    if (blocker) return close('failed', blocker);

    const listed = projects.list();
    let tonight;
    if (only) {
      tonight = listed.filter((p) => sameName(`${p.owner}/${p.repo}`, only));
      if (tonight.length === 0) return close('failed', `${only} is not on the project list.`);
    } else {
      tonight = pickProjects(listed, settings.projectsPerNight ?? 3);
    }
    saveReport(store, report);

    for (const project of tonight) {
      const name = `${project.owner}/${project.repo}`;
      deps.log(`Visiting ${name}`);
      let visit;
      try {
        visit = await visitProject({ project, deps, date, dryRun });
      } catch (error) {
        visit = {
          entries: [entry(name, 'found', 'Visit did not finish', error.message)],
          needsYou: [], model: null, stop: null, lastResult: 'Inspection did not finish', status: 'needs-you',
        };
      }
      report.entries.push(...visit.entries);
      report.needsYou.push(...visit.needsYou);
      report.model = report.model ?? visit.model;
      if (!dryRun) {
        projects.update(project.owner, project.repo, {
          lastVisitAt: deps.now().toISOString(), lastResult: visit.lastResult, status: visit.status,
        });
      }
      saveReport(store, report);
      if (visit.stop) return close('stopped', visit.stop);
    }
    const blocked = deps.blockedHosts();
    if (blocked.length) deps.log(`Hosts the sandbox refused: ${blocked.join(', ')}`);
    return close('ok', null);
  } finally {
    lock.release();
  }
}
