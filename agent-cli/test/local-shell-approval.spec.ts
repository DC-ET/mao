import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalExecutor } from '../src/local/executor';
import { resolveRuntimeDir } from '../src/local/paths';
import * as trust from '../src/local/trust';
import type { ApprovalPolicy } from '../src/local/approval';
import type { WsClient } from '../src/ws/ws-client';

const SESSION_ID = 5150;

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  yolo: false,
  force: false,
  onApproval: 'ask',
  approveRules: [],
  strictDangerCheck: false,
  iKnowWhatImDoing: false,
  stdoutIsTty: false,
  stdinIsTty: false,
  ...over,
});

interface Harness {
  exec: LocalExecutor;
  sent: Array<Record<string, unknown>>;
  asked: string[];
}

function harness(workspace: string, answer: 'allow' | 'deny' = 'allow', over: Partial<ApprovalPolicy> = {}): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const ws = { sendReliable: async (p: Record<string, unknown>) => { sent.push(p); return true; } } as unknown as WsClient;
  const exec = new LocalExecutor({
    ws,
    getToken: async () => null,
    baseUrl: 'https://mao.etarch.cn/api',
    workspace,
    // 交互式场景（TUI/REPL）：stdout+stdin 都是 TTY，审批走 askApproval。
    policy: policy({ stdoutIsTty: true, stdinIsTty: true, ...over }),
    askApproval: async (req) => {
      asked.push(req.description);
      return answer;
    },
  });
  return { exec, sent, asked };
}

async function runShell(h: Harness, requestId: string, args: Record<string, unknown>, workspace: string): Promise<Record<string, unknown>> {
  await h.exec.handleEvent({
    type: 'tool_execute',
    sessionId: SESSION_ID,
    data: { requestId, toolName: 'shell', arguments: JSON.stringify(args), workspace, needApproval: true },
  });
  const msg = h.sent.find((m) => m.type === 'tool_result' && m.requestId === requestId) as { result: string } | undefined;
  if (!msg) throw new Error(`no tool_result for ${requestId}`);
  return JSON.parse(msg.result) as Record<string, unknown>;
}

let workspaces: string[] = [];

function tempWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-shell-ws-')));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
  workspaces = [];
  fs.rmSync(resolveRuntimeDir(SESSION_ID), { recursive: true, force: true });
});

describe('shell approval is re-checked for every action', () => {
  it('asks again for a reused session and for write_stdin', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const workspace = tempWorkspace();
    const h = harness(workspace);

    const first = await runShell(h, 'sh-1', { command: 'echo one', keep_session: true }, workspace);
    const shellSession = String(first.session_id);
    expect(shellSession).toMatch(/^sh-/);
    expect(String(first.output)).toContain('one');

    const second = await runShell(h, 'sh-2', {
      command: 'echo two', session_id: shellSession, keep_session: true,
    }, workspace);
    expect(String(second.output)).toContain('two');

    const third = await runShell(h, 'sh-3', {
      action: 'write_stdin', session_id: shellSession, input: 'echo three',
    }, workspace);
    expect(String(third.output)).toContain('three');

    // 首次批准不得解锁后续命令：每个 exec / write_stdin 各问一次。
    expect(h.asked).toEqual(['echo one', 'echo two', 'echo three']);
    await h.exec.close(SESSION_ID);
  }, 60_000);

  it('refuses a denied command on an already approved session', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const workspace = tempWorkspace();
    const h = harness(workspace);
    const first = await runShell(h, 'sh-1', { command: 'echo hi', keep_session: true }, workspace);
    const shellSession = String(first.session_id);

    await h.exec.handleEvent({
      type: 'tool_execute',
      sessionId: SESSION_ID,
      data: {
        requestId: 'sh-2',
        toolName: 'shell',
        arguments: JSON.stringify({ action: 'write_stdin', session_id: shellSession, input: 'mkfs.ext4 /dev/sda1' }),
        workspace,
        needApproval: true,
      },
    });
    const err = h.sent.find((m) => m.type === 'tool_error' && m.requestId === 'sh-2') as { error: string };
    expect(err.error).toMatch(/默认拒绝清单/);
    expect(h.sent.some((m) => m.type === 'tool_result' && m.requestId === 'sh-2')).toBe(false);
    // deny-list 属于硬门禁，不会退化成「问用户」。
    expect(h.asked).toEqual(['echo hi']);
    await h.exec.close(SESSION_ID);
  }, 60_000);

  it('reports user denial instead of running the command', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const workspace = tempWorkspace();
    const h = harness(workspace, 'deny');
    const marker = path.join(workspace, 'should-not-exist.txt');
    const result = await runShell(h, 'sh-1', { command: `touch ${marker}` }, workspace);
    expect(result.exit_code).toBe(-1);
    expect(String(result.output)).toContain('User denied command execution.');
    expect(fs.existsSync(marker)).toBe(false);
    await h.exec.close(SESSION_ID);
  }, 60_000);

  it('rejects a workdir outside the workspace before spawning bash', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const workspace = tempWorkspace();
    const h = harness(workspace);
    const result = await runShell(h, 'sh-1', { command: 'pwd', workdir: '/etc' }, workspace);
    expect(String(result.error)).toMatch(/拒绝访问工作区外路径/);
    await h.exec.close(SESSION_ID);
  }, 60_000);
});
