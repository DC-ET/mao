import type { FeishuNormalizedMessage } from '../feishu/types.js';

/**
 * 通道无关的「登录后完成绑定 + 补投」编排（技术方案 2026-11-19-channel-password-bind §4.1）。
 * 由 completeFeishuPendingAfterEcp 泛化而来：ECP 回调（create-app.ts）、飞书密码 complete、
 * 钉钉密码 complete 三处共用。绑定/补投/身份冲突检查只关心「userId ↔ 发送者 unionId ↔
 * 待补投消息」三元组，与用户如何证明身份无关；各通道经回调注入自己的仓储与身份提取。
 */

/** 飞书 / 钉钉 pending 行的最小结构形状（两通道行类型均结构化兼容）。 */
export interface ChannelPendingRow {
  state: string;
  event: {
    senderUnionId?: string | null;
    senderId?: string | null;
    senderUserid?: string | null;
  };
}

export type ChannelBindOutcome = 'no-pending' | 'replayed' | 'identity-mismatch' | 'replay-failed';

/** 密码绑定链接有效期：比 OAuth 的 3 分钟宽（用户要打字）。文案与 TTL 判断共用本常量。 */
export const PASSWORD_BIND_LINK_TTL_MS = 15 * 60_000;

/** 绑定完成接口的统一结果形状（桌面确认页按三档渲染，口径对齐 ECP 通道回调页）。 */
export interface ChannelBindResultVO {
  status: 'success' | 'partial' | 'failed';
  message: string;
  senderName: string | null;
}

export function bindOutcomeToResult(
  outcome: ChannelBindOutcome,
  options: { channelLabel: string; senderName: string | null },
): ChannelBindResultVO {
  const { channelLabel, senderName } = options;
  switch (outcome) {
    case 'replayed':
      return { status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName };
    case 'replay-failed':
      return { status: 'partial', message: '绑定已生效，原消息未恢复，请回 IM 重新发送一条消息', senderName };
    case 'identity-mismatch':
      return { status: 'failed', message: `该${channelLabel}身份已绑定其它 Mao 账号，未改绑`, senderName };
    case 'no-pending':
      return { status: 'failed', message: '链接已失效或已使用，请回 IM 重新发送一条消息', senderName };
  }
}

export async function completePendingAfterBind<TPending extends ChannelPendingRow>(params: {
  state: string;
  bindUserId: number;
  claim: (state: string) => Promise<TPending | null>;
  /** 发送者 unionId 提取：飞书 senderUnionId ?? senderId；钉钉 senderUnionId。 */
  unionIdOf: (pending: TPending) => string | null;
  findUserIdByUnionId: (unionId: string) => Promise<number | null>;
  /** 改绑语义由各通道 bind 实现决定；钉钉第三参需要 pending.event.senderUserid。 */
  bind: (userId: number, unionId: string, pending: TPending) => Promise<void>;
  replay: (pending: TPending) => Promise<void>;
  complete: (state: string) => Promise<void>;
  release: (state: string) => Promise<void>;
  failClaimed: (state: string) => Promise<void>;
  notifyMismatch?: (pending: TPending) => Promise<void>;
}): Promise<ChannelBindOutcome> {
  const pending = await params.claim(params.state);
  if (pending == null) return 'no-pending';
  const unionId = params.unionIdOf(pending);
  if (unionId != null) {
    const existing = await params.findUserIdByUnionId(unionId);
    if (existing != null && existing !== params.bindUserId) {
      await params.failClaimed(params.state);
      try {
        await params.notifyMismatch?.(pending);
      } catch (error) {
        console.error(`通道绑定身份不一致通知失败, state=${params.state}`, error);
      }
      return 'identity-mismatch';
    }
    try {
      await params.bind(params.bindUserId, unionId, pending);
    } catch (error) {
      // bind 失败（如钉钉身份字段不完整）把行放回 SENT，供恢复接管或用户重发后重试，不留死锁的 CLAIMED
      await params.release(params.state).catch(() => undefined);
      throw error;
    }
  }
  try {
    await params.replay(pending);
    await params.complete(params.state);
    return 'replayed';
  } catch (error) {
    await params.release(params.state);
    console.error(`恢复待绑定消息失败, state=${params.state}`, error);
    return 'replay-failed';
  }
}

/** 飞书发送者 unionId：优先 union_id，缺省回退 open_id（与 ECP 链路语义一致）。 */
export function feishuUnionIdOf(pending: { event: Pick<FeishuNormalizedMessage, 'senderUnionId' | 'senderId'> }): string | null {
  return pending.event.senderUnionId ?? pending.event.senderId ?? null;
}

/** 钉钉发送者 unionId（入站事件经平台签名背书，密码档绑定的就是事件里的发送者身份）。 */
export function dingtalkUnionIdOf(pending: { event: { senderUnionId?: string | null } }): string | null {
  return pending.event.senderUnionId ?? null;
}

/** 拼密码绑定链接：siteBaseUrl 去尾斜杠后接 SPA 路由（Web 端 history 模式）。 */
export function channelBindLink(siteBaseUrl: string, path: string, state: string): string {
  const base = siteBaseUrl.trim().replace(/\/+$/, '');
  return `${base}/${path}/${encodeURIComponent(state)}`;
}
