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
    const inboundProcessor = {
      processInboundMessage: vi.fn(async () => {}),
      enqueueInboundMessage: vi.fn(async () => 'key-1'),
      reclaimStuckMessages: vi.fn(async () => []),
      hasInFlightMessages: vi.fn(async () => false),
    };
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
    const inboundProcessor = {
      processInboundMessage: vi.fn(async () => {}),
      enqueueInboundMessage: vi.fn()
        .mockResolvedValueOnce('k1').mockResolvedValueOnce('k2').mockResolvedValueOnce('k3')
        .mockResolvedValue(null),
      reclaimStuckMessages: vi.fn(async () => []),
      hasInFlightMessages: vi.fn(async () => false),
    };
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

  it('监控循环连续失败退出后由周期 reconcile 重新拉起', async () => {
    vi.useFakeTimers();
    try {
      const account = {
        id: 7, accountId: 'acc-heal', enabled: 1,
        payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
        getUpdatesBuf: '',
      };
      const accountRepository = {
        findByAccountId: vi.fn(async () => {
          if (requestCalls > 3) return { ...account, enabled: 0 };
          return account;
        }),
        findAllEnabled: vi.fn(async () => [account]),
        updateGetUpdatesBuf: vi.fn(),
        disableAccount: vi.fn(),
      };
      const inboundProcessor = { processInboundMessage: vi.fn() };
      let requestCalls = 0;
      const http: WeixinHttpClient = {
        // 前 3 次（= maxConsecutiveFailures）全部超时，让 monitorLoop 自行退出；
        // 之后恢复成功，验证 reconcile 把它重新拉起来。
        request: vi.fn(async () => {
          requestCalls++;
          if (requestCalls <= 3) {
            throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
          }
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ ret: 0, errcode: 0, get_updates_buf: 'healed', msgs: [] })),
            header: () => undefined,
          };
        }),
      };
      const monitor = new WeixinMonitorService(
        { ...DEFAULT_WEIXIN_BOT_CONFIG, monitor: { ...DEFAULT_WEIXIN_BOT_CONFIG.monitor, reconcileIntervalMs: 300_000 } },
        accountRepository as never,
        inboundProcessor as never,
        http,
      );

      monitor.start();
      // 跑到「连续失败3次，停止监控」：activeMonitors 应已被清空（reconcile 尚未到点）。
      await vi.advanceTimersByTimeAsync(200_000);
      expect((monitor as unknown as { activeMonitors: Map<string, unknown> }).activeMonitors).toHaveLength(0);
      expect(requestCalls).toBe(3);

      // 下一轮 reconcile 命中，账号被重新拉起并恢复轮询。
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.waitFor(() => {
        expect(accountRepository.updateGetUpdatesBuf).toHaveBeenCalledWith(7, 'healed');
      });
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconcile 查询账号失败不影响既有监控，且不重复拉起活跃账号', async () => {
    vi.useFakeTimers();
    try {
      const account = {
        id: 11, accountId: 'acc-live', enabled: 1,
        payloadJson: JSON.stringify({ token: 't', baseUrl: 'https://ilink.test' }),
        getUpdatesBuf: 'buf-1',
      };
      let listCalls = 0;
      const accountRepository = {
        findByAccountId: vi.fn(async () => ({ ...account, enabled: 0 })),
        findAllEnabled: vi.fn(async () => {
          listCalls++;
          if (listCalls === 1) return [account];
          throw new Error('db down');
        }),
        updateGetUpdatesBuf: vi.fn(),
        disableAccount: vi.fn(),
      };
      const inboundProcessor = {
        processInboundMessage: vi.fn(),
        enqueueInboundMessage: vi.fn(async () => null),
        reclaimStuckMessages: vi.fn(async () => []),
        hasInFlightMessages: vi.fn(async () => false),
      };
      const http: WeixinHttpClient = {
        request: vi.fn(async () => ({
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ ret: 0, errcode: 0, get_updates_buf: 'buf-2', msgs: [] })),
          header: () => undefined,
        })),
      };
      const monitor = new WeixinMonitorService(
        { ...DEFAULT_WEIXIN_BOT_CONFIG, monitor: { ...DEFAULT_WEIXIN_BOT_CONFIG.monitor, reconcileIntervalMs: 5000 } },
        accountRepository as never,
        inboundProcessor as never,
        http,
      );

      monitor.start();
      // 首轮 reconcile 拉起 acc-live，其循环首轮请求成功后由 findByAccountId 返回 enabled=0 自行退出。
      await vi.advanceTimersByTimeAsync(20_000);
      expect((monitor as unknown as { activeMonitors: Map<string, unknown> }).activeMonitors).toHaveLength(0);

      // 后续 reconcile 遇到 DB 异常只记日志，不抛、不影响进程。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listCalls).toBeGreaterThan(2);
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
