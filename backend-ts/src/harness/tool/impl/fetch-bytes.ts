import http from 'node:http';
import https from 'node:https';
import { Readable, Transform } from 'node:stream';

/**
 * 通道发送工具共用的 URL 下载实现：带连接/空闲双超时与流式大小上限。
 *
 * 2026-11-25 send_file 1GB 方案 D5：发送快照改走 `fetchBytesStreamWithContentType`，
 * 响应体不进数组、直接作为流的来源；读超时从「整次 30 秒墙钟」改为「连续 30 秒没有数据」，
 * 慢速但持续有数据的 1GB 传输不会被误杀。超限在累计字节处立即销毁连接。
 *
 * `fetchBytesWithContentType` / `fetchBytesWithLimits` 是整份字节的便捷封装，**当前没有生产
 * 调用方**（edit_image 也已改走 `loadSendFileBytes → openSendBytesStream`）；保留只为单测与
 * 将来确有整份需求的小文件场景。生产链路一律用下面的流式入口。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface FetchedBytes {
  bytes: Buffer;
  /** 响应头 content-type（未去参数）；无头或缺省为 null。发送工具据此推导副本扩展名 / mime。 */
  contentType: string | null;
}

export interface FetchedStream {
  /** 响应体流（含大小上限与空闲超时保护）。 */
  stream: Readable;
  /** 响应头 content-length；缺失 / 非法为 null（调用方边下边计）。 */
  size: number | null;
  contentType: string | null;
}

export interface FetchTimeouts {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export function fetchBytesWithLimits(
  url: string,
  maxBytes: number,
  timeouts: FetchTimeouts = {},
): Promise<Buffer> {
  return fetchBytesWithContentType(url, maxBytes, timeouts).then((fetched) => fetched.bytes);
}

export function fetchBytesWithContentType(
  url: string,
  maxBytes: number,
  timeouts: FetchTimeouts = {},
): Promise<FetchedBytes> {
  return fetchBytesStreamWithContentType(url, maxBytes, timeouts).then(async (fetched) => {
    const chunks: Buffer[] = [];
    for await (const chunk of fetched.stream) {
      chunks.push(chunk as Buffer);
    }
    return { bytes: Buffer.concat(chunks), contentType: fetched.contentType };
  });
}

/**
 * 流式下载入口：返回的流带「累计超过 maxBytes 立即报错」「连续 readTimeoutMs 无数据报错」
 * 两个保护，调用方 pipe 到落盘流即可。连接超时只作用于拿到响应头之前。
 */
export function fetchBytesStreamWithContentType(
  url: string,
  maxBytes: number,
  timeouts: FetchTimeouts = {},
): Promise<FetchedStream> {
  const connectTimeoutMs = timeouts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const readTimeoutMs = timeouts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      reject(err);
    };

    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      clearConnectTimer();
      const status = res.statusCode ?? 500;
      if (status < 200 || status >= 300) {
        res.resume();
        fail(new Error(`下载失败: HTTP ${status}`));
        return;
      }
      const header = res.headers['content-type'];
      const contentType = typeof header === 'string' && header.trim() !== '' ? header.trim() : null;
      const rawLength = res.headers['content-length'];
      const declared = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      if (declared != null && declared > maxBytes) {
        res.resume();
        fail(new Error(`下载内容超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 上限`));
        return;
      }

      let total = 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const armIdle = (stream: Transform) => {
        clearIdle();
        idleTimer = setTimeout(() => {
          stream.destroy(new Error('下载超时，目标服务器无响应'));
          req.destroy();
        }, readTimeoutMs);
      };

      const guard = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          total += chunk.length;
          if (total > maxBytes) {
            callback(new Error(`下载内容超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 上限`));
            req.destroy();
            return;
          }
          armIdle(this);
          callback(null, chunk);
        },
        flush(callback) {
          clearIdle();
          callback();
        },
        destroy(err, callback) {
          clearIdle();
          callback(err);
        },
      });
      guard.on('close', clearIdle);
      guard.on('error', () => req.destroy());
      res.on('error', (err) => guard.destroy(err));
      res.on('aborted', () => guard.destroy(new Error('下载中断')));
      res.pipe(guard);
      armIdle(guard);

      settled = true;
      resolvePromise({ stream: guard, size: declared, contentType });
    });

    connectTimer = setTimeout(() => {
      req.destroy();
      fail(new Error('下载超时，目标服务器连接无响应'));
    }, connectTimeoutMs);

    // 拿到响应头之后连接定时器即失效；请求错误统一收敛（settled 之后不再重复 reject）
    req.on('error', (err) => fail(err));
  });
}
