import type { WeixinAccountRepository } from './account.repository.js';
import type { InboundProcessor } from './inbound-processor.js';
import type { WeixinBotConfig } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

class SessionExpiredException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredException';
  }
}

export class WeixinMonitorService {
  private readonly activeMonitors = new Map<string, { abort: AbortController }>();
  private httpClient: WeixinHttpClient | null = null;
  private started = false;

  constructor(
    private readonly config: WeixinBotConfig,
    private readonly accountRepository: WeixinAccountRepository,
    private readonly inboundProcessor: InboundProcessor,
    httpClient?: WeixinHttpClient,
  ) {
    if (httpClient) this.httpClient = httpClient;
  }

  start(): void {
    if (!this.config.enabled || !this.config.monitor.enabled) {
      console.info('微信Bot监控未启用');
      return;
    }
    if (this.started) return;
    this.started = true;
    const readTimeout = this.config.monitor.longPollTimeoutMs + 15_000;
    this.httpClient ??= createWeixinHttpClient(readTimeout);
    void this.startAll();
  }

  shutdown(): void {
    for (const [accountId, handle] of this.activeMonitors) {
      handle.abort.abort();
      void accountId;
    }
    this.activeMonitors.clear();
    this.started = false;
    console.info('微信Bot监控已停止');
  }

  async startAll(): Promise<void> {
    const accounts = await this.accountRepository.findAllEnabled();
    for (const account of accounts) {
      if (account.accountId) this.startMonitor(account.accountId);
    }
    console.info(`微信Bot监控已启动, 账号数=${this.activeMonitors.size}`);
  }

  startMonitor(accountId: string): void {
    if (!this.config.enabled || !this.config.monitor.enabled) {
      console.info('微信Bot监控未启用');
      return;
    }
    if (this.activeMonitors.has(accountId)) {
      console.debug(`账号监控已在运行, accountId=${accountId}`);
      return;
    }
    if (!this.httpClient) {
      const readTimeout = this.config.monitor.longPollTimeoutMs + 15_000;
      this.httpClient = createWeixinHttpClient(readTimeout);
    }
    const abort = new AbortController();
    const handle = { abort };
    this.activeMonitors.set(accountId, handle);
    console.info(`启动账号监控, accountId=${accountId}`);
    void this.monitorLoop(accountId, abort.signal, handle);
  }

  stopMonitor(accountId: string): void {
    const handle = this.activeMonitors.get(accountId);
    if (handle) {
      this.activeMonitors.delete(accountId);
      handle.abort.abort();
      console.info(`停止账号监控, accountId=${accountId}`);
    }
  }

