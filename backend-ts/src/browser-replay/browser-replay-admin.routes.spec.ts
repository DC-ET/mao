import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import { BrowserReplayService } from './browser-replay.service.js';
import { registerBrowserReplayAdminRoutes } from './browser-replay-admin.routes.js';

const ADMIN = 1;
const OWNER = 7;
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

/** getSession 按 executionMode 分流：11=CLOUD，12=LOCAL。 */
function fakeSessionService() {
  return {
    getSession: vi.fn(async (id: number) => ({
      id,
      userId: OWNER,
      executionMode: id === 12 ? 'LOCAL' : 'CLOUD',
    })),
  };
}

async function application(root: string, opts?: { allowed?: boolean }) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      (request as { userId?: number }).userId = ADMIN;
    });
    registerBrowserReplayAdminRoutes(api, {
      sessionService: fakeSessionService(),
      replayService: new BrowserReplayService(RuntimeDataResolver.forTest(root, path.join(root, 'home'))),
      catalogService: {
        listForAdmin: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 })),
      } as never,
      permissionService: { hasPermission: vi.fn(async () => opts?.allowed ?? true) },
    });
  });
  await app.ready();
  return app;
}

describe('browser-replay admin routes（session:read + 跨用户读取，方案 2026-11-27 §4.2/§4.5）', () => {
  it('列表：有 session:read → 200；无权限 → 403', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-admin-'));
    const allowed = await application(root, { allowed: true });
    const ok = await allowed.inject({ method: 'GET', url: '/v1/admin/browser-replays' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).toBe(0);
    await allowed.close();

    const denied = await application(root, { allowed: false });
    const res = await denied.inject({ method: 'GET', url: '/v1/admin/browser-replays' });
    expect(res.statusCode).toBe(403);
    await denied.close();
  });

  it('timeline：CLOUD 会话可读；LOCAL 会话拒绝；liveId 穿越/不存在 404', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-admin-tl-'));
    writeLive(root);
    const app = await application(root);

    const ok = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/L1000/timeline` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.frames).toHaveLength(1);

    const traversal = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/..%2F..%2F7%2F..%2Fetc/timeline` });
    expect(traversal.statusCode).toBe(404);

    const missing = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/L9999/timeline` });
    expect(missing.statusCode).toBe(404);

    // LOCAL 会话（id=12）服务端无 runtime 目录：业务错误拒答
    const local = await app.inject({ method: 'GET', url: '/v1/admin/browser-replays/12/L1000/timeline' });
    expect(local.statusCode).toBe(200);
    expect(local.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    await app.close();
  });

  it('帧端点：image/jpeg + private 缓存头；非法 seq 业务错误；LOCAL 会话拒绝', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-admin-frame-'));
    writeLive(root);
    const app = await application(root);

    const ok = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/L1000/frames/1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/jpeg');
    expect(ok.headers['cache-control']).toContain('private');
    expect(ok.body.toString()).toBe('jpeg-1');

    const badSeq = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/L1000/frames/1.5` });
    expect(badSeq.statusCode).toBe(200);
    expect(badSeq.json().code).toBe(ErrorCode.PARAM_INVALID.code);

    const local = await app.inject({ method: 'GET', url: '/v1/admin/browser-replays/12/L1000/frames/1' });
    expect(local.json().code).toBe(ErrorCode.PARAM_INVALID.code);

    const missing = await app.inject({ method: 'GET', url: `/v1/admin/browser-replays/${SESSION_ID}/L1000/frames/9` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('sessionId 非数字 → PARAM_INVALID（不把 NaN 拼进路径）', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-admin-400-'));
    writeLive(root);
    const app = await application(root);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/browser-replays/abc/L1000/timeline' });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    await app.close();
  });
});
