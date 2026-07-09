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

function outputResult(result, options = {}) {
  const { json = false, raw = false } = options;
  if (raw) {
    if (json || typeof result === 'object') {
      printJson(result);
    } else {
      printText(result);
    }
    return;
  }
  const data = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data')
    ? result.data
    : result;
  if (json) {
    printJson(data);
  } else {
    printText(data);
  }
}

function outputBinarySaved(filePath, bytes) {
  process.stdout.write(`已保存 ${bytes} 字节到 ${filePath}\n`);
}

module.exports = {
  printJson,
  printText,
  outputResult,
  outputBinarySaved,
};
