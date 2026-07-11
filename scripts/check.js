/**
 * Syntax-checks every source file (no Discord token needed). Used in CI and
 * before deploys: `npm run check`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

const files = walk(new URL('../src', import.meta.url).pathname);
let failed = false;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`✗ ${file}\n${res.stderr}`);
    failed = true;
  } else {
    console.log(`✓ ${file}`);
  }
}
process.exit(failed ? 1 : 0);
