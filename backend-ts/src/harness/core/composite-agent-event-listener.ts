import type { ChatRequest, ChatUsage, ToolCall } from '../llm/chat-request.js';
import type { AgentEventListener } from './agent-event-listener.js';
import { harnessLog } from '../log.js';

type ListenerAction = (l: AgentEventListener) => void;

export class CompositeAgentEventListener implements AgentEventListener {
  private readonly listeners: AgentEventListener[];

  constructor(listeners: AgentEventListener[] | AgentEventListener[]) {
    const list = Array.isArray(listeners) ? listeners : [listeners];
    this.listeners = list.filter((l): l is AgentEventListener => l != null);
  }

  static of(...listeners: Array<AgentEventListener | null | undefined>): CompositeAgentEventListener {
    return new CompositeAgentEventListener(listeners.filter((l): l is AgentEventListener => l != null));
  }

  onContentDelta(delta: string): void {
    this.forEach('onContentDelta', (l) => l.onContentDelta(delta));
  }
  onToolCallStart(toolCall: ToolCall): void {
    this.forEach('onToolCallStart', (l) => l.onToolCallStart(toolCall));
  }
  onToolCallResult(toolCallId: string, result: string): void {
    this.forEach('onToolCallResult', (l) => l.onToolCallResult(toolCallId, result));
  }
  onMessageEnd(usage: ChatUsage): void {
    this.forEach('onMessageEnd', (l) => l.onMessageEnd(usage));
  }
  onRoundStart(round: number): void {
    this.forEach('onRoundStart', (l) => l.onRoundStart?.(round));
  }
  onRoundEnd(round: number): void {
    this.forEach('onRoundEnd', (l) => l.onRoundEnd?.(round));
  }
  onError(t: unknown): void {
    this.forEach('onError', (l) => l.onError(t));
  }
  onContextWindow(estimatedTokens: number, actualTokens: number): void {
    this.forEach('onContextWindow', (l) => l.onContextWindow?.(estimatedTokens, actualTokens));
  }
  onCompactionStart(type: string, messageCount: number, estimatedTokens: number): void {
    this.forEach('onCompactionStart', (l) => l.onCompactionStart?.(type, messageCount, estimatedTokens));
  }
  onCompactionEnd(type: string, summaryTokens: number, savedTokens: number, durationMs: number): void {
    this.forEach('onCompactionEnd', (l) => l.onCompactionEnd?.(type, summaryTokens, savedTokens, durationMs));
  }
  onCompactionPersisted(
    eventId: number, triggerMode: string, prevBoundaryMsgId: number, boundaryMsgId: number,
    compactedMessageCount: number, summaryTokens: number, savedTokens: number, durationMs: number,
  ): void {
    this.forEach('onCompactionPersisted', (l) => l.onCompactionPersisted?.(
      eventId, triggerMode, prevBoundaryMsgId, boundaryMsgId, compactedMessageCount, summaryTokens, savedTokens, durationMs));
  }
  onThinkingStart(): void {
    this.forEach('onThinkingStart', (l) => l.onThinkingStart?.());
  }
  onThinkingEnd(): void {
    this.forEach('onThinkingEnd', (l) => l.onThinkingEnd?.());
  }
  onToolCallArgsDelta(toolCallId: string, argumentsJson: string): void {
    this.forEach('onToolCallArgsDelta', (l) => l.onToolCallArgsDelta?.(toolCallId, argumentsJson));
  }
  onThinkingDelta(delta: string): void {
    this.forEach('onThinkingDelta', (l) => l.onThinkingDelta?.(delta));
  }
  onLlmWaiting(phase: string, elapsedSeconds: number): void {
    this.forEach('onLlmWaiting', (l) => l.onLlmWaiting?.(phase, elapsedSeconds));
  }
  onLlmStreamReset(): void {
    this.forEach('onLlmStreamReset', (l) => l.onLlmStreamReset?.());
  }
  onLlmRetry(reason: string, statusCode: number | null, attempt: number, maxRetries: number, delaySeconds: number): void {
    this.forEach('onLlmRetry', (l) => l.onLlmRetry?.(reason, statusCode, attempt, maxRetries, delaySeconds));
  }

  private forEach(method: string, action: ListenerAction): void {
    for (const listener of this.listeners) {
      try {
        action(listener);
      } catch (e) {
        harnessLog('warn', `CompositeAgentEventListener ${listener.constructor?.name} failed on ${method}: ${(e as Error).message}`);
      }
    }
  }
}
