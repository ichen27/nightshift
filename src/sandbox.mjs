// Everything the model writes, and every check the job runs on code the model has touched,
// runs through here: a short allow-listed environment with no credentials in it and, on
// macOS, an OS sandbox that can write only to the project's own working folders and cannot
// read the places credentials and private files live.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// The ports the system hands out when a program asks for "any free port", which is what a
// test's own server does. Services people run on purpose sit on ordinary ports below these.
const AUTOMATIC_PORTS = [49152, 65535];
const PORTS_PER_RULE = 4096; // A single rule with the whole range does not compile.
const loopback = (port) => `(remote ip "localhost:${port}")`;
const AUTOMATIC_PORT_RULES = (() => {
  const rules = [];
  for (let from = AUTOMATIC_PORTS[0]; from <= AUTOMATIC_PORTS[1]; from += PORTS_PER_RULE) {
    const ports = [];
    for (let port = from; port < from + PORTS_PER_RULE && port <= AUTOMATIC_PORTS[1]; port += 1) ports.push(loopback(port));
    rules.push(`(allow network-outbound ${ports.join(' ')})`);
  }
  return rules;
})();
// Ways out of a sandbox that are neither files nor sockets: asking another program to do
// something on the sandboxed one's behalf.
// (Two launch-services names are deliberately not here: a headless browser needs one to
// start and the other to work out the type of a file it uploads. Launching things through
// them is what `(deny lsopen)` stops.)
const BLOCKED_SERVICES = [
  'com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.securityd.xpc', 'com.apple.security.agent',
  'com.apple.pasteboard.1', 'com.apple.lsd.open',
];
const BLOCKED_TOOLS = [
  '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/security', '/bin/launchctl', '/usr/bin/pbpaste', '/usr/bin/pbcopy',
  '/usr/sbin/screencapture',
];
const TEMP_DIRS = ['/private/tmp', '/private/var/folders', '/private/var/tmp'];
const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'];
// Relative to the home folder.
const PRIVATE_HOME_PATHS = [
  // Sign-ins and keys.
  '.config', '.git-credentials', '.gitconfig', '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube', '.netrc', '.npmrc',
  '.claude', '.claude.json', '.codex', 'Library/Keychains', 'Library/Application Support', 'Library/Cookies',
  // Shell start-up files and history, where tokens tend to end up.
  '.zshrc', '.zshenv', '.zprofile', '.zsh_history', '.bashrc', '.bash_profile', '.bash_history', '.profile',
  // Personal files.
  'Library/Mail', 'Library/Messages', 'Documents', 'Desktop', 'Downloads',
];

export function sandboxSupported({ platform = process.platform, existsSync: exists = existsSync } = {}) {
  return platform === 'darwin' && exists(SANDBOX_EXEC);
}

function quote(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /["\\\n\r\0]/.test(path)) {
    throw new Error(`Not a usable sandbox path: ${JSON.stringify(path)}`);
  }
  return `(subpath "${path}")`;
}

// A Seatbelt profile. Later rules win, so the readable list is applied after the denied one.
// Outbound network is closed except: loopback on ports the system hands out (a project's own
// test servers, and the job's proxy), loopback on any listed port, and sockets inside the
// given folders. Launching apps, scripting other apps, creating background jobs, and
// reaching the keychain or the clipboard are closed too.
export function sandboxProfile({ writable, denyRead, readable, sockets = writable, allowPorts = [] }) {
  if (allowPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('A sandbox port must be a whole number from 1 to 65535.');
  }
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(quote).join(' ')} (regex #"^/dev/"))`,
  ];
  if (denyRead.length) lines.push(`(deny file-read-data ${denyRead.map(quote).join(' ')})`);
  if (readable.length) lines.push(`(allow file-read-data ${readable.map(quote).join(' ')})`);
  lines.push('(deny network-outbound)', ...AUTOMATIC_PORT_RULES);
  const listed = allowPorts.filter((port) => port < AUTOMATIC_PORTS[0]);
  if (listed.length) lines.push(`(allow network-outbound ${listed.map(loopback).join(' ')})`);
  if (sockets.length) lines.push(`(allow network-outbound ${sockets.map(quote).join(' ')})`);
  lines.push(
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny job-creation)',
    `(deny mach-lookup ${BLOCKED_SERVICES.map((name) => `(global-name "${name}")`).join(' ')})`,
    `(deny process-exec ${BLOCKED_TOOLS.map((path) => `(literal "${path}")`).join(' ')})`,
  );
  return `${lines.join('\n')}\n`;
}

// Only what a build needs, with every route to stored credentials pointed at nothing.
export function restrictedEnv(env, { emptyDir, cacheDir, proxyUrl = null, extra = {} }) {
  const out = {};
  for (const key of KEEP_ENV) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return {
    ...out,
    CI: 'true',
    TMPDIR: join(cacheDir, 'tmp'),
    XDG_CACHE_HOME: join(cacheDir, 'xdg'),
    npm_config_cache: join(cacheDir, 'npm'),
    npm_config_userconfig: '/dev/null',
    GH_CONFIG_DIR: emptyDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(proxyUrl
      ? {
          HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
          NO_PROXY: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1',
        }
      : {}),
    ...extra,
  };
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// Returns a function with the same result shape as exec's run(). Each call names the
// folders it may write to and a private cache folder.
export function createRestrictedRun({
  run, sandbox, home, dataDir, emptyDir, env, settings, proxyUrl = null,
  ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
  writeProfile = null,
}) {
  const custom = settings?.sandbox ?? {};
  // The profile is large, and it is kept in the data folder, which sandboxed commands can
  // neither read nor write, so one command cannot loosen the rules for the next.
  const saveProfile = writeProfile ?? ((text) => {
    const dir = join(dataDir, 'sandbox-profiles');
    const file = join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.sb`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text, { mode: 0o600 });
    }
    return file;
  });
  return function restrictedRun(argv, { cwd, timeoutMs, writable = [], cacheDir, env: extraEnv = {}, pathPrefix = [] } = {}) {
    if (pathPrefix.some((folder) => typeof folder !== 'string' || !folder.startsWith('/') || folder.includes(':'))) {
      throw new Error('Tool folders must be absolute paths.');
    }
    for (const dir of [emptyDir, cacheDir, join(cacheDir, 'tmp'), join(cacheDir, 'npm'), join(cacheDir, 'xdg'), ...writable]) {
      ensureDir(dir);
    }
    const runEnv = restrictedEnv(env, { emptyDir: real(emptyDir), cacheDir: real(cacheDir), proxyUrl, extra: extraEnv });
    // A project that needs its own toolchain (another Node version, say) gets it first on PATH.
    if (pathPrefix.length) runEnv.PATH = [...pathPrefix, runEnv.PATH].filter(Boolean).join(':');
    if (!sandbox) return run(argv, { cwd, timeoutMs, env: runEnv });
    const canWrite = [...writable, cacheDir, ...TEMP_DIRS, ...(custom.allowWrite ?? [])].map(real);
    const profile = sandboxProfile({
      writable: canWrite,
      denyRead: [dataDir, ...PRIVATE_HOME_PATHS.map((path) => join(home, path)), ...(custom.denyRead ?? [])].map(real),
      readable: [...writable, cacheDir, emptyDir, ...(custom.allowRead ?? [])].map(real),
      // Not the shared temporary folders: other programs keep their own sockets there.
      sockets: [...writable, cacheDir].map(real),
      allowPorts: custom.allowPorts ?? [],
    });
    return run([SANDBOX_EXEC, '-f', saveProfile(profile), ...argv], { cwd, timeoutMs, env: runEnv });
  };
}
