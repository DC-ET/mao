import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchBytesWithLimits } from './fetch-bytes.js';

describe('fetchBytesWithLimits', () => {
  let server: Server | null = null;
  const listen = (handler: Parameters<typeof createServer>[0]): Promise<string> =>
    new Promise((resolvePromise) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        resolvePromise(`http://127.0.0.1:${port}/x`);
      });
    });

  afterEach(async () => {
    if (server) {
      await new Promise((r) => server!.close(r));
      server = null;
    }
  });

  it('正常下载返回完整内容', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from('hello world'));
    });
    const buf = await fetchBytesWithLimits(url, 1024);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('HTTP 错误状态码报错', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    await expect(fetchBytesWithLimits(url, 1024)).rejects.toThrow('HTTP 404');
  });

  it('超过流式大小上限立即中止并报错', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // 分多块写，总大小超过上限；对端断开时停止写入
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const timer = setInterval(() => {
        sent += chunk.length;
        if (sent > 4 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(chunk);
      }, 2);
      res.on('close', () => clearInterval(timer));
    });
    await expect(fetchBytesWithLimits(url, 128 * 1024)).rejects.toThrow('上限');
  });

  it('对端挂起时按读取超时中止', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // 永不写数据、永不结束
    });
    await expect(
      fetchBytesWithLimits(url, 1024, { connectTimeoutMs: 500, readTimeoutMs: 300 }),
    ).rejects.toThrow('下载超时');
  });

  it('连接阶段无响应按连接超时中止', async () => {
    // 接受 TCP 连接但永不返回 HTTP 响应头
    const url = await listen(() => {
      // 不调用任何 res 方法
    });
    // 注意：Node 在收到请求头前就触发 callback 与否取决于实现；此处服务器回调不响应，
    // 客户端应先在 connect 或 read 阶段超时。
    await expect(
      fetchBytesWithLimits(url, 1024, { connectTimeoutMs: 300, readTimeoutMs: 300 }),
    ).rejects.toThrow('下载超时');
  });
});
