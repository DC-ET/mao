import { describe, expect, it, vi } from 'vitest';
import { UserWeixinPreferenceService } from './weixin-preference.service.js';
import type { UserWeixinPreference, UserWeixinPreferenceRepository } from './types.js';

describe('UserWeixinPreferenceService', () => {
  const repo: UserWeixinPreferenceRepository = {
    findByUserId: vi.fn(),
    insert: vi.fn(),
    updateByUserId: vi.fn(),
  };
  const service = new UserWeixinPreferenceService(repo);

  it('getVoiceReplyReturnsNullWhenUnset', async () => {
    vi.mocked(repo.findByUserId).mockResolvedValue(null);
    expect(await service.getVoiceReply(1)).toBeNull();
  });

  it('saveInsertsOrUpdates', async () => {
    vi.mocked(repo.findByUserId).mockResolvedValue(null);
    const created = await service.save(7, true);
    expect(created.voiceReply).toBe(1);
    expect(repo.insert).toHaveBeenCalled();

    const existing: UserWeixinPreference = { userId: 7, voiceReply: 1 };
    vi.mocked(repo.findByUserId).mockResolvedValue(existing);
    const updated = await service.save(7, false);
    expect(updated.voiceReply).toBe(0);
    expect(repo.updateByUserId).toHaveBeenCalledWith(existing);
  });
});
