import type { AgentEventListener } from '../harness/core/agent-event-listener.js';
import type { ChatUsage, ToolCall } from '../harness/llm/chat-request.js';
import { ToolResultSummarizer } from '../session/util/tool-result-summarizer.js';

export interface FeishuCardProgress {
  update(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[]): Promise<void>;
}

type ToolProgress = { name: string; argumentsJson: string | null; summary: string | null };

/** Collects one LLM loop round and updates a Feishu progress card at round boundaries. */
export class FeishuCardProgressListener implements AgentEventListener {
  private round = 0;
  private readonly roundOffset: number;
  private content = '';
  private readonly tools = new Map<string, ToolProgress>();
  private pending: Promise<void> = Promise.resolve();

  /**
   * @param roundOffset 崩溃恢复/重试时，当前任务已完成的 LLM 轮数。
   *                    AgentLoop 仍从 1 计本趟循环，卡片展示 offset+loopRound。
   */
  constructor(private readonly progress: FeishuCardProgress, roundOffset = 0) {
    this.roundOffset = normalizeRoundOffset(roundOffset);
    this.round = this.roundOffset;
  }

  onRoundStart(round: number): void {
    this.round = this.displayRound(round);
  }

  onContentDelta(delta: string): void {
    this.content = trimCardText(`${this.content}${delta}`);
  }

  onToolCallStart(toolCall: ToolCall): void {
    const toolCallId = toolCall.id ?? `tool-${this.tools.size}`;
    const name = toolCall.function?.name ?? '未知工具';
    const previous = this.tools.get(toolCallId);
    this.tools.set(toolCallId, { name, argumentsJson: toolCall.function?.arguments ?? previous?.argumentsJson ?? null, summary: previous?.summary ?? null });
    // 工具触发即推送一次进度，长耗时工具执行期间用户可见"执行中"状态，而不是等结果返回。
    this.queue('RUNNING', this.content, this.toolValues(), this.round);
  }

  onToolCallArgsDelta(toolCallId: string, argumentsJson: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool == null) return;
    const before = formatToolLine(tool);
    tool.argumentsJson = argumentsJson;
    // 流式参数拼完后（尤其是 shell command）立刻刷新卡片，不必等整轮 LLM 流结束。
    if (formatToolLine(tool) !== before) {
      this.queue('RUNNING', this.content, this.toolValues(), this.round);
    }
  }

  onToolCallResult(toolCallId: string, result: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool == null) {
      this.tools.set(toolCallId, { name: `工具 ${toolCallId}`, argumentsJson: null, summary: trimCardText(result.replace(/\s+/g, ' ')).slice(0, 240) });
      return;
    }
    tool.summary = ToolResultSummarizer.summarize(tool.name, tool.argumentsJson, result)
      ?? trimCardText(result.replace(/\s+/g, ' ')).slice(0, 240);
  }

  onMessageEnd(_usage: ChatUsage): void {}

  onRoundEnd(round: number): void {
    this.round = this.displayRound(round);
    this.queue('RUNNING', this.content, this.toolsList(), this.round);
    this.content = '';
    this.tools.clear();
  }

  onError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Agent 执行异常';
    this.queue('FAILED', message);
  }

  async complete(finalContent: string): Promise<boolean> {
    await this.flush();
    return this.updateTerminal('COMPLETED', this.round, trimCardText(finalContent), []);
  }

  async cancel(interrupted = false): Promise<boolean> {
    await this.flush();
    const message = interrupted ? '已被下一条指令中断。' : '任务已取消。';
    return this.updateTerminal('CANCELLED', this.round, message, []);
  }

  async fail(message: string): Promise<boolean> {
    await this.flush();
    return this.updateTerminal('FAILED', this.round, trimCardText(message), this.toolValues());
  }

  private queue(status: 'RUNNING' | 'FAILED', content = this.content, tools = this.toolValues(), round = this.round): void {
    this.pending = this.pending.then(async () => { await this.safeUpdate(status, round, content, tools); });
  }

  private async safeUpdate(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[]): Promise<boolean> {
    try {
      await this.progress.update(status, round, content, tools);
      return true;
    } catch (error) {
      console.warn(`飞书进度卡片更新失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async updateTerminal(status: 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[]): Promise<boolean> {
    return this.safeUpdate(status, round, content, tools);
  }

  private toolValues(): string[] {
    return [...this.tools.values()].map((tool) => formatToolLine(tool));
  }

  private toolsList(): string[] {
    return this.toolValues();
  }

  private displayRound(loopRound: number): number {
    const n = Number.isFinite(loopRound) ? Math.max(0, Math.floor(loopRound)) : 0;
    return this.roundOffset + n;
  }

  private async flush(): Promise<void> {
    await this.pending;
  }
}

function trimCardText(value: string): string {
  return value.trim().slice(0, 6000);
}

function normalizeRoundOffset(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 当前任务已完成的 LLM 轮数：最后一条 USER 之后的 ASSISTANT 条数。
 * 崩溃恢复与失败重试用来把飞书卡片轮次接上，避免从 0/1 重计。
 */
export function countCompletedAgentRounds(messages: Array<{ role?: string | null }> | null | undefined): number {
  if (messages == null || messages.length === 0) return 0;
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'USER') start = i + 1;
  }
  let count = 0;
  for (let i = start; i < messages.length; i++) {
    if (messages[i].role === 'ASSISTANT') count++;
  }
  return count;
}

const RUNNING_COMMAND_MAX = 80;

function formatToolLine(tool: ToolProgress): string {
  if (tool.summary) return `${tool.name}：${tool.summary}`;
  const running = runningToolDetail(tool);
  return running ? `${tool.name}：${running}（执行中）` : `${tool.name}：执行中…`;
}

/** 执行中优先展示 shell 命令；其它工具复用摘要器的无结果预览（有具体参数时）。 */
function runningToolDetail(tool: ToolProgress): string | null {
  if (tool.name.toLowerCase() === 'shell') {
    const command = extractShellCommand(tool.argumentsJson);
    if (command) return `\`${escapeInlineCode(truncateCard(command, RUNNING_COMMAND_MAX))}\``;
  }
  const preview = ToolResultSummarizer.summarize(tool.name, tool.argumentsJson, null);
  if (preview == null || preview.trim() === '') return null;
  if (preview.toLowerCase() === tool.name.toLowerCase()) return null;
  if (GENERIC_RUNNING_LABELS.has(preview)) return null;
  return preview;
}

const GENERIC_RUNNING_LABELS = new Set([
  'Shell 命令',
  '读取 文件',
  '写入 文件',
  '编辑 文件',
]);

function extractShellCommand(argumentsJson: string | null): string | null {
  const args = parseArgsObject(argumentsJson);
  if (args == null) return null;
  const command = args.command;
  if (typeof command !== 'string') return null;
  const normalized = command.replace(/\s+/g, ' ').trim();
  return normalized === '' ? null : normalized;
}

function parseArgsObject(argumentsJson: string | null): Record<string, unknown> | null {
  if (argumentsJson == null || argumentsJson.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, "'");
}

function truncateCard(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
