import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { McpSecretCipher } from '../harness/mcp/crypto/mcp-secret-cipher.js';
import { McpServerService } from '../harness/mcp/service/mcp-server.service.js';
import { STATUS_DISABLED, TYPE_HTTP, TYPE_STDIO, type McpServer } from '../harness/mcp/entity/mcp-server.js';
import { AgentExperienceService } from './agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import { AgentBundleService } from './agent-bundle.service.js';
import { BUNDLE_FORMAT, MAX_AGENT_NAME_LENGTH, MAX_INLINE_BYTES, REDACTED_PLACEHOLDER } from './agent-bundle.types.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import type {
  Agent, AgentExperience, AgentExperienceRepository, AgentPromptVersion, AgentRepository,
  AgentSuggestedQuestion, AgentSuggestedQuestionRepository,
} from './types.js';

const SECRET_VALUE = 'super-secret-api-key-42';

class MemoryAgentRepo implements AgentRepository {
  rows = new Map<number, Agent>();
  promptVersions: AgentPromptVersion[] = [];
  private nextId = 1;

  async selectList(keyword?: string | null, includeDisabled = false): Promise<Agent[]> {
    return [...this.rows.values()]
      .filter((a) => a.deleted !== 1)
      .filter((a) => includeDisabled || a.enabled !== 0)
      .filter((a) => keyword == null || a.name.includes(keyword));
  }

  async findById(id: number): Promise<Agent | null> {
    const a = this.rows.get(id);
    return a && a.deleted !== 1 ? a : null;
  }

  async findDefault(): Promise<Agent | null> {
    return [...this.rows.values()].find((a) => a.isDefault === 1 && a.enabled !== 0 && a.deleted !== 1) ?? null;
  }

  async insert(agent: Agent): Promise<number> {
    const id = this.nextId++;
    agent.id = id;
    this.rows.set(id, { ...agent, id, deleted: 0 });
    // 对齐 MysqlAgentRepository.insert：落库同事务起提示词版本 v1
    this.promptVersions.push({ agentId: id, version: 1, systemPrompt: agent.systemPrompt, operatorId: agent.creatorId ?? null });
    return id;
  }

  async updateById(): Promise<void> {}
  async deleteById(id: number): Promise<void> {
    const a = this.rows.get(id);
    if (a) a.deleted = 1;
  }
  async updateEnabled(id: number, enabled: number): Promise<void> {
    const a = this.rows.get(id);
    if (a) a.enabled = enabled;
  }
  async clearDefaultFlag(): Promise<void> {
    for (const a of this.rows.values()) a.isDefault = 0;
  }
  async removeSkillName(): Promise<number> {
    return 0;
  }
  async listPromptVersions(agentId: number): Promise<AgentPromptVersion[]> {
    return this.promptVersions.filter((v) => v.agentId === agentId);
  }
  async rollbackPrompt(): Promise<Agent> {
    throw new Error('not implemented');
  }
}

class MemoryExperienceRepo implements AgentExperienceRepository {
  rows: AgentExperience[] = [];
  private nextId = 1;

  async listByAgentId(agentId: number): Promise<AgentExperience[]> {
    return this.rows
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id! - b.id!);
  }
  async listEnabledByAgentId(agentId: number): Promise<AgentExperience[]> {
    return (await this.listByAgentId(agentId)).filter((r) => r.enabled === 1);
  }
  async findById(id: number): Promise<AgentExperience | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async insert(e: AgentExperience): Promise<number> {
    const id = this.nextId++;
    e.id = id;
    this.rows.push({ ...e, id });
    return id;
  }
  async updateById(e: AgentExperience): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === e.id);
    if (idx >= 0) this.rows[idx] = { ...e };
  }
  async deleteById(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async deleteByAgentId(agentId: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.agentId !== agentId);
  }
}

class MemorySuggestedQuestionRepo implements AgentSuggestedQuestionRepository {
  rows: AgentSuggestedQuestion[] = [];
  private nextId = 1;

  async listByAgentId(agentId: number): Promise<AgentSuggestedQuestion[]> {
    return this.rows
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id! - b.id!);
  }
  async findById(id: number): Promise<AgentSuggestedQuestion | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async insert(q: AgentSuggestedQuestion): Promise<number> {
    const id = this.nextId++;
    q.id = id;
    this.rows.push({ ...q, id });
    return id;
  }
  async updateById(q: AgentSuggestedQuestion): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === q.id);
    if (idx >= 0) this.rows[idx] = { ...q };
  }
  async deleteById(id: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async deleteByAgentId(agentId: number): Promise<void> {
    this.rows = this.rows.filter((r) => r.agentId !== agentId);
  }
}

/** 导入侧 MCP 落库 fake（模拟 mcp_server 表：全局/用户空间同名查重 + 直写 insert）。 */
class MemoryMcpMapper {
  rows = new Map<number, McpServer>();
  private nextId = 1;

