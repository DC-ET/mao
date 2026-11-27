import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { harnessLog } from '../harness/log.js';
import {
  AGENT_REPORT_CATEGORIES,
  AGENT_REPORT_SEVERITIES,
  AGENT_REPORT_STATUSES,
  AgentReportRepository,
  type AgentReportCategory,
  type AgentReportRow,
  type AgentReportSeverity,
  type AgentReportStatus,
} from './agent-report.repository.js';

/** title 落库上限（VARCHAR(255) 留余量）；去重与 insert 同用截断后值。 */
export const AGENT_REPORT_TITLE_MAX_CHARS = 200;
/** detail 落库上限（TEXT 足够，截断防注入内容刷屏）。 */
export const AGENT_REPORT_DETAIL_MAX_CHARS = 8000;
/** 每会话终身累计上限（含已处置）：防刷屏硬闸，触顶后静默接受不再插库。 */
export const AGENT_REPORT_MAX_PER_SESSION = 20;

/** 状态机合法迁移：OPEN 可确认/解决/忽略；ACKNOWLEDGED 可解决/忽略；终态无出边。 */
const STATUS_TRANSITIONS: Record<AgentReportStatus, readonly AgentReportStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'],
  ACKNOWLEDGED: ['RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

/** 工具上报入参：session/user/agent 由服务端从执行上下文注入，模型入参里没有。 */
export interface ReportFromToolInput {
  sessionId: number | null;
  userId: number | null;
  agentId: number | null;
  category: string;
  title: string;
  severity?: string | null;
  detail?: string | null;
}

/**
 * 工具侧结果：invalid = 参数非法（错误文案回给模型修正）；accepted = 正常 ack
 * （含限流静默接受——不给模型可操纵的信号，防注入内容教唆换写法绕限流）。
 */
export type ReportFromToolResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: string };

export interface AgentReportPage {
  total: number;
  items: AgentReportRow[];
}

/** 按码点截断：UTF-16 slice 会把代理对（emoji）切成孤立代理落库。 */
function truncateByCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

export class AgentReportService {
  constructor(private readonly repository: AgentReportRepository) {}

  /**
   * report_issue 工具写入路径（§5.2）：
   * 校验 → 会话内去重（截断后 title）→ 每会话限流（超限静默接受 + warn）→ insert。
   */
  async reportFromTool(input: ReportFromToolInput): Promise<ReportFromToolResult> {
    if (input.sessionId == null || !Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
      // 会话内执行恒有 sessionId；此为防御分支（上报必须归属会话，与归因防伪同口径）。
      return { ok: false, error: '会话上下文缺失，无法上报' };
    }
    const category = input.category.trim();
    if (!(AGENT_REPORT_CATEGORIES as readonly string[]).includes(category)) {
      // 枚举是模型的契约：静默归 other 会掩盖模型/版本漂移，明确报错让它修正。
      return { ok: false, error: `无效的 category: ${category}，可选值：${AGENT_REPORT_CATEGORIES.join(' / ')}` };
    }
    const title = (input.title ?? '').trim();
    if (title === '') {
      return { ok: false, error: 'title 不能为空' };
    }
    const severityRaw = (input.severity ?? '').trim();
    // severity 是模型自评建议值：非法值回退 medium，不打断上报。
    const severity = (AGENT_REPORT_SEVERITIES as readonly string[]).includes(severityRaw)
      ? (severityRaw as AgentReportSeverity)
      : 'medium';
    const truncatedTitle = truncateByCodePoints(title, AGENT_REPORT_TITLE_MAX_CHARS);
    const detail = input.detail != null && input.detail.trim() !== ''
      ? truncateByCodePoints(input.detail.trim(), AGENT_REPORT_DETAIL_MAX_CHARS)
      : null;

    if (await this.repository.findDuplicate(input.sessionId, category, truncatedTitle)) {
      return { ok: true, duplicate: true };
    }
    const count = await this.repository.countBySession(input.sessionId);
    if (count >= AGENT_REPORT_MAX_PER_SESSION) {
      harnessLog('warn',
        `[agent-report] session=${input.sessionId} 上报触顶 ${AGENT_REPORT_MAX_PER_SESSION} 条，`
        + `静默丢弃：${category} ${truncatedTitle}`);
      return { ok: true, duplicate: false };
    }
    await this.repository.insert({
      sessionId: input.sessionId,
      userId: input.userId,
      agentId: input.agentId,
      category: category as AgentReportCategory,
      severity,
      title: truncatedTitle,
      detail,
    });
    return { ok: true, duplicate: false };
  }

  /** 状态统计条（各状态数量，含 0 态补全）。 */
  async summary(): Promise<{ byStatus: Record<AgentReportStatus, number>; openCount: number }> {
    const rows = await this.repository.countByStatus();
    const byStatus = Object.fromEntries(AGENT_REPORT_STATUSES.map((s) => [s, 0])) as Record<AgentReportStatus, number>;
    for (const row of rows) {
      if ((AGENT_REPORT_STATUSES as readonly string[]).includes(row.status)) {
        byStatus[row.status as AgentReportStatus] = Number(row.count);
      }
    }
    return { byStatus, openCount: byStatus.OPEN };
  }

  async pageList(filter: {
    status?: string;
    category?: string;
    severity?: string;
    startDate?: string;
    endDate?: string;
    page: number;
    pageSize: number;
  }): Promise<AgentReportPage> {
    const safePage = Math.max(1, Math.floor(filter.page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize)));
    const [total, items] = await Promise.all([
      this.repository.countTotal(filter),
      this.repository.pageList({
        ...filter,
        offset: (safePage - 1) * safePageSize,
        limit: safePageSize,
      }),
    ]);
    return { total, items };
  }

  async detail(id: number): Promise<AgentReportRow> {
    const row = await this.repository.selectById(id);
    if (row == null) throw new BusinessException(ErrorCode.AGENT_REPORT_NOT_FOUND);
    return row;
  }

  /**
   * 状态流转：目标态合法性 + 状态机出边在 service 校验；CAS 防并发双击
   * （影响行数 0 = 已被他人处置）。终态必须带备注与否由前端表单约束，后端不强制。
   */
  async updateStatus(operatorId: number, id: number, target: string, note: string | null): Promise<AgentReportRow> {
    const current = await this.detail(id);
    const targetStatus = target as AgentReportStatus;
    if (!(AGENT_REPORT_STATUSES as readonly string[]).includes(target)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `无效的状态: ${target}`);
    }
    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed.includes(targetStatus)) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `状态不可从 ${current.status} 流转到 ${targetStatus}`,
      );
    }
    const trimmedNote = note != null && note.trim() !== '' ? truncateByCodePoints(note.trim(), 2000) : null;
    // CAS 源态守卫用刚读出的当前态（防并发双击/终态复活）——勿传 allowed（那是合法目标态列表），
    // 传错则 CAS 永不命中（评审 P0：处置链路全失败）。
    const updated = await this.repository.updateStatus(id, targetStatus, [current.status], operatorId, trimmedNote);
    if (updated === 0) {
      throw new BusinessException(ErrorCode.AGENT_REPORT_ALREADY_RESOLVED);
    }
    return this.detail(id);
  }
}
