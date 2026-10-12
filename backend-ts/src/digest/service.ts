import { addDaysYmd, formatDateTime, shanghaiYmd } from '../common/json.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import {
  DEFAULT_DIGEST_PREFERENCE,
  isValidPushTime,
  type DigestData,
  DigestInboxPort,
  DigestOutboundPort,
  DigestPreference,
  DigestPreferenceRow,
  DigestPreferenceView,
  DigestProcessResult,
  YesterdayDigestStatus,
} from './types.js';
import type { DigestRepository } from './repository.js';

/** 失败任务 / 审批挂起 / 成本 Top 的展示条数上限。 */
const FAILED_TOP = 3;
const APPROVAL_ITEMS = 5;
const COST_TOP = 3;
/** 失败原因的截断长度。 */
const REASON_MAX = 80;
/** 内容与标题的 clip 上限（对齐 inbox 域口径）。 */
const TITLE_MAX = 200;
const CONTENT_MAX = 500;

export interface DigestServiceDeps {
  repo: DigestRepository;
  inbox: DigestInboxPort;
  outbound: DigestOutboundPort | null;
  /** 可注入时钟（调度器与单测固定“现在”）。 */
  now?: () => Date;
}

/**
 * 每日运营摘要服务（技术方案 §5.3）：六板块聚合 → 渲染 → 收件箱/出站投递 → 防重标记。
 *
 * 关键不变量：
 * - 窗口永远是“昨天自然日”（Asia/Shanghai，半开区间），由 coveredDate 推算，绝不用“过去 24h”。
 * - 安静日（六板块全空）只写 last_digest_date 不投递；设置页据此显示「无事件未发送」。
 * - 试发（force）走同一条链路但不写 last_digest_date，可重复试发、同日覆盖通知行。
 * - 偏好门控（enabled）只认 user_digest_preference；收件箱 kind 偏好不门控摘要（isKindEnabled 恒真）。
 */
export class DigestService {
  private readonly now: () => Date;

