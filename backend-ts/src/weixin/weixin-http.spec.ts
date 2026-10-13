import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWeixinHttpAgent, createWeixinHttpClient, weixinRequest } from './weixin-http.js';

describe('weixin-http', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Echo': 'yes' });
          res.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : 'ok');
        });
        return;
      }
      if (req.url === '/hang') {
        return; // 永不响应 → 触发 timeout 分支
      }
      res.writeHead(404);
      res.end('missing');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));

  it('gets and posts over local http', async () => {
    const client = createWeixinHttpClient(5_000);
    const get = await client.request(`http://127.0.0.1:${port}/echo`);
    expect(get.status).toBe(200);
    expect(get.body.toString()).toBe('ok');
    expect(get.header('x-echo')).toBe('yes');
    const posted = await weixinRequest(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      body: 'hello',
      httpAgent: createWeixinHttpAgent(5_000),
    });
    expect(posted.body.toString()).toBe('hello');
    const missing = await weixinRequest(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);
  });

  // round 1 BUG-9：超时错误必须带 code='ETIMEDOUT'（Node 网络错误的惯例）。
  // 本仓超时错误的唯一产生点就在这里；调用方（qr-login 的 isTimeoutError）按 code
  // 判定超时，普通 Error 会让那些判据恒不命中。
  it('attaches the ETIMEDOUT code to the timeout error', async () => {
    const err = await weixinRequest(`http://127.0.0.1:${port}/hang`, { timeoutMs: 200 })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe('ETIMEDOUT');
    expect((err as Error).message).toBe('timeout after 200ms');
  });
});
