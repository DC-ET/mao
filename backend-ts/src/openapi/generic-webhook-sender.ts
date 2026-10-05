import type { OutboundEvent } from './types.js';

/** 出站投递显式超时（对齐 webhook-sender.ts 的 10s 做法）。 */
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface OutboundSendResult {
  success: boolean;
  retryable: boolean;
  httpStatus: number | null;
  error: string | null;
}

/**
 * 通用 HTTP 出站投递（P3）：HMAC 签名头与入站触发器同方案（决策 6），
 * 另带 X-Mao-Event。签名在发送时刻计算（每次重试刷新时间戳），
 * 签名对象为本函数序列化的字节（JSON.stringify），与请求体逐字节一致。
 */
export class GenericHttpWebhookSender {
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly now: () => number = () => Date.now()) {}

  async send(
    url: string,
    secret: string,
    event: OutboundEvent,
    payload: Record<string, unknown>,
    sign: (secret: string, timestamp: string, body: string) => string,
  ): Promise<OutboundSendResult> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Mao-Event': event,
          'X-Mao-Timestamp': timestamp,
          'X-Mao-Signature': sign(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return { success: true, retryable: false, httpStatus: response.status, error: null };
      }
      const retryable = response.status === 429 || response.status >= 500;
      return { success: false, retryable, httpStatus: response.status, error: `目标返回 ${response.status}` };
    } catch (e) {
      return { success: false, retryable: true, httpStatus: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
