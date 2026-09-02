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
import { handleEditFile, handleReadFile, handleWriteFile } from './tools/files';
import { handleGlobSearch, handleGrepSearch } from './tools/search';
import { createCliShellRuntime, type LocalShellRuntime } from './tools/shell';
import { McpManager, parseMcpToolName, type McpServerSpec } from './tools/mcp';
import { syncSkills } from './skills';

export type ApprovalChoice = 'allow' | 'deny' | 'always';

export interface LocalExecutorOptions {
  ws: WsClient;
  getToken: () => Promise<string | null>;
  baseUrl: string;
  workspace: string;
  policy: ApprovalPolicy;
  askApproval?: (req: ApprovalRequest, reason: string) => Promise<ApprovalChoice>;
  onApprovalDenied?: () => void;
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

  constructor(private readonly opts: LocalExecutorOptions) {}

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
    const delegatedToShell = toolName === 'shell';
    if (decision.action === 'ask' && !delegatedToShell) {
      const choice = await this.ask(req, decision.reason);
      if (choice === 'always') recordAlwaysAllow(this.opts.policy, req);
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      if (choice === 'deny') {
        await this.failTool(sessionId, requestId, '用户拒绝执行该工具');
        this.opts.onApprovalDenied?.();
        return;
      }
    } else if (needApproval || decision.action === 'ask') {
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
    }

    const result = await this.runTool(toolName, args, sessionId, workspace, req);
    const payload = persistToolResult(sessionId, requestId, result);
    const sent = await this.opts.ws.sendReliable({ type: 'tool_result', sessionId, requestId, result: payload });
    if (!sent) {
      console.error(`Failed to send tool result session=${sessionId} requestId=${requestId}`);
    }
  }

  private async ask(req: ApprovalRequest, reason: string): Promise<ApprovalChoice> {
    if (this.opts.askApproval) return this.opts.askApproval(req, reason);
    return (await defaultAsk(formatApprovalPrompt(req, reason))) ? 'allow' : 'deny';
  }

  private async runTool(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: number,
    workspace: string,
    req: ApprovalRequest,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'shell':
        return this.runShell(args, sessionId, workspace, req);
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
  ): Promise<Record<string, unknown>> {
    if (!this.shell) this.shell = createCliShellRuntime();
    return this.shell.handle(args, {
      conversationId: sessionId,
      workspace,
      needApproval: true,
      approve: (description) => this.approveShellText(req, description),
    });
  }

  private async approveShellText(req: ApprovalRequest, description: string): Promise<boolean> {
    const stepReq: ApprovalRequest = {
      ...req,
      args: { ...req.args, command: description },
      description,
    };
    const decision = evaluateApproval(stepReq, this.opts.policy);
    if (decision.action === 'allow') return true;
    if (decision.action === 'deny') {
      process.stderr.write(`${decision.reason}\n`);
      if (decision.exitApproval) this.opts.onApprovalDenied?.();
      return false;
    }
    const choice = await this.ask(stepReq, decision.reason);
    if (choice === 'always') recordAlwaysAllow(this.opts.policy, stepReq);
    if (choice === 'deny') {
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
