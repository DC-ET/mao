import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { ClientImpersonation, ModelAuthType } from '@mao/contracts';
import { normalizeModelAuthType } from './types.js';
import type {
  LlmChatClient,
  LlmChatRequest,
  LlmChatResponse,
  LlmModel,
  LlmModelConfig,
  LlmModelRepository,
  ModelListFilter,
  ModelTestResult,
  SessionModelRepository,
} from './types.js';
import { createStaticOnlyAuthResolver, type LlmAuthResolver } from '../harness/llm/llm-auth.js';
import {
  callImageGenerations,
  normalizeImageModelName,
  normalizeImageUsage,
  toImageApiError,
  type ImageApiConfig,
  type ImageApiResult,
} from '../harness/tool/image-api-client.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../usage/llm-call-context.js';
import { harnessLog } from '../harness/log.js';
import type { AgentFeaturedModelBindingRepository } from '../agent/types.js';

const TTS_TEST_TEXT = '你好，欢迎使用 Mao 语音合成测试。';
const TTS_TEST_AUDIO = { format: 'wav' };
/** 文生图试生成：短提示 + 低质量，验证 /images/generations，不走聊天补全。 */
const IMAGE_PROBE_PROMPT = 'a white square';
const IMAGE_PROBE_SIZE = '1024x1024';
const IMAGE_PROBE_QUALITY = 'low';

/** 试生成记账端口，与图片工具的 ImageCallRecorder 同结构；未注入则不记流水。 */
interface ImageProbeRecorder {
  record(input: {
    model: LlmModel | null;
    resolvedModelName: string;
    usage: ReturnType<typeof normalizeImageUsage>;
    success: boolean;
    errorMessage?: string | null;
    durationMs: number;
    userId: number | null;
    sessionId: number | null;
    agentId: number | null;
  }): Promise<void>;
}

export interface ImageModelProbe {
  authResolver?: LlmAuthResolver;
  callGenerations?: (cfg: ImageApiConfig, params: {
    prompt: string;
    n?: number;
    size?: string;
    quality?: string;
  }) => Promise<ImageApiResult>;
  recorder?: ImageProbeRecorder | null;
}

const CLIENT_IMPERSONATION_VALUES = ['none', 'codex', 'claude_code'] as const;
const AUTH_TYPE_VALUES = ['api_key', 'ecp'] as const;

function normalizeClientImpersonation(
  value: string | null | undefined,
): ClientImpersonation | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!(CLIENT_IMPERSONATION_VALUES as readonly string[]).includes(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `clientImpersonation 只能是 ${CLIENT_IMPERSONATION_VALUES.join(' / ')} 之一`,
    );
  }
  return trimmed as ClientImpersonation;
}

/** 凭证方式写侧解析：null/undefined/空串表示未提供（返回 null，不更新）；非法值抛参数错误。 */
function normalizeAuthTypeInput(value: string | null | undefined): ModelAuthType | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!(AUTH_TYPE_VALUES as readonly string[]).includes(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `authType 只能是 ${AUTH_TYPE_VALUES.join(' / ')} 之一`,
    );
  }
  return trimmed as ModelAuthType;
}

/**
 * 0/1 标志归一：0/false → 0，1/true/非零数 → 1；null/undefined = 未提供（返回 null）。
 * 前端表单可能直接提交布尔（JSON true/false），严格 `=== 1` 比较会漏判。
 */
function normalizeFlag01(value: number | boolean | null | undefined): number | null {
  if (value == null) return null;
  if (value === 0 || value === false) return 0;
  return 1;
}

/**
 * 默认模型必须对客户端可见（与「默认 Agent 必须客户端可见」同口径）。
 * 否则客户端新建态从 /v1/models/default 拿到的模型不在候选列表里，用户看到一个选不回来的名字。
 */
function requireDefaultModelVisible(isDefault: number, clientVisible: number): void {
  if (isDefault === 1 && clientVisible === 0) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      '默认模型必须对客户端可见，请先取消默认或打开「客户端可选」',
    );
  }
}

/**
 * 语音默认模型必须 OpenAI 兼容（2026-11-27 特色工具模型绑定）：anthropic / openai-responses
 * 适配器不序列化 audio 字段，默认指向这类模型会让所有未绑定 Agent 的 TTS / 微信语音
 * 「成功但无音频」。apiProtocol 已归一：'' = OpenAI 兼容。
 */
