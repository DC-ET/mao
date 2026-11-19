import { isUsableEcpSession } from '../auth/ecp-session.repository.js';
import type { FeishuChatType, FeishuNormalizedMessage } from './types.js';

export interface FeishuChannelAuthLink {
  authUrl: string;
  state: string;
}

export interface FeishuUnauthorizedGuide {
  title: string;
  body: string;
  buttonLabel: string;
}

export const FEISHU_ECP_IDENTITY_MISMATCH_TEXT =
  'ECP 登录成功，但该飞书身份已绑定到其它 Mao 账号（邮箱不一致）。未改绑、原消息未执行。请联系管理员核对邮箱，或在桌面端用已绑定账号的同一邮箱完成 ECP 登录后再试。';

/** ECP 开启时飞书通道引导一律走 ECP 飞书登录（才会写入 sessionToken）。 */
export async function startFeishuChannelAuthLink(options: {
  ecpEnabled: boolean;
  feishuEnabled: boolean;
  /** 密码档（第三档）：仅当 ECP / 飞书 OAuth 都未开启，且账号密码登录开启、站点地址可用时兜底。 */
  passwordEnabled?: boolean;
  getSiteBaseUrl?: () => string | null;
  startEcp: () => Promise<FeishuChannelAuthLink>;
  startFeishu: () => Promise<FeishuChannelAuthLink>;
  /** 密码档无需任何 OAuth state 表：state 由调用方 randomUUID 生成并落 pending 表。 */
  startPassword?: () => FeishuChannelAuthLink;
}): Promise<FeishuChannelAuthLink | null> {
  if (options.ecpEnabled) return options.startEcp();
  if (options.feishuEnabled) return options.startFeishu();
  const siteBaseUrl = (options.getSiteBaseUrl?.() ?? '').trim();
  if (options.passwordEnabled === true && siteBaseUrl !== '' && options.startPassword != null) {
    return options.startPassword();
  }
  return null;
}

export function withFeishuAuthLink(body: string, link: string, action: '登录' | '绑定'): string {
  const url = link.trim();
  return url === '' ? body : `${body}\n点击完成${action}：${url}`;
}

export function feishuUnauthorizedFallbackText(guide: FeishuUnauthorizedGuide): string {
  return `${guide.body}\n若未看到「${guide.buttonLabel}」按钮，请打开 Mao 桌面或网页完成操作。`;
}

/** 飞书卡片 JSON 2.0：正文 + 跳转按钮，避免把超长授权 URL 写进文本被客户端截断。 */
export function buildFeishuAuthGuideCard(
  guide: FeishuUnauthorizedGuide,
  authUrl: string,
  renew?: { sender: string },
): Record<string, unknown> {
  const url = authUrl.trim();
  const columns: Array<Record<string, unknown>> = [{
    tag: 'column', width: 'auto', vertical_align: 'top',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: guide.buttonLabel },
      type: 'primary',
      size: 'sm',
      behaviors: [{
        type: 'open_url',
        default_url: url,
        pc_url: url,
        ios_url: url,
        android_url: url,
      }],
    }],
  }];
  const sender = renew?.sender?.trim() ?? '';
  if (sender !== '') {
    columns.push({
      tag: 'column', width: 'auto', vertical_align: 'top',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '重新获取链接' },
        type: 'default',
        size: 'sm',
        behaviors: [{
          type: 'callback',
          value: { kind: 'feishu_ecp_auth', act: 'renew', sender },
        }],
      }],
    });
  }
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: guide.body },
    {
      tag: 'column_set', flex_mode: 'flow', background_style: 'default',
      columns,
    },
  ];
  if (sender !== '') {
    elements.push({ tag: 'markdown', content: '链接过期后点「重新获取链接」即可换一张新的。' });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: guide.title } },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
}

/** 记录待重放消息失败时仍应把授权链接发给用户，不能把已拿到的 URL 丢掉。 */
export async function persistFeishuPendingAuth(insert: () => Promise<void>, state: string): Promise<boolean> {
  try {
    await insert();
    return true;
  } catch (error) {
    console.error(`记录飞书待登录/绑定消息失败, state=${state}`, error);
    return false;
  }
}

export function feishuUnauthorizedGuide(ecpEnabled: boolean, chatType: FeishuChatType, passwordEnabled = false): FeishuUnauthorizedGuide {
  if (ecpEnabled) {
    return {
      title: '新用户绑定',
      body: '请先点击下方按钮完成用户绑定（3分钟内有效）。',
      buttonLabel: '点我绑定',
    };
  }
  if (passwordEnabled) {
    return {
      title: '新用户绑定',
      body: chatType === 'group'
        ? '请先登录 Mao 账号并确认绑定，获得群内使用权限后再试（15 分钟内有效）。'
        : '登录 Mao 账号后核对信息并确认绑定，即可继续刚才的消息（15 分钟内有效）。',
      buttonLabel: '登录 Mao 并绑定',
    };
  }
  return {
    title: '新用户绑定',
    body: chatType === 'group'
      ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
      : '请先完成飞书账号绑定后再试。',
    buttonLabel: '完成飞书绑定',
  };
}

export function isFeishuSenderEcpReady(
  ecpEnabled: boolean,
  session: Parameters<typeof isUsableEcpSession>[0],
  decryptToken: (enc: string) => string | null,
  now = Date.now(),
): boolean {
  if (!ecpEnabled) return true;
  return isUsableEcpSession(session, decryptToken, now);
}

export function senderUnionIdOf(event: Pick<FeishuNormalizedMessage, 'senderUnionId' | 'senderId'>): string | null {
  return event.senderUnionId ?? event.senderId ?? null;
}
