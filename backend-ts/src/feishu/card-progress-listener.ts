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
  private content = '';
  private readonly tools = new Map<string, ToolProgress>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly progress: FeishuCardProgress) {}

  onRoundStart(round: number): void {
    this.round = round;
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
    if (tool != null) tool.argumentsJson = argumentsJson;
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
    this.queue('RUNNING', this.content, this.toolsList(), round);
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
    return [...this.tools.values()].map((tool) => `${tool.name}：${tool.summary || '执行中…'}`);
  }

  private toolsList(): string[] {
    return this.toolValues();
  }

  private async flush(): Promise<void> {
    await this.pending;
  }
}

function trimCardText(value: string): string {
  return value.trim().slice(0, 6000);
}