import type { ChatMessage, ChatRequest, ContentPart, ToolCall, ToolDefinition } from '../llm/chat-request.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_TOKEN_ESTIMATE = 1000;

export class TokenEstimator {
  estimateRequestTokens(request: ChatRequest): number {
    let total = 0;
    if (request.messages) total += this.estimateMessages(request.messages);
    if (request.tools && request.tools.length > 0) total += this.estimateToolDefinitions(request.tools);
    return total;
  }

  estimateMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) total += this.estimateMessage(msg);
    return total;
  }

  estimateMessage(message: ChatMessage): number {
    let tokens = MESSAGE_OVERHEAD_TOKENS;
    if (message.role) tokens += this.countTokens(message.role);
    if (message.content != null) {
      tokens += this.countTokens(TokenEstimator.contentToString(message.content));
      tokens += this.countImagePartTokens(message.content);
    }
    if (message.toolCallId) tokens += this.countTokens(message.toolCallId);
    if (message.toolCalls) {
      for (const tc of message.toolCalls) tokens += this.estimateToolCall(tc);
    }
    return tokens;
  }

  private estimateToolCall(toolCall: ToolCall): number {
    let tokens = 7;
    if (toolCall.id) tokens += this.countTokens(toolCall.id);
    if (toolCall.function) {
      if (toolCall.function.name) tokens += this.countTokens(toolCall.function.name);
      if (toolCall.function.arguments) tokens += this.countTokens(toolCall.function.arguments);
    }
    return tokens;
  }

  estimateToolDefinitions(tools: ToolDefinition[]): number {
    let total = 0;
    for (const tool of tools) total += this.estimateToolDefinition(tool);
    total += 12;
    return total;
  }

  private estimateToolDefinition(tool: ToolDefinition): number {
    let tokens = 7;
    if (tool.type) tokens += this.countTokens(tool.type);
    if (tool.function) {
      const fn = tool.function;
      if (fn.name) tokens += this.countTokens(fn.name);
      if (fn.description) tokens += this.countTokens(fn.description);
      if (fn.parameters) {
        try {
          tokens += this.countTokens(JSON.stringify(fn.parameters));
        } catch {
          tokens += Object.keys(fn.parameters).length * 20;
        }
      }
    }
    return tokens;
  }

  private countImagePartTokens(content: unknown): number {
    if (!Array.isArray(content)) return 0;
    let images = 0;
    for (const item of content) {
      if (item && typeof item === 'object') {
        const type = (item as ContentPart).type ?? (item as Record<string, unknown>).type;
        if (type === 'image_url') images++;
      }
    }
    return images * IMAGE_TOKEN_ESTIMATE;
  }

  static contentToString(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      let sb = '';
      for (const item of content) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          if (o.type === 'text' && o.text != null) sb += String(o.text);
        }
      }
      return sb;
    }
    return String(content);
  }

  countTokens(text: string | null | undefined): number {
    if (text == null || text === '') return 0;
    const bytes = Buffer.byteLength(text, 'utf8');
    return Math.floor((bytes + 3) / 4);
  }
}
