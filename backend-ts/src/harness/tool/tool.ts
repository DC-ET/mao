import type { ToolDescriptor } from './tool-descriptor.js';

/**
 * Tool interface matching Java default-method overloads:
 * execute(args)
 * execute(args, workspace)
 * execute(args, sessionId, workspace)
 * execute(args, sessionId, userId, workspace)
 * execute(args, sessionId, userId, workspace, agentId)
 */
export interface Tool {
  getName(): string;
  getDescription(): string;
  getInputSchema(): Record<string, unknown>;
  getOutputSchema(): Record<string, unknown>;
  getToolPrompt?(): string | null;
  /** 可选：静态描述元数据（来源/执行器）。缺省时由调用方按 builtin/server 兜底。 */
  getDescriptor?(): ToolDescriptor;
  execute(
    argumentsJson: string,
    a?: unknown,
    b?: unknown,
    c?: unknown,
    d?: unknown,
  ): string | Promise<string>;
}

export abstract class BaseTool implements Tool {
  abstract getName(): string;
  abstract getDescription(): string;
  abstract getInputSchema(): Record<string, unknown>;
  abstract getOutputSchema(): Record<string, unknown>;
  getToolPrompt(): string | null {
    return null;
  }

  getDescriptor(): ToolDescriptor {
    return { name: this.getName(), source: 'builtin', executor: 'server' };
  }

  execute(
    argumentsJson: string,
    a?: unknown,
    b?: unknown,
    c?: unknown,
    d?: unknown,
  ): string | Promise<string> {
    const argc = arguments.length;
    if (argc <= 1) {
      return this.executeWithUser(argumentsJson, null, null, null);
    }
    if (typeof a === 'string' || (argc === 2 && (a === null || a === undefined))) {
      return this.executeWithUser(argumentsJson, null, null, (a as string | null) ?? null);
    }
    if (argc === 3) {
      return this.executeWithUser(
        argumentsJson,
        (a as number | null) ?? null,
        null,
        (b as string | null) ?? null,
      );
    }
    // 4 参（sessionId, userId, workspace）与 5 参（+ agentId）同路：少传一个位置参数时
    // d 为 undefined，落成 null，与「无 agent 归属」同义。
    return this.executeWithUser(
      argumentsJson,
      (a as number | null) ?? null,
      (b as number | null) ?? null,
      (c as string | null) ?? null,
      (d as number | null) ?? null,
    );
  }

  /**
   * Java Tool defaults chain down in arity (5→4→3→2→1) to avoid StackOverflow.
   * Subclasses override the highest arity they need; lower arities fall through.
   *
   * agentId（技术方案 2026-11-24 D5）：ToolInvocation.agentId 按轮快照，经 dispatcher 的
   * routeAgentId 透传，供图片调用流水归因；不需要的工具忽略该参即可（基类实现即如此）。
   */
  protected executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    _userId: number | null,
    workspace: string | null,
    _agentId: number | null = null,
  ): string | Promise<string> {
    return this.executeWithSession(argumentsJson, sessionId, workspace);
  }

  protected executeWithSession(
    argumentsJson: string,
    _sessionId: number | null,
    workspace: string | null,
  ): string | Promise<string> {
    return this.executeWithWorkspace(argumentsJson, workspace);
  }

  protected executeWithWorkspace(argumentsJson: string, _workspace: string | null): string | Promise<string> {
    return this.executeImpl(argumentsJson);
  }

  protected executeImpl(_argumentsJson: string): string | Promise<string> {
    throw new Error('execute not implemented');
  }
}

export async function callTool(
  tool: Tool,
  argumentsJson: string,
  sessionId?: number | null,
  userId?: number | null,
  workspace?: string | null,
  agentId?: number | null,
): Promise<string> {
  if (sessionId !== undefined || userId !== undefined) {
    return await tool.execute(
      argumentsJson,
      sessionId ?? null,
      userId ?? null,
      workspace ?? null,
      agentId ?? null,
    );
  }
  if (workspace !== undefined) {
    return await tool.execute(argumentsJson, workspace);
  }
  return await tool.execute(argumentsJson);
}
