import { CliError, EXIT } from '../util/exit-codes';
import { stripModelSecrets } from '../util/redact';
import { tokenFromEnv } from '../auth/auth-store';
import type { AgentVO, CloudProject, CreateSessionRequest, LoginVO, MessagePage, Result, SafeModelVO, SessionVO, UserInfoVO } from './types';

export interface RestClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null> | string | null;
  onUnauthorized?: () => Promise<string | null>;
  timeoutMs?: number;
  debug?: (msg: string, extra?: unknown) => void;
}

function classifyNetworkError(err: unknown, timeoutMs: number, url: string): CliError {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === 'AbortError') {
    return new CliError(`请求超时（${timeoutMs}ms）: ${url}`);
  }
  const code = e.cause?.code || '';
  const msg = e.message || String(err);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(msg)) {
    return new CliError(`DNS 解析失败: ${url}`);
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return new CliError(`连接被拒绝: ${url}`);
  }
  const cause = e.cause?.message ? `（${e.cause.message}）` : '';
  return new CliError(`网络请求失败: ${msg}${cause}`);
}

function unauthorizedHint(): string {
  if (tokenFromEnv()) {
    return (
      '未登录或登录已过期（HTTP 401）\n' +
      '  云端/微信场景：请确认 MAO_TOKEN 已注入（echo ${MAO_TOKEN:+injected}），必要时重开 shell 会话。'
    );
  }
  return '未登录或登录已过期（HTTP 401）。请执行 mao-agent login 或设置 MAO_TOKEN。';
}

/** 仅幂等方法允许自动重试，避免 POST 等请求在服务端已生效后重试造成重复副作用。 */
function isRetryableMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
}

export class RestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  async login(username: string, password: string): Promise<LoginVO> {
    return this.request<LoginVO>('POST', '/v1/auth/login', { body: { username, password }, auth: false });
  }

  async refresh(refreshToken: string): Promise<LoginVO> {
    return this.request<LoginVO>('POST', '/v1/auth/refresh', { body: { refreshToken }, auth: false });
  }

  async logout(): Promise<void> {
    await this.request<unknown>('POST', '/v1/auth/logout', { body: {} });
  }

  async me(): Promise<UserInfoVO> {
    return this.request<UserInfoVO>('GET', '/v1/users/me');
  }

  async listAgents(keyword?: string): Promise<AgentVO[]> {
    return this.request<AgentVO[]>('GET', '/v1/agents', { query: { keyword } });
  }

  async listActiveModels(): Promise<SafeModelVO[]> {
    const list = await this.request<Array<SafeModelVO & { apiKey?: string }>>('GET', '/v1/models/active');
    return stripModelSecrets(list ?? []);
  }

  async createSession(req: CreateSessionRequest): Promise<SessionVO> {
    return this.request<SessionVO>('POST', '/v1/sessions', { body: req });
  }

  async getSession(id: number): Promise<SessionVO> {
    return this.request<SessionVO>('GET', `/v1/sessions/${id}`);
  }

  async listSessions(params?: { keyword?: string; status?: string }): Promise<SessionVO[]> {
    const data = await this.request<SessionVO[] | { items: SessionVO[] }>('GET', '/v1/sessions', { query: params });
    return Array.isArray(data) ? data : (data?.items ?? []);
  }

  async listMessages(id: number, params?: { roundLimit?: number; beforeMessageId?: number }): Promise<MessagePage> {
    return this.request<MessagePage>('GET', `/v1/sessions/${id}/messages`, { query: params });
  }

  async markRead(id: number): Promise<void> {
    await this.request<unknown>('PUT', `/v1/sessions/${id}/read`);
  }

  async listCloudProjects(): Promise<CloudProject[]> {
    return this.request<CloudProject[]>('GET', '/v1/sessions/cloud-projects');
  }

  private async request<T>(
    method: string,
    apiPath: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      auth?: boolean;
      _retried401?: boolean;
      _retriedNet?: number;
    } = {},
  ): Promise<T> {
    const url = this.buildUrl(apiPath, options.query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const needAuth = options.auth !== false;
    let token: string | null = null;
    if (needAuth) {
      token = await Promise.resolve(this.opts.getToken());
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    this.opts.debug?.(`${method} ${url}`, options.body ? { body: options.body } : undefined);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // 仅幂等方法自动重试；POST 等非幂等请求可能已在服务端生效，重试会产生重复副作用
      if (isRetryableMethod(method)) {
        const netRetries = options._retriedNet ?? 0;
        if (netRetries < 2) {
          await sleep(200 * 2 ** netRetries);
          return this.request<T>(method, apiPath, { ...options, _retriedNet: netRetries + 1 });
        }
      }
      throw classifyNetworkError(err, this.timeoutMs, url);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: Result<T> | null = null;
    if (text) {
      try {
        json = JSON.parse(text) as Result<T>;
      } catch {
        if (!response.ok) {
          throw new CliError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        }
        throw new CliError(`响应不是合法 JSON: ${text.slice(0, 200)}`);
      }
    }

    this.opts.debug?.(`${method} ${url} -> ${response.status}`, json ? { code: json.code, message: json.message } : text.slice(0, 200));

    if (response.status === 401 && needAuth && !options._retried401 && this.opts.onUnauthorized) {
      const next = await this.opts.onUnauthorized();
      if (next && next !== token) {
        return this.request<T>(method, apiPath, { ...options, _retried401: true });
      }
      throw new CliError(unauthorizedHint());
    }

    if (!response.ok) {
      const msg = json?.message || response.statusText || '请求失败';
      if (response.status === 401) throw new CliError(unauthorizedHint());
      if (response.status >= 500 && isRetryableMethod(method)) {
        const netRetries = options._retriedNet ?? 0;
        if (netRetries < 2) {
          await sleep(200 * 2 ** netRetries);
          return this.request<T>(method, apiPath, { ...options, _retriedNet: netRetries + 1 });
        }
      }
      throw new CliError(`HTTP ${response.status}: ${msg}`);
    }

    if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'code')) {
      if (json.code !== 0) {
        throw new CliError(`业务错误 code=${json.code}: ${json.message || '未知错误'}`, EXIT.GENERAL);
      }
      return json.data as T;
    }

    return (json as unknown as T) ?? (undefined as T);
  }

  private buildUrl(apiPath: string, query?: Record<string, unknown>): string {
    const normalized = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = new URL(this.baseUrl + normalized);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