  async countByUserIdAndName(userId: number, name: string): Promise<number> {
    let n = 0;
    for (const s of this.rows.values()) if ((s.userId ?? 0) === userId && s.name === name) n++;
    return n;
  }
  async countByNameWhereUserIdNot(name: string, userId: number): Promise<number> {
    let n = 0;
    for (const s of this.rows.values()) if ((s.userId ?? 0) !== userId && s.name === name) n++;
    return n;
  }
  async insert(server: McpServer): Promise<number> {
    const id = this.nextId++;
    this.rows.set(id, { ...server, id });
    return id;
  }
}

function validSkillMd(name: string, description = '测试技能'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;
}

interface Fixture {
  root: string;
  agentRepo: MemoryAgentRepo;
  experienceService: AgentExperienceService;
  suggestedQuestionService: AgentSuggestedQuestionService;
  skillLoader: SkillLoader;
  userSkillService: UserSkillService;
  mcpStore: Map<number, McpServer>;
  mcpMapper: MemoryMcpMapper;
  originRepo: MemoryOriginRepo;
  entrySourceLookup: MemoryEntrySourceLookup;
  service: AgentBundleService;
}

class MemoryOriginRepo {
  rows = new Map<number, { id: number; agentId: number; sourceUrl: string; contentHash: string; importedSystemPrompt: string | null; importedBy: number }>();
  private nextId = 1;

  async findByAgentId(agentId: number) {
    return this.rows.get(agentId) ?? null;
  }
  async listAll() {
    return [...this.rows.values()];
  }
  async upsert(agentId: number, sourceUrl: string, contentHash: string, importedSystemPrompt: string | null, importedBy: number) {
    this.rows.set(agentId, { id: this.nextId++, agentId, sourceUrl, contentHash, importedSystemPrompt, importedBy });
  }
}

class MemoryEntrySourceLookup {
  rows: Array<{ agentId: number; sourceUrl: string | null }> = [];
  async listAll() {
    return this.rows.map((r) => ({ ...r }));
  }
}

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mao-bundle-'));
  const skillsDir = join(root, 'skills');
  const userSkillsDir = join(root, 'userskills');
  const workspaceDir = join(root, 'workspace');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(userSkillsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const skillLoader = new SkillLoader(new PathSandbox(workspaceDir), skillsDir, 0);
  const userSkillService = new UserSkillService(userSkillsDir);
  const agentRepo = new MemoryAgentRepo();
  const experienceService = new AgentExperienceService(new MemoryExperienceRepo());
  const suggestedQuestionService = new AgentSuggestedQuestionService(new MemorySuggestedQuestionRepo());
  const cipher = new McpSecretCipher('unit-test-secret');
  const mcpStore = new Map<number, McpServer>();
  const mcpRuntime = new McpServerService(
    { selectById: async (id: number) => mcpStore.get(id) ?? null } as never,
    cipher,
    {} as never,
  );
  const mcpMapper = new MemoryMcpMapper();
  const originRepo = new MemoryOriginRepo();
  const entrySourceLookup = new MemoryEntrySourceLookup();
  const service = new AgentBundleService(
    agentRepo, experienceService, suggestedQuestionService, skillLoader, userSkillService,
    mcpRuntime, mcpMapper, cipher, originRepo, entrySourceLookup,
  );
  return { root, agentRepo, experienceService, suggestedQuestionService, skillLoader, userSkillService, mcpStore, mcpMapper, originRepo, entrySourceLookup, service };
}

async function insertAgent(repo: MemoryAgentRepo, agent: Agent): Promise<Agent> {
  await repo.insert(agent);
  return agent;
}

function systemSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), validSkillMd(name));
}

