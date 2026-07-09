'use strict';

function createCliError(message, exitCode = 1) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        const key = token.slice(2, eq);
        flags[key] = token.slice(eq + 1);
        i += 1;
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
        i += 1;
        continue;
      }
      flags[key] = next;
      i += 2;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
        i += 1;
        continue;
      }
      flags[key] = next;
      i += 2;
      continue;
    }
    positionals.push(token);
    i += 1;
  }

  return { positionals, flags };
}

function hasHelp(flags) {
  return Boolean(flags.help || flags.h);
}

function getFlag(flags, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(flags, name) && flags[name] !== undefined) {
      return flags[name];
    }
  }
  return undefined;
}

function requireString(flags, name, label) {
  const value = getFlag(flags, name);
  if (value === undefined || value === true || String(value).trim() === '') {
    throw createCliError(`缺少必填参数 --${name}${label ? `（${label}）` : ''}`);
  }
  return String(value);
}

function optionalString(flags, name) {
  const value = getFlag(flags, name);
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function optionalNumber(flags, name) {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw createCliError(`参数 --${name} 必须是数字`);
  }
  return num;
}

function requireNumber(flags, name, label) {
  const value = optionalNumber(flags, name);
  if (value === undefined) {
    throw createCliError(`缺少必填参数 --${name}${label ? `（${label}）` : ''}`);
  }
  return value;
}

function optionalBoolean(flags, name) {
  const value = getFlag(flags, name);
  if (value === undefined) return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw createCliError(`参数 --${name} 必须是 true/false`);
}

function parseCsv(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonFlag(flags, name) {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw createCliError(`参数 --${name} 必须是合法 JSON`);
  }
}

function extractGlobalOptions(flags) {
  return {
    baseUrl: optionalString(flags, 'base-url'),
    token: optionalString(flags, 'token'),
    json: Boolean(flags.json),
    raw: Boolean(flags.raw),
    timeoutMs: optionalNumber(flags, 'timeout-ms'),
    help: hasHelp(flags),
  };
}

module.exports = {
  createCliError,
  parseArgs,
  hasHelp,
  getFlag,
  requireString,
  optionalString,
  optionalNumber,
  requireNumber,
  optionalBoolean,
  parseCsv,
  parseJsonFlag,
  extractGlobalOptions,
};
