// Everything the model writes, and every check the job runs on code the model has touched,
// runs through here: a short allow-listed environment with no credentials in it and, on
// macOS, an OS sandbox that can write only to the project's own working folders and cannot
// read the places credentials and private files live.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

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
// Outbound network is closed except loopback (a project's own tests, and the job's proxy)
// and sockets inside the given folders.
export function sandboxProfile({ writable, denyRead, readable, sockets = writable }) {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(quote).join(' ')} (regex #"^/dev/"))`,
  ];
  if (denyRead.length) lines.push(`(deny file-read-data ${denyRead.map(quote).join(' ')})`);
  if (readable.length) lines.push(`(allow file-read-data ${readable.map(quote).join(' ')})`);
  lines.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))');
  if (sockets.length) lines.push(`(allow network-outbound ${sockets.map(quote).join(' ')})`);
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
}) {
  const custom = settings?.sandbox ?? {};
  return function restrictedRun(argv, { cwd, timeoutMs, writable = [], cacheDir, env: extraEnv = {} } = {}) {
    for (const dir of [emptyDir, cacheDir, join(cacheDir, 'tmp'), join(cacheDir, 'npm'), join(cacheDir, 'xdg'), ...writable]) {
      ensureDir(dir);
    }
    const runEnv = restrictedEnv(env, { emptyDir: real(emptyDir), cacheDir: real(cacheDir), proxyUrl, extra: extraEnv });
    if (!sandbox) return run(argv, { cwd, timeoutMs, env: runEnv });
    const canWrite = [...writable, cacheDir, ...TEMP_DIRS, ...(custom.allowWrite ?? [])].map(real);
    const profile = sandboxProfile({
      writable: canWrite,
      denyRead: [dataDir, ...PRIVATE_HOME_PATHS.map((path) => join(home, path)), ...(custom.denyRead ?? [])].map(real),
      readable: [...writable, cacheDir, emptyDir, ...(custom.allowRead ?? [])].map(real),
      // Not the shared temporary folders: other programs keep their own sockets there.
      sockets: [...writable, cacheDir].map(real),
    });
    return run([SANDBOX_EXEC, '-p', profile, ...argv], { cwd, timeoutMs, env: runEnv });
  };
}
