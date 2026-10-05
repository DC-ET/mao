import { createHash } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { harnessLog } from '../harness/log.js';
import { validateSkillMd, parseSkillMdContent } from '../harness/skill/skill-md.js';
import { isHiddenRelativePath, readSkillFolderFiles, skillFilesPathError } from '../skill/read-skill-files.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import {
  GLOBAL_USER_ID, STATUS_DISABLED, TYPE_HTTP, TYPE_STDIO, type McpServer,
} from '../harness/mcp/entity/mcp-server.js';
import type { McpSecretCipher } from '../harness/mcp/crypto/mcp-secret-cipher.js';
import { writeSkillStaged } from '../skill/staged-skill-writer.js';
import type { UserSkillService } from '../skill/user-skill.service.js';
import { AgentExperienceService } from './agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import type {
  Agent, AgentRepository, ExperienceInput, SuggestedQuestionInput,
} from './types.js';
import {
  BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, MAX_AGENT_NAME_LENGTH, MAX_INLINE_BYTES, REDACTED_PLACEHOLDER,
  type AgentBundle, type BundleCheckUpdateItem, type BundleExperience, type BundleImportMcpEntry, type BundleImportReport,
  type BundleImportResult, type BundleImportSkillEntry, type BundleMcpDefinition, type BundleMcpServer,
  type BundleSkill, type BundleSuggestedQuestion,
} from './agent-bundle.types.js';
import type { AgentImportOriginRow } from './agent-import-origin.repository.js';

/** 对齐 McpServerService.validateName：名称全局唯一（跨全局与用户空间）+ 无连续下划线。 */
const MCP_NAME_PATTERN = /^[a-z0-9_-]+$/;
const MCP_NAME_MAX_LENGTH = 64;

/** URL 拉取约束（import-from-url / check-updates 共用；见技术方案 §8）：仅 http/https + 10s 超时 + 20MB 上限 + 禁用重定向。 */
export const BUNDLE_FETCH_TIMEOUT_MS = 10_000;
export const BUNDLE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
/** check-updates 缺省全量时的拉取并发。 */
export const CHECK_UPDATE_CONCURRENCY = 4;

/** URL 拉取能力（import-from-url / check-updates 共用），测试可替换。 */
export async function fetchBundleFromUrl(rawUrl: string): Promise<AgentBundle> {
  const sourceUrl = validateSourceUrl(rawUrl);
  let res: Response;
  try {
    res = await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(BUNDLE_FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `拉取远端 bundle 失败：${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `远端返回 HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get('content-length');
  if (lenHeader != null && Number(lenHeader) > BUNDLE_FETCH_MAX_BYTES) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `远端响应超过 ${Math.floor(BUNDLE_FETCH_MAX_BYTES / 1024 / 1024)}MB 上限`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader == null) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '远端响应无内容');
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BUNDLE_FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BusinessException(ErrorCode.PARAM_INVALID, `远端响应超过 ${Math.floor(BUNDLE_FETCH_MAX_BYTES / 1024 / 1024)}MB 上限`);
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '远端返回的不是合法 JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).format !== BUNDLE_FORMAT) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '远端返回的不是 mao-agent-bundle JSON');
  }
  return parsed as AgentBundle;
}

/** 导入来源 URL 校验：http/https 且 ≤1024（对齐 source_url 列宽）。 */
export function validateSourceUrl(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不能为空');
  }
  if (text.length > 1024) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 最长 1024 字符');
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不合法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 必须以 http:// 或 https:// 开头');
  }
  return text;
}

/** 导出链路用到的 MCP 运行时读取能力（McpServerService 已实现）。 */
export interface BundleMcpRuntime {
  getForRuntime(id: number): Promise<McpServer>;
  decryptEnv(server: McpServer): Record<string, string>;
}

/** 导入链路用到的 MCP 落库能力（McpServerMapper 已实现）；绕过 validateForAgent 由 service 层直写。 */
export interface BundleMcpMapper {
  countByUserIdAndName(userId: number, name: string): Promise<number>;
  countByNameWhereUserIdNot(name: string, userId: number): Promise<number>;
  insert(server: McpServer): Promise<number>;
}

/** URL 导入来源落库能力（AgentImportOriginRepository 已实现）。 */
export interface BundleOriginRepo {
  findByAgentId(agentId: number): Promise<AgentImportOriginRow | null>;
  listAll(): Promise<AgentImportOriginRow[]>;
  upsert(agentId: number, sourceUrl: string, contentHash: string, importedSystemPrompt: string | null, importedBy: number): Promise<void>;
}

/** 共享条目远端来源读取能力（SharedAgentEntryRepository 已实现）。 */
export interface BundleEntrySourceLookup {
  listAll(): Promise<Array<{ agentId: number; sourceUrl: string | null }>>;
}

