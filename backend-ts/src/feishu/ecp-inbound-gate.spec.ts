import { describe, expect, it, vi } from 'vitest';
import {
  feishuUnauthorizedGuide,
  isFeishuSenderEcpReady,
  persistFeishuPendingAuth,
  senderUnionIdOf,
  startFeishuChannelAuthLink,
  withFeishuAuthLink,
  buildFeishuAuthGuideCard,
  feishuUnauthorizedFallbackText,
} from './ecp-inbound-gate.js';

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

  it('密码档：ECP / 飞书 OAuth 都关闭且密码登录开启 + 站点地址可用时兜底', async () => {
    const startPassword = vi.fn(() => ({ authUrl: 'https://mao.example.com/feishu/bind/st', state: 'st' }));
    const startEcpFail = async () => { throw new Error('ECP 不应被调用'); };
    const startFeishuFail = async () => { throw new Error('飞书 OAuth 不应被调用'); };
    const link = await startFeishuChannelAuthLink({
      ecpEnabled: false,
      feishuEnabled: false,
      passwordEnabled: true,
      getSiteBaseUrl: () => 'https://mao.example.com',
      startEcp: startEcpFail,
      startFeishu: startFeishuFail,
      startPassword,
    });
    expect(link).toEqual({ authUrl: 'https://mao.example.com/feishu/bind/st', state: 'st' });
    expect(startPassword).toHaveBeenCalledTimes(1);
  });

  it('密码档：ECP 或飞书 OAuth 任一开启时不触发', async () => {
    const startPassword = vi.fn(() => ({ authUrl: 'x', state: 'x' }));
    await startFeishuChannelAuthLink({
      ecpEnabled: true, feishuEnabled: false,
      passwordEnabled: true, getSiteBaseUrl: () => 'https://mao.example.com',
      startEcp: async () => ({ authUrl: 'ecp', state: 'e' }), startFeishu: async () => ({ authUrl: 'f', state: 'f' }), startPassword,
    });
    await startFeishuChannelAuthLink({
      ecpEnabled: false, feishuEnabled: true,
      passwordEnabled: true, getSiteBaseUrl: () => 'https://mao.example.com',
      startEcp: async () => ({ authUrl: 'e', state: 'e' }), startFeishu: async () => ({ authUrl: 'feishu', state: 'f' }), startPassword,
    });
    expect(startPassword).not.toHaveBeenCalled();
  });

  it('密码档：密码登录未开启或站点地址缺失时返回 null', async () => {
    const base = { ecpEnabled: false, feishuEnabled: false, startEcp: async () => ({ authUrl: 'e', state: 'e' }), startFeishu: async () => ({ authUrl: 'f', state: 'f' }) };
    const startPassword = () => ({ authUrl: 'x', state: 'x' });
    expect(await startFeishuChannelAuthLink({ ...base, passwordEnabled: false, getSiteBaseUrl: () => 'https://x', startPassword })).toBeNull();
    expect(await startFeishuChannelAuthLink({ ...base, passwordEnabled: true, getSiteBaseUrl: () => '', startPassword })).toBeNull();
    expect(await startFeishuChannelAuthLink({ ...base, passwordEnabled: true, getSiteBaseUrl: () => null, startPassword })).toBeNull();
    expect(await startFeishuChannelAuthLink({ ...base, passwordEnabled: true, getSiteBaseUrl: () => 'https://x' })).toBeNull();
  });
});

