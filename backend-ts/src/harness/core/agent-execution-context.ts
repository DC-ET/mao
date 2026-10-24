import type { ChatMessage, ChatRequest, ChatUsage, ContentPart, LlmModelConfig, ToolCall } from '../llm/chat-request.js';
import { emptyUsage } from '../llm/chat-request.js';
import type { CompactionConfig } from './compaction-config.js';
import type { LocalSkillRef } from '../skill/skill-document.js';
import type { SkillDocument } from '../skill/skill-document.js';
import type { MemoryHint } from '../../memory/types.js';
import type { Tool } from '../tool/tool.js';
import type { ToolAttachment } from './tool-attachment.js';
import type { ContextManifest } from './context-manifest.js';
import type { NoProgressNotice, NoProgressTail } from './no-progress-notice.js';
import type { McpWorkingSet } from '../mcp/workingset/mcp-working-set.js';
import type { CustomHttpToolCatalog } from './custom-http-tools-catalog.js';
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
  /**
   * 团队经验库（技术方案 2026-10-24）：Agent 开关启用且 CLOUD 会话时非 null，
   * 提示词据此渲染「团队经验库」路标节（非 null 必渲染；null 零输出，前缀缓存前提）。
   */
  experienceLibrary: { agentId: number } | null = null;
  /** 跨会话长期记忆（查询失败降级为 null，不产生注入段落）。 */
  memories: MemoryHint[] | null = null;
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
  /**
   * MCP 工作集结构化数据（技术方案 2026-10-18 §5.3）。全量模式 / 无 MCP server 时为 null，
   * 提示词 section 据此决定是否渲染（空值必须零输出，前缀缓存前提）。
   */
  mcpWorkingSet: McpWorkingSet | null = null;
  /**
   * 自定义 HTTP 工具目录（技术方案 2026-10-19 §5.2）。用户无启用工具 / 未装配时为 null，
   * 提示词 section 据此决定是否渲染（空值必须零输出，前缀缓存前提）。
   */
  customHttpTools: CustomHttpToolCatalog | null = null;
  /**
   * 系统提示 current-date 节的日期锚点：本会话首条现存用户消息的日期，跨天不重算
   * （技术方案 2026-10-12 §5.1）。无用户消息的会话回落服务器当天（shanghaiYmd）。
   * 真实日期推进由用户消息前的 `<date-change>` 标签承载，见 session-date-notice.ts。
   */
  sessionBaseYmd?: string | null;
  /**
   * 压缩边界前最后一条现存用户消息的日期：`applyHistory` 装载时解析，供跨天提示与
   * 窗口内第一条用户消息比较（跨过压缩边界也能判出日期变化）。窗口内无用户消息时为 null。
   */
  previousUserYmdBefore?: string | null;
  sessionSummary?: string | null;
  ephemeralSystemMessages: ChatMessage[] = [];
  lastPromptTokens = 0;
  contextAnchorMsgId = 0;
  messagesCoveredByAnchor = -1;
  /** 最近一次 buildRequest 估算的请求体字节数（与 manifest.requestBytes 同源）。 */
  lastRequestBytes = 0;
  /** 本次执行已因体积触发过一次压缩（防止压缩后仍超阈值时重复压缩）。 */
  payloadCompactionDone = false;
  /** 本次执行已发起的体积压缩次数（含失败），用于限制重试。 */
  payloadCompactionAttempts = 0;
  /** 达到重试上限的告警只打一次。 */
  payloadCompactionCapLogged = false;
  compactionConfig?: CompactionConfig | null;
  preparedRequest?: ChatRequest | null;
  /** 最近一次 buildRequest 同源产出的上下文构成清单（技术方案 5.2），随 onContextWindow 推送。 */
  contextManifest?: ContextManifest | null;
  pendingToolCalls?: ToolCall[] | null;
  totalUsage: ChatUsage = emptyUsage();
  currentRound = 0;
  cancelFlag?: AtomicBoolean | null;
  toolAttachments = new Map<string, ToolAttachment>();
  /**
   * 渲染期重放的提醒锚点（不落库）。执行开始 / 压缩重载时由历史扫描重建，运行中增量追加。
   * 只在 PromptEngine.buildRequest 的请求副本上生效，不进入 context.messages。
   */
  noProgressNotices: NoProgressNotice[] = [];
  /**
   * 历史扫描得到的尾部状态：执行开始 / 压缩重载时 seed guard，避免运行时与重放分叉。
   * 每轮结束不回写；只有 applyHistory 重算后才更新。
   */
  noProgressTail: NoProgressTail | null = null;
  /**
   * applyHistory 每次重算提醒锚点 / 尾部状态时自增。执行循环据此判断「压缩是否真的重载了
   * 历史」——不能用 tail 是否为 null 当哨兵：窗口内没有完整工具轮时 tail 恒为 null，
   * 压缩前后都为 null 会让 resetFrom 被跳过，运行时 streak 与重放结果分叉。
   */
  noProgressEpoch = 0;
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
