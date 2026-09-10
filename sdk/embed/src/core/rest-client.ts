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
    private readonly onUnauthorized?: (token: string, final: boolean) => void,
    private readonly identity: () => string | null = () => null,
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, opts: RestOptions = {}, retry = true): Promise<T> {
    const before = this.identity();
    const token = await this.getToken();
    const identity = this.identity();
    if (before !== null && before !== identity) throw new AuthError();
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
    return this.parse<T>(resp, `${method} ${path}`, identity, token, retry, () => this.request<T>(method, path, opts, false));
  }

  /**
   * multipart 上传（附件）：Content-Type 必须交给浏览器按 boundary 生成，不能手写。
   * FormData 可重复提交，401 换新 token 后直接重试。
   */
  async upload<T>(path: string, form: FormData, retry = true): Promise<T> {
    const before = this.identity();
    const token = await this.getToken();
    const identity = this.identity();
    if (before !== null && before !== identity) throw new AuthError();
    const resp = await fetch(new URL(`${this.apiBase}${path}`).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return this.parse<T>(resp, `POST ${path}`, identity, token, retry, () => this.upload<T>(path, form, false));
  }

  private async parse<T>(
    resp: Response,
    label: string,
    identity: string | null,
    token: string,
    retry: boolean,
    retryCall: () => Promise<T>,
  ): Promise<T> {
    if (identity !== this.identity()) throw new AuthError();
    const text = await resp.text();
    if (identity !== this.identity()) throw new AuthError();
    let payload: { code?: number; data?: T; message?: string } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(resp.status, `Invalid response from ${label}`);
    }
    // Only the authentication gate's documented code proves no business execution occurred.
    if (resp.status === 401 && payload.code === 1001) {
      this.onUnauthorized?.(token, !retry);
      if (retry) return retryCall();
      throw new AuthError();
    }
    if (!resp.ok || (payload.code != null && payload.code !== 0)) {
      throw new ApiError(
        resp.status,
        payload.message || `${label} failed (${resp.status})`,
        payload.code ?? null,
      );
    }
    return payload.data as T;
  }
}
