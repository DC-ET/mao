#!/usr/bin/env node
'use strict';

const { main } = require('../dist/main.js');

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  });
