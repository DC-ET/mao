import { describe, expect, it, vi } from 'vitest';
import { InboundProcessor } from './inbound-processor.js';
import { WeixinInboundMessageRepository } from './inbound-message.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { WeixinMediaService } from './media.service.js';
import type { WeixinSendService } from './send.service.js';
import type { WeixinVoiceReplyService } from './voice-reply.service.js';

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    enqueue: vi.fn(async () => true),
    markDone: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    shouldSkipDuplicate: vi.fn(async () => true),
    reclaimForResend: vi.fn(async () => undefined),
    ...overrides,
  };
}

function textMessage(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: 'wx-user-1',
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

function imageMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: 'wx-user-1',
    context_token: 'ctx-1',
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p' } } }],
    ...overrides,
  };
}

function makeProcessor(repo: ReturnType<typeof makeRepo> | undefined, mergeWindowMs: number) {
  const inboundHandler = { onMessage: vi.fn(async () => ({ text: 'reply' })), authorizeDirectMessage: vi.fn() };
  const contextTokenRepository = { saveOrUpdate: vi.fn(async () => undefined) };
  const weixinSendService = { sendText: vi.fn(async () => true) };
  const weixinMediaService = { downloadImage: vi.fn(async () => null), downloadFile: vi.fn(async () => null) };
  const voiceReply = { sendVoiceReply: vi.fn(async () => false) };
  const processor = new InboundProcessor(
    inboundHandler as never,
    contextTokenRepository as unknown as ContextTokenRepository,
    weixinSendService as unknown as WeixinSendService,
    weixinMediaService as unknown as WeixinMediaService,
    voiceReply as unknown as WeixinVoiceReplyService,
    repo as never,
    undefined,
    undefined,
    mergeWindowMs,
  );
  return { processor, inboundHandler, contextTokenRepository, weixinMediaService };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('InboundProcessor 合并窗口', () => {
  it('两条纯文本窗口期内合并为一次触发，正文按到达序拼接，两个 key 均 markDone', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 30);
    const keyA = WeixinInboundMessageRepository.messageKeyOf(textMessage('看看这个'));
    const keyB = WeixinInboundMessageRepository.messageKeyOf(textMessage('帮我总结'));
    await processor.processInboundMessage('acc-1', textMessage('看看这个'), keyA);
    await processor.processInboundMessage('acc-1', textMessage('帮我总结'), keyB);
    await wait(120);
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(inboundHandler.onMessage.mock.calls[0][0].body).toBe('看看这个\n帮我总结');
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', keyA);
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', keyB);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('单条消息窗口到点后单次触发', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 30);
    await processor.processInboundMessage('acc-1', textMessage('只有一条'), 'k1');
    await wait(120);
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(inboundHandler.onMessage.mock.calls[0][0].body).toBe('只有一条');
  });

  it('带图片的消息豁免出窗，单独触发（媒体不跨消息合并）', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler, weixinMediaService } = makeProcessor(repo, 30);
    weixinMediaService.downloadImage.mockResolvedValue({
      dataUri: 'data:image/png;base64,eA==', path: '/ws/img.png', bytes: Buffer.from('x'), mimeType: 'image/png',
    });
    await processor.processInboundMessage('acc-1', textMessage('看这张'), 'k1');
    await processor.processInboundMessage('acc-1', imageMessage(), 'k2');
    expect(inboundHandler.onMessage).toHaveBeenCalledTimes(2);
    expect(inboundHandler.onMessage.mock.calls[0][0].body).toBe('看这张');
    expect(inboundHandler.onMessage.mock.calls[1][0].imageDataUris).toEqual(['data:image/png;base64,eA==']);
    await wait(120);
    expect(inboundHandler.onMessage).toHaveBeenCalledTimes(2);
  });

  it('不同发送者窗口期内仍是两次触发', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 30);
    await processor.processInboundMessage('acc-1', textMessage('甲说', { from_user_id: 'wx-a' }), 'k1');
    await processor.processInboundMessage('acc-1', textMessage('乙说', { from_user_id: 'wx-b' }), 'k2');
    await wait(120);
    expect(inboundHandler.onMessage).toHaveBeenCalledTimes(2);
  });

  it('合并消息的 context_token 取最后非空（回复只能用最新 token）', async () => {
    const repo = makeRepo();
    const { processor, contextTokenRepository } = makeProcessor(repo, 30);
    await processor.processInboundMessage('acc-1', textMessage('第一条', { context_token: 'ctx-1' }), 'k1');
    await processor.processInboundMessage('acc-1', textMessage('第二条', { context_token: 'ctx-2' }), 'k2');
    await wait(120);
    expect(contextTokenRepository.saveOrUpdate).toHaveBeenCalledWith('acc-1', 'wx-user-1', 'ctx-2');
  });

  it('合并执行抛错时批内 key 全部 markFailed，交重放器逐条重放', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 30);
    inboundHandler.onMessage.mockRejectedValueOnce(new Error('DB 抖动'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await processor.processInboundMessage('acc-1', textMessage('一'), 'k1');
    await processor.processInboundMessage('acc-1', textMessage('二'), 'k2');
    await wait(120);
    expect(repo.markDone).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith('acc-1', 'k1');
    expect(repo.markFailed).toHaveBeenCalledWith('acc-1', 'k2');
    errorSpy.mockRestore();
  });

  it('合并执行期间对所有 absorbed key 持续心跳（漏一个都会被重放器回收并发重跑）', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeRepo();
      const { processor, inboundHandler } = makeProcessor(repo, 30);
      let release!: () => void;
      inboundHandler.onMessage.mockImplementationOnce(() => new Promise((r) => { release = () => r({ text: 'ok' }); }));
      const p1 = processor.processInboundMessage('acc-1', textMessage('慢任务前半'), 'k1');
      const p2 = processor.processInboundMessage('acc-1', textMessage('慢任务后半'), 'k2');
      await vi.advanceTimersByTimeAsync(WeixinInboundMessageRepository.HEARTBEAT_INTERVAL_MS * 2 + 10);
      const heartbeats = repo.heartbeat.mock.calls.map((c) => c[1]);
      expect(heartbeats).toContain('k1');
      expect(heartbeats).toContain('k2');
      release();
      await Promise.all([p1, p2]);
      const callsAtEnd = repo.heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(WeixinInboundMessageRepository.HEARTBEAT_INTERVAL_MS * 2);
      expect(repo.heartbeat.mock.calls.length).toBe(callsAtEnd);
    } finally {
      vi.useRealTimers();
    }
  });

  it('全部为空正文时合并后直接 markDone，不触发 handler', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 30);
    await processor.processInboundMessage('acc-1', textMessage(''), 'k1');
    await processor.processInboundMessage('acc-1', textMessage('  '), 'k2');
    await wait(120);
    expect(inboundHandler.onMessage).not.toHaveBeenCalled();
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', 'k1');
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', 'k2');
  });

  it('windowMs=0 时立即单条处理，行为与加窗前一致', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo, 0);
    await processor.processInboundMessage('acc-1', textMessage('甲'), 'k1');
    await processor.processInboundMessage('acc-1', textMessage('乙'), 'k2');
    expect(inboundHandler.onMessage).toHaveBeenCalledTimes(2);
    expect(inboundHandler.onMessage.mock.calls[0][0].body).toBe('甲');
    expect(inboundHandler.onMessage.mock.calls[1][0].body).toBe('乙');
  });

  it('未挂认领表时合并窗口行为不变（无认领状态机，合并/单条照常）', async () => {
    const { processor, inboundHandler } = makeProcessor(undefined, 30);
    await processor.processInboundMessage('acc-1', textMessage('甲'));
    await processor.processInboundMessage('acc-1', textMessage('乙'));
    await wait(120);
    // 无认领表只影响 claim/心跳状态机：窗口合并语义与挂表时一致。
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(inboundHandler.onMessage.mock.calls[0][0].body).toBe('甲\n乙');
    expect(await processor.hasInFlightMessages('acc-1')).toBe(false);
    expect(await processor.reclaimStuckMessages('acc-1')).toEqual([]);
  });
});
