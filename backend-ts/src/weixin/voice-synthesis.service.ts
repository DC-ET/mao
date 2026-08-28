import type { ClientImpersonation } from '@mao/contracts';
import type { LlmAdapter } from '../harness/llm/chat-request.js';
import type { LlmModel } from '../model/types.js';
import type { WeixinBotConfig } from './types.js';
import { WeixinVoiceTextSanitizer } from './voice-text-sanitizer.js';

const DEFAULT_MAX_CHARS = 240;

function toClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}

export interface VoiceModelLookup {
  findFirstActiveAudioModel(): Promise<LlmModel | null>;
}

export function clipSpeechText(text: string, voiceMaxSeconds: number): string {
  const maxSeconds = voiceMaxSeconds > 0 ? voiceMaxSeconds : 60;
  const maxChars = Math.max(40, Math.floor(DEFAULT_MAX_CHARS * maxSeconds / 60));
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, maxChars);
  const boundary = Math.max(
    prefix.lastIndexOf('。'),
    Math.max(prefix.lastIndexOf('！'), Math.max(prefix.lastIndexOf('？'), prefix.lastIndexOf('\n'))),
  );
  if (boundary > maxChars / 2) {
    return text.slice(0, boundary + 1);
  }
  return prefix;
}

export class WeixinVoiceSynthesisService {
  constructor(
    private readonly modelService: VoiceModelLookup,
    private readonly llmAdapter: LlmAdapter,
    private readonly weixinBotConfig: WeixinBotConfig,
    private readonly textSanitizer = new WeixinVoiceTextSanitizer(),
  ) {}

  clipText(text: string): string {
    return clipSpeechText(text, this.weixinBotConfig.voiceMaxSeconds);
  }

  async synthesizeWav(text: string | null | undefined): Promise<Buffer | null> {
    if (text == null || text.trim() === '') return null;
    const model = await this.modelService.findFirstActiveAudioModel();
    if (model == null) {
      console.warn('微信语音回复：未找到启用的语音模型（model_type=audio），跳过语音合成');
      return null;
    }
    const plain = this.textSanitizer.toSpeechText(text);
    if (plain.trim() === '') {
      console.warn('微信语音回复：剥离 Markdown 后无可朗读文本，跳过语音合成');
      return null;
    }
    const clipped = this.clipText(plain);
    try {
      const response = await this.llmAdapter.chat(
        {
          messages: [{ role: 'assistant', content: clipped }],
          audio: { format: 'wav' },
        },
        {
          id: model.id,
          name: model.name,
          provider: model.provider ?? undefined,
          apiProtocol: model.apiProtocol ?? undefined,
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          modelId: model.modelId,
          clientImpersonation: toClientImpersonation(model.clientImpersonation),
        },
      );
      const audio = response?.choices?.[0]?.message?.audio;
      if (audio == null || audio.data == null || audio.data.trim() === '') {
        console.warn(`微信语音回复：语音模型未返回音频数据, model=${model.modelId}`);
        return null;
      }
      const wavBytes = Buffer.from(audio.data, 'base64');
      if (wavBytes.length === 0) return null;
      console.info(`微信语音回复：TTS 合成成功, textLength=${clipped.length}, audioBytes=${wavBytes.length}, model=${model.modelId}`);
      return wavBytes;
    } catch (e) {
      console.warn(`微信语音回复：TTS 合成失败, model=${model.modelId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}
