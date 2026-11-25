import { describe, expect, it } from 'vitest';
import { SEND_DOWNLOAD_TICKET_TTL_MS, SendDownloadTicketService } from './send-download-ticket.service.js';

describe('SendDownloadTicketService（2026-11-25 R6）', () => {
  const svc = new SendDownloadTicketService('unit-test-secret');

  it('issue / verify：绑定文件 id + 用户，24 小时有效', () => {
    const now = 1_700_000_000_000;
    const { ticket, expiresAt } = svc.issue('file-1', 7, now);
    expect(expiresAt).toBe(now + SEND_DOWNLOAD_TICKET_TTL_MS);
    expect(svc.verify(ticket, now)).toEqual({ fileId: 'file-1', userId: 7, expiresAt });
    // 过期即失效
    expect(svc.verify(ticket, expiresAt)).toBeNull();
    expect(svc.verify(ticket, expiresAt - 1)).not.toBeNull();
  });

  it('篡改载荷 / 签名 / 非法格式一律拒绝', () => {
    const { ticket } = svc.issue('file-1', 7);
    const [body, signature] = ticket.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ i: 'file-2', u: 7, e: Date.now() + 1000 })).toString('base64url');
    expect(svc.verify(`${forgedBody}.${signature}`)).toBeNull();
    expect(svc.verify(`${body}.AAAA`)).toBeNull();
    expect(svc.verify('nodot')).toBeNull();
    expect(svc.verify('.')).toBeNull();
    expect(svc.verify('')).toBeNull();
  });

  it('不同密钥无法互认（票据不是登录凭据）', () => {
    const other = new SendDownloadTicketService('another-secret');
    const { ticket } = svc.issue('file-1', 7);
    expect(other.verify(ticket)).toBeNull();
  });

  it('载荷字段非法（空 id / 非正整数用户 / 非整数过期）→ 拒绝', () => {
    const forge = (payload: unknown): string => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      // 用同签名算法（private，借 issue/verify 关系重建：直接测试 verify 对合法签名的非法载荷）
      const signed = new SendDownloadTicketService('unit-test-secret');
      // 通过反射调用私有 sign（TS 私有仅编译期）
      const signature = (signed as unknown as { sign(body: string): string }).sign(body);
      return `${body}.${signature}`;
    };
    expect(svc.verify(forge({ i: '', u: 7, e: Date.now() + 1000 }))).toBeNull();
    expect(svc.verify(forge({ i: 'f', u: 0, e: Date.now() + 1000 }))).toBeNull();
    expect(svc.verify(forge({ i: 'f', u: 7, e: 1.5 }))).toBeNull();
    expect(svc.verify(forge({ i: 'f', u: 7 }))).toBeNull();
  });
});
