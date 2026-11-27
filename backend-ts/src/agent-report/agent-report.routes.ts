import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { AgentReportService } from './agent-report.service.js';
import {
  AGENT_REPORT_CATEGORIES,
  AGENT_REPORT_SEVERITIES,
  AGENT_REPORT_STATUSES,
  type AgentReportCategory,
  type AgentReportSeverity,
  type AgentReportStatus,
} from './agent-report.repository.js';

export interface AgentReportRouteDeps {
  jwt: JwtService;
  agentReport: AgentReportService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface StatusBody {
  status?: unknown;
  note?: unknown;
}

const CATEGORY_SET = new Set<string>(AGENT_REPORT_CATEGORIES);
const SEVERITY_SET = new Set<string>(AGENT_REPORT_SEVERITIES);
const STATUS_SET = new Set<string>(AGENT_REPORT_STATUSES);

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.floor(Number(query.page ?? 1));
  const pageSize = Math.floor(Number(query.pageSize ?? 20));
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
  };
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

function parseId(value: string): number {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/**
 * Agent 静默问题上报（技术方案 2026-11-27 agent-issue-report）：管理端只读列表/详情 +
 * 状态处置。上报写入不经 HTTP（report_issue 工具服务端直插，见 agent-report.service）。
 */
export function registerAgentReportRoutes(app: FastifyInstance, deps: AgentReportRouteDeps): void {
  // 状态统计条（列表页顶部常显，各状态数量）
  app.get('/v1/agent-report/admin/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'agent-report:read');
    sendJson(reply, 200, ok(await deps.agentReport.summary()));
  });

  // 分页列表（状态 / 类别 / 级别 / 时间区间筛选）
  app.get('/v1/agent-report/admin/list', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'agent-report:read');
    const query = req.query as Record<string, unknown>;
    const page = parsePagination(query);
    const result = await deps.agentReport.pageList({
      status: typeof query.status === 'string' && STATUS_SET.has(query.status) ? query.status as AgentReportStatus : undefined,
      category: typeof query.category === 'string' && CATEGORY_SET.has(query.category) ? query.category as AgentReportCategory : undefined,
      severity: typeof query.severity === 'string' && SEVERITY_SET.has(query.severity) ? query.severity as AgentReportSeverity : undefined,
      startDate: parseDate(query.startDate),
      endDate: parseDate(query.endDate),
      page: page.page,
      pageSize: page.pageSize,
    });
    sendJson(reply, 200, ok(result));
  });

  // 详情（含 detail 全文，前端纯文本渲染）。非法 id 收敛为 0 → detail 抛 NOT_FOUND。
  app.get('/v1/agent-report/admin/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'agent-report:read');
    const id = parseId((req.params as { id: string }).id);
    sendJson(reply, 200, ok(await deps.agentReport.detail(id)));
  });

  // 状态流转：确认 / 解决 / 忽略（状态机合法性在 service 校验）
  app.put('/v1/agent-report/admin/:id/status', async (req, reply) => {
    const operatorId = await requireRequestPermission(deps.permissionService, req, 'agent-report:write');
    const id = parseId((req.params as { id: string }).id);
    const body = (req.body ?? {}) as StatusBody;
    const status = typeof body.status === 'string' ? body.status : '';
    const note = typeof body.note === 'string' ? body.note : null;
    sendJson(reply, 200, ok(await deps.agentReport.updateStatus(operatorId, id, status, note)));
  });
}
