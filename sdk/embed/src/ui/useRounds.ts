/**
 * 消息 → 轮次（round）视图（对齐 desktop/src/composables/useMessageRounds.ts 的折叠语义）：
 * 一条用户消息 + 其后的全部 assistant 消息构成一轮。已完成轮次把执行过程（思考/工具/中间文本）
 * 折进「已执行 N 个步骤，任务耗时 X」折叠条，只露出最终回复；执行中的轮次平铺展示。
 *
 * embed 与桌面端的消息模型差异：桌面端每步一条 assistant 消息，embed 一轮只有一条流式
 * 气泡（segments 交错 thinking/tool/text），历史对账后则回到「每步一条」。两种形态都按
 * segment 序列扁平化处理，规则一致。
 */
import { computed, reactive, type Ref } from 'vue';
import type { ChatMessage, MessageSegment, ToolCallItem } from '../types';
import { formatRoundDuration } from './elapsed';

export interface RoundRow {
  kind: 'thinking' | 'tools' | 'text';
  /** thinking/text 正文；tools 行时为空串 */
  content: string;
  /** tools 行的调用列表；其余行为 null */
  toolCalls: ToolCallItem[] | null;
  /** 思考行仍在流式（最后一个 segment 是 thinking 且气泡在流式）：行头显示「思考中…」与转圈 */
  streaming: boolean;
}

export interface RoundView {
  /** 折叠展开状态挂在这一轮的 key 上（用户消息 id） */
  key: string;
  /** 头部用户消息；历史截断导致轮次缺头时为 null（此时不折叠，平铺） */
  user: ChatMessage | null;
  /**
   * 执行过程行（思考/工具/中间文本）。不含最终回复正文（折叠与否都单独渲染 replyText，
   * 避免重复上屏）；收尾轮的 thinking 在展开态补在过程行之后。
   */
  rows: RoundRow[];
  /** 最终回复文本（最后一个工具行之后的正文）；无则空串 */
  replyText: string;
  /** 收尾轮 thinking 正文（紧跟最终回复之前）：仅展开态显示 */
  replyThinking: string;
  /** 步骤数：执行过程行的「轮」数（对齐桌面端 stepCount = 中间 assistant 消息数） */
  stepCount: number;
  /** 任务耗时文案（如 16分34秒）；缺时间戳为空串，折叠条相应省略 */
  durationText: string;
  /** 是否可折叠：本轮用过工具（与桌面端 collapsedSteps.length > 0 同口径） */
  collapsible: boolean;
  /** 本轮仍在执行：平铺展示，不折叠 */
  active: boolean;
  /** 是否显示等待三点：执行中、无工具在跑、且还没有正在流出的正文 */
  typing: boolean;
}

/** thinking 起新轮；tool-group / text 归属当前轮。与桌面端「每步一条消息」的步数口径对齐。 */
function countSteps(rows: RoundRow[]): number {
  let steps = 0;
  let open = false;
  for (const row of rows) {
    if (row.kind === 'thinking') {
      steps++;
      open = true;
    } else if (row.kind === 'tools') {
      if (!open) steps++;
      open = true;
    }
    // text 归属当前轮，不计步
  }
  return steps;
}

interface FlatResult {
  rows: RoundRow[];
  hasTools: boolean;
  /** 最后一个工具行的下标；无工具行时 -1 */
  lastToolIdx: number;
  /** 最后一个思考行的下标；无思考行时 -1 */
  lastThinkingIdx: number;
}

function flattenSegments(messages: ChatMessage[]): FlatResult {
  const rows: RoundRow[] = [];
  let hasTools = false;
  let lastToolIdx = -1;
  let lastThinkingIdx = -1;
  for (const m of messages) {
    const segs = m.segments as MessageSegment[];
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      // 气泡流式中：最后一个 segment 是 live 尾（thinking 行转「思考中…」）
      const liveTail = m.streaming && si === segs.length - 1;
      if (seg.type === 'thinking') {
        if (!seg.content) continue;
        rows.push({ kind: 'thinking', content: seg.content, toolCalls: null, streaming: liveTail });
        lastThinkingIdx = rows.length - 1;
      } else if (seg.type === 'tool-group') {
        if (seg.toolCalls.length === 0) continue;
        hasTools = true;
        rows.push({ kind: 'tools', content: '', toolCalls: seg.toolCalls, streaming: false });
        lastToolIdx = rows.length - 1;
      } else {
        if (!seg.content) continue;
        rows.push({ kind: 'text', content: seg.content, toolCalls: null, streaming: false });
      }
    }
  }
  return { rows, hasTools, lastToolIdx, lastThinkingIdx };
}

