import readline from 'node:readline';
import type { WsClient } from '../ws/ws-client';
import {
  canPrompt,
  evaluateApproval,
  formatApprovalPrompt,
  recordAlwaysAllow,
  type ApprovalPolicy,
  type ApprovalRequest,
} from './approval';
import { isWorkspaceWithin } from './sandbox';
import { persistToolResult } from './truncate';
import { handleEditFile, handleReadFile, handleWriteFile, handleWriteLocalTextFile } from './tools/files';
import { handleGlobSearch, handleGrepSearch } from './tools/search';
import { createCliShellRuntime, type LocalShellRuntime } from './tools/shell';
import { McpManager, parseMcpToolName, type McpServerSpec } from './tools/mcp';
import { syncSkills } from './skills';

export type ApprovalChoice = 'allow' | 'deny' | 'always';

/** 投票后等回声：5s 未到且连接在线则重发同一帧，最多 2 次（技术方案 2026-11-06 §4.5-6）。 */
export const APPROVAL_ECHO_RETRY_MS = 5000;
export const APPROVAL_ECHO_MAX_RETRIES = 2;
/** 已完成决策的 requestId 记录上限（shell 复用一个 requestId，跨请求淘汰即可）。 */
const APPROVAL_DECIDED_LIMIT = 200;

export interface LocalExecutorOptions {
  ws: WsClient;
  getToken: () => Promise<string | null>;
  baseUrl: string;
  workspace: string;
  policy: ApprovalPolicy;
  askApproval?: (req: ApprovalRequest, reason: string) => Promise<ApprovalChoice>;
  onApprovalDenied?: () => void;
  /**
   * 多端审批：本地选择确定后的收尾（关模态 + 让 requestApproval 解挂）。
   * chat.ts 里接到 Ink 的 deliverApproval；无 Ink（readline / 打印模式）时省略即可。
   */
  deliverApproval?: (requestId: string, choice: ApprovalChoice) => void;
}

