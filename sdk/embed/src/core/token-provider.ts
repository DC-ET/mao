import type { SsoExchangeVO } from '@mao/contracts';
import type { AuthStatus } from '../types';

export const AUTH_MESSAGES: Record<AuthStatus, string> = {
  authenticated: '', login_required: '登录凭据已失效，请在宿主恢复登录后重试',
  service_unavailable: '认证服务暂时不可用，请稍后重试',
  account_forbidden: '当前账号无权使用助手', identity_conflict: '账号关联冲突，请联系管理员',
  configuration_error: '助手认证配置异常，请联系管理员',
};
export class TokenError extends Error {
  constructor(readonly status: AuthStatus) { super(AUTH_MESSAGES[status]); }
}
export interface TokenUpdate { token: string; userId: string; expiresAt: number }
interface SsoOptions {
  apiBase: string;
  checkUrl: string;
  onUpdate: (update: TokenUpdate, previousUser: string | null) => void;
  onStatus: (status: AuthStatus) => void;
}

/** Credentials are instance-local memory only. No persistence or cross-tab token transport. */
export class TokenProvider {
  private current: string | null = null;
  private flight: Promise<string> | null = null;
  private user: string | null = null;
  private expiresAt = Infinity;
  private refreshAt = Infinity;
  private retryAt = 0;
  private serverRetryAt = 0;
  private failures = 0;
  private stopped: TokenError | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private destroyed = false;
  private readonly wake = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.stopped?.status === 'service_unavailable') this.resume();
    void this.get().catch(() => {});
  };

  constructor(private readonly supplier: () => Promise<string>, private readonly sso?: SsoOptions) {
    if (sso && typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('pageshow', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
  }

  get(): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error('Authentication destroyed'));
    if (this.flight) return this.flight;
    const valid = this.current !== null && Date.now() < this.expiresAt;
    if (this.stopped) {
      if (valid && this.stopped.status === 'service_unavailable') return Promise.resolve(this.current!);
      return Promise.reject(this.stopped);
    }
    if (valid && (Date.now() < this.refreshAt || Date.now() < this.retryAt)) return Promise.resolve(this.current!);
    if (Date.now() < this.retryAt) return Promise.reject(new TokenError('service_unavailable'));
    this.flight = this.acquire().finally(() => { this.flight = null; });
    return this.flight;
  }

  /** Ignore a late 401 for a credential already superseded by another request. */
  invalidate(rejectedToken?: string) {
    if (rejectedToken && rejectedToken !== this.current) return;
    this.current = null;
    this.refreshAt = 0;
  }

  resume() {
    if (this.destroyed) return;
    this.stopped = null;
    this.failures = 0;
    this.retryAt = Math.max(0, this.serverRetryAt);
    this.refreshAt = 0;
    if (this.retryAt > Date.now()) this.schedule(this.retryAt - Date.now());
  }

  getExpiresAt(token: string): number {
    return token === this.current ? this.expiresAt : 0;
  }

  rejectAuthentication(rejectedToken: string) {
    if (rejectedToken !== this.current) return;
    this.stop('login_required');
  }

  private stop(status: AuthStatus): TokenError {
    const error = new TokenError(status);
    this.stopped = error;
    if (status !== 'service_unavailable') this.current = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sso?.onStatus(status);
    return error;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.get().catch(() => {});
    }, Math.max(1, Math.ceil(delay)));
  }

  private async acquire(): Promise<string> {
    if (!this.sso) {
      const token = await this.supplier();
      if (this.destroyed) throw new Error('Authentication destroyed');
      this.current = token;
      return token;
    }
    let retryAfter = 0;
    try {
      for (let nearExpiry = 0; nearExpiry < 2; nearExpiry++) {
        let supplied: string;
        try { supplied = await this.supplier(); }
        catch { throw new TokenError('login_required'); }
        if (this.destroyed) throw new Error('Authentication destroyed');
        if (!supplied?.trim()) throw new TokenError('login_required');
        this.abort = new AbortController();
        const timeout = setTimeout(() => this.abort?.abort(), 10_000);
        let response: Response;
        let body: { code?: number; data?: SsoExchangeVO };
        try {
          response = await fetch(`${this.sso.apiBase}/auth/sso/exchange`, {
            method: 'POST', headers: { Authorization: `Bearer ${supplied}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkUrl: this.sso.checkUrl }),
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal: this.abort.signal,
          });
          const retry = response.headers.get('Retry-After');
          if (retry) {
            const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            if (Number.isFinite(delay)) retryAfter = Math.max(0, delay);
          }
          body = await response.json();
        } finally { clearTimeout(timeout); this.abort = null; }
        if (this.destroyed) throw new Error('Authentication destroyed');
        // Dedicated business code agreed with the exchange endpoint (not all 401s).
        if (body.code === 1402 && nearExpiry === 0) continue;
        if (response.status === 401 || body.code === 1402) throw new TokenError('login_required');
        if (response.status === 403) throw new TokenError('account_forbidden');
        if (response.status === 409) throw new TokenError('identity_conflict');
        if (response.status === 429 || response.status === 503) throw new TokenError('service_unavailable');
        if (!response.ok || body.code !== 0) throw new TokenError('configuration_error');
        const data = body.data;
        if (!data || typeof data.accessToken !== 'string' || !data.accessToken
          || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()
          || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0
          || !Number.isFinite(data.refreshAfter) || data.refreshAfter <= 0
          || data.refreshAfter >= data.expiresIn || !Number.isSafeInteger(data.user?.id) || data.user.id <= 0) {
          throw new TokenError('configuration_error');
        }
        const previous = this.user;
        this.current = data.accessToken;
        this.user = String(data.user.id);
        this.expiresAt = Math.min(data.expiresAt, Date.now() + data.expiresIn * 1000);
        this.refreshAt = Math.min(this.expiresAt, Date.now() + data.refreshAfter * 1000 * (0.95 + Math.random() * 0.05));
        this.failures = 0;
        this.retryAt = 0;
        this.serverRetryAt = 0;
        this.sso.onUpdate({ token: this.current, userId: this.user, expiresAt: this.expiresAt }, previous);
        this.sso.onStatus('authenticated');
        this.schedule(this.refreshAt - Date.now());
        return this.current;
      }
      throw new TokenError('login_required');
    } catch (err) {
      if (this.destroyed) throw new Error('Authentication destroyed');
      const error = err instanceof TokenError ? err : new TokenError('service_unavailable');
      if (error.status !== 'service_unavailable') throw this.stop(error.status);
      this.failures++;
      this.serverRetryAt = Math.max(this.serverRetryAt, Date.now() + retryAfter);
      this.retryAt = Math.max(this.serverRetryAt, Date.now() + Math.min(30_000, 1000 * 2 ** (this.failures - 1)) * (1 + Math.random() * 0.2));
      this.sso.onStatus(error.status);
      if (this.failures >= 5) this.stop(error.status);
      else this.schedule(this.retryAt - Date.now());
      if (this.current && Date.now() < this.expiresAt) return this.current;
      throw error;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    this.current = null;
    this.user = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('pageshow', this.wake);
      document.removeEventListener('visibilitychange', this.wake);
    }
  }
}

/** Unverified JWT subject is a local isolation hint ONLY; never used to authorize. */
export function tokenSubject(token: string): string | null {
  try {
    const part = token.split('.')[1]!;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' || typeof payload.sub === 'number' ? String(payload.sub) : null;
  } catch { return null; }
}
