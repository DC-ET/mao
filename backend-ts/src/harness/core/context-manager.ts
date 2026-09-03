import type { ChatMessage, ChatRequest, LlmModelConfig } from '../llm/chat-request.js';
import type { CompactionConfig } from './compaction-config.js';
import type { CompactionService, SessionCompactionResult } from './compaction-service.js';
import type { TokenEstimator } from './token-estimator.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { PersistedChatMessage } from './persisted-chat-message.js';

export class ContextManager {
  constructor(
    private readonly tokenEstimator: TokenEstimator,
    private readonly compactionService: CompactionService,
  ) {}

  estimateTokens(messages: ChatMessage[]): number {
    return this.tokenEstimator.estimateMessages(messages);
  }

  estimateRequestTokens(request: ChatRequest): number {
    return this.tokenEstimator.estimateRequestTokens(request);
  }

  compactSession(
    sessionId: number | null,
    expectedOldBoundary: number,
    messages: PersistedChatMessage[],
    snapshotMessageIds: number[],
    normalRequest: ChatRequest,
    modelConfig: LlmModelConfig,
    config: CompactionConfig,
    listener: AgentEventListener | null,
    cancelFlag: { get(): boolean } | null,
    activeTokensHint?: number | null,
  ): Promise<SessionCompactionResult | null> {
    return this.compactionService.compactSession(
      sessionId, expectedOldBoundary, messages, snapshotMessageIds,
      normalRequest, modelConfig, config, listener, cancelFlag, activeTokensHint,
    );
  }

  prependSessionSummary(
    summary: string | null | undefined,
    incrementalMessages: ChatMessage[] | null,
    archiveHint?: string | null,
  ): ChatMessage[] {
    return this.compactionService.prependSessionSummary(summary, incrementalMessages, archiveHint);
  }
}
