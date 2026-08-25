import type { FeishuHttpClient, FeishuHttpRequest, FeishuHttpResponse } from './types.js';

export function createFeishuHttpClient(timeoutMs = 30_000): FeishuHttpClient {
  return {
    async request(url: string, options: FeishuHttpRequest): Promise<FeishuHttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body as BodyInit | undefined, signal: controller.signal });
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) };
      } finally { clearTimeout(timer); }
    },
  };
}
