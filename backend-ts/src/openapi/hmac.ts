import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** 出站/入站共用的 HMAC 签名方案（技术方案决策 6）：`sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${body}`))>`。 */
export const SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function hmacSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** 时间戳容差校验（±300 秒，决策 14：窗口内重放明确接受，不做 nonce 去重）。 */
export function isTimestampFresh(timestamp: string, nowMs: number = Date.now(), toleranceSeconds = SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts * 1000) <= toleranceSeconds * 1000;
}

/** 等长安全比较，防时序侧信道；格式非法直接 false。 */
export function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received ?? '', 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** 综合验签：时间戳容差 + 签名等时比较。 */
export function verifyHmacSignature(
  secret: string,
  timestamp: string | undefined | null,
  signature: string | undefined | null,
  rawBody: string,
  nowMs: number = Date.now(),
): boolean {
  if (timestamp == null || signature == null) return false;
  if (!isTimestampFresh(timestamp, nowMs)) return false;
  return signaturesMatch(hmacSignature(secret, timestamp, rawBody), signature);
}

/** 32 字节随机 secret（hex 64 字符），触发器/订阅共用。 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** 16 字节随机 pathToken（hex 32 字符，128bit），防枚举。 */
export function generatePathToken(): string {
  return randomBytes(16).toString('hex');
}
