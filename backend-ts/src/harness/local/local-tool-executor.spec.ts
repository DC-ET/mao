import { describe, expect, it, vi } from 'vitest';
import { LocalToolExecutor } from './local-tool-executor.js';
import type { ApprovalRegistry } from '../approval/approval-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

describe('LocalToolExecutor', () => {
  const approvalRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as ApprovalRegistry & Record<string, ReturnType<typeof vi.fn>>;
  const treeSignalPublisher = { publishForSession: vi.fn() } as unknown as SessionTreeSignalPublisher & { publishForSession: ReturnType<typeof vi.fn> };

  function executor(registry: LocalToolSessionRegistry, timeoutSeconds: number) {
    return new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, timeoutSeconds);
  }

  it('returnsErrorWhenLocalClientIsDisconnected', async () => {
    const registry = { isConnected: vi.fn().mockResolvedValue(false) } as unknown as LocalToolSessionRegistry;
    const result = await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', false, null);
    expect(result).toContain('Local client is not connected');
  });

  it('returnsToolResultWhenRegistryFutureCompletes', async () => {
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-1', future: Promise.resolve('{"ok":true}') }),
      failAllForSession: vi.fn(),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const result = await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    expect(result).toBe('{"ok":true}');
    expect(registry.failAllForSession).not.toHaveBeenCalled();
    expect(registry.completeToolRequestError).not.toHaveBeenCalled();
  });

  it('returns a failure message that survives a JSON round trip', async () => {
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({
        requestId: 'req-1',
        future: Promise.reject(new Error('client said "no such \\path"')),
      }),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const raw = await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', false, null);
    const parsed = JSON.parse(raw) as { error: string };
    expect(parsed.error).toBe('Local tool execution failed: client said "no such \\path"');
  });

  it('registersAndUnregistersApprovalForApprovalRequests', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-1', future: Promise.resolve('{"ok":true}') }),
    } as unknown as LocalToolSessionRegistry;
    await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-1');
    expect(approvalRegistry.unregister).toHaveBeenCalledWith(7, 'req-1');
    expect(treeSignalPublisher.publishForSession).toHaveBeenCalledTimes(2);
  });

  it('doesNotRegisterApprovalForNonApprovalRequests', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-1', future: Promise.resolve('{"ok":true}') }),
    } as unknown as LocalToolSessionRegistry;
    await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', false, null);
    expect(approvalRegistry.register).not.toHaveBeenCalled();
    expect(approvalRegistry.unregister).not.toHaveBeenCalled();
    expect(treeSignalPublisher.publishForSession).not.toHaveBeenCalled();
  });

  it('unregistersApprovalEvenOnTimeout', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-timeout', future: new Promise(() => {}) }),
      completeToolRequestError: vi.fn(),
      failAllForSession: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const result = await executor(registry, 1).execute(7, 'shell', '{}', 'workspace', true, null);
    expect(result).toContain('timed out');
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(7, 'req-timeout', 'Local tool execution timed out after 1 seconds');
    expect(registry.failAllForSession).not.toHaveBeenCalled();
    expect(approvalRegistry.unregister).toHaveBeenCalledWith(7, 'req-timeout');
    expect(treeSignalPublisher.publishForSession).toHaveBeenCalledTimes(2);
  });

  it('returnsTimeoutErrorAndFailsOnlyThatRequest', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-timeout', future: new Promise(() => {}) }),
      completeToolRequestError: vi.fn(),
      failAllForSession: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const result = await executor(registry, 1).execute(7, 'shell', '{}', 'workspace', false, null);
    expect(result).toContain('timed out');
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(7, 'req-timeout', 'Local tool execution timed out after 1 seconds');
    expect(registry.failAllForSession).not.toHaveBeenCalled();
  });

  describe('收件箱写入（APPROVAL_PENDING / 联动置已读）', () => {
  function recorderSpy(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    return {
      recordApprovalPending: vi.fn(async () => undefined),
      resolveApprovalPending: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function executor(recorder: ReturnType<typeof recorderSpy> | null, reg: LocalToolSessionRegistry = registry('req-inbox')) {
    return new LocalToolExecutor(reg, approvalRegistry, treeSignalPublisher, 900, recorder as never);
  }

  function registry(requestId: string) {
    return {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId, future: Promise.resolve('{"ok":true}') }),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('审批注册后写入 APPROVAL_PENDING（userId 由 service 内部解析）', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy();
    await executor(recorder).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    await settle();
    // LocalToolExecutor 无 userId 上下文：只传 sessionId + requestId
    expect(recorder.recordApprovalPending).toHaveBeenCalledWith(7, 'req-inbox');
  });

  it('执行正常返回后联动置已读（四态统一收敛点）', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy();
    await executor(recorder).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    await settle();
    expect(recorder.resolveApprovalPending).toHaveBeenCalledWith(7, 'req-inbox');
  });

  it('置已读键与写入键一致（同 requestId 尾段，防两侧漂移）', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy();
    await executor(recorder).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    await settle();
    expect(recorder.resolveApprovalPending.mock.calls[0][1]).toBe(recorder.recordApprovalPending.mock.calls[0][1]);
  });

  it('超时后同样置已读（unregister 之后、finally 内）', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy();
    const hanging = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-timeout', future: new Promise(() => {}) }),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const result = await new LocalToolExecutor(
      hanging, approvalRegistry, treeSignalPublisher, 1, recorder as never,
    ).execute(7, 'shell', '{}', 'workspace', true, null);
    expect(result).toContain('timed out');
    await settle();
    expect(approvalRegistry.unregister).toHaveBeenCalledWith(7, 'req-timeout');
    expect(recorder.resolveApprovalPending).toHaveBeenCalledWith(7, 'req-timeout');
  });

  it('非审批请求不写收件箱、也不置已读', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy();
    await executor(recorder).execute(7, 'shell', '{}', 'workspace', false, null);
    await settle();
    expect(recorder.recordApprovalPending).not.toHaveBeenCalled();
    expect(recorder.resolveApprovalPending).not.toHaveBeenCalled();
  });

  it('收件箱写入失败不打断本地执行链路（异常全吞）', async () => {
    vi.clearAllMocks();
    const recorder = recorderSpy({
      recordApprovalPending: vi.fn(async () => { throw new Error('db down'); }),
      resolveApprovalPending: vi.fn(async () => { throw new Error('db down'); }),
    });
    await expect(executor(recorder).execute(7, 'shell', '{}', 'workspace', true, 'reason'))
      .resolves.toBe('{"ok":true}');
  });

  it('未注入 inboxRecorder 时行为与改造前一致（零影响）', async () => {
    vi.clearAllMocks();
    await expect(executor(null).execute(7, 'shell', '{}', 'workspace', true, 'reason'))
      .resolves.toBe('{"ok":true}');
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-inbox');
  });
});

});
