import http from 'node:http';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { GenerateImageTool, materializeImageApiResult, toStaticUploadBase } from './generate-image-tool.js';
import { EditImageTool } from './edit-image-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import type { SendBytesSupport } from './send-file-bytes.js';
import type { ImageApiResult } from '../image-api-client.js';
import { normalizeImageModelName, buildAuthorizationHeader, stripTrailingSlash } from '../image-api-client.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

type Mode = 'ok' | 'url-only' | 'rate-limit' | 'task' | 'empty' | 'non-json' | 'edit-ok' | 'client-error' | 'url-download-fail';

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
    // 错误体里回显 Authorization（反代错误页 / 调试网关常见）：只有这样
    // 「错误摘要不含 apiKey」才是真断言。早先错误体是 'bad prompt'，本来就不含
    // key，断言恒真——脱敏逻辑整个坏掉也测不出来。
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad prompt: ${String(req.headers.authorization ?? '')}`, code: 'invalid_request' } }));
    return;
  }
  if (mode === 'url-download-fail') {
    // 上游 200 且已返回 usage，但图片 URL 下载失败：token 已经计费，流水必须记
    // 「失败 + usage 非空」，而不是 usage=null 的纯失败行（P2）。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      created: 1,
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      data: [{ url: 'http://127.0.0.1:1/missing.png' }],
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
    }));
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
    apiKey: 'sk-image-secret-12345',
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

describe('materializeImageApiResult（图片产物按用户隔离）', () => {
  const apiResult: ImageApiResult = {
    images: [{ bytes: PNG_BYTES, mime: 'image/png', source: 'b64_json', fileName: 'a.png' }],
    model: 'gpt-image-2.5-flare',
  };

  it('derives static origin by stripping a trailing /api', () => {
    expect(toStaticUploadBase('https://mao.example/api')).toBe('https://mao.example');
    expect(toStaticUploadBase('https://mao.example/api/')).toBe('https://mao.example');
    expect(toStaticUploadBase('https://mao.example')).toBe('https://mao.example');
    expect(toStaticUploadBase('https://mao.example/')).toBe('https://mao.example');
    expect(toStaticUploadBase('')).toBe('');
  });

  it('strips the configured contextPath instead of a hardcoded /api', () => {
    // 后台自定义 contextPath=/api/v1：硬编码剥 /api 会残留 /api/v1，image_url 必 404
    expect(toStaticUploadBase('https://mao.example/api/v1', '/api/v1')).toBe('https://mao.example');
    expect(toStaticUploadBase('https://mao.example/api/v1/', '/api/v1')).toBe('https://mao.example');
    // 默认 contextPath 未传时按 /api 兜底
    expect(toStaticUploadBase('https://mao.example/api/v1')).toBe('https://mao.example/api/v1');
    // contextPath 为空（裸域名部署）：原样返回，由后端 /uploads/ 前缀兜底
    expect(toStaticUploadBase('https://mao.example/api', '')).toBe('https://mao.example/api');
  });

  it('builds the uploads url for a custom contextPath', () => {
    const dir = useTmpDir('mat-');
    const payload = materializeImageApiResult(apiResult, dir, 'gen', 'https://mao.example/api/v1', 'cat', 7, '/api/v1');
    const image = payload.images[0] as Record<string, unknown>;
    const fileName = basename(image.image_path as string);
    expect(image.image_url).toBe(`https://mao.example/uploads/7/${fileName}`);
  });

  it('writes into {uploadDir}/{userId} and builds /uploads/{uid}/ url', () => {
    const dir = useTmpDir('mat-');
    const payload = materializeImageApiResult(apiResult, dir, 'gen', 'https://mao.example/api', 'cat', 7);
    const image = payload.images[0] as Record<string, unknown>;
    const fileName = basename(image.image_path as string);
    expect(image.image_path).toBe(join(dir, '7', fileName));
    expect(image.image_url).toBe(`https://mao.example/uploads/7/${fileName}`);
    expect(existsSync(image.image_path as string)).toBe(true);
    expect(payload.model).toBe('gpt-image-2.5-flare');
  });

  it('falls back to the flat dir when userId is absent (internal/test callers)', () => {
    const dir = useTmpDir('mat-');
    const payload = materializeImageApiResult(apiResult, dir, 'gen', 'https://mao.example/api', 'cat');
    const image = payload.images[0] as Record<string, unknown>;
    const fileName = basename(image.image_path as string);
    expect(image.image_path).toBe(join(dir, fileName));
    expect(image.image_url).toBe(`https://mao.example/uploads/${fileName}`);
    expect(readdirSync(dir).some((f) => f === fileName)).toBe(true);
  });

  it('falls back to the absolute path when baseUrl is empty', () => {
    const dir = useTmpDir('mat-');
    const payload = materializeImageApiResult(apiResult, dir, 'edit', '', 'cat', 7);
    const image = payload.images[0] as Record<string, unknown>;
    expect(image.image_url).toBe(image.image_path);
    expect(image.image_path as string).toContain(join(dir, '7'));
  });
});

