import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { DockerSendBytesBridge } from './read-bytes-bridge.js';
import type { DockerToolRouter } from './docker-tool-router.js';

function makeBridge(uploadOriginProvider?: () => Promise<string | null>, sessionAgentIdOf?: (sessionId: number) => Promise<number | null>) {
  const base = useTmpDir('mao-bridge-');
  const uploadDir = join(base, 'uploads');
  const runtimeDir = join(base, 'runtime');
  const readBytes = vi.fn(async () => null);
  const bridge = new DockerSendBytesBridge({
    router: { readBytes } as unknown as DockerToolRouter,
    runtimeResolver: { resolveUserHomeDir: (userId: number) => join(base, 'users', String(userId)) } as never,
    runtimeDir,
    uploadDir,
    // 容器键第二维（2026-11-07 复合容器方案 §5.8）：缺省按会话固定返回 agent 5
    sessionAgentIdOf: sessionAgentIdOf ?? (async () => 5),
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
    // agentId 由 sessionAgentIdOf 按会话解析（缺省桩恒返 5）后透传
    expect(readBytes).toHaveBeenCalledWith({ ...input, agentId: 5 });

    readBytes.mockClear();
    expect(await bridge.readBytes({ ...input, userId: null })).toBeNull();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('readBytes: 会话不存在（agentId 不可得）时明确报错不派发', async () => {
    const { bridge, readBytes } = makeBridge(undefined, async () => null);
    await expect(bridge.readBytes({ userId: 7, sessionId: 11, workspace: '/ws/7', path: 'a.png', maxBytes: 1024 }))
      .rejects.toThrow(/无法路由/);
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

  it('foreignPathMessage: 非 uid 首段（平坦文件 / releases / channels）不做跨成员归因', async () => {
    const { bridge, uploadDir, runtimeDir } = makeBridge(async () => 'https://mao.example.com');
    expect(await bridge.foreignPathMessage(join(uploadDir, '0aa0dc1a-dead.png'), 67)).toBeNull();
    expect(await bridge.foreignPathMessage(join(uploadDir, 'releases', 'latest.yml'), 67)).toBeNull();
    expect(await bridge.foreignPathMessage(join(runtimeDir, 'channels', 'x.sock'), 67)).toBeNull();
    // 纯数字首段仍按成员判定（170 与 17 是不同用户）
    const hit = await bridge.foreignPathMessage(join(uploadDir, '170', 'x.png'), 67);
    expect(hit).toContain('其他成员的产物目录');
    expect(hit).toContain('/uploads/170/x.png');
  });

  it('foreignPathMessage: publicUrl 片段编码空格与 # ?', async () => {
    const { bridge, uploadDir } = makeBridge(async () => 'https://mao.example.com');
    const message = await bridge.foreignPathMessage(join(uploadDir, '17', 'a b#c?d.png'), 67);
    expect(message).toContain('https://mao.example.com/uploads/17/a%20b%23c%3Fd.png');
  });

  it('foreignPathMessage: edit 场景（hint）URL 只标注转发用途，出路走 hint', async () => {
    const { bridge, uploadDir, runtimeDir } = makeBridge(async () => 'https://mao.example.com');
    const message = await bridge.foreignPathMessage(
      join(uploadDir, '17', 'gen.png'), 67, '改图请重新生成，或由该成员本人操作',
    );
    // edit_image 不接受 URL：不得再引导「请改用其转发」，URL 仅标注为 send_* 转发用途
    expect(message).toContain('可用于 send_* 转发');
    expect(message).not.toContain('请改用其转发');
    expect(message).toContain('改图请重新生成，或由该成员本人操作');
    // runtime 分支：hint 替代默认出路建议，避免两句建议连读
    const runtimeMessage = await bridge.foreignPathMessage(
      join(runtimeDir, '17', '1607', 'shellOutput', 'x.out'), 67, '改图请重新生成，或由该成员本人操作',
    );
    expect(runtimeMessage).toContain('改图请重新生成，或由该成员本人操作');
    expect(runtimeMessage).not.toContain('请让该成员本人操作，或重新生成到共享位置');
    // 无 hint（send_* 工具）：保持「请改用其转发」的可执行引导
    const sendMessage = await bridge.foreignPathMessage(join(uploadDir, '17', 'gen.png'), 67);
    expect(sendMessage).toContain('请改用其转发');
  });
});
