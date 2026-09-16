import { describe, expect, it, vi } from 'vitest';
import {
  completeFeishuPendingAfterEcp,
  FEISHU_ECP_IDENTITY_MISMATCH_TEXT,
  feishuUnauthorizedGuide,
  isFeishuSenderEcpReady,
  persistFeishuPendingAuth,
  senderUnionIdOf,
  startFeishuChannelAuthLink,
  withFeishuAuthLink,
  buildFeishuAuthGuideCard,
  feishuUnauthorizedFallbackText,
} from './ecp-inbound-gate.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';

function pending(overrides: Partial<FeishuPendingBindingMessage> = {}): FeishuPendingBindingMessage {
  return {
    state: 'st',
    appId: 1,
    messageId: 'om_1',
    event: {
      eventId: 'evt',
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderId: 'ou_1',
      senderUnionId: 'on_1',
      senderType: 'user',
      messageType: 'text',
      text: 'hi',
      mentions: [],
      isBotMentioned: false,
      content: {},
      rawEvent: {},
    },
    ...overrides,
  };
}

describe('startFeishuChannelAuthLink', () => {
  it('prefers ECP even when Mao Feishu OAuth is also enabled', async () => {
    const startEcp = vi.fn(async () => ({ authUrl: 'https://ecp', state: 'e' }));
    const startFeishu = vi.fn(async () => ({ authUrl: 'https://mao', state: 'f' }));
    const link = await startFeishuChannelAuthLink({
      ecpEnabled: true,
      feishuEnabled: true,
      startEcp,
      startFeishu,
    });
    expect(link).toEqual({ authUrl: 'https://ecp', state: 'e' });
    expect(startFeishu).not.toHaveBeenCalled();
  });

  it('falls back to Mao Feishu OAuth when ECP is off', async () => {
    const link = await startFeishuChannelAuthLink({
      ecpEnabled: false,
      feishuEnabled: true,
      startEcp: async () => ({ authUrl: 'https://ecp', state: 'e' }),
      startFeishu: async () => ({ authUrl: 'https://mao', state: 'f' }),
    });
    expect(link?.state).toBe('f');
  });

  it('returns null when neither login is enabled', async () => {
    expect(await startFeishuChannelAuthLink({
      ecpEnabled: false,
      feishuEnabled: false,
      startEcp: async () => ({ authUrl: 'https://ecp', state: 'e' }),
      startFeishu: async () => ({ authUrl: 'https://mao', state: 'f' }),
    })).toBeNull();
  });
});

describe('feishuUnauthorizedGuide', () => {
  it('uses ECP copy for bound users missing a token', () => {
    const guide = feishuUnauthorizedGuide(true, true, 'p2p');
    expect(guide.title).toContain('ECP');
    expect(guide.body).toContain('没有有效的 ECP');
  });

  it('uses ECP copy for bound users in group chat', () => {
    expect(feishuUnauthorizedGuide(true, true, 'group').body).toContain('再在群内使用机器人');
  });

  it('uses ECP copy for unbound users in group chat', () => {
    const guide = feishuUnauthorizedGuide(true, false, 'group');
    expect(guide.body).toContain('ECP 飞书登录');
    expect(guide.body).toContain('群内');
  });

  it('keeps bind copy when ECP is off', () => {
    const guide = feishuUnauthorizedGuide(false, false, 'group');
    expect(guide.title).toContain('绑定');
    expect(guide.body).toContain('飞书账号绑定');
  });

  it('uses bind copy for private chat when ECP is off', () => {
    expect(feishuUnauthorizedGuide(false, false, 'p2p').body).toContain('请先完成飞书账号绑定后再试');
  });
});

describe('isFeishuSenderEcpReady', () => {
  it('skips the token check when ECP is disabled', () => {
    expect(isFeishuSenderEcpReady(false, null, () => 'x')).toBe(true);
  });

  it('requires a usable session when ECP is enabled', () => {
    expect(isFeishuSenderEcpReady(true, null, () => 'x')).toBe(false);
    expect(isFeishuSenderEcpReady(true, {
      userId: 1, sessionTokenEnc: 'enc', expiresAt: '2099-01-01 00:00:00', renewStatus: 'ACTIVE',
    }, () => 'tok')).toBe(true);
  });
});

