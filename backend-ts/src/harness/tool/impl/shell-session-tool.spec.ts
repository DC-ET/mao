import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellSessionTool } from './shell-session-tool.js';
import { SecurityException } from '../../safety/path-sandbox.js';

describe('ShellSessionTool', () => {
  const pathSandbox = {
    resolve: vi.fn((_p: string, ws: string | null) => ws ?? '/tmp'),
    resolveLenient: vi.fn((p: string, ws: string | null) => p.startsWith('/') ? p : `${ws ?? '/tmp'}/${p}`),
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
  const outputManager = {
    readUntilMarker: vi.fn(async () => {
      // 真实实现读到 marker 后会 finishCommand，mock 也要清掉 pending
      session.pendingCommand = null;
      return { output: 'hello\n', truncated: false, completed: true, exitCode: null, matched: null };
    }),
  };
  const background = { submit: vi.fn(() => 'task-1') };
  const git = { getTokenMapByUser: vi.fn(async () => ({ 'github.com': 'tok' })) };
  const tool = new ShellSessionTool(pathSandbox as never, sessionManager as never, outputManager as never, background as never, git);

  beforeEach(() => {
    // submit 是 mock，后台读取任务不会真的跑，pending 需要在用例间复位
    session.pendingCommand = null;
  });

  it('executes lists closes and writes stdin', async () => {
    expect(tool.getName()).toBe('shell');
    expect(tool.getDescription()).toContain('exec');
    expect(tool.getInputSchema().properties).toBeTruthy();
    const exec = JSON.parse(await tool.execute(JSON.stringify({ command: 'echo hi' }), 11, 7, '/tmp'));
    expect(exec.output).toContain('hello');
    expect(sessionManager.close).toHaveBeenCalled();
    const listed = JSON.parse(await tool.execute(JSON.stringify({ action: 'list' }), 11, 7, '/tmp'));
    expect(listed.sessions ?? listed).toBeTruthy();
    const closed = JSON.parse(await tool.execute(JSON.stringify({ action: 'close', session_id: 'sh-1' }), 11, null, null));
    expect(closed.success).toBe(true);
    const stdin = JSON.parse(await tool.execute(JSON.stringify({ action: 'write_stdin', session_id: 'sh-1', input: 'y\n' }), 11, null, null));
    expect(stdin.session_id).toBe('sh-1');
    const unknown = JSON.parse(await tool.execute(JSON.stringify({ action: 'nope' }), 11, null, null));
    expect(unknown.error).toContain('未知动作');
  });

  it('submits async exec and reports missing command', async () => {
    const asyncResult = JSON.parse(await tool.execute(JSON.stringify({ command: 'sleep 1', async: true, keep_session: true }), 11, 7, '/tmp'));
    expect(asyncResult.async).toBe(true);
    expect(asyncResult.task_id).toBe('task-1');
    expect(asyncResult.session_id).toBe('sh-1');
    expect(asyncResult.output_file).toBe('/tmp/out.log');
    expect(asyncResult.message).toContain('后台执行');
    const missing = JSON.parse(await tool.execute(JSON.stringify({ action: 'exec' }), 11, null, null));
    expect(missing.error).toContain('command');
    const noSession = JSON.parse(await tool.execute(JSON.stringify({ action: 'write_stdin' }), 11, null, null));
    expect(noSession.error).toContain('session_id');
    sessionManager.getSession.mockReturnValueOnce(null);
    const gone = JSON.parse(await tool.execute(JSON.stringify({ action: 'write_stdin', session_id: 'x', input: 'a' }), 11, null, null));
    expect(gone.error).toContain('不存在');
  });

  it('allows shell workdirs outside the workspace', async () => {
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: 'ls', workdir: '/etc' }), 11, 7, '/tmp'));
    expect(result.error).toBeUndefined();
    expect(pathSandbox.resolveLenient).toHaveBeenCalledWith('/etc', '/tmp');
  });

  it('maps shell workdir resolution errors to error json', async () => {
    pathSandbox.resolveLenient.mockImplementationOnce(() => { throw new SecurityException('blocked'); });
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: 'ls', workdir: '/etc' }), 11, 7, '/tmp'));
    expect(result.error).toContain('blocked');
  });

  it('blocks pkill node and killall via deny-list', async () => {
    session.writeStdin.mockClear();
    const pkill = JSON.parse(await tool.execute(JSON.stringify({ command: 'pkill -f node' }), 11, 7, '/tmp'));
    expect(pkill.error).toContain('命令被拒绝');
    expect(pkill.error).toContain('pkill');
    expect(session.writeStdin).not.toHaveBeenCalled();

    session.writeStdin.mockClear();
    const killall = JSON.parse(await tool.execute(JSON.stringify({ command: 'killall node' }), 11, 7, '/tmp'));
    expect(killall.error).toContain('命令被拒绝');
    expect(killall.error).toContain('killall');
    expect(session.writeStdin).not.toHaveBeenCalled();

    session.writeStdin.mockClear();
    const ok = JSON.parse(await tool.execute(JSON.stringify({ command: 'pkill bash' }), 11, 7, '/tmp'));
    expect(ok.error).toBeUndefined();
    expect(session.writeStdin).toHaveBeenCalled();
  });
});