export interface ParsedBundle {
  agent: {
    name: string;
    description: string | null;
    systemPrompt: string;
    configJson: Record<string, unknown> | null;
  };
  experiences: BundleExperience[];
  suggestedQuestions: BundleSuggestedQuestion[];
  skills: Array<{ name: string; include: 'inline' | 'reference'; files?: Record<string, string> }>;
  mcpServers: Array<{ name: string; definition: BundleMcpDefinition }>;
  /** 公共校验阶段的非致命告警（如超限经验条目跳过）。 */
  warnings: string[];
}

export class AgentBundleService {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly experienceService: AgentExperienceService,
    private readonly suggestedQuestionService: AgentSuggestedQuestionService,
    private readonly skillLoader: SkillLoader,
    private readonly userSkillService: UserSkillService,
    private readonly mcpServerRuntime: BundleMcpRuntime,
    private readonly mcpMapper: BundleMcpMapper,
    private readonly mcpCipher: McpSecretCipher,
    private readonly originRepo: BundleOriginRepo,
    private readonly entrySourceLookup: BundleEntrySourceLookup,
  ) {}

  // ---------------------------------------------------------------- 导出

  /**
   * registry 只读导出（URL 导入的数据源）：对 Agent 的每个用户技能生成 name@userId 显式 token
   * 全量内联——默认 reference 导出会让 URL 导入产出缺技能的 Agent，且目标实例无属主、fix-deps 无法补齐。
   * 同名多归属/超 inline 上限时抛错（路由映射 409），check-updates 落为该项 error。
   */
  async exportRegistryBundle(agentId: number): Promise<{ bundle: AgentBundle; contentHash: string }> {
    const agent = await this.agentRepo.findById(agentId);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      // 与不存在同映射 404：不向未授权方暴露存在性差异
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND, 'Agent 已停用');
    }
    const tokens = this.buildRegistryInlineTokens(agent);
    const { bundle } = await this.exportBundle(agentId, tokens.length > 0 ? tokens.join(',') : undefined);
    return { bundle, contentHash: computeBundleContentHash(bundle) };
  }

  private buildRegistryInlineTokens(agent: Agent): string[] {
    const tokens: string[] = [];
    if (agent.skillNames == null || agent.skillNames.trim() === '') return tokens;
    const all = this.userSkillService.listAllUserSkills();
    for (const name of parseStringArray(agent.skillNames)) {
      if (this.skillLoader.hasSkill(name)) continue;
      const candidates = all.filter((s) => s.name === name);
      if (candidates.length === 0) continue; // 实例内已无该技能：导出为 reference，导入端报告 missing
      if (candidates.length > 1) {
        const ids = [...new Set(candidates.map((c) => c.userId))].map((id) => `userId=${id}`).join('、');
        throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${name}」存在多个归属（${ids}），无法从 registry 导出，请先整理同名技能`);
      }
      tokens.push(`${name}@${candidates[0].userId}`);
    }
    return tokens;
  }

  async exportBundle(agentId: number, inlineSkills?: string): Promise<{ bundle: AgentBundle; filename: string }> {
    const agent = await this.agentRepo.findById(agentId);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }

    const inlineTokens = parseInlineSkillTokens(inlineSkills);
    // listAllUserSkills 的 name 是 SKILL.md frontmatter 名（全链路技能身份标识），
    // 目录名只是存储布局且二者不强制一致——读盘必须用其返回的 folderPath，不能按名字重拼
    let userSkillsCache: Array<{ name: string; userId: number; folderPath: string }> | null = null;

    const skills: BundleSkill[] = [];
    const emittedSkillNames = new Set<string>();
    let inlineBytesTotal = 0;
    for (const name of parseStringArray(agent.skillNames)) {
      // 历史数据可能含重复 skillNames：bundle 内同名条目去重，避免导入端多归属/重复行问题
      if (emittedSkillNames.has(name)) continue;
      emittedSkillNames.add(name);
      if (this.skillLoader.hasSkill(name)) {
        if (inlineTokens.some((t) => t.name === name)) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${name}」是系统技能，只能以 reference 方式导出，不能内联`);
        }
        skills.push({ name, include: 'reference' });
        continue;
      }
      if (inlineTokens.some((t) => t.name === name)) {
        if (userSkillsCache == null) {
          userSkillsCache = this.userSkillService.listAllUserSkills()
            .map((s) => ({ name: s.name, userId: s.userId, folderPath: s.folderPath }));
        }
        const candidates = userSkillsCache.filter((s) => s.name === name);
        const tokensForName = inlineTokens.filter((t) => t.name === name);
        // 同名技能只能指定一个内联归属：多个 token 时归属行为不确定，明确报错而非静默取第一个
        if (tokensForName.length > 1) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${name}」指定了多个内联归属，请只保留一个 name@userId`);
        }
        const explicit = tokensForName.find((t) => t.userId != null);
        // 各用户同名（frontmatter）技能目录数：同一用户多目录时该用户归属无法表达——
        // 仅对请求所涉用户报错，其他用户的目录冲突不影响本次导出
        const dirsByUser = new Map<number, number>();
        for (const c of candidates) dirsByUser.set(c.userId, (dirsByUser.get(c.userId) ?? 0) + 1);
        const conflictUsers = new Set([...dirsByUser.entries()].filter(([, n]) => n > 1).map(([u]) => u));
        const conflictError = (userId: number) => new BusinessException(
          ErrorCode.PARAM_INVALID,
          `用户 ${userId} 存在多个同名技能「${name}」目录，无法内联导出，请先在个人技能中整理重名技能后重试`,
        );
        let ownerFolder: string;
        if (explicit?.userId != null) {
          if (conflictUsers.has(explicit.userId)) {
            throw conflictError(explicit.userId);
          }
          const found = candidates.find((c) => c.userId === explicit.userId);
          if (!found) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, `用户技能「${name}@${explicit.userId}」不存在，无法内联导出`);
          }
          ownerFolder = found.folderPath;
        } else {
          // 裸 token：剔除目录冲突的用户后按多用户/唯一候选消歧（候选列表不展示冲突用户，避免指向不可解析的归属）
          const selectable = candidates.filter((c) => !conflictUsers.has(c.userId));
          if (selectable.length === 0) {
            const conflicted = [...conflictUsers][0];
            if (conflicted != null) {
              throw conflictError(conflicted);
            }
            throw new BusinessException(ErrorCode.PARAM_INVALID, `未找到可内联的用户技能「${name}」`);
          }
          if (selectable.length > 1) {
            const ids = selectable.map((c) => `${name}@${c.userId}`).join('、');
            throw new BusinessException(ErrorCode.PARAM_INVALID, `用户技能「${name}」属于多个用户，请用 name@userId 指定归属：${ids}`);
          }
          ownerFolder = selectable[0].folderPath;
        }
        const { files, warnings } = readSkillFolderFiles(ownerFolder, name);
        for (const content of Object.values(files)) {
          inlineBytesTotal += Buffer.byteLength(content, 'utf8');
        }
        if (inlineBytesTotal > MAX_INLINE_BYTES) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `内联技能文本总量超过 ${Math.floor(MAX_INLINE_BYTES / 1024 / 1024)}MB 上限，请将该技能改用 reference 方式导出`);
        }
        skills.push(warnings.length > 0 ? { name, include: 'inline', files, warnings } : { name, include: 'inline', files });
        continue;
      }
      skills.push({ name, include: 'reference' });
    }

    const mcpServers: BundleMcpServer[] = [];
    for (const id of parseNumberArray(agent.mcpServerIds)) {
      mcpServers.push(await this.exportMcpServer(id));
    }

    const experiences: BundleExperience[] = (await this.experienceService.listByAgentId(agentId)).map((e) => ({
      content: e.content,
      sortOrder: e.sortOrder ?? 0,
      enabled: e.enabled === 1,
    }));
    const suggestedQuestions: BundleSuggestedQuestion[] = (await this.suggestedQuestionService.listByAgentId(agentId)).map((q) => ({
      content: q.content,
      sortOrder: q.sortOrder ?? 0,
    }));

    const bundle: AgentBundle = {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      agent: {
        name: agent.name,
        description: agent.description ?? null,
        systemPrompt: agent.systemPrompt,
        configJson: parseJsonObject(agent.configJson),
      },
      experiences,
      suggestedQuestions,
      skills,
      mcpServers,
    };
    return { bundle, filename: bundleFilename(agent.name) };
  }

  private async exportMcpServer(id: number): Promise<BundleMcpServer> {
    let server: McpServer;
    try {
      server = await this.mcpServerRuntime.getForRuntime(id);
    } catch (e) {
      if (e instanceof BusinessException) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器不存在（id=${id}），无法导出`);
      }
      throw e;
    }
    const serverType = server.serverType === TYPE_HTTP ? TYPE_HTTP : TYPE_STDIO;
    let env: Record<string, string> = {};
    if (hasText(server.envJson)) {
      try {
        env = this.mcpServerRuntime.decryptEnv(server);
      } catch {
        // 解密失败（常见为实例密钥不一致）：直接报错终止，不做"跳过该 server 静默导出"的降级
        throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器「${server.name ?? id}」环境变量解密失败，无法导出，请检查实例密钥配置后重试`);
      }
    }
    // env 值全量脱敏（不做按键名模式识别，宁多勿漏）；HTTP url 不脱敏（格式文档明示该边界）
    const envRedacted: Record<string, string> = {};
    for (const key of Object.keys(env)) {
      envRedacted[key] = REDACTED_PLACEHOLDER;
    }
    const definition: BundleMcpDefinition = serverType === TYPE_HTTP
      ? { serverType, command: null, args: null, url: server.url ?? null, env: envRedacted }
      : { serverType, command: server.command ?? null, args: parseStringArray(server.argsJson), url: null, env: envRedacted };
    return { name: server.name ?? `mcp-${id}`, definition };
  }

  // ---------------------------------------------------------------- 导入

  /**
   * 两段式导入：confirm=false 返回预检报告（不落库）；confirm=true 重新执行全部校验
   * （不信任前端缓存的预检结果，防并发窗口）后写盘/落库，返回 { agentId, report }。
   */
  async importBundle(rawBundle: unknown, confirm: boolean, operatorId: number): Promise<BundleImportReport | BundleImportResult> {
    const parsed = this.parseAndValidateBundle(rawBundle);
    const report = await this.buildImportPlan(parsed);
    if (!confirm) {
      return report;
    }

    // 1. inline 技能写盘：暂存交换；失败该技能降级为 import-failed，不阻断 Agent 创建
    let wroteSkill = false;
    for (const entry of report.skills) {
      if (entry.action !== 'will-import') continue;
      const skill = parsed.skills.find((s) => s.name === entry.name && s.include === 'inline' && s.files != null);
      if (skill == null) {
        entry.action = 'import-failed';
        entry.detail = 'bundle 内联技能缺少文件内容';
        continue;
      }
      const written = writeSkillStaged(this.skillLoader.getSkillsDir(), entry.name, skill.files!);
      if (written.ok) {
        wroteSkill = true;
        entry.action = 'ok';
        entry.detail = 'inline 技能已写入系统技能目录';
      } else {
        entry.action = 'import-failed';
        entry.detail = written.error;
      }
    }
    if (wroteSkill) {
      this.skillLoader.invalidateCache();
    }

    // 2. MCP 创建：新建即 DISABLED；不经 validateForAgent（DISABLED 态会被其拒绝），service 层直写
    const createdMcpIds: number[] = [];
    const createdNames = new Set<string>();
    for (const entry of report.mcpServers) {
      if (entry.action !== 'will-create-disabled') continue;
      // 与本次导入已创建的记录同名：视同名称冲突跳过（bundle 内同名条目防御）
      if (createdNames.has(entry.name)) {
        entry.action = 'skip-name-conflict';
        continue;
      }
      const mcp = parsed.mcpServers.find((m) => m.name === entry.name);
      if (mcp == null) {
        entry.action = 'skip-invalid';
        continue;
      }
      createdNames.add(entry.name);
      createdMcpIds.push(await this.createDisabledMcp(mcp));
    }

    // 3. Agent 落库：起提示词版本 v1；defaultModelId 置空（目标实例无意义）、enabled=1、isDefault=0
    const skillNames = parsed.skills.map((s) => s.name);
    const agent: Agent = {
      name: report.finalName,
      description: parsed.agent.description,
      avatarUrl: null,
      systemPrompt: parsed.agent.systemPrompt,
      creatorId: operatorId,
      configJson: parsed.agent.configJson == null ? null : JSON.stringify(parsed.agent.configJson),
      skillNames: skillNames.length > 0 ? JSON.stringify(skillNames) : null,
      mcpServerIds: createdMcpIds.length > 0 ? JSON.stringify(createdMcpIds) : null,
      defaultModelId: null,
      isDefault: 0,
      enabled: 1,
    };
    const agentId = await this.agentRepo.insert(agent);

    if (parsed.experiences.length > 0) {
      const inputs: ExperienceInput[] = parsed.experiences.map((e) => ({
        content: e.content, sortOrder: e.sortOrder, enabled: e.enabled,
      }));
      await this.experienceService.syncExperiences(agentId, inputs);
    }
    if (parsed.suggestedQuestions.length > 0) {
      const inputs: SuggestedQuestionInput[] = parsed.suggestedQuestions.map((q) => ({
        content: q.content, sortOrder: q.sortOrder,
      }));
      await this.suggestedQuestionService.syncSuggestedQuestions(agentId, inputs);
    }

    harnessLog('info', `Agent bundle imported: agentId=${agentId}, name=${report.finalName}, operator=${operatorId}, skills=${parsed.skills.length}, mcp=${createdMcpIds.length}`);
    return { agentId, report };
  }

  /**
   * URL 导入（P2）：服务端拉取远端 bundle 后完全复用 importBundle 两段式语义。
   * confirm=true 落库成功后 upsert agent_import_origin（uk agent_id，保留最近一次）；
   * contentHash 是后续 check-updates 的比对基准、systemPrompt 快照用于 localEdited 判定。
   */
  async importBundleFromUrl(rawUrl: string, confirm: boolean, operatorId: number): Promise<BundleImportReport | BundleImportResult> {
    const sourceUrl = validateSourceUrl(rawUrl);
    const bundle = await fetchBundleFromUrl(sourceUrl);
    const result = await this.importBundle(bundle, confirm, operatorId);
    if ('agentId' in result) {
      result.report.sourceUrl = sourceUrl;
      await this.originRepo.upsert(result.agentId, sourceUrl, computeBundleContentHash(bundle), bundle.agent.systemPrompt, operatorId);
      return result;
    }
    return { ...result, sourceUrl };
  }

  /**
   * 批量检查更新（P2）：changed 以导入时的 origin.content_hash 快照为基准（导入损耗会造成
   * "本地重导出 vs 远端"口径的永久假 changed，禁止）；localEdited 仅覆盖 systemPrompt 漂移。
   * 双 URL（origin.source_url 与 shared_agent_entry.source_url）不一致时条目优先（管理员显式维护）。
   */
  async checkUpdates(agentIds: number[] | null): Promise<BundleCheckUpdateItem[]> {
    const entryRows = await this.entrySourceLookup.listAll();
    const entryUrlByAgent = new Map<number, string>();
    for (const row of entryRows) {
      if (row.sourceUrl != null && row.sourceUrl.trim() !== '') entryUrlByAgent.set(row.agentId, row.sourceUrl.trim());
    }
    // value=null 表示"显式指定但无来源"：产出 error 项而非静默跳过
    const targets = new Map<number, string | null>();
    if (agentIds != null && agentIds.length > 0) {
      for (const id of agentIds) {
        const url = entryUrlByAgent.get(id) ?? (await this.originRepo.findByAgentId(id))?.sourceUrl ?? null;
        targets.set(id, url);
      }
    } else {
      for (const origin of await this.originRepo.listAll()) {
        targets.set(origin.agentId, origin.sourceUrl);
      }
      // 条目 source_url 优先于 origin（管理员显式维护），同 agentId 覆盖
      for (const [id, url] of entryUrlByAgent) {
        targets.set(id, url);
      }
    }

    const ids = [...targets.keys()];
    const results: BundleCheckUpdateItem[] = new Array(ids.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= ids.length) return;
        results[index] = await this.checkOneUpdate(ids[index], targets.get(ids[index]) ?? null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_UPDATE_CONCURRENCY, ids.length) }, () => worker()));
    return results;
  }

  private async checkOneUpdate(agentId: number, sourceUrl: string | null): Promise<BundleCheckUpdateItem> {
    const item: BundleCheckUpdateItem = {
      agentId, sourceUrl, originHash: null, remoteHash: null, changed: false, localEdited: false,
    };
    if (sourceUrl == null) {
      item.error = '无导入来源（从未 URL 导入且共享条目未配置远端来源）';
      return item;
    }
    const origin = await this.originRepo.findByAgentId(agentId).catch(() => null);
    item.originHash = origin?.contentHash ?? null;
    let bundle: AgentBundle;
    try {
      bundle = await fetchBundleFromUrl(sourceUrl);
      item.remoteHash = computeBundleContentHash(bundle);
    } catch (e) {
      item.error = (e as Error).message;
      return item;
    }
    if (origin == null) {
      item.error = '该 Agent 未通过 URL 导入过，无比对基线（可在共享条目配置远端来源后重新导入建立基线）';
      return item;
    }
    item.changed = item.remoteHash !== item.originHash;
    const agent = await this.agentRepo.findById(agentId).catch(() => null);
    if (agent == null) {
      item.error = 'Agent 不存在（可能已被删除）';
      return item;
    }
    item.localEdited = agent.systemPrompt !== origin.importedSystemPrompt;
    return item;
  }

  private async createDisabledMcp(mcp: { name: string; definition: BundleMcpDefinition }): Promise<number> {
    const def = mcp.definition;
    // bundle 契约中 env 值只能来自脱敏导出；导入端一律置空字符串、键名保留
    //（管理员在 MCP 编辑页可见需补填哪些键，补齐后手动启用）
    const env: Record<string, string> = {};
    if (def.env != null && typeof def.env === 'object' && !Array.isArray(def.env)) {
      for (const key of Object.keys(def.env)) {
        env[key] = '';
      }
    }
    const isStdio = def.serverType === TYPE_STDIO;
    const server: McpServer = {
      userId: GLOBAL_USER_ID,
      name: mcp.name,
      description: '由 bundle 导入',
      serverType: def.serverType,
      command: isStdio ? def.command ?? null : null,
      argsJson: isStdio ? JSON.stringify(Array.isArray(def.args) ? def.args.filter((a) => typeof a === 'string') : []) : null,
      url: isStdio ? null : def.url ?? null,
      envJson: Object.keys(env).length > 0 ? this.mcpCipher.encrypt(JSON.stringify(env)) ?? null : null,
      status: STATUS_DISABLED,
    };
    return this.mcpMapper.insert(server);
  }

  /** 公共校验（两段都执行）：格式识别 + 必填字段 + 字段级约束。 */
  private parseAndValidateBundle(raw: unknown): ParsedBundle {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidBundleFormat();
    }
    const bundle = raw as Record<string, unknown>;
    if (bundle.format !== BUNDLE_FORMAT || bundle.formatVersion !== BUNDLE_FORMAT_VERSION) {
      throw invalidBundleFormat();
    }

    const warnings: string[] = [];

    const rawAgent = bundle.agent;
    if (rawAgent == null || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 缺少 agent 定义');
    }
    const agent = rawAgent as Record<string, unknown>;
    const name = typeof agent.name === 'string' ? agent.name.trim() : '';
    if (name.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 Agent 名称不能为空');
    }
    if (name.length > MAX_AGENT_NAME_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `bundle 内 Agent 名称超过 ${MAX_AGENT_NAME_LENGTH} 字符上限`);
    }
    const systemPrompt = typeof agent.systemPrompt === 'string' ? agent.systemPrompt : '';
    if (systemPrompt.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内角色定义（systemPrompt）不能为空');
    }
    const description = typeof agent.description === 'string' ? agent.description : null;
    let configJson: Record<string, unknown> | null = null;
    if (agent.configJson != null) {
      if (typeof agent.configJson !== 'object' || Array.isArray(agent.configJson)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 configJson 必须为对象或 null');
      }
      configJson = agent.configJson as Record<string, unknown>;
    }

    const experiences: BundleExperience[] = [];
    if (bundle.experiences != null) {
      if (!Array.isArray(bundle.experiences)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 experiences 必须为数组');
      }
      bundle.experiences.forEach((item, index) => {
        const content = typeof (item as BundleExperience | null)?.content === 'string'
          ? (item as BundleExperience).content.trim() : '';
        // 超限条目跳过并列入 warnings，不整体失败（对齐 AgentExperienceService.MAX_CONTENT_LENGTH）
        if (content.length === 0 || content.length > AgentExperienceService.MAX_CONTENT_LENGTH) {
          warnings.push(`经验第 ${index + 1} 条已跳过：内容需 1～${AgentExperienceService.MAX_CONTENT_LENGTH} 字`);
          return;
        }
        const raw = item as BundleExperience;
        experiences.push({
          content,
          sortOrder: normalizeSortOrder(raw.sortOrder),
          enabled: raw.enabled !== false,
        });
      });
    }

    const suggestedQuestions: BundleSuggestedQuestion[] = [];
    if (bundle.suggestedQuestions != null) {
      if (!Array.isArray(bundle.suggestedQuestions)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 suggestedQuestions 必须为数组');
      }
      if (bundle.suggestedQuestions.length > AgentSuggestedQuestionService.MAX_ITEMS) {
        throw new BusinessException(ErrorCode.AGENT_SUGGESTED_QUESTION_LIMIT_EXCEEDED);
      }
      bundle.suggestedQuestions.forEach((item, index) => {
        const raw = (item ?? {}) as BundleSuggestedQuestion;
        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        // 超限整体 PARAM_INVALID（对齐 AgentSuggestedQuestionService 约束）
        if (content.length === 0 || content.length > AgentSuggestedQuestionService.MAX_CONTENT_LENGTH) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `推荐问题第 ${index + 1} 条内容无效（需 1～${AgentSuggestedQuestionService.MAX_CONTENT_LENGTH} 字）`);
        }
        suggestedQuestions.push({ content, sortOrder: normalizeSortOrder(raw.sortOrder) });
      });
    }

    const skills: ParsedBundle['skills'] = [];
    const seenSkillNames = new Set<string>();
    if (bundle.skills != null) {
      if (!Array.isArray(bundle.skills)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 skills 必须为数组');
      }
      bundle.skills.forEach((item, index) => {
        const raw = (item ?? {}) as BundleSkill;
        const skillName = typeof raw.name === 'string' ? raw.name : '';
        if (!isValidBundleSkillName(skillName)) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `技能第 ${index + 1} 条名称非法：需非空白、≤64 字符、不含路径分隔符与控制字符`);
        }
        // 重复技能名去重（保留首个）：否则落库 skillNames 含重复项，导出对话框会为同名生成多行并触发多归属报错
        if (seenSkillNames.has(skillName)) {
          warnings.push(`技能「${skillName}」重复条目已忽略`);
          return;
        }
        seenSkillNames.add(skillName);
        const include = raw.include === 'inline' ? 'inline' as const : 'reference' as const;
        let files: Record<string, string> | undefined;
        if (include === 'inline') {
          if (raw.files != null && (typeof raw.files !== 'object' || Array.isArray(raw.files))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${skillName}」的 files 必须为对象`);
          }
          files = {};
          for (const [path, content] of Object.entries(raw.files ?? {})) {
            if (typeof content !== 'string') {
              throw new BusinessException(ErrorCode.PARAM_INVALID, `技能「${skillName}」的文件 ${path} 内容必须为字符串`);
            }
            // 与导出/上传写入规则对称：隐藏路径段的文件不属于技能内容，直接丢弃（预检与写盘口径一致）
            if (isHiddenRelativePath(path)) continue;
            files[path] = content;
          }
        }
        skills.push({ name: skillName, include, files });
      });
    }

    const mcpServers: ParsedBundle['mcpServers'] = [];
    if (bundle.mcpServers != null) {
      if (!Array.isArray(bundle.mcpServers)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'bundle 内 mcpServers 必须为数组');
      }
      bundle.mcpServers.forEach((item, index) => {
        const raw = item as BundleMcpServer | null;
        const rawName = raw?.name;
        if (rawName != null && typeof rawName !== 'string') {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 第 ${index + 1} 条名称必须为字符串`);
        }
        const def = raw?.definition;
        if (def == null || typeof def !== 'object' || Array.isArray(def)) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 第 ${index + 1} 条缺少 definition 定义`);
        }
        mcpServers.push({
          name: rawName ?? '',
          definition: def as unknown as BundleMcpDefinition,
        });
      });
    }

    return {
      agent: { name, description, systemPrompt, configJson },
      experiences,
      suggestedQuestions,
      skills,
      mcpServers,
      warnings,
    };
  }

  /** 预检计划：名称冲突后缀、技能 action、MCP action。confirm 阶段重跑，不信任预检缓存。 */
  private async buildImportPlan(parsed: ParsedBundle): Promise<BundleImportReport> {
    const warnings = [...parsed.warnings];
    const existingNames = new Set((await this.agentRepo.selectList(null, true)).map((a) => a.name));
    const agentName = parsed.agent.name;
    const nameConflict = existingNames.has(agentName);
    let finalName = agentName;
    if (nameConflict) {
      // 后缀在截断后的原名上追加，保证 finalName ≤ 128；不覆盖任何现有 Agent
      let n = 0;
      for (;;) {
        n += 1;
        const suffix = n === 1 ? ' 副本' : ` 副本${n}`;
        const candidate = agentName.slice(0, Math.max(0, MAX_AGENT_NAME_LENGTH - suffix.length)) + suffix;
        if (!existingNames.has(candidate)) {
          finalName = candidate;
          break;
        }
        if (n > 10_000) {
          finalName = agentName.slice(0, MAX_AGENT_NAME_LENGTH - ' 副本'.length) + ' 副本';
          break;
        }
      }
    }

    const userSkills = this.userSkillService.listAllUserSkills();
    const skillEntries: BundleImportSkillEntry[] = [];
    for (const skill of parsed.skills) {
      if (skill.include === 'inline') {
        if (this.skillLoader.hasSkill(skill.name)) {
          skillEntries.push({
            name: skill.name, include: 'inline', action: 'exists-skip',
            detail: '系统技能目录已存在同名技能，不覆盖（Agent 仍引用该名称）',
          });
          continue;
        }
        const skillMd = skill.files?.['SKILL.md'];
        let mdError = skillMd == null
          ? 'bundle 内联技能缺少 SKILL.md'
          : validateSkillMd(skillMd, skill.name);
        // SkillLoader 按 frontmatter name 索引技能：条目名必须与 frontmatter 一致，否则写盘后引用悬空
        if (mdError == null) {
          const frontName = parseSkillMdContent(skillMd!)?.name?.trim();
          if (frontName !== skill.name) {
            mdError = `SKILL.md frontmatter name（${frontName ?? '缺失'}）与条目名（${skill.name}）不一致`;
          }
        }
        const pathError = mdError == null ? skillFilesPathError(skill.files ?? {}) : null;
        if (mdError != null || pathError != null) {
          skillEntries.push({
            name: skill.name, include: 'inline', action: 'import-failed',
            detail: mdError ?? pathError ?? '内联技能文件非法',
          });
          continue;
        }
        skillEntries.push({ name: skill.name, include: 'inline', action: 'will-import' });
        continue;
      }
      const exists = this.skillLoader.hasSkill(skill.name) || userSkills.some((s) => s.name === skill.name);
      skillEntries.push(exists
        ? { name: skill.name, include: 'reference', action: 'ok' }
        : {
            name: skill.name, include: 'reference', action: 'missing',
            detail: '目标实例未安装该技能，导入后不可用（不阻断导入）',
          });
    }

    const mcpEntries: BundleImportMcpEntry[] = [];
    for (const mcp of parsed.mcpServers) {
      const name = mcp.name;
      const def = mcp.definition;
      const nameOk = name.length <= MCP_NAME_MAX_LENGTH
        && MCP_NAME_PATTERN.test(name)
        && !name.includes('__');
      const fieldsError = mcpDefinitionError(def);
      const serverType = typeof def.serverType === 'string' ? def.serverType : '';
      if (!nameOk || fieldsError != null) {
        mcpEntries.push({ name, serverType, action: 'skip-invalid', definition: def });
        continue;
      }
      // 同名（跨全局+用户空间，复用现有查重口径）→ 跳过且 Agent 不绑该项
      const globalDup = await this.mcpMapper.countByUserIdAndName(GLOBAL_USER_ID, name);
      const crossDup = await this.mcpMapper.countByNameWhereUserIdNot(name, GLOBAL_USER_ID);
      if (globalDup > 0 || crossDup > 0) {
        mcpEntries.push({ name, serverType, action: 'skip-name-conflict', definition: def });
        continue;
      }
      mcpEntries.push({ name, serverType, action: 'will-create-disabled', definition: def });
    }

    return {
      agentName,
      finalName,
      nameConflict,
      systemPrompt: parsed.agent.systemPrompt,
      experiencesCount: parsed.experiences.length,
      suggestedQuestionsCount: parsed.suggestedQuestions.length,
      skills: skillEntries,
      mcpServers: mcpEntries,
      warnings,
    };
  }
}

