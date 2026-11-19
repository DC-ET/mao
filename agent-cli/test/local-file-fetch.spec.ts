// file_fetch 委托读取（方案 2026-11-18 §5.3）：路径校验、字节读取、分片、executor 分支的静默失败口径。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FILE_FETCH_CHUNK_BYTES,
  chunkBuffer,
  readWorkspaceImageBytes,
  resolveWorkspaceImagePath,
} from '../src/local/file-fetch';
import { LocalExecutor } from '../src/local/executor';
import type { WsClient } from '../src/ws/ws-client';

const WORKSPACE = mkdtempSync(path.join(tmpdir(), 'mao-file-fetch-'));
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveWorkspaceImagePath', () => {
  it('正常相对路径解析为信任工作区内绝对路径', () => {
    const resolved = resolveWorkspaceImagePath(WORKSPACE, 'screenshots/a.png');
    expect(resolved).toBe(path.resolve(WORKSPACE, 'screenshots', 'a.png'));
  });

  it('拒绝越界 / 绝对 / 反斜杠 / 盘符 / 非图片扩展名', () => {
    for (const bad of [
      '../escape.png',
      'a/../../escape.png',
      '/abs/a.png',
      'C:/a.png',
      'a\\b.png',
      '\\\\host\\share\\a.png',
      'dir/./a.png',
      'dir//a.png',
      '',
      'a.txt',
      'a.svg',
    ]) {
      expect(() => resolveWorkspaceImagePath(WORKSPACE, bad)).toThrow();
    }
    // 大小写不敏感白名单放行
    expect(() => resolveWorkspaceImagePath(WORKSPACE, 'imgs/A.PNG')).not.toThrow();
  });
});

describe('readWorkspaceImageBytes', () => {
  it('读到普通文件字节', async () => {
    writeFileSync(path.join(WORKSPACE, 'a.png'), PNG_HEAD);
    const bytes = await readWorkspaceImageBytes(WORKSPACE, 'a.png');
    expect(bytes).toEqual(PNG_HEAD);
  });

  it('拒绝符号链接目标', async () => {
    try {
      symlinkSync(path.join(WORKSPACE, 'a.png'), path.join(WORKSPACE, 'link.png'));
    } catch {
      return; // Windows 无符号链接权限时跳过
    }
    await expect(readWorkspaceImageBytes(WORKSPACE, 'link.png')).rejects.toThrow();
  });

  it('拒绝超出 10MB 上限的文件', async () => {
    const big = path.join(WORKSPACE, 'big.png');
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    try {
      await expect(readWorkspaceImageBytes(WORKSPACE, 'big.png')).rejects.toThrow('过大');
    } finally {
      rmSync(big);
    }
  });
});

describe('chunkBuffer', () => {
  it('按 512KB 切分，末片可短', () => {
    const bytes = Buffer.alloc(FILE_FETCH_CHUNK_BYTES * 2 + 8, 3);
    const chunks = chunkBuffer(bytes);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(FILE_FETCH_CHUNK_BYTES);
    expect(chunks[1].length).toBe(FILE_FETCH_CHUNK_BYTES);
    expect(chunks[2].length).toBe(8);
    // 字节级比较。toEqual 会把约 1MB Buffer 当对象逐项做深度比较，CI 上会顶满 5s 超时。
    const joined = Buffer.concat(chunks);
    expect(joined.length).toBe(bytes.length);
    expect(joined.equals(bytes)).toBe(true);
  });

  it('空 buffer 产出空数组（executor 据此静默）', () => {
    expect(chunkBuffer(Buffer.alloc(0))).toHaveLength(0);
  });
});

/** 构造最小 LocalExecutor：只注入 file_fetch 分支需要的 ws 与信任工作区。 */
function makeExecutor(wsSend: (payload: object) => Promise<boolean>, workspace = WORKSPACE) {
  const executor = new LocalExecutor({
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
  return executor;
}

describe('LocalExecutor.onFileFetch', () => {
  it('信任内正常读取：按分片回传 file_fetch_result', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const executor = makeExecutor(async (payload) => {
      frames.push(payload as Record<string, unknown>);
      return true;
    });
    writeFileSync(path.join(WORKSPACE, 'shot.png'), PNG_HEAD);
    await (executor as unknown as { onFileFetch: (sid: number, d: Record<string, unknown>) => Promise<void> }).onFileFetch(
      40,
      { requestId: 'r1', path: 'shot.png', workspace: WORKSPACE },
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'file_fetch_result',
      sessionId: 40,
      requestId: 'r1',
      seq: 1,
      total: 1,
      data: PNG_HEAD.toString('base64'),
    });
  });

  it('信任外 workspace / 非法路径 / 读失败 → 静默不回包（不发送任何帧）', async () => {
    const send = vi.fn(async () => true);
    const executor = makeExecutor(send);
    const call = (d: Record<string, unknown>) =>
      (executor as unknown as { onFileFetch: (sid: number, d: Record<string, unknown>) => Promise<void> }).onFileFetch(40, d);
    await call({ requestId: 'r1', path: 'a.png', workspace: '/elsewhere' }); // 信任外
    await call({ requestId: 'r2', path: '../escape.png', workspace: WORKSPACE }); // 越界
    await call({ requestId: 'r3', path: 'a.txt', workspace: WORKSPACE }); // 非图片
    await call({ requestId: 'r4', path: 'missing.png', workspace: WORKSPACE }); // 文件不存在
    await call({ requestId: 'r5', path: '', workspace: WORKSPACE }); // 空路径
    await call({ path: 'a.png', workspace: WORKSPACE }); // 缺 requestId
    expect(send).not.toHaveBeenCalled();
  });

  it('sendReliable 中途失败 → 立即停止，不回 error 帧', async () => {
    writeFileSync(path.join(WORKSPACE, 'multi.png'), Buffer.alloc(FILE_FETCH_CHUNK_BYTES + 4, 5));
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return calls < 2;
    });
    const executor = makeExecutor(send);
    await (executor as unknown as { onFileFetch: (sid: number, d: Record<string, unknown>) => Promise<void> }).onFileFetch(
      40,
      { requestId: 'r1', path: 'multi.png', workspace: WORKSPACE },
    );
    expect(calls).toBe(2);
  });
});
