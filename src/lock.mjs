// One nightly run at a time. The lock is a file naming the process that holds it, so a
// run that was killed does not block the next one.

const FILE = 'run.lock';

function readLock(store) {
  try {
    return store.read(FILE, null);
  } catch {
    return null; // An unreadable lock is treated as abandoned.
  }
}

export function acquireLock(store, { pid, isAlive }) {
  const held = readLock(store);
  if (held && held.pid !== pid && isAlive(held.pid)) return null;
  store.write(FILE, { pid, startedAt: new Date().toISOString() });
  return {
    release() {
      if (readLock(store)?.pid === pid) store.remove(FILE);
    },
  };
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
