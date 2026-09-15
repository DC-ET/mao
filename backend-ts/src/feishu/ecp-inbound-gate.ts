import { isUsableEcpSession } from '../auth/ecp-session.repository.js';
import type { FeishuChatType, FeishuNormalizedMessage } from './types.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';

export interface FeishuChannelAuthLink {
  authUrl: string;
  state: string;
}

export interface FeishuUnauthorizedGuide {
  title: string;
  body: string;
}

export const FEISHU_ECP_IDENTITY_MISMATCH_TEXT =
  'ECP 登录成功，但该飞书身份已绑定到其它 Mao 账号（邮箱不一致）。未改绑、原消息未执行。请联系管理员核对邮箱，或在桌面端用已绑定账号的同一邮箱完成 ECP 登录后再试。';

/** ECP 开启时飞书通道引导一律走 ECP 飞书登录（才会写入 sessionToken）。 */
export async function startFeishuChannelAuthLink(options: {
  ecpEnabled: boolean;
  feishuEnabled: boolean;
  startEcp: () => Promise<FeishuChannelAuthLink>;
  startFeishu: () => Promise<FeishuChannelAuthLink>;
}): Promise<FeishuChannelAuthLink | null> {
  if (options.ecpEnabled) return options.startEcp();
  if (options.feishuEnabled) return options.startFeishu();
  return null;
}

export function feishuUnauthorizedGuide(ecpEnabled: boolean, bound: boolean, chatType: FeishuChatType): FeishuUnauthorizedGuide {
  if (ecpEnabled) {
    if (bound) {
      return {
        title: '需要完成 ECP 飞书登录',
        body: chatType === 'group'
          ? '已绑定飞书账号，但没有有效的 ECP 登录凭证。请完成 ECP 飞书登录后，再在群内使用机器人（执行内部工具需要该凭证）。'
          : '已绑定飞书账号，但没有有效的 ECP 登录凭证。请完成 ECP 飞书登录后再试（执行内部工具需要该凭证）。',
      };
    }
    return {
      title: '需要完成 ECP 飞书登录',
      body: chatType === 'group'
        ? '请先完成 ECP 飞书登录，获得群内使用权限后再试。'
        : '请先完成 ECP 飞书登录后再试。',
    };
  }
  return {
    title: '需要完成飞书绑定',
    body: chatType === 'group'
      ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
      : '请先完成飞书账号绑定后再试。',
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

export type FeishuEcpPendingResult = 'no-pending' | 'replayed' | 'identity-mismatch' | 'replay-failed';

export async function completeFeishuPendingAfterEcp(params: {
  state: string;
  ecpUserId: number;
  claim: (state: string) => Promise<FeishuPendingBindingMessage | null>;
  findUserIdByUnionId: (unionId: string) => Promise<number | null>;
  bind: (userId: number, unionId: string) => Promise<void>;
  replay: (pending: FeishuPendingBindingMessage) => Promise<void>;
  complete: (state: string) => Promise<void>;
  release: (state: string) => Promise<void>;
  failClaimed: (state: string) => Promise<void>;
  notifyMismatch?: (pending: FeishuPendingBindingMessage) => Promise<void>;
}): Promise<FeishuEcpPendingResult> {
  const pending = await params.claim(params.state);
  if (pending == null) return 'no-pending';
  const unionId = pending.event.senderUnionId ?? pending.event.senderId;
  if (unionId != null) {
    const existing = await params.findUserIdByUnionId(unionId);
    if (existing != null && existing !== params.ecpUserId) {
      await params.failClaimed(params.state);
      try {
        await params.notifyMismatch?.(pending);
      } catch (error) {
        console.error(`飞书 ECP 身份不一致通知失败, state=${params.state}`, error);
      }
      return 'identity-mismatch';
    }
    await params.bind(params.ecpUserId, unionId);
  }
  try {
    await params.replay(pending);
    await params.complete(params.state);
    return 'replayed';
  } catch (error) {
    await params.release(params.state);
    console.error(`恢复飞书待绑定消息失败, state=${params.state}`, error);
    return 'replay-failed';
  }
}

export function senderUnionIdOf(event: Pick<FeishuNormalizedMessage, 'senderUnionId' | 'senderId'>): string | null {
  return event.senderUnionId ?? event.senderId ?? null;
}