function hasRunningTool(rows: RoundRow[]): boolean {
  return rows.some((row) => row.toolCalls?.some((tc) => tc.status === 'running') ?? false);
}

export interface UseRoundsResult {
  rounds: Ref<RoundView[]>;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
}

/**
 * 轮次视图构建。phase 处于运行态时仅最后一轮平铺（执行中）；其余轮次按已完成折叠。
 * 每轮的展开/收起状态由 key（用户消息 id）挂在组件里，跨重渲染保持。
 */
export function useRounds(messages: Ref<ChatMessage[]>, activePhase: Ref<string | null>): UseRoundsResult {
  const expanded = reactive<Record<string, boolean>>({});

  const phaseActive = computed(() => activePhase.value === 'RUNNING' || activePhase.value === 'RESUMING');

  const rounds = computed<RoundView[]>(() => {
    const msgs = messages.value;
    const groups: { user: ChatMessage | null; assistants: ChatMessage[]; key: string }[] = [];
    let cur: { user: ChatMessage | null; assistants: ChatMessage[]; key: string } | null = null;
    for (const m of msgs) {
      if (m.role === 'user') {
        if (cur) groups.push(cur);
        cur = { user: m, assistants: [], key: m.id };
      } else if (cur) {
        cur.assistants.push(m);
      } else {
        // 无主的 assistant（历史截断首轮）：自成一轮，缺头不折叠
        cur = { user: null, assistants: [m], key: `orphan-${m.id}` };
      }
    }
    if (cur) groups.push(cur);

    return groups.map((group, idx) => {
      // 只有最后一轮可能仍在执行：phase 运行中，或尾部气泡还挂着 streaming
      const isLast = idx === groups.length - 1;
      const forceActive = isLast && (phaseActive.value || group.assistants.some((m) => m.streaming));
      return buildView(group, forceActive);
    });
  });

  function buildView(group: { user: ChatMessage | null; assistants: ChatMessage[]; key: string }, forceActive: boolean): RoundView {
    const { rows, hasTools, lastToolIdx, lastThinkingIdx } = flattenSegments(group.assistants);
    // 切分执行区与回复区：有工具行切在最后工具行后；纯问答轮切在最后思考行后
    const splitIdx = lastToolIdx >= 0 ? lastToolIdx : lastThinkingIdx;
    const tail = rows.slice(splitIdx + 1);
    // 收尾轮若先思考后正文（有工具轮），thinking 归回复区、仅展开态显示
    const tailThinking = lastToolIdx >= 0 && tail[0]?.kind === 'thinking' ? tail[0] : null;
    const tailTexts = (tailThinking ? tail.slice(1) : tail).filter((row) => row.kind === 'text');
    const replyText = tailTexts.map((row) => row.content).join('');
    const execRows = rows.slice(0, splitIdx + 1);

    // 无工具轮（纯问答）：不产生折叠条，思考行+正文平铺（对齐桌面端单消息轮次）
    const collapsible = hasTools && group.user != null;
    const stepCount = collapsible ? countSteps(execRows) : 0;
    const endIso = group.assistants[group.assistants.length - 1]?.updatedAt
      ?? group.assistants[group.assistants.length - 1]?.createdAt;
    const durationText = collapsible ? formatRoundDuration(group.user?.createdAt, endIso) : '';

    const active = forceActive;
    // 展开态/执行中的过程行：执行区 + 收尾轮 thinking（仅有工具轮在尾部切出过）
    const visibleRows: RoundRow[] = !collapsible
      ? execRows
      : [...execRows, ...(tailThinking ? [tailThinking] : [])];
    // 等待三点：执行中、无工具在跑、且不是正在流出思考（思考行自带转圈）。
    // 空气泡（刚发出还没产出）与工具跑完等下一轮、正文流式中都保持三点（沿用既有口径）。
    const lastOverall = rows[rows.length - 1];
    const typing = active && !hasRunningTool(rows)
      && !(lastOverall?.kind === 'thinking' && lastOverall.streaming);

    return {
      key: group.key,
      user: group.user,
      rows: visibleRows,
      replyText,
      replyThinking: tailThinking?.content ?? '',
      stepCount,
      durationText,
      collapsible,
      active,
      typing,
    };
  }

  function isExpanded(key: string): boolean {
    return expanded[key] === true;
  }

  function toggle(key: string): void {
    expanded[key] = !expanded[key];
  }

  return { rounds, isExpanded, toggle };
}
