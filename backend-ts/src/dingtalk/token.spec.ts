import { describe, expect, it, vi } from 'vitest';
import { DingtalkTokenCache } from './token.js';

describe('DingtalkTokenCache', () => {
  it('keeps the new access token and the legacy gettoken in separate caches', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('oapi.dingtalk.com')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'old-token', expires_in: 7200 }));
      }
      return new Response(JSON.stringify({ accessToken: 'new-token', expireIn: 7200 }));
    });
    const cache = new DingtalkTokenCache(fetchImpl as typeof fetch, () => 1_000);
    await expect(cache.getAccessToken('app', 'secret')).resolves.toBe('new-token');
    await expect(cache.getLegacyToken('app', 'secret')).resolves.toBe('old-token');
    await cache.getAccessToken('app', 'secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
