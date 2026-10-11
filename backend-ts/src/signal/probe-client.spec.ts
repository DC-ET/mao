import { createHash } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { executeProbe } from './probe-client.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function withServer(
  handler: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address != null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('executeProbe', () => {
  it('returns body and status for a normal response', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    }, async (base) => {
      const result = await executeProbe({ url: base, method: 'GET', headers: {}, body: null });
      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.body).toBe('hello');
      expect(result.error).toBeNull();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('treats non-2xx as a valid probe input (ok=true)', async () => {
    await withServer((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    }, async (base) => {
      const result = await executeProbe({ url: base, method: 'GET', headers: {}, body: null });
      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(503);
      expect(result.body).toBe('unavailable');
    });
  });

  it('fails on redirect without following it', async () => {
    await withServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/other' });
      res.end();
    }, async (base) => {
      const result = await executeProbe({ url: base, method: 'GET', headers: {}, body: null });
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(302);
      expect(result.error).toContain('重定向');
    });
  });

  it('sends method, headers and body for POST probes', async () => {
    await withServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200);
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, raw }));
      });
    }, async (base) => {
      const result = await executeProbe({
        url: base,
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });
      expect(result.ok).toBe(true);
      const payload = JSON.parse(result.body ?? '{}') as { method: string; auth: string; raw: string };
      expect(payload.method).toBe('POST');
      expect(payload.auth).toBe('Bearer t');
      expect(payload.raw).toBe('{"a":1}');
    });
  });

  it('fails when the response exceeds the size cap', async () => {
    await withServer((req, res) => {
      res.writeHead(200);
      // 1.5MB，超过 1MB 上限
      res.end(Buffer.alloc(1536 * 1024, 0x61));
    }, async (base) => {
      const result = await executeProbe({ url: base, method: 'GET', headers: {}, body: null });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('上限');
      expect(result.bodyBytes).toBeNull();
    });
  });

  it('fails on read timeout when the peer stalls', async () => {
    await withServer((req, res) => {
      res.writeHead(200);
      res.write('partial');
      // 永不 end：读超时应触发
    }, async (base) => {
      const result = await executeProbe(
        { url: base, method: 'GET', headers: {}, body: null },
        { connectTimeoutMs: 2000, readTimeoutMs: 300 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('读取超时');
    });
  });

  it('fails on connect timeout when nothing listens on the port', async () => {
    const result = await executeProbe(
      // 198.51.100.1 是 TEST-NET-2 保留段，不会被路由，稳定触发连接超时
      { url: 'http://198.51.100.1:81/', method: 'GET', headers: {}, body: null },
      { connectTimeoutMs: 300, readTimeoutMs: 300 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails on connection refused with a code-bearing message', async () => {
    await withServer((_req, res) => { res.end('x'); }, async (base) => {
      const url = new URL(base);
      url.port = '1';
      const result = await executeProbe({ url: url.toString(), method: 'GET', headers: {}, body: null });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  it('rejects malformed urls without throwing', async () => {
    const result = await executeProbe({ url: 'not-a-url', method: 'GET', headers: {}, body: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('URL 不合法');
  });

  it('rejects non-http protocols without throwing', async () => {
    const result = await executeProbe({ url: 'ftp://example.com/x', method: 'GET', headers: {}, body: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http/https');
  });

  it('hash of bodyBytes matches utf8 sha256', async () => {
    await withServer((req, res) => { res.writeHead(200); res.end('payload'); }, async (base) => {
      const result = await executeProbe({ url: base, method: 'GET', headers: {}, body: null });
      expect(result.bodyBytes).not.toBeNull();
      expect(createHash('sha256').update(result.bodyBytes!).digest('hex')).toBe(sha256('payload'));
    });
  });
});
