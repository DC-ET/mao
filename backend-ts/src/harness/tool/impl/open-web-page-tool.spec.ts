import http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OpenWebPageTool } from './open-web-page-tool.js';

describe('OpenWebPageTool', () => {
  const tool = new OpenWebPageTool({
    connectTimeout: 3000,
    readTimeout: 3000,
    maxRawBytes: 1_000_000,
    maxOutputLength: 20_000,
    userAgent: 'mao-test',
  });

  it('rejects empty and non-http urls', async () => {
    expect(JSON.parse(await tool.execute('{}'))).toMatchObject({ error: expect.stringContaining('URL') });
    expect(JSON.parse(await tool.execute(JSON.stringify({ url: 'ftp://x' })))).toMatchObject({
      error: expect.stringContaining('协议'),
    });
  });

  it('extracts article html to markdown json', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Hello</title></head>
        <body><article><h1>Hello</h1><p>World content for extraction.</p></article></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const raw = await tool.execute(JSON.stringify({ url: `http://127.0.0.1:${port}/` }));
      const json = JSON.parse(raw) as { title?: string; content?: string; url?: string };
      expect(json.url).toContain('127.0.0.1');
      expect(json.content ?? json.title).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('truncates oversized html without waiting for read timeout', async () => {
    const marker = '<article><p>KEEP_ME</p></article>';
    const payload = Buffer.concat([
      Buffer.from(`<!doctype html><html><body>${marker}`),
      Buffer.alloc(400_000, 'x'),
      Buffer.from('</body></html>'),
    ]);
    const small = new OpenWebPageTool({
      connectTimeout: 1500,
      readTimeout: 1500,
      maxRawBytes: 20_000,
      maxOutputLength: 20_000,
      userAgent: 'mao-test',
    });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(payload);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    try {
      const json = JSON.parse(await small.execute(JSON.stringify({ url: `http://127.0.0.1:${port}/` }))) as {
        error?: string;
        content?: string;
      };
      expect(json.error).toBeUndefined();
      expect(json.content).toContain('KEEP');
      expect(Date.now() - started).toBeLessThan(1400);
    } finally {
      server.close();
    }
  });

  it('follows http redirects', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><article><p>Redirected body</p></article></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const json = JSON.parse(await tool.execute(JSON.stringify({ url: `http://127.0.0.1:${port}/go` }))) as {
        content?: string;
      };
      expect(json.content).toContain('Redirected body');
    } finally {
      server.close();
    }
  });
});
