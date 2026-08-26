import { describe, expect, it, vi } from 'vitest';
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
  };
  const sessionManager = {
    getOrCreate: vi.fn(() => session),
    getSession: vi.fn(() => session),
    close: vi.fn(),
    listByConversation: vi.fn(() => [session]),
  };
  const outputManager = {
    readUntilMarker: vi.fn(async () => ({ output: 'hello\n', truncated: false, completed: true })),
  };
  const background = { submit: vi.fn(() => 'task-1') };
  const git = { getTokenMapByUser: vi.fn(async () => ({ 'github.com': 'tok' })) };
  const tool = new ShellSessionTool(pathSandbox as never, sessionManager as never, outputManager as never, background as never, git);

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
});

describe('ShellSessionTool marker and environment handling', () => {
  function harness(readResult: Partial<{ output: string; truncated: boolean; completed: boolean; exitCode: number | null }> = {}) {
    const shellSession = {
      sessionId: 'sh-1',
      writeStdin: vi.fn(),
      incrementCommandCount: vi.fn(),
      touch: vi.fn(),
      setCurrentWorkdir: vi.fn(),
      currentWorkdir: '/tmp',
      outputFile: '/tmp/out.log',
      isAlive: () => true,
    };
    const sessionManager = {
      getOrCreate: vi.fn(() => shellSession),
      getSession: vi.fn(() => shellSession),
      close: vi.fn(),
      listByConversation: vi.fn(() => [shellSession]),
    };
    const outputManager = {
      readUntilMarker: vi.fn(async () => ({
        output: 'hello\n', truncated: false, completed: true, exitCode: null, ...readResult,
      })),
    };
    const tool = new ShellSessionTool(
      { resolve: vi.fn((p: string) => p) } as never,
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
      .mockImplementationOnce(async () => ({ output: 'done\n', truncated: false, completed: true, exitCode: 0 }))
      .mockImplementationOnce(async () => ({ output: '/tmp/sub\n', truncated: false, completed: true, exitCode: null }));
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: 'cd sub' }), 11, 7, '/tmp'));
    expect(result.current_workdir).toBe('/tmp/sub');
    expect(shellSession.setCurrentWorkdir).toHaveBeenCalledWith('/tmp/sub');
  });
});