describe('feishuUnauthorizedGuide', () => {
  it('uses ECP bind copy when ECP is enabled', () => {
    const guide = feishuUnauthorizedGuide(true, 'p2p');
    expect(guide.body).toBe('请先点击下方按钮完成用户绑定（3分钟内有效）。');
    expect(guide.buttonLabel).toBe('点我绑定');
    expect(guide.title).toBe('新用户绑定');
  });

  it('uses the same ECP copy in group chat', () => {
    expect(feishuUnauthorizedGuide(true, 'group')).toEqual({
      title: '新用户绑定',
      body: '请先点击下方按钮完成用户绑定（3分钟内有效）。',
      buttonLabel: '点我绑定',
    });
  });

  it('keeps bind copy when ECP is off', () => {
    const guide = feishuUnauthorizedGuide(false, 'group');
    expect(guide.body).toContain('飞书账号绑定');
    expect(guide.buttonLabel).toBe('完成飞书绑定');
  });

  it('uses bind copy for private chat when ECP is off', () => {
    expect(feishuUnauthorizedGuide(false, 'p2p').body).toContain('请先完成飞书账号绑定后再试');
  });

  it('密码档 p2p：登录 + 确认绑定文案与按钮', () => {
    const guide = feishuUnauthorizedGuide(false, 'p2p', true);
    expect(guide.body).toBe('登录 Mao 账号后核对信息并确认绑定，即可继续刚才的消息（15 分钟内有效）。');
    expect(guide.buttonLabel).toBe('登录 Mao 并绑定');
    expect(guide.title).toBe('新用户绑定');
  });

  it('密码档群聊：先绑定再使用权限的文案', () => {
    expect(feishuUnauthorizedGuide(false, 'group', true).body).toBe('请先登录 Mao 账号并确认绑定，获得群内使用权限后再试（15 分钟内有效）。');
  });

  it('ECP 开启时密码档不改变 ECP 文案；passwordEnabled 缺省维持飞书 OAuth 档', () => {
    expect(feishuUnauthorizedGuide(true, 'p2p', true).body).toBe('请先点击下方按钮完成用户绑定（3分钟内有效）。');
    expect(feishuUnauthorizedGuide(false, 'p2p').body).toContain('请先完成飞书账号绑定后再试');
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
    const card = buildFeishuAuthGuideCard(feishuUnauthorizedGuide(true, 'p2p'), url);
    expect(card.header).toEqual({ template: 'orange', title: { tag: 'plain_text', content: '新用户绑定' } });
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const markdown = body.elements.filter((el) => el.tag === 'markdown');
    expect(JSON.stringify(markdown)).not.toContain(url);
    expect(JSON.stringify(markdown)).toContain('请先点击下方按钮完成用户绑定（3分钟内有效）。');
    const columnSet = body.elements.find((el) => el.tag === 'column_set') as {
      columns: Array<{ elements: Array<Record<string, unknown>> }>;
    };
    const button = columnSet.columns[0].elements[0];
    expect(button.tag).toBe('button');
    expect(button.text).toEqual({ tag: 'plain_text', content: '点我绑定' });
    expect(button.behaviors).toEqual([{
      type: 'open_url', default_url: url, pc_url: url, ios_url: url, android_url: url,
    }]);
  });
});

describe('feishuUnauthorizedFallbackText', () => {
  it('does not embed the auth URL in the text fallback', () => {
    const text = feishuUnauthorizedFallbackText(feishuUnauthorizedGuide(true, 'p2p'));
    expect(text).toContain('点我绑定');
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

describe('buildFeishuAuthGuideCard · 重新获取链接按钮', () => {
  it('未提供 sender 时不渲染换链接按钮', () => {
    const card = buildFeishuAuthGuideCard(feishuUnauthorizedGuide(true, 'p2p'), 'https://ecp.example/auth');
    expect(JSON.stringify(card)).not.toContain('重新获取链接');
  });

  it('提供 sender 时渲染回调按钮并带上发送者', () => {
    const card = buildFeishuAuthGuideCard(
      feishuUnauthorizedGuide(true, 'p2p'),
      'https://ecp.example/auth',
      { sender: 'ou_1' },
    );
    const json = JSON.stringify(card);
    expect(json).toContain('重新获取链接');
    expect(json).toContain('"kind":"feishu_ecp_auth"');
    expect(json).toContain('"sender":"ou_1"');
    expect(json).toContain('链接过期后点「重新获取链接」即可换一张新的。');
  });
});
