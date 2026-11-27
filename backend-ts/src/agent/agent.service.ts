import { validateAgentAvatarUrl } from './agent-avatar.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { AgentExperienceService } from './agent-experience.service.js';
import type { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import type {
  Agent,
  AgentExperience,
  AgentFeaturedTool,
  AgentRepository,
  AgentSuggestedQuestion,
  ExperienceInput,
  SuggestedQuestionInput,
} from './types.js';

/** Agent 默认模型 / 特色工具模型绑定校验所需的最小模型查询能力 */
export interface AgentModelLookup {
  findById(id: number): Promise<{
    id?: number;
    status?: number | null;
    modelType?: string | null;
    apiProtocol?: string | null;
  } | null>;
}

/**
 * 技能运行依赖按需安装的触发口（方案 2026-11-23 skill-runtime-deps）：Agent 勾选技能
 * 保存时把完整技能名单交给 SkillDepsService，由各 provider 自行过滤并 ensure。optional 注入
 * 保持既有构造兼容；实现方必须自吞异常（fire-and-forget），不得影响 Agent 保存。
 */
export interface AgentSkillDepsEnsurer {
  ensureForSkills(skillNames: readonly string[] | null | undefined): void;
}

/** 删除 Agent 时摘掉限定到该 Agent 的角色技能授权。agent_id = 0 的行不删。 */
export interface AgentSkillGrantCleaner {
  deleteByAgentId(agentId: number): Promise<void>;
}

export class AgentService {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly experienceService: AgentExperienceService,
    private readonly suggestedQuestionService: AgentSuggestedQuestionService,
    private readonly modelLookup?: AgentModelLookup,
    private readonly skillDepsEnsurer?: AgentSkillDepsEnsurer,
    private readonly skillGrantCleaner?: AgentSkillGrantCleaner,
  ) {}

  listAgents(
    _userId: number,
    keyword?: string | null,
    includeDisabled = false,
    clientVisibleOnly = false,
    /** true=仅返回未配置 git_allowed_domains 的 Agent（管理后台筛选）。 */
    missingGitAllowedDomains = false,
  ): Promise<Agent[]> {
    return this.agentRepo.selectList(keyword, includeDisabled, clientVisibleOnly, missingGitAllowedDomains);
  }

  async getAgent(id: number): Promise<Agent> {
    const agent = await this.agentRepo.findById(id);
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    return agent;
  }

  getDefaultAgent(): Promise<Agent | null> {
    return this.agentRepo.findDefault();
  }

  async requireDefaultAgent(): Promise<Agent> {
    const agent = await this.getDefaultAgent();
    if (!agent) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND, '未配置默认 Agent，请先在管理后台设置');
    }
    return agent;
  }

  async createAgent(
    userId: number,
    name: string,
    description: string | null | undefined,
    systemPrompt: string,
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    httpToolIds: number[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    suggestedQuestions: SuggestedQuestionInput[] | null | undefined,
    isDefault: number | null | undefined,
    defaultModelId: number | null | undefined,
    avatarUrl?: string | null,
    clientVisible?: boolean | null,
    experienceLibraryEnabled?: boolean | null,
    gitAllowedDomains?: string[] | null,
    featuredTools?: AgentFeaturedTool[] | null,
    /** 特色工具模型绑定（2026-11-27）：null/未提供都存 NULL（跟随类型默认）。 */
    imageModelId?: number | null,
    audioModelId?: number | null,
    /** 问题上报按 Agent 开关（2026-11-27）：false=关闭；缺省开启。追加在参数表末尾，不挤位既有调用。 */
    reportIssueEnabled?: boolean | null,
  ): Promise<Agent> {
    validateAgentAvatarUrl(avatarUrl);
    await this.requireFeaturedModel(imageModelId, 'image');
    await this.requireFeaturedModel(audioModelId, 'audio');
    const clientVisibleFlag = clientVisible === false ? 0 : 1;
    if (isDefault != null && isDefault === 1 && clientVisibleFlag === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '默认 Agent 必须客户端可见，请先更改默认 Agent 或开启客户端可见');
    }
    // 先校验默认模型再清旧默认旗标：clearDefaultFlag 是独立 UPDATE（自动提交），
    // 若顺序颠倒，校验失败时旧默认旗标已被清掉而新 Agent 尚未 insert → 全库零默认
    // Agent，后续所有会话创建被 requireDefaultAgent() 阻断，且表象与本次失败无关。
    await this.requireEnabledModel(defaultModelId);
    if (isDefault != null && isDefault === 1) {
      await this.agentRepo.clearDefaultFlag();
    }
    const agent: Agent = {
      name,
      description,
      avatarUrl: avatarUrl ?? null,
      systemPrompt,
      creatorId: userId,
      defaultModelId: defaultModelId ?? null,
      isDefault: isDefault != null ? isDefault : 0,
      enabled: 1,
      clientVisible: clientVisibleFlag,
      experienceLibraryEnabled: experienceLibraryEnabled === false ? 0 : 1,
      reportIssueEnabled: reportIssueEnabled === false ? 0 : 1,
    };
    if (skillNames != null && skillNames.length > 0) {
      agent.skillNames = JSON.stringify(skillNames);
    }
    if (mcpServerIds != null && mcpServerIds.length > 0) {
      agent.mcpServerIds = JSON.stringify(mcpServerIds);
    }
    if (httpToolIds != null && httpToolIds.length > 0) {
      agent.httpToolIds = JSON.stringify(httpToolIds);
    }
    if (gitAllowedDomains != null) {
      // '[]'（显式禁止）必须保留，不做「空数组 → null」折叠（技术方案 2026-11-06 三态语义）
      agent.gitAllowedDomains = JSON.stringify(gitAllowedDomains);
    }
    if (featuredTools != null && featuredTools.length > 0) {
      agent.featuredTools = JSON.stringify(featuredTools);
    }
    agent.imageModelId = imageModelId ?? null;
    agent.audioModelId = audioModelId ?? null;
    await this.agentRepo.insert(agent);
    if (skillNames != null) this.skillDepsEnsurer?.ensureForSkills(skillNames);

    if (experiences != null) {
      await this.experienceService.syncExperiences(agent.id!, experiences);
    }
    if (suggestedQuestions != null) {
      await this.suggestedQuestionService.syncSuggestedQuestions(agent.id!, suggestedQuestions);
    }

    return agent;
  }

  async updateAgent(
    operatorId: number,
    id: number,
    name: string | null | undefined,
    description: string | null | undefined,
    systemPrompt: string | null | undefined,
    skillNames: string[] | null | undefined,
    mcpServerIds: number[] | null | undefined,
    httpToolIds: number[] | null | undefined,
    experiences: ExperienceInput[] | null | undefined,
    suggestedQuestions: SuggestedQuestionInput[] | null | undefined,
    isDefault: number | null | undefined,
    defaultModelId: number | null | undefined,
    avatarUrl?: string | null,
    clientVisible?: boolean | null,
    experienceLibraryEnabled?: boolean | null,
    gitAllowedDomains?: string[] | null,
    featuredTools?: AgentFeaturedTool[] | null,
    /** 特色工具模型绑定（2026-11-27）：undefined=不修改；null=清空（跟随类型默认）；正整数=绑定。 */
    imageModelId?: number | null,
    audioModelId?: number | null,
    /** 问题上报按 Agent 开关（2026-11-27）：undefined/null=不修改；false=关闭；true=开启。追加在参数表末尾。 */
    reportIssueEnabled?: boolean | null,
  ): Promise<Agent> {
    validateAgentAvatarUrl(avatarUrl);
    const agent = await this.getAgent(id);
    if (imageModelId !== undefined) await this.requireFeaturedModel(imageModelId, 'image');
    if (audioModelId !== undefined) await this.requireFeaturedModel(audioModelId, 'audio');
    const nextClientVisible = clientVisible == null
      ? (agent.clientVisible ?? 1)
      : (clientVisible ? 1 : 0);
    // 默认 Agent 必须客户端可见：同一次请求同时改两个字段时，用合并后的最终状态判断
    const nextIsDefault = isDefault == null ? (agent.isDefault ?? 0) : isDefault;
    if (nextIsDefault === 1 && nextClientVisible === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '默认 Agent 必须客户端可见，请先更改默认 Agent 或开启客户端可见');
    }
    if (avatarUrl !== undefined) agent.avatarUrl = avatarUrl;
    if (name != null) agent.name = name;
    if (description != null) agent.description = description;
    if (systemPrompt != null) agent.systemPrompt = systemPrompt;
    if (skillNames != null) {
      agent.skillNames = skillNames.length === 0 ? null : JSON.stringify(skillNames);
      this.skillDepsEnsurer?.ensureForSkills(skillNames);
    }
    if (mcpServerIds != null) {
      agent.mcpServerIds = mcpServerIds.length === 0 ? null : JSON.stringify(mcpServerIds);
    }
    if (httpToolIds != null) {
      agent.httpToolIds = httpToolIds.length === 0 ? null : JSON.stringify(httpToolIds);
    }
    if (defaultModelId !== undefined) {
      await this.requireEnabledModel(defaultModelId);
      agent.defaultModelId = defaultModelId;
    }
    if (clientVisible != null) {
      agent.clientVisible = nextClientVisible;
    }
    if (experienceLibraryEnabled != null) {
      agent.experienceLibraryEnabled = experienceLibraryEnabled ? 1 : 0;
    }
    if (gitAllowedDomains !== undefined) {
      // 四态（技术方案 2026-11-06 §3.6）：undefined=不修改；null=清空；[]=显式禁止；非空=白名单。
      // 不能用 `!= null` 判断，否则 null 与 [] 都会被当成「不修改」——三态语义失效。
      agent.gitAllowedDomains = gitAllowedDomains == null ? null : JSON.stringify(gitAllowedDomains);
    }
    if (featuredTools != null) {
      // null / undefined 不修改（管理端始终提交数组）；[] 显式清空。
      agent.featuredTools = featuredTools.length === 0 ? null : JSON.stringify(featuredTools);
    }
    if (reportIssueEnabled != null) {
      agent.reportIssueEnabled = reportIssueEnabled ? 1 : 0;
    }
    // 绑定与 featuredTools 独立：未勾选对应能力时绑定仍可保存（休眠状态，UI 禁用下拉但保留值）。
    if (imageModelId !== undefined) agent.imageModelId = imageModelId;
    if (audioModelId !== undefined) agent.audioModelId = audioModelId;
    if (isDefault != null) {
      if (isDefault === 1) {
        if (agent.enabled === 0) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '已停用的 Agent 不能设为默认，请先启用');
        }
        await this.agentRepo.clearDefaultFlag();
      }
      agent.isDefault = isDefault;
    }
    await this.agentRepo.updateById(agent, operatorId, systemPrompt != null);

    await this.experienceService.syncExperiences(id, experiences);
    await this.suggestedQuestionService.syncSuggestedQuestions(id, suggestedQuestions);
    return agent;
  }

  async listPromptVersions(id: number) {
    await this.getAgent(id);
    return this.agentRepo.listPromptVersions(id);
  }

  async rollbackPrompt(id: number, version: number, operatorId: number): Promise<Agent> {
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '版本号必须为正整数');
    }
    return this.agentRepo.rollbackPrompt(id, version, operatorId);
  }

  async setEnabled(id: number, enabled: boolean): Promise<Agent> {
    const agent = await this.getAgent(id);
    const next = enabled ? 1 : 0;
    if (next === 0 && agent.isDefault === 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不能停用默认 Agent，请先指定其他默认 Agent');
    }
    if ((agent.enabled ?? 1) !== next) {
      await this.agentRepo.updateEnabled(id, next);
      agent.enabled = next;
    }
    return agent;
  }

  /** 团队经验库开关（技术方案 2026-10-24）：只改标记位，挂载/注入在各自装配点按位判定。 */
  async setExperienceLibraryEnabled(id: number, enabled: boolean): Promise<Agent> {
    const agent = await this.getAgent(id);
    const next = enabled ? 1 : 0;
    if ((agent.experienceLibraryEnabled ?? 1) !== next) {
      await this.agentRepo.updateExperienceLibraryEnabled(id, next);
      agent.experienceLibraryEnabled = next;
    }
    return agent;
  }

  async deleteAgent(id: number): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent.isDefault != null && agent.isDefault === 1) {
      throw new BusinessException(ErrorCode.AGENT_IS_DEFAULT);
    }
    await this.experienceService.deleteByAgentId(id);
    await this.suggestedQuestionService.deleteByAgentId(id);
    await this.skillGrantCleaner?.deleteByAgentId(id);
    await this.agentRepo.deleteById(id);
  }

  /** 默认模型必须存在且启用；null/undefined 表示未配置，直接跳过 */
  private async requireEnabledModel(defaultModelId: number | null | undefined): Promise<void> {
    if (defaultModelId == null) return;
    if (this.modelLookup == null) return;
    const model = await this.modelLookup.findById(defaultModelId);
    if (model == null || model.status !== 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '默认模型不存在或未启用');
    }
  }

  /**
   * 特色工具模型绑定校验（2026-11-27）：模型必须存在（未软删）、类型匹配；
   * audio 额外要求 OpenAI 兼容协议（anthropic / openai-responses 不序列化 audio，配了也「成功但无音频」）。
   * 不校验 status：允许先绑定后停用，运行时解析为不可用（fail-closed），表单提示「已绑定模型不可用」。
   */
  private async requireFeaturedModel(
    modelId: number | null | undefined,
    expectedType: 'image' | 'audio',
  ): Promise<void> {
    if (modelId == null) return;
    if (this.modelLookup == null) return;
    const label = expectedType === 'image' ? '图片模型' : '语音模型';
    const model = await this.modelLookup.findById(modelId);
    if (model == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `${label}不存在`);
    }
    if ((model.modelType ?? null) !== expectedType) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `${label}类型不匹配`);
    }
    if (expectedType === 'audio') {
      const protocol = (model.apiProtocol ?? '').trim();
      if (protocol !== '' && protocol !== 'openai-compatible') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '语音模型协议需为 OpenAI 兼容');
      }
    }
  }

  async removeSkillNameFromAll(skillName: string): Promise<number> {
    return this.agentRepo.removeSkillName(skillName);
  }

  getAgentExperiences(agentId: number): Promise<AgentExperience[]> {
    return this.experienceService.listByAgentId(agentId);
  }

  getAgentSuggestedQuestions(agentId: number): Promise<AgentSuggestedQuestion[]> {
    return this.suggestedQuestionService.listByAgentId(agentId);
  }
}
