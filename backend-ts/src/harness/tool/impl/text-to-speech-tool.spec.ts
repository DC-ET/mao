import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { TextToSpeechTool, TTS_MAX_TEXT_CHARS } from './text-to-speech-tool.js';
import type { ChatRequest, LlmAdapter, LlmModelConfig } from '../../llm/chat-request.js';
import type { LlmModel } from '../../../model/types.js';
import { LlmCallContext } from '../../../usage/llm-call-context.js';

const WAV_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

function audioModel(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    id: 5,
    name: 'mimo-tts',
    provider: 'openai',
    apiProtocol: 'openai-compatible',
    baseUrl: 'https://audio.example/v1',
    apiKey: 'sk-tts-secret',
    modelId: 'mimo-v2.5-tts',
    authType: 'api_key',
    status: 1,
    ...overrides,
  };
}

function makeTool(options: {
  model?: LlmModel | null;
  chat?: ReturnType<typeof vi.fn>;
  uploadDir?: string;
  baseUrl?: string;
} = {}) {
  const uploadDir = options.uploadDir ?? useTmpDir('tts-');
  const chat = options.chat ?? vi.fn(async () => ({
    choices: [{ message: { audio: { data: WAV_BYTES.toString('base64'), format: 'wav' } } }],
  }));
  const adapter = { chat, stream: vi.fn() } as unknown as LlmAdapter;
  const tool = new TextToSpeechTool(
    { findFirstActiveAudioModel: async () => (options.model === undefined ? audioModel() : options.model) },
    adapter,
    uploadDir,
    async () => options.baseUrl ?? 'https://mao.example/api',
  );
  return { tool, chat, uploadDir };
}

