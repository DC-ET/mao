import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 交互 REPL 的新建会话延迟到第一条消息：仅打开/退出不应留下空白会话。
 * 这里直接驱动 resolveSessionTarget 的决策分支（不启动 REPL）。
 */
const envKeys = ['HOME', 'USERPROFILE', 'MAO_BASE_URL'] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let home = '';

beforeEach(() => {
  saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-defer-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function loadChat() {
  return import('../src/commands/chat');
}

function makeCtx(overrides: { cfg?: Record<string, unknown>; resolved?: Record<string, unknown> } = {}) {
  const createSession = vi.fn(async (req: Record<string, unknown>) => ({ id: 99, ...req }));
  const rest = {
    listAgents: vi.fn(async () => [{ id: 1, name: 'default', isDefault: true }]),
    listActiveModels: vi.fn(async () => [{ id: 10, name: 'm1' }]),
    createSession,
    getSession: vi.fn(async (id: unknown) => ({ id: Number(id) })),
    listSessions: vi.fn(async () => []),
  };
  const cfg = {
    command: 'chat',
    agent: undefined,
    model: undefined,
    local: true,
    workspace: home,
    permissionLevel: undefined,
    resumeSessionId: undefined,
    continueLast: false,
    cloudProject: undefined,
    gitClone: undefined,
    gitBranch: undefined,
    print: false,
    ...overrides.cfg,
  };
  const resolved = {
    defaultAgentId: undefined,
    defaultModelId: undefined,
    lastSessionId: undefined,
    permissionLevel: 'READ_WRITE',
    ...overrides.resolved,
  };
  const ctx = {
    rest,
    cfg,
    resolved,
    baseUrl: 'https://mao.example.com/api',
    getToken: async () => null,
    logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  };
  return { ctx, rest, createSession };
}

describe('resolveSessionTarget（空白会话防护）', () => {
  it('交互模式新建：延迟创建，不调用 createSession', async () => {
    const { resolveSessionTarget } = await loadChat();
    const { ctx, createSession } = makeCtx();
    const target = await resolveSessionTarget(ctx as never, { deferCreate: true });
    expect(target.kind).toBe('new');
    expect(createSession).not.toHaveBeenCalled();
    if (target.kind === 'new') {
      expect(target.draft).toMatchObject({
        agentId: 1,
        agentName: 'default',
        executionMode: 'LOCAL',
        workspace: home,
      });
      expect(target.request).toMatchObject({ executionMode: 'LOCAL', source: 'cli' });
      // LOCAL 创建即绑定本机执行端（第一条消息落库时同样带上）
      expect(target.request.targetDeviceId).toBeTruthy();
      expect(target.request.targetDeviceName).toBeTruthy();
    }
  });

  it('打印模式新建：立即创建（马上要执行，不存在空白会话）', async () => {
    const { resolveSessionTarget } = await loadChat();
    const { ctx, createSession } = makeCtx({ cfg: { print: true } });
    const target = await resolveSessionTarget(ctx as never, { deferCreate: false });
    expect(target.kind).toBe('existing');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('--resume 指定会话：直接返回已存在会话，不创建', async () => {
    const { resolveSessionTarget } = await loadChat();
    const { ctx, createSession } = makeCtx({ cfg: { resumeSessionId: '42' } });
    const target = await resolveSessionTarget(ctx as never, { deferCreate: true });
    expect(target.kind).toBe('existing');
    if (target.kind === 'existing') expect(target.session.id).toBe(42);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('--continue 命中 lastSessionId：直接复用，不创建', async () => {
    const { resolveSessionTarget } = await loadChat();
    const { ctx, createSession } = makeCtx({
      cfg: { continueLast: true },
      resolved: { lastSessionId: 7 },
    });
    const target = await resolveSessionTarget(ctx as never, { deferCreate: true });
    expect(target.kind).toBe('existing');
    if (target.kind === 'existing') expect(target.session.id).toBe(7);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('延迟创建的草稿 banner 显示「新会话」而不是空 id', async () => {
    const { formatSessionBanner } = await import('../src/ui/welcome');
    const line = formatSessionBanner({ agentName: 'A', modelName: 'M', executionMode: 'LOCAL' });
    expect(line).toContain('新会话');
  });
});
