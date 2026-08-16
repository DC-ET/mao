import type { UserWeixinPreference, UserWeixinPreferenceRepository } from './types.js';

export class UserWeixinPreferenceService {
  constructor(private readonly preferenceRepo: UserWeixinPreferenceRepository) {}

  get(userId: number): Promise<UserWeixinPreference | null> {
    return this.preferenceRepo.findByUserId(userId);
  }

  async getVoiceReply(userId: number): Promise<boolean | null> {
    const row = await this.preferenceRepo.findByUserId(userId);
    return row != null && row.voiceReply != null ? row.voiceReply === 1 : null;
  }

  async save(userId: number, voiceReply: boolean): Promise<UserWeixinPreference> {
    const row = await this.preferenceRepo.findByUserId(userId);
    if (row == null) {
      const created: UserWeixinPreference = { userId, voiceReply: voiceReply ? 1 : 0 };
      await this.preferenceRepo.insert(created);
      return created;
    }
    row.voiceReply = voiceReply ? 1 : 0;
    await this.preferenceRepo.updateByUserId(row);
    return row;
  }
}
