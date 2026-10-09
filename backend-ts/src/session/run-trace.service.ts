import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import { sumCostMicros, wallClockMs } from './run-window.js';
import type { SessionActivityRepository } from './activity.repository.js';
import type { SessionCompactionEventRepository } from './session-compaction.repository.js';
import type { Message, SessionActivity, SessionCompactionEvent } from './types.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type {
  RunTracePageVO,
  RunTraceVO,
  TraceMarkerVO,
  TraceRoundVO,
  TraceSegmentVO,
  TraceSideCallVO,
  TraceToolVO,
  UnattributedGroupVO,
} from './session-vo.js';

/**
 * run 轨迹读模型（技术方案 2026-10-09-run-trace §5.2）。
 *
 * 归属口径（D3）：有 tool_call_id 就按消息归；没有则按时间窗放进某个 run 的「未挂到轮」，
 * 或第一页的会话级「未归属」，不对秒级 created_at 猜轮。墙钟按「结束时刻 − duration」
 * 估算起点（D5）；慢 / 贵阈值由路由钳制后传入，服务端只比较。
 *
 * 秒级时钟下的挂轮放宽：llm_call.created_at 是调用结束时刻、message.created_at 是消息
 * 落库时刻，同为秒级 DATETIME。流收尾与 afterStream 落库在同一程序块先后执行，几乎总
 * 落在同一秒，因此候选判定用「不晚于」（<=）而非「严格早于」。同秒仍有多条未占用候选
 * （空响应重试）时不猜，留 unplacedTools。
 */
export interface RunTraceQuery {
  /** 翻页锚点：只取 id 小于它的 run；null = 第一页（最新） */
  beforeRunId: number | null;
  /** 每页 run 数（路由已钳到 1–50，服务端不再判断合法性） */
  limit: number;
  slowMs: number;
  expensiveTokens: number;
}

interface UserStamp {
  id: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 一条助手消息声明的工具调用（tool_calls 数组元素）。 */
interface DeclaredToolCall {
  id: string;
  name: string;
  argumentsJson: string | null;
}

interface ToolDecl {
  runIndex: number;
  message: Message;
  call: DeclaredToolCall;
}

interface RunInput {
  anchor: Message;
  /** 消息 id 区间排他上界（下一条现存用户消息 id）；null = 开放 */
  upperId: number | null;
  /** LLM 时间窗上界；null = 开放 */
  upperCreatedAt: string | null;
  messages: Message[];
  calls: LlmCallRow[];
}

const AGENT_SCENE = 'agent';
const DELEGATE_TOOLS = new Set(['delegate', 'delegate_followup']);
const CANCELLED_MARK = 'Cancelled by user';

export class RunTraceService {
  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly llmCallRepo: LlmCallRepository,
    private readonly activityRepo: SessionActivityRepository,
    private readonly compactionEventRepo: SessionCompactionEventRepository,
  ) {}

