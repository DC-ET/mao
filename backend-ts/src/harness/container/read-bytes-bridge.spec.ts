import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { DockerSendBytesBridge } from './read-bytes-bridge.js';
import type { DockerToolRouter } from './docker-tool-router.js';

function makeBridge() {
  const base = useTmpDir('mao-bridge-');
  const uploadDir = join(base, 'uploads');
  const runtimeDir = join(base, 'runtime');
  const readBytes = vi.fn(async () => null);
  const bridge = new DockerSendBytesBridge({
    router: { readBytes } as unknown as DockerToolRouter,
    runtimeResolver: { resolveUserHomeDir: (userId: number) => join(base, 'users', String(userId)) } as never,
    runtimeDir,
    uploadDir,
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
});
