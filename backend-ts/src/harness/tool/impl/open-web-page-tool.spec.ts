import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { useTmpDir } from '../../../testing/tmp-dir.js';
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
    const root = useTmpDir('mao-webpage-fit-');
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
  });

  it('spills full content to runtime dir and returns the path when truncated', async () => {
    const root = useTmpDir('mao-webpage-spill-');
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
      expect(json.message).toContain('未能落盘');
    } finally {
      page.close();
    }
  });

  it('LOCAL execution mode never spills to server disk even with a cache locator', async () => {
    const root = useTmpDir('mao-webpage-local-');
    const cache = { resolveWebPageCacheDir: (uid: number, sid: number) => join(root, String(uid), String(sid), 'webPages') };
    const local = new OpenWebPageTool({
      connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
      userAgent: 'mao-test',
    }, cache, async () => true); // LOCAL 模式
    const page = await bigPageServer(20_000);
    try {
      const json = JSON.parse(await local.execute(
        JSON.stringify({ url: `http://127.0.0.1:${page.port}/big` }), 42, 9, null,
      )) as { truncated?: boolean; full_content_file?: string; message?: string; content?: string };
      expect(json.truncated).toBe(true);
      // LOCAL：不落盘、不返回 full_content_file，且不应指引模型去 read_file 服务端路径
      expect(json.full_content_file).toBeUndefined();
      expect(json.message).toContain('未能落盘');
      expect(json.message).not.toContain('read_file');
      expect(existsSync(join(root, '9', '42', 'webPages'))).toBe(false);
    } finally {
      page.close();
    }
  });

  it('CLOUD execution mode still spills full content with a cache locator', async () => {
    const root = useTmpDir('mao-webpage-cloud-');
    const cache = { resolveWebPageCacheDir: (uid: number, sid: number) => join(root, String(uid), String(sid), 'webPages') };
    const cloud = new OpenWebPageTool({
      connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
      userAgent: 'mao-test',
    }, cache, async () => false); // CLOUD 模式
    const page = await bigPageServer(20_000);
    try {
      const json = JSON.parse(await cloud.execute(
        JSON.stringify({ url: `http://127.0.0.1:${page.port}/big` }), 42, 9, null,
      )) as { truncated?: boolean; full_content_file?: string; message?: string };
      expect(json.truncated).toBe(true);
      expect(typeof json.full_content_file).toBe('string');
      expect(existsSync(json.full_content_file as string)).toBe(true);
    } finally {
      page.close();
    }
  });

  it('different urls sharing the last path segment spill to different files (no overwrite)', async () => {
    // urlSlug 必须含 URL 哈希：同会话内 /docs/intro 与 /api/intro 的截断全文
    // 不得互相覆盖，否则模型按第一次结果的路径 read_file 会读到另一个网页的内容。
    const root = useTmpDir('mao-webpage-collision-');
    const cache = { resolveWebPageCacheDir: (uid: number, sid: number) => join(root, String(uid), String(sid), 'webPages') };
    const local = new OpenWebPageTool({
      connectTimeout: 3000, readTimeout: 3000, maxRawBytes: 2_000_000, maxOutputLength: 2_000,
      userAgent: 'mao-test',
    }, cache);
    const markerA = 'DOCS-INTRO-MARKER';
    const markerB = 'API-INTRO-MARKER';
    const server = http.createServer((req, res) => {
      const marker = req.url?.startsWith('/docs/intro') ? markerA : markerB;
      const body = `<article><h1>${marker}</h1><p>${'C'.repeat(20_000)}</p></article>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const first = JSON.parse(await local.execute(
        JSON.stringify({ url: `http://127.0.0.1:${port}/docs/intro` }), 42, 9, null,
      )) as { truncated?: boolean; full_content_file?: string };
      const second = JSON.parse(await local.execute(
        JSON.stringify({ url: `http://127.0.0.1:${port}/api/intro` }), 42, 9, null,
      )) as { truncated?: boolean; full_content_file?: string };
      expect(first.truncated).toBe(true);
      expect(second.truncated).toBe(true);
      expect(first.full_content_file).not.toBe(second.full_content_file);
      // 第一份全文未被第二份覆盖
      expect(readFileSync(first.full_content_file as string, 'utf8')).toContain(markerA);
      expect(readFileSync(second.full_content_file as string, 'utf8')).toContain(markerB);
      // 同一 URL 重复抓取仍覆盖同一文件（哈希稳定）
      const again = JSON.parse(await local.execute(
        JSON.stringify({ url: `http://127.0.0.1:${port}/docs/intro` }), 42, 9, null,
      )) as { full_content_file?: string };
      expect(again.full_content_file).toBe(first.full_content_file);
    } finally {
      server.close();
    }
  });
});
