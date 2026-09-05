/** 极小 REST 客户端：只带 Authorization，401 时抛 AuthError 交给上层重取 token */
export class AuthError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'AuthError';
  }
}

/**
 * 业务错误：同时携带 HTTP 状态码与后端业务 code。
 * 后端契约（backend-ts/src/common/http-error.ts handleError）：
 * - 业务异常默认 HTTP 200 + body.code（如会话不存在 = 3002）
 * - 仅 1001/401 → HTTP 401，1002/403 → HTTP 403
 * 因此判定"资源不存在/无权访问"必须看 code，不能只看 status。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, message: string, code: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface RestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class RestClient {
  constructor(
    private readonly apiBase: string,
    private readonly getToken: () => Promise<string>,
    /** 401 时回调：使 TokenProvider 缓存失效，重试才真正取到新 token */
    private readonly onUnauthorized?: () => void,
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, opts: RestOptions = {}, retry = true): Promise<T> {
    const token = await this.getToken();
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (resp.status === 401) {
      // token 过期：先失效缓存再重取一次，仍 401 才判定凭据失效
      if (retry) {
        this.onUnauthorized?.();
        return this.request<T>(method, path, opts, false);
      }
      throw new AuthError();
    }
    const text = await resp.text();
    let payload: { code?: number; data?: T; message?: string } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(resp.status, `Invalid response from ${path}`);
    }
    if (!resp.ok || (payload.code != null && payload.code !== 0)) {
      throw new ApiError(
        resp.status,
        payload.message || `${method} ${path} failed (${resp.status})`,
        payload.code ?? null,
      );
    }
    return payload.data as T;
  }
}
