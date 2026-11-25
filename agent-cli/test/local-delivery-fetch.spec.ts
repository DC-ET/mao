// delivery_read 委托读取（2026-11-25 send_file 1GB R2）：路径校验、绝对路径在 workspace 内的口径、
// open / read / close 三段、执行端错误显式回包与路由入口。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DELIVERY_READ_CHUNK_BYTES,
  DELIVERY_READ_MAX_BYTES,
  openDeliveryFile,
  readDeliveryChunk,
  resolveDeliveryWorkspacePath,
} from '../src/local/file-fetch';
import { LocalExecutor } from '../src/local/executor';
import { DAEMON_ROUTED_EVENTS } from '../src/commands/local';
import type { WsClient } from '../src/ws/ws-client';

const WORKSPACE = mkdtempSync(path.join(tmpdir(), 'mao-delivery-read-'));

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

describe('openDeliveryFile / readDeliveryChunk', () => {
  it('读到普通文件字节（不限制扩展名），open 回 size / mtimeMs', async () => {
    writeFileSync(path.join(WORKSPACE, 'doc.bin'), Buffer.from([1, 2, 3]));
    const opened = await openDeliveryFile(WORKSPACE, 'doc.bin');
    expect(opened.size).toBe(3);
    expect(Number.isFinite(opened.mtimeMs)).toBe(true);
    const chunk = await readDeliveryChunk(opened, 1, 2);
    expect([...chunk.bytes]).toEqual([2, 3]);
    await opened.handle.close();
  });

  it('maxBytes 上限生效（图片 20MB / 文件 1GB 由服务端传入）', async () => {
    writeFileSync(path.join(WORKSPACE, 'big.dat'), Buffer.alloc(32, 7));
    await expect(openDeliveryFile(WORKSPACE, 'big.dat', 16)).rejects.toThrow('过大');
    const opened = await openDeliveryFile(WORKSPACE, 'big.dat', 32);
    expect(opened.size).toBe(32);
    await opened.handle.close();
  });

  it('非法 / 缺省 maxBytes 按 1GB 兜底（模块常量与后端同表）', async () => {
    writeFileSync(path.join(WORKSPACE, 'small.dat'), Buffer.alloc(4, 1));
    const a = await openDeliveryFile(WORKSPACE, 'small.dat', Number.NaN);
    const b = await openDeliveryFile(WORKSPACE, 'small.dat', 0);
    expect(a.size).toBe(4);
    expect(b.size).toBe(4);
    await a.handle.close();
    await b.handle.close();
    expect(DELIVERY_READ_MAX_BYTES).toBe(1024 * 1024 * 1024);
    expect(DELIVERY_READ_CHUNK_BYTES).toBe(512 * 1024);
  });

  it('目录 / 不存在的文件拒绝', async () => {
    mkdirSync(path.join(WORKSPACE, 'dir'), { recursive: true });
    await expect(openDeliveryFile(WORKSPACE, 'dir')).rejects.toThrow();
    await expect(openDeliveryFile(WORKSPACE, 'missing.pdf')).rejects.toThrow();
  });

  it('单片超过 512KB / 区间非法 → 拒绝', async () => {
    writeFileSync(path.join(WORKSPACE, 'range.bin'), Buffer.alloc(8, 1));
    const opened = await openDeliveryFile(WORKSPACE, 'range.bin');
    await expect(readDeliveryChunk(opened, 0, DELIVERY_READ_CHUNK_BYTES + 1)).rejects.toThrow('单片上限');
    await expect(readDeliveryChunk(opened, -1, 1)).rejects.toThrow('不合法');
    await opened.handle.close();
  });

  it('发送期间文件 mtime 变化 → 失败（避免撕裂快照）', async () => {
    const file = path.join(WORKSPACE, 'mutating.bin');
    writeFileSync(file, Buffer.alloc(64, 2));
    const opened = await openDeliveryFile(WORKSPACE, 'mutating.bin');
    const future = new Date(Date.now() + 5000);
    writeFileSync(file, Buffer.alloc(64, 3));
    const { utimesSync } = await import('node:fs');
    utimesSync(file, future, future);
    await expect(readDeliveryChunk(opened, 0, 16)).rejects.toThrow('文件在发送期间被修改');
    await opened.handle.close();
  });
});

/** 构造最小 LocalExecutor：只注入 delivery_read 分支需要的 ws 与信任工作区。 */
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

type DeliveryReadHook = (sid: number, d: Record<string, unknown>) => Promise<void>;