describe('buildFeishuAuthGuideCard', () => {
  it('puts the long auth URL on an open_url button instead of markdown text', () => {
    const url = `https://ecp.example/auth?${'s='.repeat(200)}`;
    const card = buildFeishuAuthGuideCard(feishuUnauthorizedGuide(true, true, 'p2p'), url);
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const markdown = body.elements.filter((el) => el.tag === 'markdown');
    expect(JSON.stringify(markdown)).not.toContain(url);
    const columnSet = body.elements.find((el) => el.tag === 'column_set') as {
      columns: Array<{ elements: Array<Record<string, unknown>> }>;
    };
    const button = columnSet.columns[0].elements[0];
    expect(button.tag).toBe('button');
    expect(button.text).toEqual({ tag: 'plain_text', content: '完成 ECP 登录' });
    expect(button.behaviors).toEqual([{
      type: 'open_url', default_url: url, pc_url: url, ios_url: url, android_url: url,
    }]);
  });
});

describe('feishuUnauthorizedFallbackText', () => {
  it('does not embed the auth URL in the text fallback', () => {
    const text = feishuUnauthorizedFallbackText(feishuUnauthorizedGuide(true, true, 'p2p'));
    expect(text).toContain('完成 ECP 登录');
    expect(text).not.toContain('https://');
  });
});

describe('withFeishuAuthLink', () => {
  it('appends the login URL even when pending persistence later fails', () => {
    const body = '已绑定飞书账号，但没有有效的 ECP 登录凭证。请完成 ECP 飞书登录后再试（执行内部工具需要该凭证）。';
    expect(withFeishuAuthLink(body, 'https://ecp.example/auth?state=long', '登录')).toBe(
      `${body}\n点击完成登录：https://ecp.example/auth?state=long`,
    );
  });

  it('keeps the body when the URL is empty', () => {
    expect(withFeishuAuthLink('请先完成绑定', '  ', '绑定')).toBe('请先完成绑定');
  });
});

describe('persistFeishuPendingAuth', () => {
  it('does not throw when insert fails so the auth URL can still be sent', async () => {
    const ok = await persistFeishuPendingAuth(async () => {
      throw new Error("Data too long for column 'state'");
    }, 'x'.repeat(200));
    expect(ok).toBe(false);
  });
});

describe('senderUnionIdOf', () => {
  it('prefers union_id then open_id', () => {
    expect(senderUnionIdOf({ senderUnionId: 'on_1', senderId: 'ou_1' })).toBe('on_1');
    expect(senderUnionIdOf({ senderUnionId: null, senderId: 'ou_1' })).toBe('ou_1');
    expect(senderUnionIdOf({ senderUnionId: null, senderId: null })).toBeNull();
  });
});

describe('completeFeishuPendingAfterEcp', () => {
  it('binds unbound union_id and replays the original message', async () => {
    const bind = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 8,
      claim: async () => pending(),
      findUserIdByUnionId: async () => null,
      bind,
      replay,
      complete,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replayed');
    expect(bind).toHaveBeenCalledWith(8, 'on_1');
    expect(replay).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('st');
  });

  it('replays when the bound user is the ECP user', async () => {
    const bind = vi.fn(async () => undefined);
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 8,
      claim: async () => pending(),
      findUserIdByUnionId: async () => 8,
      bind,
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('replayed');
    expect(bind).toHaveBeenCalledWith(8, 'on_1');
  });

  it('releases pending when replay fails', async () => {
    const release = vi.fn(async () => undefined);
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 8,
      claim: async () => pending(),
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

  it('returns no-pending when the oauth state has no inbound message', async () => {
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 8,
      claim: async () => null,
      findUserIdByUnionId: async () => null,
      bind: async () => undefined,
      replay: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      failClaimed: async () => undefined,
    });
    expect(result).toBe('no-pending');
  });

  it('does not steal the binding when ECP email maps to another user', async () => {
    const bind = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const failClaimed = vi.fn(async () => undefined);
    const notifyMismatch = vi.fn(async () => undefined);
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 9,
      claim: async () => pending(),
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
    expect(FEISHU_ECP_IDENTITY_MISMATCH_TEXT).toContain('邮箱不一致');
  });

  it('still marks identity-mismatch if notifying Feishu fails', async () => {
    const result = await completeFeishuPendingAfterEcp({
      state: 'st',
      ecpUserId: 9,
      claim: async () => pending(),
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
});
