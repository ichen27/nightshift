// Command line for the nightly job:  node src/cli.mjs run [--only owner/repo] [--dry-run]
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadSettings } from './config.mjs';
import { run } from './exec.mjs';
import { createGithub } from './github.mjs';
import { isProcessAlive } from './lock.mjs';
import { RunInProgress, realSteps, runNight } from './nightly.mjs';
import { createProjects } from './projects.mjs';
import { createEgressProxy } from './proxy.mjs';
import { LinkError, parseRepoLink } from './repo-link.mjs';
import { countEntries } from './report.mjs';
import { createRestrictedRun, sandboxSupported } from './sandbox.mjs';
import { createStore } from './store.mjs';

export const DEFAULT_ALLOWED_HOSTS = ['api.anthropic.com', 'registry.npmjs.org'];
const USAGE = `Usage: node src/cli.mjs run [--only owner/repo] [--dry-run]

  run          Visit tonight's projects and write the report.
  --only       Visit just this project, whatever the rotation says.
  --dry-run    Inspect and report only: no changes, no pull requests, no merges.`;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run') throw new UsageError(USAGE);
  const args = { command: 'run', only: null, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--dry-run') args.dryRun = true;
    else if (rest[i] === '--only' && rest[i + 1] !== undefined) {
      try {
        const { owner, repo } = parseRepoLink(rest[(i += 1)]);
        args.only = `${owner}/${repo}`;
      } catch (error) {
        if (error instanceof LinkError) throw new UsageError(`--only needs a repository, such as owner/repo.\n\n${USAGE}`);
        throw error;
      }
    } else throw new UsageError(USAGE);
  }
  return args;
}

export function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The long-lived token from `claude setup-token`, kept in the data folder and nowhere else.
export function readToken(dataDir, files = fs) {
  try {
    return files.readFileSync(join(dataDir, 'claude-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function readRegistry(path) {
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  const config = loadConfig(env);
  const store = createStore(config.dataDir);
  const settings = loadSettings(store);
  const sandbox = sandboxSupported();
  const proxy = createEgressProxy({ allowHosts: [...DEFAULT_ALLOWED_HOSTS, ...(settings.sandbox?.allowHosts ?? [])] });
  if (sandbox) await proxy.start();
  const github = createGithub({ run, ghPath: config.ghPath, gitPath: config.gitPath });
  const deps = {
    dataDir: config.dataDir, gitPath: config.gitPath, ghPath: config.ghPath, claudePath: config.claudePath, nodePath: config.nodePath,
    settings, store, github,
    projects: createProjects({ store, github }),
    run,
    restrictedRun: createRestrictedRun({
      run, sandbox, proxyUrl: sandbox ? proxy.url : null, home: homedir(), dataDir: config.dataDir,
      emptyDir: join(config.dataDir, 'empty'), env, settings,
    }),
    fs,
    now: () => new Date(), pid: process.pid, isAlive: isProcessAlive,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readRegistry: () => readRegistry(settings.launcherRegistry),
    claudeToken: readToken(config.dataDir),
    sandboxOk: sandbox || settings.allowUnsandboxed === true,
    blockedHosts: () => [...proxy.denied],
    log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    steps: realSteps,
  };
  try {
    const report = await runNight({ deps, date: localDate(new Date()), only: args.only, dryRun: args.dryRun });
    const counts = countEntries(report);
    deps.log(`Run ${report.outcome}${report.reason ? `: ${report.reason.replace(/\.$/, '')}` : ''}. Found ${counts.found}, proposed ${counts.proposed}, did ${counts.did}, rolled back ${counts.rolledBack}.`);
    return 0;
  } catch (error) {
    if (error instanceof RunInProgress) {
      console.error(error.message);
      return 3;
    }
    throw error;
  } finally {
    if (sandbox) await proxy.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Nightshift could not run: ${error.message}`);
      process.exit(1);
    },
  );
}
