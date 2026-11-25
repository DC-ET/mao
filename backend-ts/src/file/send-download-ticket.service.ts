import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 发送快照的短时下载票据（技术方案 2026-11-25-send-file-1gb R6）。
 *
 * 1GB 下载不能再把整份字节收进页面内存走 Blob，桌面 / Web 都要「直接导航到下载地址」；
 * 而 JWT 不能出现在 URL 里（历史记录、下载列表、Nginx 访问日志，Electron 下还会被
 * `shell.openExternal` 交给系统浏览器）。改为：
 *
 * - `POST /v1/files/send-download-ticket` 用 JWT 换一张无状态 HMAC 票据；
 * - `GET /v1/files/send-download?id=..&ticket=..` 凭票据下载，不需要 JWT。
 *
 * 票据绑定 `文件 id + 授权用户 id`，有效期 12 小时（R7 的 Range 续传会原样重用同一个
 * URL，60 秒票据续传必然失败）。票据泄露的影响面只有这一个文件、最长 12 小时，
 * 不能换取其它资源，也不是登录凭证。不入库、不落盘。
 */
export const SEND_DOWNLOAD_TICKET_TTL_MS = 12 * 60 * 60 * 1000;

export interface SendDownloadTicketClaims {
  fileId: string;
  userId: number;
  /** epoch 毫秒。 */
  expiresAt: number;
}

interface TicketPayload {
  i: string;
  u: number;
  e: number;
}

export class SendDownloadTicketService {
  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = SEND_DOWNLOAD_TICKET_TTL_MS,
  ) {}

  issue(fileId: string, userId: number, now = Date.now()): { ticket: string; expiresAt: number } {
    const expiresAt = now + this.ttlMs;
    const payload: TicketPayload = { i: fileId, u: userId, e: expiresAt };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { ticket: `${body}.${this.sign(body)}`, expiresAt };
  }

  /** 校验签名与有效期；任何一项不满足返回 null（调用方统一按未授权处理）。 */
  verify(ticket: string, now = Date.now()): SendDownloadTicketClaims | null {
    const dot = ticket.indexOf('.');
    if (dot <= 0 || dot === ticket.length - 1) return null;
    const body = ticket.slice(0, dot);
    const signature = ticket.slice(dot + 1);
    const expected = this.sign(body);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let payload: TicketPayload;
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TicketPayload>;
      if (typeof parsed.i !== 'string' || parsed.i === '') return null;
      if (!Number.isSafeInteger(parsed.u) || (parsed.u as number) <= 0) return null;
      if (!Number.isSafeInteger(parsed.e)) return null;
      payload = { i: parsed.i, u: parsed.u as number, e: parsed.e as number };
    } catch {
      return null;
    }
    if (payload.e <= now) return null;
    return { fileId: payload.i, userId: payload.u, expiresAt: payload.e };
  }

  private sign(body: string): string {
    return createHmac('sha256', Buffer.from(this.secret, 'utf8')).update(body).digest('base64url');
  }
}
