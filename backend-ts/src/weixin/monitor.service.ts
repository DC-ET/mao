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
        if (result.newBuf != null && account.id != null) {
          await this.accountRepository.updateGetUpdatesBuf(account.id, result.newBuf);
        }
        if (result.messages.length > 0) {
          console.info(`收到${result.messages.length}条微信消息, accountId=${accountId}`);
          // Fire-and-forget：不阻塞 monitorLoop 轮询。消息处理在后台上并发执行，
          // 后一条消息可在前一条 Agent 执行期间重入 handler，触发纠偏取代逻辑。
          // 串行 await 会使 monitorLoop 阻塞在 Agent 执行上，错过后续消息的轮询窗口。
          for (const message of result.messages) {
            void this.inboundProcessor.processInboundMessage(accountId, message)
              .catch((e) => console.error(`处理单条消息异常, accountId=${accountId}`, e));
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
