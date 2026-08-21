import type { ChatUsage, ContentPart, SessionTodo } from '../../domain/types.js';
import type { ToolCall } from '../../harness/llm/chat-request.js';
import type { StreamingWsRegistry } from './streaming-ws-registry.js';
import { mapToolToType } from '../activity/activity-type-mapper.js';
import { ToolResultSummarizer } from '../util/tool-result-summarizer.js';
import { FileChangeDiffUtil } from '../../harness/tool/file-change-diff-util.js';
import { ToolImageResultProcessor } from '../../harness/tool/tool-image-result-processor.js';
import { wsEvent } from './ws-event.js';

export interface AgentEventListener {
  onContentDelta(delta: string): void;
  onToolCallStart(toolCall: ToolCall): void;
  onToolCallResult(toolCallId: string, result: string): void;
  onMessageEnd(usage: ChatUsage): void;
  onError(t: unknown): void;
  onContextWindow?(estimatedTokens: number, actualTokens: number): void;
  onCompactionStart?(type: string, messageCount: number, estimatedTokens: number): void;
  onCompactionEnd?(type: string, summaryTokens: number, savedTokens: number, durationMs: number): void;
  onCompactionPersisted?(eventId: number, triggerMode: string, prevBoundaryMsgId: number, boundaryMsgId: number, compactedMessageCount: number, summaryTokens: number, savedTokens: number, durationMs: number): void;
  onThinkingStart?(): void;
  onThinkingEnd?(): void;
  onThinkingDelta?(delta: string): void;
  onLlmWaiting?(phase: string, elapsedSeconds: number): void;
  onLlmStreamReset?(): void;
  onLlmRetry?(reason: string, statusCode: number | null, attempt: number, maxRetries: number, delaySeconds: number): void;
  onToolCallArgsDelta?(toolCallId: string, argumentsDelta: string): void;
}

const TASK_TOOLS = new Set(['task_create', 'task_update', 'task_delete', 'task_list']);
const FILE_TOOLS = new Set(['write_file', 'edit_file']);

export interface WsListenerDeps {
  registry: StreamingWsRegistry;
  activityService: {
    record(sessionId: number, type: string, target: string | null, summary: string | null, extra: null, status: string, extra2: null): Promise<{ id: number }>;
  };
  activityHeartbeat: { touch(sessionId: number): void };
  sessionTodoMapper: { selectBySessionId(sessionId: number): Promise<SessionTodo[]> };
  sessionService: {
    updateContextTokens(sessionId: number, tokens: number): Promise<void>;
    updateRuntimeStatus?(sessionId: number, runtimeStatus: unknown | null): Promise<void>;
  };
}

export class WsStreamingEventListener implements AgentEventListener {
  private readonly toolCallInfo = new Map<string, [string, string | null]>();

  constructor(
    private readonly deps: WsListenerDeps,
    private readonly sessionId: number,
    private readonly userId: number,
    private readonly executionId: string,
    private readonly supportsVision: boolean,
  ) {}

  onContentDelta(delta: string): void {
    this.send('content_delta', { delta });
  }

  onToolCallStart(toolCall: ToolCall): void {
    const toolCallId = toolCall.id ?? '';
    const toolName = toolCall.function?.name ?? '';
    const args = toolCall.function?.arguments ?? null;
    const alreadySent = this.toolCallInfo.has(toolCallId);
    this.toolCallInfo.set(toolCallId, [toolName, args]);
    this.deps.registry.trackActiveToolCall(this.sessionId, this.executionId, toolCallId, toolName, args ?? '');
    if (alreadySent) return;
    this.send('tool_call_start', {
      tool_call_id: toolCallId,
      tool_name: toolName,
      arguments: toolCall.function?.arguments ?? '',
    });
  }

  onToolCallResult(toolCallId: string, result: string): void {
    this.deps.registry.completeActiveToolCall(this.sessionId, toolCallId);
    const info = this.toolCallInfo.get(toolCallId);
    this.toolCallInfo.delete(toolCallId);
    const toolName = info?.[0] ?? null;
    const argumentsJson = info?.[1] ?? null;
    const publicResult = FileChangeDiffUtil.stripPrivateDiff(result) ?? result;
    const processed = ToolImageResultProcessor.process(publicResult, this.supportsVision);
    const displayResult = processed.sanitizedContent ?? publicResult;
    const preview = processed.preview;
    const isError = isErrorResult(displayResult);
    const summary = ToolResultSummarizer.summarize(toolName, argumentsJson, displayResult);
    const data: Record<string, unknown> = {
      tool_call_id: toolCallId,
      result: displayResult,
      status: isError ? 'error' : 'success',
    };
    if (toolName) data.tool_name = toolName;
    if (preview) data.preview = preview;
    if (summary) data.summary = summary;
    this.send('tool_call_result', data);

    void this.recordActivity(toolName, argumentsJson, summary, isError);
    if (toolName && TASK_TOOLS.has(toolName)) {
      void this.pushTodos();
    }
    if (toolName && FILE_TOOLS.has(toolName) && !isError) {
      this.pushFileChange(toolCallId, result);
    }
  }

  onMessageEnd(usage: ChatUsage): void {
    this.send('message_end', {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    });
    this.persistRuntimeStatus(null);
  }

  onError(t: unknown): void {
    const message = t instanceof Error ? t.message : 'Agent 执行异常';
    this.send('error', { message: message || 'Agent 执行异常' });
    this.persistRuntimeStatus(null);
  }

  onContextWindow(estimatedTokens: number, actualTokens: number): void {
    this.send('context_window', { estimated: estimatedTokens, actual: actualTokens });
    void this.deps.sessionService.updateContextTokens(this.sessionId, estimatedTokens).catch(() => {});
  }