describe('LocalExecutor.onDeliveryRead', () => {
  it('open / read / close 三段：回 size / mtimeMs 与按 offset 的 base64 字节', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    const bytes = Buffer.from('0123456789');
    writeFileSync(path.join(WORKSPACE, 'ten.bin'), bytes);
    const hook = executor as unknown as { onDeliveryRead: DeliveryReadHook };
    await hook.onDeliveryRead(40, {
      requestId: 'r-open', action: 'open', streamId: 's1', path: 'ten.bin', workspace: WORKSPACE, maxBytes: DELIVERY_READ_MAX_BYTES,
    });
    expect(frames[0]).toMatchObject({ type: 'delivery_read_result', sessionId: 40, requestId: 'r-open', ok: true, size: 10 });
    await hook.onDeliveryRead(40, {
      requestId: 'r-read', action: 'read', streamId: 's1', offset: 4, length: 3,
    });
    expect(frames[1]).toMatchObject({
      ok: true,
      data: bytes.subarray(4, 7).toString('base64'),
      size: 10,
    });
    await hook.onDeliveryRead(40, { requestId: 'r-close', action: 'close', streamId: 's1' });
    await hook.onDeliveryRead(40, { requestId: 'r-read2', action: 'read', streamId: 's1', offset: 0, length: 1 });
    expect(frames.at(-1)).toMatchObject({ ok: false, error: '读取流已关闭或不存在' });
    executor.closeDeliveryHandles();
  });

  it('帧内 maxBytes 超限：open 显式回「文件过大」（服务端据此给准确文案）', async () => {
    writeFileSync(path.join(WORKSPACE, 'too-big.png'), Buffer.alloc(64, 3));
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    await (executor as unknown as { onDeliveryRead: DeliveryReadHook }).onDeliveryRead(
      40,
      { requestId: 'r1', action: 'open', streamId: 's1', path: 'too-big.png', workspace: WORKSPACE, maxBytes: 32 },
    );
    expect(frames[0]).toMatchObject({ ok: false, error: expect.stringContaining('过大') });
    executor.closeDeliveryHandles();
  });

  it('信任外 workspace / 越界 / 不存在 / 缺字段 → 显式回 ok:false', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    const call = (d: Record<string, unknown>) =>
      (executor as unknown as { onDeliveryRead: DeliveryReadHook }).onDeliveryRead(40, d);
    writeFileSync(path.join(WORKSPACE, 'ok.pdf'), 'x');
    await call({ requestId: 'r1', action: 'open', streamId: 's1', path: 'ok.pdf', workspace: '/elsewhere' });
    await call({ requestId: 'r2', action: 'open', streamId: 's2', path: '../escape.pdf', workspace: WORKSPACE });
    await call({ requestId: 'r3', action: 'open', streamId: 's3', path: 'missing.pdf', workspace: WORKSPACE });
    // 缺 streamId / requestId：静默
    await call({ requestId: 'r4', action: 'open', path: 'ok.pdf', workspace: WORKSPACE });
    await call({ action: 'open', streamId: 's5', path: 'ok.pdf', workspace: WORKSPACE });
    expect(frames.filter((f) => f.ok === false)).toHaveLength(3);
    expect(frames).toHaveLength(3);
    executor.closeDeliveryHandles();
  });

  it('sendReliable 失败不冒泡（下一片仍可重试；关闭时清句柄）', async () => {
    writeFileSync(path.join(WORKSPACE, 'multi.bin'), 'abc');
    const send = vi.fn(async () => false);
    const executor = makeExecutor(send);
    const hook = executor as unknown as { onDeliveryRead: DeliveryReadHook };
    await hook.onDeliveryRead(40, {
      requestId: 'r-open', action: 'open', streamId: 's1', path: 'multi.bin', workspace: WORKSPACE, maxBytes: DELIVERY_READ_MAX_BYTES,
    });
    await hook.onDeliveryRead(40, { requestId: 'r-read', action: 'read', streamId: 's1', offset: 0, length: 3 });
    expect(send).toHaveBeenCalled();
    executor.closeDeliveryHandles();
  });
});

describe('路由入口（评审补充 P1）', () => {
  it('DAEMON_ROUTED_EVENTS 覆盖 file_fetch 与 delivery_read', () => {
    expect(DAEMON_ROUTED_EVENTS.has('file_fetch')).toBe(true);
    expect(DAEMON_ROUTED_EVENTS.has('delivery_read')).toBe(true);
  });
});
