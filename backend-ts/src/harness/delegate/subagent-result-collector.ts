import type { AgentEventListener } from '../core/agent-event-listener.js';
import type { ChatUsage, ToolCall } from '../llm/chat-request.js';

export class SubAgentResultCollector implements AgentEventListener {
  private readonly contentBuilder: string[] = [];
  private readonly thinkingBuilder: string[] = [];
  totalUsage?: ChatUsage;
  completed = false;
  error?: unknown;
  toolCallCount = 0;

  onThinkingStart(): void {
    this.contentBuilder.length = 0;
    this.thinkingBuilder.length = 0;
  }

  onLlmStreamReset(): void {
    this.contentBuilder.length = 0;
    this.thinkingBuilder.length = 0;
    this.toolCallCount = 0;
  }

  onContentDelta(delta: string): void {
    if (delta) this.contentBuilder.push(delta);
  }

  onToolCallStart(_toolCall: ToolCall): void {
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
    return this.contentBuilder.join('');
  }

  getThinkingContent(): string | null {
    return this.thinkingBuilder.length > 0 ? this.thinkingBuilder.join('') : null;
  }
}
