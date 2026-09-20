import http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenWebPageTool } from './open-web-page-tool.js';

const BIG_MARKER = 'TERMIUS-PRICING-FULL-BODY';

/** 造一个超过 maxOutputLength 的正文页面（正文 ASCII，长度可预测）。 */
function bigPageServer(chars: number): Promise<{ port: number; close: () => void }> {
  // 用连字符避免 turndown 把下划线转义成 \_，干扰断言。
  const filler = 'B'.repeat(Math.max(0, chars));
  const body = `<article><h1>${BIG_MARKER}</h1><p>${filler}</p></article>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Big</title></head><body>${body}</body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

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

  it('does not spill to disk when content fits within maxOutputLength', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mao-webpage-fit-'));
    try {
      const cache = { resolveWebPageCacheDir: (uid: number, sid: number) => join(root, String(uid), String(sid), 'webPages') };
      const local = new OpenWebPageTool({
        connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 1_000_000, maxOutputLength: 50_000,
        userAgent: 'mao-test',
      }, cache);
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><article><p>short body</p></article></body></html>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        const json = JSON.parse(await local.execute(
          JSON.stringify({ url: `http://127.0.0.1:${port}/short` }), 77, 7, null,
        )) as { truncated?: boolean; full_content_file?: string; message?: string; content_length?: number };
        expect(json.truncated).toBe(false);
        expect(json.full_content_file).toBeUndefined();
        expect(json.message).toBeUndefined();
        expect(existsSync(join(root, '7', '77', 'webPages'))).toBe(false);
      } finally {
        server.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spills full content to runtime dir and returns the path when truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mao-webpage-spill-'));
    try {
      const cache = { resolveWebPageCacheDir: (uid: number, sid: number) => join(root, String(uid), String(sid), 'webPages') };
      const local = new OpenWebPageTool({
        connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
        userAgent: 'mao-test',
      }, cache);
      const page = await bigPageServer(20_000);
      try {
        const json = JSON.parse(await local.execute(
          JSON.stringify({ url: `http://127.0.0.1:${page.port}/big` }), 42, 9, null,
        )) as { truncated?: boolean; full_content_file?: string; message?: string; content?: string; content_length?: number };
        expect(json.truncated).toBe(true);
        expect(typeof json.full_content_file).toBe('string');
        // 落盘文件必须存在，且包含被截断戳记之外的完整正文
        const file = json.full_content_file as string;
        expect(existsSync(file)).toBe(true);
        const onDisk = readFileSync(file, 'utf8');
        expect(onDisk).toContain(BIG_MARKER);
        expect(onDisk.length).toBeGreaterThan(json.content_length ?? 0);
        // 正文末尾明确告知 Agent 去哪读，避免模型以为内容就是这么多
        expect(json.content).toContain('内容已截断');
        expect(json.content).toContain('full_content_file');
        expect(json.message).toContain(file);
        expect(json.message).toContain('read_file');
      } finally {
        page.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports truncation without a file path when spilling is unavailable', async () => {
    const local = new OpenWebPageTool({
      connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
      userAgent: 'mao-test',
    }); // 无 cacheLocator：等价于缺 uid/sid 或 LOCAL
    const page = await bigPageServer(20_000);
    try {
      const json = JSON.parse(await local.execute(
        JSON.stringify({ url: `http://127.0.0.1:${page.port}/big` }), 42, 9, null,
      )) as { truncated?: boolean; full_content_file?: string; message?: string; content?: string };
      expect(json.truncated).toBe(true);
      expect(json.full_content_file).toBeUndefined();
      expect(json.content).toContain('内容已截断');
      expect(json.message).toContain('落盘失败');
    } finally {
      page.close();
    }
  });

  it('still returns truncated content when writing the spill file throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mao-webpage-fail-'));
    try {
      const brokenCache = {
        resolveWebPageCacheDir: () => { throw new Error('disk on fire'); },
      };
      const local = new OpenWebPageTool({
        connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
        userAgent: 'mao-test',
      }, brokenCache);
      const page = await bigPageServer(20_000);
      try {
        const json = JSON.parse(await local.execute(
          JSON.stringify({ url: `http://127.0.0.1:${page.port}/big` }), 42, 9, null,
        )) as { truncated?: boolean; full_content_file?: string; message?: string; content?: string };
        expect(json.truncated).toBe(true);
        expect(json.full_content_file).toBeUndefined();
        expect(json.message).toContain('落盘失败');
        expect(json.content).toContain('内容已截断');
      } finally {
        page.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
