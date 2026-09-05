import type { ChatMessage, ChatRequest, ChatUsage, ContentPart, LlmModelConfig, ToolCall } from '../llm/chat-request.js';
import { emptyUsage } from '../llm/chat-request.js';
import type { CompactionConfig } from './compaction-config.js';
import type { LocalSkillRef } from '../skill/skill-document.js';
import type { SkillDocument } from '../skill/skill-document.js';
import type { Tool } from '../tool/tool.js';
import type { ToolAttachment } from './tool-attachment.js';
import { AtomicBoolean } from '../atomic-boolean.js';

export class AgentExecutionContext {
  sessionId?: number | null;
  userId?: number | null;
  /** 本次外部消息触发者；群聊会话的 userId 仍保留为 owner。 */
  executionUserId?: number | null;
  agentId?: number | null;
  projectKey?: string | null;
  systemPrompt?: string | null;
  experiences: string[] = [];
  agentName?: string | null;
  modelConfig?: LlmModelConfig | null;
  executionMode?: string | null;
  permissionLevel?: string | null;
  workspace?: string | null;
  isGit?: boolean | null;
  platform?: string | null;
  shellPath?: string | null;
  osVersion?: string | null;
  messages: ChatMessage[] = [];
  tools: Tool[] = [];
  availableSkillNames: string[] = [];
  availableSkillDocs = new Map<string, SkillDocument>();
  localUnsyncedSkills: LocalSkillRef[] = [];
  currentTimestamp?: string | null;
  sessionSummary?: string | null;
  ephemeralSystemMessages: ChatMessage[] = [];
  lastPromptTokens = 0;
  contextAnchorMsgId = 0;
  messagesCoveredByAnchor = -1;
  compactionConfig?: CompactionConfig | null;
  preparedRequest?: ChatRequest | null;
  pendingToolCalls?: ToolCall[] | null;
  totalUsage: ChatUsage = emptyUsage();
  currentRound = 0;
  cancelFlag?: AtomicBoolean | null;
  toolAttachments = new Map<string, ToolAttachment>();
  agentsMdContent?: string | null;

  addUserMessage(content: string | ContentPart[]): void {
    this.messages.push({ role: 'user', content });
  }

  addSystemMessage(content: string): void {
    // 使用 user role 避免许多模型不支持中途 system message 的问题；
    // 外裹 <system-notice> 标签帮助模型区分系统注入的通知与真实用户输入。
    const msg: ChatMessage = {
      role: 'user',
      content: `<system-notice>\n${content}\n</system-notice>`,
    };
    this.messages.push(msg);
    this.ephemeralSystemMessages.push(msg);
  }

  addAssistantMessage(content: string | null | undefined, toolCalls?: ToolCall[] | null, reasoningContent?: string | null): void {
    const hasToolCalls = toolCalls != null && toolCalls.length > 0;
    this.messages.push({
      role: 'assistant',
      content: content ?? '',
      toolCalls: hasToolCalls ? toolCalls : undefined,
      reasoningContent: reasoningContent != null && reasoningContent !== '' ? reasoningContent : undefined,
    });
  }

  addToolResult(toolCallId: string, result: string | null | undefined): void {
    this.messages.push({
      role: 'tool',
      toolCallId,
      content: result ?? '',
    });
  }

  registerToolAttachment(toolCallId: string | null | undefined, attachment: ToolAttachment | null | undefined): void {
    if (toolCallId != null && attachment != null) {
      this.toolAttachments.set(toolCallId, attachment);
    }
  }

  addUsage(usage: ChatUsage | null | undefined): void {
    if (!usage) return;
    this.totalUsage = {
      promptTokens: this.totalUsage.promptTokens + usage.promptTokens,
      completionTokens: this.totalUsage.completionTokens + usage.completionTokens,
      totalTokens: this.totalUsage.totalTokens + usage.totalTokens,
    };
  }

  clearPendingToolCalls(): void {
    this.pendingToolCalls = null;
  }
}
