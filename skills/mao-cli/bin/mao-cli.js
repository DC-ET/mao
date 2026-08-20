#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli');

run(process.argv.slice(2)).catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(message + '\n');
  process.exit(typeof err?.exitCode === 'number' ? err.exitCode : 1);
});
