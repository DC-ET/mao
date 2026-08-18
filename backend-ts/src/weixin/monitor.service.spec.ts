import { describe, expect, it, vi } from 'vitest';
import { WeixinMonitorService } from './monitor.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import type { WeixinHttpClient } from './weixin-http.js';

describe('WeixinMonitorService', () => {
  it('doesNotStartMonitorWhenDisabled', () => {
    const accountRepository = { findAllEnabled: vi.fn() };
    const monitor = new WeixinMonitorService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, enabled: false },
      accountRepository as never,
      {} as never,
    );

    monitor.startMonitor('acc-disabled');

    expect((monitor as unknown as { activeMonitors: Map<string, unknown> }).activeMonitors).toHaveLength(0);
  });

  it('disablesAccountWhenSessionExpired', async () => {
    const account = {
      id: 9, accountId: 'acc-1', enabled: 1,
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
      getUpdatesBuf: '',
    };
    const accountRepository = {
      findByAccountId: vi.fn(async () => account),
      findAllEnabled: vi.fn(async () => [account]),
      updateGetUpdatesBuf: vi.fn(),
      disableAccount: vi.fn(),
    };
    const inboundProcessor = { processInboundMessage: vi.fn() };
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ ret: 0, errcode: -14, errmsg: 'expired' })),
        header: () => undefined,
      })),
    };
    const monitor = new WeixinMonitorService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, enabled: true, monitor: { ...DEFAULT_WEIXIN_BOT_CONFIG.monitor, enabled: true } },
      accountRepository as never,
      inboundProcessor as never,
      http,
    );
    monitor.startMonitor('acc-1');
    await vi.waitFor(() => {
      expect(accountRepository.disableAccount).toHaveBeenCalledWith(9);
    });
    monitor.shutdown();
  });

  it('processesMessagesAndUpdatesCursor', async () => {
    const account = {
      id: 3, accountId: 'acc-2', enabled: 1,
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
      getUpdatesBuf: 'old',
    };
    let calls = 0;
    const accountRepository = {
      findByAccountId: vi.fn(async () => {
        if (calls > 0) return { ...account, enabled: 0 };
        return account;
      }),
      findAllEnabled: vi.fn(async () => []),
      updateGetUpdatesBuf: vi.fn(async () => { calls++; }),
      disableAccount: vi.fn(),
    };
    const inboundProcessor = { processInboundMessage: vi.fn(async () => {}) };
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({
          ret: 0, errcode: 0, get_updates_buf: 'new-buf',
          msgs: [{ from_user_id: 'wx', item_list: [] }],
        })),
        header: () => undefined,
      })),
    };
    const monitor = new WeixinMonitorService(DEFAULT_WEIXIN_BOT_CONFIG, accountRepository as never, inboundProcessor as never, http);
    monitor.startMonitor('acc-2');
    await vi.waitFor(() => {
      expect(inboundProcessor.processInboundMessage).toHaveBeenCalled();
      expect(accountRepository.updateGetUpdatesBuf).toHaveBeenCalledWith(3, 'new-buf');
    });
    monitor.stopMonitor('acc-2');
    monitor.shutdown();
  });

  it('processesEveryMessageInBatch', async () => {
    const account = {
      id: 4, accountId: 'acc-3', enabled: 1,
      payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
      getUpdatesBuf: '',
    };
    let calls = 0;
    const accountRepository = {
      findByAccountId: vi.fn(async () => {
        if (calls > 0) return { ...account, enabled: 0 };
        return account;
      }),
      findAllEnabled: vi.fn(async () => []),
      updateGetUpdatesBuf: vi.fn(async () => { calls++; }),
      disableAccount: vi.fn(),
    };
    const inboundProcessor = { processInboundMessage: vi.fn(async () => {}) };
    const http: WeixinHttpClient = {
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({
          ret: 0, errcode: 0, get_updates_buf: 'b',
          msgs: [{ from_user_id: 'wx-1' }, { from_user_id: 'wx-1' }, { from_user_id: 'wx-1' }],
        })),
        header: () => undefined,
      })),
    };
    const monitor = new WeixinMonitorService(DEFAULT_WEIXIN_BOT_CONFIG, accountRepository as never, inboundProcessor as never, http);
    monitor.startMonitor('acc-3');
    await vi.waitFor(() => {
      expect(inboundProcessor.processInboundMessage).toHaveBeenCalledTimes(3);
    });
    monitor.stopMonitor('acc-3');
    monitor.shutdown();
  });
});
