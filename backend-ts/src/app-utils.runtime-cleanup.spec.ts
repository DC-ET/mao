import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeSessionCleanup } from './app-utils.js';

describe('runtimeSessionCleanup（会话删除的 runtime 回收）', () => {
  it('回收同一会话在所有运行身份下的目录（群聊多发言者），不动其他会话与非用户目录', () => {
    const root = join(tmpdir(), `mao-runtime-session-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
});
