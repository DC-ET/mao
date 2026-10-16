import { describe, expect, it, vi } from 'vitest';
import { FeishuInboundProcessor } from './inbound-processor.js';
import { replayFeishuPendingMessage } from './pending-replay.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';
import type { FeishuInboundContext, FeishuInboundHandler, FeishuNormalizedMessage, FeishuReply } from './types.js';

/** 回归守护：绑定后补投（ECP 完成 / OAuth 完成 / 启动恢复扫描三个调用点的共用入口）
 *  必须绕开合并窗口。曾因 ECP 与启动恢复两条路径直接调 process() 漏传 bypassWindow，
 *  补投被窗口拖延至多 1s，还会与绑定成功后同一发送者的追问合并成一次触发。 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeEvent(overrides: Partial<FeishuNormalizedMessage> = {}): FeishuNormalizedMessage {
  return {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_p2p', chatType: 'p2p',
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: false, content: {}, rawEvent: {},
    ...overrides,
  };
}

function makeHandler(onMessage?: (ctx: FeishuInboundContext) => Promise<FeishuReply | null>): FeishuInboundHandler {
  return {
    authorizeDirectMessage: () => true,
    onMessage: onMessage ?? (async () => ({ text: 'reply' })),
  };
}

function pending(overrides: Partial<FeishuPendingBindingMessage> = {}): FeishuPendingBindingMessage {
  return {
    state: 'st-1',
    appId: 1,
    messageId: 'om_pending',
    cardMessageId: 'card-1',
    event: makeEvent({ messageId: 'om_pending', text: '帮我看下这份报告' }),
    ...overrides,
  };
}

/** 与 feishu/inbound-processor.spec.ts 的 windowedProcessor 同构：开 30ms 窗口 + 内存日志假件。 */
function windowedProcessor(
  onMessage: (ctx: FeishuInboundContext) => Promise<FeishuReply | null>,
): { processor: FeishuInboundProcessor; claimInboundMessage: ReturnType<typeof vi.fn> } {
  const claimInboundMessage = vi.fn(async () => true);
  const svc = {
    claimInboundMessage,
    releaseInboundMessage: vi.fn(async () => undefined),
    completeInboundMessage: vi.fn(async () => undefined),
    recordGroupMessage: vi.fn(async () => 1),
    buildGroupContext: vi.fn(async () => ({ conversation: {} as never, messages: [], prompt: 'group context' })),
    listPendingGroupMessages: vi.fn(async () => []),
    updateGroupMessageContent: vi.fn(async () => undefined),
    updateGroupMessageSenderName: vi.fn(async () => undefined),
    markGroupMessageEnriched: vi.fn(async () => undefined),
  };
  const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
    mergeWindowMs: 30, authorizeSender: async () => true, messageService: svc as never,
  });
  return { processor, claimInboundMessage };
}

describe('replayFeishuPendingMessage（绑定后补投统一入口）', () => {
  it('补投绕开合并窗口：返回即已触发，不等窗口期', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const { processor } = windowedProcessor(onMessage);
    await replayFeishuPendingMessage(processor, pending());
    // 未绕窗时此处 onMessage 还是 0 次（消息挂在 30ms 窗口里）。
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe('帮我看下这份报告');
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('补投不与绑定成功后同一发送者的追问合并，各触发一次', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const { processor } = windowedProcessor(onMessage);
    await replayFeishuPendingMessage(processor, pending());
    await processor.process('1', makeEvent({ messageId: 'om_follow', text: '对了，还有第二份' }));
    await wait(120);
    // 未绕窗时两条会同键合并为 1 次，正文粘成「帮我看下这份报告\n\n对了，还有第二份」。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].text).toBe('帮我看下这份报告');
    expect(onMessage.mock.calls[0][0].messageId).toBe('om_pending');
    expect(onMessage.mock.calls[1][0].text).toBe('对了，还有第二份');
  });

  it('补投透传 progressCardMessageId 且 skipClaim=true（不重复认领入站消息）', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const { processor, claimInboundMessage } = windowedProcessor(onMessage);
    await replayFeishuPendingMessage(processor, pending());
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].progressCardMessageId).toBe('card-1');
    expect(claimInboundMessage).not.toHaveBeenCalled();
  });

  it('多条待恢复消息逐条即时补投，互不合并', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const { processor } = windowedProcessor(onMessage);
    // 启动恢复扫描的场景：同一用户多条待恢复消息连续补投。
    await replayFeishuPendingMessage(processor, pending({ state: 'st-1' }));
    await replayFeishuPendingMessage(processor, pending({
      state: 'st-2',
      event: makeEvent({ messageId: 'om_p2', text: '第二条待恢复' }),
    }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].text).toBe('帮我看下这份报告');
    expect(onMessage.mock.calls[1][0].text).toBe('第二条待恢复');
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});
