'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 与 mao-admin-cli 共用同一套 JWT 缓存（前后台同一用户体系） */
const AUTH_DIR = path.join(os.homedir(), '.mao');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

/** 旧版路径，读取时兼容迁移 */
const LEGACY_AUTH_FILES = [
  path.join(os.homedir(), '.mao-cli', 'auth.json'),
  path.join(os.homedir(), '.mao-admin-cli', 'auth.json'),
  path.join(os.homedir(), '.mao-user-cli', 'auth.json'),
];

function ensureDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadAuth() {
  const current = readJsonFile(AUTH_FILE);
  if (current?.accessToken) return current;

  for (const legacy of LEGACY_AUTH_FILES) {
    const data = readJsonFile(legacy);
    if (data?.accessToken) {
      try {
        saveAuth(data);
      } catch {
        // 迁移失败时仍返回旧数据，保证本次可用
      }
      return data;
    }
  }
  return null;
}

function saveAuth(data) {
  ensureDir();
  const payload = {
    accessToken: data.accessToken || null,
    refreshToken: data.refreshToken || null,
    expiresIn: data.expiresIn ?? null,
    user: data.user ?? null,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return payload;
}

function clearAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch {
    // ignore
  }
  for (const legacy of LEGACY_AUTH_FILES) {
    try {
      if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    } catch {
      // ignore
    }
  }
}

/**
 * Token 优先级：
 * 1. 命令行 --token
 * 2. 环境变量 MAO_TOKEN（兼容旧名 MAO_ADMIN_TOKEN / MAO_USER_TOKEN）
 * 3. ~/.mao/auth.json（及旧路径迁移）
 */
function resolveToken(cliToken) {
  if (cliToken) return String(cliToken);
  const fromEnv =
    process.env.MAO_TOKEN ||
    process.env.MAO_ADMIN_TOKEN ||
    process.env.MAO_USER_TOKEN;
  if (fromEnv) return fromEnv;
  const cached = loadAuth();
  return cached?.accessToken || null;
}

function resolveRefreshToken(cliToken) {
  if (cliToken) return String(cliToken);
  const fromEnv =
    process.env.MAO_REFRESH_TOKEN ||
    process.env.MAO_ADMIN_REFRESH_TOKEN ||
    process.env.MAO_USER_REFRESH_TOKEN;
  if (fromEnv) return fromEnv;
  const cached = loadAuth();
  return cached?.refreshToken || null;
}

module.exports = {
  AUTH_DIR,
  AUTH_FILE,
  loadAuth,
  saveAuth,
  clearAuth,
  resolveToken,
  resolveRefreshToken,
};