describe('AgentBundleService 导出组装', () => {
  it('bundle 含 skillNames 全量条目、经验（含停用）、推荐问题与 configJson', async () => {
    const fx = buildFixture();
    try {
      systemSkill(join(fx.root, 'skills'), 'web-search');
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from(validSkillMd('code-review'), 'utf8') },
      ]);
      fx.skillLoader.invalidateCache();

      const agent = await insertAgent(fx.agentRepo, {
        name: '代码评审员', description: '负责 PR 评审', systemPrompt: '你是评审员',
        configJson: JSON.stringify({ compaction: { enabled: true } }),
        skillNames: JSON.stringify(['web-search', 'code-review']),
        mcpServerIds: null,
      });
      await fx.experienceService.create(agent.id!, '先读文档', 0, true);
      await fx.experienceService.create(agent.id!, '已停用经验', 1, false);
      await fx.suggestedQuestionService.syncSuggestedQuestions(agent.id!, [{ content: '帮我评审', sortOrder: 0 }]);

      const { bundle, filename } = await fx.service.exportBundle(agent.id!);
      expect(bundle.format).toBe(BUNDLE_FORMAT);
      expect(bundle.formatVersion).toBe(1);
      expect(bundle.agent).toMatchObject({ name: '代码评审员', description: '负责 PR 评审', systemPrompt: '你是评审员' });
      expect(bundle.agent.configJson).toEqual({ compaction: { enabled: true } });
      expect(bundle.skills).toHaveLength(2);
      expect(bundle.skills.map((s) => s.name)).toEqual(['web-search', 'code-review']);
      expect(bundle.skills.every((s) => s.include === 'reference')).toBe(true);
      expect(bundle.experiences).toEqual([
        { content: '先读文档', sortOrder: 0, enabled: true },
        { content: '已停用经验', sortOrder: 1, enabled: false },
      ]);
      expect(bundle.suggestedQuestions).toEqual([{ content: '帮我评审', sortOrder: 0 }]);
      expect(filename).toBe('mao-agent-bundle-agent-v1.json');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('目录名与 SKILL.md frontmatter 名不一致时按候选 folderPath 读盘（不串技能、不误报失败）', async () => {
    const fx = buildFixture();
    try {
      // Case A：目录 code-review 的 frontmatter 是 other-skill；真正的 code-review 技能在目录 holder
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from(validSkillMd('other-skill', '另一个技能'), 'utf8') },
      ]);
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'holder/SKILL.md', buffer: Buffer.from(validSkillMd('code-review', '真正的评审技能'), 'utf8') },
      ]);
      const agentA = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['code-review']) });

      const { bundle } = await fx.service.exportBundle(agentA.id!, 'code-review');
      const inline = bundle.skills[0];
      expect(inline.include).toBe('inline');
      expect(inline.files?.['SKILL.md']).toContain('name: code-review');
      expect(inline.files?.['SKILL.md']).not.toContain('other-skill');

      // Case B：目录名与 frontmatter 名不一致且无同名目录时，仍按 folderPath 正常导出
      await fx.userSkillService.uploadUserSkill(13, [
        { originalFilename: 'my-tool/SKILL.md', buffer: Buffer.from(validSkillMd('skill-x'), 'utf8') },
      ]);
      const agentB = await insertAgent(fx.agentRepo, { name: 'B', systemPrompt: 'p', skillNames: JSON.stringify(['skill-x']) });
      const { bundle: bundleB } = await fx.service.exportBundle(agentB.id!, 'skill-x');
      expect(bundleB.skills[0].include).toBe('inline');
      expect(bundleB.skills[0].files?.['SKILL.md']).toContain('name: skill-x');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline 条目读取用户技能文本文件；二进制文件跳过并在 warnings 标注', async () => {
    const fx = buildFixture();
    try {
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]);
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'packer/SKILL.md', buffer: Buffer.from(validSkillMd('packer'), 'utf8') },
        { originalFilename: 'packer/scripts/run.sh', buffer: Buffer.from('#!/bin/sh\necho hi\n', 'utf8') },
        { originalFilename: 'packer/assets/logo.bin', buffer: binary },
      ]);
      const agent = await insertAgent(fx.agentRepo, {
        name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['packer']),
      });

      const { bundle } = await fx.service.exportBundle(agent.id!, 'packer');
      expect(bundle.skills).toHaveLength(1);
      const skill = bundle.skills[0];
      expect(skill.include).toBe('inline');
      expect(skill.files?.['SKILL.md']).toContain('name: packer');
      expect(skill.files?.['scripts/run.sh']).toContain('echo hi');
      expect(skill.files?.['assets/logo.bin']).toBeUndefined();
      expect(skill.warnings).toEqual(['binary file skipped: assets/logo.bin']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('系统技能出现在 inlineSkills 报 PARAM_INVALID', async () => {
    const fx = buildFixture();
    try {
      systemSkill(join(fx.root, 'skills'), 'web-search');
      fx.skillLoader.invalidateCache();
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['web-search']) });
      await expect(fx.service.exportBundle(agent.id!, 'web-search')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('同名多用户技能未带 @userId 报 PARAM_INVALID 并列出候选；name@userId 指向不存在的归属报错', async () => {
    const fx = buildFixture();
    try {
      const md = validSkillMd('shared-skill');
      await fx.userSkillService.uploadUserSkill(12, [{ originalFilename: 'shared-skill/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      await fx.userSkillService.uploadUserSkill(13, [{ originalFilename: 'shared-skill/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['shared-skill']) });

      const err = await fx.service.exportBundle(agent.id!, 'shared-skill').catch((e) => e as BusinessException);
      expect(err.code).toBe(ErrorCode.PARAM_INVALID.code);
      expect(err.message).toContain('shared-skill@12');
      expect(err.message).toContain('shared-skill@13');

      await expect(fx.service.exportBundle(agent.id!, 'shared-skill@99'))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('唯一候选可省略 @userId；唯一候选带 @userId 正常内联', async () => {
    const fx = buildFixture();
    try {
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'solo/SKILL.md', buffer: Buffer.from(validSkillMd('solo'), 'utf8') },
      ]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['solo']) });

      const bare = await fx.service.exportBundle(agent.id!, 'solo');
      expect(bare.bundle.skills[0].include).toBe('inline');
      const explicit = await fx.service.exportBundle(agent.id!, 'solo@12');
      expect(explicit.bundle.skills[0].include).toBe('inline');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('同名技能指定多个内联归属 token → PARAM_INVALID（不静默取第一个）', async () => {
    const fx = buildFixture();
    try {
      const md = validSkillMd('shared-skill');
      await fx.userSkillService.uploadUserSkill(12, [{ originalFilename: 'shared-skill/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      await fx.userSkillService.uploadUserSkill(13, [{ originalFilename: 'shared-skill/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['shared-skill']) });

      await expect(fx.service.exportBundle(agent.id!, 'shared-skill@12,shared-skill@13'))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code, message: expect.stringContaining('多个内联归属') });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('同一用户存在多个同名技能目录 → PARAM_INVALID（不静默取首个目录）', async () => {
    const fx = buildFixture();
    try {
      // 同一用户 12：两个目录的 SKILL.md frontmatter 名都是 shared-skill（上传不拦截）
      const md = validSkillMd('shared-skill');
      await fx.userSkillService.uploadUserSkill(12, [{ originalFilename: 'dir-a/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      await fx.userSkillService.uploadUserSkill(12, [{ originalFilename: 'dir-b/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['shared-skill']) });

      // 未带归属：明确报错（不再列出重复的 shared@12、shared@12）
      await expect(fx.service.exportBundle(agent.id!, 'shared-skill'))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code, message: expect.stringContaining('多个同名技能') });
      // 显式归属同样无法表达目录选择：报错而非静默取 readdir 首个
      await expect(fx.service.exportBundle(agent.id!, 'shared-skill@12'))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code, message: expect.stringContaining('多个同名技能') });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('目录冲突检查仅作用于请求所涉用户：他用户冲突不影响无歧义归属的导出', async () => {
    const fx = buildFixture();
    try {
      const md = validSkillMd('shared-skill');
      // 用户 12：单目录（归属无歧义）；用户 13：两个同名目录（冲突）
      await fx.userSkillService.uploadUserSkill(12, [{ originalFilename: 'ok-dir/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      await fx.userSkillService.uploadUserSkill(13, [{ originalFilename: 'dir-a/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      await fx.userSkillService.uploadUserSkill(13, [{ originalFilename: 'dir-b/SKILL.md', buffer: Buffer.from(md, 'utf8') }]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['shared-skill']) });

      // 显式指定无歧义用户：正常导出（第 5 轮回归点）
      const { bundle } = await fx.service.exportBundle(agent.id!, 'shared-skill@12');
      expect(bundle.skills[0].include).toBe('inline');
      expect(bundle.skills[0].files?.['SKILL.md']).toContain('name: shared-skill');

      // 裸 token：剔除冲突用户后唯一可用候选（用户 12）确定性解析
      const bare = await fx.service.exportBundle(agent.id!, 'shared-skill');
      expect(bare.bundle.skills[0].include).toBe('inline');
      expect(bare.bundle.skills[0].files?.['SKILL.md']).toContain('name: shared-skill');

      // 显式指定冲突用户：报错
      await expect(fx.service.exportBundle(agent.id!, 'shared-skill@13'))
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code, message: expect.stringContaining('用户 13') });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('Agent 不存在报 AGENT_NOT_FOUND', async () => {
    const fx = buildFixture();
    try {
      await expect(fx.service.exportBundle(999)).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_FOUND.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe('AgentBundleService 脱敏（最高优先）', () => {
  it('env 值全量替换为 $MAO_REDACTED，且序列化 bundle 不含任何原始密钥值', async () => {
    const fx = buildFixture();
    try {
      const cipher = new McpSecretCipher('unit-test-secret');
      const envJson = cipher.encrypt(JSON.stringify({ API_KEY: SECRET_VALUE, DB_PASS: 'p@ssw0rd' }));
      fx.mcpStore.set(1, {
        id: 1, userId: 0, name: 'context7', serverType: TYPE_STDIO,
        command: 'npx', argsJson: JSON.stringify(['-y', 'ctx']), envJson, status: 'ENABLED',
      });
      fx.mcpStore.set(2, {
        id: 2, userId: 0, name: 'http-mcp', serverType: TYPE_HTTP,
        url: 'https://mcp.example.com/sse', envJson: cipher.encrypt(JSON.stringify({ TOKEN: SECRET_VALUE })), status: 'ENABLED',
      });
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', mcpServerIds: JSON.stringify([1, 2]) });

      const { bundle } = await fx.service.exportBundle(agent.id!);
      const stdio = bundle.mcpServers.find((m) => m.name === 'context7')!;
      expect(stdio.definition.env).toEqual({ API_KEY: REDACTED_PLACEHOLDER, DB_PASS: REDACTED_PLACEHOLDER });
      const http = bundle.mcpServers.find((m) => m.name === 'http-mcp')!;
      expect(http.definition.env).toEqual({ TOKEN: REDACTED_PLACEHOLDER });
      expect(http.definition.url).toBe('https://mcp.example.com/sse');
      // 断言整个序列化 bundle 不含任何原始密钥值
      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain('p@ssw0rd');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('envJson 解密失败时导出明确报错（PARAM_INVALID），不静默降级', async () => {
    const fx = buildFixture();
    try {
      fx.mcpStore.set(1, {
        id: 1, userId: 0, name: 'broken', serverType: TYPE_HTTP, url: 'https://x.example.com',
        envJson: 'not-a-valid-ciphertext', status: 'ENABLED',
      });
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', mcpServerIds: JSON.stringify([1]) });
      await expect(fx.service.exportBundle(agent.id!)).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID.code,
        message: expect.stringContaining('解密失败'),
      });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('MCP 不存在时导出明确报错', async () => {
    const fx = buildFixture();
    try {
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', mcpServerIds: JSON.stringify([404]) });
      await expect(fx.service.exportBundle(agent.id!)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe('AgentBundleService round-trip', () => {
  it('导出 → 导入（confirm）→ 逐字段断言落库结果', async () => {
    const source = buildFixture();
    try {
      systemSkill(join(source.root, 'skills'), 'web-search');
      await source.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from(validSkillMd('code-review'), 'utf8') },
        { originalFilename: 'code-review/docs/guide.md', buffer: Buffer.from('# 指南\n内容\n', 'utf8') },
      ]);
      source.skillLoader.invalidateCache();
      const cipher = new McpSecretCipher('unit-test-secret');
      source.mcpStore.set(1, {
        id: 1, userId: 0, name: 'context7', serverType: TYPE_STDIO,
        command: 'npx', argsJson: JSON.stringify(['-y', 'ctx']),
        envJson: cipher.encrypt(JSON.stringify({ API_KEY: SECRET_VALUE })), status: 'ENABLED',
      });
      const exported = await insertAgent(source.agentRepo, {
        name: '代码评审员', description: '负责 PR 评审', systemPrompt: '你是评审员',
        configJson: JSON.stringify({ compaction: { enabled: true } }),
        skillNames: JSON.stringify(['web-search', 'code-review']),
        mcpServerIds: JSON.stringify([1]),
      });
      await source.experienceService.create(exported.id!, '先读文档', 0, true);
      await source.experienceService.create(exported.id!, '停用经验', 1, false);
      await source.suggestedQuestionService.syncSuggestedQuestions(exported.id!, [{ content: '帮我评审', sortOrder: 0 }]);

      const { bundle } = await source.service.exportBundle(exported.id!, 'code-review@12');

      // 全新目标实例
      const target = buildFixture();
      try {
        const result = await target.service.importBundle(JSON.parse(JSON.stringify(bundle)), true, 7);
        if (!('agentId' in result)) throw new Error('expected import result');
        const { agentId, report } = result;
        expect(report.nameConflict).toBe(false);
        expect(report.finalName).toBe('代码评审员');
        expect(report.skills.map((s) => `${s.name}:${s.action}`)).toEqual([
          'web-search:missing',
          'code-review:ok',
        ]);
        expect(report.mcpServers[0].action).toBe('will-create-disabled');

        const agent = await target.agentRepo.findById(agentId);
        expect(agent).toMatchObject({
          name: '代码评审员', description: '负责 PR 评审', systemPrompt: '你是评审员',
          defaultModelId: null, isDefault: 0, enabled: 1, creatorId: 7, avatarUrl: null,
        });
        expect(JSON.parse(agent!.configJson ?? 'null')).toEqual({ compaction: { enabled: true } });
        expect(JSON.parse(agent!.skillNames ?? '[]')).toEqual(['web-search', 'code-review']);

        // MCP：DISABLED、全局、env 键保留值置空
        const mcpIds = JSON.parse(agent!.mcpServerIds ?? '[]') as number[];
        expect(mcpIds).toHaveLength(1);
        const mcp = target.mcpMapper.rows.get(mcpIds[0])!;
        expect(mcp).toMatchObject({ userId: 0, name: 'context7', serverType: TYPE_STDIO, status: STATUS_DISABLED, description: '由 bundle 导入' });
        const targetCipher = new McpSecretCipher('unit-test-secret');
        expect(JSON.parse(targetCipher.decrypt(mcp.envJson)!)).toEqual({ API_KEY: '' });
        // 序列化 bundle 中的密钥值不得以明文落库
        expect(JSON.stringify([...target.mcpMapper.rows.values()])).not.toContain(SECRET_VALUE);

        // 经验（含停用）与推荐问题
        const experiences = await target.experienceService.listByAgentId(agentId);
        expect(experiences.map((e) => ({ content: e.content, enabled: e.enabled }))).toEqual([
          { content: '先读文档', enabled: 1 },
          { content: '停用经验', enabled: 0 },
        ]);
        const questions = await target.suggestedQuestionService.listByAgentId(agentId);
        expect(questions.map((q) => q.content)).toEqual(['帮我评审']);

        // inline 技能已写入目标实例系统技能目录
        const staged = join(target.root, 'skills', 'code-review');
        expect(existsSync(join(staged, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(staged, 'docs', 'guide.md'))).toBe(true);
        expect(readFileSync(join(staged, 'SKILL.md'), 'utf8')).toContain('name: code-review');
        expect(existsSync(join(target.root, 'skills', '.staging'))).toBe(false);

        // 提示词版本表恰有 v1
        const versions = await target.agentRepo.listPromptVersions(agentId);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({ version: 1, systemPrompt: '你是评审员' });
      } finally {
        rmSync(target.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(source.root, { recursive: true, force: true });
    }
  });
});

describe('AgentBundleService 导入校验', () => {
  it('format/formatVersion 不识别明确报错', async () => {
    const fx = buildFixture();
    try {
      for (const bad of [
        {},
        { format: 'mao-agent-bundle', formatVersion: 2, agent: { name: 'A', systemPrompt: 'p' } },
        { format: 'other', formatVersion: 1, agent: { name: 'A', systemPrompt: 'p' } },
      ]) {
        await expect(fx.service.importBundle(bad, false, 7)).rejects.toMatchObject({
          code: ErrorCode.PARAM_INVALID.code,
          message: expect.stringContaining('不支持的 bundle 格式'),
        });
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('名称冲突加"副本"后缀且不覆盖现有 Agent；仍冲突则递增', async () => {
    const fx = buildFixture();
    try {
      await insertAgent(fx.agentRepo, { name: '评审员', systemPrompt: 'old' });
      const bundle = { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: '评审员', systemPrompt: 'p' } };
      const precheck = await fx.service.importBundle(bundle, false, 7);
      expect(precheck.nameConflict).toBe(true);
      expect(precheck.finalName).toBe('评审员 副本');
      expect(fx.agentRepo.rows.size).toBe(1);

      await insertAgent(fx.agentRepo, { name: '评审员 副本', systemPrompt: 'old2' });
      const precheck2 = await fx.service.importBundle(bundle, false, 7);
      expect(precheck2.finalName).toBe('评审员 副本2');

      const result = await fx.service.importBundle(bundle, true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      const created = await fx.agentRepo.findById(result.agentId);
      expect(created?.name).toBe('评审员 副本2');
      expect((await fx.agentRepo.findById(1))?.systemPrompt).toBe('old');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('confirm=true 阶段重算后缀与冲突（不信任预检结果）', async () => {
    const fx = buildFixture();
    try {
      const bundle = { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: 'A', systemPrompt: 'p' } };
      const precheck = await fx.service.importBundle(bundle, false, 7);
      expect(precheck.finalName).toBe('A');
      // 预检之后、确认之前，目标实例出现同名 Agent（并发窗口）
      await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'concurrent' });
      const result = await fx.service.importBundle(bundle, true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      expect(result.report.nameConflict).toBe(true);
      expect(result.report.finalName).toBe('A 副本');
      const concurrent = await fx.agentRepo.findById(1);
      expect(concurrent?.systemPrompt).toBe('concurrent');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('MCP 同名（全局或用户空间）跳过且 Agent 不绑该项', async () => {
    const fx = buildFixture();
    try {
      fx.mcpMapper.rows.set(100, { id: 100, userId: 9, name: 'ctx7', serverType: TYPE_HTTP, url: 'https://a.b', status: 'ENABLED' });
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        mcpServers: [
          { name: 'ctx7', definition: { serverType: TYPE_HTTP, command: null, args: null, url: 'https://mcp.example.com', env: {} } },
        ],
      };
      const precheck = await fx.service.importBundle(bundle, false, 7);
      expect(precheck.mcpServers[0].action).toBe('skip-name-conflict');

      const result = await fx.service.importBundle(bundle, true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      const agent = await fx.agentRepo.findById(result.agentId);
      expect(agent?.mcpServerIds ?? null).toBeNull();
      expect(fx.mcpMapper.rows.size).toBe(1);
      expect(fx.mcpMapper.rows.get(100)?.userId).toBe(9);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('STDIO/HTTP 必填字段缺失归 skip-invalid', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        mcpServers: [
          { name: 'no-command', definition: { serverType: TYPE_STDIO, command: null, args: ['x'], url: null, env: {} } },
          { name: 'no-args', definition: { serverType: TYPE_STDIO, command: 'npx', args: [], url: null, env: {} } },
          { name: 'no-url', definition: { serverType: TYPE_HTTP, command: null, args: null, url: '', env: {} } },
          { name: 'bad-url', definition: { serverType: TYPE_HTTP, command: null, args: null, url: 'ftp://x', env: {} } },
          { name: 'bad-type', definition: { serverType: 'GRPC', command: null, args: null, url: 'https://x', env: {} } },
        ],
      };
      const report = await fx.service.importBundle(bundle, false, 7);
      expect(report.mcpServers.map((m) => m.action)).toEqual([
        'skip-invalid', 'skip-invalid', 'skip-invalid', 'skip-invalid', 'skip-invalid',
      ]);
      expect(fx.mcpMapper.rows.size).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline 技能与系统技能同名 → exists-skip，不覆盖目标文件', async () => {
    const fx = buildFixture();
    try {
      const original = validSkillMd('code-review', '原始描述');
      systemSkill(join(fx.root, 'skills'), 'code-review');
      writeFileSync(join(fx.root, 'skills', 'code-review', 'SKILL.md'), original);
      fx.skillLoader.invalidateCache();
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [{ name: 'code-review', include: 'inline', files: { 'SKILL.md': validSkillMd('code-review', '恶意覆盖') } }],
      };
      const precheck = await fx.service.importBundle(bundle, false, 7);
      expect(precheck.skills[0].action).toBe('exists-skip');

      await fx.service.importBundle(bundle, true, 7);
      expect(readFileSync(join(fx.root, 'skills', 'code-review', 'SKILL.md'), 'utf8')).toContain('原始描述');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline SKILL.md frontmatter 名与条目名不一致 → import-failed，不写盘、引用不悬空', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [{ name: 'foo', include: 'inline', files: { 'SKILL.md': '---\nname: bar\ndescription: 另一个名字\n---\n正文\n' } }],
      };
      const precheck = await fx.service.importBundle(structuredClone(bundle), false, 7);
      expect(precheck.skills[0].action).toBe('import-failed');
      expect(precheck.skills[0].detail).toContain('不一致');

      const result = await fx.service.importBundle(structuredClone(bundle), true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      expect(result.report.skills[0].action).toBe('import-failed');
      expect(existsSync(join(fx.root, 'skills', 'foo'))).toBe(false);
      expect(fx.skillLoader.hasSkill('foo')).toBe(false);
      expect(fx.skillLoader.hasSkill('bar')).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('bundle 内重复技能名去重（保留首个并列 warnings），skillNames 不含重复项', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [
          { name: 'dup', include: 'reference' },
          { name: 'dup', include: 'reference' },
          { name: 'other', include: 'reference' },
        ],
      };
      const report = await fx.service.importBundle(structuredClone(bundle), false, 7);
      expect(report.warnings.some((w) => w.includes('dup') && w.includes('重复'))).toBe(true);

      const result = await fx.service.importBundle(structuredClone(bundle), true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      expect(JSON.parse((await fx.agentRepo.findById(result.agentId))!.skillNames ?? '[]')).toEqual(['dup', 'other']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline files 中隐藏路径段的文件被丢弃（与导出/上传口径一致）', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [{
          name: 'foo', include: 'inline',
          files: { 'SKILL.md': '---\nname: foo\ndescription: d\n---\n正文\n', '.secret': 'x', 'docs/.hidden': 'y' },
        }],
      };
      const precheck = await fx.service.importBundle(structuredClone(bundle), false, 7);
      expect(precheck.skills[0].action).toBe('will-import');

      await fx.service.importBundle(structuredClone(bundle), true, 7);
      expect(existsSync(join(fx.root, 'skills', 'foo', '.secret'))).toBe(false);
      expect(existsSync(join(fx.root, 'skills', 'foo', 'docs', '.hidden'))).toBe(false);
      expect(existsSync(join(fx.root, 'skills', 'foo', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline 缺 SKILL.md 或 SKILL.md 校验失败 → import-failed，不写盘、不阻断 Agent 创建', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [
          { name: 'no-md', include: 'inline', files: { 'README.txt': 'hi' } },
          { name: 'bad-md', include: 'inline', files: { 'SKILL.md': '没有 frontmatter' } },
        ],
      };
      const precheck = await fx.service.importBundle(bundle, false, 7);
      expect(precheck.skills.map((s) => s.action)).toEqual(['import-failed', 'import-failed']);

      const result = await fx.service.importBundle(bundle, true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      expect(existsSync(join(fx.root, 'skills', 'no-md'))).toBe(false);
      expect(existsSync(join(fx.root, 'skills', 'bad-md'))).toBe(false);
      expect(JSON.parse((await fx.agentRepo.findById(result.agentId))!.skillNames ?? '[]')).toEqual(['no-md', 'bad-md']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('reference 技能任一用户空间存在即 ok', async () => {
    const fx = buildFixture();
    try {
      await fx.userSkillService.uploadUserSkill(31, [
        { originalFilename: 'user-only/SKILL.md', buffer: Buffer.from(validSkillMd('user-only'), 'utf8') },
      ]);
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        skills: [{ name: 'user-only', include: 'reference' }],
      };
      const report = await fx.service.importBundle(bundle, false, 7);
      expect(report.skills[0].action).toBe('ok');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe('AgentBundleService 字段级校验', () => {
  it('name ≤128；超长报错', async () => {
    const fx = buildFixture();
    try {
      const ok = { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: 'x'.repeat(MAX_AGENT_NAME_LENGTH), systemPrompt: 'p' } };
      const report = await fx.service.importBundle(ok, false, 7);
      expect(report.finalName).toBe('x'.repeat(MAX_AGENT_NAME_LENGTH));
      const tooLong = { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: 'x'.repeat(MAX_AGENT_NAME_LENGTH + 1), systemPrompt: 'p' } };
      await expect(fx.service.importBundle(tooLong, false, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('超长原名冲突时在截断后的原名上追加后缀，finalName ≤128', async () => {
    const fx = buildFixture();
    try {
      const longName = '长'.repeat(MAX_AGENT_NAME_LENGTH);
      await insertAgent(fx.agentRepo, { name: longName, systemPrompt: 'old' });
      const bundle = { format: BUNDLE_FORMAT, formatVersion: 1, agent: { name: longName, systemPrompt: 'p' } };
      const report = await fx.service.importBundle(bundle, false, 7);
      expect(report.finalName.length).toBeLessThanOrEqual(MAX_AGENT_NAME_LENGTH);
      expect(report.finalName.endsWith(' 副本')).toBe(true);
      expect(report.finalName.startsWith('长'.repeat(10))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('experiences 超 300 字条目跳过并列 warnings，其余正常导入', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        experiences: [
          { content: '正常经验', sortOrder: 0, enabled: true },
          { content: '超'.repeat(301), sortOrder: 1, enabled: true },
        ],
      };
      const report = await fx.service.importBundle(bundle, false, 7);
      expect(report.experiencesCount).toBe(1);
      expect(report.warnings.some((w) => w.includes('第 2 条'))).toBe(true);

      const result = await fx.service.importBundle(bundle, true, 7);
      if (!('agentId' in result)) throw new Error('expected import result');
      const rows = await fx.experienceService.listByAgentId(result.agentId);
      expect(rows.map((r) => r.content)).toEqual(['正常经验']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('suggestedQuestions 超 5 条或单条超 100 字整体 PARAM_INVALID', async () => {
    const fx = buildFixture();
    try {
      const six = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        suggestedQuestions: Array.from({ length: 6 }, (_, i) => ({ content: `q${i}` })),
      };
      await expect(fx.service.importBundle(six, false, 7)).rejects.toMatchObject({ code: ErrorCode.AGENT_SUGGESTED_QUESTION_LIMIT_EXCEEDED.code });
      const longOne = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        suggestedQuestions: [{ content: 'q'.repeat(101) }],
      };
      await expect(fx.service.importBundle(longOne, false, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
      expect(fx.agentRepo.rows.size).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('MCP name 不符 NAME_PATTERN 归 skip-invalid', async () => {
    const fx = buildFixture();
    try {
      const bundle = {
        format: BUNDLE_FORMAT, formatVersion: 1,
        agent: { name: 'A', systemPrompt: 'p' },
        mcpServers: [
          { name: 'Bad Name', definition: { serverType: TYPE_HTTP, command: null, args: null, url: 'https://x', env: {} } },
          { name: 'x'.repeat(65), definition: { serverType: TYPE_HTTP, command: null, args: null, url: 'https://x', env: {} } },
          { name: 'double__under', definition: { serverType: TYPE_HTTP, command: null, args: null, url: 'https://x', env: {} } },
        ],
      };
      const report = await fx.service.importBundle(bundle, false, 7);
      expect(report.mcpServers.map((m) => m.action)).toEqual(['skip-invalid', 'skip-invalid', 'skip-invalid']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('技能名含路径分隔符/控制字符被拒（PARAM_INVALID，不落库）', async () => {
    const fx = buildFixture();
    try {
      for (const badName of ['a/b', 'a\\b', 'a\u0000b', '  ', '.hidden', '..']) {
        const bundle = {
          format: BUNDLE_FORMAT, formatVersion: 1,
          agent: { name: 'A', systemPrompt: 'p' },
          skills: [{ name: badName, include: 'reference' }],
        };
        await expect(fx.service.importBundle(bundle, false, 7)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
      }
      expect(fx.agentRepo.rows.size).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('历史重复 skillNames 导出时去重（bundle 不产同名条目）', async () => {
    const fx = buildFixture();
    try {
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['x', 'x', 'y']) });
      const { bundle } = await fx.service.exportBundle(agent.id!);
      expect(bundle.skills.map((s) => s.name)).toEqual(['x', 'y']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('inline files 累计超 10MB 报 PARAM_INVALID 且不产出 bundle', async () => {
    const fx = buildFixture();
    try {
      const big = 'a'.repeat(MAX_INLINE_BYTES + 1);
      await fx.userSkillService.uploadUserSkill(12, [
        { originalFilename: 'big/SKILL.md', buffer: Buffer.from(validSkillMd('big'), 'utf8') },
        { originalFilename: 'big/data.txt', buffer: Buffer.from(big, 'utf8') },
      ]);
      const agent = await insertAgent(fx.agentRepo, { name: 'A', systemPrompt: 'p', skillNames: JSON.stringify(['big']) });
      await expect(fx.service.exportBundle(agent.id!, 'big')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
