import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import { BrowserReplayService } from './browser-replay.service.js';

/** 造一场回放：<tmp>/<uid>/<sid>/.mao-browser/replay/<liveId>/{manifest.json,timeline.ndjson,f<seq>.jpg}。 */
function writeLive(root: string, opts: {
  userId: number; sessionId: number; liveId: string;
  startedAt?: number; endedAt?: number | null; frameCount?: number;
  truncated?: boolean; brokenManifest?: boolean; frames?: Array<{ seq: number; ts: number }>;
}) {
  const dir = path.join(root, String(opts.userId), String(opts.sessionId), '.mao-browser', 'replay', opts.liveId);
  mkdirSync(dir, { recursive: true });
  const startedAt = opts.startedAt ?? 1000;
  const frameCount = opts.frameCount ?? 2;
  const endedAt = opts.endedAt === undefined ? startedAt + 60_000 : opts.endedAt;
  if (opts.brokenManifest) {
    writeFileSync(path.join(dir, 'manifest.json'), '{"liveId": "half-line');
  } else {
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 1, liveId: opts.liveId, sessionId: opts.sessionId,
      startedAt, endedAt,
      frameCount, durationMs: endedAt == null ? null : endedAt - startedAt,
      approxBytes: 12345, cliSessions: ['default'], urls: ['https://example.com'], truncated: opts.truncated ?? false,
    }));
  }
  const rows = (opts.frames ?? [{ seq: 1, ts: startedAt }, { seq: 5, ts: startedAt + 30_000 }]).slice(0, frameCount);
  writeFileSync(path.join(dir, 'timeline.ndjson'),
    rows.map((r) => JSON.stringify({ ...r, pageUrl: 'https://example.com/a', width: 1280, height: 720, bytes: 100, file: `f${r.seq}.jpg` })).join('\n') + '\n'
    + (opts.frames == null ? '{"seq": 9, "ts": half-broken-crash-line\n' : ''));
  for (const r of rows) writeFileSync(path.join(dir, `f${r.seq}.jpg`), Buffer.from(`jpeg-${r.seq}`));
  return dir;
}

function serviceWith(root: string): BrowserReplayService {
  return new BrowserReplayService(RuntimeDataResolver.forTest(root, path.join(root, 'home')));
}

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mao-replay-svc-'));
}

describe('BrowserReplayService.listReplays', () => {
  it('按 startedAt 倒序列出全部场（含 endedAt=null 的未结算场），truncated 透传', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000', startedAt: 1000 });
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L5000', startedAt: 5000, endedAt: null, truncated: true });
    const list = serviceWith(root).listReplays(7, 11);
    expect(list.map((s) => s.liveId)).toEqual(['L5000', 'L1000']);
    expect(list[0].endedAt).toBeNull();
    expect(list[0].truncated).toBe(true);
    expect(list[1].frameCount).toBe(2);
  });

  it('replay 目录不存在 = 从未录制，返回空列表；坏 manifest 的场跳过', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 12, liveId: 'L1000', brokenManifest: true });
    expect(serviceWith(root).listReplays(7, 12)).toEqual([]);
    expect(serviceWith(root).listReplays(7, 99)).toEqual([]);
  });

  it('非 L<数字> 命名的目录不进列表', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 13, liveId: 'L1000' });
    mkdirSync(path.join(root, '7', '13', '.mao-browser', 'replay', 'not-a-live'), { recursive: true });
    const list = serviceWith(root).listReplays(7, 13);
    expect(list.map((s) => s.liveId)).toEqual(['L1000']);
  });
});

describe('BrowserReplayService.timeline', () => {
  it('返回 manifest + 容错解析的 timeline（跳过崩溃半行）', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000' });
    const tl = serviceWith(root).timeline(7, 11, 'L1000');
    expect(tl).not.toBeNull();
    expect(tl!.manifest.liveId).toBe('L1000');
    expect(tl!.frames.map((f) => f.seq)).toEqual([1, 5]);
    expect(tl!.frames[0].file).toBe('f1.jpg');
  });

  it('liveId 非法 / 目录穿越 / manifest 缺失返回 null', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000' });
    const svc = serviceWith(root);
    expect(svc.timeline(7, 11, '../../7')).toBeNull();
    expect(svc.timeline(7, 11, 'L9999')).toBeNull();
    expect(svc.timeline(7, 11, 'abc')).toBeNull();
  });
});

describe('BrowserReplayService.frameBuffer', () => {
  it('读取指定帧字节；缺失 / 非法 seq 返回 null', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000', frames: [{ seq: 1, ts: 1000 }] });
    const svc = serviceWith(root);
    expect(svc.frameBuffer(7, 11, 'L1000', 1)?.toString()).toBe('jpeg-1');
    expect(svc.frameBuffer(7, 11, 'L1000', 5)).toBeNull();
    expect(svc.frameBuffer(7, 11, 'L1000', -1)).toBeNull();
    expect(svc.frameBuffer(7, 11, 'L1000', Number.NaN)).toBeNull();
    expect(svc.frameBuffer(7, 11, 'L9999', 1)).toBeNull();
  });
});

describe('BrowserReplayService 归属与清理联动', () => {
  it('不同用户 / 会话目录互不可见（无跨会话列举面）', () => {
    const root = tmpRoot();
    writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000' });
    writeLive(root, { userId: 8, sessionId: 11, liveId: 'L2000' });
    expect(serviceWith(root).listReplays(7, 11).map((s) => s.liveId)).toEqual(['L1000']);
    expect(serviceWith(root).listReplays(8, 11).map((s) => s.liveId)).toEqual(['L2000']);
  });

  it('场目录 mtime 可改写：TTL 清理按「最后写入时间」判定的前提成立', () => {
    const root = tmpRoot();
    const dir = writeLive(root, { userId: 7, sessionId: 11, liveId: 'L1000' });
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(dir, old, old);
    expect(statSync(dir).mtimeMs).toBeLessThan(Date.now() - 7 * 24 * 3600_000);
  });
});
