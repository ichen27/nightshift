// Decides whether a change may be merged or is only proposed. This is plain code on
// purpose: the model that made the change has no say in it.
import { rmSync } from 'node:fs';
import { detectCheck, runCheck } from './measure.mjs';

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const GUARDED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

async function git(run, gitPath, cwd, args, { allowFailure = false } = {}) {
  const result = await run([gitPath, ...GUARDED, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim().split('\n').pop()}`);
  }
  return result;
}

// What a change touches: its files (a rename counts as both names), how many lines it adds,
// and whether it does nothing but remove (no added lines, no new files, no binary changes,
// no permission changes).
export async function changeStats({ run, gitPath, repoDir, baseSha, sha }) {
  const range = ['--no-renames', baseSha, sha];
  const numstat = await git(run, gitPath, repoDir, ['diff', '--numstat', '-z', ...range]);
  const files = [];
  let addedLines = 0;
  let binary = false;
  for (const record of numstat.stdout.split('\0').filter(Boolean)) {
    const [added, , ...path] = record.split('\t');
    files.push(path.join('\t'));
    if (/^\d+$/.test(added)) addedLines += Number(added);
    else binary = true;
  }
  const summary = await git(run, gitPath, repoDir, ['diff', '--summary', ...range]);
  const reshaped = /^ (create mode|mode change) /m.test(summary.stdout);
  return {
    files,
    addedLines,
    onlyRemovals: files.length > 0 && addedLines === 0 && !binary && !reshaped,
  };
}

// The text of each changed package.json and package-lock.json before and after a change,
// as { path: { before, after } }. A side is null when the file did not exist there.
export async function readManifests({ run, gitPath, repoDir, baseSha, sha, files }) {
  const manifests = {};
  const show = async (commit, path) => {
    const result = await git(run, gitPath, repoDir, ['--literal-pathspecs', 'show', `${commit}:${path}`], { allowFailure: true });
    return result.code === 0 ? result.stdout : null;
  };
  for (const path of files) {
    if (!['package.json', 'package-lock.json'].includes(path.split('/').pop())) continue;
    manifests[path] = { before: await show(baseSha, path), after: await show(sha, path) };
  }
  return manifests;
}

const baseName = (path) => path.split('/').pop();

export function isTestFile(path) {
  const anchored = `/${path}`;
  return (
    ['/test/', '/tests/', '/__tests__/', 'Tests/'].some((part) => anchored.includes(part)) ||
    ['.test.', '.spec.', '_test.'].some((part) => baseName(path).includes(part)) ||
    baseName(path).endsWith('Tests.swift')
  );
}

// Matched against lower-cased paths.
const has = (path, ...folders) => folders.some((folder) => `/${path}`.includes(`/${folder}/`));
const named = (path, pattern) => pattern.test(baseName(path));
const SENSITIVE = [
  ['Changes CI workflows', (path) =>
    has(path, '.github', 'ci', '.circleci', '.buildkite') ||
    named(path, /^(\.gitlab-ci\.yml|jenkinsfile|azure-pipelines\.yml|\.travis\.yml|bitbucket-pipelines\.yml)$/)],
  ['Changes how the checks run', (path) => named(path, /^(makefile|justfile|taskfile\.ya?ml)$/)],
  ['Changes how packages or git behave', (path) =>
    has(path, '.husky', '.githooks') ||
    named(path, /^(\.npmrc|\.yarnrc.*|\.pnpmfile\.cjs|\.gitmodules|\.gitattributes|lefthook\.ya?ml|\.pre-commit-config\.ya?ml)$/)],
  ['Changes agent instructions', (path) =>
    has(path, '.claude', '.codex', '.cursor') || named(path, /^(agents\.md|claude\.md|gemini\.md|\.mcp\.json)$/)],
  ['Changes deploy configuration', (path) =>
    named(path, /^(dockerfile(\..+)?|docker-compose.*|wrangler\..+|launcher\.json|fly\.toml|vercel\.json|netlify\.toml|procfile|serverless\.ya?ml|.+\.tf)$/)],
  ['Changes environment files', (path) => baseName(path).startsWith('.env')],
  ['Changes database migrations', (path) => path.split('/').some((part) => part === 'migrations' || part === 'migrate')],
  ['Touches sign-in or payment code', (path) => /auth|login|session|password|token|payment|billing|stripe|payout/.test(path)],
];

// Why these files must not be merged unattended, or null. A passing check says little
// about any of them.
export function sensitiveReason(paths) {
  const lowered = paths.map((path) => path.toLowerCase());
  for (const [reason, matches] of SENSITIVE) {
    if (lowered.some(matches)) return reason;
  }
  return null;
}

// [major, minor] of the lowest version a range allows, or null when it is not a plain range.
function versionOf(range) {
  const match = /^[\^~>=<v\s]*(\d+)(?:\.(\d+))?/.exec(String(range ?? ''));
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

export function isMajorUpgrade(beforePkg, afterPkg) {
  if (!beforePkg || !afterPkg) return false;
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(afterPkg[group] ?? {})) {
      const was = versionOf(beforePkg[group]?.[name]);
      const is = versionOf(range);
      if (!was || !is) continue;
      if (is[0] > was[0]) return true;
      if (is[0] === 0 && was[0] === 0 && is[1] > was[1]) return true; // before 1.0, a minor bump may break
    }
  }
  return false;
}

// Runs the repository's checks on the old code with only the change's test files added.
// If that fails, the tests really do exercise the change.
export async function provesItself({ run, checkRunFor, gitPath, repoDir, proofDir, baseSha, sha, files, fs, timeoutMs, baselinePass }) {
  const testFiles = files.filter(isTestFile);
  if (testFiles.length === 0) return { proven: false, note: 'The change has no test.' };
  // If the old code already failed, a failure here would say nothing about the new tests.
  if (baselinePass !== true) return { proven: false, note: 'The checks were already failing before the change.' };
  rmSync(proofDir, { recursive: true, force: true });
  try {
    // The folder is built from the job's own clone before anything untrusted runs in it.
    await git(run, gitPath, repoDir, ['clone', '--quiet', '--no-hardlinks', repoDir, proofDir]);
    await git(run, gitPath, proofDir, ['checkout', '--quiet', '--detach', baseSha]);
    await git(run, gitPath, proofDir, ['remote', 'remove', 'origin']);
    for (const file of testFiles) {
      // A test file the change deleted has nothing to bring over.
      await git(run, gitPath, proofDir, ['--literal-pathspecs', 'checkout', '--quiet', sha, '--', file], { allowFailure: true });
    }
    if (!detectCheck(proofDir, fs)) return { proven: false, note: 'The repository has no checks to run the test with.' };
    const check = await runCheck({ run: checkRunFor(proofDir), dir: proofDir, fs, timeoutMs });
    if (check.installFailed) return { proven: false, note: 'The old code could not be installed to run the test.' };
    return check.pass === false
      ? { proven: true, note: 'The new test fails without the change.' }
      : { proven: false, note: 'The new test passes without the change.' };
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
  }
}

const DOCS = /(\.(md|mdx|txt|rst|adoc)$|^docs\/|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)[^/]*$)/i;
const DEP_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const PLAIN_VERSION = /^[\^~]?(\d+)\.(\d+)\.\d+$/;

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// A package.json differs only by patch or minor bumps of dependencies it already had.
function onlyBumps(before, after) {
  if (!before || !after) return false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!DEP_GROUPS.includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
  }
  for (const group of DEP_GROUPS) {
    const was = before[group] ?? {};
    const is = after[group] ?? {};
    if (JSON.stringify(Object.keys(was).sort()) !== JSON.stringify(Object.keys(is).sort())) return false;
    for (const name of Object.keys(is)) {
      if (was[name] === is[name]) continue;
      const from = PLAIN_VERSION.exec(String(was[name]));
      const to = PLAIN_VERSION.exec(String(is[name]));
      if (!from || !to || from[1] !== to[1]) return false;
      if (to[1] === '0' && from[2] !== to[2]) return false;
    }
  }
  return true;
}

const LOCKED_VERSION = /^(\d+)\.(\d+)\.\d+$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The package a lockfile entry installs, from its path, or null for anything that is not
// an installed package (a workspace link, for example).
function lockedName(key) {
  const at = key.lastIndexOf('node_modules/');
  return at === -1 ? null : key.slice(at + 'node_modules/'.length);
}

// A package-lock.json differs only by small version bumps of packages it already listed,
// each still downloaded from the public registry under its own name and version.
function lockOnlyBumps(before, after) {
  if (!before || !after || typeof before.packages !== 'object' || typeof after.packages !== 'object') return false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== 'packages' && !same(before[key], after[key])) return false;
  }
  if (!same(Object.keys(before.packages).sort(), Object.keys(after.packages).sort())) return false;
  for (const [key, is] of Object.entries(after.packages)) {
    const was = before.packages[key];
    // The root entry mirrors package.json, which is checked on its own.
    if (key === '' || same(was, is)) continue;
    const name = lockedName(key);
    const from = LOCKED_VERSION.exec(String(was?.version));
    const to = LOCKED_VERSION.exec(String(is?.version));
    if (!name || !from || !to || from[1] !== to[1] || (to[1] === '0' && from[2] !== to[2])) return false;
    if (is.resolved !== `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${is.version}.tgz`) return false;
    if (typeof is.integrity !== 'string' || !/^sha\d+-/.test(is.integrity)) return false;
    if (is.hasInstallScript && !was.hasInstallScript) return false;
    if (is.link || was.link) return false;
  }
  return true;
}

function isDependencyPatch(files, manifests) {
  return files.every((path) => {
    const entry = manifests[path];
    if (!entry || entry.before == null || entry.after == null) return false;
    if (baseName(path) === 'package.json') return onlyBumps(parse(entry.before), parse(entry.after));
    if (baseName(path) === 'package-lock.json') return lockOnlyBumps(parse(entry.before), parse(entry.after));
    return false;
  });
}

// A change may skip the test rule only if what it touches fits what the model called it.
function fitsKind(kind, stats, manifests) {
  if (kind === 'docs') return stats.files.every((path) => DOCS.test(path));
  if (kind === 'dependency-patch') return isDependencyPatch(stats.files, manifests);
  if (kind === 'dead-code') return stats.onlyRemovals === true;
  return false;
}

const packageFiles = (manifests) =>
  Object.entries(manifests)
    .filter(([path]) => baseName(path) === 'package.json')
    .map(([, entry]) => ({ before: parse(entry.before), after: parse(entry.after) }));
const sameScripts = (a, b) => JSON.stringify(a?.scripts ?? {}) === JSON.stringify(b?.scripts ?? {});

// Returns { merge, reason }: the first rule that applies decides. `manifests` maps each
// changed package.json or package-lock.json to its text { before, after }.
export function decide({ change, stats, before, after, proof, manifests = {} }) {
  const propose = (reason) => ({ merge: false, reason });
  const { files } = stats;
  if (files.length === 0) return propose('No change was made');
  if (after.checksPass !== true) return propose("The repository's checks do not pass with the change");
  if (before?.tests && after.tests && after.tests.ran < before.tests.ran) return propose('Fewer tests ran than before');
  const sensitive = sensitiveReason(files);
  if (sensitive) return propose(sensitive);
  const packages = packageFiles(manifests);
  if (packages.some((pkg) => !sameScripts(pkg.before, pkg.after))) return propose('Changes how the checks run');
  if (change.majorUpgrade || packages.some((pkg) => isMajorUpgrade(pkg.before, pkg.after))) return propose('Major version upgrade');
  const needsProof = change.kind === 'fix' || !fitsKind(change.kind, stats, manifests);
  if (needsProof && !proof.proven) return propose('No test proves the change');
  return { merge: true, reason: null };
}
