import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthError, RestClient } from './rest-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function okResponse(data: unknown) {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ code: 0, data }),
  } as unknown as Response;
}

function payloadResponse(status: number, payload: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('RestClient.upload', () => {
  it('以 multipart 提交：只带 Authorization，不手写 Content-Type', async () => {
    const fetchMock = vi.fn(async () => okResponse({ url: '/uploads/pic.png' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new RestClient('https://mao.example.com/api/v1', async () => 'token-1');
    const form = new FormData();
    form.append('file', new File(['x'], 'shot.png', { type: 'image/png' }));

    await expect(client.upload<{ url: string }>('/files/upload', form)).resolves.toEqual({ url: '/uploads/pic.png' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mao.example.com/api/v1/files/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1' });
  });

  it('401/1001 换新 token 后重试一次', async () => {
    let token = 'token-1';
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return payloadResponse(401, { code: 1001, message: 'unauthorized' });
      return okResponse({ absolutePath: '/tmp/a.pdf' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onUnauthorized = vi.fn(() => { token = 'token-2'; });
    const client = new RestClient('https://mao.example.com/api/v1', async () => token, onUnauthorized);

    const form = new FormData();
    form.append('file', new File(['y'], 'a.pdf', { type: 'application/pdf' }));
    await expect(client.upload<{ absolutePath: string }>('/files/upload-incoming', form))
      .resolves.toEqual({ absolutePath: '/tmp/a.pdf' });

    expect(onUnauthorized).toHaveBeenCalledWith('token-1', false);
    expect(calls).toBe(2);
    const secondInit = (fetchMock.mock.calls[1] as unknown[])[1] as RequestInit;
    expect(secondInit.headers).toEqual({ Authorization: 'Bearer token-2' });
  });

  it('业务失败抛 ApiError 并带后端文案', async () => {
    globalThis.fetch = vi.fn(async () => payloadResponse(200, { code: 4001, message: '文件大小超过限制: 10MB' })) as unknown as typeof fetch;
    const client = new RestClient('https://mao.example.com/api/v1', async () => 'token-1');
    const form = new FormData();
    form.append('file', new File(['z'], 'big.bin'));
    await expect(client.upload('/files/upload', form)).rejects.toBeInstanceOf(ApiError);
    await expect(client.upload('/files/upload', form)).rejects.toThrow('文件大小超过限制: 10MB');
  });

  it('身份在请求期间变化时抛 AuthError，不写入其他账号的附件', async () => {
    let identity: string | null = '7';
    globalThis.fetch = vi.fn(async () => {
      identity = '8';
      return okResponse({ url: '/uploads/pic.png' });
    }) as unknown as typeof fetch;
    const client = new RestClient('https://mao.example.com/api/v1', async () => 'token-1', undefined, () => identity);
    const form = new FormData();
    form.append('file', new File(['x'], 'shot.png', { type: 'image/png' }));
    await expect(client.upload('/files/upload', form)).rejects.toBeInstanceOf(AuthError);
  });
});
