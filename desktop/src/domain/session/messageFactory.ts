import type { ChatMessage } from '../../types/chat'

export function createOptimisticUserMessage(content: string, images?: string[]): ChatMessage {
  return {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content,
    createdAt: new Date().toLocaleString(),
    images: images && images.length > 0 ? images : undefined
  }
}

export function createAssistantPlaceholder(): ChatMessage {
  return {
    id: `msg_${Date.now()}_assistant`,
    role: 'assistant',
    content: '',
    createdAt: new Date().toLocaleString(),
    toolCalls: [],
    segments: []
  }
}

