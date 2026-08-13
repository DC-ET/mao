import { describe, expect, it, vi } from 'vitest';
import { WeixinVoiceSynthesisService, clipSpeechText } from './voice-synthesis.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import { WeixinVoiceTextSanitizer } from './voice-text-sanitizer.js';

describe('WeixinVoiceSynthesisService clipText', () => {
  const service = new WeixinVoiceSynthesisService(
    { findFirstActiveAudioModel: vi.fn() },
    { chat: vi.fn() } as never,
    { ...DEFAULT_WEIXIN_BOT_CONFIG, voiceMaxSeconds: 60 },
    new WeixinVoiceTextSanitizer(),
  );

  it('shortTextNotClipped', () => {
    const text = '你好，这是一段较短的文本。';
    expect(service.clipText(text)).toBe(text);
  });

  it('clippedAtSentenceBoundary', () => {
    const text = `${'甲'.repeat(150)}。${'乙'.repeat(149)}`;
    const clipped = service.clipText(text);
    expect(clipped).toHaveLength(151);
    expect(clipped.endsWith('。')).toBe(true);
  });

  it('clippedAtNewlineBoundary', () => {
    const text = `${'甲'.repeat(200)}\n${'乙'.repeat(99)}`;
    const clipped = service.clipText(text);
    expect(clipped).toHaveLength(201);
    expect(clipped.endsWith('\n')).toBe(true);
  });

  it('clippedHardWhenNoBoundary', () => {
    expect(clipSpeechText('甲'.repeat(300), 60)).toHaveLength(240);
  });
});
