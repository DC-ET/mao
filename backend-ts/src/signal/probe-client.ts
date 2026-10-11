import http from 'node:http';
import https from 'node:https';

/**
 * 信号哨兵探针执行器（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.2）。
 *
 * 与 `harness/tool/impl/fetch-bytes.ts` 的差异：支持任意方法 + 自定义请求头 + body，
 * 且**任何完成响应的状态码都是合法判定输入**（ok=true），只有网络错误 / 超时 / 超大小
 * 上限 / 重定向才算失败（ok=false）。仿其 node:http 双 timer + 流式上限结构。
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface ProbeRequest {
  url: string;
  /** GET / POST。 */
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProbeResult {
  /** 是否取得完整响应（网络/超时/超限/重定向为 false）。 */
  ok: boolean;
  httpStatus: number | null;
  /** utf8 解码的响应体；失败或超限为 null。 */
  body: string | null;
  /** 响应体原始字节（哈希用，避免解码差异影响判定）；失败或超限为 null。 */
  bodyBytes: Buffer | null;
  error: string | null;
  durationMs: number;
}

export interface ProbeTimeouts {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

/** 错误信息脱敏：只回协议级原因，不拼 URL、不回响应体（防内网探测信息经错误串泄露）。 */
function safeError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === 'string' && code !== '') return `连接失败: ${code}`;
  const message = (err as { message?: string } | null)?.message;
  return typeof message === 'string' && message !== '' ? message.slice(0, 200) : '连接失败';
}

export function executeProbe(
  req: ProbeRequest,
  timeouts: ProbeTimeouts = {},
): Promise<ProbeResult> {
  const connectTimeoutMs = timeouts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const readTimeoutMs = timeouts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (connectTimer) clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
    };
    const finish = (result: Omit<ProbeResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...result, durationMs: elapsed() });
    };

    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      finish({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: 'URL 不合法' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      finish({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: 'URL 仅支持 http/https' });
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    let request: http.ClientRequest;
    try {
      // 注意：`redirect` 不是 http.RequestOptions 的合法字段，禁重定向由响应回调里
      // 对 3xx 直接判失败实现（见下方 response 分支）。
      request = lib.request(parsed, {
        method: req.method,
        headers: req.headers,
      });
    } catch (e) {
      finish({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: safeError(e) });
      return;
    }

    if (req.body != null) {
      request.write(req.body);
    }
    request.end();

    request.on('error', (err) => {
      finish({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: safeError(err) });
    });

    connectTimer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: '连接超时，目标服务器无响应' });
    }, connectTimeoutMs);

    request.on('response', (res) => {
      if (connectTimer) clearTimeout(connectTimer);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        // 禁重定向（与出站投递口径一致）：跟随会让 URL 校验失效
        res.resume();
        finish({ ok: false, httpStatus: status, body: null, bodyBytes: null, error: '重定向未跟随' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      readTimer = setTimeout(() => {
        request.destroy();
        finish({ ok: false, httpStatus: status, body: null, bodyBytes: null, error: '读取超时，目标服务器无响应' });
      }, readTimeoutMs);

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy();
          finish({
            ok: false,
            httpStatus: status,
            body: null,
            bodyBytes: null,
            error: `响应体超过 ${Math.floor(MAX_BODY_BYTES / (1024 * 1024))}MB 上限`,
          });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        finish({
          ok: true,
          httpStatus: status,
          body: bytes.toString('utf8'),
          bodyBytes: bytes,
          error: null,
        });
      });
      res.on('error', (err) => {
        finish({ ok: false, httpStatus: status, body: null, bodyBytes: null, error: safeError(err) });
      });
    });
  });
}
