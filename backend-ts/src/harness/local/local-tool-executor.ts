import { harnessLog } from '../log.js';
import type { ApprovalRegistry } from '../approval/approval-registry.js';
import type { SessionTreeSignalPublisher } from '../approval/session-tree-signal-publisher.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';
import { LOCAL_CLIENT_OFFLINE_TOOL_ERROR } from './local-tool-session-registry.js';
import type { ApprovalHint } from '../approval/approval-hint.js';

/** 站内收件箱写入能力（可选注入；接口化避免 harness 反向依赖 inbox 域实现）。 */
export interface ApprovalInboxRecorder {
  /** userId 未知（LocalToolExecutor 无 userId 上下文）→ InboxService 内部按 session 兜底解析。 */
  recordApprovalPending(sessionId: number, requestId: string): Promise<void>;
  resolveApprovalPending(sessionId: number, requestId: string): Promise<void>;
}

/** 审批升级外推。窄接口，避免 harness 反向依赖通知实现。未注入时只写收件箱。 */
export interface ApprovalEscalationDelivery {
  id?: number;
}

export interface ApprovalEscalationNotifier {
  prepare(sessionId: number, requestId: string): Promise<ApprovalEscalationDelivery | null>;
  suppress(delivery: ApprovalEscalationDelivery | null): Promise<void>;
}

export class LocalToolExecutor {
  /**
   * @param timeoutSeconds 本地工具执行的总超时（秒）：执行端已确认接手后的命令运行上限。
   * @param inboxRecorder 审批待办的收件箱写入（可选）。
   * @param ackTimeoutSeconds 「执行端接手」ack 兜底窗口（秒）：无审批请求下发后，若执行端在
   *   此窗口内既没回 `tool_approval`（空表态）也没回结果，即判通道半死并立即失败，
   *   不再干等到 timeoutSeconds（默认 900s）。需远大于一次正常网络往返、远小于总超时。
   */
  constructor(
    private readonly sessionRegistry: LocalToolSessionRegistry,
    private readonly approvalRegistry: ApprovalRegistry,
    private readonly treeSignalPublisher: SessionTreeSignalPublisher,
    private readonly timeoutSeconds = 900,
    private readonly inboxRecorder?: ApprovalInboxRecorder | null,
    private readonly ackTimeoutSeconds = 60,
  ) {}

  private escalationNotifier: ApprovalEscalationNotifier | null = null;

  /**
   * 实际生效的 ack 窗口（秒）：ack 只用于「提前发现半死通道」，绝不能反过来
   * 把请求拖得比总超时更久，因此按两者较小值收敛（测试里 timeoutSeconds=1
   * 而 ackTimeoutSeconds 仍是默认 60 时同样安全）。
   */
  private get ackWindowSeconds(): number {
    return Math.min(this.ackTimeoutSeconds, this.timeoutSeconds);
  }

