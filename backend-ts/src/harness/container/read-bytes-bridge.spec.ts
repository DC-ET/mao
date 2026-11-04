import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { DockerSendBytesBridge } from './read-bytes-bridge.js';
import type { DockerToolRouter } from './docker-tool-router.js';

function makeBridge(uploadOriginProvider?: () => Promise<string | null>) {
  const base = useTmpDir('mao-bridge-');
  const uploadDir = join(base, 'uploads');
  const runtimeDir = join(base, 'runtime');
  const readBytes = vi.fn(async () => null);
  const bridge = new DockerSendBytesBridge({
    router: { readBytes } as unknown as DockerToolRouter,
    runtimeResolver: { resolveUserHomeDir: (userId: number) => join(base, 'users', String(userId)) } as never,
    runtimeDir,
    uploadDir,
    uploadOriginProvider,
  });
  return { bridge, readBytes, uploadDir, runtimeDir, base };
}

describe('DockerSendBytesBridge', () => {
  it('extraRoots covers own uploads/{uid} without leaking the flat root or other users', () => {
    const { bridge, uploadDir, runtimeDir, base } = makeBridge();
    const roots = bridge.extraRoots(7);
    expect(roots).toContain(join(uploadDir, '7'));
    expect(roots).toContain(join(runtimeDir, '7'));
    expect(roots).toContain(join(base, 'users', '7'));
    expect(roots).toContain('/tmp');
    // 平坦 uploads 根与其他用户子目录都不得放行
    expect(roots).not.toContain(uploadDir);
    expect(roots.some((r) => r.endsWith('/8'))).toBe(false);
  });

  it('extraRoots without a user only keeps /tmp', () => {
    const { bridge } = makeBridge();
    expect(bridge.extraRoots(null)).toEqual(['/tmp']);
  });

  it('forwards readBytes to the container router and skips it without a user', async () => {
    const { bridge, readBytes } = makeBridge();
    const input = { userId: 7, sessionId: 11, workspace: '/ws/7', path: 'a.png', maxBytes: 1024 };
    await bridge.readBytes(input);
    expect(readBytes).toHaveBeenCalledWith(input);

    readBytes.mockClear();
    expect(await bridge.readBytes({ ...input, userId: null })).toBeNull();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('foreignPathMessage: 他人 uploads 给出带公开 URL 的可执行文案', async () => {
    let origin: string | null = 'https://mao.example.com';
    const { bridge, uploadDir } = makeBridge(async () => origin);
    const message = await bridge.foreignPathMessage(join(uploadDir, '17', 'gen-1.png'), 67);
    expect(message).toContain('其他成员的产物目录');
    expect(message).toContain('https://mao.example.com/uploads/17/gen-1.png');
    // URL 不可得时降级为「向系统索取链接」，仍可执行
    origin = null;
    const degraded = await bridge.foreignPathMessage(join(uploadDir, '17', 'gen-1.png'), 67);
    expect(degraded).toContain('向系统索取链接');
  });

  it('foreignPathMessage: 他人 runtime 无公开 URL；本人路径与非绝对路径不拦截', async () => {
    const { bridge, uploadDir, runtimeDir } = makeBridge(async () => 'https://mao.example.com');
    const runtimeMessage = await bridge.foreignPathMessage(join(runtimeDir, '17', '1607', 'shellOutput', 'x.out'), 67);
    expect(runtimeMessage).toContain('其他成员的会话运行目录');
    expect(runtimeMessage).toContain('无公开 URL');
    expect(await bridge.foreignPathMessage(join(uploadDir, '67', 'mine.png'), 67)).toBeNull();
    expect(await bridge.foreignPathMessage(join(runtimeDir, '67', '1607', 'x.out'), 67)).toBeNull();
    expect(await bridge.foreignPathMessage('chat-files/a.png', 67)).toBeNull();
    expect(await bridge.foreignPathMessage(join(uploadDir, '17', 'gen.png'), null)).toBeNull();
  });

  it('foreignPathMessage: edit 场景追加行为提示', async () => {
    const { bridge, uploadDir } = makeBridge(async () => 'https://mao.example.com');
    const message = await bridge.foreignPathMessage(
      join(uploadDir, '17', 'gen.png'), 67, '改图请重新生成，或由该成员本人操作',
    );
    expect(message).toContain('改图请重新生成');
  });
});
