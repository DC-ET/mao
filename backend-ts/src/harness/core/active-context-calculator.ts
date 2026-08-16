import type { ChatMessage, ChatRequest } from '../llm/chat-request.js';
import type { TokenEstimator } from './token-estimator.js';

export class ActiveContextCalculator {
  constructor(private readonly tokenEstimator: TokenEstimator) {}

  active(
    lastPromptTokens: number,
    contextAnchorMsgId: number,
    messagesAfterAnchor: ChatMessage[] | null | undefined,
    fullRequestFallback: ChatRequest | null | undefined,
  ): number {
    if (lastPromptTokens > 0 && contextAnchorMsgId > 0) {
      const delta = messagesAfterAnchor ?? [];
      return lastPromptTokens + this.tokenEstimator.estimateMessages(delta);
    }
    if (fullRequestFallback != null) {
      return this.tokenEstimator.estimateRequestTokens(fullRequestFallback);
    }
    return this.tokenEstimator.estimateMessages(messagesAfterAnchor ?? []);
  }

  activeFromMessageSuffix(
    lastPromptTokens: number,
    contextAnchorMsgId: number,
    allMessages: ChatMessage[] | null | undefined,
    messagesCoveredByAnchor: number,
    fullRequestFallback: ChatRequest | null | undefined,
  ): number {
    if (lastPromptTokens > 0 && contextAnchorMsgId > 0
      && allMessages != null && messagesCoveredByAnchor >= 0
      && messagesCoveredByAnchor <= allMessages.length) {
      const delta = allMessages.slice(messagesCoveredByAnchor);
      return lastPromptTokens + this.tokenEstimator.estimateMessages(delta);
    }
    if (fullRequestFallback != null) {
      return this.tokenEstimator.estimateRequestTokens(fullRequestFallback);
    }
    return this.active(lastPromptTokens, contextAnchorMsgId, null, null);
  }

  estimateMessages(messages: ChatMessage[]): number {
    return this.tokenEstimator.estimateMessages(messages);
  }

  estimateRequestTokens(request: ChatRequest): number {
    return this.tokenEstimator.estimateRequestTokens(request);
  }

  estimateText(text: string | null | undefined): number {
    return this.tokenEstimator.countTokens(text ?? '');
  }
}
