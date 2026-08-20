import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserInfoVO } from '../rest/types';

/** 与 mao-cli 共用同一套 JWT 缓存。 */
export const AUTH_DIR = path.join(os.homedir(), '.mao');
export const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

const LEGACY_AUTH_FILES = [
  path.join(os.homedir(), '.mao-cli', 'auth.json'),
  path.join(os.homedir(), '.mao-admin-cli', 'auth.json'),
  path.join(os.homedir(), '.mao-user-cli', 'auth.json'),
];

export interface AuthRecord {
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number | null;
  user: UserInfoVO | null;
  savedAt: string;
}

function ensureDir(): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(AUTH_DIR, 0o700);
    } catch {
      // ignore
    }
  }
}

function readJsonFile(file: string): AuthRecord | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AuthRecord;
  } catch {
    return null;
  }
}

export function loadAuth(): AuthRecord | null {
  const current = readJsonFile(AUTH_FILE);
  if (current?.accessToken) return current;
  for (const legacy of LEGACY_AUTH_FILES) {
    const data = readJsonFile(legacy);
    if (data?.accessToken) {
      try {
        saveAuth(data);
      } catch {
        // 迁移失败时仍返回旧数据
      }
      return data;
    }
  }
  return null;
}

export function saveAuth(data: Partial<AuthRecord> & { accessToken?: string | null }): AuthRecord {
  ensureDir();
  const payload: AuthRecord = {
    accessToken: data.accessToken || null,
    refreshToken: data.refreshToken || null,
    expiresIn: data.expiresIn ?? null,
    user: data.user ?? null,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {
    // ignore
  }
  return payload;
}

export function clearAuth(): void {
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
 * 2. 环境变量 MAO_TOKEN（兼容旧名 MAO_USER_TOKEN / MAO_ADMIN_TOKEN）
 * 3. ~/.mao/auth.json
 */
export function resolveToken(cliToken?: string): string | null {
  if (cliToken) return String(cliToken);
  const fromEnv = process.env.MAO_TOKEN || process.env.MAO_ADMIN_TOKEN || process.env.MAO_USER_TOKEN;
  if (fromEnv) return fromEnv;
  return loadAuth()?.accessToken || null;
}

export function resolveRefreshToken(cliToken?: string): string | null {
  if (cliToken) return String(cliToken);
  const fromEnv =
    process.env.MAO_REFRESH_TOKEN || process.env.MAO_ADMIN_REFRESH_TOKEN || process.env.MAO_USER_REFRESH_TOKEN;
  if (fromEnv) return fromEnv;
  return loadAuth()?.refreshToken || null;
}

export function tokenFromEnv(): boolean {
  return Boolean(process.env.MAO_TOKEN || process.env.MAO_ADMIN_TOKEN || process.env.MAO_USER_TOKEN);
}