  async buildTrace(sessionId: number, query: RunTraceQuery): Promise<RunTracePageVO> {
    // 多取的一条只用于判断 hasMore，然后丢掉，不裁剪本页最老一个 run
    const anchors = await this.messageRepo.selectUserStarts(sessionId, query.beforeRunId, query.limit + 1);
    const hasMore = anchors.length > query.limit;
    const pageAnchors = hasMore ? anchors.slice(0, query.limit) : anchors;
    if (pageAnchors.length === 0 && query.beforeRunId != null) {
      return { runs: [], hasMore: false, unattributed: null };
    }

    // 全局用户消息时钟戳：run 时间窗上界、编辑切点、未归属边界共用，不按页各查一遍
    const userStamps = await this.messageRepo.selectUserStamps(sessionId);
    const stampById = new Map<number, UserStamp>();
    for (const stamp of userStamps) {
      if (stamp.id != null) stampById.set(stamp.id, { id: stamp.id, createdAt: stamp.createdAt ?? null, updatedAt: stamp.updatedAt ?? null });
    }
    const ascendingIds = [...stampById.keys()].sort((a, b) => a - b);
    const firstUserCreatedAt = ascendingIds.length > 0 ? stampById.get(ascendingIds[0])?.createdAt ?? null : null;

    if (pageAnchors.length === 0) {
      // 会话没有任何用户消息：全部调用与活动进未归属
      const calls = await this.llmCallRepo.selectBySessionWindow(sessionId, null, null);
      const activities = await this.activityRepo.selectBySessionAll(sessionId);
      return { runs: [], hasMore: false, unattributed: buildUnattributed(calls, activities, query) };
    }

    const activities = await this.activityRepo.selectBySessionAll(sessionId);
    const compactionEvents = await this.compactionEventRepo.selectBySessionId(sessionId);

    // 每个 run 的消息主干与时间窗 LLM 调用（窗口互不相交，并行取）
    const runInputs: RunInput[] = await Promise.all(pageAnchors.map(async (anchor) => {
      const upperId = nextIdAbove(ascendingIds, anchor.id!);
      const upperCreatedAt = upperId != null ? stampById.get(upperId)?.createdAt ?? null : null;
      const [messages, calls] = await Promise.all([
        this.messageRepo.selectRange(sessionId, anchor.id!, upperId),
        this.llmCallRepo.selectBySessionWindow(sessionId, anchor.createdAt ?? null, upperCreatedAt),
      ]);
      return { anchor, upperId, upperCreatedAt, messages, calls };
    }));

    // 消息索引：tool_call_id -> 声明它的助手消息（只索引本页 run 的现存消息）
    const declByCallId = new Map<string, ToolDecl>();
    const toolMessageByCallId = new Map<string, Message>();
    runInputs.forEach((input, runIndex) => {
      for (const message of input.messages) {
        if (message.role === 'ASSISTANT' && message.toolCalls != null) {
          for (const call of parseToolCalls(message.toolCalls)) {
            if (!declByCallId.has(call.id)) declByCallId.set(call.id, { runIndex, message, call });
          }
        } else if (message.role === 'TOOL' && message.toolCallId != null) {
          if (!toolMessageByCallId.has(message.toolCallId)) {
            toolMessageByCallId.set(message.toolCallId, message);
          }
        }
      }
    });

    // 活动归属：有 tool_call_id 且对得上本页现存消息 → 按消息归（即使 created_at 落在窗外）；
    // 对得上全会话消息但声明消息不在本页 → 归属另一个 run，本页不出现；
    // 其余按时间窗放进某个 run；再否则第一页且早于首条用户消息 → 未归属
    const activityByCallId = new Map<string, SessionActivity>();
    const activitiesByRun: SessionActivity[][] = runInputs.map(() => []);
    const unattributedActivities: SessionActivity[] = [];
    let sessionDeclaredCallIds: Set<string> | null = null;
    for (const activity of activities) {
      const toolCallId = parseDetailToolCallId(activity.detailJson);
      if (toolCallId != null) {
        const decl = declByCallId.get(toolCallId);
        if (decl != null) {
          activityByCallId.set(toolCallId, activity);
          activitiesByRun[decl.runIndex].push(activity);
          continue;
        }
        // 迟到插入：created_at 已落进别的 run 时间窗，但 tool_call_id 对准的助手消息
        // 属于另一个 run。按时间窗兜底会让它在本页和归属页各出现一次、成败重复计数，
        // 因此本页直接不出现（翻到那一页时按消息正确归属）。
        sessionDeclaredCallIds ??= await this.sessionDeclaredCallIds(sessionId);
        if (sessionDeclaredCallIds.has(toolCallId)) continue;
      }
      const runIndex = findRunIndexByTime(runInputs, activity.createdAt ?? null);
      if (runIndex >= 0) {
        activitiesByRun[runIndex].push(activity);
      } else if (query.beforeRunId == null && isBefore(activity.createdAt, firstUserCreatedAt)) {
        unattributedActivities.push(activity);
      }
      // 其余情况属于其他页的 run，本页不出现
    }

    const runs = runInputs.map((input, runIndex) =>
      this.buildRun(input, activitiesByRun[runIndex], compactionEvents, toolMessageByCallId, activityByCallId, query),
    );

    const unattributed = query.beforeRunId == null
      ? buildUnattributed(
        await this.llmCallRepo.selectBySessionWindow(sessionId, null, firstUserCreatedAt),
        unattributedActivities,
        query,
      )
      : null;

    return { runs, hasMore, unattributed };
  }

