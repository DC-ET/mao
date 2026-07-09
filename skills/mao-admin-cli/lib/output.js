'use strict';

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function printText(value) {
  if (value === undefined || value === null) {
    process.stdout.write('\n');
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(value + (value.endsWith('\n') ? '' : '\n'));
    return;
  }
  printJson(value);
}

function printError(message) {
  process.stderr.write(String(message) + '\n');
}

/**
 * Emit CLI result according to --json / --raw.
 * Default: print data (JSON pretty). --raw: full Result. --json: same as default for data.
 */
function emitResult(result, { raw = false } = {}) {
  if (raw) {
    printJson(result);
    return;
  }
  printJson(result?.data === undefined ? null : result.data);
}

module.exports = {
  printJson,
  printText,
  printError,
  emitResult,
};