describe('GenerateImageTool', () => {
  function makeTool(extra?: Record<string, unknown> | null) {
    const dir = useTmpDir('img-');
    const tool = new GenerateImageTool({
      findImageModel: async () => model(extra) as never,
    }, dir, async () => 'https://mao.example/api');
    return { tool, dir };
  }

  it('generates images from mock api with protocol-shaped body', async () => {
    const { tool, dir } = makeTool();
    expect(tool.getName()).toBe('generate_image');
    expect(tool.getToolPrompt()).toContain('prompt');
    expect(tool.getToolPrompt()).toContain('edit_image');

    const missing = JSON.parse(await tool.execute('{}', 1, null));
    expect(missing.error).toContain('prompt');

    const emptyModel = new GenerateImageTool({ findImageModel: async () => null }, dir);
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
    expect(lastHeaders.authorization).toBe('Bearer sk-image-secret-12345');
    expect(lastHeaders['accept-encoding']).toBe('identity');

    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('gen-') && f.endsWith('.png'))).toBe(true);
  });

  it('isolates artifacts per user when userId is present', async () => {
    const { tool, dir } = makeTool();
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, 7, null));
    expect(result.error).toBeUndefined();
    const image = result.images[0];
    expect(image.image_path.startsWith(join(dir, '7') + sep)).toBe(true);
    expect(image.image_url.startsWith('https://mao.example/uploads/7/')).toBe(true);
    const fileName = basename(image.image_path);
    expect(existsSync(join(dir, '7', fileName))).toBe(true);
    // 只建 {uid} 子目录，平坦根不落文件
    expect(readdirSync(dir)).toEqual(['7']);
  });

  it('keeps the flat dir for callers without a user context', async () => {
    const { tool, dir } = makeTool();
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1));
    expect(result.error).toBeUndefined();
    const image = result.images[0];
    expect(image.image_path.startsWith(dir + sep)).toBe(true);
    expect(image.image_path).not.toContain(`${join(dir, '7')}`);
    expect(image.image_url.startsWith('https://mao.example/uploads/gen-')).toBe(true);
  });

  it('passes the current agentId to the model lookup（绑定模型按 Agent 解析）', async () => {
    const dir = useTmpDir('img-agent-');
    const seen: Array<number | null> = [];
    const tool = new GenerateImageTool({
      findImageModel: async (agentId: number | null) => { seen.push(agentId); return model() as never; },
    }, dir, async () => 'https://mao.example/api');
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'cat' }), 1, null, null, 42));
    expect(result.error).toBeUndefined();
    expect(seen).toEqual([42]);
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

  it('resolves auth with explicit userId for ecp models', async () => {
    const seen: Array<{ userId?: number | null; authType?: string | null }> = [];
    const dir = useTmpDir('img-ecp-');
    const tool = new GenerateImageTool(
      { findImageModel: async () => model({ authType: 'ecp' }) as never },
      dir,
      async () => 'https://mao.example/api',
      '/api',
      {
        resolveApiKey: async (target, userId) => {
          seen.push({ userId, authType: target.authType });
          return 'ecp-token';
        },
      },
    );
    // 工具执行不在 LlmCallContext 内：必须把显式 userId 传给 resolver，否则 ecp 解析必失败。
    const resp = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 1, 7, null));
    expect(resp.error).toBeUndefined();
    expect(seen).toEqual([{ userId: 7, authType: 'ecp' }]);
    expect(lastHeaders.authorization).toBe('Bearer ecp-token');
  });
});

