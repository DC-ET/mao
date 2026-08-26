import * as Lark from '@larksuiteoapi/node-sdk';
import { decryptAesGcm } from '../crypto/aes-gcm.js';
import type { FeishuBotConfig } from '../config/app-config.js';
import { normalizeFeishuEvent } from './event-normalizer.js';
import { FeishuInboundProcessor } from './inbound-processor.js';
import type { FeishuBot, FeishuBotRepository, FeishuNormalizedMessage } from './types.js';

export interface FeishuBotHandle {
  start(): void;
  stop(): void;
}

export interface FeishuBotHandleCallbacks {
  onReady?: () => void;
  onFailure?: (error?: unknown) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export type FeishuBotHandleFactory = (bot: FeishuBot, callbacks?: FeishuBotHandleCallbacks) => FeishuBotHandle;

/** Creates one SDK WebSocket connection for one enabled Feishu bot. */
export function createFeishuBotHandle(
  bot: FeishuBot,
  config: FeishuBotConfig,
  processor?: FeishuInboundProcessor,
  callbacks?: FeishuBotHandleCallbacks,
): FeishuBotHandle {
  if (!bot.id) throw new Error('飞书Bot缺少id');
  if (!config.appSecretKey) throw new Error('飞书Bot appSecretKey未配置');
  const appSecret = decryptAesGcm(bot.appSecret, config.appSecretKey, '飞书Bot appSecret解密失败');
  const accountId = String(bot.id);
  // 入站处理转入后台异步执行：事件处理器必须立即返回，让 SDK 尽快向飞书回 ack。
  // 若在此处 await 完整 agent 执行，长连接会阻塞到整轮跑完才 ack，飞书侧 ack 超时后
  // 会重发同一事件，造成消息重复执行（飞书已回复但任务一直运行中）。
  // 重复执行由 claimInboundMessage 的 DB 级去重（CLAIMED + 10 分钟窗口）兜底拦截。
  const identityClient = new Lark.Client({ appId: bot.appId, appSecret });
  let botOpenId: string | undefined;
  const dispatchInbound = (event: FeishuNormalizedMessage): void => {
    if (processor == null) return;
    void processor.process(accountId, event).catch((error) => {
      console.error(`飞书入站处理失败, id=${bot.id}`, error);
    });
  };
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      const event = normalizeFeishuEvent(data, botOpenId);
      if (event == null) return;
      if (event.header?.appId !== bot.appId) {
        console.warn(`飞书事件appId不匹配, id=${bot.id}, eventAppId=${event.header?.appId ?? 'null'}, botAppId=${bot.appId}`);
        return;
      }
      console.info(`飞书收到消息, id=${bot.id}, messageId=${event.messageId ?? 'null'}, chatType=${event.chatType}, mentioned=${event.isBotMentioned}`);
      dispatchInbound(event);
    },
  });
  const wsClient = new Lark.WSClient({
    appId: bot.appId,
    appSecret,
    onReady: () => {
      void identityClient.request<{ bot?: { open_id?: string } }>({ url: '/open-apis/bot/v3/info', method: 'GET' })
        .then((response) => { botOpenId = response.bot?.open_id; })
        .catch((error) => { console.warn(`获取飞书Bot open_id失败, id=${bot.id}`, error); });
      console.info(`飞书Bot长连接已连接, id=${bot.id}, appId=${bot.appId}`);
      callbacks?.onReady?.();
    },
    onError: (error: Error) => {
      console.error(`飞书Bot长连接失败, id=${bot.id}`, error);
      callbacks?.onFailure?.(error);
    },
    onReconnecting: () => callbacks?.onReconnecting?.(),
    onReconnected: () => callbacks?.onReconnected?.(),
  });

  return {
    start(): void {
      void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
        console.error(`飞书Bot长连接启动失败, id=${bot.id}`, error);
        callbacks?.onFailure?.(error);
      });
    },
    stop(): void {
      wsClient.close();
    },
  };
}

/**
 * Reconciles enabled database bots with their runtime handles. The SDK owns
 * the Feishu long-connection endpoint and reconnect behavior; this service
 * deliberately does not construct or override an endpoint.
 */
export class FeishuMonitorService {
  private readonly active = new Map<number, { handle: FeishuBotHandle; generation: symbol; fingerprint: string; clearRetryTimer: () => void }>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private reconciling = false;

