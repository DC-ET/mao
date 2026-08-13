import type { UserWeixinPreferenceService } from '../preference/weixin-preference.service.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { WeixinMediaUploadService } from './media-upload.service.js';
import type { WeixinSendService } from './send.service.js';
import type { WeixinBotConfig } from './types.js';
import type { WeixinVoiceCodecService } from './voice-codec.service.js';
import type { WeixinVoiceSynthesisService } from './voice-synthesis.service.js';

const VOICE_FILE_NAME = '语音回复.mp3';

export class WeixinVoiceReplyService {
  constructor(
    private readonly weixinBotConfig: WeixinBotConfig,
    private readonly accountRepository: WeixinAccountRepository,
    private readonly userPreferenceService: UserWeixinPreferenceService,
    private readonly synthesisService: WeixinVoiceSynthesisService,
    private readonly codecService: WeixinVoiceCodecService,
    private readonly uploadService: WeixinMediaUploadService,
    private readonly sendService: WeixinSendService,
  ) {}

  async sendVoiceReply(accountId: string, toUserId: string, text: string | null | undefined): Promise<boolean> {
    if (!(await this.isVoiceReplyEnabled(accountId))) return false;
    if (text == null || text.trim() === '') return false;
    try {
      const wavBytes = await this.synthesisService.synthesizeWav(text);
      if (wavBytes == null) return false;
      const mp3Bytes = await this.codecService.wavToMp3(wavBytes);
      if (mp3Bytes == null) return false;
      const account = await this.accountRepository.findByAccountId(accountId);
      if (account == null) {
        console.warn(`微信语音回复：账号不存在, accountId=${accountId}`);
        return false;
      }
      const media = await this.uploadService.uploadFile(account, toUserId, mp3Bytes);
      if (media == null) return false;
      const sent = await this.sendService.sendFile(accountId, toUserId, media, VOICE_FILE_NAME);
      console.info(`微信语音回复：${sent ? '发送成功' : '发送失败'} accountId=${accountId}, toUserId=${toUserId}, fileName=${VOICE_FILE_NAME}, mp3Bytes=${mp3Bytes.length}`);
      return sent;
    } catch (e) {
      console.warn(`微信语音回复异常, accountId=${accountId}, toUserId=${toUserId}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private async isVoiceReplyEnabled(accountId: string): Promise<boolean> {
    const account = await this.accountRepository.findByAccountId(accountId);
    if (account != null && account.userId != null) {
      const userPreference = await this.userPreferenceService.getVoiceReply(account.userId);
      if (userPreference != null) return userPreference;
    }
    return this.weixinBotConfig.voiceReply;
  }
}
