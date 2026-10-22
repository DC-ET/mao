import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import { estimatedStartMs } from './run-window.js';
import type { Message } from './types.js';
import type { TraceCallMetaVO, TraceCallRecordVO, TraceToolRecordVO } from './session-vo.js';

/**
 * 运行轨迹记录详情读模型（技术方案 2026-10-22-run-trace-deep-dive §5.3）。
 *
 * 轨迹主 VO 不带正文（防载荷膨胀）：工具行 / 轮次行的参数、结果、完整计时与请求元信息
 * 由本 service 按需查询。只读，不写任何表。
 *
 * 归属口径：
 * - 工具记录按 tool_call_id 精确查（助手消息的 tool_calls + TOOL 消息行），配不上留 null；
 * - 配对 llm_call 用「助手消息 created_at → TOOL 消息 created_at」夹时间窗，取窗口内
 *   scene = 'agent' 的最后一条（与 buildRun 工具组挂轮同一「最后一条未占用候选」精神），
 *   窗口取不到即 null，不跨窗猜；
 * - 轮次记录的「本轮工具」是时间窗近似归属，仅用于抽屉内跳转链接，内容一律以
 *   buildToolRecord 的按 tool_call_id 精确查询为准。
 */

/** 路由层已 requireSessionOwner；此处按「视为不存在」处理跨会话读，不抛错、不泄露存在性。 */
export class RunTraceRecordService {
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly llmCallRepo: LlmCallRepository,
  ) {}

  /**
   * 工具记录详情：参数 JSON（助手消息 tool_calls 元素）、结果 JSON（TOOL 消息 content +
   * metadata）与配对的 llm_call 元信息。找不到 TOOL 消息时结果侧全 null。
   */
  async buildToolRecord(sessionId: number, toolCallId: string): Promise<TraceToolRecordVO> {
    const empty: TraceToolRecordVO = {
      toolCallId, toolName: null, argumentsJson: null, resultContent: null, resultMetadata: null, call: null,
    };
    if (toolCallId === '') return empty;

    const toolMessage = await this.messageRepo.selectToolMessageByCallId(sessionId, toolCallId);
    const assistantMessage = await this.messageRepo.selectAssistantByToolCallId(sessionId, toolCallId);
    const declared = assistantMessage != null ? findDeclaredCall(assistantMessage, toolCallId) : null;

    return {
      toolCallId,
      toolName: declared?.name || null,
      argumentsJson: declared?.argumentsJson ?? null,
      resultContent: toolMessage?.content ?? null,
      resultMetadata: toolMessage?.metadata ?? null,
      // 配对窗口：声明该调用的助手消息 created_at → TOOL 消息 created_at。
      // 缺任一侧时钟时不猜（窗口开放端由 selectBySessionWindow 的 null 语义承担）。
      call: await this.findCall(sessionId, assistantMessage?.createdAt ?? null, toolMessage?.createdAt ?? null),    };
  }

  /**
   * 轮次记录详情：llm_call 全量元信息 + 该轮已声明且现存于会话内的工具（供抽屉内跳转）。
   * llm_call 不存在、或 sessionId 与路径会话不一致 → 空态 VO（防越权读他人会话的调用行）。
   */
  async buildCallRecord(sessionId: number, llmCallId: number): Promise<TraceCallRecordVO> {
    const empty: TraceCallRecordVO = { call: null, tools: [] };
    if (!Number.isInteger(llmCallId) || llmCallId <= 0) return empty;
    const row = await this.llmCallRepo.selectById(llmCallId);
    if (row == null || row.sessionId == null || row.sessionId !== sessionId) return empty;
    return { call: toCallMeta(row), tools: await this.findRoundTools(sessionId, row) };
  }

  /** 窗口内 scene = 'agent' 的最后一条调用；窗口任一端缺失即不配对（不跨窗猜）。 */
  private async findCall(sessionId: number, startAt: string | null, endAt: string | null): Promise<TraceCallMetaVO | null> {
    if (startAt == null || endAt == null) return null;
    const rows = await this.llmCallRepo.selectBySessionWindow(sessionId, startAt, endAt);
    const agents = rows.filter((row) => row.scene === 'agent');
    const last = agents.length > 0 ? agents[agents.length - 1]! : null;
    return last != null ? toCallMeta(last) : null;
  }

  /**
   * 「本轮工具」清单：created_at 落在 [llm_call.created_at − duration, llm_call.created_at]
   * 内的现存助手消息声明的工具调用。近似归属只决定「列出哪些可点的链接」，不决定内容
   * （点过去仍以 buildToolRecord 按 tool_call_id 的精确查询为准）。
   * 窗口任一端不可估算（时钟缺失）时退化为全会话清单，不猜归属也不空列表误导。
   */
  private async findRoundTools(
    sessionId: number,
    call: LlmCallRow,
  ): Promise<Array<{ toolCallId: string; name: string; target: string | null }>> {
    const startMs = estimatedStartMs(call.createdAt, call.durationMs);
    const endMs = startMs == null ? null : startMs + Math.max(0, call.durationMs ?? 0);
    const rows = await this.messageRepo.selectAssistantToolCalls(sessionId);
    const tools: Array<{ toolCallId: string; name: string; target: string | null }> = [];
    for (const row of rows) {
      if (!inWindow(row.createdAt, startMs, endMs)) continue;
      for (const declared of parseToolCalls(row.toolCalls)) {
        tools.push({ toolCallId: declared.id, name: declared.name, target: targetOf(declared.name, declared.argumentsJson) });
      }
    }
    return tools;
  }
}

