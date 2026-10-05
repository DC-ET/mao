import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { basename } from 'node:path';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import { STATUS_ENABLED } from '../harness/mcp/entity/mcp-server.js';
import { isValidSkillName } from '../harness/skill/skill-md.js';
import { readSkillFolderFiles } from '../skill/read-skill-files.js';
import type { SkillResult } from '../skill/user-skill.service.js';
import type { Agent } from './types.js';
import type { SharedAgentEntryRepository } from './shared-agent.repository.js';

/**
 * 共享目录自检/补装用用户技能能力（UserSkillService 已实现；name 为 SKILL.md frontmatter 名）。
 * listAllUserSkills 用于缺失技能的属主定位；installUserSkillFiles 用于一键补装落盘。
 */
export interface SharedAgentUserSkillLookup {
  listUserSkills(userId: number): Promise<Array<{ name: string; folderPath?: string | null }>> | Array<{ name: string; folderPath?: string | null }>;
  listAllUserSkills(): Promise<Array<{ name: string; userId: number; folderPath: string }>> | Array<{ name: string; userId: number; folderPath: string }>;
  installUserSkillFiles(userId: number, skillName: string, files: Record<string, string>): SkillResult<string>;
}

export interface SharedAgentVO {
  agentId: number;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  note: string;
  sortOrder: number;
  /** 远端来源（registry URL），非空时 admin 支持更新检查。 */
  sourceUrl: string | null;
  /** 既不在系统技能、也不在当前用户用户技能中的 skillNames。 */
  missingSkills: string[];
  /** 形如 "context7（已停用）" / "MCP#5（不存在）"。 */
  mcpIssues: string[];
}

/** 共享目录自检/修复用 MCP 能力（MysqlMcpServerLookup.findById + McpServerService.updateStatus 已实现）。 */
export interface SharedAgentMcpLookup {
  findById(id: number): Promise<{ id: number; name?: string | null; status?: string | null } | null>;
  /** 与 PUT /v1/mcp-servers/:id/status 同一 service 方法（不绕过校验）。 */
  updateStatus(id: number, status: string): Promise<void>;
}

export interface SharedAgentAgentLookup {
  findById(id: number): Promise<Agent | null>;
}

export type FixDepsSkillAction = 'installed' | 'ambiguous' | 'failed';
export type FixDepsMcpAction = 'enabled' | 'needs-admin' | 'dangling' | 'failed';

export interface FixDepsSkillEntry {
  name: string;
  action: FixDepsSkillAction;
  /** 成功/歧义时注明属主 userId（审计用）。 */
  ownerUserIds?: number[];
  detail?: string;
}

export interface FixDepsMcpEntry {
  serverId: number;
  name: string | null;
  action: FixDepsMcpAction;
  detail?: string;
}

/** POST /v1/shared-agents/:agentId/fix-deps 响应。 */
export interface FixDepsReport {
  skills: FixDepsSkillEntry[];
  mcpServers: FixDepsMcpEntry[];
  /** 处理后重算的该条目自检（前端直接替换行数据）。 */
  selfCheck: SharedAgentVO;
}

