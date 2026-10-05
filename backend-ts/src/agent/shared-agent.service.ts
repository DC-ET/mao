import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import { STATUS_ENABLED } from '../harness/mcp/entity/mcp-server.js';
import type { Agent } from './types.js';
import type { SharedAgentEntryRepository } from './shared-agent.repository.js';

/** 共享目录自检用用户技能查询能力（UserSkillService 已实现；name 为 SKILL.md frontmatter 名）。 */
export interface SharedAgentUserSkillLookup {
  listUserSkills(userId: number): Promise<Array<{ name: string }>> | Array<{ name: string }>;
}

export interface SharedAgentVO {
  agentId: number;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  note: string;
  sortOrder: number;
  /** 既不在系统技能、也不在当前用户用户技能中的 skillNames。 */
  missingSkills: string[];
  /** 形如 "context7（已停用）" / "MCP#5（不存在）"。 */
  mcpIssues: string[];
}

/** 共享目录自检用 MCP 最小查询能力（MysqlMcpServerLookup 已实现）。 */
export interface SharedAgentMcpLookup {
  findById(id: number): Promise<{ id: number; name?: string | null; status?: string | null } | null>;
}

export interface SharedAgentAgentLookup {
  findById(id: number): Promise<Agent | null>;
}

export const SHARED_NOTE_MAX_LENGTH = 512;

/**
 * 团队共享目录（Agent 资产化 P2）：管理员上架/下架 + 按当前用户实时计算依赖自检。
 * 共享目录不改变 Agent 可见性（GET /v1/agents 本就全员可读）；价值是管理员背书、排序与说明、依赖自检。
 */
export class SharedAgentService {
  constructor(
    private readonly entryRepo: SharedAgentEntryRepository,
    private readonly agentRepo: SharedAgentAgentLookup,
    private readonly skillLoader: SkillLoader,
    private readonly userSkillLookup: SharedAgentUserSkillLookup,
    private readonly mcpLookup: SharedAgentMcpLookup,
  ) {}

  /** 上架/更新（upsert by agent_id）。停用 Agent 报 PARAM_INVALID；重复上架即更新。 */
  async putEntry(agentId: number, note: string | null | undefined, sortOrder: number | null | undefined, operatorId: number): Promise<void> {
    const agent = await this.agentRepo.findById(agentId);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '请先启用该 Agent');
    }
    const noteText = typeof note === 'string' ? note : '';
    if (noteText.length > SHARED_NOTE_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `推荐语最长 ${SHARED_NOTE_MAX_LENGTH} 字`);
    }
    // INT 列宽边界：超出直接 PARAM_INVALID，避免落库时 DB 报错变 500
    let order = 0;
    if (sortOrder != null) {
      const n = Number(sortOrder);
      if (!Number.isSafeInteger(n) || Math.abs(n) > 2147483647) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '排序值必须为 32 位整数');
      }
      order = n;
    }
    await this.entryRepo.upsert(agentId, noteText, order, operatorId);
  }

  /** 下架（幂等；条目不存在时静默成功）。 */
  async removeEntry(agentId: number): Promise<void> {
    await this.entryRepo.deleteByAgentId(agentId);
  }

  /**
   * 条目列表 + 按当前用户计算的依赖自检（服务端实时计算，前端零额外请求）。
   * 已删除/停用的 Agent 不返回（条目保留，重新启用即恢复展示）。
   */
  async listSharedAgents(userId: number): Promise<SharedAgentVO[]> {
    const entries = await this.entryRepo.listAll();
    // 运行时（SkillSync）、导出、导入全链路均按 SKILL.md frontmatter 名索引用户技能；
    // 自检必须同名口径，否则目录名≠frontmatter 名（上传不拦截）时会产生假缺失/假通过
    const userSkillNames = new Set((await this.userSkillLookup.listUserSkills(userId)).map((s) => s.name));
    const result: SharedAgentVO[] = [];
    for (const entry of entries) {
      const agent = await this.agentRepo.findById(entry.agentId);
      if (!agent || agent.enabled === 0) continue;
      result.push({
        agentId: entry.agentId,
        name: agent.name,
        description: agent.description ?? null,
        avatarUrl: agent.avatarUrl ?? null,
        note: entry.note,
        sortOrder: entry.sortOrder,
        missingSkills: this.computeMissingSkills(agent, userSkillNames),
        mcpIssues: await this.computeMcpIssues(agent),
      });
    }
    return result;
  }

  /** 技能自检：系统技能存在 → 通过；当前用户已安装（frontmatter 名匹配）→ 通过；否则缺失。 */
  private computeMissingSkills(agent: Agent, userSkillNames: Set<string>): string[] {
    const names = parseNames(agent.skillNames);
    if (names.length === 0) return [];
    const missing: string[] = [];
    for (const name of names) {
      if (this.skillLoader.hasSkill(name)) continue;
      // skillNames 现状无格式校验，含路径片段的名字在 Set 匹配中天然不命中，判缺失
      if (name.length > 0 && userSkillNames.has(name)) continue;
      missing.push(name);
    }
    return missing;
  }

  /** MCP 自检：全局 server 存在且 ENABLED → 通过；停用/不存在进 mcpIssues。 */
  private async computeMcpIssues(agent: Agent): Promise<string[]> {
    const ids = parseIds(agent.mcpServerIds);
    if (ids.length === 0) return [];
    const issues: string[] = [];
    for (const id of ids) {
      const server = await this.mcpLookup.findById(id).catch(() => null);
      if (server == null) {
        issues.push(`MCP#${id}（不存在）`);
        continue;
      }
      if (server.status !== STATUS_ENABLED) {
        issues.push(`${server.name ?? `MCP#${id}`}（已停用）`);
      }
    }
    return issues;
  }
}

function parseNames(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function parseIds(raw: string | null | undefined): number[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => Number.isSafeInteger(v));
  } catch {
    return [];
  }
}
