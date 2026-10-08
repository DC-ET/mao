import { harnessLog } from '../log.js';
import type { ApprovalRegistry } from '../approval/approval-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';
import type { ApprovalHint } from '../approval/approval-hint.js';

/** 站内收件箱写入能力（可选注入；接口化避免 harness 反向依赖 inbox 域实现）。 */
export interface ApprovalInboxRecorder {
  /** userId 未知（LocalToolExecutor 无 userId 上下文）→ InboxService 内部按 session 兜底解析。 */
  recordApprovalPending(sessionId: number, requestId: string): Promise<void>;
  resolveApprovalPending(sessionId: number, requestId: string): Promise<void>;
}

export class LocalToolExecutor {
  constructor(
    private readonly sessionRegistry: LocalToolSessionRegistry,
    private readonly approvalRegistry: ApprovalRegistry,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly timeoutSeconds = 900,
    private readonly inboxRecorder?: ApprovalInboxRecorder | null,
  ) {}

  async execute(
    sessionId: number | null,
    toolName: string,
    argumentsJson: string,
    workspace: string | null | undefined,
    needApproval: boolean,
    dangerReason: string | null,
    approvalHint: ApprovalHint | null = null,
  ): Promise<string> {
    if (!(await this.sessionRegistry.isConnected(sessionId))) {
      harnessLog('warn', `No local client connected for session ${sessionId}`);
      return JSON.stringify({ error: 'Local client is not connected. Please ensure the desktop app is running and connected.' });
    }
    let pending: { requestId: string | null; future: Promise<string> } | null = null;
    let approvalRegistered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      pending = await this.sessionRegistry.sendToolRequest(
        sessionId, toolName, argumentsJson, workspace, needApproval, dangerReason,
        ...(approvalHint ? [approvalHint] : []),
      );
      if (needApproval && pending.requestId != null && sessionId != null) {
        approvalRegistered = true;
        // hint 随签存入 registry（V135）：alwaysAllow 回包时按 requestId 取回服务端自己生成的 hint；
        // 本 finally 与 handleToolApproval 双 unregister 都会清 hint，保证恰好一次消费
        await Promise.resolve(this.approvalRegistry.register(
          sessionId, pending.requestId, ...(approvalHint ? [approvalHint] : []),
        ));
        await Promise.resolve(this.treeSignalPublisher.publishForSession(sessionId));
        // 站内收件箱：审批待办（userId 由 InboxService 内部按 session 兜底解析，
        // LocalToolExecutor 无 userId 上下文）
        const requestId = pending.requestId;
        this.recordInbox(() => this.inboxRecorder?.recordApprovalPending(sessionId, requestId));
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
        // 待办生命周期联动：批准 / 拒绝 / 超时 / 执行异常 / 断连统一在 finally 收敛，
        // 对应收件箱条目自动置已读（保留可查，不计未读徽标）。
        // 只挂这一处：handleToolApproval 的 unregister 不重复挂点，避免
        // 「已批准 → 命令仍在跑」窗口内双触发。
        const requestId = pending.requestId;
        this.recordInbox(() => this.inboxRecorder?.resolveApprovalPending(sessionId, requestId));
      }
    }
  }

  /**
   * 收件箱副作用统一入口：fire-and-forget + 全吞异常。
   * 本地工具执行链路绝不能因为收件箱写入失败而中断。
   */
  private recordInbox(fn: () => void | Promise<void>): void {
    try {
      void Promise.resolve()
        .then(fn)
        .catch((e) => {
          harnessLog('warn', `Inbox side effect failed: ${(e as Error).message}`);
        });
    } catch (e) {
      harnessLog('warn', `Inbox side effect threw synchronously: ${(e as Error).message}`);
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
