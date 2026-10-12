import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { PathSandbox } from '../safety/path-sandbox.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { ShellSessionManager } from './shell-session-manager.js';

/**
 * 逻辑回归用例（round2 审查修复后转正）：
 * getOrCreate 复用分支不校验 conversationId，会话 B 持会话 A 的 session_id
 * 即可拿到 A 的 shell（A 的 cwd / HOME / Git Token 环境），越权执行命令。
 * 预期：复用必须属于同一 conversation，否则拒绝或为调用方新建。
 * 注意：断言用布尔值，避免失败时 vitest 序列化已关闭的 ShellSession 对象而挂起。
 */

function makeManager(dir: string): ShellSessionManager {
  return new ShellSessionManager(
    new PathSandbox(dir),
    RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
  );
}

describe('shell session 复用必须校验会话归属', () => {
  it('跨 conversation 携带他人 session_id 不得复用该会话的 shell', async () => {
    const dir = useTmpDir('mao-shell-review-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'users'), { recursive: true });
    mkdirSync(join(dir, 'ws-a'), { recursive: true });
    mkdirSync(join(dir, 'ws-b'), { recursive: true });
    const manager = makeManager(dir);
    try {
      const a = manager.getOrCreate(1, 'sh-1-aaa', 1, join(dir, 'ws-a'), { 'github.com': 'token-a' });

      // 会话 2 的模型拿到（或猜到）会话 1 的 shell session id
      let reusedSame = false;
      try {
        const reused = manager.getOrCreate(2, 'sh-1-aaa', 2, join(dir, 'ws-b'), { 'github.com': 'token-b' });
        reusedSame = reused === a;
      } catch {
        reusedSame = false; // 拒绝复用也是可接受的修复
      }
      // 当前实现：直接返回会话 1 的 shell → reusedSame=true → 断言失败
      expect(reusedSame).toBe(false);
    } finally {
      manager.closeByConversation(1);
      manager.closeByConversation(2);
    }
  });

  it('同一 conversation 复用仍按原语义放行', async () => {
    const dir = useTmpDir('mao-shell-review-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = makeManager(dir);
    try {
      const a = manager.getOrCreate(1, 'sh-1-bbb', 1, dir);
      const again = manager.getOrCreate(1, 'sh-1-bbb', 1, dir);
      expect(again === a).toBe(true);
      expect(manager.getSession('sh-1-bbb') === a).toBe(true);
    } finally {
      manager.closeByConversation(1);
    }
  });

  it('getSession/close 带归属参数时跨 conversation 不得读、不得杀掉他人的 shell', async () => {
    const dir = useTmpDir('mao-shell-review-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = makeManager(dir);
    try {
      const a = manager.getOrCreate(1, 'sh-1-ccc', 1, dir);
      // 会话 2 持会话 1 的 id：读不到、也关不掉
      expect(manager.getSession('sh-1-ccc', { conversationId: 2 })).toBeNull();
      manager.close('sh-1-ccc', { conversationId: 2 });
      expect(a.isAlive()).toBe(true);
      // 归属一致时读写与关闭照常
      expect(manager.getSession('sh-1-ccc', { conversationId: 1 }) === a).toBe(true);
      manager.close('sh-1-ccc', { conversationId: 1 });
      expect(a.isAlive()).toBe(false);
    } finally {
      manager.closeByConversation(1);
    }
  });

  it('getOrCreate 归属不一致时为调用方新建会话，不动他人的 shell', async () => {
    const dir = useTmpDir('mao-shell-review-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'ws-a'), { recursive: true });
    mkdirSync(join(dir, 'ws-b'), { recursive: true });
    const manager = makeManager(dir);
    try {
      const a = manager.getOrCreate(1, 'sh-1-ddd', 1, join(dir, 'ws-a'));
      const b = manager.getOrCreate(2, 'sh-1-ddd', 2, join(dir, 'ws-b'));
      expect(b === a).toBe(false);
      expect(b.sessionId).not.toBe('sh-1-ddd');
      // 他人生存会话语义上不受影响：仍可按原归属复用
      expect(manager.getOrCreate(1, 'sh-1-ddd', 1, join(dir, 'ws-a')) === a).toBe(true);
    } finally {
      manager.closeByConversation(1);
      manager.closeByConversation(2);
    }
  });
});
