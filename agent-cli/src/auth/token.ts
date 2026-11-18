import type { LoginVO } from '../rest/types';
import { CliError } from '../util/exit-codes';
import { loadAuth, resolveRefreshToken, resolveToken, saveAuth, tokenFromEnv } from './auth-store';

/**
 * 刷新令牌失效时服务端用业务码返回，HTTP 仍是 200，不会走进 401 重试。
 * 1001 未登录，1003 Token 已过期，1004 Token 无效。
 */
const AUTH_RECOVERY_CODES = new Set([1001, 1003, 1004]);

export function isAuthRecoveryError(err: unknown): err is CliError {
  if (!(err instanceof CliError)) return false;
  if (err.businessCode != null && AUTH_RECOVERY_CODES.has(err.businessCode)) return true;
  return err.message.startsWith('未登录或登录已过期');
}

function withLoginHint(err: CliError): CliError {
  if (err.message.includes('mao-agent login')) return err;
  return new CliError(`${err.message}\n请执行 mao-agent login 后重试。`, err.exitCode, err.businessCode);
}

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
  /**
   * 交互终端下，本地登录态无法刷新时用用户名密码重新登录。
   * 返回新的 access token。`--token` / `MAO_TOKEN` 不会走到这里。
   */
  relogin?: () => Promise<string | null>;
}): TokenResolver {
  const persistable = !opts.cliToken && !tokenFromEnv();
  let reloginInflight: Promise<string | null> | null = null;

  function loginAgain(): Promise<string | null> {
    if (!opts.relogin || !persistable) return Promise.resolve(null);
    if (!reloginInflight) {
      const pending = opts.relogin().finally(() => {
        if (reloginInflight === pending) reloginInflight = null;
      });
      reloginInflight = pending;
    }
    return reloginInflight;
  }

  async function refreshIfNeeded(force: boolean): Promise<string | null> {
    if (opts.cliToken) return opts.cliToken;
    if (tokenFromEnv()) return resolveToken();
    const auth = loadAuth();
    const access = auth?.accessToken ?? null;
    if (!force && access && !needsRefresh(access, auth?.savedAt, auth?.expiresIn)) {
      return access;
    }
    const refreshToken = resolveRefreshToken();
    if (!refreshToken) {
      // 从未登录，或 401 之后没有 refresh 可用。交互终端直接问密码。
      if (force || !access) {
        const next = await loginAgain();
        if (next) return next;
      }
      return access;
    }
    try {
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
    } catch (err) {
      if (!isAuthRecoveryError(err)) throw err;
      const next = await loginAgain();
      if (next) return next;
      throw withLoginHint(err);
    }
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
