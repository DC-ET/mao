import { hasText } from '../common/case.js';
import type { EcpConfig } from './ecp.config.js';
import { EcpError } from './ecp.error.js';

export interface EcpSessionUser {
  email: string;
  displayName: string;
}

export interface EcpSessionResult {
  sessionToken: string;
  expiresAt: Date;
  user: EcpSessionUser;
}

/** renew 只换票，不返回用户信息。 */
export interface EcpRenewedSession {
  sessionToken: string;
  expiresAt: Date;
}

export interface EcpFeishuAuthorization {
  authorizeUrl: string;
  state?: string;
}

/** ECP 飞书授权 state：优先响应体，其次 authorizeUrl query。 */
export function resolveEcpOAuthState(authorization: EcpFeishuAuthorization): string | undefined {
  if (hasText(authorization.state)) return authorization.state!.trim();
  try {
    const state = new URL(authorization.authorizeUrl).searchParams.get('state');
    return hasText(state) ? state!.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface EcpHttpClient {
  request(method: string, url: string, options?: {
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<{ status: number; json: unknown }>;
}

function defaultHttpClient(): EcpHttpClient {
  return {
    async request(method, url, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body != null ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
        }
        return { status: response.status, json };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function unwrapData(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') throw new EcpError('ECP 响应无效');
  const root = json as Record<string, unknown>;
  if (root.code != null && Number(root.code) !== 0) {
    const message = typeof root.message === 'string' ? root.message : 'ECP 请求失败';
    throw new EcpError(message);
  }
  if (root.success === false) {
    const message = typeof root.message === 'string' ? root.message : 'ECP 请求失败';
    throw new EcpError(message);
  }
  const data = root.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return root;
}

function parseExpiresAt(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === 'string' && hasText(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  throw new EcpError('ECP 响应缺少有效 expiresAt');
}

function parseUser(data: Record<string, unknown>): EcpSessionUser {
  const user = data.user;
  const userObj = user && typeof user === 'object' && !Array.isArray(user) ? user as Record<string, unknown> : data;
  const email = String(userObj.email ?? '').trim();
  if (!email) throw new EcpError('ECP 响应缺少用户邮箱');
  const displayName = String(userObj.realName ?? userObj.displayName ?? userObj.name ?? email).trim();
  return { email, displayName };
}

/**
 * renew 只换票，响应不含用户信息；登录换票才需要解析用户邮箱。
 * 两者拆开，避免 renew 因缺少 user 字段被误判为失败。
 */
function parseSessionToken(data: Record<string, unknown>): EcpRenewedSession {
  const sessionToken = String(data.sessionToken ?? data.token ?? '').trim();
  if (!sessionToken) throw new EcpError('ECP 响应缺少 sessionToken');
  const expiresAt = parseExpiresAt(data.expiresAt ?? data.expireAt ?? data.expiredAt);
  return { sessionToken, expiresAt };
}

function parseSession(data: Record<string, unknown>): EcpSessionResult {
  return { ...parseSessionToken(data), user: parseUser(data) };
}

export interface LarkUserAccessToken {
  accessToken: string;
  expiresAt: Date;
  scope?: string;
}

/** 兼容裸 OAuth token 响应与 { code, data } 包裹。 */
function parseLarkUat(json: unknown): LarkUserAccessToken {
  const data = unwrapData(json);
  const accessToken = String(data.access_token ?? data.accessToken ?? data.userAccessToken ?? '').trim();
  if (!accessToken) throw new EcpError('ECP 响应缺少 access_token');
  const expiresInRaw = Number(data.expires_in ?? data.expiresIn ?? 0);
  const expiresInSec = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Math.floor(expiresInRaw) : 7200;
  const scopeRaw = data.scope;
  const scope = scopeRaw != null && String(scopeRaw).trim() !== '' ? String(scopeRaw).trim() : undefined;
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    scope,
  };
}

export class EcpClient {
  constructor(private readonly http: EcpHttpClient = defaultHttpClient()) {}

  async createFeishuAuthorization(config: EcpConfig, callbackUrl: string): Promise<EcpFeishuAuthorization> {
    const url = `${config.baseUrl}/public/login/apps/${encodeURIComponent(config.appCode)}/feishu-authorizations`;
    const { status, json } = await this.http.request('POST', url, {
      body: { callbackUrl, loginVariant: config.loginVariant },
      timeoutMs: config.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      throw new EcpError(`ECP 飞书授权启动失败（HTTP ${status}）`);
    }
    const data = unwrapData(json);
    const authorizeUrl = String(data.authorizeUrl ?? data.authorizationUrl ?? '').trim();
    if (!authorizeUrl) throw new EcpError('ECP 响应缺少 authorizeUrl');
    const state = data.state != null ? String(data.state) : undefined;
    return { authorizeUrl, state };
  }

  async createSessionFromFeishuCallback(config: EcpConfig, code: string, state: string): Promise<EcpSessionResult> {
    const url = `${config.baseUrl}/public/login/apps/${encodeURIComponent(config.appCode)}/sessions`;
    const { status, json } = await this.http.request('POST', url, {
      body: {
        loginMethod: 'FEISHU_CALLBACK',
        authorizationCode: code,
        code,
        state,
        feishuState: state,
      },
      timeoutMs: config.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      throw new EcpError(`ECP 飞书换票失败（HTTP ${status}）`);
    }
    return parseSession(unwrapData(json));
  }

  async renewSession(config: EcpConfig, sessionToken: string): Promise<EcpRenewedSession> {
    const url = `${config.baseUrl}/public/session/renew?appCode=${encodeURIComponent(config.appCode)}`;
    const { status, json } = await this.http.request('POST', url, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      timeoutMs: config.timeoutMs,
    });
    if (status === 401) {
      const message = typeof (json as Record<string, unknown> | null)?.message === 'string'
        ? String((json as Record<string, unknown>).message)
        : '';
      if (/already renewed|revoked/i.test(message)) {
        throw new EcpError('ECP session 已被其它进程 renew 或已撤销');
      }
      throw new EcpError('ECP session 已过期或无效，无法 renew');
    }
    if (status < 200 || status >= 300) {
      throw new EcpError(`ECP renew 失败（HTTP ${status}）`);
    }
    return parseSessionToken(unwrapData(json));
  }

  async verifySession(config: EcpConfig, sessionToken: string): Promise<EcpSessionUser> {
    const url = `${config.baseUrl}/public/session?appCode=${encodeURIComponent(config.appCode)}`;
    const { status, json } = await this.http.request('GET', url, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      timeoutMs: config.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      throw new EcpError(`ECP session 校验失败（HTTP ${status}）`);
    }
    return parseUser(unwrapData(json));
  }

  /** 用 ECP sessionToken 换飞书用户 UAT（OAuth2 token 端点，token 放 query）。 */
  async getUserAccessToken(config: EcpConfig, ecpUserToken: string): Promise<LarkUserAccessToken> {
    const url = `${config.baseUrl}/public/protocols/oauth2/apps/token`
      + `?appCode=${encodeURIComponent(config.appCode)}`
      + `&ecpUserToken=${encodeURIComponent(ecpUserToken)}`;
    const { status, json } = await this.http.request('POST', url, {
      timeoutMs: config.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      const root = (json ?? {}) as Record<string, unknown>;
      const message = typeof root.error_description === 'string' ? root.error_description
        : typeof root.error === 'string' ? root.error
          : typeof root.message === 'string' ? root.message : '';
      throw new EcpError(message
        ? `ECP 换取飞书 UAT 失败：${message}`
        : `ECP 换取飞书 UAT 失败（HTTP ${status}）`);
    }
    return parseLarkUat(json);
  }
}
