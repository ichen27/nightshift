// JSON files in the data folder. Writes go to a temporary file and are renamed into place,
// so a reader never sees a half-written file and a failed write leaves the old one intact.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export function createStore(dataDir) {
  const root = resolve(dataDir);

  function pathFor(name) {
    if (typeof name !== 'string' || name === '') {
      throw new Error('A name inside the data folder is required.');
    }
    const full = resolve(root, name);
    if (full === root || !full.startsWith(root + sep)) {
      throw new Error(`${JSON.stringify(name)} is outside the data folder.`);
    }
    return full;
  }

  function read(name, fallback) {
    const file = pathFor(name);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${name} in the data folder is not valid JSON: ${error.message}`);
    }
  }

  function write(name, value) {
    const file = pathFor(name);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  function list(dir) {
    let names;
    try {
      names = readdirSync(pathFor(dir));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return names.filter((name) => name.endsWith('.json')).sort();
  }

  function remove(name) {
    rmSync(pathFor(name), { recursive: true, force: true });
  }

  return { read, write, list, remove };
}
