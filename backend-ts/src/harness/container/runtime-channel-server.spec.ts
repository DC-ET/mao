import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeChannelServer } from './runtime-channel-server.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

/**
 * 宿主机侧每容器 socket 监听的生命周期回归（2026-11-12 线上故障）：
 * 蓝绿部署/并发替换期间 runtime.sock 被 unlink，但进程仍持有监听 inode——
 * ss 可见却无法 connect（容器侧 ENOENT），且旧实现只查内存 map，永不重建。
 * 修复后：ensureListening 校验 socket 文件存在性（缺失自愈），并用
 * 「临时路径 listen → rename 原子替换」避免出现「已删除而新未建立」的空窗。
 */
function connectOk(socketPath: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('RuntimeChannelServer ensureListening', () => {
  const servers: RuntimeChannelServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.stop();
  });

  function makeServer(channelDir: string): RuntimeChannelServer {
    const server = new RuntimeChannelServer({ channelDir, tokenOf: () => 'token-1' });
    servers.push(server);
    return server;
  }

  it('监听后 socket 文件存在且可连接', async () => {
    const root = useTmpDir('mao-channel-');
    const server = makeServer(root);
    const socketPath = await server.ensureListening(7, 5);

    expect(socketPath).toBe(join(root, '7', '5', 'runtime.sock'));
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await connectOk(socketPath);
  });

  it('幂等：重复调用复用同一监听（inode 不变）', async () => {
    const root = useTmpDir('mao-channel-');
    const server = makeServer(root);
    const first = await server.ensureListening(7, 5);
    const inode = lstatSync(first).ino;

    expect(await server.ensureListening(7, 5)).toBe(first);
    expect(lstatSync(first).ino).toBe(inode);
  });

  it('自愈：socket 文件被外部删除后重新监听恢复（线上回归）', async () => {
    const root = useTmpDir('mao-channel-');
    const server = makeServer(root);
    const socketPath = await server.ensureListening(7, 5);

    unlinkSync(socketPath); // 模拟蓝绿/外部清理删除路径（进程仍持有 inode）
    expect(lstatSync(socketPath, { throwIfNoEntry: false })).toBeUndefined();

    expect(await server.ensureListening(7, 5)).toBe(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await connectOk(socketPath);
  });

  it('非 socket 残留文件被原子替换为可用监听', async () => {
    const root = useTmpDir('mao-channel-');
    mkdirSync(join(root, '7', '5'), { recursive: true });
    writeFileSync(join(root, '7', '5', 'runtime.sock'), 'stale');

    const server = makeServer(root);
    const socketPath = await server.ensureListening(7, 5);

    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await connectOk(socketPath);
  });
});
