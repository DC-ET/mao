import type { AgentEventListener } from '../core/agent-event-listener.js';
import type { ChatUsage, ToolCall } from '../llm/chat-request.js';

export class SubAgentResultCollector implements AgentEventListener {
  private readonly contentBuilder: string[] = [];
  private readonly thinkingBuilder: string[] = [];
  private readonly seenToolCallIds = new Set<string>();
  totalUsage?: ChatUsage;
  completed = false;
  error?: unknown;
  toolCallCount = 0;

  onThinkingStart(): void {
    this.contentBuilder.length = 0;
    this.thinkingBuilder.length = 0;
  }

  onLlmStreamReset(): void {
    // 只清本轮文本缓冲。toolCallCount 是跨轮累计指标（快照/结果统计用），
    // 不能随整轮流重试归零；seenToolCallIds 保留后，重试轮重发的相同 id 也会自然去重
    this.contentBuilder.length = 0;
    this.thinkingBuilder.length = 0;
  }

  onContentDelta(delta: string): void {
    if (delta) this.contentBuilder.push(delta);
  }

  onToolCallStart(toolCall: ToolCall): void {
    if (toolCall.id && this.seenToolCallIds.has(toolCall.id)) return;
    if (toolCall.id) this.seenToolCallIds.add(toolCall.id);
    this.toolCallCount++;
    this.contentBuilder.length = 0;
  }

  onToolCallResult(_toolCallId: string, _result: string): void {}

  onMessageEnd(usage: ChatUsage): void {
    this.totalUsage = usage;
    this.completed = true;
  }

  onError(t: unknown): void {
    this.error = t;
    this.completed = true;
  }

  onThinkingDelta(delta: string): void {
    if (delta) this.thinkingBuilder.push(delta);
  }

  getResult(): string {
    return this.contentBuilder.join('').trim();
  }

  getThinkingContent(): string | null {
    return this.thinkingBuilder.length > 0 ? this.thinkingBuilder.join('') : null;
  }
}
