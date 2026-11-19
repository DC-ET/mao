import { describe, expect, it, vi } from 'vitest';
import {
  completePendingAfterBind,
  dingtalkUnionIdOf,
  feishuUnionIdOf,
  channelBindLink,
  PASSWORD_BIND_LINK_TTL_MS,
} from './bind-flow.js';

/** 结构上同时兼容飞书 / 钉钉两通道 pending 行的最小夹具（事件身份字段齐全）。 */
const pending = () => ({
  state: 'st',
  event: { senderUnionId: 'on_1', senderId: 'on_1', senderUserid: 'staff_1' },
});

describe('completePendingAfterBind', () => {
  it('binds unbound union_id and replays the original message', async () => {
    const bind = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 8,
      claim: async () => pending(),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind,
      replay,
      complete,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replayed');
    expect(bind).toHaveBeenCalledWith(8, 'on_1', expect.anything());
    expect(replay).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('st');
  });

  it('replays when the bound user is the same account', async () => {
    const bind = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 8,
      claim: async () => pending(),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => 8,
      bind,
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replayed');
    expect(bind).toHaveBeenCalledWith(8, 'on_1', expect.anything());
  });

  it('releases pending when replay fails', async () => {
    const release = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 8,
      claim: async () => pending(),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind: async () => undefined,
      replay: async () => { throw new Error('boom'); },
      complete: async () => undefined,
      release,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replay-failed');
    expect(release).toHaveBeenCalledWith('st');
  });

  it('releases pending and rethrows when bind fails（钉钉身份字段不完整等）', async () => {
    const release = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const bind = vi.fn(async () => { throw new Error('钉钉身份不完整，无法绑定'); });
    await expect(completePendingAfterBind({
      state: 'st',
      bindUserId: 8,
      claim: async () => pending(),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind,
      replay,
      complete: async () => undefined,
      release,
      failClaimed: async () => undefined,
    })).rejects.toThrow('钉钉身份不完整');
    expect(release).toHaveBeenCalledWith('st');
    expect(replay).not.toHaveBeenCalled();
  });

  it('returns no-pending when the state has no inbound message', async () => {
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 8,
      claim: async () => null,
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind: async () => undefined,
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('no-pending');
  });

  it('does not steal the binding when the union_id maps to another user', async () => {
    const bind = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const failClaimed = vi.fn(async () => undefined);
    const notifyMismatch = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 9,
      claim: async () => pending(),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => 3,
      bind,
      replay,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed,
      notifyMismatch,
    });
    expect(result).toBe('identity-mismatch');
    expect(bind).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(failClaimed).toHaveBeenCalledWith('st');
    expect(notifyMismatch).toHaveBeenCalled();
  });

  it('still marks identity-mismatch if notifying the channel fails', async () => {
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 9,
      claim: async () => pending(),
      unionIdOf: feishuUnionIdOf,
      findUserIdByUnionId: async () => 3,
      bind: async () => undefined,
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
      notifyMismatch: async () => { throw new Error('send failed'); },
    });
    expect(result).toBe('identity-mismatch');
  });

  it('dingtalk unionIdOf only uses senderUnionId（绑定的是事件里的发送者身份）', async () => {
    const bind = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'st',
      bindUserId: 5,
      claim: async () => pending(),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind: (userId, unionId, pendingRow) => bind(userId, unionId, pendingRow.event.senderUserid),
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replayed');
    // unionId 取 senderUnionId，第三参取 senderUserid（钉钉 bind 的完整身份）
    expect(bind).toHaveBeenCalledWith(5, 'on_1', 'staff_1');
  });
});

describe('feishuUnionIdOf / dingtalkUnionIdOf', () => {
  it('feishu：优先 union_id，缺省回退 open_id', () => {
    expect(feishuUnionIdOf({ event: { senderUnionId: 'on_u', senderId: 'on_d' } })).toBe('on_u');
    expect(feishuUnionIdOf({ event: { senderUnionId: null, senderId: 'on_d' } })).toBe('on_d');
    expect(feishuUnionIdOf({ event: { senderUnionId: null, senderId: null } })).toBeNull();
  });

  it('dingtalk：只取 senderUnionId，不回退', () => {
    expect(dingtalkUnionIdOf({ event: { senderUnionId: 'du_x' } })).toBe('du_x');
    expect(dingtalkUnionIdOf({ event: { senderUnionId: null } })).toBeNull();
  });
});

describe('channelBindLink / PASSWORD_BIND_LINK_TTL_MS', () => {
  it('siteBaseUrl 去尾斜杠后拼 SPA 路由，state 走 encodeURIComponent', () => {
    expect(channelBindLink('https://mao.example.com/', 'feishu/bind', 'st-1')).toBe('https://mao.example.com/feishu/bind/st-1');
    expect(channelBindLink('https://mao.example.com', 'dingtalk/bind-pwd', 'a/b')).toBe('https://mao.example.com/dingtalk/bind-pwd/a%2Fb');
  });

  it('密码档 TTL 为 15 分钟', () => {
    expect(PASSWORD_BIND_LINK_TTL_MS).toBe(15 * 60_000);
  });
});
