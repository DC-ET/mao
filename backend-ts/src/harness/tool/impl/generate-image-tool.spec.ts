import http from 'node:http';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { GenerateImageTool } from './generate-image-tool.js';
import { EditImageTool } from './edit-image-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { normalizeImageModelName, buildAuthorizationHeader, stripTrailingSlash } from '../image-api-client.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

type Mode = 'ok' | 'url-only' | 'rate-limit' | 'task' | 'empty' | 'non-json' | 'edit-ok' | 'client-error';

let server: http.Server;
let port = 0;
let lastHeaders: http.IncomingHttpHeaders = {};
let lastBody: Record<string, unknown> | null = null;
let lastPath = '';
let lastRawBody = Buffer.alloc(0);
let mode: Mode = 'ok';
let rateLimitHits = 0;
let clientErrorHits = 0;

function handleGenerateOrEdit(req: http.IncomingMessage, res: http.ServerResponse, text: string) {
  if (mode === 'rate-limit' && rateLimitHits < 1) {
    rateLimitHits++;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }));
    return;
  }
  if (mode === 'client-error') {
    clientErrorHits++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad prompt', code: 'invalid_request' } }));
    return;
  }
  if (mode === 'non-json') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not-json');
    return;
  }
  if (mode === 'task') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ task_id: 't1' }] }));
    return;
  }
  if (mode === 'empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (mode === 'url-only') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      created: 1,
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      data: [{ url: `/img.png` }],
      usage: { total_tokens: 10 },
    }));
    return;
  }
  // ok / edit-ok
  const isEdit = lastPath.includes('/images/edits');
  const n = lastBody && typeof lastBody.n === 'number' ? lastBody.n : 1;
  const count = Math.min(10, Math.max(1, n));
  const data = Array.from({ length: isEdit ? 1 : count }, (_, i) => ({
    b64_json: PNG_BYTES.toString('base64'),
    generation_id: isEdit ? 'e1' : `g${i}`,
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    revised_prompt: i === 0 ? 'a revised cat' : undefined,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    created: 1,
    background: 'opaque',
    output_format: 'png',
    quality: 'low',
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    data,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  }));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    lastPath = req.url ?? '';
    if (req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      lastRawBody = Buffer.concat(chunks);
      const text = lastRawBody.toString('utf8');
      try {
        lastBody = text ? JSON.parse(text) : null;
      } catch {
        // multipart or non-json body
        lastBody = { rawLen: lastRawBody.length, rawHead: text.slice(0, 200) };
      }
      handleGenerateOrEdit(req, res, text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));

beforeEach(() => {
  lastHeaders = {};
  lastBody = null;
  lastPath = '';
  lastRawBody = Buffer.alloc(0);
  mode = 'ok';
  rateLimitHits = 0;
  clientErrorHits = 0;
});

const model = (extra?: Record<string, unknown> | null) => {
  if (extra === null) return null;
  return {
    modelId: 'gpt-image-2.5-flare',
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    ...extra,
  };
};

describe('normalizeImageModelName', () => {
  it('maps aliases to full names', () => {
    expect(normalizeImageModelName('flare')).toBe('gpt-image-2.5-flare');
    expect(normalizeImageModelName('gpt-image-2.5-flare')).toBe('gpt-image-2.5-flare');
    expect(normalizeImageModelName('sunburst')).toBe('gpt-image-2.5-sunburst');
    expect(normalizeImageModelName('gpt-image-2')).toBe('gpt-image-2');
    expect(normalizeImageModelName('custom-x')).toBe('custom-x');
  });

  it('builds auth and base url helpers', () => {
    expect(buildAuthorizationHeader('sk-1')).toBe('Bearer sk-1');
    expect(buildAuthorizationHeader('Bearer sk-1')).toBe('Bearer sk-1');
    expect(stripTrailingSlash('https://x/v1/')).toBe('https://x/v1');
  });
});

