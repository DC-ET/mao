import { decryptAesGcm } from '../crypto/aes-gcm.js';
import { normalizeDingtalkEvent } from './event-normalizer.js';
import type { DingtalkInboundProcessor } from './inbound-processor.js';
import type { DingtalkBot, DingtalkBotRepository } from './types.js';

export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
export const DINGTALK_CARD_TOPIC = '/v1.0/card/instances/callback';

export interface DingtalkStreamDownlink {
  headers?: { messageId?: string };
  data?: string;
}

export interface DingtalkStreamClient {
  registerCallbackListener(topic: string, callback: (message: DingtalkStreamDownlink) => void | Promise<void>): void;
  socketCallBackResponse(messageId: string, payload: unknown): void;
  connect(): Promise<void> | void;
  disconnect(): void;
}

export interface DingtalkBotHandle {
  start(): void;
  stop(): void;
}

export interface DingtalkBotHandleCallbacks {
  onReady?: () => void;
  onFailure?: (error?: unknown) => void;
  onReconnecting?: () => void;
}

export interface DingtalkMonitorConfig {
  enabled: boolean;
  appSecretKey: string;
  reconcileIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxConsecutiveFailures: number;
}

export type DingtalkBotConnectionStatus = 'ready' | 'reconnecting' | 'failed' | 'disabled';

export interface DingtalkBotRuntimeStatus {
  botId: number;
  status: DingtalkBotConnectionStatus;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
  lastReadyAt: string | null;
}

export function createDingtalkBotHandle(
  bot: DingtalkBot,
  secretKey: string,
  openClient: (clientId: string, clientSecret: string) => DingtalkStreamClient,
  processor?: DingtalkInboundProcessor,
  callbacks?: DingtalkBotHandleCallbacks,
  onCard?: (raw: unknown) => Promise<unknown>,
): DingtalkBotHandle {
  if (!bot.id) throw new Error('钉钉Bot缺少id');
  const clientSecret = decryptAesGcm(bot.clientSecret, secretKey, '钉钉Bot clientSecret解密失败');
  const client = openClient(bot.clientId, clientSecret);
  const accountId = String(bot.id);
  client.registerCallbackListener(DINGTALK_ROBOT_TOPIC, (message) => {
    const messageId = message.headers?.messageId;
    if (messageId) client.socketCallBackResponse(messageId, { status: 'SUCCESS' });
    const event = normalizeDingtalkEvent(parseData(message.data));
    if (event == null || processor == null) return;
    console.info(`钉钉收到消息, id=${bot.id}, messageId=${event.messageId}, chatType=${event.chatType}`);
    void processor.process(accountId, event).catch((error) => console.error(`钉钉入站处理失败, id=${bot.id}`, error));
  });
  if (onCard != null) {
    client.registerCallbackListener(DINGTALK_CARD_TOPIC, async (message) => {
      const messageId = message.headers?.messageId;
      let response: unknown = {};
      let after: (() => Promise<void>) | undefined;
      try {
        const decision = await onCard(parseData(message.data)) as { response?: unknown; after?: () => Promise<void> } | undefined;
        response = decision?.response ?? decision ?? {};
        after = decision?.after;
      } catch (error) {
        console.error(`钉钉卡片动作处理失败, id=${bot.id}`, error);
      }
      if (messageId) client.socketCallBackResponse(messageId, response);
      if (after != null) void after().catch((error) => console.error(`钉钉卡片后续动作失败, id=${bot.id}`, error));
    });
  }
  return {
    start() {
      void Promise.resolve(client.connect()).then(() => callbacks?.onReady?.()).catch((error: unknown) => {
        console.error(`钉钉Bot长连接启动失败, id=${bot.id}`, error);
        callbacks?.onFailure?.(error);
      });
    },
    stop() {
      try { client.disconnect(); } catch (error) { console.error(`停止钉钉Bot失败, id=${bot.id}`, error); }
    },
  };
}

export class DingtalkMonitorService {
  private readonly active = new Map<number, { handle: DingtalkBotHandle; generation: symbol; fingerprint: string; clearRetryTimer: () => void }>();
  private readonly runtimeStates = new Map<number, { status: DingtalkBotConnectionStatus; lastFailureReason: string | null; lastFailureAt: string | null; lastReadyAt: string | null }>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private reconciling = false;

