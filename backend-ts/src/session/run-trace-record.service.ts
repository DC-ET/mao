import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import type { Message } from './types.js';
import type { TraceCallMetaVO, TraceCallRecordVO, TraceMessageRecordVO, TraceToolRecordVO } from './session-vo.js';

/**
 * 运行轨迹记录详情读模型（技术方案 2026-10-22-run-trace-deep-dive §5.3 与
 * 2026-10-25-run-trace-content-and-prompt §5.3）。
 *
 * 轨迹主 VO 不带正文（防载荷膨胀）：工具行 / 轮次行的参数、结果、回复、思考、完整计时
 * 与请求元信息由本 service 按需查询。只读，不写任何表。
 *
 * 归属口径：
 * - 工具记录按 tool_call_id 精确查（助手消息的 tool_calls + TOOL 消息行），配不上留 null；
 * - 配对 llm_call 用「本轮 llm_call 结束时刻之前」夹时间窗，取窗口内 scene = 'agent'
 *   的最后一条（与 buildRun 工具组挂轮同一「最后一条未占用候选」精神），窗口取不到即
 *   null，不跨窗猜。下界刻意开放，理由见 findCall 上方注释；
 * - 轮次记录的「本轮工具」与「本轮回复」是同一时间窗的近似归属（buildCallRecord 里
 *   一次算出 next），仅用于抽屉内展示 / 跳转链接；工具内容一律以 buildToolRecord 的
 *   按 tool_call_id 精确查询为准；
 * - 单条消息详情（buildMessageRecord）主键直查，无窗口推导。
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
      // 配对窗口：只设上界（TOOL 消息 created_at，排他），下界开放。
      // llm_call.created_at 是「调用结束时刻」，恒早于本轮助手消息的落库时刻
      // （流一结束就 record，之后才执行工具、才 persistToolRound），所以不能用
      // 助手消息 created_at 当下界——那会把本轮的调用挡在窗外，配对恒为空。
      // 下一轮的调用落库更晚（在本轮 TOOL 消息之后），上界即可把它排除。
      // 缺 TOOL 消息时钟时不猜（上界开放端由 selectBySessionWindow 的 null 语义承担）。
      call: await this.findCall(sessionId, toolMessage?.createdAt ?? null),
    };
  }

  /**
   * 轮次记录详情：llm_call 全量元信息 + 该轮已声明且现存于会话内的工具（供抽屉内跳转）
   * + 该轮窗口内的助手消息（回复与思考）。
   * llm_call 不存在、或 sessionId 与路径会话不一致 → 空态 VO（防越权读他人会话的调用行）。
   */
  async buildCallRecord(sessionId: number, llmCallId: number): Promise<TraceCallRecordVO> {
    const empty: TraceCallRecordVO = { call: null, tools: [], messages: [] };
    if (!Number.isInteger(llmCallId) || llmCallId <= 0) return empty;
    const row = await this.llmCallRepo.selectById(llmCallId);
    if (row == null || row.sessionId == null || row.sessionId !== sessionId) return empty;
    // 同一会话的调用序列（created_at 升序）：「本轮工具」与「本轮回复」共享的窗口上界用它推导
    const calls = await this.llmCallRepo.selectBySessionWindow(sessionId, null, null);
    const index = row.id != null ? calls.findIndex((candidate) => candidate.id === row.id) : -1;
    const next = index >= 0 ? calls.slice(index + 1).find((candidate) => candidate.scene === 'agent') : undefined;
    const [tools, messages] = await Promise.all([
      this.findRoundTools(sessionId, row, next),
      this.findRoundMessages(sessionId, row, next),
    ]);
    return { call: toCallMeta(row), tools, messages };
  }

  /**
   * 单条消息详情（用户消息抽屉等）：主键直查，无窗口推导。
   * 行不存在 / 跨会话 → 空态 VO（messageId 原样带回、其余 null），不抛错、不泄露存在性。
   */
  async buildMessageRecord(sessionId: number, messageId: number): Promise<TraceMessageRecordVO> {
    const empty: TraceMessageRecordVO = {
      messageId, role: null, content: null, thinkingContent: null,
      tokenCount: null, createdAt: null, updatedAt: null, edited: false,
    };
    if (!Number.isInteger(messageId) || messageId <= 0) return empty;
    const row = await this.messageRepo.selectMessageById(sessionId, messageId);
    if (row == null) return empty;
    return {
      messageId,
      role: row.role ?? null,
      content: row.content ?? null,
      thinkingContent: row.thinkingContent ?? null,
      tokenCount: row.tokenCount ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      // 编辑重发：锚点被更新过 → updated_at 晚于 created_at；同刻视为未编辑
      edited: row.updatedAt != null && row.updatedAt !== row.createdAt,
    };
  }

  /**
   * 窗口内 scene = 'agent' 的最后一条调用；上界缺失即不配对（不猜）。
   * 下界刻意开放：见 buildToolRecord 的配对窗口注释。
   */
  private async findCall(sessionId: number, endAtExclusive: string | null): Promise<TraceCallMetaVO | null> {
    if (endAtExclusive == null) return null;
    const rows = await this.llmCallRepo.selectBySessionWindow(sessionId, null, endAtExclusive);
    const agents = rows.filter((row) => row.scene === 'agent');
    const last = agents.length > 0 ? agents[agents.length - 1]! : null;
    return last != null ? toCallMeta(last) : null;
  }

  /**
   * 「本轮工具」清单：本轮调用结束后、下一轮 agent 调用结束前落库的现存助手消息声明的工具调用。
   *
   * 归属口径说明：`llm_call.created_at` 是**调用结束时刻**，而本轮助手消息是在工具执行
   * 完之后才落库的，所以本轮助手消息的 `created_at` **晚于** 本轮 `llm_call.created_at`
   * （`C < A`，同 `run-trace.service.ts` 的 `notAfter(call.createdAt, message.createdAt)`）。
   * 因此窗口下界取本轮调用的结束时刻（含同刻），上界取**下一轮 agent 调用**的结束时刻：
   * 本轮工具必然在那之前落库，而下一轮助手消息要等下一轮工具跑完才落库，自然落在窗外。
   * 上界只看 scene = 'agent'——标题 / 压缩等旁路调用可能夹在两轮之间，用它们当上界会把
   * 本轮助手消息误排除。
   *
   * 下一轮不存在（本轮就是最后一轮）时上界开放，下界仍把范围收在本轮；
   * 时钟缺失（created_at 不可用）时退化为全会话清单：不猜归属，也不空列表误导。
   * 点过去仍以 buildToolRecord 按 tool_call_id 精确查询为准。
   */
  private async findRoundTools(
    sessionId: number,
    call: LlmCallRow,
    next: LlmCallRow | undefined,
  ): Promise<Array<{ toolCallId: string; name: string; target: string | null }>> {
    const rows = await this.messageRepo.selectAssistantToolCalls(
      sessionId,
      next?.createdAt ?? null,
      call.createdAt ?? null,
    );
    const tools: Array<{ toolCallId: string; name: string; target: string | null }> = [];
    for (const row of rows) {
      for (const declared of parseToolCalls(row.toolCalls)) {
        tools.push({ toolCallId: declared.id, name: declared.name, target: targetOf(declared.name, declared.argumentsJson) });
      }
    }
    return tools;
  }

  /**
   * 「本轮回复」：本轮窗口内的助手消息（正文 + 思考），窗口与 findRoundTools 同语义。
   * 时钟缺失时返回空数组而非全会话清单——回复是「这一轮的产物」，全会话清单是错误内容；
   * 空数组配抽屉的「时钟缺失」空态提示，比误导诚实。崩溃恢复（调用已落库、回复没落库）
   * 同样得到空数组，抽屉据此区分空态文案。
   */
  private async findRoundMessages(
    sessionId: number,
    call: LlmCallRow,
    next: LlmCallRow | undefined,
  ): Promise<TraceCallRecordVO['messages']> {
    if (call.createdAt == null) return [];
    const rows = await this.messageRepo.selectAssistantMessagesBetween(
      sessionId,
      call.createdAt,
      next?.createdAt ?? null,
    );
    return rows
      .filter((row): row is typeof row & { id: number } => row.id != null)
      .map((row) => ({
        messageId: row.id,
        content: row.content ?? null,
        thinkingContent: row.thinkingContent ?? null,
        tokenCount: row.tokenCount ?? null,
        createdAt: row.createdAt ?? null,
      }));
  }
}

interface DeclaredToolCall {
  id: string;
  name: string;
  argumentsJson: string | null;
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
    systemPrompt: call.systemPrompt ?? null,
    toolsJson: call.toolsJson ?? null,
  };
}
