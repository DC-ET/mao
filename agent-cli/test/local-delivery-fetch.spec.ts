// delivery_fetch 委托读取（统一发送媒体方案 2026-11-18 §6.2）：路径校验、绝对路径在 workspace 内的口径、
// 分片回传、executor 分支的静默失败与路由入口。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DELIVERY_FETCH_CHUNK_BYTES,
  DELIVERY_FETCH_MAX_BYTES,
  readDeliveryFileBytes,
  resolveDeliveryWorkspacePath,
} from '../src/local/file-fetch';
import { LocalExecutor } from '../src/local/executor';
import { DAEMON_ROUTED_EVENTS } from '../src/commands/local';
import type { WsClient } from '../src/ws/ws-client';

const WORKSPACE = mkdtempSync(path.join(tmpdir(), 'mao-delivery-fetch-'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDeliveryWorkspacePath', () => {
  it('相对路径与 workspace 内绝对路径都解析到同一真实路径（send 工具允许绝对路径）', async () => {
    mkdirSync(path.join(WORKSPACE, 'sub'), { recursive: true });
    const file = path.join(WORKSPACE, 'sub', 'a.pdf');
    writeFileSync(file, 'payload');
    const expected = realpathSync(file);
    await expect(resolveDeliveryWorkspacePath(WORKSPACE, 'sub/a.pdf')).resolves.toBe(expected);
    await expect(resolveDeliveryWorkspacePath(WORKSPACE, file)).resolves.toBe(expected);
  });

  it('拒绝越界 / 绝对路径在工作区外 / 反斜杠 / NUL / 空路径', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'mao-delivery-outside-'));
    try {
      writeFileSync(path.join(outside, 'a.pdf'), 'x');
      for (const bad of [
        '../escape.pdf',
        'a/../../escape.pdf',
        path.join(outside, 'a.pdf'),
        '/etc/hosts',
        'a\\b.pdf',
        'a\0b.pdf',
        '',
        '   ',
      ]) {
        await expect(resolveDeliveryWorkspacePath(WORKSPACE, bad)).rejects.toThrow();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('目标本身是符号链接被拒（即使指向 workspace 内文件）', async () => {
    writeFileSync(path.join(WORKSPACE, 'real.pdf'), 'x');
    const link = path.join(WORKSPACE, 'alias.pdf');
    try {
      symlinkSync(path.join(WORKSPACE, 'real.pdf'), link, 'file');
    } catch {
      return; // Windows 无符号链接权限时跳过
    }
    try {
      await expect(resolveDeliveryWorkspacePath(WORKSPACE, 'alias.pdf')).rejects.toThrow('符号链接');
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('父级目录符号链接逃出工作区被 realpath containment 拒绝', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'mao-delivery-link-'));
    try {
      writeFileSync(path.join(outside, 'a.pdf'), 'x');
      try {
        symlinkSync(outside, path.join(WORKSPACE, 'link'));
      } catch {
        return; // Windows 无符号链接权限时跳过
      }
      await expect(resolveDeliveryWorkspacePath(WORKSPACE, 'link/a.pdf')).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('readDeliveryFileBytes', () => {
  it('读到普通文件字节（不限制文件扩展名）', async () => {
    writeFileSync(path.join(WORKSPACE, 'doc.bin'), Buffer.from([1, 2, 3]));
    await expect(readDeliveryFileBytes(WORKSPACE, 'doc.bin')).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it('maxBytes 上限生效（副本侧 20MB 图片 / 30MB 文件由服务端传入）', async () => {
    writeFileSync(path.join(WORKSPACE, 'big.dat'), Buffer.alloc(32, 7));
    await expect(readDeliveryFileBytes(WORKSPACE, 'big.dat', 16)).rejects.toThrow('过大');
    await expect(readDeliveryFileBytes(WORKSPACE, 'big.dat', 32)).resolves.toHaveLength(32);
  });

  it('非法 / 缺省 maxBytes 按 30MB 兜底（模块常量与后端同表）', async () => {
    writeFileSync(path.join(WORKSPACE, 'small.dat'), Buffer.alloc(4, 1));
    await expect(readDeliveryFileBytes(WORKSPACE, 'small.dat', Number.NaN)).resolves.toHaveLength(4);
    await expect(readDeliveryFileBytes(WORKSPACE, 'small.dat', 0)).resolves.toHaveLength(4);
    expect(DELIVERY_FETCH_MAX_BYTES).toBe(30 * 1024 * 1024);
    expect(DELIVERY_FETCH_CHUNK_BYTES).toBe(512 * 1024);
  });

  it('目录 / 不存在的文件拒绝', async () => {
    mkdirSync(path.join(WORKSPACE, 'dir'), { recursive: true });
    await expect(readDeliveryFileBytes(WORKSPACE, 'dir')).rejects.toThrow();
    await expect(readDeliveryFileBytes(WORKSPACE, 'missing.pdf')).rejects.toThrow();
  });
});

/** 构造最小 LocalExecutor：只注入 delivery_fetch 分支需要的 ws 与信任工作区。 */
function makeExecutor(wsSend: (payload: object) => Promise<boolean>, workspace = WORKSPACE) {
  return new LocalExecutor({
    ws: { sendReliable: wsSend } as unknown as WsClient,
    getToken: async () => null,
    baseUrl: 'http://localhost:9080',
    workspace,
    policy: {
      yolo: true,
      force: false,
      onApproval: 'ask' as const,
      approveRules: [],
      strictDangerCheck: false,
      iKnowWhatImDoing: true,
      stdoutIsTty: false,
    },
  });
}

type DeliveryFetchHook = (sid: number, d: Record<string, unknown>) => Promise<void>;

describe('LocalExecutor.onDeliveryFetch', () => {
  it('信任内正常读取：按 512KB 分片回传 delivery_fetch_result', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    const bytes = Buffer.alloc(DELIVERY_FETCH_CHUNK_BYTES + 4, 9);
    writeFileSync(path.join(WORKSPACE, 'two.bin'), bytes);
    await (executor as unknown as { onDeliveryFetch: DeliveryFetchHook }).onDeliveryFetch(
      40,
      { requestId: 'r1', path: 'two.bin', workspace: WORKSPACE, maxBytes: DELIVERY_FETCH_MAX_BYTES },
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      type: 'delivery_fetch_result',
      sessionId: 40,
      requestId: 'r1',
      seq: 1,
      total: 2,
      data: bytes.subarray(0, DELIVERY_FETCH_CHUNK_BYTES).toString('base64'),
    });
    expect(frames[1]).toMatchObject({ seq: 2, total: 2, data: bytes.subarray(DELIVERY_FETCH_CHUNK_BYTES).toString('base64') });
    // 序列化后必须低于出站截断（mao-agent 900KB）与服务端 1MB maxPayload
    expect(JSON.stringify(frames[0]).length).toBeLessThan(1_000_000);
  });

  it('帧内 maxBytes 生效：超过副本上限的文件静默不读（不发送任何帧）', async () => {
    writeFileSync(path.join(WORKSPACE, 'too-big.png'), Buffer.alloc(64, 3));
    const send = vi.fn(async () => true);
    const executor = makeExecutor(send);
    await (executor as unknown as { onDeliveryFetch: DeliveryFetchHook }).onDeliveryFetch(
      40,
      { requestId: 'r1', path: 'too-big.png', workspace: WORKSPACE, maxBytes: 32 },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('信任外 workspace / 越界 / 不存在 / 缺 requestId → 静默不回包', async () => {
    const send = vi.fn(async () => true);
    const executor = makeExecutor(send);
    const call = (d: Record<string, unknown>) =>
      (executor as unknown as { onDeliveryFetch: DeliveryFetchHook }).onDeliveryFetch(40, d);
    writeFileSync(path.join(WORKSPACE, 'ok.pdf'), 'x');
    await call({ requestId: 'r1', path: 'ok.pdf', workspace: '/elsewhere' }); // 信任外
    await call({ requestId: 'r2', path: '../escape.pdf', workspace: WORKSPACE }); // 越界
    await call({ requestId: 'r3', path: 'missing.pdf', workspace: WORKSPACE }); // 文件不存在
    await call({ requestId: 'r4', path: '', workspace: WORKSPACE }); // 空路径
    await call({ path: 'ok.pdf', workspace: WORKSPACE }); // 缺 requestId
    expect(send).not.toHaveBeenCalled();
  });

  it('sendReliable 中途失败 → 立即停止，不回 error 帧', async () => {
    writeFileSync(path.join(WORKSPACE, 'multi.bin'), Buffer.alloc(DELIVERY_FETCH_CHUNK_BYTES + 4, 5));
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return calls < 2;
    });
    const executor = makeExecutor(send);
    await (executor as unknown as { onDeliveryFetch: DeliveryFetchHook }).onDeliveryFetch(
      40,
      { requestId: 'r1', path: 'multi.bin', workspace: WORKSPACE, maxBytes: DELIVERY_FETCH_MAX_BYTES },
    );
    expect(calls).toBe(2);
  });

  it('帧 maxBytes 非法 / 缺省时按 30MB 兜底照常回传', async () => {
    writeFileSync(path.join(WORKSPACE, 'fallback.bin'), Buffer.from('abc'));
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    const hook = executor as unknown as { onDeliveryFetch: DeliveryFetchHook };
    await hook.onDeliveryFetch(40, { requestId: 'r1', path: 'fallback.bin', workspace: WORKSPACE, maxBytes: 'x' });
    await hook.onDeliveryFetch(40, { requestId: 'r2', path: 'fallback.bin', workspace: WORKSPACE });
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.type === 'delivery_fetch_result')).toBe(true);
  });
});

describe('路由入口（评审补充 P1）', () => {
  it('DAEMON_ROUTED_EVENTS 覆盖 file_fetch 与 delivery_fetch', () => {
    expect(DAEMON_ROUTED_EVENTS.has('file_fetch')).toBe(true);
    expect(DAEMON_ROUTED_EVENTS.has('delivery_fetch')).toBe(true);
  });
});
