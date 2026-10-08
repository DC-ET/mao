import { harnessLog } from '../harness/log.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { ApprovalHint, ApprovalRuleFacade, ApprovalRuleMatchHit } from '../harness/approval/approval-hint.js';
import {
  APPROVAL_RULE_DENY_TOKENS_SEED,
  APPROVAL_RULE_TYPES,
  MCP_TOOL_NAME_MAX_LENGTH,
  RULE_VALUE_MAX_LENGTH,
  buildApprovalHint,
  buildShellPrefixValue,
  buildShellRuleCandidates,
  containsDenyToken,
  matchesShellPrefix,
  normalizeShellCommand,
  tokenizeCommand,
} from './approval-rule-normalize.js';
import type { ApprovalRuleRepository } from './approval-rule.repository.js';
import type { ApprovalRuleAdminFilter, ApprovalRuleAdminPage, ApprovalRuleRow, ApprovalRuleScope, ApprovalRuleType, ApprovalRuleVo } from './types.js';

const MCP_TOOL_PREFIX = 'mcp__';
/** denyTokens 设置键（admin 系统设置「审批」分组可编辑，逗号分隔）。 */
export const DENY_TOKENS_SETTING_KEY = 'approval.rule.denyTokens';

/** denylist token 来源：内置种子 + system_setting 扩展。 */
export interface DenyTokenReader {
  getValue(key: string): Promise<string | null>;
}

/** alwaysAllow 落规则所需的会话归属解析（不引入 session 域完整依赖）。 */
export interface ApprovalRuleSessionLookup {
  getUserId(sessionId: number): Promise<number | null>;
}

export interface ApprovalRuleUserCreateInput {
  ruleType: string;
  ruleValue: string;
}

export interface ApprovalRuleUserUpdateInput {
  enabled?: boolean | null;
  ruleValue?: string | null;
}

function isApprovalRuleType(v: string): v is ApprovalRuleType {
  return (APPROVAL_RULE_TYPES as readonly string[]).includes(v);
}

export class ApprovalRuleService implements ApprovalRuleFacade {
  constructor(
    private readonly repo: ApprovalRuleRepository,
    private readonly denyTokenReader: DenyTokenReader,
    private readonly sessionLookup: ApprovalRuleSessionLookup,
  ) {}

  /** 内置种子 + admin 扩展 token（设置值逗号分隔，trim 去空去重）。读取失败退化为种子（便利性功能，不能因配置故障阻断审批链）。 */
  private async denyTokens(): Promise<string[]> {
    const tokens = new Set<string>(APPROVAL_RULE_DENY_TOKENS_SEED);
    try {
      const raw = await this.denyTokenReader.getValue(DENY_TOKENS_SETTING_KEY);
      if (raw != null && raw.trim() !== '') {
        for (const t of raw.split(',')) {
          const token = t.trim();
          if (token !== '') tokens.add(token);
        }
      }
    } catch (e) {
      harnessLog('warn', `Failed to read ${DENY_TOKENS_SETTING_KEY}, falling back to seed denylist: ${(e as Error).message}`);
    }
    return [...tokens];
  }

