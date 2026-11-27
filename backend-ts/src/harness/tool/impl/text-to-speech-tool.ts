import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientImpersonation } from '@mao/contracts';
import { BaseTool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { LlmAdapter } from '../../llm/chat-request.js';
import { normalizeModelAuthType, type LlmModel } from '../../../model/types.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../../../usage/llm-call-context.js';
import { toStaticUploadBase } from './generate-image-tool.js';

/** 单次 TTS 文本上限（产品保护值，不是上游硬限制）。 */
export const TTS_MAX_TEXT_CHARS = 2000;
/** 微信 / 钉钉通道单文件上限（20MB）：超出时提前提示，避免「已生成但发不出去」。 */
export const TTS_CHANNEL_WARN_BYTES = 20 * 1024 * 1024;

export interface AudioModelLookup {
  findFirstActiveAudioModel(): Promise<LlmModel | null>;
}

function toClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}

function normalizeAudioFormat(format: string | null | undefined): string {
  const raw = (format ?? '').trim().toLowerCase().replace(/^audio\//, '');
  // 扩展名只接受短字母数字：既防路径穿越，也避免上游返回超长垃圾串。
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : 'wav';
}

/** 兼容部分网关把 audio.data 包成 data URI 的形态；纯 base64 原样返回。 */
function stripDataUri(data: string): string {
  const text = data.trim();
  if (!text.toLowerCase().startsWith('data:')) return text;
  const comma = text.indexOf(',');
  return comma >= 0 ? text.slice(comma + 1) : text;
}

function errorJson(message: string, errorCode: string): string {
  return toJson({ error: message, error_code: errorCode });
}

function maskSecret(message: string, secret: string | null | undefined): string {
  let masked = message;
  if (secret != null && secret !== '') masked = masked.split(secret).join('***');
  // 适配器/网关错误可能回显其它凭证形态：URL userinfo、Bearer token、sk- key。
  return masked
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

/**
 * 语音合成（技术方案 2026-11-27 §5.4）：文本进、音频文件出。
 * 复用后台 model_type=audio 模型与 LlmAdapter（RecordingLlmAdapter 自动记 llm_call）；
 * 不自动投递，需要交付时由模型把 audio_path 作为 send_file 的 file 参数。
 */
export class TextToSpeechTool extends BaseTool {
  constructor(
    private readonly modelLookup: AudioModelLookup,
    private readonly llmAdapter: LlmAdapter,
    private readonly uploadDir: string,
    private readonly getBaseUrl: () => Promise<string> = async () => '',
    private readonly contextPath: string = '/api',
  ) { super(); }

  getName(): string { return 'text_to_speech'; }

  getDescription(): string {
    return '将文字合成为语音（TTS）。基于后台配置的语音模型（model_type=audio）生成音频（默认 WAV），'
      + '返回访问 URL 与本地保存路径。适合朗读、配音、语音回复；text 请使用适合朗读的纯文本，'
      + `单次最多 ${TTS_MAX_TEXT_CHARS} 字，超长请分段调用。`
      + '需要把音频直接发给用户时，将 audio_path 的值作为 send_file 的 file 参数传入。'
      + '仅当 Agent 启用了「语音合成」特色工具且后台存在可用语音模型时才会出现。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `要朗读的文本，最多 ${TTS_MAX_TEXT_CHARS} 字`,
          maxLength: TTS_MAX_TEXT_CHARS,
        },
      },
      required: ['text'],
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        audio_url: { type: 'string' },
        audio_path: { type: 'string' },
        format: { type: 'string' },
        size_bytes: { type: 'integer' },
        model: { type: 'string' },
        text_length: { type: 'integer' },
        warning: { type: 'string' },
      },
    };
  }

  protected async executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    _workspace: string | null,
    agentId: number | null = null,
  ): Promise<string> {
    let model: LlmModel | null = null;
    try {
      const args = parseObject(argumentsJson) ?? {};
      const text = (asText(args.text) ?? '').trim();
      if (text === '') return errorJson('text 不能为空', 'invalid_text');
      const textLength = [...text].length;
      if (textLength > TTS_MAX_TEXT_CHARS) {
        return errorJson(`text 过长（最多 ${TTS_MAX_TEXT_CHARS} 字），请分段调用`, 'text_too_long');
      }

      model = await this.modelLookup.findFirstActiveAudioModel();
      if (model == null) {
        return errorJson('没有可用的语音模型，请先在管理后台配置 model_type=audio 且协议为 OpenAI 兼容的模型', 'no_model');
      }
      const apiProtocol = (model.apiProtocol ?? '').trim();
      if (apiProtocol !== '' && apiProtocol !== 'openai-compatible') {
        return errorJson(`语音模型协议需为 OpenAI 兼容（当前 ${apiProtocol}），否则 audio 字段不会发送`, 'unsupported_protocol');
      }
      const baseUrl = (model.baseUrl ?? '').trim();
      const modelId = (model.modelId ?? '').trim();
      if (baseUrl === '' || modelId === '') {
        return errorJson('语音模型未配置 base_url / model_id', 'invalid_model_config');
      }

      const response = await LlmCallContext.runAsync({
        scene: LLM_CALL_SCENES.VOICE_SYNTHESIS,
        userId,
        sessionId,
        agentId,
      }, async () => this.llmAdapter.chat(
        {
          messages: [{ role: 'assistant', content: text }],
          audio: { format: 'wav' },
        },
        {
          id: model!.id,
          name: model!.name,
          provider: model!.provider ?? undefined,
          apiProtocol: model!.apiProtocol ?? undefined,
          baseUrl,
          apiKey: model!.apiKey,
          modelId,
          clientImpersonation: toClientImpersonation(model!.clientImpersonation),
          authType: normalizeModelAuthType(model!.authType),
        },
      ));

      const audio = response?.choices?.[0]?.message?.audio;
      if (audio?.data == null || audio.data.trim() === '') {
        return errorJson('语音模型未返回音频数据', 'empty_audio');
      }
      const bytes = Buffer.from(stripDataUri(audio.data), 'base64');
      if (bytes.length === 0) {
        return errorJson('语音模型未返回音频数据', 'empty_audio');
      }

      const format = normalizeAudioFormat(audio.format);
      const dir = userId != null ? path.join(this.uploadDir, String(userId)) : this.uploadDir;
      const fileName = `tts-${randomUUID()}.${format}`;
      let filePath = '';
      try {
        mkdirSync(dir, { recursive: true });
        filePath = path.join(dir, fileName);
        writeFileSync(filePath, bytes);
      } catch (e) {
        return errorJson(`音频落盘失败: ${(e as Error).message}`, 'write_failed');
      }

      let origin = '';
      try {
        origin = toStaticUploadBase(await this.getBaseUrl(), this.contextPath);
      } catch {
        origin = '';
      }
      const uidSegment = userId != null ? `${String(userId)}/` : '';
      const audioUrl = origin ? `${origin}/uploads/${uidSegment}${fileName}` : filePath;
      return toJson({
        audio_url: audioUrl,
        audio_path: filePath,
        format,
        size_bytes: bytes.length,
        model: modelId,
        text_length: textLength,
        // 通道上限提示：不阻断生成，但避免模型把超限音频直接交给 send_file 后静默失败。
        ...(bytes.length > TTS_CHANNEL_WARN_BYTES
          ? { warning: `音频超过 ${Math.floor(TTS_CHANNEL_WARN_BYTES / (1024 * 1024))}MB，微信/钉钉通道可能发送失败，建议缩短文本` }
          : {}),
      });
    } catch (e) {
      const message = maskSecret(e instanceof Error ? e.message : String(e), model?.apiKey);
      harnessLog('error', `TextToSpeechTool failed: ${message}`);
      return errorJson(message, 'tts_failed');
    }
  }
}