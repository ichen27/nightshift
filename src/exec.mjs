// Runs a command given as an argv array. There is no shell, so arguments are never
// interpreted. A non-zero exit, a missing command and a timeout are all returned, not thrown.
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 20 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

function killTree(child, signal) {
  // The child leads its own process group, so this reaches anything it started.
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export function run(argv, { cwd, timeoutMs, env } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string')) {
    return Promise.reject(new TypeError('run() needs a non-empty argv array of strings.'));
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = `Could not run ${argv[0]}: ${error.message}`;
      finish(127);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += `Could not run ${argv[0]}: ${error.message}`;
      finish(127);
    });
    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 128 : 1));
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);
    }
  });
}
