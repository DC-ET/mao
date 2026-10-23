import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { ClientImpersonation } from '@mao/contracts';
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
import { LLM_CALL_SCENES, LlmCallContext } from '../usage/llm-call-context.js';

const TTS_TEST_TEXT = '你好，欢迎使用 Mao 语音合成测试。';
const TTS_TEST_AUDIO = { format: 'wav' };

const CLIENT_IMPERSONATION_VALUES = ['none', 'codex', 'claude_code'] as const;

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
  ) {}

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
  ): Promise<{ records: LlmModel[]; total: number; page: number; size: number }> {
    const filter: ModelListFilter = { keyword, provider, status, supportsVision, isDefault, modelType };
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

  listActiveModels(): Promise<LlmModel[]> {
    return this.modelRepo.listActiveText();
  }

  findFirstActiveAudioModel(): Promise<LlmModel | null> {
    return this.modelRepo.findFirstActiveByType('audio');
  }

  findFirstActiveImageModel(): Promise<LlmModel | null> {
    return this.modelRepo.findFirstActiveByType('image');
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
    apiKey: string,
    modelId: string,
    supportsVision: number | null | undefined,
    isDefault: number | null | undefined,
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
  ): Promise<LlmModel> {
    if (isDefault != null && isDefault === 1) {
      await this.modelRepo.clearDefaultFlag();
    }
    const model: LlmModel = {
      name,
      provider,
      apiProtocol: normalizeApiProtocol(apiProtocol) ?? '',
      effort: normalizeEffort(effort) ?? '',
      baseUrl,
      apiKey,
      modelId,
      modelType: hasText(modelType) ? modelType!.trim() : 'text',
      clientImpersonation: normalizeClientImpersonation(clientImpersonation) ?? 'none',
      supportsVision: supportsVision != null ? supportsVision : 0,
      isDefault: isDefault != null ? isDefault : 0,
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
    isDefault: number | null | undefined,
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
  ): Promise<LlmModel> {
    const model = await this.getModel(id);
    if (name != null) model.name = name;
    if (provider != null) model.provider = provider;
    const apiProtocolValue = normalizeApiProtocol(apiProtocol);
    if (apiProtocolValue != null) model.apiProtocol = apiProtocolValue;
    const effortValue = normalizeEffort(effort);
    if (effortValue != null) model.effort = effortValue;
    if (baseUrl != null) model.baseUrl = baseUrl;
    if (apiKey != null) model.apiKey = apiKey;
    if (modelId != null) model.modelId = modelId;
    if (hasText(modelType)) model.modelType = modelType!.trim();
    const impersonation = normalizeClientImpersonation(clientImpersonation);
    if (impersonation != null) model.clientImpersonation = impersonation;
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
    if (isDefault != null) {
      if (isDefault === 1) {
        await this.modelRepo.clearDefaultFlag();
      }
      model.isDefault = isDefault;
    }
    await this.modelRepo.updateById(model);
    return model;
  }

  async deleteModel(id: number): Promise<void> {
    const model = await this.getModel(id);
    if (model.isDefault != null && model.isDefault === 1) {
      throw new BusinessException(ErrorCode.MODEL_IS_DEFAULT);
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
    if (status === 0 && model.isDefault != null && model.isDefault === 1) {
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

  async testConnectivity(id: number): Promise<ModelTestResult> {
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
    };
    const startTime = Date.now();
    if (model.modelType === 'audio') {
      return this.testAudioSynthesis(config, startTime);
    }

    try {
      const request: LlmChatRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const response = await LlmCallContext.runAsync({
        scene: LLM_CALL_SCENES.CONNECTIVITY_TEST,
        userId: null,
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

  private async testAudioSynthesis(config: LlmModelConfig, startTime: number): Promise<ModelTestResult> {
    try {
      const request: LlmChatRequest = {
        messages: [{ role: 'assistant', content: TTS_TEST_TEXT }],
        audio: TTS_TEST_AUDIO,
      };
      const response = await LlmCallContext.runAsync({
        scene: LLM_CALL_SCENES.CONNECTIVITY_TEST,
        userId: null,
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

  private buildAudioTestFailure(error: string, startTime: number): ModelTestResult {
    return {
      connectivity: false,
      audioTest: true,
      error,
      durationMs: Date.now() - startTime,
    };
  }
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
