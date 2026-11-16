// Nightshift's own copies of each project, kept in the data folder:
//
//   workspaces/<owner>__<repo>/repo   the job's clone. It talks to GitHub. The model never
//                                     works here, and the sandbox makes it read-only to it.
//   workspaces/<owner>__<repo>/tree   a throwaway clone of that clone, for the model and for
//                                     running the project's checks. Everything in it,
//                                     including its .git folder, is treated as untrusted.
//   workspaces/<owner>__<repo>/cache  temporary files and package caches for sandboxed runs.
//
// The job's own git commands never run inside the tree. A change comes out of the tree as a
// bundle file written from inside the sandbox, which the job then reads as plain data.
// A checkout that a running app is served from is never touched here.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectKey } from './projects.mjs';

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
// The job's git never runs hooks or helper programs named by a repository's own settings.
const GUARDED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const lastLine = (text) => String(text).trim().split('\n').pop();

function gitRunner(run, gitPath, cwd) {
  return async (args, { allowFailure = false, env } = {}) => {
    const result = await run([gitPath, ...GUARDED, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env });
    if ((result.code !== 0 || result.timedOut) && !allowFailure) {
      throw new Error(`git ${args[0]} failed: ${result.timedOut ? 'timed out' : lastLine(result.stderr)}`);
    }
    return result;
  };
}

// Throws the tree away and clones it again from the job's clone at `ref`.
export async function resetTree({ run, gitPath, repoDir, dir, ref, identity }) {
  rmSync(dir, { recursive: true, force: true });
  const git = gitRunner(run, gitPath, repoDir);
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  await git([
    'clone', '--quiet', '--no-hardlinks', '--branch', branch,
    '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`,
    repoDir, dir,
  ]);
  // Done while the tree is still exactly what the job just cloned.
  const inTree = gitRunner(run, gitPath, dir);
  await inTree(['reset', '--quiet', '--hard', ref]);
  await inTree(['remote', 'remove', 'origin']);
}

// Brings the job's clone to the tip of the default branch on a fresh branch, and makes a new
// tree from it. Returns { repoDir, dir, cacheDir, branch, baseSha }.
export async function prepareWorkspace({ run, gitPath, dataDir, project, date, identity, cloneUrl, branch }) {
  const name = `${project.owner}/${project.repo}`;
  const home = join(dataDir, 'workspaces', projectKey(project.owner, project.repo));
  const repoDir = join(home, 'repo');
  const dir = join(home, 'tree');
  const cacheDir = join(home, 'cache');
  const url = cloneUrl ?? `https://github.com/${project.owner}/${project.repo}.git`;
  const target = branch ?? `nightshift/${date}`;

  try {
    if (!existsSync(join(repoDir, '.git'))) {
      rmSync(repoDir, { recursive: true, force: true });
      const clone = await run([gitPath, ...GUARDED, 'clone', '--quiet', url, repoDir], { timeoutMs: GIT_TIMEOUT_MS });
      if (clone.code !== 0 || clone.timedOut) {
        rmSync(repoDir, { recursive: true, force: true });
        throw new Error(clone.timedOut ? 'the clone timed out' : lastLine(clone.stderr));
      }
    }
    const git = gitRunner(run, gitPath, repoDir);
    await git(['config', 'user.name', identity.name]);
    await git(['config', 'user.email', identity.email]);
    await git(['fetch', '--quiet', '--prune', 'origin']);
    await git(['reset', '--quiet', '--hard']);
    await git(['checkout', '--quiet', '--force', '-B', target, `origin/${project.defaultBranch}`]);
    await git(['clean', '--quiet', '-fdx']);
    const branches = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    for (const other of branches.stdout.split('\n').filter((ref) => ref && ref !== target)) {
      await git(['branch', '--quiet', '-D', other]);
    }
    const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await resetTree({ run, gitPath, repoDir, dir, ref: baseSha, identity });
    return { repoDir, dir, cacheDir, branch: target, baseSha };
  } catch (error) {
    throw new Error(`Could not prepare a working copy of ${name}: ${error.message}`);
  }
}

// Takes what the model committed in the tree and records it in the job's clone as a single
// commit on top of `baseSha`, authored and committed as `identity`, with exactly `message`.
// Files merely left lying in the tree are not included. Returns { sha }, or null when the
// model committed nothing or its commits leave the files as they were.
export async function importChange({ run, restrictedRun, gitPath, repoDir, dir, cacheDir, baseSha, message, identity }) {
  // Inside the sandbox: read the tree's HEAD and pack its new commits into a bundle.
  const untrusted = { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, writable: [dir], cacheDir };
  const head = await restrictedRun([gitPath, 'rev-parse', '--verify', 'HEAD'], untrusted);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !SHA.test(headSha)) throw new Error('The change could not be read from the working copy.');
  if (headSha === baseSha) return null;
  const bundle = join(cacheDir, 'change.bundle');
  mkdirSync(cacheDir, { recursive: true });
  rmSync(bundle, { force: true });
  const packed = await restrictedRun([gitPath, 'bundle', 'create', bundle, `${baseSha}..HEAD`], untrusted);
  if (packed.code !== 0 || !existsSync(bundle)) throw new Error('The change could not be read from the working copy.');

  // Outside it: the bundle is data. Nothing from the tree's .git folder is used from here on.
  const git = gitRunner(run, gitPath, repoDir);
  try {
    await git(['fetch', '--quiet', '--no-tags', bundle, 'HEAD']);
    const newTree = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{tree}'])).stdout.trim();
    const baseTree = (await git(['rev-parse', '--verify', `${baseSha}^{tree}`])).stdout.trim();
    if (newTree === baseTree) return null;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    const commit = await git(['commit-tree', newTree, '-p', baseSha, '-m', message], { env });
    const sha = commit.stdout.trim();
    await git(['reset', '--quiet', '--hard', sha]);
    return { sha };
  } catch (error) {
    throw new Error(`The change could not be read from the working copy: ${error.message}`);
  } finally {
    rmSync(bundle, { force: true });
  }
}
