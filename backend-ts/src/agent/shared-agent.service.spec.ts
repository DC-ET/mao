import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { AgentService } from './agent.service.js';
import { SharedAgentService } from './shared-agent.service.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import type { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import type { Agent } from './types.js';

/** 模拟 shared_agent_entry 表：upsert（唯一键 agent_id）+ 排序同 SQL 口径。 */
class MemoryEntryRepo {
  rows = new Map<number, { agentId: number; note: string; sortOrder: number; createdBy: number; sourceUrl: string | null }>();

  async findByAgentId(agentId: number) {
    return [...this.rows.values()].find((r) => r.agentId === agentId) ?? null;
  }

  async listAll() {
    return [...this.rows.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.agentId - b.agentId)
      .map((r) => ({ ...r, id: r.agentId, createdAt: null, updatedAt: null }));
  }

  async upsert(agentId: number, note: string, sortOrder: number, createdBy = 1, sourceUrl: string | null = null) {
    const existing = await this.findByAgentId(agentId);
    if (existing) {
      existing.note = note;
      existing.sortOrder = sortOrder;
      existing.sourceUrl = sourceUrl;
    } else {
      this.rows.set(agentId, { agentId, note, sortOrder, createdBy, sourceUrl });
    }
  }

  async deleteByAgentId(agentId: number): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.agentId === agentId) this.rows.delete(key);
    }
  }
}

function validSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: 测试\n---\n正文\n`;
}

describe('SharedAgentService', () => {
  let root: string;
  let skillsDir: string;
  let userSkillsDir: string;
  let skillLoader: SkillLoader;
  let userSkillService: UserSkillService;
  let entryRepo: MemoryEntryRepo;
  let agentRows: Map<number, Agent>;
  let mcpRows: Map<number, { id: number; name: string; status: string }>;
  let updateStatus: ReturnType<typeof vi.fn>;
  let permission: { hasPermission: ReturnType<typeof vi.fn> };
  let service: SharedAgentService;
  const OPERATOR = 9;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-shared-'));
    skillsDir = join(root, 'skills');
    userSkillsDir = join(root, 'userskills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
    skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    userSkillService = new UserSkillService(userSkillsDir);
    entryRepo = new MemoryEntryRepo();
    agentRows = new Map();
    mcpRows = new Map();
    updateStatus = vi.fn(async (id: number, status: string) => {
      const row = mcpRows.get(id);
      if (row) row.status = status;
    });
    permission = { hasPermission: vi.fn(async () => false) };
    service = new SharedAgentService(
      entryRepo as never,
      // 模拟 MysqlAgentRepository.findById：deleted = 0 过滤
      { findById: async (id: number) => {
          const a = agentRows.get(id);
          return a && a.deleted !== 1 ? a : null;
        } },
      skillLoader,
      userSkillService,
      { findById: async (id: number) => mcpRows.get(id) ?? null, updateStatus },
      permission,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function putAgent(id: number, agent: Partial<Agent>): void {
    agentRows.set(id, { id, name: `A${id}`, systemPrompt: 'p', enabled: 1, ...agent } as Agent);
  }

  it('上架校验：Agent 不存在报 AGENT_NOT_FOUND；停用 Agent 报"请先启用"', async () => {
    await expect(service.putEntry(404, 'note', 0, OPERATOR)).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_FOUND.code });
    putAgent(1, { enabled: 0 });
    await expect(service.putEntry(1, 'note', 0, OPERATOR)).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
      message: expect.stringContaining('请先启用'),
    });
    expect(entryRepo.rows.size).toBe(0);
  });

  it('推荐语超 512 字报错；upsert 重复上架即更新 note/sortOrder', async () => {
    putAgent(1);
    await expect(service.putEntry(1, 'n'.repeat(513), 0, OPERATOR)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    await service.putEntry(1, '第一版推荐语', 5, OPERATOR);
    expect(await entryRepo.findByAgentId(1)).toMatchObject({ note: '第一版推荐语', sortOrder: 5, createdBy: OPERATOR });

    await service.putEntry(1, '第二版推荐语', 2, 99);
    expect(await entryRepo.findByAgentId(1)).toMatchObject({ note: '第二版推荐语', sortOrder: 2 });
    expect(entryRepo.rows.size).toBe(1);
  });

  it('排序值超出 INT 范围或非整数报 PARAM_INVALID（不落库不 500）', async () => {
    putAgent(1);
    for (const bad of [2147483648, -2147483649, Number.NaN, 1.5]) {
      await expect(service.putEntry(1, 'note', bad as number, OPERATOR))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    }
    expect(entryRepo.rows.size).toBe(0);
  });

  it('下架幂等', async () => {
    putAgent(1);
    await service.putEntry(1, 'note', 0, OPERATOR);
    await service.removeEntry(1);
    expect(await entryRepo.findByAgentId(1)).toBeNull();
    await expect(service.removeEntry(1)).resolves.toBeUndefined();
  });

  it('自检：系统技能通过；仅当前用户安装的用户技能通过；他人技能进 missingSkills', async () => {
    mkdirSync(join(skillsDir, 'sys-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'sys-skill', 'SKILL.md'), validSkillMd('sys-skill'));
    mkdirSync(join(userSkillsDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userSkillsDir, '7', 'mine', 'SKILL.md'), validSkillMd('mine'));
    mkdirSync(join(userSkillsDir, '8', 'theirs'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'theirs', 'SKILL.md'), validSkillMd('theirs'));
    skillLoader.invalidateCache();

    putAgent(1, { skillNames: JSON.stringify(['sys-skill', 'mine', 'theirs', 'nope']) });
    await service.putEntry(1, 'note', 0, OPERATOR);
    const list = await service.listSharedAgents(7);
    expect(list[0].missingSkills).toEqual(['theirs', 'nope']);

    const listFor8 = await service.listSharedAgents(8);
    expect(listFor8[0].missingSkills).toEqual(['mine', 'nope']);
  });

  it('自检按 SKILL.md frontmatter 名匹配用户技能（目录名≠frontmatter 名不产生假缺失）', async () => {
    // 目录 holder 内的技能 frontmatter 名是 mine-alias；运行时按 frontmatter 名索引
    mkdirSync(join(userSkillsDir, '7', 'holder'), { recursive: true });
    writeFileSync(join(userSkillsDir, '7', 'holder', 'SKILL.md'), validSkillMd('mine-alias'));
    putAgent(1, { skillNames: JSON.stringify(['mine-alias']) });
    await service.putEntry(1, 'note', 0, OPERATOR);

    const list = await service.listSharedAgents(7);
    expect(list[0].missingSkills).toEqual([]);

    // 他人视角仍缺失
    const listFor8 = await service.listSharedAgents(8);
    expect(listFor8[0].missingSkills).toEqual(['mine-alias']);
  });

  it('自检：MCP 停用进 mcpIssues（已停用），不存在用 id 表示；启用通过', async () => {
    mcpRows.set(11, { id: 11, name: 'context7', status: 'DISABLED' });
    mcpRows.set(12, { id: 12, name: 'live', status: 'ENABLED' });
    putAgent(1, { mcpServerIds: JSON.stringify([11, 12, 13]) });
    await service.putEntry(1, 'note', 0, OPERATOR);
    const list = await service.listSharedAgents(7);
    expect(list[0].mcpIssues).toEqual(['context7（已停用）', 'MCP#13（不存在）']);
  });

  it('已删除 / 停用的 Agent 不出现在共享列表（条目保留，重新启用即恢复）', async () => {
    putAgent(1, { enabled: 1 });
    putAgent(2, { enabled: 1 });
    putAgent(3, { enabled: 1 });
    await service.putEntry(1, 'a', 0, OPERATOR);
    await service.putEntry(2, 'b', 0, OPERATOR);
    await service.putEntry(3, 'c', 0, OPERATOR);
    // 上架后停用：条目保留，但列表不再展示；删除后同样隐藏
    agentRows.set(2, { ...agentRows.get(2)!, enabled: 0 });
    agentRows.set(3, { ...agentRows.get(3)!, deleted: 1 });

    expect((await service.listSharedAgents(7)).map((v) => v.agentId)).toEqual([1]);
    agentRows.set(2, { ...agentRows.get(2)!, enabled: 1 });
    expect((await service.listSharedAgents(7)).map((v) => v.agentId)).toEqual([1, 2]);
  });

  it('排序：sortOrder asc, agentId asc', async () => {
    putAgent(2);
    putAgent(1);
    putAgent(3);
    await service.putEntry(2, 'b', 1, OPERATOR);
    await service.putEntry(1, 'a', 1, OPERATOR);
    await service.putEntry(3, 'c', 0, OPERATOR);
    expect((await service.listSharedAgents(7)).map((v) => v.agentId)).toEqual([3, 1, 2]);
  });

  it('上架可携带 source_url；VO 回显', async () => {
    putAgent(1);
    await service.putEntry(1, 'note', 0, OPERATOR, 'http://other.example.com/api/v1/agent-bundle/registry/1');
    expect((await service.listSharedAgents(7))[0].sourceUrl).toBe('http://other.example.com/api/v1/agent-bundle/registry/1');
    await service.putEntry(1, 'note', 0, OPERATOR, '');
    expect((await service.listSharedAgents(7))[0].sourceUrl).toBeNull();
  });

  it('source_url 非法（非 http/超长）报 PARAM_INVALID', async () => {
    putAgent(1);
    await expect(service.putEntry(1, 'note', 0, OPERATOR, 'ftp://x.com/a')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.putEntry(1, 'note', 0, OPERATOR, 'not a url')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.putEntry(1, 'note', 0, OPERATOR, `http://x.com/${'a'.repeat(1100)}`)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });
});

