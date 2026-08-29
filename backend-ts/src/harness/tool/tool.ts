import type { ToolDescriptor } from './tool-descriptor.js';

/**
 * Tool interface matching Java default-method overloads:
 * execute(args)
 * execute(args, workspace)
 * execute(args, sessionId, workspace)
 * execute(args, sessionId, userId, workspace)
 */
export interface Tool {
  getName(): string;
  getDescription(): string;
  getInputSchema(): Record<string, unknown>;
  getOutputSchema(): Record<string, unknown>;
  getToolPrompt?(): string | null;
  /** 可选：静态描述元数据（来源/执行器）。缺省时由调用方按 builtin/server 兜底。 */
  getDescriptor?(): ToolDescriptor;
  execute(argumentsJson: string, a?: unknown, b?: unknown, c?: unknown): string | Promise<string>;
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

  execute(argumentsJson: string, a?: unknown, b?: unknown, c?: unknown): string | Promise<string> {
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
    return this.executeWithUser(
      argumentsJson,
      (a as number | null) ?? null,
      (b as number | null) ?? null,
      (c as string | null) ?? null,
    );
  }

  /**
   * Java Tool defaults chain down in arity (4→3→2→1) to avoid StackOverflow.
   * Subclasses override the highest arity they need; lower arities fall through.
   */
  protected executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    _userId: number | null,
    workspace: string | null,
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
): Promise<string> {
  if (sessionId !== undefined || userId !== undefined) {
    return await tool.execute(argumentsJson, sessionId ?? null, userId ?? null, workspace ?? null);
  }
  if (workspace !== undefined) {
    return await tool.execute(argumentsJson, workspace);
  }
  return await tool.execute(argumentsJson);
}