  /** 全会话现存助手消息声明的 tool_call_id：迟到活动据此判断归属 run 是否在本页（一次查询，惰性）。 */
  private async sessionDeclaredCallIds(sessionId: number): Promise<Set<string>> {
    const rows = await this.messageRepo.selectAssistantToolCalls(sessionId);
    const ids = new Set<string>();
    for (const row of rows) {
      for (const call of parseToolCalls(row.toolCalls)) ids.add(call.id);
    }
    return ids;
  }

  private buildRun(
    input: RunInput,
    runActivities: SessionActivity[],
    compactionEvents: SessionCompactionEvent[],
    toolMessageByCallId: Map<string, Message>,
    activityByCallId: Map<string, SessionActivity>,
    query: RunTraceQuery,
  ): RunTraceVO {
    const { anchor, upperId, messages, calls } = input;
    // 编辑重发：锚点被更新过 → created_at < updated_at 的调用归「编辑前」，更早的执行合并进该段
    const editBoundary = isAfter(anchor.updatedAt, anchor.createdAt) ? anchor.updatedAt ?? null : null;

    const agentCalls = calls.filter((c) => c.scene === AGENT_SCENE);
    const beforeRounds: TraceRoundVO[] = [];
    const currentRounds: TraceRoundVO[] = [];
    /** 当前段的轮与来源调用并行保留：工具组挂轮后要按调用 id 记账「已被占用」 */
    const currentRoundEntries: Array<{ call: LlmCallRow; round: TraceRoundVO }> = [];
    for (const call of agentCalls) {
      const round = toRoundVO(call, 0, query);
      if (editBoundary != null && isBefore(call.createdAt, editBoundary)) {
        round.seq = beforeRounds.length + 1;
        beforeRounds.push(round);
      } else {
        round.seq = currentRounds.length + 1;
        currentRounds.push(round);
        currentRoundEntries.push({ call, round });
      }
    }
    const sideCalls = calls.filter((c) => c.scene !== AGENT_SCENE).map(toSideCallVO);

    // 工具组：现存助手消息的 tool_calls 与工具消息、活动按 tool_call_id 配成一组
    const beforeUnplaced: TraceToolVO[] = [];
    const currentUnplaced: TraceToolVO[] = [];
    const groupedActivityIds = new Set<number>();
    const claimedCallIds = new Set<number>();
    for (const message of messages) {
      if (message.role !== 'ASSISTANT' || message.toolCalls == null) continue;
      const declared = parseToolCalls(message.toolCalls);
      if (declared.length === 0) continue;
      const tools: TraceToolVO[] = [];
      for (const call of declared) {
        const activity = activityByCallId.get(call.id);
        if (activity?.id != null) groupedActivityIds.add(activity.id);
        tools.push(toToolVO(call, toolMessageByCallId.get(call.id), activity));
      }
      // 挂轮：当前段内 created_at 不晚于该助手消息、且尚未被占用的最后一条 agent 调用。
      // 候选池限定当前段——对得上现存消息的工具永远归当前段（编辑前的助手消息已被截断）。
      //
      // 为何允许同秒（<=）：llm_call.created_at 是调用结束时刻、message.created_at 是
      // 消息落库时刻。流式响应收尾与 afterStream 的落库在同一个程序块里先后执行，几乎
      // 总落在同一秒。V142 已把这两列提升为 DATETIME(3)，毫秒正常可区分先后；但历史行
      // 仍是秒级（MySQL 补 .000），「同秒也认」作为兼容存量行的兜底保留，不能删。
      const candidates = currentRoundEntries.filter((entry) =>
        entry.call.id != null && !claimedCallIds.has(entry.call.id) && notAfter(entry.call.createdAt, message.createdAt),
      );
      const last = candidates.length > 0 ? candidates[candidates.length - 1] : null;
      // 时间戳完全相同（历史秒级行的同秒，或时钟回拨）→ 无法判定先后，不猜
      const ambiguous = last != null && candidates.some((entry) => entry !== last && eqTs(entry.call.createdAt, last.call.createdAt));
      if (last == null || ambiguous) {
        currentUnplaced.push(...tools);
      } else {
        claimedCallIds.add(last.call.id!);
        last.round.tools.push(...tools);
      }
    }

    // 未配进任何工具组的活动（历史行 / 对不上现存消息的截断旧工具）
    for (const activity of runActivities) {
      if (activity.id != null && groupedActivityIds.has(activity.id)) continue;
      const tool = activityToToolVO(activity);
      if (editBoundary != null && isBefore(activity.createdAt, editBoundary)) {
        beforeUnplaced.push(tool);
      } else {
        currentUnplaced.push(tool);
      }
    }

    const segments: TraceSegmentVO[] = [];
    if (beforeRounds.length > 0 || beforeUnplaced.length > 0) {
      segments.push({ kind: 'before_edit', rounds: beforeRounds, unplacedTools: beforeUnplaced });
    }
    segments.push({ kind: 'current', rounds: currentRounds, unplacedTools: currentUnplaced });

    const markers: TraceMarkerVO[] = [];
    for (const event of compactionEvents) {
      const boundary = event.boundaryMsgId;
      // 压缩只按 boundary_msg_id 硬归属，不拿 created_at 去对 llm_call
      if (boundary == null || boundary < anchor.id!) continue;
      if (upperId != null && boundary >= upperId) continue;
      markers.push({
        kind: 'compaction',
        atMessageId: boundary,
        detail: `${event.triggerMode} · 压缩 ${event.compactedMessageCount ?? 0} 条消息 · 节省 ${event.savedTokens ?? 0} tokens`,
      });
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let cacheCreationTokens = 0;
    for (const call of calls) {
      promptTokens += call.promptTokens ?? 0;
      completionTokens += call.completionTokens ?? 0;
      cachedTokens += call.cachedTokens ?? 0;
      cacheCreationTokens += call.cacheCreationTokens ?? 0;
    }
    // 窗口内没有任何调用时同样没有账可算；任一行未配价则合计为 null
    const costMicros = sumCostMicros(calls);

    // 工具成败只数挂上了轮或 unplacedTools 里、且状态明确的活动；null duration 不影响计数
    let toolSuccess = 0;
    let toolError = 0;
    for (const activity of runActivities) {
      if (activity.status === 'SUCCESS') toolSuccess++;
      else if (activity.status === 'ERROR') toolError++;
    }

    return {
      runId: anchor.id!,
      userMessagePreview: previewOf(anchor.content),
      startedAt: javaLocalDateTimeString(anchor.createdAt),
      segments,
      sideCalls,
      subagentLinks: collectSubagentLinks(messages, toolMessageByCallId),
      markers,
      totals: {
        wallClockMs: wallClockMs([
          ...calls.map((c) => ({ createdAt: c.createdAt ?? null, durationMs: c.durationMs ?? null })),
          ...runActivities.map((a) => ({ createdAt: a.createdAt ?? null, durationMs: a.durationMs ?? null })),
        ]),
        costMicros,
        promptTokens,
        completionTokens,
        cachedTokens,
        cacheCreationTokens,
        toolSuccess,
        toolError,
      },
    };
  }
}

function toRoundVO(call: LlmCallRow, seq: number, query: RunTraceQuery): TraceRoundVO {
  const promptTokens = call.promptTokens ?? 0;
  const completionTokens = call.completionTokens ?? 0;
  const cachedTokens = call.cachedTokens ?? 0;
  const cacheCreationTokens = call.cacheCreationTokens ?? 0;
  const durationMs = call.durationMs ?? 0;
  const errorMessage = call.errorMessage ?? null;
  return {
    seq,
    modelName: call.modelName ?? null,
    scene: AGENT_SCENE,
    createdAt: call.createdAt ?? null,
    durationMs,
    firstTokenMs: call.firstTokenMs ?? null,
    retryCount: call.retryCount ?? 0,
    success: call.success === 1,
    // 取消也会在 finally 落库：只认 error_message 含 Cancelled by user，不计失败
    interrupted: errorMessage != null && errorMessage.includes(CANCELLED_MARK),
    errorMessage,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheCreationTokens,
    costMicros: call.costMicros ?? null,
    slow: durationMs >= query.slowMs,
    // 贵看四类 token 之和，与是否配价无关
    expensive: promptTokens + completionTokens + cachedTokens + cacheCreationTokens >= query.expensiveTokens,
    tools: [],
  };
}

function toSideCallVO(call: LlmCallRow): TraceSideCallVO {
  return {
    scene: call.scene ?? 'unknown',
    modelName: call.modelName ?? null,
    createdAt: call.createdAt ?? null,
    durationMs: call.durationMs ?? 0,
    promptTokens: call.promptTokens ?? 0,
    completionTokens: call.completionTokens ?? 0,
    cachedTokens: call.cachedTokens ?? 0,
    cacheCreationTokens: call.cacheCreationTokens ?? 0,
    costMicros: call.costMicros ?? null,
    success: call.success === 1,
  };
}

function toToolVO(call: DeclaredToolCall, toolMessage: Message | undefined, activity: SessionActivity | undefined): TraceToolVO {
  return {
    toolCallId: call.id || null,
    name: call.name,
    target: activity?.target ?? extractTarget(call.name, call.argumentsJson),
    // 状态以活动行为权威；没有活动行（写入失败 / 极早期）才回退工具消息内容启发式
    status: activity?.status ?? heuristicStatus(toolMessage?.content),
    durationMs: activity?.durationMs ?? null,
    // 审批标记：先读工具消息 metadataJson，没有再用活动 detail_json
    approvalMark: approvalMarkLabel(parseMetadataMark(toolMessage?.metadata)) ?? approvalMarkLabel(parseDetailMark(activity?.detailJson)),
    actor: parseActor(activity?.detailJson),
  };
}

function activityToToolVO(activity: SessionActivity): TraceToolVO {
  return {
    toolCallId: parseDetailToolCallId(activity.detailJson),
    // 历史行与截断旧工具没有工具名可对：summary 是当时最具体的记录
    name: activity.summary ?? activity.type ?? '工具',
    target: activity.target ?? null,
    status: activity.status ?? 'SUCCESS',
    durationMs: activity.durationMs ?? null,
    approvalMark: approvalMarkLabel(parseDetailMark(activity.detailJson)),
    actor: parseActor(activity.detailJson),
  };
}

function parseActor(detailJson: string | null | undefined): 'user' | 'agent' | null {
  const actor = parseJsonObject(detailJson)?.actor;
  return actor === 'user' || actor === 'agent' ? actor : null;
}

function buildUnattributed(calls: LlmCallRow[], activities: SessionActivity[], query: RunTraceQuery): UnattributedGroupVO | null {
  if (calls.length === 0 && activities.length === 0) return null;
  // 未归属组不做轮 / 旁路之分：llm_call 原样成行，scene 携带真实值
  const rounds = calls.map((call, i) => ({ ...toRoundVO(call, i + 1, query), scene: call.scene ?? 'unknown' }));
  const tools = activities.map(activityToToolVO);
  const stamps = [
    ...calls.map((c) => c.createdAt ?? null),
    ...activities.map((a) => a.createdAt ?? null),
  ].filter((s): s is string => s != null);
  return {
    count: rounds.length + tools.length,
    startedAt: stamps.length > 0 ? javaLocalDateTimeString(stamps.reduce((a, b) => (a <= b ? a : b))) : null,
    endedAt: stamps.length > 0 ? javaLocalDateTimeString(stamps.reduce((a, b) => (a >= b ? a : b))) : null,
    rounds,
    tools,
  };
}

function collectSubagentLinks(messages: Message[], toolMessageByCallId: Map<string, Message>): Array<{ sessionId: number; title: string | null }> {
  const links: Array<{ sessionId: number; title: string | null }> = [];
  const seen = new Set<number>();
  for (const message of messages) {
    if (message.role !== 'ASSISTANT' || message.toolCalls == null) continue;
    for (const call of parseToolCalls(message.toolCalls)) {
      if (!DELEGATE_TOOLS.has(call.name.toLowerCase())) continue;
      // 解析失败就不出链接；失败结果上的同名字段同样解析
      const childSessionId = parseChildSessionId(toolMessageByCallId.get(call.id)?.content);
      if (childSessionId == null || seen.has(childSessionId)) continue;
      seen.add(childSessionId);
      links.push({ sessionId: childSessionId, title: taskLabel(call.argumentsJson) });
    }
  }
  return links;
}

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

function parseDetailToolCallId(detailJson: string | null | undefined): string | null {
  const value = parseJsonObject(detailJson)?.toolCallId;
  return typeof value === 'string' && value !== '' ? value : null;
}

interface ToolApprovalMarkLike {
  mode?: unknown;
  approved?: unknown;
  reason?: unknown;
}

function parseDetailMark(detailJson: string | null | undefined): ToolApprovalMarkLike | null {
  const mark = parseJsonObject(detailJson)?.approvalMark;
  return mark != null && typeof mark === 'object' ? (mark as ToolApprovalMarkLike) : null;
}

function parseMetadataMark(metadata: string | null | undefined): ToolApprovalMarkLike | null {
  const mark = parseJsonObject(metadata)?.approvalMark;
  return mark != null && typeof mark === 'object' ? (mark as ToolApprovalMarkLike) : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 审批标记紧凑串，与桌面 ToolCallCard 的徽标文案保持一致。 */
function approvalMarkLabel(mark: ToolApprovalMarkLike | null): string | null {
  if (mark == null) return null;
  if (mark.mode === 'jev') return '低风险放行';
  if (mark.mode === 'rule') return '规则放行';
  return mark.approved ? 'AI 已批准' : 'AI 已拒绝';
}

function parseChildSessionId(content: string | null | undefined): number | null {
  const node = parseJsonObject(content);
  const value = node?.child_session_id ?? node?.childSessionId;
  const id = value != null ? Number(value) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

function taskLabel(argumentsJson: string | null): string | null {
  const task = parseJsonObject(argumentsJson)?.task;
  if (typeof task !== 'string' || task.trim() === '') return null;
  const text = task.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 与 ws-streaming-event-listener 的错误启发式一致：meta 缺失时的兜底判定。 */
function heuristicStatus(content: string | null | undefined): string {
  if (content == null) return 'SUCCESS';
  try {
    const node = JSON.parse(content) as Record<string, unknown>;
    if ('error' in node) return 'ERROR';
    if ('exit_code' in node && Number(node.exit_code) !== 0) return 'ERROR';
  } catch { /* ignore */ }
  return 'SUCCESS';
}

function extractTarget(toolName: string, argumentsJson: string | null): string | null {
  if (!toolName || !argumentsJson) return null;
  const node = parseJsonObject(argumentsJson);
  if (node == null) return null;
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

function previewOf(content: string | null | undefined, max = 80): string {
  if (content == null) return '';
  let text = content;
  if (text.trim().startsWith('[')) {
    try {
      const parts = JSON.parse(text) as unknown[];
      text = parts
        .map((part) => {
          if (part != null && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
            return String((part as Record<string, unknown>).text ?? '');
          }
          return '';
        })
        .join('');
    } catch { /* 非 JSON 数组时按原文 */ }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 下一个更大的现存用户消息 id（排他上界）；没有则 null（上界开放）。 */
function nextIdAbove(ascendingIds: number[], id: number): number | null {
  for (const candidate of ascendingIds) {
    if (candidate > id) return candidate;
  }
  return null;
}

/** run 窗口按 [anchor.created_at, 上界) 半开；窗口互不相交，最多命中一个。 */
function findRunIndexByTime(runInputs: RunInput[], createdAt: string | null): number {
  if (createdAt == null) return -1;
  for (let i = 0; i < runInputs.length; i++) {
    const { anchor, upperCreatedAt } = runInputs[i];
    if (isBefore(createdAt, anchor.createdAt)) continue;
    if (upperCreatedAt != null && !isBefore(createdAt, upperCreatedAt)) continue;
    return i;
  }
  return -1;
}

/** DATETIME 字符串（yyyy-MM-dd HH:mm:ss）字典序即时间序。 */
function isBefore(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a < b;
}

/** 同秒也认：工具组挂轮的候选判定用。任一侧缺失（时钟不可比）时保守返回 false。 */
function notAfter(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a <= b;
}

function isAfter(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a > b;
}

function eqTs(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a === b;
}