  /** 通知服务比本执行器晚装配，构造完成后再挂上。 */
  setEscalationNotifier(notifier: ApprovalEscalationNotifier | null): void {
    this.escalationNotifier = notifier;
  }

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
      return JSON.stringify({ error: LOCAL_CLIENT_OFFLINE_TOOL_ERROR });
    }
    let pending: { requestId: string | null; future: Promise<string> } | null = null;
    let approvalRegistered = false;
    let escalation: ApprovalEscalationDelivery | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let ackTimedOut = false;
    try {
      pending = await this.sessionRegistry.sendToolRequest(
        sessionId, toolName, argumentsJson, workspace, needApproval, dangerReason,
        ...(approvalHint ? [approvalHint] : []),
      );
      // 投递即失败（该设备当前没有可写连接）已在 registry 侧回错误 future，无需再等。
      if (pending.requestId != null && !needApproval) {
        // 无审批请求的 ack 兜底：桌面端/mao-agent 收到 tool_execute 后会先回一条
        // tool_approval（无需审批时是空表态）或直接执行。半死连接（readyState=OPEN
        // 但 LocalExecutor 不处理该会话）时两者都不会来，此前要干等满 timeoutSeconds
        // （默认 900s）才返回。这里给一个远小于超时预算的 ack 窗口，超时即判通道失效。
        // 与总超时定时器同起跑并取更早触发者，ack 只可能让结果来得更快，绝不会拖过总预算。
        const ackPromise = new Promise<'ack'>((resolve) => {
          ackTimer = setTimeout(() => { ackTimedOut = true; resolve('ack'); }, this.ackWindowSeconds * 1000);
        });
        await Promise.race([pending.future.then(() => 'ack' as const), ackPromise]);
        if (ackTimedOut && pending.requestId != null) {
          const msg = `本地执行端未响应（${this.ackWindowSeconds} 秒内无回应），已停止等待。请确认桌面客户端正在运行且未在后台被挂起，然后重试。`;
          this.failPending(sessionId, pending, msg);
          return JSON.stringify({ error: msg });
        }
        // ack 已到：清掉 ack 定时器，后续（含审批登记）照常走总超时竞速
        if (ackTimer) clearTimeout(ackTimer);
      }
      // 需审批的调用不设 ack 窗口（ack 在 needApproval=false 分支内），
      // 由审批链路兜底：卡片超时 / 升级通知 / failAllFor*。
      if (needApproval && pending.requestId != null && sessionId != null) {
        approvalRegistered = true;
        // hint 随签存入 registry（V135）：alwaysAllow 回包时按 requestId 取回服务端自己生成的 hint；
        // 本 finally 与 handleToolApproval 双 unregister 都会清 hint，保证恰好一次消费
        await Promise.resolve(this.approvalRegistry.register(
          sessionId,
          pending.requestId,
          approvalHint ?? null,
          {
            toolName,
            arguments: argumentsJson ?? '{}',
            workspace: workspace ?? '',
            dangerReason: dangerReason ?? null,
          },
        ));
        await Promise.resolve(this.treeSignalPublisher.publishForSession(sessionId));
        // 站内收件箱：审批待办（userId 由 InboxService 内部按 session 兜底解析，
        // LocalToolExecutor 无 userId 上下文）
        const requestId = pending.requestId;
        this.recordInbox(() => this.inboxRecorder?.recordApprovalPending(sessionId, requestId));
        // 必须先把升级行插入再等待。fire-and-forget 时人可能在提交前就点了批准，finally 抑制会扑空。
        if (this.escalationNotifier) {
          try {
            escalation = await this.escalationNotifier.prepare(sessionId, requestId);
            // 插入期间人已经点过：登记被 handleToolApproval 同步摘掉，而命令还要跑很久，不能留到 finally。
            if (escalation != null && !this.approvalRegistry.has(sessionId, requestId)) {
              try {
                await this.escalationNotifier.suppress(escalation);
              } catch (suppressError) {
                harnessLog('warn', `Failed to suppress approval escalation: sessionId=${sessionId}, requestId=${requestId}, error=${(suppressError as Error).message}`);
              }
            }
          } catch (e) {
            escalation = null;
            harnessLog('warn', `Failed to prepare approval escalation: sessionId=${sessionId}, requestId=${requestId}, error=${(e as Error).message}`);
          }
        }
      }
      // 总超时竞速：定时器与 ack 同起跑，谁先到都只会让结果更早，不会拖过总预算
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
      if (ackTimer) clearTimeout(ackTimer);
      if (approvalRegistered && pending?.requestId && sessionId != null) {
        await Promise.resolve(this.approvalRegistry.unregister(sessionId, pending.requestId));
        await Promise.resolve(this.treeSignalPublisher.publishForSession(sessionId));
        // 待办生命周期联动：批准 / 拒绝 / 超时 / 执行异常 / 断连统一在 finally 收敛，
        // 对应收件箱条目自动置已读（保留可查，不计未读徽标）。
        // 只挂这一处：handleToolApproval 的 unregister 不重复挂点，避免
        // 「已批准 → 命令仍在跑」窗口内双触发。
        const requestId = pending.requestId;
        // 超时 / 断连 / 执行异常，以及审批帧丢失时的兜底。人已经点过时上面可能抑制过一次，重复调用看到终态会跳过。
        // 收件箱仍只在这里置已读：它表示这次本地调用还没结束，升级通知表示人还没表态。
        if (this.escalationNotifier && escalation) {
          try {
            await this.escalationNotifier.suppress(escalation);
          } catch (e) {
            harnessLog('warn', `Failed to suppress approval escalation: sessionId=${sessionId}, requestId=${requestId}, error=${(e as Error).message}`);
          }
        }
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
