import { describe, expect, it, vi } from 'vitest';
import { DingtalkInboundProcessor } from './inbound-processor.js';
import type { DingtalkInboundHandler, DingtalkNormalizedMessage } from './types.js';

function event(overrides: Partial<DingtalkNormalizedMessage> = {}): DingtalkNormalizedMessage {
  return {
    chatType: 'p2p', conversationId: 'cid', messageId: 'm1', senderUserid: 'staff', senderUnionId: 'union',
    senderName: '张三', msgtype: 'text', text: '你好', downloadCodes: [], fileName: null, quotedText: null, isInAtList: true,
    ...overrides,
  };
}

function processor(handler: DingtalkInboundHandler, options: ConstructorParameters<typeof DingtalkInboundProcessor>[1] = {}) {
  return new DingtalkInboundProcessor(handler, options);
}

describe('DingtalkInboundProcessor', () => {
  it('does not run the handler twice for the same message id', async () => {
    const onMessage = vi.fn(async () => null);
    const claim = vi.fn(async () => false);
    await processor({ onMessage }, {
      messageService: { claimInbound: claim, completeInbound: vi.fn(), releaseInbound: vi.fn() } as never,
      resolveUserId: async () => 7,
    }).process('1', event());
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allows a FAILED message to be claimed again', async () => {
    const onMessage = vi.fn(async () => null);
    const claim = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const complete = vi.fn();
    const options = {
      messageService: { claimInbound: claim, completeInbound: complete, releaseInbound: vi.fn() } as never,
      resolveUserId: async () => 7,
    };
    const inbound = processor({ onMessage }, options);
    await inbound.process('1', event());
    await inbound.process('1', event());
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('1', 'm1');
  });

  it('sends a short-link card when the sender is unbound', async () => {
    const onMessage = vi.fn();
    const sendBindingCard = vi.fn(async () => true);
    const sendReply = vi.fn();
    await processor({ onMessage }, {
      resolveUserId: async () => null,
      sendBindingCard,
      sendReply,
      oauthConfigured: () => true,
    }).process('1', event());
    expect(sendBindingCard).toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('does not send a binding card when staff id is missing', async () => {
    const sendBindingCard = vi.fn();
    const sendReply = vi.fn();
    await processor({ onMessage: vi.fn() }, { sendBindingCard, sendReply }).process('1', event({ senderUserid: null }));
    expect(sendBindingCard).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith('1', expect.anything(), '当前无法识别你的钉钉身份');
  });

  it('logs an unmentioned group message and does not run the agent', async () => {
    const record = vi.fn();
    const onMessage = vi.fn();
    await processor({ onMessage }, {
      messageService: {
        claimInbound: async () => true,
        completeInbound: vi.fn(),
        releaseInbound: vi.fn(),
        recordGroupInbound: record,
      } as never,
      resolveUserId: async () => 7,
    }).process('1', event({ chatType: 'group', isInAtList: false }));
    expect(record).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('DingtalkInboundProcessor 合并窗口', () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** 带内存群日志的 messageService 假件：record/buildContext 联动，
   *  buildGroupContext 复刻真实实现的「排除指定 messageId」语义。 */
  function makeLogService(): { svc: Record<string, unknown>; rows: Array<{ messageId: string; content: string }>; contextCalls: string[][] } {
    const rows: Array<{ messageId: string; content: string }> = [];
    const contextCalls: string[][] = [];
    const svc = {
      claimInbound: vi.fn(async () => true),
      releaseInbound: vi.fn(async () => undefined),
      completeInbound: vi.fn(async () => undefined),
      recordGroupInbound: vi.fn(async (_accountId: string, e: { messageId: string; text: string }) => {
        rows.push({ messageId: e.messageId, content: e.text });
        return rows.length;
      }),
      buildGroupContext: vi.fn(async (_accountId: string, _cid: string, exclude: readonly string[] = []) => {
        contextCalls.push([...exclude]);
        return rows
          .filter((row) => !exclude.includes(row.messageId))
          .map((row) => row.content)
          .join('\n');
      }),
    };
    return { svc, rows, contextCalls };
  }

  function windowedProcessor(
    onMessage: (ctx: unknown) => Promise<null>,
    options: ConstructorParameters<typeof DingtalkInboundProcessor>[1] = {},
  ): DingtalkInboundProcessor {
    return new DingtalkInboundProcessor({ onMessage } as never, {
      mergeWindowMs: 30, resolveUserId: async () => 7, ...options,
    });
  }

  it('两条文本窗口期内合并为一次触发，正文按到达序拼接，两条 claim 均 complete', async () => {
    const { svc } = makeLogService();
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never, { messageService: svc as never });
    await processor.process('1', event({ messageId: 'm_a', text: '看看这个' }));
    await processor.process('1', event({ messageId: 'm_b', text: '帮我总结' }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('看看这个\n\n帮我总结');
    expect(svc.completeInbound).toHaveBeenCalledWith('1', 'm_a');
    expect(svc.completeInbound).toHaveBeenCalledWith('1', 'm_b');
  });

  it('单条消息窗口到点后单次触发', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_solo', text: '只有一条' }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('只有一条');
  });

  it('p2p `---` 到达即冲刷窗口后单独生效', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_t', text: '先问一句' }));
    await processor.process('1', event({ messageId: 'm_new', text: '---' }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('先问一句');
    expect((onMessage.mock.calls[1][0] as { messageId: string }).messageId).toBe('m_new');
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('不同发送者同会话窗口期内仍是两次触发', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_u1', senderUserid: 'staff_a', text: '甲说' }));
    await processor.process('1', event({ messageId: 'm_u2', senderUserid: 'staff_b', text: '乙说' }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('群聊两条 @ 合并：两条群日志 + 一次触发，groupContext 排除批内全部消息', async () => {
    const { svc, contextCalls } = makeLogService();
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never, { messageService: svc as never });
    await processor.process('1', event({ chatType: 'group', isInAtList: true, messageId: 'm_g1', text: '第一条' }));
    await processor.process('1', event({ chatType: 'group', isInAtList: true, messageId: 'm_g2', text: '第二条' }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(svc.recordGroupInbound).toHaveBeenCalledTimes(2);
    // 批内全部消息都已落库：只排除末条会让第一条作为「历史」重复注入本次 prompt。
    expect(contextCalls).toEqual([['m_g1', 'm_g2']]);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('第一条\n\n第二条');
  });

  it('带 downloadCode 的富文本（内嵌图片）豁免出窗，单独触发', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_t', text: '看这条' }));
    await processor.process('1', event({ messageId: 'm_rich', msgtype: 'richText', text: '图文', downloadCodes: ['code_1'] }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('看这条');
    expect((onMessage.mock.calls[1][0] as { messageId: string }).messageId).toBe('m_rich');
  });

  it('群聊语音（不支持的媒体）不触发、也不阻塞在途批次的窗口到点冲刷', async () => {
    const sendReply = vi.fn(async () => undefined);
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never, { sendReply });
    await processor.process('1', event({ chatType: 'group', isInAtList: true, messageId: 'm_t', text: '看看这个' }));
    await processor.process('1', event({ chatType: 'group', isInAtList: true, messageId: 'm_video', msgtype: 'video', text: '' }));
    // 语音被即时拒绝（不进窗口、不触发），文本批次等窗口到点整批冲刷。
    expect(sendReply).toHaveBeenCalledWith('1', expect.objectContaining({ messageId: 'm_video' }), '群聊暂不支持该类型，请私聊发送');
    expect(onMessage).not.toHaveBeenCalled();
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('看看这个');
  });

  it('豁免消息只等在途批次触发启动，不被其执行阻塞', async () => {
    let release = (): void => undefined;
    const onMessage = vi.fn(async (ctx: { messageId: string }) => {
      if (ctx.messageId === 'm_slow') {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return null;
    });
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_slow', text: '慢任务' }));
    await processor.process('1', event({ messageId: 'm_file', msgtype: 'file', text: '' }));
    // 批次 [m_slow] 的执行一直挂起，文件已在其启动后立即单独触发。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[1][0] as { messageId: string }).messageId).toBe('m_file');
    release();
    await wait(20);
  });

  it('合并触发抛错时批内 claim 全部 release', async () => {
    const { svc } = makeLogService();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = windowedProcessor((async () => { throw new Error('boom'); }) as never, { messageService: svc as never });
    await processor.process('1', event({ messageId: 'm_e1', text: '一' }));
    await processor.process('1', event({ messageId: 'm_e2', text: '二' }));
    await wait(120);
    expect(svc.releaseInbound).toHaveBeenCalledWith('1', 'm_e1');
    expect(svc.releaseInbound).toHaveBeenCalledWith('1', 'm_e2');
    errorSpy.mockRestore();
  });

  it('bypassWindow（绑定后补投）不经过窗口，立即单条触发', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_replay', text: '补投' }), true, { bypassWindow: true });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0][0] as { messageId: string }).messageId).toBe('m_replay');
  });

  it('flushAll 冲刷在途批次', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never);
    await processor.process('1', event({ messageId: 'm_f1', text: '待冲刷' }));
    // flushAll 只保证批次 flush 启动（onMessage 在其内部 await 之后），给一点时间让触发完成。
    await processor.flushAll();
    await wait(50);
    expect(onMessage).toHaveBeenCalledTimes(1);
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('windowMs=0 时立即单条触发，行为与加窗前一致', async () => {
    const onMessage = vi.fn(async () => null);
    const processor = windowedProcessor(onMessage as never, { mergeWindowMs: 0 });
    await processor.process('1', event({ messageId: 'm_z1', text: '甲' }));
    await processor.process('1', event({ messageId: 'm_z2', text: '乙' }));
    // submit 已 await 到 onFlush 返回：无需等待定时器即两次触发、无合并。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect((onMessage.mock.calls[0][0] as { text: string }).text).toBe('甲');
    expect((onMessage.mock.calls[1][0] as { text: string }).text).toBe('乙');
  });
});
