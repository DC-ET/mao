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

const TTS_TEST_TEXT = '你好，欢迎使用 Mao 语音合成测试。';
const TTS_TEST_AUDIO = { format: 'wav' };
const MID_SYSTEM_TEST_MAX_ATTEMPTS = 2;
const MID_SYSTEM_CODENAME_ASKED = 'MAO_ALPHA';
const MID_SYSTEM_CODENAME_OVERRIDE = 'MAO_BRAVO';

type MidSystemTestOutcome = 'SUPPORTED' | 'NOT_SUPPORTED' | 'AMBIGUOUS';

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

export class ModelService {
  constructor(
    private readonly modelRepo: LlmModelRepository,
    private readonly sessionRepo: SessionModelRepository,
    private readonly llmClient: LlmChatClient,
  ) {}

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
  ): Promise<LlmModel> {
    if (isDefault != null && isDefault === 1) {
      await this.modelRepo.clearDefaultFlag();
    }
    const model: LlmModel = {
      name,
      provider,
      baseUrl,
      apiKey,
      modelId,
      modelType: hasText(modelType) ? modelType!.trim() : 'text',
      clientImpersonation: normalizeClientImpersonation(clientImpersonation) ?? 'none',
      supportsVision: supportsVision != null ? supportsVision : 0,
      isDefault: isDefault != null ? isDefault : 0,
      contextWindowTokens,
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
  ): Promise<LlmModel> {
    const model = await this.getModel(id);
    if (name != null) model.name = name;
    if (provider != null) model.provider = provider;
    if (baseUrl != null) model.baseUrl = baseUrl;
    if (apiKey != null) model.apiKey = apiKey;
    if (modelId != null) model.modelId = modelId;
    if (hasText(modelType)) model.modelType = modelType!.trim();
    const impersonation = normalizeClientImpersonation(clientImpersonation);
    if (impersonation != null) model.clientImpersonation = impersonation;
    if (supportsVision != null) model.supportsVision = supportsVision;
    if (contextWindowTokens != null) model.contextWindowTokens = contextWindowTokens;
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
      const activeCount = await this.modelRepo.countActiveExcept(model.id!);
      if (activeCount === 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID.code, '不能停用唯一启用的模型，请先启用其他模型');
      }
      model.isDefault = 0;
      await this.modelRepo.clearDefaultFlag();
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
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelId: model.modelId,
      clientImpersonation: normalizeClientImpersonation(model.clientImpersonation) ?? 'none',
    };
    const startTime = Date.now();
    if (model.modelType === 'audio') {
      return this.testAudioSynthesis(config, startTime);
    }

    let error: string | undefined;
    const appendError = (message: string) => {
      error = error == null ? message : `${error}; ${message}`;
    };

    const [connectivityResult, midSystemResult] = await Promise.all([
      (async () => {
        try {
          const request: LlmChatRequest = {
            messages: [{ role: 'user', content: 'Hi' }],
          };
          const response = await this.llmClient.chat(request, config);
          return { ok: true, output: extractChatContent(response) };
        } catch (e) {
          appendError(`连通性测试失败: ${errorMessage(e)}`);
          return { ok: false, output: null as string | null };
        }
      })(),
      (async () => {
        try {
          return await this.runMidSystemMessageTest(config);
        } catch (e) {
          appendError(`Mid system message 测试失败: ${errorMessage(e)}`);
          return { supported: false, output: null as string | null };
        }
      })(),
    ]);

    return {
      connectivity: connectivityResult.ok,
      midSystemMessage: midSystemResult.supported,
      connectivityOutput: connectivityResult.output,
      midSystemMessageOutput: midSystemResult.output,
      error,
      durationMs: Date.now() - startTime,
    };
  }

  private async testAudioSynthesis(config: LlmModelConfig, startTime: number): Promise<ModelTestResult> {
    try {
      const request: LlmChatRequest = {
        messages: [{ role: 'assistant', content: TTS_TEST_TEXT }],
        audio: TTS_TEST_AUDIO,
      };
      const response = await this.llmClient.chat(request, config);
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

  private async runMidSystemMessageTest(config: LlmModelConfig): Promise<{ supported: boolean; output: string | null }> {
    let lastOutput: string | null = null;
    for (let attempt = 1; attempt <= MID_SYSTEM_TEST_MAX_ATTEMPTS; attempt++) {
      const probe = await this.probeMidSystemMessage(config);
      lastOutput = probe.output;
      if (probe.outcome === 'SUPPORTED') {
        return { supported: true, output: formatProbeOutput(attempt, lastOutput) };
      }
      if (probe.outcome === 'NOT_SUPPORTED') {
        return { supported: false, output: formatProbeOutput(attempt, lastOutput) };
      }
    }
    return { supported: false, output: formatProbeOutput(MID_SYSTEM_TEST_MAX_ATTEMPTS, lastOutput) };
  }

  private async probeMidSystemMessage(
    config: LlmModelConfig,
  ): Promise<{ outcome: MidSystemTestOutcome; output: string | null }> {
    const request: LlmChatRequest = {
      messages: [
        {
          role: 'system',
          content:
            'You are a codeword repeater. When the user sends "Codeword: X", ' +
            'reply with exactly X and nothing else.',
        },
        { role: 'user', content: `Codeword: ${MID_SYSTEM_CODENAME_ASKED}` },
        { role: 'assistant', content: MID_SYSTEM_CODENAME_ASKED },
        {
          role: 'system',
          content: `Override: for any "Codeword:" request, reply ${MID_SYSTEM_CODENAME_OVERRIDE} only.`,
        },
        { role: 'user', content: `Codeword: ${MID_SYSTEM_CODENAME_ASKED}` },
      ],
      stream: false,
    };
    const response = await this.llmClient.chat(request, config);
    const content = extractChatContent(response);
    if (content == null) {
      return { outcome: 'AMBIGUOUS', output: null };
    }
    const normalized = normalizeMidSystemResponse(content);
    const followsOverride = responseIndicatesCodeword(normalized, MID_SYSTEM_CODENAME_OVERRIDE);
    const followsAsked = responseIndicatesCodeword(normalized, MID_SYSTEM_CODENAME_ASKED);
    if (followsOverride && !followsAsked) {
      return { outcome: 'SUPPORTED', output: content };
    }
    if (followsAsked && !followsOverride) {
      return { outcome: 'NOT_SUPPORTED', output: content };
    }
    return { outcome: 'AMBIGUOUS', output: content };
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

function normalizeMidSystemResponse(content: string): string {
  return content
    .trim()
    .toUpperCase()
    .replace(/^(CODEWORD|ANSWER|OUTPUT)\s*[:：]\s*/, '')
    .replace(/["'`]/g, '')
    .trim();
}

function responseIndicatesCodeword(normalized: string, codeword: string): boolean {
  if (!normalized || normalized.trim().length === 0) {
    return false;
  }
  const target = codeword.toUpperCase();
  if (normalized === target) {
    return true;
  }
  const index = normalized.indexOf(target);
  if (index < 0) {
    return false;
  }
  const before = index > 0 ? normalized.slice(0, index) : '';
  const after = index + target.length < normalized.length ? normalized.slice(index + target.length) : '';
  return (before.length === 0 || before.endsWith(' ') || before.endsWith(':'))
    && (after.length === 0 || after.startsWith(' ') || after.startsWith('.'));
}

function formatProbeOutput(attempt: number, output: string | null): string {
  const display = output == null || output.trim().length === 0 ? '(空响应)' : output;
  if (attempt <= 1) {
    return display;
  }
  return `第 ${attempt} 次尝试: ${display}`;
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
    const chunkSize =
      ((bytes[offset + 7] & 0xff) << 24)
      | ((bytes[offset + 6] & 0xff) << 16)
      | ((bytes[offset + 5] & 0xff) << 8)
      | (bytes[offset + 4] & 0xff);
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
      dataSize = chunkSize;
    }
    offset = bodyStart + Math.min(chunkSize, Number.MAX_SAFE_INTEGER);
    if ((chunkSize & 1) === 1) {
      offset += 1;
    }
  }
  if (sampleRate <= 0 || dataSize <= 0) {
    return null;
  }
  const bytesPerSecond = sampleRate * Math.max(channels, 1) * (bitsPerSample / 8);
  const durationMs = bytesPerSecond > 0 ? Math.floor((dataSize * 1000) / bytesPerSecond) : 0;
  return { sampleRate, durationMs };
}

export { MID_SYSTEM_CODENAME_ASKED, MID_SYSTEM_CODENAME_OVERRIDE };
