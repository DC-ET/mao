import { describe, expect, it } from 'vitest';
import { hmacSignature, isTimestampFresh, generatePathToken, generateWebhookSecret, signaturesMatch, verifyHmacSignature } from './hmac.js';

describe('hmac 签名方案（入站/出站共用，决策 6）', () => {
  it('签名格式 sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${body}`))>', () => {
    const signature = hmacSignature('secret', '1700000000', '{"a":1}');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('同参数签名可被 verifyHmacSignature 通过', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"event":"ci.failed"}';
    const signature = hmacSignature('s3cret', timestamp, body);
    expect(verifyHmacSignature('s3cret', timestamp, signature, body)).toBe(true);
  });

  it('签名错误 / secret 错误 / body 被篡改一律拒绝', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(verifyHmacSignature('s3cret', timestamp, 'sha256=deadbeef', '{}')).toBe(false);
    expect(verifyHmacSignature('wrong', timestamp, hmacSignature('s3cret', timestamp, '{}'), '{}')).toBe(false);
    expect(verifyHmacSignature('s3cret', timestamp, hmacSignature('s3cret', timestamp, '{}'), '{"tampered":true}')).toBe(false);
  });

  it('缺失头 / 非法时间戳拒绝', () => {
    expect(verifyHmacSignature('s3cret', null, 'sha256=aa', '{}')).toBe(false);
    expect(verifyHmacSignature('s3cret', undefined, 'sha256=aa', '{}')).toBe(false);
    expect(verifyHmacSignature('s3cret', 'not-a-number', hmacSignature('s3cret', '1', '{}'), '{}')).toBe(false);
  });

  it('时间戳容差 ±300 秒：窗口内接受、超窗拒绝', () => {
    const now = Date.now();
    expect(isTimestampFresh(String(Math.floor(now / 1000)), now)).toBe(true);
    expect(isTimestampFresh(String(Math.floor((now - 299_000) / 1000)), now)).toBe(true);
    expect(isTimestampFresh(String(Math.floor((now - 301_000) / 1000)), now)).toBe(false);
    expect(isTimestampFresh(String(Math.floor((now + 301_000) / 1000)), now)).toBe(false);
  });

  it('signaturesMatch 等时比较：长度不同直接 false', () => {
    expect(signaturesMatch('sha256=aa', 'sha256=aaa')).toBe(false);
    expect(signaturesMatch('', '')).toBe(false);
  });

  it('pathToken 128bit（32 hex 字符）、secret 64 hex 字符且随机', () => {
    const a = generatePathToken();
    const b = generatePathToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});
