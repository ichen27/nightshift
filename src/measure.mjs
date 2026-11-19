// Measures a working copy: do its own checks pass, how many tests ran and passed, and how
// many known-vulnerable dependencies it has. The job runs this before and after a change,
// so impact is something the job measured, not something the model reported.
import { join } from 'node:path';

const NPM_PLACEHOLDER = /no test specified/i;

function readPackage(dir, fs) {
  try {
    return JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The command that runs a repository's own checks, or null when none is recognized.
export function detectCheck(dir, fs) {
  if (fs.existsSync(join(dir, 'ci/run.sh'))) return ['bash', 'ci/run.sh'];
  const scripts = readPackage(dir, fs)?.scripts ?? {};
  if (typeof scripts.ci === 'string') return ['npm', 'run', 'ci'];
  if (typeof scripts.test === 'string' && !NPM_PLACEHOLDER.test(scripts.test)) return ['npm', 'test'];
  if (fs.existsSync(join(dir, 'Package.swift'))) return ['swift', 'test'];
  return null;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const all = (text, pattern) => [...text.matchAll(pattern)];
const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);
const passedIn = (text) => Number(/(\d+) passed/.exec(text)?.[1] ?? 0);

// One reader per test runner. Each returns { ran, passed } or null. A repository may run
// several suites in one check, so every summary a runner printed is added up.
const SUMMARIES = [
  // node --test, TAP and spec reporters
  (text) => {
    const ran = all(text, /^(?:#|ℹ) tests (\d+)\s*$/gm);
    const passed = all(text, /^(?:#|ℹ) pass (\d+)\s*$/gm);
    return ran.length && passed.length ? { ran: sum(ran.map((m) => Number(m[1]))), passed: sum(passed.map((m) => Number(m[1]))) } : null;
  },
  // Jest: "Tests:  1 failed, 11 passed, 12 total"
  (text) => {
    const lines = all(text, /^Tests:\s+(.*?)(\d+) total\s*$/gm);
    return lines.length ? { ran: sum(lines.map((m) => Number(m[2]))), passed: sum(lines.map((m) => passedIn(m[1]))) } : null;
  },
  // Vitest: "Tests  1 failed | 11 passed (12)"
  (text) => {
    const lines = all(text, /^\s*Tests\s+(.*?)\((\d+)\)\s*$/gm);
    return lines.length ? { ran: sum(lines.map((m) => Number(m[2]))), passed: sum(lines.map((m) => passedIn(m[1]))) } : null;
  },
  // XCTest prints a total per suite and then an overall one, so only the last counts.
  (text) => {
    const line = all(text, /Executed (\d+) tests?, with (\d+) failures?/g).pop();
    return line ? { ran: Number(line[1]), passed: Number(line[1]) - Number(line[2]) } : null;
  },
];

// { ran, passed } across every test summary in a check's output, or null when none is recognized.
export function parseTestCounts(output) {
  const text = String(output ?? '').replace(ANSI, '');
  const found = SUMMARIES.map((read) => read(text)).filter(Boolean);
  if (found.length === 0) return null;
  return { ran: sum(found.map((counts) => counts.ran)), passed: sum(found.map((counts) => counts.passed)) };
}

const MAX_PACKAGE_DEPTH = 3;

// Folders holding a package-lock.json: the root first, then nested packages. A repository
// can have several, and each needs its own install before the checks mean anything.
function packageDirs(dir, fs, depth = 0) {
  const found = fs.existsSync(join(dir, 'package-lock.json')) ? [dir] : [];
  if (depth >= MAX_PACKAGE_DEPTH) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.filter((item) => item.isDirectory() && item.name !== 'node_modules' && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    found.push(...packageDirs(join(dir, entry.name), fs, depth + 1));
  }
  return found;
}

// Runs the repository's checks. When the check is an npm script, dependencies are installed
// from each lockfile first, because a fresh clone has none. A repository with its own
// ci/run.sh installs for itself.
export async function runCheck({ run, dir, fs, timeoutMs }) {
  const checkCommand = detectCheck(dir, fs);
  if (!checkCommand) return { checkCommand: null, pass: null, installFailed: false, output: '' };
  if (checkCommand[0] === 'npm') {
    for (const packageDir of packageDirs(dir, fs)) {
      const install = await run(['npm', 'ci'], { cwd: packageDir, timeoutMs });
      if (install.code !== 0 || install.timedOut) {
        return { checkCommand, pass: false, installFailed: true, output: `${install.stdout}\n${install.stderr}` };
      }
    }
  }
  const result = await run(checkCommand, { cwd: dir, timeoutMs });
  return {
    checkCommand,
    pass: result.code === 0 && !result.timedOut,
    installFailed: false,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

async function countVulnerabilities({ run, dir, fs, timeoutMs }) {
  if (!fs.existsSync(join(dir, 'package-lock.json'))) return null;
  const audit = await run(['npm', 'audit', '--json'], { cwd: dir, timeoutMs });
  try {
    const total = JSON.parse(audit.stdout).metadata.vulnerabilities.total;
    return Number.isInteger(total) ? total : null;
  } catch {
    return null;
  }
}

const FAILURE_OUTPUT_MAX = 4000;

// `failureOutput` is present only when the check failed: the end of what it printed, so a
// person can see which test broke. It comes from code the job does not trust; treat it as text.
export async function measure({ run, dir, fs, timeoutMs }) {
  const check = await runCheck({ run, dir, fs, timeoutMs });
  const measured = {
    checkCommand: check.checkCommand,
    checksPass: check.pass,
    tests: check.pass === null ? null : parseTestCounts(check.output),
    vulnerabilities: await countVulnerabilities({ run, dir, fs, timeoutMs }),
  };
  if (check.pass === false) measured.failureOutput = check.output.replace(ANSI, '').trimEnd().slice(-FAILURE_OUTPUT_MAX);
  return measured;
}

const NOT_MEASURED = 'not measured';
const yesNo = (value) => (value === null || value === undefined ? null : value ? 'yes' : 'no');

// The measurements that differ between two runs, as [{ name, before, after }].
export function diffMeasures(before, after) {
  const rows = [
    ['Checks pass', yesNo(before.checksPass), yesNo(after.checksPass)],
    ['Tests run', before.tests?.ran ?? null, after.tests?.ran ?? null],
    ['Tests passed', before.tests?.passed ?? null, after.tests?.passed ?? null],
    ['Known vulnerable dependencies', before.vulnerabilities ?? null, after.vulnerabilities ?? null],
  ];
  return rows
    .filter(([, was, is]) => was !== is)
    .map(([name, was, is]) => ({ name, before: was ?? NOT_MEASURED, after: is ?? NOT_MEASURED }));
}