function invalidBundleFormat(): BusinessException {
  return new BusinessException(ErrorCode.PARAM_INVALID, '不支持的 bundle 格式，format/formatVersion 不识别');
}

function mcpDefinitionError(def: BundleMcpDefinition): string | null {
  const type = def.serverType;
  if (type === TYPE_STDIO) {
    if (!hasText(def.command)) return 'STDIO 类型缺少启动命令';
    if (!Array.isArray(def.args) || def.args.length === 0 || !def.args.every((a) => typeof a === 'string')) {
      return 'STDIO 类型缺少启动参数（args 需为非空字符串数组）';
    }
    return null;
  }
  if (type === TYPE_HTTP) {
    const url = def.url ?? '';
    if (!hasText(url)) return 'HTTP 类型缺少服务器 URL';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'URL 必须以 http:// 或 https:// 开头';
    }
    return null;
  }
  return 'serverType 必须为 STDIO 或 HTTP';
}

/** bundle 技能名：非空白、≤64、不含路径分隔符与控制字符（agent.skillNames 现状无格式校验，导入侧拒绝不可读/危险字符）。 */
function isValidBundleSkillName(name: string): boolean {
  if (name.trim().length === 0 || name !== name.trim() || name.length > 64) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  if (/[/\\]/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

/**
 * bundle 内容指纹：同一内容多次导出得到同一 hash（exportedAt 每次变化，必须剔除）。
 * 规范化：浅拷贝删除 exportedAt → 递归排序对象键（数组保序）→ 紧凑 JSON → sha256 hex。
 * 导出、registry、check-updates 三处共用；check-updates 以导入时的快照 hash 为比对基准（见 docs/plan/2026-10-05-asset-distribution-technical-design.md §5.6/§5.8）。
 */
export function computeBundleContentHash(bundle: AgentBundle): string {
  const { exportedAt: _omit, ...rest } = bundle;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** inlineSkills 查询参数：逗号分隔 token，`name` 或 `name@userId`。 */
export function parseInlineSkillTokens(raw: string | null | undefined): Array<{ name: string; userId?: number }> {
  if (raw == null || raw.trim() === '') return [];
  return raw.split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      const at = token.lastIndexOf('@');
      if (at <= 0) return { name: token };
      const userId = Number(token.slice(at + 1));
      if (Number.isSafeInteger(userId) && userId > 0) {
        return { name: token.slice(0, at), userId };
      }
      return { name: token };
    });
}

function normalizeSortOrder(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string | null | undefined): number[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => Number.isSafeInteger(v));
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Content-Disposition 文件名仅保留 ASCII 安全子集；中文名清洗为连字符，空则回落 agent。 */
function bundleFilename(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return `mao-agent-bundle-${safe || 'agent'}-v1.json`;
}