export const SHARED_NOTE_MAX_LENGTH = 512;
/** source_url 列宽 VARCHAR(1024)。 */
export const SHARED_SOURCE_URL_MAX_LENGTH = 1024;

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
    private readonly permissionChecker: { hasPermission(userId: number, code: string): Promise<boolean> },
  ) {}

  /** 上架/更新（upsert by agent_id）。停用 Agent 报 PARAM_INVALID；重复上架即更新。 */
  async putEntry(
    agentId: number,
    note: string | null | undefined,
    sortOrder: number | null | undefined,
    operatorId: number,
    sourceUrl?: string | null,
  ): Promise<void> {
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
    const source = normalizeSourceUrl(sourceUrl);
    await this.entryRepo.upsert(agentId, noteText, order, operatorId, source);
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
    const result: SharedAgentVO[] = [];
    for (const entry of entries) {
      const agent = await this.agentRepo.findById(entry.agentId);
      if (!agent || agent.enabled === 0) continue;
      result.push(await this.buildEntryVO(entry, agent, userId));
    }
    return result;
  }

  /** 单条目 VO + 自检（listSharedAgents 与 fixDependencies 共用）。 */
  private async buildEntryVO(
    entry: { agentId: number; note: string; sortOrder: number; sourceUrl?: string | null },
    agent: Agent,
    userId: number,
  ): Promise<SharedAgentVO> {
    // 运行时（SkillSync）、导出、导入全链路均按 SKILL.md frontmatter 名索引用户技能；
    // 自检必须同名口径，否则目录名≠frontmatter 名（上传不拦截）时会产生假缺失/假通过
    const userSkillNames = new Set((await this.userSkillLookup.listUserSkills(userId)).map((s) => s.name));
    return {
      agentId: entry.agentId,
      name: agent.name,
      description: agent.description ?? null,
      avatarUrl: agent.avatarUrl ?? null,
      note: entry.note,
      sortOrder: entry.sortOrder,
      sourceUrl: entry.sourceUrl ?? null,
      missingSkills: this.computeMissingSkills(agent, userSkillNames),
      mcpIssues: await this.computeMcpIssues(agent),
    };
  }

  /**
   * 依赖一键补装（P1）：缺失的用户技能自动安装到操作者本人名下；MCP 问题按可修性分类处理。
   * 前置：agentId 在共享目录且 Agent 启用。无缺失时幂等返回全空 actions + 当前自检。
   */
  async fixDependencies(agentId: number, operatorId: number): Promise<FixDepsReport> {
    const entry = await this.entryRepo.findByAgentId(agentId);
    if (!entry) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 不在团队共享目录');
    }
    const agent = await this.agentRepo.findById(agentId);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用，无法修复依赖');
    }

    // 技能补装：安装目标永远是操作者本人（不是共享条目属主），作用域天然收敛到本人目录
    const skills: FixDepsSkillEntry[] = [];
    const operatorSkills = await this.userSkillLookup.listUserSkills(operatorId);
    const userSkillNames = new Set(operatorSkills.map((s) => s.name));
    // skillNames 是 DB 自由文本数组，可能含历史重复项：同一技能只补装一次。若不去重，
    // 第二次处理同名条目时"本人刚装上"会让候选数从 1 变 2，输出 installed + ambiguous 矛盾报告
    const missingNames = [...new Set(parseNames(agent.skillNames))].filter(
      (name) => !this.skillLoader.hasSkill(name) && !(name.length > 0 && userSkillNames.has(name)),
    );
    // listAllUserSkills 是逐用户 readdir 的全量扫描：提到循环外一次获取。
    // 既消除 N+1 扫描，也避免"扫描结果随安装推进变化"造成的候选竞态
    const allUserSkills = missingNames.length > 0 ? await this.userSkillLookup.listAllUserSkills() : [];
    for (const name of missingNames) {
      skills.push(await this.installMissingSkill(name, operatorId, operatorSkills, allUserSkills));
    }

    // MCP 分类：dangling 无动作；停用态按操作者 mcp:write 分类（启用影响全局，等同 MCP 管理页手动启用）
    const mcpServers: FixDepsMcpEntry[] = [];
    for (const id of parseIds(agent.mcpServerIds)) {
      const server = await this.mcpLookup.findById(id).catch(() => null);
      if (server != null && server.status === STATUS_ENABLED) continue;
      mcpServers.push(await this.fixMcpIssue(id, server, operatorId));
    }

    const selfCheck = await this.buildEntryVO(entry, agent, operatorId);
    return { skills, mcpServers, selfCheck };
  }

  private async installMissingSkill(
    name: string,
    operatorId: number,
    operatorSkills: Array<{ name: string; folderPath?: string | null }>,
    allUserSkills: Array<{ name: string; userId: number; folderPath: string }>,
  ): Promise<FixDepsSkillEntry> {
    // skillNames 现状无格式校验：空串/路径片段会进 missingSkills（computeMissingSkills 对空串判缺失），
    // 用作目录名前必须校验，非法名不进入属主定位
    if (!isValidSkillName(name)) {
      return { name, action: 'failed', detail: `技能名非法，无法安装：${name}` };
    }
    // 目标目录占用检查：自检按 frontmatter 名判"缺失"，写盘按目录名落盘——上传侧不校验
    // "目录名 == frontmatter 名"，操作者已有的"目录 A、frontmatter 名 B"技能会让补装静默
    // 覆盖 A/（rename 备份在成功后即删除）。宁可报 failed 让人工整理，不覆盖既有技能
    const occupied = operatorSkills.find((s) => s.folderPath != null && basename(s.folderPath) === name);
    if (occupied != null) {
      return {
        name,
        action: 'failed',
        detail: `本人已存在同名技能目录「${name}」（其 frontmatter 名为「${occupied.name}」），为避免覆盖既有技能，请先在个人技能中删除「${occupied.name}」后重试`,
      };
    }
    const candidates = allUserSkills.filter((s) => s.name === name);
    if (candidates.length === 0) {
      return { name, action: 'failed', detail: '实例内已不存在该技能（可能已被删除）' };
    }
    // 多候选涵盖"不同用户同名技能"与"同一用户多个同名目录"两种形态（listAllUserSkills 按 folderPath 逐条返回）
    if (candidates.length > 1) {
      const ownerIds = [...new Set(candidates.map((c) => c.userId))];
      return {
        name,
        action: 'ambiguous',
        ownerUserIds: ownerIds,
        detail: `同名技能存在多个归属（${ownerIds.map((id) => `userId=${id}`).join('、')}），请联系管理员整理后重试`,
      };
    }
    const owner = candidates[0];
    let files: Record<string, string>;
    let warnings: string[];
    try {
      const read = readSkillFolderFiles(owner.folderPath, name);
      files = read.files;
      warnings = read.warnings;
    } catch (e) {
      return { name, action: 'failed', ownerUserIds: [owner.userId], detail: `读取属主技能文件失败：${(e as Error).message}` };
    }
    const result = this.userSkillLookup.installUserSkillFiles(operatorId, name, files);
    if (result.code !== 0) {
      return { name, action: 'failed', ownerUserIds: [owner.userId], detail: result.message };
    }
    const suffix = warnings.length > 0 ? `（${warnings.length} 个二进制文件未复制）` : '';
    return {
      name,
      action: 'installed',
      ownerUserIds: [owner.userId],
      detail: `已从属主 userId=${owner.userId} 复制安装${suffix}`,
    };
  }

  private async fixMcpIssue(id: number, server: { id: number; name?: string | null; status?: string | null } | null, operatorId: number): Promise<FixDepsMcpEntry> {
    if (server == null) {
      return { serverId: id, name: null, action: 'dangling', detail: '该 MCP 引用不存在，请在 Agent 编辑中移除后重新上架' };
    }
    const name = server.name ?? `MCP#${id}`;
    let canWrite = false;
    try {
      canWrite = await this.permissionChecker.hasPermission(operatorId, 'mcp:write');
    } catch {
      canWrite = false;
    }
    if (!canWrite) {
      return { serverId: id, name: server.name ?? null, action: 'needs-admin', detail: `MCP「${name}」已停用，需管理员在 MCP 管理页启用` };
    }
    try {
      await this.mcpLookup.updateStatus(id, STATUS_ENABLED);
      return { serverId: id, name: server.name ?? null, action: 'enabled', detail: `MCP「${name}」已启用` };
    } catch (e) {
      return { serverId: id, name: server.name ?? null, action: 'failed', detail: `启用失败：${(e as Error).message}` };
    }
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

/** source_url 校验：可省略；非空时须为 http(s) URL 且 ≤ 列宽，空串等价清除。 */
function normalizeSourceUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (text.length > SHARED_SOURCE_URL_MAX_LENGTH) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `远端来源最长 ${SHARED_SOURCE_URL_MAX_LENGTH} 字符`);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '远端来源必须是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '远端来源必须以 http:// 或 https:// 开头');
  }
  return text;
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
