// Nightshift's own clone of each project, kept in the data folder. The model works here
// and nowhere else; a checkout that a running app is served from is never used.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectKey } from './projects.mjs';

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

function gitRunner(run, gitPath, dir) {
  return async (args, { allowFailure = false } = {}) => {
    const result = await run([gitPath, ...args], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0 && !allowFailure) {
      const why = result.timedOut ? 'timed out' : String(result.stderr).trim().split('\n').pop();
      throw new Error(`git ${args[0]} failed: ${why}`);
    }
    return result;
  };
}

// Brings the clone to the tip of the default branch with nothing left over from earlier
// visits, on a fresh branch. Returns { dir, branch, baseSha }.
export async function prepareWorkspace({ run, gitPath, dataDir, project, date, identity, cloneUrl, branch }) {
  const name = `${project.owner}/${project.repo}`;
  const dir = join(dataDir, 'workspaces', projectKey(project.owner, project.repo));
  const url = cloneUrl ?? `https://github.com/${project.owner}/${project.repo}.git`;
  const target = branch ?? `nightshift/${date}`;
  const upstream = `origin/${project.defaultBranch}`;

  try {
    if (!existsSync(join(dir, '.git'))) {
      rmSync(dir, { recursive: true, force: true });
      const clone = await run([gitPath, 'clone', '--quiet', url, dir], { timeoutMs: GIT_TIMEOUT_MS });
      if (clone.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(clone.timedOut ? 'the clone timed out' : String(clone.stderr).trim().split('\n').pop());
      }
    }
    const git = gitRunner(run, gitPath, dir);
    await git(['config', 'user.name', identity.name]);
    await git(['config', 'user.email', identity.email]);
    await git(['fetch', '--quiet', '--prune', 'origin']);
    await git(['reset', '--quiet', '--hard']);
    await git(['checkout', '--quiet', '--force', '-B', target, upstream]);
    await git(['clean', '--quiet', '-fdx']);
    const others = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    for (const other of others.stdout.split('\n').filter((ref) => ref && ref !== target)) {
      await git(['branch', '--quiet', '-D', other]);
    }
    const head = await git(['rev-parse', 'HEAD']);
    return { dir, branch: target, baseSha: head.stdout.trim() };
  } catch (error) {
    throw new Error(`Could not prepare a working copy of ${name}: ${error.message}`);
  }
}

// Replaces whatever the model committed, and anything it left uncommitted, with one commit
// authored and committed as `identity`, carrying exactly `message`. Returns { sha }, or null
// when the branch ends up identical to where it started.
export async function squashBranch({ run, gitPath, dir, baseSha, message, identity }) {
  const git = gitRunner(run, gitPath, dir);
  await git(['add', '--all']);
  await git(['reset', '--quiet', '--soft', baseSha]);
  const unchanged = await git(['diff', '--cached', '--quiet'], { allowFailure: true });
  if (unchanged.code === 0) return null;
  const who = `${identity.name} <${identity.email}>`;
  await git([
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--no-verify', `--author=${who}`, '--message', message,
  ]);
  const head = await git(['rev-parse', 'HEAD']);
  return { sha: head.stdout.trim() };
}