  constructor(
    private readonly config: DingtalkMonitorConfig,
    private readonly repository: DingtalkBotRepository,
    private readonly openClient: (clientId: string, clientSecret: string) => DingtalkStreamClient,
    private readonly processor?: DingtalkInboundProcessor,
    private readonly onCard?: (raw: unknown, botId: number) => Promise<unknown>,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      console.info('钉钉Bot监控未启用');
      return;
    }
    if (!this.config.appSecretKey) {
      console.error('钉钉Bot已启用但 APP_DINGTALK_BOT_SECRET 未配置，无法启动 Stream');
      return;
    }
    if (this.started) return;
    this.started = true;
    void this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.config.reconcileIntervalMs);
    this.timer.unref();
    console.info('钉钉Bot监控已启动');
  }

  shutdown(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    for (const [id, entry] of this.active) {
      try { entry.clearRetryTimer(); entry.handle.stop(); } catch (error) { console.error(`停止钉钉Bot失败, id=${id}`, error); }
    }
    this.active.clear();
    this.started = false;
  }

  getStatus(botId: number): DingtalkBotRuntimeStatus | null {
    const state = this.runtimeStates.get(botId);
    return state == null ? null : { botId, ...state };
  }

  async reconnect(botId: number): Promise<boolean> {
    if (!this.started) return false;
    const bots = await this.repository.list();
    const bot = bots.find((item) => item.id === botId && item.enabled === 1);
    if (bot == null) return false;
    const entry = this.active.get(botId);
    if (entry != null) {
      try { entry.clearRetryTimer(); entry.handle.stop(); } catch (error) { console.error(`重连前停止钉钉Bot失败, id=${botId}`, error); }
      this.active.delete(botId);
    }
    this.mark(botId, { status: 'reconnecting' });
    void this.reconcile();
    return true;
  }

  private mark(botId: number, patch: Partial<{ status: DingtalkBotConnectionStatus; lastFailureReason: string | null; lastFailureAt: string | null; lastReadyAt: string | null }>): void {
    const current = this.runtimeStates.get(botId) ?? { status: 'reconnecting' as const, lastFailureReason: null, lastFailureAt: null, lastReadyAt: null };
    this.runtimeStates.set(botId, { ...current, ...patch });
  }

  private async reconcile(): Promise<void> {
    if (!this.started || this.reconciling) return;
    this.reconciling = true;
    try {
      const bots = await this.repository.list();
      const enabled = new Map(bots.filter((bot) => bot.enabled === 1 && bot.id != null).map((bot) => [bot.id!, bot]));
      for (const [id, entry] of this.active) {
        const bot = enabled.get(id);
        const fingerprint = bot == null ? '' : `${bot.clientId}:${bot.clientSecret}:${bot.robotCode}`;
        if (bot == null || entry.fingerprint !== fingerprint) {
          try { entry.clearRetryTimer(); entry.handle.stop(); } catch (error) { console.error(`停止钉钉Bot失败, id=${id}`, error); }
          this.active.delete(id);
        }
      }
      const seenClientIds = new Set<string>();
      for (const bot of bots) {
        if (bot.id == null) continue;
        if (bot.enabled !== 1) {
          this.mark(bot.id, { status: 'disabled', lastFailureReason: null, lastFailureAt: null, lastReadyAt: null });
          continue;
        }
        if (seenClientIds.has(bot.clientId)) {
          console.warn(`钉钉同一 Client ID 只保留一条 Stream, 跳过 id=${bot.id}, clientId=${bot.clientId}`);
          this.mark(bot.id, { status: 'failed', lastFailureReason: '同一 Client ID 已有 Stream 连接', lastFailureAt: new Date().toISOString() });
          continue;
        }
        seenClientIds.add(bot.clientId);
        if (this.active.has(bot.id)) continue;
        this.launch(bot);
      }
    } catch (error) {
      console.error('钉钉Bot监控 reconcile 失败', error);
    } finally {
      this.reconciling = false;
    }
  }

  private launch(bot: DingtalkBot): void {
    if (bot.id == null) return;
    try {
      let failureCount = 0;
      let retryTimer: NodeJS.Timeout | null = null;
      const clearRetryTimer = (): void => { if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; } };
      const generation = Symbol(String(bot.id));
      this.mark(bot.id, { status: 'reconnecting' });
      const handle = createDingtalkBotHandle(bot, this.config.appSecretKey, this.openClient, this.processor, {
        onReady: () => {
          failureCount = 0;
          clearRetryTimer();
          this.mark(bot.id!, { status: 'ready', lastReadyAt: new Date().toISOString(), lastFailureReason: null });
        },
        onFailure: (error) => {
          if (this.active.get(bot.id!)?.generation !== generation) return;
          failureCount += 1;
          this.mark(bot.id!, {
            status: 'failed',
            lastFailureReason: error instanceof Error ? error.message : String(error ?? '未知错误'),
            lastFailureAt: new Date().toISOString(),
          });
          if (failureCount > this.config.maxConsecutiveFailures) {
            console.warn(`钉钉Bot长连接连续失败, id=${bot.id}, count=${failureCount}`);
            failureCount = 1;
          }
          const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** (failureCount - 1));
          if (retryTimer == null) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              const entry = this.active.get(bot.id!);
              if (entry?.generation !== generation) return;
              this.active.delete(bot.id!);
              try { entry.handle.stop(); } catch (stopError) { console.error(`停止失败的钉钉连接失败, id=${bot.id}`, stopError); }
              void this.reconcile();
            }, delay);
            retryTimer.unref();
          }
        },
        onReconnecting: () => this.mark(bot.id!, { status: 'reconnecting' }),
      }, this.onCard == null ? undefined : (raw) => this.onCard!(raw, bot.id!));
      this.active.set(bot.id, { handle, generation, fingerprint: `${bot.clientId}:${bot.clientSecret}:${bot.robotCode}`, clearRetryTimer });
      handle.start();
    } catch (error) {
      console.error(`启动钉钉Bot失败, id=${bot.id}`, error);
      this.mark(bot.id, { status: 'failed', lastFailureReason: error instanceof Error ? error.message : String(error), lastFailureAt: new Date().toISOString() });
    }
  }
}

export async function openDingtalkStreamClient(clientId: string, clientSecret: string): Promise<DingtalkStreamClient> {
  const mod = await import('dingtalk-stream') as { DWClient: new (options: { clientId: string; clientSecret: string; keepAlive?: boolean }) => DingtalkStreamClient };
  return new mod.DWClient({ clientId, clientSecret, keepAlive: true });
}

function parseData(data: string | undefined): unknown {
  if (data == null || data === '') return {};
  try { return JSON.parse(data); } catch { return {}; }
}