  private readonly handleFactory: FeishuBotHandleFactory;

  constructor(
    private readonly config: FeishuBotConfig,
    private readonly repository: FeishuBotRepository,
    processorOrFactory?: FeishuInboundProcessor | FeishuBotHandleFactory,
    handleFactory?: FeishuBotHandleFactory,
  ) {
    this.handleFactory = typeof processorOrFactory === 'function'
      ? processorOrFactory
      : handleFactory ?? ((bot, callbacks) => createFeishuBotHandle(bot, config, processorOrFactory, callbacks));
  }

  start(): void {
    if (!this.config.enabled || !this.config.longConnection.enabled) {
      console.info('飞书Bot监控未启用');
      return;
    }
    if (!this.config.appSecretKey) {
      console.error('飞书Bot已启用但 APP_FEISHU_BOT_SECRET 未配置，无法启动机器人长连接');
      return;
    }
    if (this.started) return;
    this.started = true;
    void this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.config.longConnection.reconcileIntervalMs);
    this.timer.unref();
    console.info('飞书Bot监控已启动');
  }

  shutdown(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [id, entry] of this.active) {
      try { entry.clearRetryTimer(); entry.handle.stop(); } catch (error) { console.error(`停止飞书Bot失败, id=${id}`, error); }
    }
    this.active.clear();
    this.started = false;
    console.info('飞书Bot监控已停止');
  }

  private async reconcile(): Promise<void> {
    if (!this.started || this.reconciling) return;
    this.reconciling = true;
    try {
      const bots = await this.repository.list();
      const enabledIds = new Set(bots.filter((bot) => bot.enabled === 1 && bot.id != null).map((bot) => bot.id!));
      const currentFingerprints = new Map(bots.filter((bot) => bot.id != null).map((bot) => [bot.id!, `${bot.appId}:${bot.appSecret}`]));
      for (const [id, entry] of this.active) {
        if (!enabledIds.has(id) || entry.fingerprint !== currentFingerprints.get(id)) {
          try { entry.clearRetryTimer(); entry.handle.stop(); } catch (error) { console.error(`停止飞书Bot失败, id=${id}`, error); }
          this.active.delete(id);
        }
      }
      for (const bot of bots) {
        if (!this.started) return;
        if (bot.id == null || bot.enabled !== 1 || this.active.has(bot.id)) continue;
        try {
          let failureCount = 0;
          let retryTimer: NodeJS.Timeout | null = null;
          const clearRetryTimer = (): void => {
            if (retryTimer != null) {
              clearTimeout(retryTimer);
              retryTimer = null;
            }
          };
          const generation = Symbol(String(bot.id));
          const callbacks: FeishuBotHandleCallbacks = {
            onReady: () => { failureCount = 0; clearRetryTimer(); },
            onReconnected: () => { failureCount = 0; clearRetryTimer(); },
            onFailure: () => {
              if (this.active.get(bot.id!)?.generation !== generation) return;
              failureCount += 1;
              if (failureCount > this.config.longConnection.maxConsecutiveFailures) {
                console.warn(`飞书Bot长连接连续失败, id=${bot.id}, count=${failureCount}, 进入退避重连`);
                failureCount = 1;
              }
              const delay = Math.min(
                this.config.longConnection.reconnectMaxMs,
                this.config.longConnection.reconnectBaseMs * 2 ** (failureCount - 1),
              );
              if (retryTimer == null) {
                retryTimer = setTimeout(() => {
                  retryTimer = null;
                  const entry = this.active.get(bot.id!);
                  if (entry?.generation === generation) {
                    this.active.delete(bot.id!);
                    try { entry.handle.stop(); } catch (error) { console.error(`停止失败连接失败, id=${bot.id}`, error); }
                    void this.reconcile();
                  }
                }, delay);
                retryTimer.unref();
              }
            },
          };
          const handle = this.handleFactory(bot, callbacks);
          this.active.set(bot.id, { handle, generation, fingerprint: `${bot.appId}:${bot.appSecret}`, clearRetryTimer });
          handle.start();
        } catch (error) {
          console.error(`启动飞书Bot失败, id=${bot.id}`, error);
        }
      }
    } catch (error) {
      console.error('飞书Bot监控 reconcile 失败', error);
    } finally {
      this.reconciling = false;
    }
  }
}

export type FeishuInboundEventHandler = (event: FeishuNormalizedMessage) => void | Promise<void>;
