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
});
