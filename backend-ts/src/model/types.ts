import type { ClientImpersonation, ModelAuthType, ModelVO, ModelPageResult, ModelListFilter } from '@mao/contracts';
import type { ChatUsage } from '../harness/llm/chat-request.js';
export type { ClientImpersonation, ModelAuthType, ModelVO, ModelPageResult, ModelListFilter };

export interface LlmModel {
  id?: number;
  name: string;
  provider?: string | null;
  apiProtocol?: string | null;
  /** reasoning effort：none/low/medium/high/xhigh/max，空串=协议默认值（high） */
  effort?: string | null;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelType?: string | null;
  clientImpersonation?: string | null;
  /** 凭证方式：api_key=固定 Key（缺省/未知按此处理）；ecp=调用时使用当前用户的 ECP Token。 */
  authType?: string | null;
  contextWindowTokens?: number | null;
  /**
   * 供应商允许的请求体上限（字节）。用于推导会话压缩的体积触发阈值（上限 × 0.8）；
   * null 表示未声明，回退全局阈值。
   */
  maxRequestBodyBytes?: number | null;
  /** 每百万「非缓存」输入 token 价格（成本单位）。DECIMAL 列经 mysql2 读出为 string，计价前经 parsePriceColumn 归一。 */
  priceInput?: string | number | null;
  /** 每百万缓存命中输入 token 价格（成本单位）。语义同 priceInput。 */
  priceCacheRead?: string | number | null;
  /** 每百万缓存写入输入 token 价格（成本单位）。语义同 priceInput。 */
  priceCacheWrite?: string | number | null;
  /** 每百万输出 token 价格（成本单位）。语义同 priceInput。 */
  priceOutput?: string | number | null;
  status?: number | null;
  supportsVision?: number | null;
  isDefault?: number | null;
  /**
   * 客户端可选：1=客户端模型选择器可选 0=仅管理端可配置。
   * 只影响列表过滤，运行时不看这一列（Agent 默认模型/机器人/已绑定会话照旧可用）。
   */
  clientVisible?: number | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ModelTestResult {
  connectivity: boolean;
  connectivityOutput?: string | null;
  error?: string | null;
  durationMs: number;
  audioTest?: boolean;
  /** 文生图试生成：真实调用 /images/generations，成功只带回耗时，不回图片字节。 */
  imageTest?: boolean;
  audioFormat?: string | null;
  audioData?: string | null;
  audioSizeBytes?: number | null;
  audioSampleRate?: number | null;
  audioDurationMs?: number | null;
  audioVoice?: string | null;
}

export interface LlmModelRepository {
  selectPage(
    page: number,
    size: number,
    filter: ModelListFilter,
  ): Promise<{ records: LlmModel[]; total: number }>;
  listProviders(): Promise<string[]>;
  /** clientVisibleOnly=true 时只返回客户端可选（client_visible = 1）的启用 text 模型。 */
  listActiveText(clientVisibleOnly?: boolean): Promise<LlmModel[]>;
  findFirstActiveByType(modelType: string): Promise<LlmModel | null>;
  /**
   * 首个启用的 OpenAI 兼容语音模型（技术方案 2026-11-27 §5.3.1）。
   * 跳过 api_protocol=anthropic / openai-responses：这两类适配器不序列化 audio 字段，
   * 调用会「成功但没有音频」，必须 fail-closed。
   */
  findFirstActiveAudioModel(): Promise<LlmModel | null>;
  /**
   * 按类型的默认模型（2026-11-27 特色工具模型绑定）：is_default=1 且启用、未软删；
   * audio 额外要求 OpenAI 兼容协议（与 findFirstActiveAudioModel 同口径，防脏数据默认「成功但无音频」）。
   */
  findDefaultByType(modelType: string): Promise<LlmModel | null>;
  /**
   * 启用、未软删的同类型模型，id ASC（Agent 表单候选）；
   * audio 同样只含 OpenAI 兼容协议——协议不兼容的语音模型不允许被绑定。
   */
  listActiveByType(modelType: string): Promise<LlmModel[]>;
  findDefault(): Promise<LlmModel | null>;
  findById(id: number): Promise<LlmModel | null>;
  insert(model: LlmModel): Promise<number>;
  updateById(model: LlmModel): Promise<void>;
  deleteById(id: number): Promise<void>;
  /** 只清同一 model_type 的默认标记（is_default 语义 = 按类型各一个默认）。 */
  clearDefaultFlag(modelType: string): Promise<void>;
  /** 除 id 外启用中的 text 模型数（与 findDefault 的 model_type = 'text' 口径一致）。 */
  countActiveTextExcept(id: number): Promise<number>;
  /** 启用且可用的 text 模型数（api_key 非空或 auth_type='ecp'；readiness 就绪判定，口径同 findDefault）。 */
  countEnabledWithApiKey(): Promise<number>;
}

export interface SessionModelRepository {
  reassignModelId(fromId: number, toId: number | null): Promise<void>;
}

export interface LlmChatMessage {
  role: string;
  content?: unknown;
  audio?: {
    data?: string | null;
    format?: string | null;
    transcript?: string | null;
    duration?: number | null;
  } | null;
}

export interface LlmChatRequest {
  messages: LlmChatMessage[];
  stream?: boolean;
  audio?: Record<string, unknown>;
  temperature?: number;
}

export interface LlmChatResponse {
  choices?: Array<{
    message?: LlmChatMessage | null;
    finish_reason?: string;
  }>;
  /** 上游 token 用量（各协议已归一为统一口径）。非流式链路（连通性测试、飞书摘要等）记账必需。 */
  usage?: ChatUsage;
}

export interface LlmModelConfig {
  id?: number;
  name?: string;
  provider?: string | null;
  apiProtocol?: string | null;
  effort?: string | null;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  clientImpersonation?: ClientImpersonation;
  /** 凭证方式：api_key=固定 Key（缺省/未知按此处理）；ecp=调用时使用当前用户的 ECP Token。 */
  authType?: ModelAuthType;
  supportsVision?: boolean;
  /** 每百万 token 价格（成本单位）；缺失时 LlmCallService 走兜底价格缓存（技术方案 §5.3）。 */
  priceInput?: number | null;
  priceOutput?: number | null;
}

export interface LlmChatClient {
  chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse>;
}

/** 凭证方式读侧归一：未知/缺失一律按 'api_key'（存量行为，兼容旧行与旧前端）。 */
export function normalizeModelAuthType(value: string | null | undefined): ModelAuthType {
  return value === 'ecp' ? 'ecp' : 'api_key';
}
