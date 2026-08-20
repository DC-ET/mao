import type { LoginVO } from '../rest/types';
import { loadAuth, resolveRefreshToken, resolveToken, saveAuth, tokenFromEnv } from './auth-store';

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface TokenSource {
  accessToken: string | null;
  refreshToken: string | null;
  fromEnv: boolean;
  fromCli: boolean;
}

export function currentTokenSource(cliToken?: string): TokenSource {
  return {
    accessToken: resolveToken(cliToken),
    refreshToken: resolveRefreshToken(),
    fromEnv: !cliToken && tokenFromEnv(),
    fromCli: Boolean(cliToken),
  };
}

export function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function remainingMs(token: string | null, savedAt?: string | null, expiresIn?: number | null): number | null {
  if (!token) return null;
  const exp = decodeJwtExpMs(token);
  if (exp != null) return exp - Date.now();
  if (savedAt && expiresIn != null) {
    const start = Date.parse(savedAt);
    if (Number.isFinite(start)) return start + expiresIn * 1000 - Date.now();
  }
  return null;
}

export function needsRefresh(token: string | null, savedAt?: string | null, expiresIn?: number | null): boolean {
  const left = remainingMs(token, savedAt, expiresIn);
  if (left == null) return false;
  return left < REFRESH_SKEW_MS;
}

export function formatRemaining(ms: number | null): string {
  if (ms == null) return '未知';
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  if (m > 0) return `${m} 分钟`;
  return `${sec} 秒`;
}

export interface TokenResolver {
  getAccessToken(): Promise<string | null>;
  onUnauthorized(): Promise<string | null>;
}

export function createTokenResolver(opts: {
  cliToken?: string;
  refresh: (refreshToken: string) => Promise<LoginVO>;
}): TokenResolver {
  const persistable = !opts.cliToken && !tokenFromEnv();

  async function refreshIfNeeded(force: boolean): Promise<string | null> {
    if (opts.cliToken) return opts.cliToken;
    if (tokenFromEnv()) return resolveToken();
    const auth = loadAuth();
    const access = auth?.accessToken ?? null;
    if (!force && access && !needsRefresh(access, auth?.savedAt, auth?.expiresIn)) {
      return access;
    }
    const refreshToken = resolveRefreshToken();
    if (!refreshToken) return access;
    const vo = await opts.refresh(refreshToken);
    if (persistable) {
      saveAuth({
        accessToken: vo.accessToken,
        refreshToken: vo.refreshToken || refreshToken,
        expiresIn: vo.expiresIn,
        user: vo.user ?? auth?.user ?? null,
      });
    }
    return vo.accessToken;
  }

  return {
    async getAccessToken() {
      return refreshIfNeeded(false);
    },
    async onUnauthorized() {
      return refreshIfNeeded(true);
    },
  };
}
