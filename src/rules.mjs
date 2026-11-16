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

// The files a change touches (a rename counts as both names) and how many lines it adds.
export async function changeStats({ run, gitPath, repoDir, baseSha, sha }) {
  const diff = await git(run, gitPath, repoDir, ['diff', '--numstat', '--no-renames', '-z', baseSha, sha]);
  const files = [];
  let addedLines = 0;
  for (const record of diff.stdout.split('\0').filter(Boolean)) {
    const [added, , ...path] = record.split('\t');
    files.push(path.join('\t'));
    if (/^\d+$/.test(added)) addedLines += Number(added);
  }
  return { files, addedLines };
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

const DEPLOY_FILES = /^(Dockerfile(\..+)?|docker-compose.*|wrangler\..+|launcher\.json|fly\.toml|vercel\.json|netlify\.toml)$/;
const SIGN_IN_OR_PAYMENT = /auth|login|session|password|token|payment|billing|stripe|payout/i;
const SENSITIVE = [
  ['Changes CI workflows', (path) => path.startsWith('.github/') || path.startsWith('ci/')],
  ['Changes deploy configuration', (path) => DEPLOY_FILES.test(baseName(path))],
  ['Changes environment files', (path) => baseName(path).startsWith('.env')],
  ['Changes database migrations', (path) => path.split('/').some((part) => part === 'migrations' || part === 'migrate')],
  ['Touches sign-in or payment code', (path) => SIGN_IN_OR_PAYMENT.test(path)],
];

// Why these files must not be merged unattended, or null. A passing check says little
// about any of them.
export function sensitiveReason(paths) {
  for (const [reason, matches] of SENSITIVE) {
    if (paths.some(matches)) return reason;
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
export async function provesItself({ run, checkRunFor, gitPath, repoDir, proofDir, baseSha, sha, files, fs, timeoutMs }) {
  const testFiles = files.filter(isTestFile);
  if (testFiles.length === 0) return { proven: false, note: 'The change has no test.' };
  rmSync(proofDir, { recursive: true, force: true });
  try {
    // The folder is built from the job's own clone before anything untrusted runs in it.
    await git(run, gitPath, repoDir, ['clone', '--quiet', '--no-hardlinks', repoDir, proofDir]);
    await git(run, gitPath, proofDir, ['checkout', '--quiet', '--detach', baseSha]);
    await git(run, gitPath, proofDir, ['remote', 'remove', 'origin']);
    for (const file of testFiles) {
      // A test file the change deleted has nothing to bring over.
      await git(run, gitPath, proofDir, ['checkout', '--quiet', sha, '--', file], { allowFailure: true });
    }
    if (!detectCheck(proofDir, fs)) return { proven: false, note: 'The repository has no checks to run the test with.' };
    const check = await runCheck({ run: checkRunFor(proofDir), dir: proofDir, fs, timeoutMs });
    return check.pass === false
      ? { proven: true, note: 'The new test fails without the change.' }
      : { proven: false, note: 'The new test passes without the change.' };
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
  }
}

const DOCS = /(\.(md|mdx|txt|rst|adoc)$|^docs\/|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)[^/]*$)/i;
const MANIFESTS = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Package\.swift|Package\.resolved|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/;

// A change may skip the test rule only if its files fit what the model called it.
function fitsKind(kind, files, addedLines) {
  if (kind === 'docs') return files.every((path) => DOCS.test(path));
  if (kind === 'dependency-patch') return files.every((path) => MANIFESTS.test(baseName(path)));
  if (kind === 'dead-code') return addedLines === 0;
  return false;
}

const sameScripts = (a, b) => JSON.stringify(a?.scripts ?? {}) === JSON.stringify(b?.scripts ?? {});

// Returns { merge, reason }: the first rule that applies decides.
export function decide({ change, files, addedLines, before, after, proof, pkgBefore, pkgAfter }) {
  const propose = (reason) => ({ merge: false, reason });
  if (files.length === 0) return propose('No change was made');
  if (after.checksPass !== true) return propose("The repository's checks do not pass with the change");
  if (before?.tests && after.tests && after.tests.ran < before.tests.ran) return propose('Fewer tests ran than before');
  const sensitive = sensitiveReason(files);
  if (sensitive) return propose(sensitive);
  if (!sameScripts(pkgBefore, pkgAfter)) return propose('Changes how the checks run');
  if (change.majorUpgrade || isMajorUpgrade(pkgBefore, pkgAfter)) return propose('Major version upgrade');
  const needsProof = change.kind === 'fix' || !fitsKind(change.kind, files, addedLines);
  if (needsProof && !proof.proven) return propose('No test proves the change');
  return { merge: true, reason: null };
}