function requireAudioDefaultCompatible(isDefault: number, modelType: string, apiProtocol: string): void {
  if (isDefault === 1 && modelType === 'audio' && apiProtocol !== '') {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      '语音默认模型必须使用 OpenAI 兼容协议',
    );
  }
}

const API_PROTOCOL_VALUES = ['', 'openai-compatible', 'anthropic', 'openai-responses'] as const;

/** 校验并归一 API 协议：openai-compatible 与空串都归一为 ''（OpenAI 兼容）；null/undefined 表示未提供。 */
function normalizeApiProtocol(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!(API_PROTOCOL_VALUES as readonly string[]).includes(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `apiProtocol 只能是 ${API_PROTOCOL_VALUES.filter((v) => v !== '').join(' / ')} 或留空`,
    );
  }
  return trimmed === 'openai-compatible' ? '' : trimmed;
}

const EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 供应商请求体上限（字节）：null/0 表示未声明；非法值显式拒绝，避免阈值被写成负数。 */
function normalizeMaxRequestBodyBytes(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_REQUEST_BODY_BYTES) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `请求体上限必须是 0~${MAX_REQUEST_BODY_BYTES} 之间的整数（字节），0 或留空表示未声明`,
    );
  }
  return value > 0 ? value : null;
}

/** 价格列 DECIMAL(12,6)：整数位 6 位、小数位 6 位。超上限直接写库会触发 MySQL 1264 让接口 500；
 *  小数位超过 6 位则被静默四舍五入（0.0000004 → 0.000000，一个"拿钱买"的模型变成免费模型），
 *  两者都必须在应用层显式拦截，不能依赖数据库行为。 */
const PRICE_MAX = 999999.999999;
const PRICE_DECIMALS = 6;
/** 请求体上限的合理上界（2GB），防止把阈值写成天文数字或负数。 */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;