  constructor(private readonly deps: DigestServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 昨天的 yyyy-MM-dd（Asia/Shanghai）。 */
  coveredDateOf(now: Date = this.now()): string {
    return addDaysYmd(shanghaiYmd(now), -1);
  }

  /** 六板块聚合；无数据的板块置 null。 */
  async aggregate(userId: number, coveredDate: string): Promise<DigestData> {
    const start = `${coveredDate} 00:00:00`;
    const end = `${addDaysYmd(coveredDate, 1)} 00:00:00`;

    const taskCounts = await this.deps.repo.countTaskTerminal(userId, start, end);
    const failedRows = taskCounts.failed > 0
      ? await this.deps.repo.listFailedTasks(userId, start, end, FAILED_TOP)
      : [];
    const scheduledCounts = await this.deps.repo.countScheduledRuns(userId, start, end);
    const paused = await this.deps.repo.listPausedTasks(userId, start, end);
    const triggered = await this.deps.repo.countWatcherTriggers(userId, start, end);
    const disabledWatchers = await this.deps.repo.listDisabledWatchers(userId, start, end);
    const pendingApprovals = await this.deps.repo.countPendingApprovals(userId);
    const approvalItems = pendingApprovals > 0
      ? await this.deps.repo.listPendingApprovals(userId, APPROVAL_ITEMS)
      : [];
    const costRows = await this.deps.repo.sumCostByAgent(userId, start, end);
    const openApiCounts = await this.deps.repo.countOpenApiCalls(userId, start, end);

    const costCalls = costRows.reduce((sum, row) => sum + row.calls, 0);
    const costUnpriced = costRows.reduce((sum, row) => sum + row.unpriced, 0);
    const pricedRows = costRows.filter((row) => row.micros != null && row.micros > 0);
    const agentNames = await this.deps.repo.findAgentNames(
      pricedRows.slice(0, COST_TOP).map((row) => row.agentId).filter((id): id is number => id != null),
    );

    return {
      coveredDate,
      tasks: taskCounts.completed === 0 && taskCounts.failed === 0
        ? null
        : {
            completed: taskCounts.completed,
            failed: taskCounts.failed,
            failedTop: failedRows.map((row) => ({
              sessionId: row.sessionId == null ? null : Number(row.sessionId),
              title: clip(row.title, TITLE_MAX),
              reason: clip(row.reason ?? '', REASON_MAX),
            })),
          },
      scheduled: scheduledCounts.total === 0 && paused.length === 0
        ? null
        : { ...scheduledCounts, paused },
      watchers: triggered === 0 && disabledWatchers.length === 0
        ? null
        : { triggered, disabled: disabledWatchers },
      approvals: pendingApprovals === 0
        ? null
        : {
            pending: pendingApprovals,
            items: approvalItems.map((row) => ({
              sessionId: row.sessionId == null ? null : Number(row.sessionId),
              title: clip(row.title, TITLE_MAX),
            })),
          },
      cost: costCalls === 0
        ? null
        : {
            totalMicros: pricedRows.reduce((sum, row) => sum + (row.micros ?? 0), 0),
            unpricedCalls: costUnpriced,
            calls: costCalls,
            top: pricedRows.slice(0, COST_TOP).map((row) => ({
              agentId: row.agentId,
              name: (row.agentId != null ? agentNames.get(row.agentId) : null) ?? '未关联 Agent',
              micros: row.micros ?? 0,
            })),
          },
      openApi: openApiCounts.total === 0 ? null : { ...openApiCounts },
    };
  }

  /** 六板块全空 → 安静日。 */
  isEmpty(data: DigestData): boolean {
    return data.tasks == null
      && data.scheduled == null
      && data.watchers == null
      && data.approvals == null
      && data.cost == null
      && data.openApi == null;
  }

  /**
   * 生成并投递一个用户的昨日摘要。
   * force=true（试发）：跳过 enabled 门控与推送时间判定、不写 last_digest_date。
   */
  async processUser(userId: number, opts?: { force?: boolean }): Promise<DigestProcessResult> {
    const force = opts?.force === true;
    const pref = await this.loadPreference(userId);
    if (!pref.enabled && !force) {
      return { sent: false, reason: 'DISABLED', coveredDate: this.coveredDateOf() };
    }
    const coveredDate = this.coveredDateOf();
    const data = await this.aggregate(userId, coveredDate);
    if (this.isEmpty(data)) {
      if (!force) await this.deps.repo.markProcessed(userId, coveredDate);
      return { sent: false, reason: 'QUIET', coveredDate };
    }
    const line = renderDigestLine(data);
    await this.deps.inbox.writeDigestEntry({
      userId,
      title: digestTitle(coveredDate),
      content: clip(line, CONTENT_MAX),
      payload: { coveredDate, digest: data as unknown as Record<string, unknown> },
      dedupTail: coveredDate,
    });
    if (pref.outboundEnabled && this.deps.outbound != null) {
      this.deps.outbound.dispatchDigest({ userId, coveredDate, digest: data, text: renderDigestMarkdown(data) });
    }
    if (!force) await this.deps.repo.markProcessed(userId, coveredDate);
    return { sent: true, line, coveredDate };
  }

  /** 偏好视图：偏好 + 「上一份摘要」三态。 */
  async getPreferencesView(userId: number): Promise<DigestPreferenceView> {
    const pref = await this.loadPreference(userId);
    const coveredDate = this.coveredDateOf();
    let status: YesterdayDigestStatus = 'PENDING';
    if (pref.lastDigestDate === coveredDate) {
      status = (await this.deps.inbox.hasDigestEntry(userId, coveredDate)) ? 'SENT' : 'QUIET';
    }
    return { ...pref, yesterdayStatus: status, yesterdayCoveredDate: coveredDate };
  }

  /** 增量保存：只覆盖请求体里出现的字段，懒建行。 */
  async savePreferences(userId: number, patch: {
    enabled?: boolean;
    pushTime?: string;
    outboundEnabled?: boolean;
  }): Promise<DigestPreference> {
    if (patch.pushTime != null && !isValidPushTime(patch.pushTime)) {
      throw new DigestPreferenceError('pushTime 必须为 HH:MM（00:00~23:59）');
    }
    const current = await this.loadPreference(userId);
    const next: DigestPreference = {
      enabled: patch.enabled ?? current.enabled,
      pushTime: patch.pushTime ?? current.pushTime,
      outboundEnabled: patch.outboundEnabled ?? current.outboundEnabled,
      lastDigestDate: current.lastDigestDate,
    };
    await this.deps.repo.upsertPreference({
      userId,
      enabled: next.enabled,
      pushTime: next.pushTime,
      outboundEnabled: next.outboundEnabled,
    });
    return next;
  }

  private async loadPreference(userId: number): Promise<DigestPreference> {
    const row: DigestPreferenceRow | null = await this.deps.repo.findPreference(userId);
    if (row == null) return { ...DEFAULT_DIGEST_PREFERENCE };
    return {
      enabled: Number(row.enabled) === 1,
      pushTime: row.pushTime,
      outboundEnabled: Number(row.outboundEnabled) === 1,
      lastDigestDate: row.lastDigestDate,
    };
  }
}

/** 偏好参数非法：继承 BusinessException(PARAM_INVALID)，经 handleError 转标准业务错误响应（HTTP 200 + code≠0）。 */
export class DigestPreferenceError extends BusinessException {
  constructor(message: string) {
    super(ErrorCode.PARAM_INVALID, message);
    this.name = 'DigestPreferenceError';
  }
}

/** 收件箱条目标题：「昨日运营摘要（MM-DD）」。 */
export function digestTitle(coveredDate: string): string {
  return `昨日运营摘要（${coveredDate.slice(5)}）`;
}

/**
 * 收件箱浓缩一行：只有有数据的板块；成本按成本单位（micros/1e6）展示。
 *
 * 每个板块的门控必须与 `aggregate` 的「板块非空」判定对称：板块非空就至少要产出
 * 一个片段，否则唯一事实恰好落在门控外时（如昨天只有哨兵被停用、零触发，或昨天
 * 只用了免费模型），整行会是空串——条目投递了但列表层没有任何摘要文字。
 * 成本板块的调用分三路：已配价（进合计）/ 未配价（cost_micros IS NULL）/ 0 价
 * （免费模型，两不沾），前两路各有片段，第三路靠 `calls` 兜底。
 */
export function renderDigestLine(data: DigestData): string {
  const parts: string[] = [];
  if (data.tasks != null) {
    if (data.tasks.completed > 0) parts.push(`完成 ${data.tasks.completed}`);
    if (data.tasks.failed > 0) parts.push(`失败 ${data.tasks.failed}`);
  }
  if (data.scheduled != null) {
    if (data.scheduled.total > 0) parts.push(`定时任务 ${data.scheduled.total} 次`);
    else if (data.scheduled.paused.length > 0) parts.push(`定时任务暂停 ${data.scheduled.paused.length} 个`);
  }
  if (data.watchers != null) {
    if (data.watchers.triggered > 0) parts.push(`哨兵触发 ${data.watchers.triggered}`);
    else if (data.watchers.disabled.length > 0) parts.push(`哨兵停用 ${data.watchers.disabled.length} 个`);
  }
  if (data.approvals != null) parts.push(`审批挂起 ${data.approvals.pending}`);
  if (data.cost != null) {
    if (data.cost.totalMicros > 0) parts.push(`成本 ${formatCostMicros(data.cost.totalMicros)}`);
    else if (data.cost.unpricedCalls > 0) parts.push(`未配价 ${data.cost.unpricedCalls} 次`);
    // 走到这里 = 有调用但合计 0 且无未配价 → 全部 0 价（免费模型），靠 calls 兜底产出片段
    else parts.push(`免费调用 ${data.cost.calls} 次`);
  }
  if (data.openApi != null) parts.push(`开放接口 ${data.openApi.total} 次`);
  return parts.join(' · ');
}

/** 出站订阅 text 字段：Markdown 全文（六板块，空板块不渲染）。 */
export function renderDigestMarkdown(data: DigestData): string {
  const lines: string[] = [`# 昨日运营摘要（${data.coveredDate}）`];
  if (data.tasks != null) {
    lines.push('', '## 任务', `- 完成 ${data.tasks.completed} 个，失败 ${data.tasks.failed} 个`);
    for (const item of data.tasks.failedTop) {
      lines.push(`- 失败：${item.title}${item.reason ? ` —— ${item.reason}` : ''}`);
    }
  }
  if (data.scheduled != null) {
    lines.push('', '## 定时任务',
      `- 执行 ${data.scheduled.total} 次（完成 ${data.scheduled.completed}，失败 ${data.scheduled.failed}）`);
    for (const item of data.scheduled.paused) lines.push(`- 已自动暂停：${item.name}`);
  }
  if (data.watchers != null) {
    lines.push('', '## 信号哨兵', `- 触发 ${data.watchers.triggered} 次`);
    for (const item of data.watchers.disabled) lines.push(`- 已自动停用：${item.name}`);
  }
  if (data.approvals != null) {
    lines.push('', '## 审批待办', `- 待处理 ${data.approvals.pending} 条`);
    for (const item of data.approvals.items) lines.push(`- ${item.title}`);
  }
  if (data.cost != null) {
    lines.push('', '## 成本',
      `- 合计 ${formatCostMicros(data.cost.totalMicros)}（成本单位）`,
      `- 共 ${data.cost.calls} 次调用`);
    for (const item of data.cost.top) lines.push(`- ${item.name}：${formatCostMicros(item.micros)}`);
    if (data.cost.unpricedCalls > 0) {
      lines.push(`- 另有 ${data.cost.unpricedCalls} 次调用未配价格，未计入合计`);
    }
  }
  if (data.openApi != null) {
    lines.push('', '## 开放接口',
      `- 调用 ${data.openApi.total} 次${data.openApi.rejected > 0 ? `，其中拒绝 ${data.openApi.rejected} 次` : ''}`);
  }
  return lines.join('\n');
}

/** micros（×10⁶ 整数）→ 成本单位展示值，最多 3 位小数（对齐前端 formatCost 口径）。 */
export function formatCostMicros(micros: number): string {
  const value = micros / 1_000_000;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

function clip(value: string | null | undefined, maxLength: number): string {
  if (value == null) return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

export type { DigestData };
