import os from 'node:os';
import readline from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalExecutor, mcpSpawnApprovalId } from '../src/local/executor';
import type { ApprovalPolicy } from '../src/local/approval';
import * as trust from '../src/local/trust';
import type { WsClient } from '../src/ws/ws-client';

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  yolo: false,
  force: false,
  onApproval: 'remote',
  approveRules: [],
  strictDangerCheck: false,
  iKnowWhatImDoing: false,
  stdoutIsTty: true,
  stdinIsTty: true,
  remoteApprovalTimeoutMs: 2_000,
  ...over,
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ws(sent: object[]): WsClient {
  return {
    sendReliable: async (payload: object) => {
      sent.push(payload);
      return true;
    },
  } as unknown as WsClient;
}

function tool(sessionId: number, requestId: string, toolName = 'read_file', args: Record<string, unknown> = { path: 'missing.txt' }) {
  return {
    type: 'tool_execute',
    sessionId,
    data: {
      requestId,
      toolName,
      arguments: JSON.stringify(args),
      workspace: os.tmpdir(),
      needApproval: true,
    },
  };
}

describe('remote approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function exec(sent: object[], over: Partial<ApprovalPolicy> = {}) {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    return new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy(over),
    });
  }

  it('does not prompt, deny, or emit tool_approval while waiting for a boolean echo', async () => {
    const ask = vi.spyOn(readline, 'createInterface');
    const sent: object[] = [];
    const runner = exec(sent);
    const pending = runner.handleEvent(tool(7, 'req-1'));
    await delay(30);
    expect(sent).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 7,
      data: { requestId: 'req-1', approved: null },
    });
    await delay(20);
    expect(sent).toEqual([]);
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 7,
      data: { requestId: 'req-1', approved: true },
    });
    await pending;
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_approval')).toBe(false);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_result')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('times out into tool_error and leaves the process running', async () => {
    const sent: object[] = [];
    const runner = exec(sent, { remoteApprovalTimeoutMs: 30 });
    await runner.handleEvent(tool(7, 'req-timeout'));
    const err = sent.find((m) => (m as { type?: string }).type === 'tool_error') as { error?: string };
    expect(err.error).toMatch(/超时/);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_result')).toBe(false);
  });

  it('fails the wait immediately when the socket closes', async () => {
    const sent: object[] = [];
    const runner = exec(sent, { remoteApprovalTimeoutMs: 5_000 });
    const started = Date.now();
    const pending = runner.handleEvent(tool(7, 'req-drop'));
    await delay(20);
    runner.onWsClosed();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
    const err = sent.find((m) => (m as { type?: string }).type === 'tool_error') as { error?: string };
    expect(err.error).toMatch(/连接已断开/);
  });

  it('treats remote always-allow as one shot and still waits on the next session', async () => {
    const sent: object[] = [];
    const stored = policy();
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const runner = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: stored,
    });
    const first = runner.handleEvent(tool(1, 'req-a'));
    await delay(15);
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 1,
      data: { requestId: 'req-a', approved: true, alwaysAllow: true },
    });
    await first;
    expect(stored.alwaysAllow ?? []).toEqual([]);
    const second = runner.handleEvent(tool(2, 'req-b'));
    await delay(30);
    const results = sent.filter((m) => (m as { type?: string }).type === 'tool_result');
    expect(results).toHaveLength(1);
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 2,
      data: { requestId: 'req-b', approved: false },
    });
    await second;
    const denied = sent.find((m) => (m as { type?: string; requestId?: string }).requestId === 'req-b') as { error?: string };
    expect(denied.error).toMatch(/拒绝/);
  });

  it('waits on a shell step before running it', async () => {
    const sent: object[] = [];
    const runner = exec(sent, { remoteApprovalTimeoutMs: 40 });
    await runner.handleEvent(tool(8, 'sh-1', 'shell', { command: 'echo hi' }));
    const err = sent.find((m) => (m as { type?: string }).type === 'tool_error') as { error?: string };
    expect(err.error).toMatch(/超时/);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_approval')).toBe(false);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_result')).toBe(false);
  });

  it('waits on stdio MCP spawn and reports the remote decision without tool_approval', async () => {
    const sent: object[] = [];
    const runner = exec(sent);
    const requestId = mcpSpawnApprovalId(12, 'mcp-1', 'evil');
    const pending = runner.handleEvent({
      type: 'mcp_sync_required',
      sessionId: 12,
      data: {
        syncId: 'mcp-1',
        workspace: os.tmpdir(),
        servers: [{ name: 'evil', type: 'STDIO', command: 'mao-mcp-missing-bin' }],
      },
    });
    await delay(30);
    expect(sent).toEqual([]);
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 12,
      data: { requestId, approved: null },
    });
    await delay(20);
    expect(sent).toEqual([]);
    await runner.handleEvent({
      type: 'tool_approval_resolved',
      sessionId: 12,
      data: { requestId, approved: false },
    });
    await pending;
    const report = sent.find((m) => (m as { type?: string }).type === 'mcp_tools_report') as {
      servers: Array<{ connected: boolean; error: string }>;
    };
    expect(report.servers[0].connected).toBe(false);
    expect(report.servers[0].error).toMatch(/拒绝/);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_approval')).toBe(false);
    expect(sent.some((m) => (m as { type?: string }).type === 'tool_error')).toBe(false);
  });

  it('does not answer skill or mcp sync outside the trust root', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const runner = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy({ yolo: true }),
    });
    await runner.handleEvent({
      type: 'skill_sync_required',
      sessionId: 3,
      data: { syncId: 's1', syncUrl: 'http://127.0.0.1:1/nope', workspace: '/', removed: [] },
    });
    await runner.handleEvent({
      type: 'mcp_sync_required',
      sessionId: 3,
      data: { syncId: 'm1', workspace: '/', servers: [{ name: 'x', command: 'node' }] },
    });
    expect(sent).toEqual([]);
  });
});
