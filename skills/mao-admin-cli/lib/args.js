'use strict';

/**
 * Parse argv into { command, subcommand, rest, flags, positionals }.
 * Supports --key value, --key=value, --bool, -h.
 */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
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
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }
    if (token === '-h') {
      flags.help = true;
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }
    positionals.push(token);
    i += 1;
  }

  const command = positionals[0] || null;
  const subcommand = positionals[1] || null;
  const rest = positionals.slice(2);

  return { command, subcommand, rest, flags, positionals };
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
    const err = new Error(`参数 --${name} 必须是数字，收到: ${v}`);
    err.exitCode = 1;
    throw err;
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
  const err = new Error(`参数 --${name} 必须是 0 或 1，收到: ${v}`);
  err.exitCode = 1;
  throw err;
}

function getBool(flags, name) {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  const err = new Error(`参数 --${name} 必须是 true/false 或 0/1，收到: ${v}`);
  err.exitCode = 1;
  throw err;
}

/** Comma-separated string list. */
function getStringList(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Comma-separated number list. */
function getNumberList(flags, name) {
  const list = getStringList(flags, name);
  if (list === undefined) return undefined;
  return list.map((x) => {
    const n = Number(x);
    if (Number.isNaN(n)) {
      const err = new Error(`参数 --${name} 含非法数字: ${x}`);
      err.exitCode = 1;
      throw err;
    }
    return n;
  });
}

function requireFlag(flags, name, label) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') {
    const err = new Error(`缺少必填参数 --${name}${label ? `（${label}）` : ''}`);
    err.exitCode = 1;
    throw err;
  }
  return String(v);
}

function requireNumber(flags, name, label) {
  const raw = requireFlag(flags, name, label);
  const n = Number(raw);
  if (Number.isNaN(n)) {
    const err = new Error(`参数 --${name} 必须是数字，收到: ${raw}`);
    err.exitCode = 1;
    throw err;
  }
  return n;
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  parseArgs,
  hasFlag,
  getString,
  getNumber,
  getBool01,
  getBool,
  getStringList,
  getNumberList,
  requireFlag,
  requireNumber,
  pickDefined,
};
