import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveSendDir, runtimeSessionCleanup } from './app-utils.js';

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

/**
 * FILE_SEND_DIR 启动守卫（技术方案 2026-11-24-send-file-snapshot D3）：快照走属主鉴权的
 * send-download，落在公开 /uploads/ 树里会同时变成免鉴权可读 + 可被容器改写。
 * 守卫必须在 resolve 之前拿原始值判断层级（相对路径 resolve 后都成了绝对路径）。
 */
describe('resolveSendDir（FILE_SEND_DIR 不得落在 FILE_UPLOAD_DIR 内）', () => {
  it('接受并列兄弟目录与家目录展开', () => {
    expect(resolveSendDir('./send-files', './uploads')).toBe(resolve('send-files'));
    expect(resolveSendDir('~/mao-send', '~/mao-uploads')).toBe(resolve(homedir(), 'mao-send'));
  });

  it('拒绝等于 / 内嵌于上传根（含拼写规避）', () => {
    expect(() => resolveSendDir('./uploads', './uploads')).toThrow(/must not be inside/);
    expect(() => resolveSendDir('./uploads/send', './uploads')).toThrow(/must not be inside/);
    expect(() => resolveSendDir('~/mao/uploads/send', '~/mao/uploads')).toThrow(/must not be inside/);
    // 段前缀不等于层级包含：uploads2 不是 uploads 的子目录
    expect(resolveSendDir('./uploads2/send', './uploads')).toBe(resolve('uploads2/send'));
    // 反向（上传根在快照目录内）同样放过：两者互不嵌套
    expect(resolveSendDir('./data/send', './data/send/inner')).toBe(resolve('data/send'));
  });

  // 三/四轮评审：纯词法 resolve 挡不住指向 uploadDir 的软链——`/opt/mao-data/upl -> /opt/mao-data/uploads`
  // 词法上互不嵌套，realpath 后 sendDir 整个就是 uploadDir，快照会写进公开 /uploads/ 树。
  it('拒绝指向 / 位于上传根内的符号链接', () => {
    const root = join(tmpdir(), `mao-send-dir-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      mkdirSync(join(root, 'uploads'), { recursive: true });
      // 1) sendDir 自身就是指向 uploadDir 的软链
      symlinkSync(join(root, 'uploads'), join(root, 'upl'));
      expect(() => resolveSendDir(join(root, 'upl'), join(root, 'uploads'))).toThrow(/must not be inside/);
      // 2) sendDir 的子目录软链指回 uploadDir 内部
      mkdirSync(join(root, 'send-files'), { recursive: true });
      mkdirSync(join(root, 'uploads', 'sub'), { recursive: true });
      symlinkSync(join(root, 'uploads', 'sub'), join(root, 'send-files', 'sub'));
      expect(() => resolveSendDir(join(root, 'send-files', 'sub'), join(root, 'uploads'))).toThrow(/must not be inside/);
      // 3) 目标尚不存在（create-app 在 mkdir 之前调守卫）：往上找已存在祖先归一化
      expect(() => resolveSendDir(join(root, 'uploads', 'nope', 'deeper'), join(root, 'uploads'))).toThrow(/must not be inside/);
      // 对照组：真的兄弟目录照常放行
      mkdirSync(join(root, 'send-files2'), { recursive: true });
      expect(resolveSendDir(join(root, 'send-files2'), join(root, 'uploads'))).toBe(join(root, 'send-files2'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
