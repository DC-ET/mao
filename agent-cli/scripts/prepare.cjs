'use strict';

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

if (!existsSync(join(__dirname, '..', 'src', 'main.ts'))) {
  process.exit(0);
}

const tsc = join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
  cwd: join(__dirname, '..'),
  stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
