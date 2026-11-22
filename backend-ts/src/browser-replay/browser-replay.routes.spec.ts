import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { BrowserReplayService } from './browser-replay.service.js';
import { registerBrowserReplayRoutes } from './browser-replay.routes.js';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';

const OWNER = 7;
const OTHER = 8;
const SESSION_ID = 11;

function writeLive(root: string): void {
  const dir = path.join(root, String(OWNER), String(SESSION_ID), '.mao-browser', 'replay', 'L1000');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1, liveId: 'L1000', sessionId: SESSION_ID, startedAt: 1000, endedAt: 2000,
    frameCount: 1, durationMs: 1000, approxBytes: 6, cliSessions: ['default'], urls: [], truncated: false,
  }));
  writeFileSync(path.join(dir, 'timeline.ndjson'),
    JSON.stringify({ seq: 1, ts: 1000, pageUrl: 'https://example.com', width: 640, height: 480, bytes: 6, file: 'f1.jpg' }) + '\n');
  writeFileSync(path.join(dir, 'f1.jpg'), Buffer.from('jpeg-1'));
}

function fakeSessionService() {
  return { getSession: vi.fn(async (id: number) => ({ userId: id === SESSION_ID ? OWNER : OTHER, id })) };
}

async function application(root: string, opts?: { userId?: number }) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      (request as { userId?: number }).userId = opts?.userId ?? OWNER;
    });
    registerBrowserReplayRoutes(api, {
      sessionService: fakeSessionService(),
      replayService: new BrowserReplayService(RuntimeDataResolver.forTest(root, path.join(root, 'home'))),
    });
  });
  await app.ready();
  return app;
}

describe('browser-replay routes（归属校验 + 白名单）', () => {
  it('归属用户可列表：Result 包裹场次摘要', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-routes-'));
    writeLive(root);
    const app = await application(root, { userId: OWNER });
    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.map((s: { liveId: string }) => s.liveId)).toEqual(['L1000']);
    await app.close();
  });

  it('他人会话 403', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-routes-403-'));
    writeLive(root);
    const app = await application(root, { userId: OTHER });
    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('sid 非数字 → 业务错误（code 非 0，不把 NaN 拼进 SQL）', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-routes-400-'));
    writeLive(root);
    const app = await application(root);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/abc/browser-live/replays' });
    // 仓库口径：业务异常 HTTP 200 + code 非 0（仅 401/403 映射状态码）
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    await app.close();
  });

  it('timeline 正常返回；目录穿越 liveId 404', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-routes-tl-'));
    writeLive(root);
    const app = await application(root);
    const ok = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays/L1000/timeline` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.data.frames).toHaveLength(1);

    const traversal = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays/..%2F..%2F7%2F..%2Fetc/timeline` });
    expect(traversal.statusCode).toBe(404);
    await app.close();
  });

  it('帧端点返回 image/jpeg + private 缓存头；非法 seq 400；缺失帧 404', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-routes-frame-'));
    writeLive(root);
    const app = await application(root);
    const ok = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays/L1000/frames/1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/jpeg');
    expect(ok.headers['cache-control']).toContain('private');
    expect(ok.body.toString()).toBe('jpeg-1');

    const badSeq = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays/L1000/frames/1.5` });
    expect(badSeq.statusCode).toBe(200);
    expect(badSeq.json().code).toBe(ErrorCode.PARAM_INVALID.code);

    const missing = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/browser-live/replays/L1000/frames/9` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
