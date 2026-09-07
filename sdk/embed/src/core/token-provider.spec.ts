import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenProvider } from './token-provider';

const providers: TokenProvider[] = [];
function provider(supplier = vi.fn(async () => 'synthetic-sso')) {
  const updates = vi.fn();
  const statuses = vi.fn();
  const token = new TokenProvider(supplier, { apiBase: 'https://mao.example.test/api/v1', checkUrl: 'https://app.example.test/check', onUpdate: updates, onStatus: statuses });
  providers.push(token);
  return { token, supplier, updates, statuses };
}
function success(value = 'mao', userId = 1) {
  return new Response(JSON.stringify({ code: 0, data: {
    accessToken: value, expiresIn: 300, expiresAt: Date.now() + 300000, refreshAfter: 100,
    user: { id: userId, displayName: 'Synthetic' },
  } }), { status: 200 });
}
afterEach(() => {
  providers.splice(0).forEach((token) => token.destroy());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SSO token lifecycle', () => {
  it('coalesces concurrent exchange and never persists the token', async () => {
    const fetcher = vi.fn(async () => success());
    vi.stubGlobal('fetch', fetcher);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const { token, supplier } = provider();
    expect(await Promise.all([token.get(), token.get()])).toEqual(['mao', 'mao']);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(supplier).toHaveBeenCalledOnce();
    expect(storage).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]).toBeDefined();
    const request = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((request.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(request.body as string)).toEqual({ checkUrl: 'https://app.example.test/check' });
  });

  it('retains a valid old token during 503 but refuses it after expiry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(success('old')).mockImplementation(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    expect(await token.get()).toBe('old');
    token.resume();
    expect(await token.get()).toBe('old');
    await vi.advanceTimersByTimeAsync(301000);
    await expect(token.get()).rejects.toThrow('认证服务');
    expect(fetcher).toHaveBeenCalledTimes(6); // first success + five failed attempts
  });

  it('only code 1402 re-reads the supplier once', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"code":1402}', { status: 401 })).mockResolvedValueOnce(success('fresh')));
    const { token, supplier } = provider();
    expect(await token.get()).toBe('fresh');
    expect(supplier).toHaveBeenCalledTimes(2);
  });

  it('stops when both supplied credentials are near expiry', async () => {
    const fetcher = vi.fn(async () => new Response('{"code":1402}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    await expect(token.get()).rejects.toThrow('登录凭据');
    await expect(token.get()).rejects.toThrow('登录凭据');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not repeatedly exchange an invalid credential', async () => {
    const fetcher = vi.fn(async () => new Response('{"code":1401}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    await expect(token.get()).rejects.toThrow('登录凭据');
    await expect(token.get()).rejects.toThrow('登录凭据');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rotates proactively and clears timers on destroy', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => success('rotated'));
    vi.stubGlobal('fetch', fetcher);
    const { token, updates } = provider();
    await token.get();
    await vi.advanceTimersByTimeAsync(101000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updates).toHaveBeenCalledTimes(2);
    token.destroy();
    await vi.advanceTimersByTimeAsync(500000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('manual resume and online events cannot bypass Retry-After', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    await expect(token.get()).rejects.toThrow();
    for (let i = 0; i < 3; i++) {
      token.resume();
      await expect(token.get()).rejects.toThrow();
      window.dispatchEvent(new Event('online'));
    }
    await vi.advanceTimersByTimeAsync(59999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('the final automatic failure preserves its longer server cooldown', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': ++calls === 5 ? '600' : '1' } }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    await expect(token.get()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetcher).toHaveBeenCalledTimes(5);
    token.resume();
    await expect(token.get()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500000);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetcher.mock.calls.length).toBeGreaterThan(5);
  });

  it('honors Retry-After and stops after five automatic attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }));
    vi.stubGlobal('fetch', fetcher);
    const { token } = provider();
    await expect(token.get()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100000);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await expect(token.get()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
