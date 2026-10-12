import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellSessionTool } from './shell-session-tool.js';

/**
 * 逻辑 BUG 验证（review 探针，非产品用例）：
 * handleExec 里 workdir 的 cd 通过 executeWithMarker 发出后，返回值被完全丢弃。
 * cd 失败（目录不存在/超时）时命令仍在原 workspace 静默执行，
 * 工具描述承诺的「传 workdir 会自动 cd」被破坏且无任何失败信号。
 */

describe('review: workdir 的 cd 失败必须上报而不是静默执行', () => {
  const pathSandbox = {
    resolve: vi.fn((_p: string, ws: string | null) => ws ?? '/tmp'),
    resolveLenient: vi.fn((p: string, ws: string | null) => (p.startsWith('/') ? p : `${ws ?? '/tmp'}/${p}`)),
  };
  const session = {
    sessionId: 'sh-1',
    writeStdin: vi.fn(),
    incrementCommandCount: vi.fn(),
    touch: vi.fn(),
    currentWorkdir: '/tmp',
    outputFile: '/tmp/out.log',
    isAlive: () => true,
    pendingCommand: null as { marker: string; keepSession: boolean; persist: boolean; taskId: string | null } | null,
    beginCommand(marker: string, keepSession: boolean, persist = true, taskId: string | null = null) {
      session.pendingCommand = { marker, keepSession, persist, taskId };
    },
  };
  const sessionManager = {
    getOrCreate: vi.fn(() => session),
    getSession: vi.fn(() => session),
    close: vi.fn(),
    listByConversation: vi.fn(() => [session]),
  };
  // 第 1 次 readUntilMarker 对应 cd（失败），第 2 次对应真实命令
  const readResults: Array<{ output: string; truncated: boolean; completed: boolean; exitCode: number | null; matched: null }> = [
    { output: 'bash: cd: /definitely/not/exist: No such file or directory\n', truncated: false, completed: true, exitCode: 1, matched: null },
    { output: 'workspace-root-file-content\n', truncated: false, completed: true, exitCode: 0, matched: null },
  ];
  let readCall = 0;
  const outputManager = {
    readUntilMarker: vi.fn(async () => {
      const r = readResults[Math.min(readCall, readResults.length - 1)]!;
      readCall += 1;
      session.pendingCommand = null;
      return r;
    }),
  };
  const background = { submit: vi.fn(() => 'task-1') };
  const git = { getTokenMapByUser: vi.fn(async () => ({})) };
  const tool = new ShellSessionTool(pathSandbox as never, sessionManager as never, outputManager as never, background as never, git);

  beforeEach(() => {
    session.pendingCommand = null;
    readCall = 0;
    session.writeStdin.mockClear();
  });

  it('cd 失败时结果必须带上失败信号（当前实现静默放行命令）', async () => {
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'exec', command: 'cat secret.txt', workdir: '/definitely/not/exist' }),
      11, 7, '/tmp',
    ));
    // cd 确实发出过
    const cdCall = session.writeStdin.mock.calls.find((c) => String(c[0]).startsWith('cd '));
    expect(cdCall).toBeTruthy();
    // 期望：cd 失败被上报。当前实现 result.error 为 undefined → 断言失败
    expect(result.error).toMatch(/cd|工作目录|No such file/);
  });

  it('cd 失败时不得把命令当成功执行并回传输出（当前实现回传了错误目录下的输出）', async () => {
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'exec', command: 'cat secret.txt', workdir: '/definitely/not/exist' }),
      11, 7, '/tmp',
    ));
    // 期望：命令不被放行执行。当前实现 output 为旧目录里的内容 → 断言失败
    expect(result.output ?? '').not.toContain('workspace-root-file-content');
  });

  it('对照组：cd 成功时命令正常执行、无错误', async () => {
    readResults[0] = { output: '', truncated: false, completed: true, exitCode: 0, matched: null };
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'exec', command: 'cat secret.txt', workdir: '/tmp' }),
      11, 7, '/tmp',
    ));
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('workspace-root-file-content');
    readResults[0] = { output: 'bash: cd: /definitely/not/exist: No such file or directory\n', truncated: false, completed: true, exitCode: 1, matched: null };
  });
});