describe('GenerateImageTool', () => {
  function makeTool(extra?: Record<string, unknown> | null) {
    const dir = useTmpDir('img-');
    const tool = new GenerateImageTool({
      findFirstActiveImageModel: async () => model(extra) as never,
    }, dir, async () => 'https://mao.example/uploads');
    return { tool, dir };
  }

  it('generates images from mock api with protocol-shaped body', async () => {
    const { tool, dir } = makeTool();
    expect(tool.getName()).toBe('generate_image');
    expect(tool.getToolPrompt()).toContain('prompt');
    expect(tool.getToolPrompt()).toContain('edit_image');

    const missing = JSON.parse(await tool.execute('{}', 1, null));
    expect(missing.error).toContain('prompt');

    const emptyModel = new GenerateImageTool({ findFirstActiveImageModel: async () => null }, dir);
    expect(JSON.parse(await emptyModel.execute(JSON.stringify({ prompt: 'cat' }), 1, null)).error).toContain('文生图');

    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
      quality: 'low',
    }), 1, null));
    expect(result.images.length).toBe(2);
    expect(result.images[0].image_url).toContain('uploads');
    expect(result.images[0].image_path).toBeTruthy();
    expect(result.images[0].size_bytes).toBe(PNG_BYTES.length);
    expect(result.model).toBe('gpt-image-2.5-flare');
    expect(result.size).toBe('1024x1024');
    expect(result.revised_prompt).toBe('a revised cat');
    expect(result.usage.total_tokens).toBe(3);

    expect(lastPath).toBe('/images/generations');
    expect(lastBody).toMatchObject({ model: 'gpt-image-2.5-flare', prompt: 'a cat', n: 2, size: '1024x1024', quality: 'low' });
    expect(lastBody).not.toHaveProperty('response_format');
    expect(lastBody).not.toHaveProperty('background');
    expect(lastBody).not.toHaveProperty('image');
    expect(lastBody).not.toHaveProperty('mask');
    expect(lastHeaders.authorization).toBe('Bearer k');
    expect(lastHeaders['accept-encoding']).toBe('identity');

    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('gen-') && f.endsWith('.png'))).toBe(true);
  });

  it('clamps n and normalizes model override aliases', async () => {
    const { tool } = makeTool();
    await tool.execute(JSON.stringify({ prompt: 'cat', n: 99, model: 'flare' }), 1, null);
    expect((lastBody as Record<string, unknown>).n).toBe(10);
    expect((lastBody as Record<string, unknown>).model).toBe('gpt-image-2.5-flare');

    await tool.execute(JSON.stringify({ prompt: 'cat', n: 0, model: 'sunburst' }), 1, null);
    expect((lastBody as Record<string, unknown>).n).toBe(1);
    expect((lastBody as Record<string, unknown>).model).toBe('gpt-image-2.5-sunburst');
  });

  it('rejects invalid size/quality', async () => {
    const { tool } = makeTool();
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'c', size: '9x9' }), 1, null)).error).toContain('size');
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'c', quality: 'ultra' }), 1, null)).error).toContain('quality');
  });

  it('does not retry on 400', async () => {
    mode = 'client-error';
    const { tool } = makeTool();
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(result.http_status).toBe(400);
    expect(result.error_code).toBe('invalid_request');
    expect(clientErrorHits).toBe(1);
  });

  it('downloads url-only results (relative url)', async () => {
    mode = 'url-only';
    const { tool } = makeTool();
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(result.error).toBeUndefined();
    expect(result.images[0].source).toBe('url');
    expect(result.images[0].image_path).toBeTruthy();
  });

  it('rejects async task_id and empty data', async () => {
    const { tool } = makeTool();
    mode = 'task';
    const task = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(task.error_code).toBe('async_task_unsupported');

    mode = 'empty';
    const empty = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(empty.error_code).toBe('empty_data');
  });

  it('surfaces non-json and retries rate limit', async () => {
    const { tool } = makeTool();
    mode = 'non-json';
    const nonJson = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(nonJson.error).toContain('非 JSON');

    mode = 'rate-limit';
    rateLimitHits = 0;
    const retried = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null));
    expect(retried.error).toBeUndefined();
    expect(retried.images.length).toBeGreaterThan(0);
  }, 15_000);

  it('injects client impersonation headers when configured', async () => {
    const { tool } = makeTool({ clientImpersonation: 'codex' });
    await tool.execute(JSON.stringify({ prompt: 'a cat' }), 1, null);
    expect(lastHeaders['user-agent']).toBe('codex_cli_rs/0.146.0 (Linux 6.1.0; x86_64) xterm-256color');
    expect(lastHeaders.originator).toBe('codex_cli_rs');
  });
});

