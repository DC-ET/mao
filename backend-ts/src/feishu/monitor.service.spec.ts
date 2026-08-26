import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FeishuInboundProcessor, FeishuNormalizedMessage } from './types.js';

// 记录 register 进来的事件处理器，便于直接调用验证 ack 不被入站处理阻塞。
const registeredHandlers = new Map<string, (data: unknown) => Promise<unknown>>();

vi.mock('@larksuiteoapi/node-sdk', () => {
  class EventDispatcher {
    register(handles: Record<string, (data: unknown) => Promise<unknown>>): EventDispatcher {
      for (const [key, handler] of Object.entries(handles)) registeredHandlers.set(key, handler);
      return this;
    }
  }
  class Client {
    request(): Promise<{ bot: { open_id: string } }> { return Promise.resolve({ bot: { open_id: 'ou_bot' } }); }
  }
  class WSClient {
    constructor(_params: unknown) { /* nothing to connect in test */ }
    start(_params: unknown): Promise<void> { return Promise.resolve(); }
    close(): void { /* noop */ }
  }
  return { Client, EventDispatcher, WSClient };
});

vi.mock('../crypto/aes-gcm.js', () => ({
  decryptAesGcm: () => 'decrypted-app-secret',
}));

import { createFeishuBotHandle } from './monitor.service.js';

function makeBot() {
  return {
    id: 1, name: 'bot', appId: 'cli_test_app', appSecret: 'cipher:secret',
    enabled: 1, deleted: 0,
  };
}

const config = { appSecretKey: 'key', appId: 'cli_test_app', appSecret: 'x', enabled: true } as never;

function makeProcessor(process: (accountId: string, event: FeishuNormalizedMessage) => Promise<void>): FeishuInboundProcessor {
  return { process } as unknown as FeishuInboundProcessor;
}

/** 构造一个能被 normalizeFeishuEvent 正常解析的 v2 事件信封。 */
function makeEventEnvelope(appId = 'cli_test_app'): Record<string, unknown> {
  return {
    header: { app_id: appId, event_id: 'evt-1' },
    event: {
      message: {
        message_id: 'om_1', chat_type: 'p2p', chat_id: 'oc_1',
        message_type: 'text', content: '{"text":"hi"}',
      },
      sender: { sender_id: { open_id: 'ou_1', union_id: 'on_1' } },
    },
  };
}

describe('createFeishuBotHandle event ack', () => {
  beforeEach(() => registeredHandlers.clear());

  it('returns the ack immediately without awaiting the inbound agent execution', async () => {
    let resolveProcess!: () => void;
    let processFinished = false;
    const processor = makeProcessor(async (_accountId, _event) => {
      await new Promise<void>((r) => { resolveProcess = r; });
      processFinished = true;
    });
    const handle = createFeishuBotHandle(makeBot() as never, config, processor as never);
    handle.start();

    const handler = registeredHandlers.get('im.message.receive_v1');
    expect(handler).toBeDefined();
    const ackPromise = handler!(makeEventEnvelope('cli_test_app'));
    // 事件处理器必须立即 resolve，否则长连接会一直占用直到 agent 执行结束。
    const raced = await Promise.race([
      ackPromise.then(() => 'acked'),
      new Promise<string>((r) => setTimeout(() => r('blocked'), 200)),
    ]);
    expect(raced).toBe('acked');
    expect(processFinished).toBe(false);

    resolveProcess();
    await ackPromise;
    expect(processFinished).toBe(true);
  });

  it('does not dispatch when the event belongs to another app', async () => {
    const process = vi.fn(async () => undefined);
    const handle = createFeishuBotHandle(makeBot() as never, config, { process } as never);
    handle.start();
    const handler = registeredHandlers.get('im.message.receive_v1')!;
    await handler(makeEventEnvelope('cli_other'));
    expect(process).not.toHaveBeenCalled();
  });

  it('ignores events that fail to normalize', async () => {
    const process = vi.fn(async () => undefined);
    const handle = createFeishuBotHandle(makeBot() as never, config, { process } as never);
    handle.start();
    const handler = registeredHandlers.get('im.message.receive_v1')!;
    // 缺少 message 对象，normalize 返回 null。
    await handler({ header: { app_id: 'cli_test_app' }, event: { sender: {} } });
    expect(process).not.toHaveBeenCalled();
  });
});