describe('EditImageTool', () => {
  /**
   * @param support 'host-bridge' = host 模式桥接桩（readBytes 返回 null 降级本地严格读，
   *   extraRoots 放行本人 uploads/{uid}，与 DockerSendBytesBridge 同口径）；
   *   其余值原样作为 SendBytesSupport 传入（默认 null = 无桥，只按会话工作区解析）。
   */
  function makeTool(extra?: Record<string, unknown> | null, support?: SendBytesSupport | null | 'host-bridge') {
    const ws = useTmpDir('edit-ws-');
    const out = useTmpDir('edit-out-');
    const uploads = useTmpDir('edit-uploads-');
    mkdirSync(join(ws, 'chat-files'), { recursive: true });
    writeFileSync(join(ws, 'input.png'), PNG_BYTES);
    writeFileSync(join(ws, 'mask.png'), PNG_BYTES);
    // 图片产物按用户隔离后的落盘形态：{uploads}/{uid}/gen-*.png
    mkdirSync(join(uploads, '7'), { recursive: true });
    mkdirSync(join(uploads, '8'), { recursive: true });
    writeFileSync(join(uploads, '7', 'gen-own.png'), PNG_BYTES);
    writeFileSync(join(uploads, '8', 'gen-other.png'), PNG_BYTES);
    const bridge: SendBytesSupport | null = support === 'host-bridge'
      ? {
        openStream: async () => null,
        readBytes: async () => null,
        extraRoots: (userId) => ['/tmp', join(uploads, String(userId))],
      }
      : (support ?? null);
    const tool = new EditImageTool(
      { findImageModel: async () => model(extra) as never },
      new PathSandbox(ws),
      out,
      async () => 'https://mao.example/api',
      bridge,
    );
    return { tool, ws, out, uploads };
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

  it('accepts own uploads artifacts as input and writes output under {uid}', async () => {
    const { tool, out, uploads } = makeTool(undefined, 'host-bridge');
    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image_paths: [join(uploads, '7', 'gen-own.png')],
    }), 1, 7, null));
    expect(result.error).toBeUndefined();
    const image = result.images[0];
    expect(image.image_path.startsWith(join(out, '7') + sep)).toBe(true);
    expect(image.image_url.startsWith('https://mao.example/uploads/7/edit-')).toBe(true);
    expect(readdirSync(join(out, '7')).some((f) => f.startsWith('edit-') && f.endsWith('.png'))).toBe(true);
  });

  it('rejects another user uploads artifact', async () => {
    const { tool, uploads } = makeTool(undefined, 'host-bridge');
    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image: join(uploads, '8', 'gen-other.png'),
    }), 1, 7, null));
    expect(result.error).toContain('Path escape');
  });

  it('reads input bytes through the container bridge (docker mode)', async () => {
    const seen: Array<{ userId: number | null; sessionId: number | null; path: string }> = [];
    const support: SendBytesSupport = {
      // 宿主机上不存在的容器内路径也能编辑：字节全部由容器桥提供
      openStream: async (input) => {
        seen.push({ userId: input.userId, sessionId: input.sessionId, path: input.path });
        return { stream: Readable.from([PNG_BYTES]), size: PNG_BYTES.length, contentType: null };
      },
      readBytes: async (input) => {
        seen.push({ userId: input.userId, sessionId: input.sessionId, path: input.path });
        return PNG_BYTES;
      },
      extraRoots: () => [],
    };
    const { tool, ws } = makeTool(undefined, support);
    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image_paths: ['/tmp/container-only.png'],
    }), 1, 7, ws));
    expect(result.error).toBeUndefined();
    expect(result.images.length).toBe(1);
    expect(seen).toEqual([{ userId: 7, sessionId: 1, path: '/tmp/container-only.png' }]);
  });

  it('accepts a mask from own uploads artifacts', async () => {
    const { tool, uploads } = makeTool(undefined, 'host-bridge');
    const result = JSON.parse(await tool.execute(JSON.stringify({
      prompt: 'x',
      image_paths: [join(uploads, '7', 'gen-own.png')],
      mask_path: join(uploads, '7', 'gen-own.png'),
    }), 1, 7, null));
    expect(result.error).toBeUndefined();
    expect(lastRawBody.toString('latin1')).toContain('name="mask"');
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

describe('图片调用流水埋点（技术方案 2026-11-24）', () => {
  /** 记录器 spy：捕获每次 record 入参，供断言。 */
  function spyRecorder() {
    const calls: Array<Record<string, unknown>> = [];
    return { calls, recorder: { record: async (input: Record<string, unknown>) => { calls.push(input); } } };
  }

  function makeGenTool(recorder: unknown = null) {
    const dir = useTmpDir('img-rec-');
    const tool = new GenerateImageTool({
      findImageModel: async () => model() as never,
    }, dir, async () => 'https://mao.example/api', '/api', undefined, recorder as never);
    return { tool, dir };
  }

  function makeEditTool(recorder: unknown = null) {
    const ws = useTmpDir('edit-rec-ws-');
    const out = useTmpDir('edit-rec-out-');
    mkdirSync(join(ws, 'chat-files'), { recursive: true });
    writeFileSync(join(ws, 'input.png'), PNG_BYTES);
    const tool = new EditImageTool(
      { findImageModel: async () => model() as never },
      new PathSandbox(ws),
      out,
      async () => 'https://mao.example/api',
      null,
      '/api',
      undefined,
      recorder as never,
    );
    return { tool, out, ws };
  }

  it('generate: records one row per successful call with normalized usage', async () => {
    const { calls, recorder } = spyRecorder();
    const { tool } = makeGenTool(recorder);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      resolvedModelName: 'gpt-image-2.5-flare',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      success: true,
      userId: 7,
      sessionId: 11,
      agentId: 3,
    });
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].errorMessage).toBeUndefined();
  });

  it('generate: resolves the model alias into providerModelId (D10)', async () => {
    const { calls, recorder } = spyRecorder();
    const { tool } = makeGenTool(recorder);
    await tool.execute(JSON.stringify({ prompt: 'a cat', model: 'sunburst' }), 11, 7, 'ws', 3);
    expect(calls[0].resolvedModelName).toBe('gpt-image-2.5-sunburst');
  });

  it('generate: records a failure row when the upstream returns 5xx, with the api key redacted', async () => {
    mode = 'client-error';
    const { calls, recorder } = spyRecorder();
    const { tool } = makeGenTool(recorder);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].success).toBe(false);
    expect(calls[0].errorMessage).toBeTruthy();
    // 脱敏：mock 上游把 Authorization 回显进错误体，摘要里必须换成 [redacted]。
    // 早先错误体是 'bad prompt'（本就不含 key）、mock key 又是 1 字符 'k'，
    // 断言恒真——脱敏逻辑整个坏掉也测不出来。
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('sk-image-secret-12345');
    expect(calls[0].errorMessage).toContain('[redacted]');
    expect(calls[0].errorMessage).not.toContain('sk-image-secret-12345');
    expect(calls[0].usage).toBeNull();
  });

  it('generate: does not record param/config errors that never reached the upstream', async () => {
    const { calls, recorder } = spyRecorder();
    const { tool } = makeGenTool(recorder);
    // 参数非法 / 无可用模型：早退分支，不是模型调用
    expect(JSON.parse(await tool.execute('{}', 11, 7, 'ws', 3)).error).toContain('prompt');
    expect(JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', size: '1x1' }), 11, 7, 'ws', 3)).error).toContain('size');
    const noModel = new GenerateImageTool({ findImageModel: async () => null } as never, useTmpDir('img-nomodel-'), async () => '', '/api', undefined, recorder);
    expect(JSON.parse(await noModel.execute(JSON.stringify({ prompt: 'x' }), 11, 7, 'ws', 3)).error).toContain('文生图');
    expect(calls).toHaveLength(0);
  });

  it('edit: records one row per successful call', async () => {
    const { calls, recorder } = spyRecorder();
    const { tool, ws } = makeEditTool(recorder);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image_paths: ['input.png'] }), 11, 7, ws, 3));
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      resolvedModelName: 'gpt-image-2.5-flare',
      success: true,
      userId: 7,
      sessionId: 11,
      agentId: 3,
    });
  });

  it('edit: records a failure row when the upstream returns 5xx, with the api key redacted', async () => {
    mode = 'client-error';
    const { calls, recorder } = spyRecorder();
    const { tool, ws } = makeEditTool(recorder);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image_paths: ['input.png'] }), 11, 7, ws, 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].success).toBe(false);
    // mock 上游回显 Authorization → 摘要必须抹成 [redacted]（见 client-error 模式注释）
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('sk-image-secret-12345');
    expect(calls[0].errorMessage).not.toContain('sk-image-secret-12345');
  });

  it('edit: a local read failure before the upstream call is not recorded', async () => {
    const { calls, recorder } = spyRecorder();
    const { tool, ws } = makeEditTool(recorder);
    // 路径不存在 → loadLocalImage 抛错，早于上游调用
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image_paths: ['nope.png'] }), 11, 7, ws, 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('no recorder injected: tool behaves exactly as before', async () => {
    const { tool } = makeGenTool(null);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeUndefined();
    expect(result.images).toHaveLength(1);
  });

  it('generate: upstream success + local bookkeeping failure still records the consumed tokens (B2)', async () => {
    // 落盘/拼 URL 在记账之后抛错（磁盘满、uploadDir 不可写）时，上游 token 已经产生。
    // 记账若留在收尾之后，这一行会退化成 usage=null 的失败行——真实消耗被吞，
    // 成功率与用量同时失真。要求：一行、success=true、usage 归一值。
    const { calls, recorder } = spyRecorder();
    const dir = useTmpDir('img-rec-b2-');
    const tool = new GenerateImageTool({
      findImageModel: async () => model() as never,
    }, dir, async () => { throw new Error('boom: base url unavailable'); }, '/api', undefined, recorder as never);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      success: true,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(calls[0].errorMessage).toBeUndefined();
  });

  it('generate: never records two rows for one call (D9)', async () => {
    // 同一行调用不能被记成「成功行 + 失败行」两条：用量翻倍、成功率错乱。
    const { calls, recorder } = spyRecorder();
    const dir = useTmpDir('img-rec-d9-');
    const tool = new GenerateImageTool({
      findImageModel: async () => model() as never,
    }, dir, async () => { throw new Error('boom'); }, '/api', undefined, recorder as never);
    await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3);
    expect(calls).toHaveLength(1);
    expect(calls[0].success).toBe(true);
  });

  it('generate: upstream 200 then download failure keeps the billed tokens (P2)', async () => {
    // 上游返回 200 + usage，但图片 URL 下载失败（CDN 限流 / 超时）。token 已经
    // 计费，流水必须记「失败 + usage 非空」；记成 usage=null 就是又一次把真实
    // 消耗吞掉——B2 的同款问题，只是发生在 callImageGenerations 里更里一层。
    mode = 'url-download-fail';
    const { calls, recorder } = spyRecorder();
    const { tool } = makeGenTool(recorder);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      success: false,
      usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
    });
  });

  it('generate: a throwing recorder never breaks the tool result (D8)', async () => {
    // recordOnce 在成功路径的 finally 里被 await：记账自身抛错若不被兜住，
    // 一次成功的出图会变成 errorJson。D8 要求「记账失败绝不影响工具返回」。
    const dir = useTmpDir('img-rec-d8-');
    const tool = new GenerateImageTool({
      findImageModel: async () => model() as never,
    }, dir, async () => 'https://mao.example/api', '/api', undefined, {
      record: async () => { throw new Error('db down'); },
    } as never);
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat' }), 11, 7, 'ws', 3));
    expect(result.error).toBeUndefined();
    expect(result.images).toHaveLength(1);
  });

  it('edit: upstream success + local bookkeeping failure still records the consumed tokens (B2)', async () => {
    const { calls, recorder } = spyRecorder();
    const ws = useTmpDir('edit-rec-b2-ws-');
    const out = useTmpDir('edit-rec-b2-out-');
    mkdirSync(join(ws, 'chat-files'), { recursive: true });
    writeFileSync(join(ws, 'input.png'), PNG_BYTES);
    const tool = new EditImageTool(
      { findImageModel: async () => model() as never },
      new PathSandbox(ws),
      out,
      async () => { throw new Error('boom'); },
      null,
      '/api',
      undefined,
      recorder as never,
    );
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image_paths: ['input.png'] }), 11, 7, ws, 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ success: true });
    expect(calls[0].usage).toMatchObject({ totalTokens: 3 });
  });

  it('edit: upstream 200 then download failure keeps the billed tokens (P2)', async () => {
    mode = 'url-download-fail';
    const { calls, recorder } = spyRecorder();
    const ws = useTmpDir('edit-rec-p2-ws-');
    const out = useTmpDir('edit-rec-p2-out-');
    mkdirSync(join(ws, 'chat-files'), { recursive: true });
    writeFileSync(join(ws, 'input.png'), PNG_BYTES);
    const tool = new EditImageTool(
      { findImageModel: async () => model() as never },
      new PathSandbox(ws),
      out,
      async () => 'https://mao.example/api',
      null,
      '/api',
      undefined,
      recorder as never,
    );
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'x', image_paths: ['input.png'] }), 11, 7, ws, 3));
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      success: false,
      usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
    });
  });
});