describe('EditImageTool', () => {
  function makeTool(extra?: Record<string, unknown> | null) {
    const ws = useTmpDir('edit-ws-');
    const out = useTmpDir('edit-out-');
    mkdirSync(join(ws, 'chat-files'), { recursive: true });
    writeFileSync(join(ws, 'input.png'), PNG_BYTES);
    writeFileSync(join(ws, 'mask.png'), PNG_BYTES);
    const tool = new EditImageTool(
      { findFirstActiveImageModel: async () => model(extra) as never },
      new PathSandbox(ws),
      out,
      async () => 'https://mao.example/uploads',
    );
    return { tool, ws, out };
  }

  it('edits local images via multipart and returns files', async () => {
    const { tool, out } = makeTool();
    expect(tool.getName()).toBe('edit_image');
    expect(tool.getToolPrompt()).toContain('image_paths');

    const missingPrompt = JSON.parse(await tool.execute(JSON.stringify({ image_paths: 'input.png' }), 1, null, null));
    expect(missingPrompt.error).toContain('prompt');

    const missingImage = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x' }), 1, null, null));
    expect(missingImage.error).toContain('image_paths');

    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: '把小猫改成蓝色',
      image_paths: ['input.png', 'mask.png'],
      mask_path: 'mask.png',
      quality: 'low',
      output_format: 'png',
    }), 1, null, null));
    expect(result.error).toBeUndefined();
    expect(result.images.length).toBe(1);
    expect(result.images[0].image_url).toContain('uploads');
    expect(result.images[0].source).toBe('b64_json');

    expect(lastPath).toBe('/images/edits');
    const contentType = String(lastHeaders['content-type'] ?? '');
    expect(contentType).toContain('multipart/form-data');
    expect(contentType).toContain('boundary=');
    // multipart body contains repeated image field names and model/prompt
    const raw = lastRawBody.toString('latin1');
    expect(raw.match(/name="image"/g)?.length).toBe(2);
    expect(raw).toContain('name="mask"');
    expect(raw).toContain('name="model"');
    expect(raw).toContain('name="prompt"');
    expect(raw).toContain('gpt-image-2.5-flare');
    expect(raw).toContain('name="output_format"');
    expect(raw).toContain('name="quality"');

    const files = readdirSync(out);
    expect(files.some((f) => f.startsWith('edit-') && f.endsWith('.png'))).toBe(true);
  });

  it('accepts singular image field and rejects url / missing / non-image', async () => {
    const { tool, ws } = makeTool();

    const url = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'https://example.com/a.png',
    }), 1, null, null));
    expect(url.error).toContain('本地');

    const missing = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'nope.png',
    }), 1, null, null));
    expect(missing.error).toContain('不存在');

    writeFileSync(join(ws, 'fake.png'), Buffer.from('not-an-image'));
    const bad = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'fake.png',
    }), 1, null, null));
    expect(bad.error).toContain('图片格式');

    writeFileSync(join(ws, 'huge.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(20 * 1024 * 1024 + 1)]));
    const tooBig = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'huge.png',
    }), 1, null, null));
    expect(tooBig.error).toContain('20MB');

    const ok = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'input.png',
    }), 1, null, null));
    expect(ok.error).toBeUndefined();
    expect(ok.images.length).toBe(1);
  });

  it('sends output_compression only for jpeg', async () => {
    const { tool } = makeTool();
    await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'input.png',
      output_format: 'png',
      output_compression: 80,
    }), 1, null, null);
    let raw = lastRawBody.toString('latin1');
    expect(raw).not.toContain('name="output_compression"');

    await tool.execute(JSON.stringify({
      prompt: 'x',
      image: 'input.png',
      output_format: 'jpeg',
      output_compression: 80,
    }), 1, null, null);
    raw = lastRawBody.toString('latin1');
    expect(raw).toContain('name="output_compression"');
    expect(raw).toContain('80');
  });

  it('validates enums and compression range', async () => {
    const { tool } = makeTool();
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image: 'input.png', size: '1x1' }), 1, null, null)).error).toContain('size');
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image: 'input.png', background: 'magic' }), 1, null, null)).error).toContain('background');
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image: 'input.png', output_format: 'webp' }), 1, null, null)).error).toContain('output_format');
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image: 'input.png', output_format: 'jpeg', output_compression: 200 }), 1, null, null)).error).toContain('output_compression');
  });
});
