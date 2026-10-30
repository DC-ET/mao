/**
 * 逻辑 BUG 审查第二轮（2026-10-29）——agent-cli 本地文件工具口径 + localShell 运行时。
 *
 * 每个测试断言「正确行为」，当前代码因对应 BUG 而失败——测试失败即证明 BUG 真实存在。
 * 配套文档：docs/code-review/2026-10-29-logic-bug-audit-round2.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { handleReadFile } from '../src/local/tools/files';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createLocalShellRuntime } = require('../vendor/localShell.cjs') as {
  createLocalShellRuntime: (opts?: Record<string, unknown>) => LocalShellRuntime;
};

interface LocalShellRuntime {
  handle: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
  closeAll: () => void;
  getActiveSessionCount: () => number;
}

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
  tmpDirs.length = 0;
});

describe('Logic Bug Audit Round2 — agent-cli local', () => {
  it('BUG-R2-1: read_file 的 offset 应与云端同口径拒绝小数（1.9 不得截断成 1）', () => {
    const dir = tmpDir('mao-r2-parse-');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'l1\nl2\nl3\n', 'utf8');
    // 云端 read-file-tool parseLineIndex（asIntStrict）注释明确：asInt 会 Math.trunc，
    // 1.5 会被当成 1、-0.5 会得到 -0 并绕过 n < 0 —— 本文件自述「与云端同口径」，
    // 正确行为是 offset=1.9 报「参数 offset 必须是非负整数」。
    // BUG：agent-cli 的 parseLineIndex 用了 asInt（Math.trunc）→ 静默按 1 执行，两端分叉。
    const result = handleReadFile({ path: file, offset: 1.9 }, dir, 7701);
    expect(result.error).toEqual(expect.stringContaining('必须是非负整数'));
  });

  it('BUG-R2-1b: read_file 的 limit 传小数字符串应报错而非静默截断', () => {
    const dir = tmpDir('mao-r2-parse-');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'l1\nl2\nl3\n', 'utf8');
    // 云端：limit='2.5' → asIntStrict 不接受小数字符串 → 报错。
    // BUG：本地 asInt('2.5') → 2，静默按 2 行读，同一输入两端结果不同。
    const result = handleReadFile({ path: file, limit: '2.5' }, dir, 7701);
    expect(result.error).toEqual(expect.stringContaining('必须是非负整数'));
  });

  it('BUG-R2-2: exec 的 workdir 不存在时应报错，不得静默在旧目录执行命令', async () => {
    const runtime = createLocalShellRuntime({ buildEnv: async () => ({ ...process.env }) });
    try {
      const dirA = tmpDir('mao-r2-cwd-a-');
      // keep_session: true —— 否则第一次 exec 结束就回收会话，第二次 exec 会走
      // 「新建会话 spawn cwd 不存在」分支而非「复用会话 + cd 失败被忽略」分支
      const first = await runtime.handle(
        { action: 'exec', command: 'echo start', workdir: dirA, keep_session: true },
        { conversationId: 7702 },
      );
      expect(first.error).toBeUndefined();
      const shellId = first.session_id;
      expect(typeof shellId).toBe('string');

      // 云端 shell-session-tool 同场景（shell-session-tool.ts:199-202）：
      //   cd.exitCode != 0 → errorJson('工作目录切换失败：…')
      //   注释：「命令绝不能仍在错误目录里静默执行」
      // BUG：localShell.cjs 的 handleExec 对 executeWithMarker(chdir) 的结果不做任何判定，
      // cd 失败后命令照常执行 —— pwd 在 dirA 里返回 exit_code 0，模型完全无感知。
      const missing = path.join(dirA, 'no-such-dir-r2');
      const second = await runtime.handle(
        { action: 'exec', command: 'pwd', session_id: shellId, workdir: missing },
        { conversationId: 7702 },
      );
      expect(second.error).toBeDefined();
    } finally {
      runtime.closeAll();
    }
  });

  it('BUG-R2-5: write_stdin 触发 bash 退出后死会话应被立即回收', async () => {
    const runtime = createLocalShellRuntime({ buildEnv: async () => ({ ...process.env }) });
    try {
      const dir = tmpDir('mao-r2-exit-');
      const first = await runtime.handle(
        { action: 'exec', command: 'echo hi', keep_session: true, workdir: dir },
        { conversationId: 7703 },
      );
      const shellId = first.session_id;
      expect(typeof shellId).toBe('string');

      const result = await runtime.handle(
        { action: 'write_stdin', session_id: shellId, input: 'exit' },
        { conversationId: 7703 },
      );
      // 返回文案明确说「shell 进程已退出，会话已关闭」——会话必须真的被回收。
      // 云端 shell-session-tool.ts:343-349 已修（settleSession(session, result, true)），
      // 注释：「否则返回文案说『会话已关闭』而死会话仍占着会话数配额」。
      // BUG：localShell.cjs 的 write_stdin 无 pending 分支漏调 settleSession → 死会话留在
      // sessions 表里占住 maxSessions(30) 配额，最长 60s 后才被周期清理兜底回收。
      expect(result.error).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(0);
    } finally {
      runtime.closeAll();
    }
  });
});