/** 价格校验：null 表示不计成本；填写的值必须是非负有限数且完整落在 DECIMAL(12,6) 值域内。 */
function normalizePrice(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${field} 必须是非负数字`);
  }
  if (value > PRICE_MAX) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      `${field} 不能超过 ${PRICE_MAX}（每百万 token 价格，成本单位）`,
    );
  }
  // 与「小数位会被截断」语义对齐：四舍五入后值变了就说明用户填了存不下的精度，
  // 直接拒绝而非替用户取整——静默取整会让 0 价与亚微价格无法区分。
  if (Number(value.toFixed(PRICE_DECIMALS)) !== value) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      `${field} 最多保留 ${PRICE_DECIMALS} 位小数`,
    );
  }
  return value;
}

/** 校验并归一 reasoning effort：空串表示使用协议默认值；null/undefined 表示未提供。 */
function normalizeEffort(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!(EFFORT_VALUES as readonly string[]).includes(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID.code,
      `effort 只能是 ${EFFORT_VALUES.join(' / ')} 或留空`,
    );
  }
  return trimmed;
}

export class ModelService {
  constructor(
    private readonly modelRepo: LlmModelRepository,
    private readonly sessionRepo: SessionModelRepository,
    private readonly llmClient: LlmChatClient,
    private readonly llmClients?: Map<string, LlmChatClient>,
    /** ECP 登录开关判定（写侧校验 ecp 凭证方式；未注入时视为未启用，fail-closed）。 */
    private readonly isEcpEnabled?: () => Promise<boolean>,
    /** 文生图试生成依赖；缺省用固定 Key 解析器 + 真实 Images API，不记流水。 */
    imageProbe?: ImageModelProbe,
    /**
     * Agent 特色工具模型绑定端口（2026-11-27）：deleteModel 清理绑定、updateModel 类型变更守卫用。
     * 可选注入：精简单测不传时跳过这两步（与 modelLookup 缺省同款的精简装配口径）。
     */
    private readonly featuredModelBindings?: AgentFeaturedModelBindingRepository,
  ) {
    this.imageAuthResolver = imageProbe?.authResolver ?? createStaticOnlyAuthResolver();
    this.imageCallGenerations = imageProbe?.callGenerations ?? callImageGenerations;
    this.imageRecorder = imageProbe?.recorder ?? null;
  }

  private readonly imageAuthResolver: LlmAuthResolver;
  private readonly imageCallGenerations: NonNullable<ImageModelProbe['callGenerations']>;
  private readonly imageRecorder: ImageProbeRecorder | null;

  /** ecp 凭证方式要求系统已启用 ECP 飞书登录。 */
  private async requireEcpEnabled(): Promise<void> {
    const enabled = this.isEcpEnabled != null ? await this.isEcpEnabled().catch(() => false) : false;
    if (!enabled) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID.code,
        'ECP 飞书登录未启用，无法选择「ECP Token」凭证方式',
      );
    }
  }

  /** 按 apiProtocol 协议 code 选择连通性测试客户端，未注册的回落默认 OpenAI 兼容客户端。 */
  private chatClientFor(config: LlmModelConfig): LlmChatClient {
    const code = config.apiProtocol?.trim().toLowerCase();
    if (code != null && this.llmClients?.has(code)) return this.llmClients.get(code)!;
    return this.llmClient;
  }

  async listModels(
    page: number,
    size: number,
    keyword?: string | null,
    provider?: string | null,
    status?: number | null,
    supportsVision?: number | null,
    isDefault?: number | null,
    modelType?: string | null,
    /** 客户端可选筛选：1=可选 0=仅管理端；null/undefined=不筛。 */
    clientVisible?: number | null,
  ): Promise<{ records: LlmModel[]; total: number; page: number; size: number }> {
    const filter: ModelListFilter = {
      keyword, provider, status, supportsVision, isDefault, modelType, clientVisible,
    };
    const result = await this.modelRepo.selectPage(page, size, filter);
    return { records: result.records, total: result.total, page, size };
  }

  async listProviders(): Promise<string[]> {
    const providers = await this.modelRepo.listProviders();
    return providers
      .filter((provider): provider is string => typeof provider === 'string')
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);
  }

  /** clientVisibleOnly=true 只返回客户端可选模型（客户端选择器用）；缺省保持全量。 */
  listActiveModels(clientVisibleOnly = false): Promise<LlmModel[]> {
    return this.modelRepo.listActiveText(clientVisibleOnly);
  }

  /**
   * 语音模型解析（2026-11-27 特色工具模型绑定）：显式默认（is_default=1 且启用且协议兼容）
   * → 首个启用（改造前行为兜底）。微信语音回复经此方法，改默认后立即跟随。
   */
  async findFirstActiveAudioModel(): Promise<LlmModel | null> {
    return (await this.modelRepo.findDefaultByType('audio')) ?? this.modelRepo.findFirstActiveAudioModel();
  }

  /** 图片模型解析：显式默认（is_default=1 且启用）→ 首个启用（改造前行为兜底）。 */
  async findFirstActiveImageModel(): Promise<LlmModel | null> {
    return (await this.modelRepo.findDefaultByType('image')) ?? this.modelRepo.findFirstActiveByType('image');
  }

  /** 按类型取默认模型（is_default=1 且启用；audio 额外要求协议兼容）；无默认返回 null。 */
  getDefaultModelByType(type: 'text' | 'image' | 'audio'): Promise<LlmModel | null> {
    if (type === 'text') return this.modelRepo.findDefault();
    return this.modelRepo.findDefaultByType(type);
  }

  /** Agent 表单候选（2026-11-27）：启用、未软删的同类型模型（audio 仅 OpenAI 兼容），id ASC。 */
  async listFeaturedModelOptions(): Promise<{ image: LlmModel[]; audio: LlmModel[] }> {
    const [image, audio] = await Promise.all([
      this.modelRepo.listActiveByType('image'),
      this.modelRepo.listActiveByType('audio'),
    ]);
    return { image, audio };
  }

  getDefaultModel(): Promise<LlmModel | null> {
    return this.modelRepo.findDefault();
  }

  async getModel(id: number): Promise<LlmModel> {
    const model = await this.modelRepo.findById(id);
    if (!model) {
      throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
    }
    return model;
  }

  async createModel(
    name: string,
    provider: string | null | undefined,
    baseUrl: string,
    apiKey: string | null | undefined,
    modelId: string,
    supportsVision: number | null | undefined,
    /** 默认模型标记：1/true=是 0/false=否；布尔同样接受（前端表单可能直接提交布尔）。 */
    isDefault: number | boolean | null | undefined,
    contextWindowTokens: number | null | undefined,
    modelType: string | null | undefined,
    clientImpersonation: string | null | undefined,
    apiProtocol: string | null | undefined,
    effort: string | null | undefined,
    priceInput: number | null | undefined,
    priceCacheRead: number | null | undefined,
    priceCacheWrite: number | null | undefined,
    priceOutput: number | null | undefined,
    maxRequestBodyBytes?: number | null,
    /** 凭证方式：api_key（默认）/ ecp（当前用户 ECP Token）。 */
    authType?: string | null,
    /** 客户端可选：缺省 1（可见）；0/false=仅管理端可配置。 */
    clientVisible?: number | boolean | null,
  ): Promise<LlmModel> {
    const authTypeValue = normalizeAuthTypeInput(authType) ?? 'api_key';
    // 客户端可选：缺省可见；0/false 显式关闭。与 isDefault 共用同一套 0/1 归一。
    const clientVisibleValue = normalizeFlag01(clientVisible) ?? 1;
    const isDefaultValue = normalizeFlag01(isDefault) ?? 0;
    // 最终类型/协议必须先算出来：is_default 按 model_type 作用域（2026-11-27 特色工具模型绑定），
    // 清默认与默认校验都要用到；且归一化可能抛 PARAM_INVALID，必须先于清默认（否则校验失败时旧默认已被清）。
    const modelTypeValue = hasText(modelType) ? modelType!.trim() : 'text';
    // 文生图只走 Images API，不保存聊天协议与推理力度（提交值一律忽略）。
    const imageModel = modelTypeValue === 'image';
    const apiProtocolValue = imageModel ? '' : (normalizeApiProtocol(apiProtocol) ?? '');
    const effortValue = imageModel ? '' : (normalizeEffort(effort) ?? '');
    // 「默认必须客户端可见」仅约束 text：image/audio 不参与客户端模型选择器。
    if (modelTypeValue === 'text') {
      requireDefaultModelVisible(isDefaultValue, clientVisibleValue);
    }
    requireAudioDefaultCompatible(isDefaultValue, modelTypeValue, apiProtocolValue);
    if (authTypeValue === 'ecp') await this.requireEcpEnabled();
    // api_key 模式必须有固定 Key：避免直连 API 创建出必然 401 的空 Key 模型（前端/CLI 均有必填校验）。
    if (authTypeValue === 'api_key' && !hasText(apiKey)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID.code, '请输入 API Key');
    }
    // 用归一后的值判断：前端可能提交布尔 true，裸比较会漏清旧默认标记（出现两个 is_default=1）。
    if (isDefaultValue === 1) {
      await this.modelRepo.clearDefaultFlag(modelTypeValue);
    }
    const model: LlmModel = {
      name,
      provider,
      apiProtocol: apiProtocolValue,
      effort: effortValue,
      baseUrl,
      // api_key 列 NOT NULL：ecp 模式（或未提供 Key 的创建请求）统一写空串占位。
      apiKey: apiKey ?? '',
      modelId,
      modelType: modelTypeValue,
      clientImpersonation: normalizeClientImpersonation(clientImpersonation) ?? 'none',
      authType: authTypeValue,
      supportsVision: supportsVision != null ? supportsVision : 0,
      isDefault: isDefaultValue,
      clientVisible: clientVisibleValue,
      contextWindowTokens,
      maxRequestBodyBytes: normalizeMaxRequestBodyBytes(maxRequestBodyBytes) ?? null,
      priceInput: normalizePrice(priceInput, 'priceInput'),
      priceCacheRead: normalizePrice(priceCacheRead, 'priceCacheRead'),
      priceCacheWrite: normalizePrice(priceCacheWrite, 'priceCacheWrite'),
      priceOutput: normalizePrice(priceOutput, 'priceOutput'),
      status: 1,
    };
    await this.modelRepo.insert(model);
    return model;
  }

  async updateModel(
    id: number,
    name: string | null | undefined,
    provider: string | null | undefined,
    baseUrl: string | null | undefined,
    apiKey: string | null | undefined,
    modelId: string | null | undefined,
    supportsVision: number | null | undefined,
    /** 默认模型标记：1/true=是 0/false=否；布尔同样接受（前端表单可能直接提交布尔）。 */
    isDefault: number | boolean | null | undefined,
    contextWindowTokens: number | null | undefined,
    modelType: string | null | undefined,
    clientImpersonation: string | null | undefined,
    apiProtocol: string | null | undefined,
    effort: string | null | undefined,
    priceInput: number | null | undefined,
    priceCacheRead: number | null | undefined,
    priceCacheWrite: number | null | undefined,
    priceOutput: number | null | undefined,
    maxRequestBodyBytes?: number | null,
    /** 凭证方式：未提供=保持原值；api_key / ecp 显式切换。 */
    authType?: string | null,
    /** 客户端可选：未提供=保持原值；0/false=仅管理端可配置。 */
    clientVisible?: number | boolean | null,
  ): Promise<LlmModel> {
    const model = await this.getModel(id);
    const nextClientVisible = normalizeFlag01(clientVisible) ?? (model.clientVisible ?? 1);
    const isDefaultValue = normalizeFlag01(isDefault);
    // 先算「最终状态」再校验/清默认：is_default 按 model_type 作用域（2026-11-27 特色工具模型绑定），
    // 顺序颠倒会在 clearDefaultFlag 之后才发现组合非法（默认标记已被别的模型抢走）。
    const prevModelType = (model.modelType ?? 'text').trim() || 'text';
    const nextModelType = hasText(modelType) ? modelType!.trim() : prevModelType;
    const typeChanged = nextModelType !== prevModelType;
    // image 无聊天协议（强制清空）；其它类型按提交值归一，未提交则保留原值。
    const nextApiProtocol = nextModelType === 'image'
      ? ''
      : (normalizeApiProtocol(apiProtocol) ?? (model.apiProtocol ?? ''));
    let nextIsDefault = isDefaultValue ?? (model.isDefault ?? 0);
    if (typeChanged) {
      // 绑定按 id 指向本模型，类型一变绑定语义就漂了（Agent 绑图片模型却变成文本模型）。
      // 有绑定时拒绝，提示先解绑（API 层能力，UI 本就禁用类型修改）。
      const bindings = this.featuredModelBindings != null
        ? await this.featuredModelBindings.countBindingsByModelId(id)
        : 0;
      if (bindings > 0) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID.code,
          '该模型已被 Agent 绑定为特色工具模型，请先在 Agent 中解绑后再修改类型',
        );
      }
      // 类型变更不继承默认标记：请求没有显式 isDefault=1 时强制归零，
      // 避免「文本默认模型改成图片后自动变成图片默认」。
      if (isDefaultValue == null) nextIsDefault = 0;
    }
    // 「默认必须客户端可见」仅约束 text：image/audio 不参与客户端模型选择器。
    if (nextModelType === 'text') {
      requireDefaultModelVisible(nextIsDefault, nextClientVisible);
    }
    // 协议从兼容改成不兼容且最终是默认语音模型：拒绝，保证默认语音模型始终可用。
    requireAudioDefaultCompatible(nextIsDefault, nextModelType, nextApiProtocol);
    if (name != null) model.name = name;
    if (provider != null) model.provider = provider;
    if (baseUrl != null) model.baseUrl = baseUrl;
    if (apiKey != null) model.apiKey = apiKey;
    if (modelId != null) model.modelId = modelId;
    if (typeChanged) model.modelType = nextModelType;
    if (nextModelType === 'image') {
      // 文生图没有聊天协议：无论本次是否提交，都清掉已存的协议与推理力度。
      model.apiProtocol = '';
      model.effort = '';
    } else {
      // 协议值已在上方按最终类型归一过（nextApiProtocol），这里只在显式提交时回写。
      if (apiProtocol != null) model.apiProtocol = nextApiProtocol;
      const effortValue = normalizeEffort(effort);
      if (effortValue != null) model.effort = effortValue;
    }
    const impersonation = normalizeClientImpersonation(clientImpersonation);
    if (impersonation != null) model.clientImpersonation = impersonation;
    const authTypeValue = normalizeAuthTypeInput(authType);
    if (authTypeValue != null) {
      // 仅在「从其它方式切到 ecp」时要求开关开启：开关关闭后仍允许编辑已是 ecp 的模型
      // （改名称/价格等），也允许切回 api_key。
      if (authTypeValue === 'ecp' && normalizeModelAuthType(model.authType) !== 'ecp') {
        await this.requireEcpEnabled();
      }
      model.authType = authTypeValue;
    }
    if (supportsVision != null) model.supportsVision = supportsVision;
    if (contextWindowTokens != null) model.contextWindowTokens = contextWindowTokens;
    const maxRequestBody = normalizeMaxRequestBodyBytes(maxRequestBodyBytes);
    if (maxRequestBody !== undefined) model.maxRequestBodyBytes = maxRequestBody;
    // 价格字段显式区分「未提供」（undefined=保留）与「提供为 null」（清空=不计成本）：
    // 前端编辑表单总是回传全部价格字段，清空输入框即显式置 null。
    if (priceInput !== undefined) model.priceInput = normalizePrice(priceInput, 'priceInput');
    if (priceCacheRead !== undefined) model.priceCacheRead = normalizePrice(priceCacheRead, 'priceCacheRead');
    if (priceCacheWrite !== undefined) model.priceCacheWrite = normalizePrice(priceCacheWrite, 'priceCacheWrite');
    if (priceOutput !== undefined) model.priceOutput = normalizePrice(priceOutput, 'priceOutput');
    model.clientVisible = nextClientVisible;
    // 显式设默认时只清同类型旧默认；类型变更且未显式 isDefault=1 时 nextIsDefault 已被强制归零。
    if (isDefaultValue === 1) {
      await this.modelRepo.clearDefaultFlag(nextModelType);
    }
    model.isDefault = nextIsDefault;
    await this.modelRepo.updateById(model);
    return model;
  }

  async deleteModel(id: number): Promise<void> {
    const model = await this.getModel(id);
    if (model.isDefault != null && model.isDefault === 1) {
      throw new BusinessException(ErrorCode.MODEL_IS_DEFAULT);
    }
    // 清理 Agent 特色工具绑定（2026-11-27），避免悬空 id；清理失败的兜底是运行时
    // findById 返回 null → 工具隐藏（fail-closed），所以这里失败不阻断删除，但优先保证清成。
    if (this.featuredModelBindings != null) {
      try {
        const cleared = await this.featuredModelBindings.clearByModelId(id);
        if (cleared > 0) {
          harnessLog('info', `[featured-model] deleteModel id=${id} 清理了 ${cleared} 个 Agent 绑定列`);
        }
      } catch (e) {
        harnessLog('warn', `[featured-model] deleteModel id=${id} 清理 Agent 绑定失败（运行时按绑定失效处理）: ${(e as Error).message}`);
      }
    }
    const defaultModel = await this.getDefaultModel();
    const defaultModelId = defaultModel != null ? defaultModel.id! : null;
    await this.sessionRepo.reassignModelId(id, defaultModelId);
    await this.modelRepo.deleteById(id);
  }

  async updateStatus(id: number, status: number | null | undefined): Promise<void> {
    if (status == null || (status !== 0 && status !== 1)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID.code, '状态值只能是 0 或 1');
    }
    const model = await this.getModel(id);
    // 「不能停用唯一启用模型」守卫仅约束 text（2026-11-27 特色工具模型绑定）：
    // image/audio 默认允许停用——解析器忽略停用默认并回退首个启用模型。
    if (status === 0 && model.isDefault != null && model.isDefault === 1
      && (model.modelType ?? 'text') === 'text') {
      // 只数「同样能当默认」的启用中 text 模型——findDefault() 带 model_type = 'text'，
      // 拿 audio/image 计数会让守卫在"还有别的默认可用"时误判为唯一而拒绝停用。
      const activeCount = await this.modelRepo.countActiveTextExcept(model.id!);
      if (activeCount === 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID.code, '不能停用唯一启用的模型，请先启用其他模型');
      }
      // 停用不动 is_default：默认指定是独立语义，取消只能走显式的 updateModel(isDefault = 0)。
      // 这里顺手清零会让 deleteModel 的守卫被绕过，且 findDefault()（要求 status = 1）
      // 随后返回 null → reassignModelId(id, null) 把所有 session.model_id 置 NULL，
      // 会话再跑时抛 MODEL_NOT_FOUND。
    }
    model.status = status;
    await this.modelRepo.updateById(model);
  }

  async testConnectivity(id: number, actorUserId?: number | null): Promise<ModelTestResult> {
    const model = await this.getModel(id);
    const config: LlmModelConfig = {
      id: model.id,
      name: model.name,
      provider: model.provider,
      apiProtocol: model.apiProtocol,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelId: model.modelId,
      clientImpersonation: normalizeClientImpersonation(model.clientImpersonation) ?? 'none',
      authType: normalizeModelAuthType(model.authType),
    };
    const startTime = Date.now();
    if (model.modelType === 'audio') {
      return this.testAudioSynthesis(config, startTime, actorUserId);
    }
    if ((model.modelType ?? '').trim() === 'image') {
      return this.testImageGeneration(model, startTime, actorUserId);
    }

    try {
      const request: LlmChatRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const response = await LlmCallContext.runAsync({
        scene: LLM_CALL_SCENES.CONNECTIVITY_TEST,
        userId: actorUserId ?? null,
        sessionId: null,
        agentId: null,
      }, async () => this.chatClientFor(config).chat(request, config));
      return {
        connectivity: true,
        connectivityOutput: extractChatContent(response),
        durationMs: Date.now() - startTime,
      };
    } catch (e) {
      return {
        connectivity: false,
        connectivityOutput: null,
        error: `连通性测试失败: ${errorMessage(e)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async testAudioSynthesis(config: LlmModelConfig, startTime: number, actorUserId?: number | null): Promise<ModelTestResult> {
    try {
      const request: LlmChatRequest = {
        messages: [{ role: 'assistant', content: TTS_TEST_TEXT }],
        audio: TTS_TEST_AUDIO,
      };
      const response = await LlmCallContext.runAsync({
        scene: LLM_CALL_SCENES.CONNECTIVITY_TEST,
        userId: actorUserId ?? null,
        sessionId: null,
        agentId: null,
      }, async () => this.chatClientFor(config).chat(request, config));
      if (!response?.choices || response.choices.length === 0) {
        return this.buildAudioTestFailure('语音合成接口未返回结果', startTime);
      }
      const audio = response.choices[0].message?.audio;
      if (!audio?.data || !audio.data.trim()) {
        return this.buildAudioTestFailure('语音合成接口未返回音频数据', startTime);
      }
      let audioBytes: Buffer;
      try {
        audioBytes = Buffer.from(audio.data, 'base64');
      } catch (e) {
        return this.buildAudioTestFailure(`音频数据解码失败: ${errorMessage(e)}`, startTime);
      }
      if (audioBytes.length === 0) {
        return this.buildAudioTestFailure('合成的音频数据为空', startTime);
      }
      const format = hasText(audio.format) ? audio.format! : 'wav';
      const wavInfo = format.toLowerCase() === 'wav' ? parseWavInfo(audioBytes) : null;
      if (wavInfo && wavInfo.sampleRate > 0 && wavInfo.durationMs > 0) {
        return {
          connectivity: true,
          audioTest: true,
          audioFormat: format,
          audioData: audio.data,
          audioSizeBytes: audioBytes.length,
          audioSampleRate: wavInfo.sampleRate,
          audioDurationMs: wavInfo.durationMs,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        connectivity: true,
        audioTest: true,
        audioFormat: format,
        audioData: audio.data,
        audioSizeBytes: audioBytes.length,
        durationMs: Date.now() - startTime,
      };
    } catch (e) {
      return this.buildAudioTestFailure(`语音合成测试失败: ${errorMessage(e)}`, startTime);
    }
  }

  private async testImageGeneration(
    model: LlmModel,
    startTime: number,
    actorUserId?: number | null,
  ): Promise<ModelTestResult> {
    const fail = (error: string): ModelTestResult => ({
      connectivity: false,
      imageTest: true,
      error,
      durationMs: Date.now() - startTime,
    });
    const cfg = imageApiConfigFromModel(model);
    if (!cfg.baseUrl) return fail('文生图模型未配置 base_url');
    if (!cfg.model) return fail('文生图模型未配置 model_id');

    let upstreamAttempted = false;
    try {
      cfg.apiKey = await this.imageAuthResolver.resolveApiKey({
        id: model.id,
        modelId: model.modelId,
        apiKey: cfg.apiKey,
        authType: model.authType,
      }, actorUserId);
      upstreamAttempted = true;
      const result = await this.imageCallGenerations(cfg, {
        prompt: IMAGE_PROBE_PROMPT,
        n: 1,
        size: IMAGE_PROBE_SIZE,
        quality: IMAGE_PROBE_QUALITY,
      });
      if (!result.images?.length) {
        await this.recordImageProbe(model, cfg.model, normalizeImageUsage(result.usage), false, '图片生成接口未返回图片', startTime, actorUserId);
        return fail('试生成失败: 图片生成接口未返回图片');
      }
      await this.recordImageProbe(model, cfg.model, normalizeImageUsage(result.usage), true, null, startTime, actorUserId);
      return {
        connectivity: true,
        imageTest: true,
        durationMs: Date.now() - startTime,
      };
    } catch (e) {
      const err = toImageApiError(e, cfg.apiKey);
      if (upstreamAttempted) {
        await this.recordImageProbe(
          model, cfg.model, err.usage ?? null, false, err.message, startTime, actorUserId,
        );
      }
      return fail(`试生成失败: ${err.message}`);
    }
  }

  private async recordImageProbe(
    model: LlmModel,
    resolvedModelName: string,
    usage: ReturnType<typeof normalizeImageUsage>,
    success: boolean,
    errorMessage: string | null,
    startTime: number,
    actorUserId?: number | null,
  ): Promise<void> {
    if (!this.imageRecorder) return;
    try {
      await this.imageRecorder.record({
        model,
        resolvedModelName,
        usage,
        success,
        errorMessage,
        durationMs: Date.now() - startTime,
        userId: actorUserId ?? null,
        sessionId: null,
        agentId: null,
      });
    } catch {
      // 记账失败不影响试生成结果
    }
  }

  private buildAudioTestFailure(error: string, startTime: number): ModelTestResult {
    return {
      connectivity: false,
      audioTest: true,
      error,
      durationMs: Date.now() - startTime,
    };
  }
}

/** 与 generate_image 的 buildImageApiConfig 同口径：去尾斜杠由客户端负责，这里只归一模型名。 */
function imageApiConfigFromModel(model: LlmModel): ImageApiConfig {
  return {
    baseUrl: (model.baseUrl ?? '').trim(),
    apiKey: (model.apiKey ?? '').trim(),
    model: normalizeImageModelName(model.modelId),
    clientImpersonation: model.clientImpersonation,
  };
}

function extractChatContent(response: LlmChatResponse | null | undefined): string | null {
  if (response == null || response.choices == null || response.choices.length === 0) {
    return null;
  }
  const message = response.choices[0].message;
  const content = contentToString(message?.content);
  if (content == null || content.trim().length === 0) {
    return null;
  }
  return content;
}

function contentToString(content: unknown): string {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (item && typeof item === 'object') {
        const part = item as { type?: string; text?: string };
        if (part.type === 'text' && part.text != null) {
          out += part.text;
        }
      }
    }
    return out;
  }
  return String(content);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseWavInfo(bytes: Buffer): { sampleRate: number; durationMs: number } | null {
  if (bytes.length < 44) {
    return null;
  }
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
    return null;
  }
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
    return null;
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 16;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    // 小端无符号读取 chunk size。若按有符号解释，非 fmt/data chunk（如 JUNK）声明 0xFFFFFFxx 时
    // 会得到负数，使 offset 原地踏步、while 永不成立退出——同步死循环挂死事件循环。
    const chunkSize =
      (((bytes[offset + 7] & 0xff) << 24)
        | ((bytes[offset + 6] & 0xff) << 16)
        | ((bytes[offset + 5] & 0xff) << 8)
        | (bytes[offset + 4] & 0xff)) >>>
      0;
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= bytes.length) {
      sampleRate =
        ((bytes[bodyStart + 7] & 0xff) << 24)
        | ((bytes[bodyStart + 6] & 0xff) << 16)
        | ((bytes[bodyStart + 5] & 0xff) << 8)
        | (bytes[bodyStart + 4] & 0xff);
      channels = ((bytes[bodyStart + 3] & 0xff) << 8) | (bytes[bodyStart + 2] & 0xff);
      bitsPerSample = ((bytes[bodyStart + 15] & 0xff) << 8) | (bytes[bodyStart + 14] & 0xff);
    } else if (chunkId === 'data') {
      // 只认实际存在的字节：流式 / 截断的 WAV 会把 data 长度写成占位值（0x7FFFFFFF 最常见），
      // 采信声明值会把时长放大到数小时。
      dataSize = Math.min(chunkSize, Math.max(0, bytes.length - bodyStart));
    }
    const nextOffset = bodyStart + chunkSize + (chunkSize & 1);
    if (nextOffset <= offset) break; // chunkSize 已无符号，理论不达；兜底防未来改动 reintroduce 死循环
    offset = nextOffset;
  }
  if (sampleRate <= 0 || dataSize <= 0) {
    return null;
  }
  const bytesPerSecond = sampleRate * Math.max(channels, 1) * (bitsPerSample / 8);
  const durationMs = bytesPerSecond > 0 ? Math.floor((dataSize * 1000) / bytesPerSecond) : 0;
  return { sampleRate, durationMs };
}
