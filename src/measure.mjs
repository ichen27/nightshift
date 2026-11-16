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

const SUMMARIES = [
  // node --test, TAP and spec reporters
  (text) => {
    const ran = lastNumber(text, /^(?:#|ℹ) tests (\d+)\s*$/gm);
    const passed = lastNumber(text, /^(?:#|ℹ) pass (\d+)\s*$/gm);
    return ran !== null && passed !== null ? { ran, passed } : null;
  },
  // Jest: "Tests:  1 failed, 11 passed, 12 total"
  (text) => {
    const line = lastMatch(text, /^Tests:\s+(.*?)(\d+) total\s*$/gm);
    if (!line) return null;
    const passed = /(\d+) passed/.exec(line[1]);
    return { ran: Number(line[2]), passed: passed ? Number(passed[1]) : 0 };
  },
  // Vitest: "Tests  1 failed | 11 passed (12)"
  (text) => {
    const line = lastMatch(text, /^\s*Tests\s+(.*?)\((\d+)\)\s*$/gm);
    if (!line) return null;
    const passed = /(\d+) passed/.exec(line[1]);
    return { ran: Number(line[2]), passed: passed ? Number(passed[1]) : 0 };
  },
  // XCTest: "Executed 12 tests, with 1 failure"
  (text) => {
    const line = lastMatch(text, /Executed (\d+) tests?, with (\d+) failures?/g);
    return line ? { ran: Number(line[1]), passed: Number(line[1]) - Number(line[2]) } : null;
  },
];

function lastMatch(text, pattern) {
  let last = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}
function lastNumber(text, pattern) {
  const match = lastMatch(text, pattern);
  return match ? Number(match[1]) : null;
}

// { ran, passed } from a test runner's summary, or null when the output is not recognized.
export function parseTestCounts(output) {
  const text = String(output ?? '');
  for (const read of SUMMARIES) {
    const counts = read(text);
    if (counts) return counts;
  }
  return null;
}

// Runs the repository's checks. Dependencies are installed from the lockfile first when the
// check is an npm script, because a fresh clone has none.
export async function runCheck({ run, dir, fs, timeoutMs }) {
  const checkCommand = detectCheck(dir, fs);
  if (!checkCommand) return { checkCommand: null, pass: null, output: '' };
  if (checkCommand[0] === 'npm' && fs.existsSync(join(dir, 'package-lock.json'))) {
    const install = await run(['npm', 'ci'], { cwd: dir, timeoutMs });
    if (install.code !== 0 || install.timedOut) {
      return { checkCommand, pass: false, output: `${install.stdout}\n${install.stderr}` };
    }
  }
  const result = await run(checkCommand, { cwd: dir, timeoutMs });
  return {
    checkCommand,
    pass: result.code === 0 && !result.timedOut,
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

export async function measure({ run, dir, fs, timeoutMs }) {
  const check = await runCheck({ run, dir, fs, timeoutMs });
  return {
    checkCommand: check.checkCommand,
    checksPass: check.pass,
    tests: check.pass === null ? null : parseTestCounts(check.output),
    vulnerabilities: await countVulnerabilities({ run, dir, fs, timeoutMs }),
  };
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
