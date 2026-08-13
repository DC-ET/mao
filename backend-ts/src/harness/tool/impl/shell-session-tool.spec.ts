import { describe, expect, it, vi } from 'vitest';
import { ShellSessionTool } from './shell-session-tool.js';
import { SecurityException } from '../../safety/path-sandbox.js';

describe('ShellSessionTool', () => {
  const pathSandbox = { resolve: vi.fn((_p: string, ws: string | null) => ws ?? '/tmp') };
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
    const missing = JSON.parse(await tool.execute(JSON.stringify({ action: 'exec' }), 11, null, null));
    expect(missing.error).toContain('command');
    const noSession = JSON.parse(await tool.execute(JSON.stringify({ action: 'write_stdin' }), 11, null, null));
    expect(noSession.error).toContain('session_id');
    sessionManager.getSession.mockReturnValueOnce(null);
    const gone = JSON.parse(await tool.execute(JSON.stringify({ action: 'write_stdin', session_id: 'x', input: 'a' }), 11, null, null));
    expect(gone.error).toContain('不存在');
  });

  it('maps sandbox blocks to error json', async () => {
    pathSandbox.resolve.mockImplementationOnce(() => { throw new SecurityException('blocked'); });
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: 'ls', workdir: '/etc' }), 11, 7, '/tmp'));
    expect(result.error).toContain('blocked');
  });
});
