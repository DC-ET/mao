import { describe, expect, it, vi } from 'vitest';
import { CrashRecoveryRunner } from './crash-recovery-runner.js';
import { createAgentExecutor } from './agent-executor.js';
import { EnvironmentInfoProvider } from './environment-info-provider.js';
import { createWechatToolBridges } from '../../weixin/wechat-tool-bridge.js';

describe('CrashRecoveryRunner', () => {
  it('skips when no running sessions', async () => {
    const runner = new CrashRecoveryRunner(
      { selectByPhase: vi.fn(async () => []) } as never,
      {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      '/tmp/mao-runtime-test',
    );
    await runner.run();
  });

  it('submits recovery for stale running sessions', async () => {
    const submitted: Array<() => Promise<void>> = [];
    const sessionService = {
      cleanupIncompleteTail: vi.fn(async () => 1),
      updatePhase: vi.fn(),
    };
    const harness = { execute: vi.fn(async () => undefined) };
    const agentLoop = {
      registerCancelFlag: vi.fn(() => ({ get: () => false })),
      removeCancelFlag: vi.fn(),
    };
    const registry = { send: vi.fn() };
    const activityHeartbeat = { clear: vi.fn() };
    const taskTerminal = { finishExecution: vi.fn() };
    const llm = { selectById: vi.fn(async () => ({ supportsVision: 1 })), selectDefault: vi.fn() };
    const runner = new CrashRecoveryRunner(
      { selectByPhase: vi.fn(async () => [{ id: 4, userId: 7, modelId: 3, phase: 'RUNNING' }]) } as never,
      sessionService as never,
      taskTerminal as never,
      harness as never,
      agentLoop as never,
      registry as never,
      { record: vi.fn() } as never,
      activityHeartbeat as never,
      { selectBySessionId: vi.fn(async () => []) } as never,
      llm as never,
      '/tmp/mao-runtime-test',
      { submit: (fn) => { submitted.push(fn); } },
    );
    await runner.run();
    expect(submitted).toHaveLength(1);
    await submitted[0]();
    expect(harness.execute).toHaveBeenCalled();
    expect(taskTerminal.finishExecution).toHaveBeenCalledWith(4, 7, 'COMPLETED', expect.any(String));
    expect(activityHeartbeat.clear).toHaveBeenCalledWith(4);
  });

  it('deferred pass reuses the initial snapshot and does not re-scan the DB', async () => {
    const selectByPhase = vi.fn(async () => []);
    const submitted: Array<() => Promise<void>> = [];
    const sessionService = { cleanupIncompleteTail: vi.fn(async () => 0), updatePhase: vi.fn() };
    const harness = { execute: vi.fn(async () => undefined) };
    const agentLoop = {
      registerCancelFlag: vi.fn(() => ({ get: () => false })),
      removeCancelFlag: vi.fn(),
    };
    const runner = new CrashRecoveryRunner(
      { selectByPhase } as never,
      sessionService as never,
      { finishExecution: vi.fn() } as never,
      harness as never,
      agentLoop as never,
      { send: vi.fn() } as never,
      { record: vi.fn() } as never,
      { clear: vi.fn() } as never,
      { selectBySessionId: vi.fn(async () => []) } as never,
      { selectById: vi.fn(async () => ({ supportsVision: 1 })), selectDefault: vi.fn() } as never,
      '/tmp/mao-runtime-test',
      { submit: (fn) => { submitted.push(fn); } },
    );
    // 模拟蓝绿部署下 deferAll/skip 分支在初始扫描写入的快照。
    (runner as unknown as { deferredCandidates: unknown[] }).deferredCandidates = [
      { id: 9, userId: 3, modelId: 1, phase: 'RUNNING' },
    ] as never;
    await (runner as unknown as { runPass: (d: boolean) => Promise<void> }).runPass(true);
    // 延迟恢复必须复用快照（session 9），不得重新扫描 DB。
    expect(selectByPhase).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(1);
    await submitted[0]();
    expect(harness.execute).toHaveBeenCalled();
  });
});

describe('createAgentExecutor', () => {
  it('limits concurrency with a queue', async () => {
    const exec = createAgentExecutor(1);
    let running = 0;
    let max = 0;
    const waiters: Array<() => void> = [];
    const block = () => new Promise<void>((r) => waiters.push(r));
    exec.submit(async () => { running++; max = Math.max(max, running); await block(); running--; });
    exec.submit(async () => { running++; max = Math.max(max, running); running--; });
    await new Promise((r) => setTimeout(r, 10));
    expect(max).toBe(1);
    waiters[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(max).toBe(1);
  });

  it('expands past core when the queue is full then rejects', async () => {
    const exec = createAgentExecutor(1, 2, 1);
    let running = 0;
    const waiters: Array<() => void> = [];
    const block = () => {
      running++;
      return new Promise<void>((r) => waiters.push(() => { running--; r(); }));
    };
    exec.submit(block);
    exec.submit(block);
    exec.submit(block);
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    expect(() => exec.submit(block)).toThrow(/Agent executor rejected/);
    while (waiters.length > 0) {
      waiters.shift()!();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(running).toBe(0);
  });
});

describe('EnvironmentInfoProvider', () => {
  it('detects platform and session overlay', async () => {
    const provider = new EnvironmentInfoProvider();
    const detected = await provider.detect(null);
    expect(detected.platform).toMatch(/darwin|linux|win32/);
    const local = await provider.fromSessionOrDetect({
      executionMode: 'LOCAL', isGit: 1, platform: 'darwin', shellPath: 'zsh', osVersion: 'Darwin',
    } as never);
    expect(local.isGit).toBe(true);
    expect(local.shell).toBe('zsh');
  });
});

describe('createWechatToolBridges', () => {
  it('uploads and sends via real weixin services', async () => {
    const support = { resolveTarget: vi.fn(async () => ({ accountId: 'a', wxUserId: 'u' })) };
    const upload = {
      uploadImage: vi.fn(async () => ({ mediaId: 'm' })),
      uploadFile: vi.fn(async () => ({ mediaId: 'f' })),
    };
    const send = { sendImage: vi.fn(async () => true), sendFile: vi.fn(async () => true) };
    const accounts = { findByAccountId: vi.fn(async () => ({ accountId: 'a' })) };
    const tokens = { findByAccountId: vi.fn(async () => [{ wxUserId: 'u' }]) };
    const bridges = createWechatToolBridges(support as never, upload as never, send as never, accounts as never, tokens as never);
    expect(await bridges.toolSupport.resolveAccount(1, 7)).toEqual({ accountId: 'a', wxUserId: 'u' });
    const img = await bridges.uploadService.uploadImage('a', 'u', Buffer.from('x'));
    expect(JSON.parse(img.mediaId)).toEqual({ mediaId: 'm' });
    await bridges.sendService.sendImage('a', 'u', JSON.stringify({ mediaId: 'm' }));
    expect(send.sendImage).toHaveBeenCalled();
    expect(() => bridges.sendService.sendFile('a', 'u', 'not-json', 'f.bin')).toThrow(/无效/);
  });
});
