/**
 * 信号哨兵契约（前后端共用，desktop / admin 同步消费）。
 *
 * 判定模式与哨兵状态的联合类型放在这里，供两端汉化表以
 * `Record<SignalCompareMode, string>` / `Record<SignalWatcherStatus, string>` /
 * `Record<SignalTriggerMode, string>`
 * 声明——漏一项编译期即失败。
 *
 * 事实源是后端 `backend-ts/src/signal/types.ts`：那里持有运行时常量
 * （`SIGNAL_COMPARE_MODES` / `SIGNAL_WATCHER_STATUSES`）与校验守卫，
 * 并通过 `as const satisfies` 约束到本文件的联合类型。
 */

/** 变化判定模式：内容哈希 / JSON 字段（点分路径 + 数组下标）/ HTTP 状态码。 */
export type SignalCompareMode = 'HASH' | 'JSON_FIELD' | 'STATUS_CODE';

/** 哨兵状态：ACTIVE 轮询中 / PAUSED 用户暂停 / DISABLED 连续失败自动停用（系统终态）。 */
export type SignalWatcherStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

/**
 * 触发方式：NEW_SESSION=每次触发新建会话，REUSE_SESSION=复用本哨兵自己的会话。
 * 复用指针（reuse_session_id）由系统维护：首次触发自动建会话并回写，用户不选择会话。
 */
export type SignalTriggerMode = 'NEW_SESSION' | 'REUSE_SESSION';

/** 轮询记录里的非失败告警码：触发频次超限（照常触发，仅标记）。 */
export type SignalWatcherWarning = 'TRIGGER_RATE_LIMITED';

/**
 * diff 片段单侧截断字数（后端 `DIFF_SNIPPET_MAX_CHARS` 的展示侧复刻）。
 * 触发 prompt 的 {diff} 与轮询记录里落库的 old/new 片段共用此口径（500 字）。
 */
export const SIGNAL_SNIPPET_MAX_CHARS = 500;

/** 截断（与后端 watcher.logic 的 truncateSnippet 同口径）。 */
export function truncateSignalSnippet(text: string, max: number = SIGNAL_SNIPPET_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

export interface SignalWhenChangeInput {
  compareMode: SignalCompareMode;
  /** 上次值（判为变化时的旧值；未变/首轮可为空）。 */
  oldText: string | null;
  /** 本次值。 */
  newText: string | null;
  jsonPath?: string | null;
}

/**
 * 「旧值 → 新值」人读格式：与后端 buildDiff 三模式的文案族字面一致（§5 文案口径）。
 * 单行折叠版（展示层用）：HASH `[响应体前 500 字] 旧：… → 新：…`；
 * JSON_FIELD `[字段 {jsonPath}] 旧值：… → 新值：…`；STATUS_CODE `[HTTP 状态码] {old} → {new}`。
 * old/new 为空/NULL 时回落 `—`；两侧均过 truncateSignalSnippet（本函数内）。
 */
export function formatSignalChangeValue(input: SignalWhenChangeInput): string {
  const oldSnippet = input.oldText == null ? '—' : truncateSignalSnippet(input.oldText);
  const newSnippet = input.newText == null ? '—' : truncateSignalSnippet(input.newText);
  if (input.compareMode === 'STATUS_CODE') {
    return `[HTTP 状态码] ${oldSnippet} → ${newSnippet}`;
  }
  if (input.compareMode === 'JSON_FIELD') {
    return `[字段 ${input.jsonPath ?? ''}] 旧值：${oldSnippet} → 新值：${newSnippet}`;
  }
  return `[响应体前 ${SIGNAL_SNIPPET_MAX_CHARS} 字] 旧：${oldSnippet} → 新：${newSnippet}`;
}

/**
 * 轮询记录「详情」列的文案（桌面抽屉与 admin Tab 同口径，§5.5/§5.6）：
 * - error 行优先展示 error 文本；error 且 changed === 1 的「触发失败」行，
 *   在 error 下附第二行新旧值对（附在调用侧用换行拼接，本函数返回多行字符串）；
 * - 未变行（及首轮建基线行）显示新值；
 * - old/new 均为 NULL（上线前历史行）回落 `—`。
 */
export interface SignalCheckDetailInput {
  compareMode: SignalCompareMode;
  changed: number;
  error: string | null;
  oldValueSnippet: string | null;
  newValueSnippet: string | null;
  jsonPath?: string | null;
}

export function formatSignalCheckDetail(input: SignalCheckDetailInput): string {
  const fallback = input.newValueSnippet == null && input.oldValueSnippet == null ? '—' : null;
  if (input.error != null) {
    // 「触发失败」第三态：error 非空且 changed === 1 时附新旧值对
    if (input.changed === 1) {
      const pair = formatSignalChangeValue({
        compareMode: input.compareMode,
        oldText: input.oldValueSnippet,
        newText: input.newValueSnippet,
        jsonPath: input.jsonPath,
      });
      return `${input.error}\n${pair}`;
    }
    return input.error;
  }
  if (fallback != null) return fallback;
  if (input.changed === 1) {
    return formatSignalChangeValue({
      compareMode: input.compareMode,
      oldText: input.oldValueSnippet,
      newText: input.newValueSnippet,
      jsonPath: input.jsonPath,
    });
  }
  // 未变行显示新值（新值为空白字符串时也视为一条值）
  return input.newValueSnippet == null ? '—' : truncateSignalSnippet(input.newValueSnippet);
}