describe('TextToSpeechTool', () => {
  it('synthesizes wav, writes under uploads/{userId}, and records voice_synthesis context', async () => {
    const { tool, chat, uploadDir } = makeTool();
    const seen: Array<{ request: ChatRequest; config: LlmModelConfig; scene?: string; userId?: number | null; sessionId?: number | null; agentId?: number | null }> = [];
    const original = chat.getMockImplementation()!;
    chat.mockImplementation(async (request: ChatRequest, config: LlmModelConfig) => {
      const ctx = LlmCallContext.get();
      seen.push({ request, config, scene: ctx?.scene, userId: ctx?.userId, sessionId: ctx?.sessionId, agentId: ctx?.agentId });
      return original(request, config);
    });

    const result = JSON.parse(await tool.execute(JSON.stringify({ text: '你好，世界' }), 11, 7, null, 3));
    expect(result.error).toBeUndefined();
    expect(result.format).toBe('wav');
    expect(result.model).toBe('mimo-v2.5-tts');
    expect(result.text_length).toBe(5);
    expect(result.size_bytes).toBe(WAV_BYTES.length);
    expect(result.audio_path).toBe(join(uploadDir, '7', result.audio_path.split('/').pop()));
    expect(existsSync(result.audio_path)).toBe(true);
    expect(result.audio_url).toBe(`https://mao.example/uploads/7/${result.audio_path.split('/').pop()}`);
    expect(readdirSync(join(uploadDir, '7')).some((file) => file.startsWith('tts-') && file.endsWith('.wav'))).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0].scene).toBe('voice_synthesis');
    expect(seen[0].userId).toBe(7);
    expect(seen[0].sessionId).toBe(11);
    expect(seen[0].agentId).toBe(3);
    expect(seen[0].request.audio).toEqual({ format: 'wav' });
    expect(seen[0].request.messages?.[0]?.content).toBe('你好，世界');
    expect(seen[0].config.modelId).toBe('mimo-v2.5-tts');
    expect(seen[0].config.apiKey).toBe('sk-tts-secret');
  });

  it('writes to the flat directory and returns the absolute path when userId/baseUrl are absent', async () => {
    const { tool, uploadDir } = makeTool({ baseUrl: '' });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, null, null));
    expect(result.error).toBeUndefined();
    expect(result.audio_path).toBe(join(uploadDir, result.audio_path.split('/').pop()));
    expect(result.audio_url).toBe(result.audio_path);
  });

  it('accepts a data-URI wrapped audio payload', async () => {
    const { tool } = makeTool({
      chat: vi.fn(async () => ({
        choices: [{ message: { audio: { data: `data:audio/wav;base64,${WAV_BYTES.toString('base64')}`, format: 'wav' } } }],
      })),
    });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(result.error).toBeUndefined();
    expect(result.size_bytes).toBe(WAV_BYTES.length);
    expect(existsSync(result.audio_path)).toBe(true);
  });

  it('normalizes the response format and keeps an allow-listed extension', async () => {
    const { tool } = makeTool({
      chat: vi.fn(async () => ({ choices: [{ message: { audio: { data: WAV_BYTES.toString('base64'), format: 'MP3' } } }] })),
    });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(result.format).toBe('mp3');
    expect(result.audio_path.endsWith('.mp3')).toBe(true);

    // 超长 / 带非法字符的 format 回退 wav，不参与路径拼接
    const unsafe = makeTool({
      chat: vi.fn(async () => ({
        choices: [{ message: { audio: { data: WAV_BYTES.toString('base64'), format: '../verylongformat' } } }],
      })),
    });
    const fallback = JSON.parse(await unsafe.tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(fallback.format).toBe('wav');
    expect(fallback.audio_path.endsWith('.wav')).toBe(true);
  });

  it('rejects empty / too-long text before calling the model', async () => {
    const { tool, chat } = makeTool();
    const blank = JSON.parse(await tool.execute(JSON.stringify({ text: '   ' }), 11, 7, null));
    expect(blank.error_code).toBe('invalid_text');
    const tooLong = JSON.parse(await tool.execute(JSON.stringify({ text: '字'.repeat(TTS_MAX_TEXT_CHARS + 1) }), 11, 7, null));
    expect(tooLong.error_code).toBe('text_too_long');
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns no_model when there is no active audio model', async () => {
    const { tool, chat } = makeTool({ model: null });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(result.error_code).toBe('no_model');
    expect(chat).not.toHaveBeenCalled();
  });

  it('rejects non OpenAI-compatible protocols and incomplete model config', async () => {
    const unsupported = makeTool({ model: audioModel({ apiProtocol: 'anthropic' }) });
    expect(JSON.parse(await unsupported.tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null)).error_code)
      .toBe('unsupported_protocol');

    const missingBase = makeTool({ model: audioModel({ baseUrl: '' }) });
    expect(JSON.parse(await missingBase.tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null)).error_code)
      .toBe('invalid_model_config');
  });

  it('returns empty_audio when the upstream response has no audio bytes', async () => {
    const { tool } = makeTool({ chat: vi.fn(async () => ({ choices: [{ message: { audio: { data: '' } } }] })) });
    expect(JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null)).error_code)
      .toBe('empty_audio');
  });

  it('returns tts_failed and masks the api key from adapter errors', async () => {
    const { tool } = makeTool({
      chat: vi.fn(async () => {
        throw new Error('GET https://user:pass@audio.example failed: Bearer abc.def key=sk-tts-secret alt=sk-other-secret-123');
      }),
    });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(result.error_code).toBe('tts_failed');
    expect(result.error).toContain('***');
    // apiKey / URL userinfo / Bearer / 其它 sk- 形态都不能回显
    expect(result.error).not.toContain('sk-tts-secret');
    expect(result.error).not.toContain('user:pass');
    expect(result.error).not.toContain('abc.def');
    expect(result.error).not.toContain('sk-other-secret-123');
  });

  it('returns write_failed when the upload directory cannot be created', async () => {
    const parent = useTmpDir('tts-file-');
    const notADir = join(parent, 'not-a-dir');
    writeFileSync(notADir, 'x');
    const { tool } = makeTool({ uploadDir: notADir });
    const result = JSON.parse(await tool.execute(JSON.stringify({ text: 'hello' }), 11, 7, null));
    expect(result.error_code).toBe('write_failed');
  });
});