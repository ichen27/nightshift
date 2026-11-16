// Syntax-checks every source file with `node --check`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const files = [];
for (const dir of ['src', 'scripts', 'tests']) {
  if (!existsSync(join(root, dir))) continue;
  for (const name of readdirSync(join(root, dir))) {
    if (name.endsWith('.mjs')) files.push(join(dir, name));
  }
}
if (existsSync(join(root, 'public', 'app.js'))) files.push(join('public', 'app.js'));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}
if (failed > 0) {
  console.error(`${failed} of ${files.length} files failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} files.`);
