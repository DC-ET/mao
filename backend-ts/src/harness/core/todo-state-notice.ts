import type { SessionTodo } from '../todo/entity/session-todo.js';

/**
 * 任务台账 `<system-notice>` 注入（技术方案 2026-11-25）。
 *
 * 本模块只放纯函数：查库路径（SessionHistoryLoader.applyHistory）与工具结果路径
 * （agent-loop task_* 执行后）共用同一渲染函数，任何一处单独改渲染都会让两条
 * 刷新来源输出分叉，进而击穿跨轮的前缀缓存。
 */

/** content 渲染截断上限：task_create 对 content 无长度限制，防超长/多行标题撑爆 notice。 */
const MAX_CONTENT_LENGTH = 80;

const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_list', 'task_delete']);

/**
 * 渲染当前任务台账 notice；todos 为空返回 null（不注入）。
 *
 * 入参按 `sort_order ASC, id ASC` 排序后渲染（mapper 查询口径）：查库路径天然有序，
 * 工具结果路径的 todos 同样出自该 SQL，这里再排一次是防御性兜底，保证两条刷新来源
 * 对同一 DB 状态输出逐字节一致。全部 completed 时输出中性短变体——催收尾修辞只保留
 * 在 task_update 结果 hint（仅在实际流转那轮出现一次），notice 每轮在场，措辞必须中性。
 */
export function buildTodoStateNotice(todos: SessionTodo[]): string | null {
  if (todos.length === 0) return null;
  const sorted = [...todos].sort((a, b) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  const completedCount = sorted.filter((t) => t.status === 'completed').length;
  if (completedCount === sorted.length) {
    return `任务台账：${completedCount}/${sorted.length} 已完成。`;
  }
  const lines = sorted.map((todo) =>
    `- #${todo.id ?? '?'} ${todo.status ?? 'pending'} ${renderContent(todo.content)}`);
  return [
    '当前任务台账（系统注入的权威状态，不要向用户复述本条）：',
    ...lines,
    `进度：${completedCount}/${sorted.length} 已完成。`,
    '请维持任务纪律：每完成一项，立即用 task_update 将该项标记为 completed（带上对应 id），'
      + '并将下一项置为 in_progress；不要批量补标，也不要重复本清单。',
  ].join('\n');
}

/** 单行折叠 + 截断：截断不破坏确定性（同输入同输出）。 */
function renderContent(raw: string | null | undefined): string {
  const singleLine = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_CONTENT_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_CONTENT_LENGTH)}…`;
}

/**
 * task_* 工具结果 → 台账 notice（agent-loop 刷新点用，免查库）。
 *
 * 返回判别结果而非裸 string：外层 null = 非 task 工具 / 解析失败（调用方保留旧值）；
 * `ok: true` = 解析成功，notice 按结果重建——台账删空时 notice 为 null，调用方必须
 * 覆盖旧值。禁止「成功也返回 null 再 ?? 兜底」：那会把「删空清空」与「解析失败」混为
 * 一谈，删光后台账（含已删除 id）会持续在场，而 task_update 对已删除 id 是 0 行静默
 * 成功，模型会对幽灵台账持续假补标。
 *
 * 四种 task 工具成功结果均含 `todos` 数组（同一 selectBySessionId 口径）；errorJson
 * 形状（如参数校验失败）没有 `todos` 键，返回外层 null 保留旧值。
 */
export interface TodoNoticeFromResult {
  ok: true;
  notice: string | null;
}

export function noticeFromTaskToolResult(toolName: string, resultContent: string): TodoNoticeFromResult | null {
  if (!TASK_TOOL_NAMES.has(toolName)) return null;
  const parsed = parseJson(resultContent);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  if (!Array.isArray(parsed.value.todos)) return null;
  return { ok: true, notice: buildTodoStateNotice(parsed.value.todos as SessionTodo[]) };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