class ArgumentsParseError extends Error {}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ArgumentsParseError(`工具参数不是合法 JSON，已拒绝执行：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ArgumentsParseError('工具参数必须是 JSON 对象，已拒绝执行');
    }
    return parsed as Record<string, unknown>;
  }
  if (raw == null) return {};
  throw new ArgumentsParseError(`工具参数类型非法（${typeof raw}），已拒绝执行`);
}

function toolDescription(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'shell') {
    // 审批文本必须是真正会交给 bash 的那段：exec 是 command，write_stdin 是 input。
    const text = args.action === 'write_stdin' ? args.input : args.command;
    if (typeof text === 'string') return text;
  }
  if (typeof args.path === 'string') return args.path;
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return toolName;
  }
}

async function defaultAsk(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt + '> ', resolve));
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

export class LocalExecutor {
  private shell: LocalShellRuntime | null = null;
  private readonly mcp = new McpManager();
  private closed = false;
  /** 服务端 connected 帧声明的审批中继能力；旧后端 / 未连接为 false（投票后立即本地放行）。 */
  private approvalRelaySupported = false;
  /** requestId → sessionId：按键后的投票要用（onToolExecute 期间登记）。 */
  private readonly approvalSessions = new Map<string, number>();
  /** requestId → resolved 回声的收尾函数（等回声期间）。 */
  private readonly approvalEchoWaiters = new Map<string, (choice: ApprovalChoice) => void>();
  /** requestId → 回声重发定时器。 */
  private readonly approvalResendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 已完成多端决策（含远端直接决策）的 requestId：shell 后续动作只在本地判定，不再投票。 */
  private readonly approvalDecided = new Set<string>();
  /** 回声先到、本地还没走到 ask() 时暂存，ask() 时取用。 */
  private readonly approvalRemoteChoices = new Map<string, ApprovalChoice>();

  constructor(private readonly opts: LocalExecutorOptions) {}

  /** 服务端能力位（connected 帧）同步：false = 旧后端 / 未连接。 */
  setApprovalRelaySupported(supported: boolean): void {
    this.approvalRelaySupported = supported;
  }

  async handleEvent(evt: { type: string; sessionId: number | null; data: Record<string, unknown> | null }): Promise<void> {
    if (this.closed || evt.sessionId == null || !evt.data) return;
    const sessionId = evt.sessionId;
    const d = evt.data;
    try {
      if (evt.type === 'tool_execute') {
        await this.onToolExecute(sessionId, d);
      } else if (evt.type === 'skill_sync_required') {
        await this.onSkillSync(sessionId, d);
      } else if (evt.type === 'mcp_sync_required') {
        await this.onMcpSync(sessionId, d);
      } else if (evt.type === 'tool_approval_resolved') {
        this.onRemoteApprovalResolved(d);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (evt.type === 'tool_execute' && typeof d.requestId === 'string') {
        await this.failTool(sessionId, d.requestId, message);
      } else if (evt.type === 'skill_sync_required') {
        await this.opts.ws.sendReliable({
          type: 'skill_sync_done',
          sessionId,
          syncId: typeof d.syncId === 'string' ? d.syncId : null,
          success: false,
          error: message,
        });
      }
    }
  }

  async close(sessionId?: number): Promise<void> {
    this.closed = true;
    try {
      this.shell?.closeAll();
    } catch {
      // ignore
    }
    if (sessionId != null) await this.mcp.close(sessionId);
  }

  /**
   * 服务端下发的 workspace 只做收窄用：必须等于本地启动时校验并信任过的工作区，或位于其内部。
   * 否则服务端可以把 workspace 指到 `/` 从而绕过本地信任边界。
   */
  private resolveWorkspace(raw: unknown): string {
    const local = this.opts.workspace;
    if (typeof raw !== 'string' || raw.trim() === '') return local;
    if (isWorkspaceWithin(raw, local)) return raw;
    throw new Error(`拒绝服务端下发的工作区 ${raw}：不在本地工作区 ${local} 内`);
  }

  private async onToolExecute(sessionId: number, d: Record<string, unknown>): Promise<void> {
    const requestId = typeof d.requestId === 'string' ? d.requestId : '';
    if (!requestId) return;
    const toolName = String(d.toolName ?? '');
    let args: Record<string, unknown>;
    let workspace: string;
    try {
      args = parseArgs(d.arguments);
      workspace = this.resolveWorkspace(d.workspace);
    } catch (e) {
      await this.failTool(sessionId, requestId, e instanceof Error ? e.message : String(e));
      return;
    }
    const needApproval = Boolean(d.needApproval);
    const dangerReason = d.dangerReason != null ? String(d.dangerReason) : null;
    const req: ApprovalRequest = {
      toolName,
      args,
      workspace,
      needApproval,
      dangerReason,
      description: toolDescription(toolName, args),
      requestId,
    };
    const decision = evaluateApproval(req, this.opts.policy);
    if (decision.action === 'deny') {
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      await this.failTool(sessionId, requestId, decision.reason);
      if (decision.exitApproval) this.opts.onApprovalDenied?.();
      return;
    }
    // shell 的每个动作（exec / write_stdin）都在 runtime 内单独过一次策略，这里不重复提问，
    // 否则同一条命令会被问两遍；硬门禁（信任 + 默认拒绝清单）已在上面的 deny 分支生效。
    // 会在 runtime 里提问的 shell 不能在这里提前发 tool_approval：那一帧表示用户已经表态，
    // 发早了服务端会立刻取消「3 分钟无人处理」的审批提醒，人还停在确认提示上。
    const delegatedToShell = toolName === 'shell';
    const shellAction = typeof args.action === 'string' && args.action !== '' ? args.action : 'exec';
    const shellPrompts = delegatedToShell && (shellAction === 'exec' || shellAction === 'write_stdin');
    this.approvalSessions.set(requestId, sessionId);
    try {
      if (decision.action === 'ask' && !delegatedToShell) {
        const localChoice = await this.ask(req, decision.reason);
        const choice = await this.finalizeApproval(sessionId, requestId, localChoice);
        if (choice === 'always') recordAlwaysAllow(this.opts.policy, req);
        if (choice === 'deny') {
          await this.failTool(sessionId, requestId, '用户拒绝执行该工具');
          this.opts.onApprovalDenied?.();
          return;
        }
      } else if ((needApproval || decision.action === 'ask') && !shellPrompts) {
        await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      }

      const result = await this.runTool(toolName, args, sessionId, workspace, req, requestId);
      const payload = persistToolResult(sessionId, requestId, result);
      const sent = await this.opts.ws.sendReliable({ type: 'tool_result', sessionId, requestId, result: payload });
      if (!sent) {
        console.error(`Failed to send tool result session=${sessionId} requestId=${requestId}`);
      }
    } finally {
      this.approvalSessions.delete(requestId);
      this.clearApprovalResend(requestId);
      this.approvalEchoWaiters.delete(requestId);
      this.approvalRemoteChoices.delete(requestId);
    }
  }

  private async ask(req: ApprovalRequest, reason: string): Promise<ApprovalChoice> {
    const requestId = req.requestId;
    if (requestId) {
      // 远端决策早于本地提问：直接采用，不再弹模态（服务端已认领，也不需要再投票）
      const remote = this.takeRemoteChoice(requestId);
      if (remote != null) {
        this.markApprovalDecided(requestId);
        return remote;
      }
    }
    if (this.opts.askApproval) return this.opts.askApproval(req, reason);
    return (await defaultAsk(formatApprovalPrompt(req, reason))) ? 'allow' : 'deny';
  }

  /**
   * 本地按键（Ink 模态）后由宿主转来的投票：先上行，再等 resolved 回声；
   * 旧后端 / 断线直接按本地选择收尾。收尾动作是 deliverApproval（关模态 + 解挂 ask）。
   */
  async submitApprovalVote(requestId: string, choice: ApprovalChoice): Promise<void> {
    const sessionId = this.approvalSessions.get(requestId);
    if (sessionId == null || this.approvalDecided.has(requestId)) {
      // 无上下文 / 本请求已决策过（如 shell 后续动作）：本地选择直接生效
      this.opts.deliverApproval?.(requestId, choice);
      return;
    }
    const final = await this.raceVoteAndEcho(sessionId, requestId, choice);
    this.opts.deliverApproval?.(requestId, final);
  }

  /**
   * ask() 返回后的收口：远端先到以远端为准；本请求已经投过票（submit 路径）直接采用；
   * 其余（readline / 无模态层）在这里完成投票 + 等回声。
   */
  private async finalizeApproval(sessionId: number, requestId: string, localChoice: ApprovalChoice): Promise<ApprovalChoice> {
    const remote = this.takeRemoteChoice(requestId);
    if (remote != null) {
      this.markApprovalDecided(requestId);
      return remote;
    }
    if (this.approvalDecided.has(requestId)) return localChoice;
    const final = await this.raceVoteAndEcho(sessionId, requestId, localChoice);
    this.opts.deliverApproval?.(requestId, final);
    return final;
  }

  /** 上行投票并等待回声；不可用时按本地选择返回（旧后端 / 断线 = 单机离线，无人抢认领）。 */
  private async raceVoteAndEcho(sessionId: number, requestId: string, localChoice: ApprovalChoice): Promise<ApprovalChoice> {
    const approved = localChoice !== 'deny';
    const alwaysAllow = localChoice === 'always';
    const sent = await this.opts.ws.sendReliable({
      type: 'tool_approval',
      sessionId,
      requestId,
      approved,
      ...(alwaysAllow ? { alwaysAllow: true } : {}),
    });
    if (!sent || !this.approvalRelaySupported) {
      this.markApprovalDecided(requestId);
      return localChoice;
    }
    // 回声可能恰好在这一步之前先到（无等待者，已进 remoteChoices）：直接采用
    const early = this.takeRemoteChoice(requestId);
    if (early != null) {
      this.markApprovalDecided(requestId);
      return early;
    }
    const echoed = await new Promise<ApprovalChoice>((resolve) => {
      this.approvalEchoWaiters.set(requestId, resolve);
      this.scheduleApprovalResend(sessionId, requestId, approved, alwaysAllow);
    });
    this.markApprovalDecided(requestId);
    return echoed;
  }

  /** 服务端认领结果（含超时 / 中止的 null）：闭合等待者；早到或收尾帧按需转给模态收尾。 */
  private onRemoteApprovalResolved(d: Record<string, unknown>): void {
    const requestId = typeof d.requestId === 'string' ? d.requestId : '';
    if (!requestId) return;
    const approved = typeof d.approved === 'boolean' ? d.approved : null;
    const choice: ApprovalChoice | null = approved == null
      ? null
      : (approved ? (d.alwaysAllow === true ? 'always' : 'allow') : 'deny');
    const waiter = this.approvalEchoWaiters.get(requestId);
    if (waiter) {
      this.clearApprovalResend(requestId);
      this.approvalEchoWaiters.delete(requestId);
      waiter(choice ?? 'deny');
      return;
    }
    if (choice == null) {
      // 没有人工决策（超时 / 中止 / 通知收尾）：只按拒绝关闭可能开着的模态，不算远端决策
      this.opts.deliverApproval?.(requestId, 'deny');
      return;
    }
    if (this.approvalDecided.has(requestId)) return;
    this.markApprovalDecided(requestId);
    this.approvalRemoteChoices.set(requestId, choice);
    if (this.approvalRemoteChoices.size > APPROVAL_DECIDED_LIMIT) {
      const oldest = this.approvalRemoteChoices.keys().next();
      if (!oldest.done) this.approvalRemoteChoices.delete(oldest.value);
    }
    this.opts.deliverApproval?.(requestId, choice);
  }

  private takeRemoteChoice(requestId: string): ApprovalChoice | null {
    const choice = this.approvalRemoteChoices.get(requestId);
    if (choice == null) return null;
    this.approvalRemoteChoices.delete(requestId);
    return choice;
  }

  private markApprovalDecided(requestId: string): void {
    this.approvalDecided.add(requestId);
    if (this.approvalDecided.size > APPROVAL_DECIDED_LIMIT) {
      const oldest = this.approvalDecided.values().next();
      if (!oldest.done) this.approvalDecided.delete(oldest.value);
    }
    this.clearApprovalResend(requestId);
    this.approvalEchoWaiters.delete(requestId);
  }

  private clearApprovalResend(requestId: string): void {
    const timer = this.approvalResendTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.approvalResendTimers.delete(requestId);
  }

  private scheduleApprovalResend(sessionId: number, requestId: string, approved: boolean, alwaysAllow: boolean): void {
    const attempt = (left: number): void => {
      if (left <= 0) return;
      const timer = setTimeout(() => {
        this.approvalResendTimers.delete(requestId);
        if (!this.approvalEchoWaiters.has(requestId)) return;
        void this.opts.ws.sendReliable({
          type: 'tool_approval',
          sessionId,
          requestId,
          approved,
          ...(alwaysAllow ? { alwaysAllow: true } : {}),
        });
        attempt(left - 1);
      }, APPROVAL_ECHO_RETRY_MS);
      timer.unref?.();
      this.approvalResendTimers.set(requestId, timer);
    };
    attempt(APPROVAL_ECHO_MAX_RETRIES);
  }


  private async runTool(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: number,
    workspace: string,
    req: ApprovalRequest,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'shell':
        return this.runShell(args, sessionId, workspace, req, requestId);
      case 'read_file':
        return handleReadFile(args, workspace, sessionId);
      case 'write_file':
        return handleWriteFile(args, workspace, sessionId);
      case 'edit_file':
        return handleEditFile(args, workspace, sessionId);
      case 'glob_search':
        return handleGlobSearch(args, workspace, sessionId);
      case 'grep_search':
        return handleGrepSearch(args, workspace, sessionId);
      case 'write_local_text_file':
        // 服务端 dump_user_messages 委托：把消息原文写进会话 runtime 的 userMessages/ 目录
        // （无审批：落点固定为 Mao 自管目录，服务端下发时 needApproval=false）。
        return handleWriteLocalTextFile(args, sessionId);
      default: {
        const mcp = parseMcpToolName(toolName);
        if (mcp) {
          try {
            const result = await this.mcp.call(sessionId, mcp.serverName, mcp.toolName, args);
            return { result };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }
        return { error: `Unknown tool: ${toolName}` };
      }
    }
  }

  /**
   * 复用 shell 会话与 write_stdin 都会把新文本交给同一个 bash，因此每次动作都必须重新过策略：
   * 首次批准不得解锁后续命令（对齐 desktop ensureShellApproval）。
   */
  private async runShell(
    args: Record<string, unknown>,
    sessionId: number,
    workspace: string,
    req: ApprovalRequest,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.shell) this.shell = createCliShellRuntime();
    return this.shell.handle(args, {
      conversationId: sessionId,
      workspace,
      needApproval: true,
      approve: (description) => this.approveShellText(req, description, sessionId, requestId),
    });
  }

  private async approveShellText(
    req: ApprovalRequest,
    description: string,
    sessionId: number,
    requestId: string,
  ): Promise<boolean> {
    const stepReq: ApprovalRequest = {
      ...req,
      args: { ...req.args, command: description },
      description,
    };
    const decision = evaluateApproval(stepReq, this.opts.policy);
    if (decision.action === 'allow') {
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      return true;
    }
    if (decision.action === 'deny') {
      process.stderr.write(`${decision.reason}\n`);
      if (decision.exitApproval) this.opts.onApprovalDenied?.();
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      return false;
    }
    const choice = await this.ask(stepReq, decision.reason);
    const finalChoice = await this.finalizeApproval(sessionId, requestId, choice);
    if (finalChoice === 'always') recordAlwaysAllow(this.opts.policy, stepReq);
    if (finalChoice === 'deny') {
      this.opts.onApprovalDenied?.();
      return false;
    }
    return true;
  }

  private async onSkillSync(sessionId: number, d: Record<string, unknown>): Promise<void> {
    // syncId 必须回带：后端 handleSkillSyncDone 只认与 pending 相同的 syncId，缺失会走 60s 超时并判会话失败。
    const syncId = typeof d.syncId === 'string' ? d.syncId : null;
    const syncUrl = String(d.syncUrl ?? '');
    try {
      await syncSkills({
        sessionId,
        syncUrl,
        removed: d.removed,
        baseUrl: this.opts.baseUrl,
        token: await this.opts.getToken(),
      });
      await this.opts.ws.sendReliable({ type: 'skill_sync_done', sessionId, syncId, success: true });
    } catch (e) {
      await this.opts.ws.sendReliable({
        type: 'skill_sync_done',
        sessionId,
        syncId,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async onMcpSync(sessionId: number, d: Record<string, unknown>): Promise<void> {
    const syncId = typeof d.syncId === 'string' ? d.syncId : null;
    const servers = (Array.isArray(d.servers) ? d.servers : []) as McpServerSpec[];
    let workspace: string;
    try {
      workspace = this.resolveWorkspace(d.workspace);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.opts.ws.sendReliable({
        type: 'mcp_tools_report',
        sessionId,
        syncId,
        servers: servers.map((s) => ({ name: s.name, connected: false, tools: [], error: reason })),
      });
      return;
    }
    const reports = await this.mcp.sync(sessionId, servers, {
      approveSpawn: (server) => this.approveMcpSpawn(server, workspace),
    });
    await this.opts.ws.sendReliable({
      type: 'mcp_tools_report',
      sessionId,
      syncId,
      servers: reports,
    });
  }

  /** stdio MCP 会执行服务端指定的可执行文件，按变更类操作走同一套审批策略。 */
  private async approveMcpSpawn(server: McpServerSpec, workspace: string): Promise<{ allowed: boolean; reason: string }> {
    const commandLine = [server.command ?? '', ...(Array.isArray(server.args) ? server.args.map(String) : [])].join(' ').trim();
    const req: ApprovalRequest = {
      toolName: `mcp__${server.name}`,
      args: { command: commandLine },
      workspace,
      needApproval: true,
      dangerReason: `启动 MCP 本地进程：${commandLine}`,
      description: commandLine,
    };
    const decision = evaluateApproval(req, this.opts.policy);
    if (decision.action === 'allow') return { allowed: true, reason: decision.reason };
    if (decision.action === 'deny') {
      if (decision.exitApproval) this.opts.onApprovalDenied?.();
      return { allowed: false, reason: decision.reason };
    }
    if (!this.opts.askApproval && !canPrompt(this.opts.policy)) {
      return { allowed: false, reason: '需要审批但当前无法交互提问，已拒绝启动 MCP 进程' };
    }
    const choice = await this.ask(req, decision.reason);
    if (choice === 'always') recordAlwaysAllow(this.opts.policy, req);
    if (choice === 'deny') {
      this.opts.onApprovalDenied?.();
      return { allowed: false, reason: '用户拒绝启动该 MCP 进程' };
    }
    return { allowed: true, reason: '用户批准' };
  }

  private async failTool(sessionId: number, requestId: string, error: string): Promise<void> {
    await this.opts.ws.sendReliable({ type: 'tool_error', sessionId, requestId, error });
  }
}
