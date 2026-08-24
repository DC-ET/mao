import readline from 'node:readline';
import type { WsClient } from '../ws/ws-client';
import { evaluateApproval, formatApprovalPrompt, type ApprovalPolicy, type ApprovalRequest } from './approval';
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

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function toolDescription(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'shell' && typeof args.command === 'string') return args.command;
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
        await this.opts.ws.sendReliable({ type: 'skill_sync_done', sessionId, success: false, error: message });
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

  private async onToolExecute(sessionId: number, d: Record<string, unknown>): Promise<void> {
    const requestId = typeof d.requestId === 'string' ? d.requestId : '';
    if (!requestId) return;
    const toolName = String(d.toolName ?? '');
    const args = parseArgs(d.arguments);
    const workspace = typeof d.workspace === 'string' && d.workspace ? d.workspace : this.opts.workspace;
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
    if (decision.action === 'ask') {
      const choice = this.opts.askApproval
        ? await this.opts.askApproval(req, decision.reason)
        : (await defaultAsk(formatApprovalPrompt(req, decision.reason)) ? 'allow' : 'deny');
      if (choice === 'always') {
        this.opts.policy.approveRules.push(`${req.toolName}:*`);
      }
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
      if (choice === 'deny') {
        await this.failTool(sessionId, requestId, '用户拒绝执行该工具');
        this.opts.onApprovalDenied?.();
        return;
      }
    } else if (needApproval) {
      await this.opts.ws.sendReliable({ type: 'tool_approval', sessionId, requestId });
    }

    const result = await this.runTool(toolName, args, sessionId, workspace);
    const payload = persistToolResult(sessionId, requestId, result);
    const sent = await this.opts.ws.sendReliable({ type: 'tool_result', sessionId, requestId, result: payload });
    if (!sent) {
      console.error(`Failed to send tool result session=${sessionId} requestId=${requestId}`);
    }
  }

  private async runTool(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: number,
    workspace: string,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'shell':
        return this.runShell(args, sessionId, workspace);
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

  private async runShell(args: Record<string, unknown>, sessionId: number, workspace: string): Promise<Record<string, unknown>> {
    if (!this.shell) this.shell = createCliShellRuntime();
    return this.shell.handle(args, {
      conversationId: sessionId,
      workspace,
      needApproval: false,
    });
  }

  private async onSkillSync(sessionId: number, d: Record<string, unknown>): Promise<void> {
    const syncUrl = String(d.syncUrl ?? '');
    try {
      await syncSkills({
        sessionId,
        syncUrl,
        removed: d.removed,
        baseUrl: this.opts.baseUrl,
        token: await this.opts.getToken(),
      });
      await this.opts.ws.sendReliable({ type: 'skill_sync_done', sessionId, success: true });
    } catch (e) {
      await this.opts.ws.sendReliable({
        type: 'skill_sync_done',
        sessionId,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async onMcpSync(sessionId: number, d: Record<string, unknown>): Promise<void> {
    const syncId = typeof d.syncId === 'string' ? d.syncId : null;
    const servers = (Array.isArray(d.servers) ? d.servers : []) as McpServerSpec[];
    const reports = await this.mcp.sync(sessionId, servers);
    await this.opts.ws.sendReliable({
      type: 'mcp_tools_report',
      sessionId,
      syncId,
      servers: reports,
    });
  }

  private async failTool(sessionId: number, requestId: string, error: string): Promise<void> {
    await this.opts.ws.sendReliable({ type: 'tool_error', sessionId, requestId, error });
  }
}