interface DeclaredToolCall {
  id: string;
  name: string;
  argumentsJson: string | null;
}

/** 窗口任一端缺失 → 全会话清单（不猜）；否则按估算起止的 epoch ms 比较。 */
function inWindow(createdAt: string | null | undefined, startMs: number | null, endMs: number | null): boolean {
  if (startMs == null || endMs == null || createdAt == null) return true;
  const at = Date.parse(createdAt.replace(' ', 'T'));
  if (Number.isNaN(at)) return true;
  return at >= startMs && at <= endMs;
}

function findDeclaredCall(message: Message, toolCallId: string): DeclaredToolCall | null {
  for (const declared of parseToolCalls(message.toolCalls)) {
    if (declared.id === toolCallId) return declared;
  }
  return null;
}

/** 与 run-trace.service.ts 的 parseToolCalls 同口径：tool_calls 数组元素取 id / name / arguments。 */
function parseToolCalls(raw: string | null | undefined): DeclaredToolCall[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const calls: DeclaredToolCall[] = [];
    for (const entry of parsed) {
      if (entry == null || typeof entry !== 'object') continue;
      const node = entry as Record<string, unknown>;
      const id = node.id != null ? String(node.id) : '';
      if (id === '') continue;
      const fn = (node.function ?? {}) as Record<string, unknown>;
      calls.push({
        id,
        name: fn.name != null ? String(fn.name) : '',
        argumentsJson: typeof fn.arguments === 'string' ? fn.arguments : null,
      });
    }
    return calls;
  } catch {
    return [];
  }
}

/** 目标摘要与轨迹主 VO 的 extractTarget 同口径（读文件 / 写文件 / shell / glob / list）。 */
function targetOf(toolName: string, argumentsJson: string | null): string | null {
  if (!toolName || !argumentsJson) return null;
  let node: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    node = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
}

function toCallMeta(call: LlmCallRow): TraceCallMetaVO {
  return {
    llmCallId: call.id ?? null,
    provider: call.provider ?? null,
    protocol: call.protocol ?? null,
    stream: call.stream == null ? null : call.stream === 1,
    effort: call.effort ?? null,
    scene: call.scene ?? null,
    modelName: call.modelName ?? null,
    retryCount: call.retryCount ?? 0,
    firstTokenMs: call.firstTokenMs ?? null,
    durationMs: call.durationMs ?? 0,
    errorMessage: call.errorMessage ?? null,
    promptTokens: call.promptTokens ?? 0,
    completionTokens: call.completionTokens ?? 0,
    cachedTokens: call.cachedTokens ?? 0,
    cacheCreationTokens: call.cacheCreationTokens ?? 0,
    costMicros: call.costMicros ?? null,
    createdAt: call.createdAt ?? null,
  };
}
