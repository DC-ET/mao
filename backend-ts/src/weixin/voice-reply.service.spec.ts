import { describe, expect, it, vi } from 'vitest';
import { WeixinVoiceReplyService } from './voice-reply.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';

describe('WeixinVoiceReplyService', () => {
  it('returnsFalseWhenUserDisabledVoice', async () => {
    const service = new WeixinVoiceReplyService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, voiceReply: true },
      { findByAccountId: vi.fn(async () => ({ userId: 7, accountId: 'acc' })) } as never,
      { getVoiceReply: vi.fn(async () => false) } as never,
      { synthesizeWav: vi.fn() } as never,
      { wavToMp3: vi.fn() } as never,
      { uploadFile: vi.fn() } as never,
      { sendFile: vi.fn() } as never,
    );
    expect(await service.sendVoiceReply('acc', 'wx', 'hello')).toBe(false);
  });

  it('sendsMp3FileAfterSuccessfulPipeline', async () => {
    const uploadFile = vi.fn(async () => ({ encryptQueryParam: 'p', aesKey: 'k', encryptType: 1, size: 1, rawSize: 1, rawMd5: 'm' }));
    const sendFile = vi.fn(async () => true);
    const service = new WeixinVoiceReplyService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, voiceReply: true },
      { findByAccountId: vi.fn(async () => ({ userId: 7, accountId: 'acc' })) } as never,
      { getVoiceReply: vi.fn(async () => true) } as never,
      { synthesizeWav: vi.fn(async () => Buffer.from('RIFF')) } as never,
      { wavToMp3: vi.fn(async () => Buffer.from('mp3')) } as never,
      { uploadFile } as never,
      { sendFile } as never,
    );
    expect(await service.sendVoiceReply('acc', 'wx', 'hello')).toBe(true);
    expect(sendFile).toHaveBeenCalledWith('acc', 'wx', expect.anything(), '语音回复.mp3');
  });
});
