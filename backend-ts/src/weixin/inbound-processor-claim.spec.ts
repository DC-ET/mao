import { describe, expect, it, vi } from 'vitest';
import { InboundProcessor } from './inbound-processor.js';
import { WeixinInboundMessageRepository } from './inbound-message.repository.js';

function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
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

function makeProcessor(repo?: ReturnType<typeof makeRepo>) {
  const inboundHandler = { onMessage: vi.fn(async () => ({ text: 'reply' })) };
  const contextTokenRepository = { saveOrUpdate: vi.fn(async () => undefined) };
  const weixinSendService = { sendText: vi.fn(async () => true) };
  const weixinMediaService = { downloadImage: vi.fn(async () => null), downloadFile: vi.fn(async () => null) };
  const voiceReply = { sendVoiceReply: vi.fn(async () => false) };
  const processor = new InboundProcessor(
    inboundHandler as never,
    contextTokenRepository as never,
    weixinSendService as never,
    weixinMediaService as never,
    voiceReply as never,
    repo as never,
  );
  return { processor, inboundHandler, weixinSendService };
}

const TEXT_MESSAGE = {
  from_user_id: 'wx-user-1',
  context_token: 'ctx-1',
  item_list: [{ type: 1, text_item: { text: '你好' } }],
};

describe('InboundProcessor 认领表集成', () => {
  it('enqueueInboundMessage：新消息入队并返回指纹', async () => {
    const repo = makeRepo();
    const { processor } = makeProcessor(repo);
    const key = await processor.enqueueInboundMessage('acc-1', TEXT_MESSAGE);
    expect(key).toBe(WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE));
    expect(repo.enqueue).toHaveBeenCalledOnce();
  });

  it('enqueueInboundMessage：窗口内重复（服务端重投）返回 null', async () => {
    const repo = makeRepo({ enqueue: vi.fn(async () => false), shouldSkipDuplicate: vi.fn(async () => true) });
    const { processor } = makeProcessor(repo);
    const key = await processor.enqueueInboundMessage('acc-1', TEXT_MESSAGE);
    expect(key).toBeNull();
    expect(repo.reclaimForResend).not.toHaveBeenCalled();
  });

  it('enqueueInboundMessage：DONE 超窗口的合法重发回收行并放行', async () => {
    const repo = makeRepo({ enqueue: vi.fn(async () => false), shouldSkipDuplicate: vi.fn(async () => false) });
    const { processor } = makeProcessor(repo);
    const key = await processor.enqueueInboundMessage('acc-1', TEXT_MESSAGE);
    expect(key).not.toBeNull();
    expect(repo.reclaimForResend).toHaveBeenCalledOnce();
  });

  it('正常处理（已知指纹）：处理 → DONE，不再重复入队', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo);
    const key = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
    await processor.processInboundMessage('acc-1', TEXT_MESSAGE, key);
    expect(repo.enqueue).not.toHaveBeenCalled();
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', key);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('直接调用（未先入队）：自行入队，窗口内重复则跳过', async () => {
    const repo = makeRepo({ enqueue: vi.fn(async () => false), shouldSkipDuplicate: vi.fn(async () => true) });
    const { processor, inboundHandler } = makeProcessor(repo);
    await processor.processInboundMessage('acc-1', TEXT_MESSAGE);
    expect(repo.enqueue).toHaveBeenCalledOnce();
    expect(inboundHandler.onMessage).not.toHaveBeenCalled();
  });

  it('处理抛错置 FAILED，等待重放', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo);
    inboundHandler.onMessage.mockRejectedValueOnce(new Error('DB 抖动'));
    const key = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
    await processor.processInboundMessage('acc-1', TEXT_MESSAGE, key);
    expect(repo.markDone).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith('acc-1', key);
  });

  it('重放消息成功置 DONE，失败回到 FAILED', async () => {
    const key = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo);
    await processor.processReplayedMessage('acc-1', key, TEXT_MESSAGE);
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(repo.markDone).toHaveBeenCalledWith('acc-1', key);

    inboundHandler.onMessage.mockRejectedValueOnce(new Error('又失败'));
    await processor.processReplayedMessage('acc-1', key, TEXT_MESSAGE);
    expect(repo.markFailed).toHaveBeenCalledWith('acc-1', key);
  });

  it('处理期间按间隔发送心跳，结束后停止', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeRepo();
      const { processor, inboundHandler } = makeProcessor(repo);
      let release!: () => void;
      inboundHandler.onMessage.mockImplementationOnce(() => new Promise((r) => { release = () => r({ text: 'ok' }); }));
      const key = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
      const p = processor.processInboundMessage('acc-1', TEXT_MESSAGE, key);
      await vi.advanceTimersByTimeAsync(WeixinInboundMessageRepository.HEARTBEAT_INTERVAL_MS * 2 + 10);
      expect(repo.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
      release();
      await p;
      const callsAtEnd = repo.heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(WeixinInboundMessageRepository.HEARTBEAT_INTERVAL_MS * 2);
      expect(repo.heartbeat.mock.calls.length).toBe(callsAtEnd);
    } finally {
      vi.useRealTimers();
    }
  });

  it('未挂认领表时保持旧行为（直接处理，无状态机）', async () => {
    const { processor, inboundHandler } = makeProcessor(undefined);
    await processor.processInboundMessage('acc-1', TEXT_MESSAGE);
    expect(inboundHandler.onMessage).toHaveBeenCalledOnce();
    expect(await processor.hasInFlightMessages('acc-1')).toBe(false);
    expect(await processor.reclaimStuckMessages('acc-1')).toEqual([]);
  });

  it('handler 返回 null（被接管）也视为处理完成置 DONE，不再重放', async () => {
    const repo = makeRepo();
    const { processor, inboundHandler } = makeProcessor(repo);
    inboundHandler.onMessage.mockResolvedValueOnce(null);
    const key = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
    await processor.processInboundMessage('acc-1', TEXT_MESSAGE, key);
    expect(repo.markDone).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });
});

describe('WeixinInboundMessageRepository.messageKeyOf', () => {
  it('相同内容指纹一致，不同内容不同', () => {
    const a = WeixinInboundMessageRepository.messageKeyOf(TEXT_MESSAGE);
    const b = WeixinInboundMessageRepository.messageKeyOf({ ...TEXT_MESSAGE });
    const c = WeixinInboundMessageRepository.messageKeyOf({
      ...TEXT_MESSAGE,
      item_list: [{ type: 1, text_item: { text: '另一条' } }],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
