import { formatDateTime } from '../common/json.js';
import type { EcpConfig } from './ecp.config.js';
import { EcpClient } from './ecp.client.js';
import type { EcpSessionStore } from './ecp-session.repository.js';

const TICK_INTERVAL_MS = 60_000;
const RENEW_LEAD_MS = 30 * 60_000;
const BATCH_SIZE = 20;
/** RENEWING 超过该时长仍未收敛即视为进程崩溃遗留（单次 renew 只需秒级）。 */
const STALE_RENEWING_MS = 5 * 60_000;

export type EcpConfigSource = () => Promise<EcpConfig>;

export class EcpRenewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;

  constructor(
    private readonly sessions: EcpSessionStore & { decryptToken(enc: string): string | null },
    private readonly getConfig: EcpConfigSource,
    private readonly client: Pick<EcpClient, 'renewSession'> = new EcpClient(),
    private readonly encrypt: (token: string) => string,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const config = await this.getConfig();
      if (!config.enabled) return;
      await this.recoverStaleRenewing();
      const before = formatDateTime(new Date(Date.now() + RENEW_LEAD_MS));
      const due = await this.sessions.listDueForRenew(before, BATCH_SIZE);
      for (const row of due) {
        await this.renewOne(config, row);
      }
    } catch (e) {
      console.error('EcpRenewScheduler tick failed', e);
    } finally {
      this.running = false;
    }
  }

  /**
   * markRenewing 之后进程被 kill 会把行永久留在 RENEWING，而 listDueForRenew 只捞 ACTIVE，
   * 该用户的票到期后再也不会自动续期。每跳复位一次超时的中间态，让它重新进入续期队列。
   */
  private async recoverStaleRenewing(): Promise<void> {
    if (this.sessions.recoverStaleRenewing == null) return;
    const cutoff = formatDateTime(new Date(Date.now() - STALE_RENEWING_MS));
    const recovered = await this.sessions.recoverStaleRenewing(cutoff);
    if (recovered > 0) {
      console.warn(`ECP 续期中间态复位: ${recovered} 行 RENEWING 超过 ${STALE_RENEWING_MS / 60_000} 分钟未收敛，已置回 ACTIVE`);
    }
  }

  private async renewOne(config: EcpConfig, row: { id?: number; sessionTokenEnc: string }): Promise<void> {
    if (row.id == null) return;
    if (!await this.sessions.markRenewing(row.id)) return;
    const oldToken = this.sessions.decryptToken(row.sessionTokenEnc);
    if (!oldToken) {
      await this.sessions.markFailed(row.id);
      return;
    }
    try {
      const renewed = await this.client.renewSession(config, oldToken);
      await this.sessions.saveRenewed(row.id, this.encrypt(renewed.sessionToken), renewed.expiresAt);
    } catch (e) {
      console.warn(`ECP renew failed for session id=${row.id}`, e);
      // renew 丢响应或失败：旧票可能已作废，禁止用旧票重试
      await this.sessions.markFailed(row.id);
    }
  }
}
