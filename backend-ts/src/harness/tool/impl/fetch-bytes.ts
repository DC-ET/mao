import http from 'node:http';
import https from 'node:https';

/**
 * 通道发送工具共用的 URL 下载实现：带连接/读取双超时与流式大小上限。
 * 对端挂起或慢速 drip 时按超时中止（reject），响应体累计超过 maxBytes 立即销毁连接并报错，
 * 避免 AgentLoop 永久挂死以及大响应体在超限检查前全量进内存导致 OOM。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface FetchedBytes {
  bytes: Buffer;
  /** 响应头 content-type（未去参数）；无头或缺省为 null。发送工具据此推导副本扩展名 / mime。 */
  contentType: string | null;
}

export function fetchBytesWithLimits(
  url: string,
  maxBytes: number,
  timeouts: { connectTimeoutMs?: number; readTimeoutMs?: number } = {},
): Promise<Buffer> {
  return fetchBytesWithContentType(url, maxBytes, timeouts).then((fetched) => fetched.bytes);
}

export function fetchBytesWithContentType(
  url: string,
  maxBytes: number,
  timeouts: { connectTimeoutMs?: number; readTimeoutMs?: number } = {},
): Promise<FetchedBytes> {
  const connectTimeoutMs = timeouts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const readTimeoutMs = timeouts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
    };
    const finish = (err: Error | null, value?: FetchedBytes) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (err) reject(err);
      else resolvePromise(value!);
    };

    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      if (connectTimer) clearTimeout(connectTimer);
      const status = res.statusCode ?? 500;
      if (status < 200 || status >= 300) {
        res.resume();
        finish(new Error(`下载失败: HTTP ${status}`));
        return;
      }
      const header = res.headers['content-type'];
      const contentType = typeof header === 'string' && header.trim() !== '' ? header.trim() : null;
      const chunks: Buffer[] = [];
      let size = 0;
      readTimer = setTimeout(() => {
        req.destroy();
        finish(new Error('下载超时，目标服务器无响应'));
      }, readTimeoutMs);

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          finish(new Error(`下载内容超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 上限`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, { bytes: Buffer.concat(chunks), contentType }));
      res.on('error', (err) => finish(err));
    });

    connectTimer = setTimeout(() => {
      req.destroy();
      finish(new Error('下载超时，目标服务器连接无响应'));
    }, connectTimeoutMs);

    req.on('error', (err) => finish(err));
  });
}