  onCompactionStart(type: string, messageCount: number, estimatedTokens: number): void {
    const data = { type, messageCount, estimatedTokens };
    this.send('compaction_start', data);
    this.persistRuntimeStatus({ compacting: data });
  }

  onCompactionEnd(type: string, summaryTokens: number, savedTokens: number, durationMs: number): void {
    this.send('compaction_end', { type, summaryTokens, savedTokens, durationMs });
    this.persistRuntimeStatus(null);
  }

  onCompactionPersisted(eventId: number, triggerMode: string, prevBoundaryMsgId: number, boundaryMsgId: number, compactedMessageCount: number, summaryTokens: number, savedTokens: number, durationMs: number): void {
    this.send('compaction_marker', {
      id: eventId, triggerMode, prevBoundaryMsgId, boundaryMsgId, compactedMessageCount, summaryTokens, savedTokens, durationMs,
    });
  }

  onThinkingStart(): void { this.send('thinking_start', {}); }
  onThinkingEnd(): void { this.send('thinking_end', {}); }
  onThinkingDelta(delta: string): void { this.send('thinking_delta', { delta }); }
  onLlmWaiting(phase: string, elapsedSeconds: number): void {
    const payload = { phase, elapsedSeconds };
    this.send('llm_waiting', payload);
    this.persistRuntimeStatus({ llmWaiting: payload });
  }
  onLlmStreamReset(): void {
    this.toolCallInfo.clear();
    this.deps.registry.clearActiveToolCalls(this.sessionId);
    this.send('llm_stream_reset', {});
  }
  onLlmRetry(reason: string, statusCode: number | null, attempt: number, maxRetries: number, delaySeconds: number): void {
    const payload: Record<string, unknown> = { reason, attempt, maxRetries, delaySeconds };
    if (statusCode != null) payload.statusCode = statusCode;
    this.send('llm_retry', payload);
    this.persistRuntimeStatus({ llmRetry: payload });
  }
  onToolCallArgsDelta(toolCallId: string, argumentsDelta: string): void {
    const info = this.toolCallInfo.get(toolCallId);
    if (info) info[1] = argumentsDelta;
    this.deps.registry.updateActiveToolCallArguments(this.sessionId, toolCallId, argumentsDelta);
    this.send('tool_call_args_delta', { tool_call_id: toolCallId, arguments: argumentsDelta });
  }

  private send(type: string, data: Record<string, unknown>): void {
    this.deps.activityHeartbeat.touch(this.sessionId);
    this.deps.registry.send(this.userId, wsEvent(type, this.sessionId, { ...data, executionId: this.executionId }));
  }

  private persistRuntimeStatus(runtimeStatus: unknown | null): void {
    void this.deps.sessionService.updateRuntimeStatus?.(this.sessionId, runtimeStatus).catch(() => {});
  }

  private async recordActivity(toolName: string | null, argumentsJson: string | null, summary: string | null, isError: boolean): Promise<void> {
    try {
      const activityType = mapToolToType(toolName);
      const target = extractActivityTarget(toolName, argumentsJson);
      const activitySummary = summary ?? toolName;
      const status = isError ? 'ERROR' : 'SUCCESS';
      const activity = await this.deps.activityService.record(this.sessionId, activityType, target, activitySummary, null, status, null);
      this.send('activity', { id: activity.id, type: activityType, target, summary: activitySummary, status });
    } catch { /* ignore */ }
  }

  private async pushTodos(): Promise<void> {
    try {
      const todos = await this.deps.sessionTodoMapper.selectBySessionId(this.sessionId);
      this.send('todo_updated', {
        todos: todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
      });
    } catch { /* ignore */ }
  }

  private pushFileChange(toolCallId: string, result: string): void {
    try {
      const resultNode = JSON.parse(result) as Record<string, unknown>;
      if (resultNode.file_change && resultNode.success) {
        const fc = resultNode.file_change as Record<string, unknown>;
        const changeData: Record<string, unknown> = {
          path: fc.path, type: fc.type, lines_added: fc.lines_added, lines_deleted: fc.lines_deleted, tool_call_id: toolCallId,
        };
        const diff = resultNode[FileChangeDiffUtil.PRIVATE_DIFF_FIELD] as Record<string, unknown> | undefined;
        if (diff && typeof diff === 'object') {
          for (const key of ['diff_mode', 'before_content', 'after_content', 'patch_content', 'patch_truncated', 'diff_unavailable_reason']) {
            if (diff[key] != null) changeData[key] = diff[key];
          }
        }
        this.send('file_change', changeData);
      }
    } catch { /* ignore */ }
  }
}

function isErrorResult(result: string | null): boolean {
  if (result == null) return false;
  try {
    const node = JSON.parse(result) as Record<string, unknown>;
    if ('error' in node) return true;
    if ('exit_code' in node && Number(node.exit_code) !== 0) return true;
  } catch { /* ignore */ }
  return false;
}

function extractActivityTarget(toolName: string | null, argumentsJson: string | null): string | null {
  if (!toolName || !argumentsJson) return null;
  try {
    const node = JSON.parse(argumentsJson) as Record<string, unknown>;
    switch (toolName.toLowerCase()) {
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return typeof node.path === 'string' ? node.path : null;
      case 'shell':
        return typeof node.command === 'string' ? node.command : null;
      case 'glob':
      case 'list':
        return typeof node.pattern === 'string' ? node.pattern : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function contentParts(text: string, images: string[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text && text.trim() !== '') {
    parts.push({ type: 'text', text });
  }
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } } as ContentPart);
  }
  return parts;
}
