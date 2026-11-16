// After a merge: watch what the merge set off, put the change live where the app runs on
// this machine, check it is healthy, and undo it if it is not.
import { join } from 'node:path';
import { parseRepoLink } from './repo-link.mjs';

const WAIT_MS = 30 * 60 * 1000;
const HEALTH_WINDOW_MS = 60 * 1000;
const HEALTH_EVERY_MS = 2000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const GUARDED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const sameRepo = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
const lastLine = (text) => String(text ?? '').trim().split('\n').pop();

// The launcher app whose checkout was cloned from this repository, or null.
export async function findLauncherApp({ registry, run, gitPath, project }) {
  for (const app of registry?.apps ?? []) {
    const remote = await run([gitPath, ...GUARDED, 'remote', 'get-url', 'origin'], { cwd: app.cwd, timeoutMs: 30000 });
    if (remote.code !== 0) continue;
    try {
      if (!sameRepo(parseRepoLink(remote.stdout.trim()), project)) continue;
    } catch {
      continue;
    }
    return { id: app.id, cwd: app.cwd, port: app.port, healthPath: app.healthPath ?? '/', build: app.build ?? [] };
  }
  return null;
}

export async function goLive({ project, mergeSha, settings, deps, repoDir, date, mergeMethod, admin }) {
  const { run, gitPath, nodePath, github, fetch, sleep, now, readRegistry } = deps;
  const { owner, repo, defaultBranch: base } = project;
  const notes = [];
  const result = (liveState, detail) => ({ liveState, needsYou: notes.length ? notes.join(' ') : null, detail });

  // Undo the merge on GitHub with a pull request of its own, merged only if its checks pass.
  async function revertThroughPr() {
    let pr;
    try {
      pr = await github.revert({ repoDir, owner, repo, mergeSha, base, date });
    } catch (error) {
      notes.push(`${base} still contains the change; it could not be reverted automatically: ${error.message}`);
      return;
    }
    const checks = await github.waitForChecks({ owner, repo, number: pr.number, timeoutMs: WAIT_MS });
    if (checks.state !== 'pass') {
      notes.push(`${base} still contains the change; the revert PR did not pass: ${pr.url}`);
      return;
    }
    const merged = await github.merge({ owner, repo, number: pr.number, sha: pr.sha, method: mergeMethod, admin });
    if (!merged.ok) {
      notes.push(`${base} still contains the change; the revert PR could not be merged: ${pr.url}`);
      return;
    }
    const after = await github.waitForRunsOn({ owner, repo, sha: merged.mergeSha, timeoutMs: WAIT_MS });
    if (after.state === 'fail') notes.push("The deploy after the revert failed; run the repository's rollback workflow.");
  }

  // 1. Whatever the merge triggered on GitHub: a deploy, or the checks running again.
  const runs = await github.waitForRunsOn({ owner, repo, sha: mergeSha, timeoutMs: WAIT_MS });
  if (runs.state === 'fail') {
    await revertThroughPr();
    return result('rolled-back', `The runs the merge triggered failed (${runs.failed.join(', ')}); the change was reverted.`);
  }
  if (runs.state === 'timeout') notes.push('The runs the merge triggered did not finish in 30 minutes.');

  // 2. Projects the job itself depends on are never restarted by it.
  if ((settings.hold ?? []).some((held) => held.toLowerCase() === `${owner}/${repo}`.toLowerCase())) {
    return result('merged-not-running', 'Pull the checkout and restart the service to go live.');
  }

  // 3. Nothing runs from a checkout on this machine.
  const app = await findLauncherApp({ registry: readRegistry(), run, gitPath, project });
  if (!app) return result('not-applicable', runs.state === 'pass' ? 'The runs the merge triggered passed.' : 'Nothing to deploy.');

  // 4. A launcher app. Its checkout is only ever touched when it is clean and on the default branch.
  const git = (args) => run([gitPath, ...GUARDED, ...args], { cwd: app.cwd, timeoutMs: STEP_TIMEOUT_MS });
  const status = await git(['status', '--porcelain']);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (status.code !== 0 || status.stdout.trim() !== '' || branch.stdout.trim() !== base) {
    notes.push('The checkout has local work; not touched.');
    return result('merged-not-running', `${app.id} was left on the commit it was running.`);
  }
  const previous = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const pull = await git(['pull', '--quiet', '--ff-only', 'origin', base]);
  if (pull.code !== 0) {
    notes.push(`The checkout could not be updated: ${lastLine(pull.stderr)}`);
    return result('merged-not-running', `${app.id} was left on the commit it was running.`);
  }
  const current = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const lockChanged = (await git(['diff', '--name-only', previous, current, '--', 'package-lock.json'])).stdout.trim() !== '';

  async function healthy() {
    const started = now();
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${app.port}${app.healthPath}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (response.status >= 200 && response.status < 400) return true;
      } catch {
        // Not up yet.
      }
      if (now() - started >= HEALTH_WINDOW_MS) return false;
      await sleep(HEALTH_EVERY_MS);
    }
  }
  async function buildAndRestart() {
    const steps = [...(lockChanged ? [['npm', 'ci']] : []), ...app.build, [nodePath, join(settings.launcherDir, 'src/cli.mjs'), 'restart', app.id]];
    for (const argv of steps) {
      const step = await run(argv, { cwd: app.cwd, timeoutMs: STEP_TIMEOUT_MS });
      if (step.code !== 0 || step.timedOut) return false;
    }
    return healthy();
  }

  if (await buildAndRestart()) return result('running', `${app.id} restarted and healthy.`);

  // 5. Not healthy. Step 4 proved the checkout clean, so going back loses nothing.
  await git(['reset', '--quiet', '--hard', previous]);
  if (!(await buildAndRestart())) notes.unshift(`${app.id} is down after rollback.`);
  await revertThroughPr();
  return result('rolled-back', `${app.id} did not come back healthy on the new commit and was put back on the previous one.`);
}
