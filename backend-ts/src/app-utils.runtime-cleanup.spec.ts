import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeSessionCleanup } from './app-utils.js';

function tempRoot(): string {
  return join(tmpdir(), `mao-runtime-session-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('runtimeSessionCleanup（会话删除的 runtime 回收）', () => {
  it('回收同一会话在所有运行身份下的目录（群聊多发言者），不动其他会话与非用户目录', () => {
    const root = tempRoot();
    try {
      // 会话 1607 在归属者 17 与发言者 67 下都有产物（技能软链/shellOutput/userMessages 等）
      for (const uid of ['17', '67']) {
        mkdirSync(join(root, uid, '1607', 'shellOutput'), { recursive: true });
        writeFileSync(join(root, uid, '1607', 'shellOutput', 'x.out'), 'x');
      }
      mkdirSync(join(root, '17', '1607', 'skills', 'java'), { recursive: true });
      // 其他会话、非数字运行期目录不回收
      mkdirSync(join(root, '17', '9999'), { recursive: true });
      mkdirSync(join(root, 'channels'), { recursive: true });

      runtimeSessionCleanup(root)(17, 1607);

      expect(existsSync(join(root, '17', '1607'))).toBe(false);
      expect(existsSync(join(root, '67', '1607'))).toBe(false);
      expect(existsSync(join(root, '17', '9999'))).toBe(true);
      expect(existsSync(join(root, 'channels'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sessionId 与某用户 id 相同时不得误删 channels/{uid} 容器通道目录', () => {
    const root = tempRoot();
    try {
      // 生产布局：MAO_RUNTIME_DIR=/opt/mao-data/runtime，channel 目录为 {runtimeRoot}/channels/{userId}，
      // 内含 runtime.sock 与 .token（被 bind mount 进该用户容器）。session.id 与 user.id 都是 1 起的小整数，
      // 二者相等是常态——扫描必须只认纯数字用户目录，否则删会话会打挂另一个用户的 docker 运行面。
      mkdirSync(join(root, 'channels', '11'), { recursive: true });
      writeFileSync(join(root, 'channels', '11', 'runtime.sock'), 'sock');
      writeFileSync(join(root, 'channels', '11', '.token'), 'token');
      mkdirSync(join(root, 'channels', '67'), { recursive: true });
      mkdirSync(join(root, '2', '11', 'shellOutput'), { recursive: true });
      mkdirSync(join(root, '67', '11'), { recursive: true });

      runtimeSessionCleanup(root)(2, 11);

      // 归属者与发言者的会话目录照常回收
      expect(existsSync(join(root, '2', '11'))).toBe(false);
      expect(existsSync(join(root, '67', '11'))).toBe(false);
      // 容器通道目录必须原样保留（含 socket 与 token）
      expect(existsSync(join(root, 'channels', '11', 'runtime.sock'))).toBe(true);
      expect(existsSync(join(root, 'channels', '11', '.token'))).toBe(true);
      expect(existsSync(join(root, 'channels', '67'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
