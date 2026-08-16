import { harnessLog } from '../log.js';
import type { ApprovalRegistry } from '../approval/approval-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

export class LocalToolExecutor {
  constructor(
    private readonly sessionRegistry: LocalToolSessionRegistry,
    private readonly approvalRegistry: ApprovalRegistry,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly timeoutSeconds = 900,
  ) {}

  async execute(
    sessionId: number | null,
    toolName: string,
    argumentsJson: string,
    workspace: string | null | undefined,
    needApproval: boolean,
    dangerReason: string | null,
  ): Promise<string> {
    if (!(await this.sessionRegistry.isConnected(sessionId))) {
      harnessLog('warn', `No local client connected for session ${sessionId}`);
      return JSON.stringify({ error: 'Local client is not connected. Please ensure the desktop app is running and connected.' });
    }
    let pending: { requestId: string | null; future: Promise<string> } | null = null;
    let approvalRegistered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      pending = await this.sessionRegistry.sendToolRequest(sessionId, toolName, argumentsJson, workspace, needApproval, dangerReason);
      if (needApproval && pending.requestId != null && sessionId != null) {
        approvalRegistered = true;
        await Promise.resolve(this.approvalRegistry.register(sessionId, pending.requestId));
        await Promise.resolve(this.treeSignalPublisher.publishForSession(sessionId));
      }
      return await Promise.race([
        pending.future,
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.timeoutSeconds * 1000);
        }),
      ]);
    } catch (e) {
      const err = e as Error;
      if (err.message === 'timeout') {
        const timeoutMsg = `Local tool execution timed out after ${this.timeoutSeconds} seconds`;
        this.failPending(sessionId, pending, timeoutMsg);
        return JSON.stringify({ error: timeoutMsg });
      }
      const msg = 'Local tool execution failed: ' + err.message;
      this.failPending(sessionId, pending, msg);
      return JSON.stringify({ error: msg });
    } finally {
      // 不清理定时器的话，工具早已返回，事件循环仍会被挂住最长 timeoutSeconds
      if (timer) clearTimeout(timer);
      if (approvalRegistered && pending?.requestId && sessionId != null) {
        await Promise.resolve(this.approvalRegistry.unregister(sessionId, pending.requestId));
        await Promise.resolve(this.treeSignalPublisher.publishForSession(sessionId));
      }
    }
  }

  private failPending(
    sessionId: number | null,
    pending: { requestId: string | null } | null,
    error: string,
  ): void {
    if (sessionId != null && pending?.requestId != null) {
      this.sessionRegistry.completeToolRequestError(sessionId, pending.requestId, error);
    }
  }
}
