import type { AgentEventListener } from '../harness/core/agent-event-listener.js';
import type { ChatUsage, ToolCall } from '../harness/llm/chat-request.js';
import { ToolResultSummarizer } from '../session/util/tool-result-summarizer.js';

export interface FeishuCardProgress {
  update(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[]): Promise<void>;
}

type ToolProgress = { name: string; argumentsJson: string | null; summary: string | null };

/**
 * Collects one LLM loop round and updates a Feishu progress card at round boundaries.
 *
 * 轮次只有工具调用时（如轮询登录状态），卡片回退展示上一轮最近的正文：
 * Agent 常把登录链接写在 content 里、再用 shell 轮询状态，不兜底的话用户看不到链接，
 * 任务看起来卡住（`carriedContent`）。
 */
export class FeishuCardProgressListener implements AgentEventListener {
  private round = 0;
  private readonly roundOffset: number;
  private content = '';
  /** 上一轮收尾时留下的正文：本轮没有 assistant content 时用它撑住卡片。 */
  private carriedContent = '';
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
    // 换行、空行经常单独成为一个 delta。累积时不能 trim，否则段末换行被吃掉，
    // 下一段会粘在上一句后面。询问态卡片会停在这份正文上，标题和列表就挤成一段。
    if (delta === '' || this.content.length >= CARD_TEXT_MAX) return;
    const next = this.content + delta;
    this.content = next.length <= CARD_TEXT_MAX ? next : next.slice(0, CARD_TEXT_MAX);
  }

  onToolCallStart(toolCall: ToolCall): void {
    const toolCallId = toolCall.id ?? `tool-${this.tools.size}`;
    const name = toolCall.function?.name ?? '未知工具';
    const previous = this.tools.get(toolCallId);
    this.tools.set(toolCallId, { name, argumentsJson: toolCall.function?.arguments ?? previous?.argumentsJson ?? null, summary: previous?.summary ?? null });
    // 工具触发即推送一次进度，长耗时工具执行期间用户可见"执行中"状态，而不是等结果返回。
    this.queue('RUNNING', this.displayContent(), this.toolValues(), this.round);
  }

  onToolCallArgsDelta(toolCallId: string, argumentsJson: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool == null) return;
    const before = formatToolLine(tool);
    tool.argumentsJson = argumentsJson;
    // 流式参数拼完后（尤其是 shell command）立刻刷新卡片，不必等整轮 LLM 流结束。
    if (formatToolLine(tool) !== before) {
      this.queue('RUNNING', this.displayContent(), this.toolValues(), this.round);
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
    this.queue('RUNNING', this.displayContent(), this.toolsList(), this.round);
    // 本轮正文留给下一轮兜底（如登录链接），随后清空本轮累积。
    if (this.content.trim() !== '') this.carriedContent = this.content;
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

  /**
   * 卡片正文：本轮有 assistant content 用本轮的，否则回退到上一轮最近一条。
   * 空串视为没有正文（只有换行的 delta 不兜底），保证纯工具轮仍显示上轮的链接/说明。
   */
  private displayContent(): string {
    return this.content.trim() === '' ? this.carriedContent : this.content;
  }

  private async safeUpdate(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[]): Promise<boolean> {
    try {
      await this.progress.update(status, round, trimCardText(content), tools);
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

const CARD_TEXT_MAX = 6000;

/** 只去掉整段首尾空白。内部换行必须保留，发出卡片时再调用。 */
function trimCardText(value: string): string {
  return value.trim().slice(0, CARD_TEXT_MAX);
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

/** 飞书工作区命令常以 `cd …/oc_<id> &&` 开头，前缀约 80 字；留出后面的实际命令。 */
const RUNNING_COMMAND_MAX = 240;

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
