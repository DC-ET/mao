import { describe, expect, it, vi, afterEach } from 'vitest';
import type { FeishuBot, FeishuBotRepository } from './types.js';
import { encryptAesGcmNonNull } from '../crypto/aes-gcm.js';

const SECRET = 'unit-secret-key';

/**
 * 复现钉钉侧已修复的同类缺陷（docs/code-review/2026-10-13-code-review-03.md BUG-3）：
 * 飞书 FeishuMonitorService 把退避计数 failureCount 声明在「一次 launch」的局部，
 * 而重连动作跨多次 launch —— onFailure 到点后删 entry 并靠 reconcile() 重新 launch，
 * 新 closure 里 failureCount 又是 0。于是指数退避永远是第一档，
 * reconnectMaxMs / maxConsecutiveFailures 全是死代码。
 */

// WSClient.start() 永远失败，强制走 onFailure 退避路径。
vi.mock('@larksuiteoapi/node-sdk', () => {
  class EventDispatcher {
    register(): EventDispatcher { return this; }
  }
  class Client {
    request(): Promise<never> { return Promise.reject(new Error('unused')); }
  }
  class WSClient {
    start(): Promise<void> { return Promise.reject(new Error('connect refused')); }
    close(): void { /* noop */ }
  }
  return { Client, EventDispatcher, WSClient };
});

import { FeishuMonitorService } from './monitor.service.js';

function makeBot(id: number): FeishuBot {
  return {
    id,
    appKey: `app-${id}`,
    name: `bot-${id}`,
    appId: `cli_app_${id}`,
    appSecret: encryptAesGcmNonNull(`secret-${id}`, SECRET),
    enabled: 1,
    deleted: 0,
  };
}

function makeRepo(bots: FeishuBot[]) {
  return {
    list: vi.fn(async () => bots),
    findById: vi.fn(async (id: number) => bots.find((b) => b.id === id) ?? null),
    findByAppKey: vi.fn(async () => null),
    create: vi.fn(async () => 0),
    update: vi.fn(async () => {}),
    softDelete: vi.fn(async () => {}),
  } satisfies FeishuBotRepository;
}

const config = {
  enabled: true,
  appSecretKey: SECRET,
  appId: 'cli_app_1',
  appSecret: 'x',
  longConnection: {
    enabled: true,
    reconcileIntervalMs: 60_000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 60_000,
    maxConsecutiveFailures: 10,
  },
  groupContext: { maxItems: 20, maxMinutes: 120, overflowItems: 100 },
  reply: { maxLength: 2000 },
  file: { maxInboundFileMb: 100 },
};

describe('FeishuMonitorService 重连退避', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('连续失败时重连间隔按指数升级，不得恒定为 reconnectBaseMs', async () => {
    vi.useFakeTimers();
    try {
      const b = makeBot(1);
      // 每次 reconcile 都会 list()，其发生时刻的间隔就是真实的重连退避时长。
      const listAt: number[] = [];
      const repo = makeRepo([b]);
      repo.list.mockImplementation(async () => { listAt.push(Date.now()); return [b]; });

      const monitor = new FeishuMonitorService(config as never, repo);
      monitor.start();
      // 覆盖 1s / 2s / 4s / 8s / 16s 五档退避。
      await vi.advanceTimersByTimeAsync(40_000);

      const gaps = listAt.slice(1).map((t, i) => t - listAt[i]);
      expect(gaps.length).toBeGreaterThanOrEqual(3);
      // 指数退避：相邻两次重连间隔必须递增（1s → 2s → 4s）。
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
      }
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('连续失败超过 maxConsecutiveFailures 后计数归一，退避在第一档与第二档之间循环', async () => {
    vi.useFakeTimers();
    try {
      const b = makeBot(2);
      const listAt: number[] = [];
      const repo = makeRepo([b]);
      repo.list.mockImplementation(async () => { listAt.push(Date.now()); return [b]; });

      // maxConsecutiveFailures = 2：第 3 次失败时计数归一到 1，退避回到 1s，
      // 之后再次升到 2s，如此循环、永不到达 4s。若计数从不跨 launch 保留，
      // 归一化分支永不触发，间隔恒为 1s、永远不会出现 2s 档。
      const monitor = new FeishuMonitorService({
        ...config,
        longConnection: { ...config.longConnection, maxConsecutiveFailures: 2 },
      } as never, repo);
      monitor.start();
      await vi.advanceTimersByTimeAsync(20_000);

      const gaps = listAt.slice(1).map((t, i) => t - listAt[i]);
      expect(gaps.length).toBeGreaterThanOrEqual(4);
      // 退避档位只能在 1s / 2s 之间循环：既不能恒定 1s，也不能越过 2s。
      for (const gap of gaps) {
        expect([1000, 2000]).toContain(gap);
      }
      expect(gaps.filter((gap) => gap === 1000).length).toBeGreaterThan(0);
      expect(gaps.filter((gap) => gap === 2000).length).toBeGreaterThan(0);
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
