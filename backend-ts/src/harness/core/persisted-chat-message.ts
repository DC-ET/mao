import type { ChatMessage } from '../llm/chat-request.js';
import { TokenEstimator } from './token-estimator.js';

export class PersistedChatMessage {
  constructor(
    readonly messageId: number,
    readonly persistedContentSnapshot: string,
    readonly chatMessage: ChatMessage,
  ) {}

  static from(messageId: number, chatMessage: ChatMessage, snapshot?: string): PersistedChatMessage {
    return new PersistedChatMessage(
      messageId,
      snapshot ?? TokenEstimator.contentToString(chatMessage.content),
      chatMessage,
    );
  }
}
