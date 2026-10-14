import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DingtalkMonitorService, type DingtalkBot, type DingtalkBotRepository, type DingtalkStreamClient } from './monitor.service.js';
import { encryptAesGcmNonNull } from '../crypto/aes-gcm.js';

const SECRET = 'unit-secret-key';

function bot(id: number, clientId: string, createdAt: string): DingtalkBot {
  return {
    id,
    appKey: `app-${id}`,
    name: `bot-${id}`,
    clientId,
    clientSecret: encryptAesGcmNonNull(`secret-${clientId}`, SECRET),
    robotCode: `robot-${id}`,
    enabled: 1,
  };
}

interface FakeClient {
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeClientFactory() {
  const clients: FakeClient[] = [];
  const factory = (_clientId: string, _clientSecret: string): DingtalkStreamClient => {
    const client: FakeClient = {
      connected: false,
      connect: vi.fn(async () => { client.connected = true; }),
      disconnect: vi.fn(() => { client.connected = false; }),
    };
    clients.push(client);
    return {
      registerCallbackListener: () => {},
      socketCallBackResponse: () => {},
      connect: client.connect as never,
      disconnect: client.disconnect as never,
    };
  };
  return { clients, factory };
}

function makeRepo(bots: DingtalkBot[]) {
  return {
    list: vi.fn(async () => bots),
    findById: vi.fn(async (id: number) => bots.find((b) => b.id === id) ?? null),
    findByAppKey: vi.fn(async () => null),
    create: vi.fn(async () => 0),
    update: vi.fn(async () => {}),
    softDelete: vi.fn(async () => {}),
  } satisfies DingtalkBotRepository;
}

const config = {
  enabled: true,
  appSecretKey: SECRET,
  reconcileIntervalMs: 60_000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60_000,
  maxConsecutiveFailures: 5,
};

describe('DingtalkMonitorService', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('同一 Client ID 只保留一条 Stream：重复 Bot 不得让旧连接的 socket 泄漏', async () => {
    vi.useFakeTimers();
    try {
      const older = bot(1, 'SAME-CLIENT-ID', '2026-01-01 00:00:00');
      const newer = bot(2, 'SAME-CLIENT-ID', '2026-02-01 00:00:00');
      // 初始只有旧 bot：先连上并 ready。
      let rows: DingtalkBot[] = [older];
      const repo = makeRepo(rows);
      repo.list.mockImplementation(async () => rows);
      const { clients, factory } = makeClientFactory();

      const monitor = new DingtalkMonitorService(config, repo, factory);
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(clients.length).toBe(1));
      expect(monitor.getStatus(1)?.status).toBe('ready');

      // 管理员新增一条同 clientId 的新 bot；list() 按 created_at DESC，新 bot 排在前。
      rows = [newer, older];
      await vi.advanceTimersByTimeAsync(config.reconcileIntervalMs);
      await vi.waitFor(() => expect(clients.length).toBe(2));

      // 新 bot 抢到了这条 Stream，旧 bot 被判重标记 failed；
      // 但旧 bot 已经握着的 socket 必须一并断开，否则同一 clientId 有两条并发连接。
      expect(monitor.getStatus(1)?.status).toBe('failed');
      expect(clients[0].disconnect).toHaveBeenCalled();
      expect(clients.filter((c) => c.connected).length).toBe(1);
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重连退避按指数升级：连续失败不能恒定为 reconnectBaseMs', async () => {
    vi.useFakeTimers();
    try {
      const b = bot(7, 'FAILING-CLIENT', '2026-01-01 00:00:00');
      // 记录每次 reconcile(list) 发生的时刻，其间隔就是真实的重连退避时长。
      const listAt: number[] = [];
      const repo = makeRepo([b]);
      repo.list.mockImplementation(async () => { listAt.push(Date.now()); return [b]; });
      const { factory } = makeClientFactory();
      // 让 connect() 永远失败，触发 onFailure 退避路径。
      const failingFactory = (_clientId: string, _clientSecret: string): DingtalkStreamClient => {
        const base = factory(_clientId, _clientSecret);
        return {
          ...base,
          connect: (() => Promise.reject(new Error('connect refused'))) as never,
        };
      };

      const monitor = new DingtalkMonitorService(
        // maxConsecutiveFailures 给大，避开「连续失败上限后计数归一」的有意行为，
        // 单独考察退避是否按 2 的幂递增。
        { ...config, reconnectBaseMs: 1000, reconnectMaxMs: 60_000, maxConsecutiveFailures: 10 },
        repo,
        failingFactory,
      );
      monitor.start();
      // 推进足够长的虚拟时间，覆盖 1s / 2s / 4s / 8s 四档退避。
      await vi.advanceTimersByTimeAsync(20_000);

      // listAt[0] 是 start 的首次 reconcile，之后每次都是退避到点后的重连。
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
  it('认领方已持有连接时不得被误杀：重复方新增，原连接必须保住', async () => {
    vi.useFakeTimers();
    try {
      const claimant = bot(1, 'SHARED-CLIENT-ID', '2026-01-01 00:00:00');
      const duplicate = bot(2, 'SHARED-CLIENT-ID', '2026-03-01 00:00:00');
      // 第一轮只有 claimant：它认领这条 clientId 并连上。
      let rows: DingtalkBot[] = [claimant];
      const repo = makeRepo(rows);
      repo.list.mockImplementation(async () => rows);
      const { clients, factory } = makeClientFactory();

      const monitor = new DingtalkMonitorService(config, repo, factory);
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(clients.length).toBe(1));
      expect(monitor.getStatus(1)?.status).toBe('ready');

      // 第二轮出现同 clientId 的重复方，且 claimant 仍排在前面（list 的 created_at DESC
      // 在时间戳相同时不保证稳定，认领方仍是 claimant）。
      // 判重若按「clientId 相同就停掉 active 里的旧连接」实现，会把 claimant 唯一在用的
      // socket 一起摘掉，这条 clientId 上一条连接都不剩。
      rows = [claimant, duplicate];
      await vi.advanceTimersByTimeAsync(config.reconcileIntervalMs);
      await vi.waitFor(() => expect(monitor.getStatus(2)?.status).toBe('failed'));

      expect(monitor.getStatus(1)?.status).toBe('ready');
      expect(clients[0].disconnect).not.toHaveBeenCalled();
      // 重复方压根不该启动
      expect(clients.length).toBe(1);
      expect(clients.filter((c) => c.connected).length).toBe(1);
      monitor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
