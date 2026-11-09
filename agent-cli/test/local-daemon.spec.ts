import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliConfig } from '../src/args';
import {
  approvalModeLabel,
  buildDaemonApprovalPolicy,
  cmdLocal,
  resolveDaemonWorkspace,
} from '../src/commands/local';
import type { ChatContext } from '../src/commands/chat';
import { LocalExecutor } from '../src/local/executor';
import { McpManager } from '../src/local/tools/mcp';
import * as configStore from '../src/config/config-store';
import { WsClient } from '../src/ws/ws-client';
import * as eventFilter from '../src/ws/event-filter';
import { EXIT } from '../src/util/exit-codes';
import { startMockWsServer, type MockWsServer } from './fixtures/mock-ws-server';

const tty = { stdoutIsTty: true, stdinIsTty: true };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for daemon');
    await delay(20);
  }
}

describe('local daemon', () => {
  let server: MockWsServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await server.close();
    server = undefined;
  });

  it('resolves a relative trust root and pins approval TTY bits off', () => {
    expect(resolveDaemonWorkspace('proj', '/tmp/cwd')).toBe(path.resolve('/tmp/cwd', 'proj'));
    expect(resolveDaemonWorkspace('/abs/root', '/tmp/cwd')).toBe('/abs/root');
    expect(resolveDaemonWorkspace(undefined, '/tmp/cwd')).toBe(path.resolve('/tmp/cwd'));
    const cfg = parseCliConfig(['local', '--serve'], tty);
    const policy = buildDaemonApprovalPolicy(cfg);
    expect(policy.stdoutIsTty).toBe(false);
    expect(policy.stdinIsTty).toBe(false);
    expect(policy.onApproval).toBe('remote');
    expect(approvalModeLabel(policy)).toMatch(/300 秒/);
  });

  it('refuses a missing or untrusted workspace without prompting', async () => {
    const missing = path.join(os.tmpdir(), `mao-missing-${process.pid}`);
    const lines: string[] = [];
    const code = await cmdLocal(context(missing), { stderr: (line) => lines.push(line), onSignal: () => {} });
    expect(code).toBe(EXIT.GENERAL);
    expect(lines.join('\n')).toMatch(/不存在或不是目录/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-untrusted-'));
    vi.spyOn(configStore, 'loadUserConfig').mockReturnValue({ trustedWorkspaces: [] });
    const untrusted: string[] = [];
    const denied = await cmdLocal(context(dir), { stderr: (line) => untrusted.push(line), onSignal: () => {} });
    expect(denied).toBe(EXIT.APPROVAL);
    expect(untrusted.join('\n')).toMatch(/交互终端/);
    expect(untrusted.join('\n')).toMatch(/trustedWorkspaces/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('executes a tool for a session it never subscribed to', async () => {
    server = await startMockWsServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-daemon-'));
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi-from-daemon');
    vi.spyOn(configStore, 'loadUserConfig').mockReturnValue({
      trustedWorkspaces: [fs.realpathSync(dir)],
    });
    const accept = vi.spyOn(eventFilter, 'acceptEvent');
    const closeAll = vi.spyOn(McpManager.prototype, 'closeAll');
    const relay = vi.spyOn(LocalExecutor.prototype, 'setApprovalRelaySupported');
    const lines: string[] = [];
    const signals = new Map<string, () => void>();
    let tokens = 0;
    const pending = cmdLocal(context(dir, server.httpBase, async () => `tok-${++tokens}`), {
      getDevice: () => ({ id: 'dev-daemon', name: 'DaemonHost', platform: 'darwin' }),
      onSignal: (name, fn) => { signals.set(name, fn); },
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      createWs: (opts) => new WsClient({
        ...opts,
        heartbeatIntervalMs: 10_000,
        silenceTimeoutMs: 10_000,
        reconnectInitialMs: 30,
        reconnectMaxMs: 50,
      }),
    });
    try {
      await waitFor(() => server!.received.some((m) => (m as { type?: string }).type === 'auth'));
      const auth = server.received.find((m) => (m as { type?: string }).type === 'auth') as {
        token?: string;
        device?: { id: string; name: string };
      };
      expect(auth.token).toBe('tok-1');
      expect(auth.device).toEqual({ id: 'dev-daemon', name: 'DaemonHost', platform: 'darwin' });
      expect(server.received.some((m) => (m as { type?: string }).type === 'subscribe')).toBe(false);
      expect(accept).not.toHaveBeenCalled();
      await waitFor(() => lines.some((line) => line.includes('已接管本机 LOCAL 执行连接')));
      expect(lines.join('\n')).toContain('账号: ada');
      expect(lines.join('\n')).toContain(`信任根: ${dir}`);

      server.send({
        type: 'connected',
        sessionId: null,
        data: { approvalRelay: true },
      });
      await waitFor(() => relay.mock.calls.some((call) => call[0] === true));

      server.send({
        type: 'tool_execute',
        sessionId: 42,
        data: {
          requestId: 'req-1',
          toolName: 'read_file',
          arguments: JSON.stringify({ path: 'hello.txt' }),
          workspace: dir,
          needApproval: false,
        },
      });
      await waitFor(() => server!.received.some((m) => (m as { type?: string }).type === 'tool_result'));
      const result = server.received.find((m) => (m as { type?: string }).type === 'tool_result') as { result?: string };
      expect(result.result).toContain('hi-from-daemon');
      expect(server.received.some((m) => (m as { type?: string }).type === 'subscribe')).toBe(false);
      expect(accept).not.toHaveBeenCalled();
      await waitFor(() => lines.some((line) => line.includes('tool session=42 tool=read_file')));
      expect(lines.join('\n')).not.toContain('hello.txt');

      server.drop();
      await waitFor(() => server!.received.filter((m) => (m as { type?: string }).type === 'auth').length >= 2);
      const second = server.received.filter((m) => (m as { type?: string }).type === 'auth').at(-1) as { token?: string };
      expect(second.token).toBe('tok-2');
      expect(second.token).not.toBe('tok-1');

      signals.get('SIGTERM')?.();
      await expect(pending).resolves.toBe(0);
      expect(lines.join('\n')).toMatch(/已退出。服务会话 1 个，执行工具 1 次/);
      expect(closeAll).toHaveBeenCalled();
    } finally {
      signals.get('SIGTERM')?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

function context(workspace: string, baseUrl = 'http://127.0.0.1:9', getToken: () => Promise<string | null> = async () => 'tok'): ChatContext {
  const cfg = parseCliConfig(['local', '--serve', '--workspace', workspace, '--yolo'], tty);
  return {
    rest: { me: async () => ({ username: 'ada', displayName: 'ada' }) },
    cfg,
    resolved: {},
    baseUrl,
    getToken,
    logger: { debug() {}, warn() {}, info() {} },
  } as unknown as ChatContext;
}