describe('SharedAgentService.fixDependencies（依赖一键补装）', () => {
  let root: string;
  let skillsDir: string;
  let userSkillsDir: string;
  let skillLoader: SkillLoader;
  let userSkillService: UserSkillService;
  let entryRepo: MemoryEntryRepo;
  let agentRows: Map<number, Agent>;
  let mcpRows: Map<number, { id: number; name: string; status: string }>;
  let updateStatus: ReturnType<typeof vi.fn>;
  let permission: { hasPermission: ReturnType<typeof vi.fn> };
  let service: SharedAgentService;
  const OPERATOR = 9;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-fixdeps-'));
    skillsDir = join(root, 'skills');
    userSkillsDir = join(root, 'userskills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
    skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    userSkillService = new UserSkillService(userSkillsDir);
    entryRepo = new MemoryEntryRepo();
    agentRows = new Map();
    mcpRows = new Map();
    updateStatus = vi.fn(async (id: number, status: string) => {
      const row = mcpRows.get(id);
      if (row) row.status = status;
    });
    permission = { hasPermission: vi.fn(async () => false) };
    service = new SharedAgentService(
      entryRepo as never,
      { findById: async (id: number) => agentRows.get(id) ?? null },
      skillLoader,
      userSkillService,
      { findById: async (id: number) => mcpRows.get(id) ?? null, updateStatus },
      permission,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function putAgent(id: number, agent: Partial<Agent>): void {
    agentRows.set(id, { id, name: `A${id}`, systemPrompt: 'p', enabled: 1, ...agent } as Agent);
  }

  async function shareAgent(id: number, partial: Partial<Agent>): Promise<void> {
    putAgent(id, partial);
    await service.putEntry(id, 'note', 0, OPERATOR);
  }

  it('唯一属主：复制安装到操作者名下，selfCheck 缺失清零，属主文件不受影响', async () => {
    mkdirSync(join(userSkillsDir, '8', 'owner-copy'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'owner-copy', 'SKILL.md'), validSkillMd('theirs'));
    await shareAgent(1, { skillNames: JSON.stringify(['theirs']) });

    const report = await service.fixDependencies(1, OPERATOR);
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).toMatchObject({ name: 'theirs', action: 'installed', ownerUserIds: [8] });
    // 安装目标是操作者本人（userId=9），属主目录不动
    expect(existsSync(join(userSkillsDir, '9', 'theirs', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userSkillsDir, '8', 'owner-copy', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userSkillsDir, '9', 'owner-copy'))).toBe(false);
    expect(report.selfCheck.missingSkills).toEqual([]);
  });

  it('跨用户多属主 → ambiguous（detail 带属主列表）；同用户多目录同理', async () => {
    mkdirSync(join(userSkillsDir, '8', 'a'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'a', 'SKILL.md'), validSkillMd('dup'));
    mkdirSync(join(userSkillsDir, '10', 'b'), { recursive: true });
    writeFileSync(join(userSkillsDir, '10', 'b', 'SKILL.md'), validSkillMd('dup'));
    await shareAgent(1, { skillNames: JSON.stringify(['dup']) });

    const report = await service.fixDependencies(1, OPERATOR);
    expect(report.skills[0]).toMatchObject({ name: 'dup', action: 'ambiguous', ownerUserIds: [8, 10] });
    expect(existsSync(join(userSkillsDir, '9', 'dup'))).toBe(false);

    // 同一用户两个同名目录：同属多候选
    rmSync(join(userSkillsDir, '10'), { recursive: true, force: true });
    mkdirSync(join(userSkillsDir, '8', 'a2'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'a2', 'SKILL.md'), validSkillMd('dup'));
    const report2 = await service.fixDependencies(1, OPERATOR);
    expect(report2.skills[0]).toMatchObject({ action: 'ambiguous', ownerUserIds: [8] });
  });

  it('无属主 / 非法技能名 → failed，且不中断其余项', async () => {
    mkdirSync(join(userSkillsDir, '8', 'good'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'good', 'SKILL.md'), validSkillMd('good'));
    await shareAgent(1, { skillNames: JSON.stringify(['ghost', '../evil', 'bad/name', 'good']) });

    const report = await service.fixDependencies(1, OPERATOR);
    const byName = new Map(report.skills.map((s) => [s.name, s]));
    expect(byName.get('ghost')).toMatchObject({ action: 'failed' });
    expect(byName.get('ghost')?.detail).toContain('不存在');
    expect(byName.get('../evil')).toMatchObject({ action: 'failed' });
    expect(byName.get('bad/name')).toMatchObject({ action: 'failed' });
    expect(byName.get('good')).toMatchObject({ action: 'installed' });
    expect(existsSync(join(userSkillsDir, '9', 'good', 'SKILL.md'))).toBe(true);
  });

  it('操作者已有"目录同名、frontmatter 名不同"的技能 → failed 且不覆盖既有内容', async () => {
    // 属主（userId=8）目录 holder、frontmatter 名 theirs
    mkdirSync(join(userSkillsDir, '8', 'holder'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'holder', 'SKILL.md'), validSkillMd('theirs'));
    writeFileSync(join(userSkillsDir, '8', 'holder', 'mine.txt'), '属主自己的内容');
    // 操作者（userId=9）已有目录 theirs，frontmatter 名却是 wrong-name（自检因此认为 theirs 缺失）
    mkdirSync(join(userSkillsDir, String(OPERATOR), 'theirs'), { recursive: true });
    writeFileSync(join(userSkillsDir, String(OPERATOR), 'theirs', 'SKILL.md'), validSkillMd('wrong-name'));
    writeFileSync(join(userSkillsDir, String(OPERATOR), 'theirs', 'mine.txt'), '操作者自己的内容');
    await shareAgent(1, { skillNames: JSON.stringify(['theirs']) });

    const report = await service.fixDependencies(1, OPERATOR);
    expect(report.skills[0]).toMatchObject({ name: 'theirs', action: 'failed' });
    expect(report.skills[0].detail).toContain('frontmatter');
    // 写盘按目录名会静默替换 theirs/（rename 备份成功后即删除）：必须显式失败并保留原内容
    expect(readFileSync(join(userSkillsDir, String(OPERATOR), 'theirs', 'SKILL.md'), 'utf8')).toContain('wrong-name');
    expect(existsSync(join(userSkillsDir, String(OPERATOR), 'theirs', 'mine.txt'))).toBe(true);
    expect(userSkillService.listUserSkills(OPERATOR).map((s) => s.name)).toEqual(['wrong-name']);

    // 失败指引必须可达：按列表名（frontmatter 名）删除错位技能后重试即成功（第 2 轮 N1 闭环）
    expect(userSkillService.deleteUserSkill(OPERATOR, 'wrong-name').code).toBe(0);
    expect(existsSync(join(userSkillsDir, String(OPERATOR), 'theirs'))).toBe(false);
    const retry = await service.fixDependencies(1, OPERATOR);
    expect(retry.skills[0]).toMatchObject({ name: 'theirs', action: 'installed' });
    expect(retry.selfCheck.missingSkills).toEqual([]);
  });

  it('skillNames 含重复项时只补装一次（不输出 installed + ambiguous 矛盾报告）', async () => {
    mkdirSync(join(userSkillsDir, '8', 'good'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'good', 'SKILL.md'), validSkillMd('good'));
    await shareAgent(1, { skillNames: JSON.stringify(['good', 'good']) });

    const report = await service.fixDependencies(1, OPERATOR);
    // 安装后操作者本人也有该技能：不去重会让第二条候选数 1→2 得到 ambiguous 矛盾报告
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).toMatchObject({ name: 'good', action: 'installed', ownerUserIds: [8] });
    expect(report.selfCheck.missingSkills).toEqual([]);
  });

  it('安装内容经 SKILL.md 校验链：属主目录缺 SKILL.md 等异常 → failed', async () => {
    mkdirSync(join(userSkillsDir, '8', 'broken'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'broken', 'readme.txt'), 'no SKILL.md');
    await shareAgent(1, { skillNames: JSON.stringify(['broken']) });

    const report = await service.fixDependencies(1, OPERATOR);
    expect(report.skills[0]).toMatchObject({ name: 'broken', action: 'failed' });
  });

  it('MCP 三分类：dangling 无动作；needs-admin；有 mcp:write 则启用', async () => {
    mcpRows.set(11, { id: 11, name: 'context7', status: 'DISABLED' });
    await shareAgent(1, { mcpServerIds: JSON.stringify([11, 13]) });

    // 普通用户：停用 → needs-admin；不存在 → dangling
    let report = await service.fixDependencies(1, OPERATOR);
    expect(report.mcpServers).toHaveLength(2);
    expect(report.mcpServers.find((m) => m.serverId === 11)).toMatchObject({ action: 'needs-admin', name: 'context7' });
    expect(report.mcpServers.find((m) => m.serverId === 13)).toMatchObject({ action: 'dangling', name: null });
    expect(updateStatus).not.toHaveBeenCalled();

    // 管理员：停用 → enabled（走 updateStatus）
    permission.hasPermission = vi.fn(async (_u: number, code: string) => code === 'mcp:write');
    report = await service.fixDependencies(1, OPERATOR);
    expect(report.mcpServers.find((m) => m.serverId === 11)).toMatchObject({ action: 'enabled' });
    expect(updateStatus).toHaveBeenCalledWith(11, 'ENABLED');
    expect(report.selfCheck.mcpIssues).toEqual(['MCP#13（不存在）']);
  });

  it('无缺失幂等：返回全空 actions + 当前自检；非共享条目 / 停用 Agent 拒绝', async () => {
    mkdirSync(join(skillsDir, 'sys'), { recursive: true });
    writeFileSync(join(skillsDir, 'sys', 'SKILL.md'), validSkillMd('sys'));
    skillLoader.invalidateCache();
    mcpRows.set(12, { id: 12, name: 'live', status: 'ENABLED' });
    await shareAgent(1, { skillNames: JSON.stringify(['sys']), mcpServerIds: JSON.stringify([12]) });

    const report = await service.fixDependencies(1, OPERATOR);
    expect(report.skills).toEqual([]);
    expect(report.mcpServers).toEqual([]);
    expect(report.selfCheck.missingSkills).toEqual([]);

    await expect(service.fixDependencies(404, OPERATOR)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    putAgent(2, { enabled: 0 });
    await service.putEntry(2, 'note', 0, OPERATOR).catch(() => undefined);
    // 停用 Agent 本就上不了架：直接造条目验证拒绝路径
    await entryRepo.upsert(3, 'note', 0, OPERATOR);
    putAgent(3, { enabled: 0 });
    await expect(service.fixDependencies(3, OPERATOR)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });
});

describe('AgentService.deleteAgent 级联删除共享条目', () => {
  it('删除 Agent 时同步删除 shared_agent_entry（服务层级联，表无外键）', async () => {
    const deleteByAgentId = vi.fn(async () => undefined);
    const agentRepo = {
      selectList: vi.fn(async () => []),
      findById: vi.fn(async (id: number) => ({ id, name: 'A', systemPrompt: 'p', isDefault: 0, enabled: 1 })),
      findDefault: vi.fn(),
      insert: vi.fn(),
      updateById: vi.fn(),
      deleteById: vi.fn(),
      updateEnabled: vi.fn(),
      clearDefaultFlag: vi.fn(),
      removeSkillName: vi.fn(),
      listPromptVersions: vi.fn(),
      rollbackPrompt: vi.fn(),
    };
    const experienceService = { syncExperiences: vi.fn(), deleteByAgentId: vi.fn(), listByAgentId: vi.fn() } as unknown as AgentExperienceService;
    const suggestedQuestionService = { syncSuggestedQuestions: vi.fn(), deleteByAgentId: vi.fn(), listByAgentId: vi.fn() } as never;
    const service = new AgentService(
      agentRepo as never,
      experienceService,
      suggestedQuestionService,
      undefined,
      { deleteByAgentId },
    );
    await service.deleteAgent(5);
    expect(deleteByAgentId).toHaveBeenCalledWith(5);
    expect(experienceService.deleteByAgentId).toHaveBeenCalledWith(5);
    expect(agentRepo.deleteById).toHaveBeenCalledWith(5);
  });
});
