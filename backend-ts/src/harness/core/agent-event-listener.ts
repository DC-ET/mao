import type { ChatRequest, ChatUsage, ToolCall } from '../llm/chat-request.js';

export interface AgentEventListener {
  onContentDelta(delta: string): void;
  onToolCallStart(toolCall: ToolCall): void;
  onToolCallResult(toolCallId: string, result: string): void;
  onMessageEnd(usage: ChatUsage): void;
  onRoundStart?(round: number): void;
  onRoundEnd?(round: number): void;
  onError(t: unknown): void;
  onContextWindow?(estimatedTokens: number, actualTokens: number): void;
  onCompactionStart?(type: string, messageCount: number, estimatedTokens: number): void;
  onCompactionEnd?(type: string, summaryTokens: number, savedTokens: number, durationMs: number): void;
  onCompactionPersisted?(
    eventId: number,
    triggerMode: string,
    prevBoundaryMsgId: number,
    boundaryMsgId: number,
    compactedMessageCount: number,
    summaryTokens: number,
    savedTokens: number,
    durationMs: number,
  ): void;
  onThinkingStart?(): void;
  onThinkingEnd?(): void;
  onLlmWaiting?(phase: string, elapsedSeconds: number): void;
  onLlmStreamReset?(): void;
  onLlmRetry?(reason: string, statusCode: number | null, attempt: number, maxRetries: number, delaySeconds: number): void;
  onToolCallArgsDelta?(toolCallId: string, argumentsJson: string): void;
  onThinkingDelta?(delta: string): void;
}

export class NoopAgentEventListener implements AgentEventListener {
  onContentDelta(): void {}
  onToolCallStart(): void {}
  onToolCallResult(): void {}
  onMessageEnd(): void {}
  onError(): void {}
}
