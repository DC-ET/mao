import { describe, expect, it, vi } from 'vitest';
import { LocalToolExecutor } from './local-tool-executor.js';
import type { ApprovalRegistry } from '../approval/approval-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

describe('LocalToolExecutor', () => {
  const approvalRegistry = {
    register: vi.fn(),
    unregister: vi.fn(),
    has: vi.fn(() => true),
  } as unknown as ApprovalRegistry & Record<string, ReturnType<typeof vi.fn>>;
  const treeSignalPublisher = { publishForSession: vi.fn() } as unknown as SessionTreeSignalPublisher & { publishForSession: ReturnType<typeof vi.fn> };

  function executor(registry: LocalToolSessionRegistry, timeoutSeconds: number) {
    return new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, timeoutSeconds);
  }

  it('returnsErrorWhenLocalClientIsDisconnected', async () => {
    const registry = { isConnected: vi.fn().mockResolvedValue(false) } as unknown as LocalToolSessionRegistry;
    const result = await executor(registry, 900).execute(7, 'shell', '{}', 'workspace', false, null);
    // 该文案经工具结果/摘要展示给用户，须中文（与 WS error 帧同一口径）
    expect(result).toContain('本地执行端未连接，请确保桌面客户端正在运行');
  });

  // 线上事故回归（2026-11-10 会话 2316）：帧投进了「半死连接」（readyState=OPEN 但执行端
  // 不处理该会话），既无 tool_approval 也无 tool_result。此前要干等满 timeoutSeconds（900s）
  // 才返回，用户观感就是会话卡死。现在 ack 窗口（远小于总超时）内无任何回应即快速失败。
  it('failsFastWhenNoExecutorAckArrivesInsteadOfWaitingFullTimeout', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      // 永不 resolve：模拟黑洞连接
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-blackhole', future: new Promise(() => {}) }),
      completeToolRequestError: vi.fn(),
      failAllForSession: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    // 第 6 参 ackTimeoutSeconds=1s，总超时 900s：若仍走总超时，下面会挂住
    const exec = new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, 900, null, 1);
    const started = Date.now();
    const result = await exec.execute(7, 'shell', '{}', 'workspace', false, null);
    expect(Date.now() - started).toBeLessThan(5000);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain('本地执行端未响应');
    // 必须收敛服务端 pending，否则桌面端迟到的结果会写进已放弃的请求
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(7, 'req-blackhole', expect.stringContaining('本地执行端未响应'));
  });

  it('doesNotStartAckTimerForApprovalRequests', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-ap', future: Promise.resolve('{"ok":true}') }),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    // 需审批的调用由审批链路兜底（卡片超时 / 升级通知），ack 窗口不应介入
    const exec = new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, 900, null, 1);
    await expect(exec.execute(7, 'shell', '{}', 'workspace', true, 'reason')).resolves.toBe('{"ok":true}');
    expect(registry.completeToolRequestError).not.toHaveBeenCalled();
  });

  it('ackTimeoutStillReturnsResultWhenItArrivesInTime', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      // 200ms 后回结果，晚于投递但早于 2s ack 窗口
      sendToolRequest: vi.fn().mockResolvedValue({
        requestId: 'req-slow',
        future: new Promise<string>((r) => setTimeout(() => r('{"ok":true}'), 200)),
      }),
      completeToolRequestError: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    const exec = new LocalToolExecutor(registry, approvalRegistry, treeSignalPublisher, 900, null, 2);
    await expect(exec.execute(7, 'shell', '{}', 'workspace', false, null)).resolves.toBe('{"ok":true}');
    expect(registry.completeToolRequestError).not.toHaveBeenCalled();
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
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-1', null, {
      toolName: 'shell', arguments: '{}', workspace: 'workspace', dangerReason: 'reason',
    });
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
    // timeoutSeconds=1 且未传 ackTimeoutSeconds：ack 窗口按 min(60, 1)=1s 收敛，
    // 于是 1s 内无任何回应即失败（不再干等到默认 900s）。
    const result = await executor(registry, 1).execute(7, 'shell', '{}', 'workspace', false, null);
    expect(result).toContain('本地执行端未响应');
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(7, 'req-timeout', expect.stringContaining('本地执行端未响应'));
    expect(registry.failAllForSession).not.toHaveBeenCalled();
  });

  it('approvalRequestsStillFailWithTheFullTimeoutWording', async () => {
    vi.clearAllMocks();
    const registry = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-ap-timeout', future: new Promise(() => {}) }),
      completeToolRequestError: vi.fn(),
      failAllForSession: vi.fn(),
    } as unknown as LocalToolSessionRegistry;
    // 需审批：ack 窗口不得介入，1s 后仍按总超时口径失败（审批链路由卡片超时兜底）
    const result = await executor(registry, 1).execute(7, 'shell', '{}', 'workspace', true, null);
    expect(result).toContain('timed out');
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(7, 'req-ap-timeout', 'Local tool execution timed out after 1 seconds');
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
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-inbox', null, {
      toolName: 'shell', arguments: '{}', workspace: 'workspace', dangerReason: 'reason',
    });
  });

  describe('审批升级外推', () => {
    function registryWith(requestId: string, future: Promise<string>) {
      return {
        isConnected: vi.fn().mockResolvedValue(true),
        sendToolRequest: vi.fn().mockResolvedValue({ requestId, future }),
        completeToolRequestError: vi.fn(),
      } as unknown as LocalToolSessionRegistry;
    }

    it('需要审批时在 register 之后、结果返回之前 await prepare，finally 再抑制', async () => {
      vi.clearAllMocks();
      const order: string[] = [];
      approvalRegistry.register.mockImplementation(async () => { order.push('register'); });
      approvalRegistry.has.mockImplementation(() => true);
      let resolveResult!: (value: string) => void;
      const future = new Promise<string>((resolve) => { resolveResult = resolve; });
      const notifier = {
        prepare: vi.fn(async () => { order.push('prepare'); return { id: 3 }; }),
        suppress: vi.fn(async () => undefined),
      };
      const exec = new LocalToolExecutor(
        registryWith('req-esc', future), approvalRegistry, treeSignalPublisher, 900,
      );
      exec.setEscalationNotifier(notifier);
      const pending = exec.execute(7, 'shell', '{}', 'workspace', true, 'reason');
      await vi.waitFor(() => expect(notifier.prepare).toHaveBeenCalledWith(7, 'req-esc'));
      expect(order.indexOf('register')).toBeLessThan(order.indexOf('prepare'));
      expect(notifier.suppress).not.toHaveBeenCalled();
      resolveResult('{"ok":true}');
      await pending;
      expect(notifier.suppress).toHaveBeenCalledWith({ id: 3 });
      approvalRegistry.register.mockReset();
    });

    it('插入返回时审批已摘掉则立刻抑制，不等工具结果', async () => {
      vi.clearAllMocks();
      approvalRegistry.has.mockImplementation(() => false);
      let commandFinished = false;
      let resolveResult!: (value: string) => void;
      const future = new Promise<string>((resolve) => { resolveResult = resolve; });
      const notifier = {
        prepare: vi.fn(async () => ({ id: 4 })),
        suppress: vi.fn(async () => { expect(commandFinished).toBe(false); }),
      };
      const exec = new LocalToolExecutor(
        registryWith('req-early', future), approvalRegistry, treeSignalPublisher, 900,
      );
      exec.setEscalationNotifier(notifier);
      const pending = exec.execute(7, 'shell', '{}', 'workspace', true, 'reason');
      await vi.waitFor(() => expect(notifier.suppress).toHaveBeenCalledTimes(1));
      expect(notifier.suppress).toHaveBeenCalledWith({ id: 4 });
      commandFinished = true;
      resolveResult('{"ok":true}');
      await pending;
      expect(notifier.suppress).toHaveBeenCalledTimes(2);
      approvalRegistry.has.mockImplementation(() => true);
    });

    it('超时且无人表态时由 finally 抑制', async () => {
      vi.clearAllMocks();
      approvalRegistry.has.mockImplementation(() => true);
      const notifier = {
        prepare: vi.fn(async () => ({ id: 5 })),
        suppress: vi.fn(async () => undefined),
      };
      const exec = new LocalToolExecutor(
        registryWith('req-timeout-esc', new Promise(() => {})), approvalRegistry, treeSignalPublisher, 1,
      );
      exec.setEscalationNotifier(notifier);
      const result = await exec.execute(7, 'shell', '{}', 'workspace', true, null);
      expect(result).toContain('timed out');
      expect(notifier.suppress).toHaveBeenCalledTimes(1);
      expect(notifier.suppress).toHaveBeenCalledWith({ id: 5 });
    });

    it('prepare 抛错时工具结果仍返回且不 suppress', async () => {
      vi.clearAllMocks();
      const notifier = {
        prepare: vi.fn(async () => { throw new Error('db down'); }),
        suppress: vi.fn(async () => undefined),
      };
      const exec = new LocalToolExecutor(
        registryWith('req-fail', Promise.resolve('{"ok":true}')), approvalRegistry, treeSignalPublisher, 900,
      );
      exec.setEscalationNotifier(notifier);
      await expect(exec.execute(7, 'shell', '{}', 'workspace', true, 'reason')).resolves.toBe('{"ok":true}');
      expect(notifier.suppress).not.toHaveBeenCalled();
    });

    it('不需要审批时不 prepare', async () => {
      vi.clearAllMocks();
      const notifier = {
        prepare: vi.fn(async () => ({ id: 6 })),
        suppress: vi.fn(async () => undefined),
      };
      const exec = new LocalToolExecutor(
        registryWith('req-free', Promise.resolve('{"ok":true}')), approvalRegistry, treeSignalPublisher, 900,
      );
      exec.setEscalationNotifier(notifier);
      await exec.execute(7, 'shell', '{}', 'workspace', false, null);
      expect(notifier.prepare).not.toHaveBeenCalled();
      expect(notifier.suppress).not.toHaveBeenCalled();
    });

    it('未注入 notifier 时不碰外推', async () => {
      vi.clearAllMocks();
      const exec = new LocalToolExecutor(
        registryWith('req-none', Promise.resolve('{"ok":true}')), approvalRegistry, treeSignalPublisher, 900,
      );
      await expect(exec.execute(7, 'shell', '{}', 'workspace', true, 'reason')).resolves.toBe('{"ok":true}');
      expect(approvalRegistry.has).not.toHaveBeenCalled();
    });
  });

  it('approvalHint 随 sendToolRequest 与 registry.register 透传（V135）', async () => {
    vi.clearAllMocks();
    const reg = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-hint', future: Promise.resolve('{"ok":true}') }),
    } as unknown as LocalToolSessionRegistry;
    const hint = { ruleType: 'SHELL_PREFIX' as const, ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' };
    await executor(null, reg).execute(7, 'shell', '{"command":"npm run build"}', 'workspace', true, null, hint);
    expect(reg.sendToolRequest).toHaveBeenCalledWith(7, 'shell', '{"command":"npm run build"}', 'workspace', true, null, hint);
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-hint', hint, {
      toolName: 'shell', arguments: '{"command":"npm run build"}', workspace: 'workspace', dangerReason: null,
    });
  });

  it('无 approvalHint 时 hint 传 null、上下文照常透传', async () => {
    vi.clearAllMocks();
    const reg = {
      isConnected: vi.fn().mockResolvedValue(true),
      sendToolRequest: vi.fn().mockResolvedValue({ requestId: 'req-nohint', future: Promise.resolve('{"ok":true}') }),
    } as unknown as LocalToolSessionRegistry;
    await executor(null, reg).execute(7, 'shell', '{}', 'workspace', true, 'reason');
    expect(reg.sendToolRequest).toHaveBeenCalledWith(7, 'shell', '{}', 'workspace', true, 'reason');
    expect(approvalRegistry.register).toHaveBeenCalledWith(7, 'req-nohint', null, {
      toolName: 'shell', arguments: '{}', workspace: 'workspace', dangerReason: 'reason',
    });
  });
});

});
