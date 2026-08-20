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
    if (token === '-h') {
      flags.help = true;
      flags.h = true;
      i += 1;
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

function extractGlobalOptions(flags, { reserveBaseUrl = false } = {}) {
  return {
    baseUrl: reserveBaseUrl ? undefined : optionalString(flags, 'base-url'),
    token: optionalString(flags, 'token'),
    json: Boolean(flags.json),
    raw: Boolean(flags.raw),
    timeoutMs: optionalNumber(flags, 'timeout-ms'),
    help: hasHelp(flags),
  };
}

function hasFlag(flags, name) {
  return flags[name] === true || flags[name] === 'true' || flags[name] === '';
}

function getString(flags, name, fallback) {
  const v = flags[name];
  if (v === undefined || v === true) return fallback;
  return String(v);
}

function getNumber(flags, name, fallback) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw createCliError(`参数 --${name} 必须是数字，收到: ${v}`);
  }
  return n;
}

function getBool01(flags, name) {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === '1' || v === 'true') return 1;
  if (v === false || v === '0' || v === 'false') return 0;
  const n = Number(v);
  if (n === 0 || n === 1) return n;
  throw createCliError(`参数 --${name} 必须是 0 或 1，收到: ${v}`);
}

function getBool(flags, name) {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  throw createCliError(`参数 --${name} 必须是 true/false 或 0/1，收到: ${v}`);
}

function getStringList(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function getNumberList(flags, name) {
  const list = getStringList(flags, name);
  if (list === undefined) return undefined;
  return list.map((x) => {
    const n = Number(x);
    if (Number.isNaN(n)) {
      throw createCliError(`参数 --${name} 含非法数字: ${x}`);
    }
    return n;
  });
}

function requireFlag(flags, name, label) {
  return requireString(flags, name, label);
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  createCliError,
  parseArgs,
  hasHelp,
  hasFlag,
  getFlag,
  requireString,
  requireFlag,
  optionalString,
  optionalNumber,
  requireNumber,
  optionalBoolean,
  parseCsv,
  parseJsonFlag,
  extractGlobalOptions,
  getString,
  getNumber,
  getBool01,
  getBool,
  getStringList,
  getNumberList,
  pickDefined,
};