  private async monitorLoop(accountId: string, signal: AbortSignal, handle: { abort: AbortController }): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const account = await this.accountRepository.findByAccountId(accountId);
        if (account == null || account.enabled == null || account.enabled !== 1) {
          console.info(`账号已禁用或不存在，停止监控, accountId=${accountId}`);
          break;
        }
        const payload = JSON.parse(account.payloadJson ?? '{}') as { token: string; baseUrl: string };
        const result = await this.getUpdates(payload.baseUrl, payload.token, account.getUpdatesBuf ?? null, signal);
        consecutiveFailures = 0;
        if (result.messages.length > 0) {
          console.info(`收到${result.messages.length}条微信消息, accountId=${accountId}`);
          // 第一步：先 await 全部入队（幂等键 + payload 落库），保证「游标推进前消息必然已在表中」；
          // 入队失败（DB 异常）直接抛出走外层重试，游标本轮不推进，ilink 会重投。
          const queued: Array<{ messageKey: string | null; message: Record<string, unknown> }> = [];
          for (const message of result.messages) {
            const messageKey = await this.inboundProcessor.enqueueInboundMessage(accountId, message);
            if (messageKey != null) queued.push({ messageKey, message });
          }
          // 第二步：fire-and-forget 后台处理，不阻塞 monitorLoop 轮询（后一条消息可在前一条
          // Agent 执行期间重入 handler，触发纠偏取代逻辑）；失败置 FAILED，由下方重放段兜底重投。
          for (const item of queued) {
            void this.inboundProcessor.processInboundMessage(accountId, item.message, item.messageKey)
              .catch((e) => console.error(`处理单条消息异常, accountId=${accountId}`, e));
          }
        }
        // 重放失败/中断遗留的入站消息（FAILED 或无心跳超时的 CLAIMED），先于游标推进，
        // 保证「上一批处理失败 + 进程重启」场景消息不丢。
        const replay = await this.inboundProcessor.reclaimStuckMessages?.(accountId) ?? [];
        for (const item of replay) {
          void item.run().catch((e) => console.error(`重放单条消息异常, accountId=${accountId}`, e));
        }
        // 游标仅在「新消息已全部入队」且「无在途未处理消息」时推进；
        // 否则保留旧游标让 ilink 侧重投，配合认领表幂等键去重。
        if (result.newBuf != null && account.id != null) {
          const inFlight = await this.inboundProcessor.hasInFlightMessages?.(accountId) ?? false;
          if (!inFlight) {
            await this.accountRepository.updateGetUpdatesBuf(account.id, result.newBuf);
          } else {
            console.debug(`存在在途微信消息，暂缓推进游标, accountId=${accountId}`);
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        if (e instanceof SessionExpiredException) {
          console.warn(`账号 session 过期，禁用账号, accountId=${accountId}`, e);
          const expiredAccount = await this.accountRepository.findByAccountId(accountId);
          if (expiredAccount?.id != null) {
            await this.accountRepository.disableAccount(expiredAccount.id);
          }
          break;
        }
        consecutiveFailures++;
        console.error(`账号监控异常, accountId=${accountId}, failures=${consecutiveFailures}`, e);
        if (consecutiveFailures >= this.config.monitor.maxConsecutiveFailures) {
          console.error(`连续失败${consecutiveFailures}次，停止监控, accountId=${accountId}`);
          break;
        }
        const backoff = Math.min(30_000, 2 ** consecutiveFailures * 1000);
        await sleep(backoff, signal);
      }
    }
    if (this.activeMonitors.get(accountId) === handle) {
      this.activeMonitors.delete(accountId);
    }
    console.info(`账号监控循环结束, accountId=${accountId}`);
  }

  private async getUpdates(baseUrl: string, botToken: string, cursor: string | null, signal?: AbortSignal): Promise<{
    messages: Record<string, unknown>[];
    newBuf: string | null;
  }> {
    const body = {
      get_updates_buf: cursor ?? '',
      base_info: { channel_version: 'mao-server-1.0' },
    };
    const timeoutMs = this.config.monitor.longPollTimeoutMs + 15_000;
    const response = await this.httpClient!.request(`${baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(body),
      timeoutMs,
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`getupdates 失败: HTTP ${response.status}`);
    }
    const jsonNode = JSON.parse(response.body.toString('utf8') || '{}') as {
      ret?: number;
      errcode?: number;
      errmsg?: string;
      get_updates_buf?: string;
      msgs?: Record<string, unknown>[];
    };
    const ret = jsonNode.ret ?? 0;
    const errcode = jsonNode.errcode ?? 0;
    if (ret !== 0 || errcode !== 0) {
      const errmsg = jsonNode.errmsg ?? 'unknown';
      if (errcode === -14) {
        throw new SessionExpiredException(`getupdates session 过期: errcode=${errcode}, errmsg=${errmsg}`);
      }
      throw new Error(`getupdates 业务错误: ret=${ret}, errcode=${errcode}, errmsg=${errmsg}`);
    }
    const newBuf = jsonNode.get_updates_buf ?? null;
    const messages = Array.isArray(jsonNode.msgs) ? jsonNode.msgs : [];
    return { messages, newBuf };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
