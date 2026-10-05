import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  rows = new Map<number, { agentId: number; note: string; sortOrder: number; createdBy: number }>();

  async findByAgentId(agentId: number) {
    return [...this.rows.values()].find((r) => r.agentId === agentId) ?? null;
  }

  async listAll() {
    return [...this.rows.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.agentId - b.agentId)
      .map((r) => ({ ...r, id: r.agentId, createdAt: null, updatedAt: null }));
  }

  async upsert(agentId: number, note: string, sortOrder: number, createdBy = 1) {
    const existing = await this.findByAgentId(agentId);
    if (existing) {
      existing.note = note;
      existing.sortOrder = sortOrder;
    } else {
      this.rows.set(agentId, { agentId, note, sortOrder, createdBy });
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
    service = new SharedAgentService(
      entryRepo as never,
      // 模拟 MysqlAgentRepository.findById：deleted = 0 过滤
      { findById: async (id: number) => {
          const a = agentRows.get(id);
          return a && a.deleted !== 1 ? a : null;
        } },
      skillLoader,
      userSkillService,
      { findById: async (id: number) => mcpRows.get(id) ?? null },
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
