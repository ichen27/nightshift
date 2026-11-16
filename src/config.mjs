// Resolves where Nightshift keeps its data, where it listens, and which tools it runs.

export const DEFAULT_SETTINGS = Object.freeze({
  projectsPerNight: 3,
  hold: [],
  adminMerge: [],
  vaultDir: null,
  launcherDir: null,
  launcherRegistry: null,
});

function parsePort(value) {
  if (value === undefined || value === '') return 8950;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number between 1 and 65535, got ${JSON.stringify(value)}.`);
  }
  return port;
}

export function loadConfig(env = process.env) {
  const dataDir = env.NIGHTSHIFT_DATA_DIR || env.APP_DATA_DIR;
  if (!dataDir) {
    throw new Error('No data folder: set NIGHTSHIFT_DATA_DIR or APP_DATA_DIR.');
  }
  return {
    dataDir,
    host: env.HOST || '127.0.0.1',
    port: parsePort(env.PORT),
    ghPath: env.NIGHTSHIFT_GH || 'gh',
    gitPath: env.NIGHTSHIFT_GIT || 'git',
    claudePath: env.NIGHTSHIFT_CLAUDE || 'claude',
    nodePath: env.NIGHTSHIFT_NODE || 'node',
  };
}

// Settings live in settings.json in the data folder. Values there override the defaults;
// keys this version does not know are ignored.
export function loadSettings(store) {
  const saved = store.read('settings.json', null);
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return settings;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (saved[key] !== undefined) settings[key] = saved[key];
  }
  return settings;
}
