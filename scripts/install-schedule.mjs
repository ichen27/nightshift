// Installs or removes the nightly schedule on macOS (a launchd job for the signed-in user).
//
//   NIGHTSHIFT_DATA_DIR=/path/to/data node scripts/install-schedule.mjs install
//   NIGHTSHIFT_DATA_DIR=/path/to/data node scripts/install-schedule.mjs remove
//
// The job runs `node src/cli.mjs run` from this checkout every night at 2:00 local time.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { run } from '../src/exec.mjs';
import { createStore } from '../src/store.mjs';

export const LABEL = 'com.ichen27.nightshift-run';
const TEMPLATE = new URL('../launchd/run.plist.template', import.meta.url);

const escapeXml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist({ nodePath, repoDir, dataDir, logDir, path, home, hour = 2, minute = 0 }) {
  const validTime = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59;
  if (!validTime) throw new Error('The schedule time must be an hour from 0 to 23 and a minute from 0 to 59.');
  const fill = { LABEL, NODE: nodePath, REPO: repoDir, DATA: dataDir, LOGS: logDir, PATH: path, HOME: home, HOUR: hour, MINUTE: minute };
  return readFileSync(TEMPLATE, 'utf8').replace(/\{\{([A-Z]+)\}\}/g, (_match, key) => escapeXml(fill[key]));
}

// launchd gives a job almost no PATH, so the job is told where the tools are.
export function schedulePath({ execPath, home }) {
  const folders = [dirname(execPath), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(folders)].join(':');
}

async function main(command) {
  if (!['install', 'remove'].includes(command)) {
    console.error('Usage: node scripts/install-schedule.mjs install|remove');
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error('The built-in schedule uses launchd and is macOS only. On other systems, run `node src/cli.mjs run` from your own scheduler.');
    return 1;
  }
  const config = loadConfig();
  const store = createStore(config.dataDir);
  const home = homedir();
  const domain = `gui/${userInfo().uid}`;
  const plistPath = join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  // A job that is not loaded cannot be unloaded; that is fine either way.
  await run(['/bin/launchctl', 'bootout', `${domain}/${LABEL}`]);

  if (command === 'remove') {
    rmSync(plistPath, { force: true });
    store.remove('schedule.json');
    console.log('The nightly schedule is removed.');
    return 0;
  }
  // launchd cannot open log files on some external disks, so logs stay in the home folder.
  const logDir = join(home, 'Library/Logs/nightshift');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist({
    nodePath: process.execPath,
    repoDir: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
    dataDir: config.dataDir,
    logDir,
    path: schedulePath({ execPath: process.execPath, home }),
    home,
  }));
  const loaded = await run(['/bin/launchctl', 'bootstrap', domain, plistPath]);
  if (loaded.code !== 0) {
    console.error(`launchd refused the job: ${loaded.stderr.trim()}`);
    return 1;
  }
  store.write('schedule.json', { hour: 2, minute: 0, installedAt: new Date().toISOString() });
  console.log(`The nightly run is scheduled for 2:00 AM. Logs: ${join(logDir, 'run.log')}`);
  console.log(`Check it with: launchctl print ${domain}/${LABEL}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