  /** 请求侧候选规则值：shell → EXACT（归一化全命令）+ PREFIX（前两 token）；mcp__ → 工具全名。 */
  private candidatesFor(toolName: string, argumentsJson: string): Array<{ ruleType: ApprovalRuleType; ruleValue: string }> {
    if (toolName === 'shell') {
      return buildShellRuleCandidates(argumentsJson);
    }
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      return [{ ruleType: 'MCP_TOOL', ruleValue: toolName.slice(0, MCP_TOOL_NAME_MAX_LENGTH) }];
    }
    return [];
  }

  private rowEquals(row: ApprovalRuleRow, candidate: { ruleType: ApprovalRuleType; ruleValue: string }): boolean {
    if (row.ruleType === 'SHELL_EXACT' && candidate.ruleType === 'SHELL_EXACT') {
      return row.ruleValue === candidate.ruleValue;
    }
    if (row.ruleType === 'MCP_TOOL' && candidate.ruleType === 'MCP_TOOL') {
      return row.ruleValue === candidate.ruleValue;
    }
    return false;
  }

  private rowPrefixMatches(row: ApprovalRuleRow, candidates: Array<{ ruleType: ApprovalRuleType; ruleValue: string }>): boolean {
    if (row.ruleType !== 'SHELL_PREFIX') return false;
    const exact = candidates.find((c) => c.ruleType === 'SHELL_EXACT');
    return exact != null && matchesShellPrefix(exact.ruleValue, row.ruleValue);
  }

  /**
   * 规则匹配：denylist 全命令扫描 → 会话级优先于用户级 → 同级内更窄类型优先（候选顺序 EXACT→PREFIX）。
   * 匹配请求按归一化后命令比对（与 rule_value 生成口径一致）。
   */
  async match(input: {
    userId: number | null;
    sessionId: number | null;
    toolName: string;
    argumentsJson: string;
  }): Promise<ApprovalRuleMatchHit | null> {
    try {
      const { userId, sessionId, toolName, argumentsJson } = input;
      if (userId == null) return null;
      const candidates = this.candidatesFor(toolName, argumentsJson);
      if (candidates.length === 0) return null;
      // denylist 匹配拒绝：即使规则已存在，含 deny token 的请求规则失效、走正常审批
      // （candidates[0] 对 shell 是归一化全命令、对 MCP 是工具全名，均为全量扫描对象）
      if (await this.hasDenyToken(candidates[0].ruleValue)) return null;
      const rows = await this.repo.listEnabledForMatch(userId, sessionId);
      // 优先级：会话级优先于用户级；同级内更窄语义优先（EXACT/MCP 全等 → PREFIX 词边界前缀）
      for (const scope of ['SESSION', 'USER'] as const) {
        const scoped = rows.filter((row) => row.scope === scope);
        for (const candidate of candidates) {
          const exactHit = scoped.find((row) => this.rowEquals(row, candidate));
          if (exactHit) {
            return { ruleId: exactHit.id, ruleValue: exactHit.ruleValue };
          }
        }
        for (const row of scoped) {
          if (this.rowPrefixMatches(row, candidates)) {
            return { ruleId: row.id, ruleValue: row.ruleValue };
          }
        }
      }
      return null;
    } catch (e) {
      // 规则是放行优化，任何故障都必须退回原审批链（弹卡），绝不能因故障放行或阻断
      harnessLog('warn', `Approval rule match failed, falling back to normal approval: ${(e as Error).message}`);
      return null;
    }
  }

  /** 规则命中计数：fire-and-forget，失败只记日志（计数不准不影响放行）。 */
  recordHit(ruleId: number): void {
    void this.repo.incrementHit(ruleId).catch((e) => {
      harnessLog('warn', `Failed to increment approval rule hit count (ruleId=${ruleId}): ${(e as Error).message}`);
    });
  }

  async buildHint(toolName: string, argumentsJson: string): Promise<ApprovalHint | null> {
    try {
      return buildApprovalHint(toolName, argumentsJson, await this.denyTokens());
    } catch (e) {
      harnessLog('warn', `Failed to build approval hint: ${(e as Error).message}`);
      return null;
    }
  }

  private async hasDenyToken(command: string): Promise<boolean> {
    return containsDenyToken(command, await this.denyTokens());
  }

  /**
   * alwaysAllow 落会话级规则：从 ApprovalRegistry 取回的服务端 hint（客户端只能回传布尔，
   * 不能注入 pattern）。按 (session_id, rule_type, rule_value) 查重幂等——tool_approval 帧
   * 断线重试可能重发，同值只建一条。
   */
  async createSessionRuleFromAlwaysAllow(userId: number, sessionId: number, hint: ApprovalHint): Promise<void> {
    if (!isApprovalRuleType(hint.ruleType)) return;
    const ruleValue = hint.ruleValue.trim().slice(0, RULE_VALUE_MAX_LENGTH);
    if (ruleValue === '') return;
    // 归属以会话 owner 为准（与规则匹配的执行用户口径一致；桌面普通会话两者恒一致）
    const ownerId = await this.sessionLookup.getUserId(sessionId);
    if (ownerId == null || ownerId !== userId) return;
    const existing = await this.repo.findBySessionAndValue(sessionId, hint.ruleType, ruleValue);
    if (existing) return;
    await this.repo.insert({
      userId: ownerId,
      scope: 'SESSION',
      sessionId,
      ruleType: hint.ruleType,
      ruleValue,
    });
    harnessLog('info', `Approval rule created via always-allow: sessionId=${sessionId}, ruleType=${hint.ruleType}, ruleValue=${ruleValue}`);
  }

  // ---------- 用户级 CRUD（设置页） ----------

  private toVo(row: ApprovalRuleRow): ApprovalRuleVo {
    return {
      id: row.id,
      scope: row.scope,
      sessionId: row.sessionId,
      ruleType: row.ruleType,
      ruleValue: row.ruleValue,
      hitCount: Number(row.hitCount ?? 0),
      lastHitAt: row.lastHitAt,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** 归一化用户输入并做 denylist 校验；返回 (type, 归一化后的 value)。非法输入抛 PARAM_INVALID。 */
  private async normalizeUserInput(ruleType: string, rawValue: string): Promise<{ ruleType: ApprovalRuleType; ruleValue: string }> {
    if (!isApprovalRuleType(ruleType)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'ruleType 必须是 SHELL_PREFIX / SHELL_EXACT / MCP_TOOL');
    }
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'ruleValue 不能为空');
    }
    let ruleValue: string;
    if (ruleType === 'SHELL_PREFIX') {
      // 用户输入同样执行「前两 token」归一化：输入 git push origin main 存为 git push
      ruleValue = buildShellPrefixValue(normalizeShellCommand(rawValue));
    } else if (ruleType === 'SHELL_EXACT') {
      ruleValue = normalizeShellCommand(rawValue);
    } else {
      ruleValue = rawValue.trim().slice(0, MCP_TOOL_NAME_MAX_LENGTH);
      if (!ruleValue.startsWith(MCP_TOOL_PREFIX)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP_TOOL 规则值必须以 mcp__ 开头（工具全名）');
      }
    }
    if (ruleValue === '' || ruleValue.length > RULE_VALUE_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `ruleValue 长度必须在 1～${RULE_VALUE_MAX_LENGTH} 之间`);
    }
    if (tokenizeCommand(ruleValue).length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'ruleValue 不能为空');
    }
    if (await this.hasDenyToken(ruleValue)) {
      throw new BusinessException(ErrorCode.APPROVAL_RULE_VALUE_INVALID, '规则值包含受保护命令（denylist），不允许创建放行规则');
    }
    return { ruleType, ruleValue };
  }

  async listUserRules(
    userId: number,
    options: { scope?: ApprovalRuleScope | null; ruleType?: ApprovalRuleType | null; includeSession?: boolean; sessionId?: number | null; page?: number; pageSize?: number },
  ): Promise<{ records: ApprovalRuleVo[]; total: number }> {
    const scope = options.scope ?? 'USER';
    const ruleType = options.ruleType ?? null;
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
    const [rows, total] = await Promise.all([
      this.repo.listByUser(userId, scope, ruleType, pageSize, (page - 1) * pageSize),
      this.repo.countByUser(userId, scope, ruleType),
    ]);
    let records = rows.map((row) => this.toVo(row));
    // 可选：附带当前会话的 SESSION 规则（仅查看；SESSION 规则不经此路由管理）
    if (options.includeSession === true && options.sessionId != null) {
      const sessionRows = await this.repo.listEnabledForMatch(userId, options.sessionId);
      records = [
        ...records,
        ...sessionRows.filter((row) => row.scope === 'SESSION' && (ruleType == null || row.ruleType === ruleType)).map((row) => this.toVo(row)),
      ];
      // 附带的会话规则不在分页口径内：total 与列表都以合并去重后的结果为准，
      // 否则 scope=SESSION + includeSession 会同一规则重复出现、total 也与 records 矛盾
      const seen = new Set<number>();
      records = records.filter((record) => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      });
      return { records, total: records.length };
    }
    return { records, total };
  }

  async createUserRule(userId: number, input: ApprovalRuleUserCreateInput): Promise<ApprovalRuleVo> {
    const { ruleType, ruleValue } = await this.normalizeUserInput(input.ruleType, input.ruleValue);
    const id = await this.repo.insert({ userId, scope: 'USER', sessionId: null, ruleType, ruleValue });
    const row = await this.repo.findById(id);
    if (!row) throw new BusinessException(ErrorCode.INTERNAL_ERROR, '审批规则创建失败');
    return this.toVo(row);
  }

  /** 他人规则 / SESSION 规则一律 404（不暴露存在性；SESSION 规则不经此路由管理）。 */
  private async findOwnedUserRule(userId: number, id: number): Promise<ApprovalRuleRow> {
    const row = await this.repo.findById(id);
    if (!row || row.userId !== userId || row.scope !== 'USER') {
      throw new BusinessException(ErrorCode.APPROVAL_RULE_NOT_FOUND);
    }
    return row;
  }

  async updateUserRule(userId: number, id: number, input: ApprovalRuleUserUpdateInput): Promise<ApprovalRuleVo> {
    const row = await this.findOwnedUserRule(userId, id);
    const hasEnabled = typeof input.enabled === 'boolean';
    const hasValue = typeof input.ruleValue === 'string' && input.ruleValue !== '';
    if (!hasEnabled && !hasValue) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '至少提供 enabled 或 ruleValue 之一');
    }
    if (hasValue) {
      const normalized = await this.normalizeUserInput(row.ruleType, input.ruleValue!);
      await this.repo.updateValue(id, normalized.ruleType, normalized.ruleValue);
    }
    if (hasEnabled) {
      await this.repo.updateEnabled(id, input.enabled!);
    }
    const updated = await this.repo.findById(id);
    if (!updated) throw new BusinessException(ErrorCode.APPROVAL_RULE_NOT_FOUND);
    return this.toVo(updated);
  }

  async removeUserRule(userId: number, id: number): Promise<void> {
    await this.findOwnedUserRule(userId, id);
    await this.repo.deleteById(id);
  }

  // ---------- admin 只读清单 ----------

  async adminPage(filter: Omit<ApprovalRuleAdminFilter, 'page' | 'size'> & { page: number; size: number }): Promise<ApprovalRuleAdminPage> {
    return this.repo.pageAdmin(filter);
  }
}
