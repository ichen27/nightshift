// Every call to the GitHub CLI goes through here.

const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

const CHECK_START_GRACE_MS = 3 * 60 * 1000;
const POLL_MS = 20 * 1000;
const GUARDED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];
const METHODS = ['squash', 'merge', 'rebase'];
const NO_CHECKS = /no checks reported/i;
const FINE = new Set(['success', 'skipped', 'neutral']);

// The merge method to use: the first of squash, merge, rebase that the repository allows.
export function pickMergeMethod(allowed) {
  return METHODS.find((method) => allowed.includes(method)) ?? 'squash';
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGithub({ run, ghPath, gitPath = 'git', sleep = realSleep, now = Date.now }) {
  const gh = (args, options = {}) => run([ghPath, ...args], { timeoutMs: GH_TIMEOUT_MS, ...options });
  // The job's own git, always in its own clone, never running hooks.
  const git = (repoDir, args) => run([gitPath, ...GUARDED, ...args], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });

  async function getRepo(owner, repo) {
    const result = await gh(['api', `repos/${owner}/${repo}`]);
    if (result.code !== 0) {
      if (/HTTP 404|Not Found/i.test(result.stderr)) return { exists: false };
      throw new Error(`GitHub could not be reached: ${firstLine(result.stderr) || 'gh failed'}`);
    }
    const data = JSON.parse(result.stdout);
    const allowed = [
      ['squash', data.allow_squash_merge],
      ['merge', data.allow_merge_commit],
      ['rebase', data.allow_rebase_merge],
    ];
    // GitHub omits these fields for some callers; when it says nothing, assume all three.
    const known = allowed.some(([, value]) => typeof value === 'boolean');
    return {
      exists: true,
      owner: data.owner.login,
      repo: data.name,
      archived: data.archived === true,
      canPush: data.permissions?.push === true,
      isPublic: data.private === false,
      defaultBranch: data.default_branch,
      mergeMethods: allowed.filter(([, value]) => !known || value === true).map(([name]) => name),
    };
  }

  // Open pull requests from branches named nightshift/… in the repository itself. A pull
  // request from a fork is left out: anyone can give a fork's branch that name.
  async function listNightshiftPrs(owner, repo) {
    const result = await gh([
      'pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '100',
      '--json', 'number,url,headRefName,headRefOid,isCrossRepository',
    ]);
    if (result.code !== 0) {
      throw new Error(`Could not list pull requests for ${owner}/${repo}: ${firstLine(result.stderr) || 'gh failed'}`);
    }
    return JSON.parse(result.stdout)
      .filter((pr) => pr.headRefName.startsWith('nightshift/') && pr.isCrossRepository !== true)
      .map(({ number, url, headRefName, headRefOid }) => ({ number, url, headRefName, headRefOid }));
  }

  // Pushes one of the job's own branches. Never the default branch, never anything else.
  async function pushBranch({ repoDir, branch, defaultBranch }) {
    if (typeof branch !== 'string' || !/^nightshift\/[A-Za-z0-9._-]+$/.test(branch) || branch === defaultBranch) {
      return { ok: false, reason: `Refusing to push ${JSON.stringify(branch)}: not one of the job's own branches.` };
    }
    const ref = `refs/heads/${branch}`;
    const result = await git(repoDir, ['push', '--force', 'origin', `${ref}:${ref}`]);
    return result.code === 0 ? { ok: true, reason: null } : { ok: false, reason: lastLine(result.stderr) || 'git push failed' };
  }

  async function openPr({ owner, repo, branch, base, title, body }) {
    const result = await gh(['pr', 'create', '--repo', `${owner}/${repo}`, '--head', branch, '--base', base, '--title', title, '--body', body]);
    const match = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(result.stdout);
    if (result.code !== 0 || !match) {
      throw new Error(`Could not open a pull request on ${owner}/${repo}: ${firstLine(result.stderr) || 'gh gave no address'}`);
    }
    return { number: Number(match[1]), url: match[0] };
  }

  async function failingChecks(owner, repo, number) {
    const result = await gh(['pr', 'checks', String(number), '--repo', `${owner}/${repo}`, '--json', 'name,bucket']);
    try {
      const failed = JSON.parse(result.stdout).filter((check) => check.bucket === 'fail').map((check) => check.name);
      return failed.length ? failed.join(', ') : null;
    } catch {
      return null;
    }
  }

  // 'pass', 'fail', 'none' (no check ever started) or 'timeout'. A pull request is only ever
  // merged on 'pass'.
  async function waitForChecks({ owner, repo, number, timeoutMs }) {
    const target = [String(number), '--repo', `${owner}/${repo}`];
    const started = now();
    // Checks take a moment to be created, and longer when GitHub is having a bad day.
    for (;;) {
      const probe = await gh(['pr', 'checks', ...target, '--json', 'name,bucket']);
      if (!NO_CHECKS.test(probe.stderr)) break;
      if (now() - started >= Math.min(CHECK_START_GRACE_MS, timeoutMs)) return { state: 'none', detail: null };
      await sleep(POLL_MS);
    }
    const watch = await gh(['pr', 'checks', ...target, '--watch', '--fail-fast', '--interval', '20'], { timeoutMs });
    if (watch.timedOut) return { state: 'timeout', detail: null };
    if (watch.code === 0) return { state: 'pass', detail: null };
    if (NO_CHECKS.test(watch.stderr)) return { state: 'none', detail: null };
    return { state: 'fail', detail: await failingChecks(owner, repo, number) };
  }

  async function merge({ owner, repo, number, sha, method, admin }) {
    if (!METHODS.includes(method)) throw new Error(`Unknown merge method: ${method}`);
    const target = [String(number), '--repo', `${owner}/${repo}`];
    const result = await gh(['pr', 'merge', ...target, `--${method}`, '--match-head-commit', sha, '--delete-branch', ...(admin ? ['--admin'] : [])]);
    if (result.code !== 0) return { ok: false, mergeSha: null, reason: firstLine(result.stderr) || 'gh pr merge failed' };
    const view = await gh(['pr', 'view', ...target, '--json', 'state,mergeCommit']);
    try {
      const pr = JSON.parse(view.stdout);
      if (pr.state === 'MERGED' && pr.mergeCommit?.oid) return { ok: true, mergeSha: pr.mergeCommit.oid, reason: null };
    } catch {
      // Falls through.
    }
    return { ok: false, mergeSha: null, reason: 'GitHub did not confirm the merge.' };
  }

  async function closePr({ owner, repo, number, deleteBranch }) {
    await gh(['pr', 'close', String(number), '--repo', `${owner}/${repo}`, ...(deleteBranch ? ['--delete-branch'] : [])]);
  }

  // Watches the workflow runs a commit set off (a deploy, for example).
  async function waitForRunsOn({ owner, repo, sha, timeoutMs }) {
    const started = now();
    for (;;) {
      const result = await gh(['run', 'list', '--repo', `${owner}/${repo}`, '--commit', sha, '--limit', '50', '--json', 'name,status,conclusion']);
      let runs = [];
      try {
        runs = JSON.parse(result.stdout);
      } catch {
        // Treated as no runs yet.
      }
      const waited = now() - started;
      if (runs.length === 0) {
        if (waited >= Math.min(CHECK_START_GRACE_MS, timeoutMs)) return { state: 'none', failed: [] };
      } else if (runs.every((item) => item.status === 'completed')) {
        const failed = runs.filter((item) => !FINE.has(item.conclusion)).map((item) => item.name);
        return failed.length ? { state: 'fail', failed } : { state: 'pass', failed: [] };
      } else if (waited >= timeoutMs) {
        return { state: 'timeout', failed: [] };
      }
      await sleep(POLL_MS);
    }
  }

  // Undoes a merged commit through a pull request of its own.
  async function revert({ repoDir, owner, repo, mergeSha, base, date }) {
    const branch = `nightshift/revert-${date}`;
    const must = async (args) => {
      const result = await git(repoDir, args);
      if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${lastLine(result.stderr)}`);
      return result.stdout.trim();
    };
    await must(['fetch', '--quiet', 'origin']);
    await must(['checkout', '--quiet', '--force', '-B', branch, `origin/${base}`]);
    const parents = (await must(['rev-list', '--parents', '-n', '1', mergeSha])).split(/\s+/).length - 1;
    const title = await must(['log', '-1', '--format=%s', mergeSha]);
    const reverted = await git(repoDir, ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), mergeSha]);
    if (reverted.code !== 0) {
      await git(repoDir, ['revert', '--abort']);
      throw new Error(`The change could not be reverted cleanly: ${lastLine(reverted.stderr)}`);
    }
    const sha = await must(['rev-parse', 'HEAD']);
    const pushed = await pushBranch({ repoDir, branch, defaultBranch: base });
    if (!pushed.ok) throw new Error(`The revert could not be pushed: ${pushed.reason}`);
    const pr = await openPr({
      owner, repo, branch, base,
      title: `Revert "${title}"`,
      body: `Reverts ${mergeSha}. The change did not come up healthy after it was merged.`,
    });
    return { ...pr, sha, branch };
  }

  return { getRepo, listNightshiftPrs, pushBranch, openPr, waitForChecks, merge, closePr, waitForRunsOn, revert };

}

function lastLine(text) {
  return String(text || '').trim().split('\n').pop();
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0];
}