describe('ShellSessionTool marker and environment handling', () => {
  function harness(readResult: Partial<{ output: string; truncated: boolean; completed: boolean; exitCode: number | null; matched: string | null }> = {}) {
    const shellSession = {
      sessionId: 'sh-1',
      writeStdin: vi.fn(),
      incrementCommandCount: vi.fn(),
      touch: vi.fn(),
      setCurrentWorkdir: vi.fn(),
      currentWorkdir: '/tmp',
      outputFile: '/tmp/out.log',
      isAlive: () => true,
      peekBuffer: () => '',
      pendingCommand: null as { marker: string; keepSession: boolean; persist: boolean; taskId: string | null } | null,
      beginCommand(marker: string, keepSession: boolean, persist = true, taskId: string | null = null) {
        shellSession.pendingCommand = { marker, keepSession, persist, taskId };
      },
    };
    const sessionManager = {
      getOrCreate: vi.fn(() => shellSession),
      getSession: vi.fn(() => shellSession),
      close: vi.fn(),
      listByConversation: vi.fn(() => [shellSession]),
    };
    const outputManager = {
      readUntilMarker: vi.fn(async () => {
        const result = {
          output: 'hello\n', truncated: false, completed: true, exitCode: null, matched: null, ...readResult,
        };
        // 只有读到 marker 才算命令结束，未完成时 pending 必须保留供续等
        if (result.completed) shellSession.pendingCommand = null;
        return result;
      }),
    };
    const tool = new ShellSessionTool(
      { resolve: vi.fn((p: string) => p), resolveLenient: vi.fn((p: string) => p) } as never,
      sessionManager as never,
      outputManager as never,
      { submit: vi.fn(() => 'task-1') } as never,
      null,
      { generateShellToken: vi.fn(() => 'jwt-to"ken') },
      { findById: vi.fn(async () => ({ username: 'alice' })) },
    );
    const written = () => shellSession.writeStdin.mock.calls.map((c) => String(c[0])).join('');
    return { tool, shellSession, sessionManager, outputManager, written };
  }

  it('appends a completion marker to write_stdin so it does not wait for the timeout', async () => {
    const { tool, written } = harness();
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'write_stdin', session_id: 'sh-1', input: 'y' }), 11, 7, '/tmp',
    ));
    expect(written()).toMatch(/y\necho __CMD_DONE_[0-9a-f]+__ \$\?\n/);
    expect(result.completed).toBe(true);
  });

  it('reports the real exit code and falls back to -1 when the marker never arrives', async () => {
    const failed = harness({ exitCode: 7 });
    const withCode = JSON.parse(await failed.tool.execute(JSON.stringify({ command: 'false' }), 11, 7, '/tmp'));
    expect(withCode.exit_code).toBe(7);

    const timedOut = harness({ completed: false, exitCode: null });
    const noMarker = JSON.parse(await timedOut.tool.execute(JSON.stringify({ command: 'sleep 99' }), 11, 7, '/tmp'));
    expect(noMarker.exit_code).toBe(-1);
  });

  it('cds into workdir so a reused session does not run in the wrong directory', async () => {
    const { tool, written } = harness();
    await tool.execute(JSON.stringify({ command: 'ls', session_id: 'sh-1', workdir: '/tmp/sub' }), 11, 7, '/tmp');
    expect(written()).toContain("cd '/tmp/sub'");
  });

  it('exports a freshly signed MAO_TOKEN before every command', async () => {
    const { tool, written } = harness();
    await tool.execute(JSON.stringify({ command: 'mao-admin-cli whoami' }), 11, 7, '/tmp');
    const script = written();
    expect(script).toContain(`export MAO_TOKEN='jwt-to"ken'`);
    expect(script.indexOf('export MAO_TOKEN')).toBeLessThan(script.indexOf('mao-admin-cli'));
  });

  it('injects a fresh MAO_TOKEN before write_stdin commands on a reused session', async () => {
    const { tool, written } = harness();
    await tool.execute(
      JSON.stringify({ action: 'write_stdin', session_id: 'sh-1', input: 'mao-user pref weixin get' }), 11, 7, '/tmp',
    );
    const script = written();
    expect(script).toContain(`export MAO_TOKEN='jwt-to"ken'`);
    expect(script.indexOf('export MAO_TOKEN')).toBeLessThan(script.indexOf('mao-user'));
  });

  it('refreshes current_workdir from pwd once the command completes', async () => {
    const { tool, shellSession, outputManager } = harness();
    outputManager.readUntilMarker
      .mockImplementationOnce(async () => ({ output: 'done\n', truncated: false, completed: true, exitCode: 0, matched: null }))
      .mockImplementationOnce(async () => ({ output: '/tmp/sub\n', truncated: false, completed: true, exitCode: null, matched: null }));
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: 'cd sub' }), 11, 7, '/tmp'));
    expect(result.current_workdir).toBe('/tmp/sub');
    expect(shellSession.setCurrentWorkdir).toHaveBeenCalledWith('/tmp/sub');
  });

  it('keeps the session and reports how to resume when wait_for fires early', async () => {
    const { tool, sessionManager, outputManager } = harness({
      output: 'Listening on 3000\n', completed: false, matched: 'Listening on',
    });
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ command: 'npm run dev', wait_for: 'Listening on' }), 11, 7, '/tmp',
    ));
    expect(result.completed).toBe(false);
    expect(result.matched).toBe('Listening on');
    expect(result.exit_code).toBe(-1);
    expect(result.message).toContain('await_async');
    // 命令仍在运行：即使没有 keep_session 也不能回收会话，否则剩余输出会被 SIGKILL 丢掉
    expect(sessionManager.close).not.toHaveBeenCalled();
    expect(outputManager.readUntilMarker.mock.calls[0][3]).toBeInstanceOf(RegExp);
  });

  it('resumes an unfinished command through await_async and settles the session afterwards', async () => {
    const { tool, shellSession, sessionManager, outputManager } = harness({ completed: false });
    const first = JSON.parse(await tool.execute(
      JSON.stringify({ command: 'sleep 99', yield_time_ms: 10 }), 11, 7, '/tmp',
    ));
    expect(first.completed).toBe(false);
    const pendingMarker = shellSession.pendingCommand?.marker;
    expect(pendingMarker).toBeTruthy();
    outputManager.readUntilMarker.mockImplementationOnce(async () => {
      shellSession.pendingCommand = null;
      return { output: 'finally\n', truncated: false, completed: true, exitCode: 0, matched: null };
    });
    const resumed = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'await_async', session_id: 'sh-1' }), 11, 7, '/tmp',
    ));
    expect(resumed.completed).toBe(true);
    expect(resumed.exit_code).toBe(0);
    expect(resumed.output).toContain('finally');
    // 续读用的是原命令的 marker，否则会读到别的命令的输出
    expect(outputManager.readUntilMarker.mock.calls[1][1]).toBe(pendingMarker);
    expect(sessionManager.close).toHaveBeenCalledWith('sh-1');
  });

  it('refuses a new exec while the session still has an unfinished command', async () => {
    const { tool } = harness({ completed: false });
    await tool.execute(JSON.stringify({ command: 'sleep 99', yield_time_ms: 10 }), 11, 7, '/tmp');
    const blocked = JSON.parse(await tool.execute(JSON.stringify({ command: 'echo hi', session_id: 'sh-1' }), 11, 7, '/tmp'));
    expect(blocked.error).toContain('未结束的命令');
  });

  it('rejects an invalid or over-long wait_for before touching the shell', async () => {
    const { tool, shellSession } = harness();
    const invalid = JSON.parse(await tool.execute(JSON.stringify({ command: 'ls', wait_for: '([' }), 11, 7, '/tmp'));
    expect(invalid.error).toContain('wait_for 不是合法正则');
    const tooLong = JSON.parse(await tool.execute(JSON.stringify({ command: 'ls', wait_for: 'x'.repeat(201) }), 11, 7, '/tmp'));
    expect(tooLong.error).toContain('wait_for 过长');
    expect(shellSession.writeStdin).not.toHaveBeenCalled();
  });

  it('reports await_async without a pending command or with a background owner', async () => {
    const { tool, shellSession } = harness();
    const none = JSON.parse(await tool.execute(JSON.stringify({ action: 'await_async', session_id: 'sh-1' }), 11, 7, '/tmp'));
    expect(none.error).toContain('没有未结束的命令');
    shellSession.pendingCommand = { marker: 'm', keepSession: true, persist: true, taskId: 'bg-9' };
    const owned = JSON.parse(await tool.execute(JSON.stringify({ action: 'await_async', session_id: 'sh-1' }), 11, 7, '/tmp'));
    expect(owned.error).toContain('bg-9');
    const stdinBlocked = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'write_stdin', session_id: 'sh-1', input: 'y' }), 11, 7, '/tmp',
    ));
    expect(stdinBlocked.error).toContain('bg-9');
  });

  it('feeds write_stdin to the running command instead of queueing a new marker', async () => {
    const { tool, shellSession, outputManager } = harness({ completed: false });
    await tool.execute(JSON.stringify({ command: 'read -r x', yield_time_ms: 10 }), 11, 7, '/tmp');
    const pendingMarker = shellSession.pendingCommand?.marker;
    shellSession.writeStdin.mockClear();
    outputManager.readUntilMarker.mockClear();
    outputManager.readUntilMarker.mockImplementationOnce(async () => {
      shellSession.pendingCommand = null;
      return { output: 'got:y\n', truncated: false, completed: true, exitCode: 0, matched: null };
    });
    const answered = JSON.parse(await tool.execute(
      JSON.stringify({ action: 'write_stdin', session_id: 'sh-1', input: 'y' }), 11, 7, '/tmp',
    ));
    expect(answered.completed).toBe(true);
    // 只写输入本身，不能再排一个 marker（它只会在当前命令结束后才执行）
    expect(shellSession.writeStdin.mock.calls[0][0]).toBe('y\n');
    expect(outputManager.readUntilMarker.mock.calls[0][1]).toBe(pendingMarker);
  });
});
