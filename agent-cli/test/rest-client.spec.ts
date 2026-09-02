import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestClient } from '../src/rest/rest-client';
import { CliError, EXIT } from '../src/util/exit-codes';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const recorded: Recorded[] = [];
let responder: (req: Recorded, index: number) => Response | Promise<Response> | never;

function ok(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, message: 'ok', data, timestamp: Date.now() }), { status: 200 });
}

function httpErr(status: number, body: unknown = { code: 1, message: 'boom', timestamp: 0 }): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const savedEnv = {
  MAO_TOKEN: process.env.MAO_TOKEN,
  MAO_ADMIN_TOKEN: process.env.MAO_ADMIN_TOKEN,
  MAO_USER_TOKEN: process.env.MAO_USER_TOKEN,
};

beforeEach(() => {
  recorded.length = 0;
  responder = () => ok(null);
  delete process.env.MAO_TOKEN;
  delete process.env.MAO_ADMIN_TOKEN;
  delete process.env.MAO_USER_TOKEN;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const req: Recorded = {
      url: String(input),
      method: String(init.method),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined || init.body === null ? undefined : String(init.body),
    };
    const index = recorded.length;
    recorded.push(req);
    return responder(req, index);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function client(over: Partial<ConstructorParameters<typeof RestClient>[0]> = {}) {
  return new RestClient({
    baseUrl: 'https://mao.test/api',
    getToken: () => 'tok-1',
    timeoutMs: 500,
    ...over,
  });
}

describe('RestClient url + headers', () => {
  it('strips trailing slashes and joins the path', async () => {
    const c = client({ baseUrl: 'https://mao.test/api///' });
    responder = () => ok({ id: 1 });
    await c.getSession(7);
    expect(recorded[0].url).toBe('https://mao.test/api/v1/sessions/7');
  });

  it('drops empty query params', async () => {
    const c = client();
    responder = () => ok([]);
    await c.listAgents('');
    expect(recorded[0].url).toBe('https://mao.test/api/v1/agents');
    await c.listAgents('mao');
    expect(recorded[1].url).toBe('https://mao.test/api/v1/agents?keyword=mao');
  });

  it('attaches the bearer token and json content type', async () => {
    const c = client();
    responder = () => ok({ id: 5 });
    await c.createSession({ agentId: 1 } as never);
    expect(recorded[0].headers.Authorization).toBe('Bearer tok-1');
    expect(recorded[0].headers['Content-Type']).toBe('application/json');
    expect(recorded[0].body).toBe(JSON.stringify({ agentId: 1 }));
  });

  it('skips auth for login and refresh', async () => {
    const c = client();
    responder = () => ok({ accessToken: 'a' });
    await c.login('u', 'p');
    await c.refresh('r');
    expect(recorded[0].headers.Authorization).toBeUndefined();
    expect(recorded[1].headers.Authorization).toBeUndefined();
  });

  it('omits the header when there is no token', async () => {
    const c = client({ getToken: () => null });
    responder = () => ok(null);
    await c.me();
    expect(recorded[0].headers.Authorization).toBeUndefined();
  });
});

describe('RestClient result unwrapping', () => {
  it('returns data on code=0', async () => {
    const c = client();
    responder = () => ok({ id: 3, title: 't' });
    await expect(c.getSession(3)).resolves.toEqual({ id: 3, title: 't' });
  });

  it('raises a general error on a non-zero business code', async () => {
    const c = client();
    responder = () => ok(null, 40001);
    await expect(c.me()).rejects.toMatchObject({
      exitCode: EXIT.GENERAL,
      message: expect.stringContaining('code=40001'),
    });
  });

  it('normalizes both list shapes for sessions', async () => {
    const c = client();
    responder = (_r, i) => (i === 0 ? ok([{ id: 1 }]) : ok({ items: [{ id: 2 }] }));
    await expect(c.listSessions()).resolves.toEqual([{ id: 1 }]);
    await expect(c.listSessions()).resolves.toEqual([{ id: 2 }]);
  });

  it('tolerates an empty body', async () => {
    const c = client();
    responder = () => new Response('', { status: 200 });
    await expect(c.markRead(1)).resolves.toBeUndefined();
  });

  it('rejects a non-JSON 200 body', async () => {
    const c = client();
    responder = () => new Response('<html>nope</html>', { status: 200 });
    await expect(c.me()).rejects.toThrow(/不是合法 JSON/);
  });

  it('strips model secrets', async () => {
    const c = client();
    responder = () => ok([{ id: 1, name: 'm', apiKey: 'sk-secret' }]);
    const models = await c.listActiveModels();
    expect(models[0]).not.toHaveProperty('apiKey');
  });
});

describe('RestClient 401 handling', () => {
  it('retries once with the refreshed token', async () => {
    let token = 'stale';
    const onUnauthorized = vi.fn(async () => {
      token = 'fresh';
      return token;
    });
    const c = client({ getToken: () => token, onUnauthorized });
    responder = (_r, i) => (i === 0 ? httpErr(401) : ok({ id: 9 }));
    await expect(c.getSession(9)).resolves.toEqual({ id: 9 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(recorded[1].headers.Authorization).toBe('Bearer fresh');
  });

  it('gives up when the refresh returns the same token', async () => {
    const c = client({ onUnauthorized: async () => 'tok-1' });
    responder = () => httpErr(401);
    await expect(c.me()).rejects.toThrow(/未登录或登录已过期/);
    expect(recorded).toHaveLength(1);
  });

  it('does not loop when the retry is also 401', async () => {
    const c = client({ onUnauthorized: async () => 'other' });
    responder = () => httpErr(401);
    await expect(c.me()).rejects.toThrow(/未登录或登录已过期/);
    expect(recorded).toHaveLength(2);
  });

  it('mentions MAO_TOKEN when the token came from the environment', async () => {
    process.env.MAO_TOKEN = 'env-token';
    const c = client();
    responder = () => httpErr(401);
    await expect(c.me()).rejects.toThrow(/MAO_TOKEN/);
  });
});

describe('RestClient retries', () => {
  it('retries idempotent methods on 5xx', async () => {
    const c = client();
    responder = (_r, i) => (i < 2 ? httpErr(503) : ok({ id: 1 }));
    await expect(c.getSession(1)).resolves.toEqual({ id: 1 });
    expect(recorded).toHaveLength(3);
  });

  it('stops after two 5xx retries', async () => {
    const c = client();
    responder = () => httpErr(500);
    await expect(c.me()).rejects.toThrow(/HTTP 500/);
    expect(recorded).toHaveLength(3);
  });

  it('never retries POST', async () => {
    const c = client();
    responder = () => httpErr(503);
    await expect(c.createSession({} as never)).rejects.toThrow(/HTTP 503/);
    expect(recorded).toHaveLength(1);
  });

  it('retries idempotent methods on network failure', async () => {
    const c = client();
    responder = (_r, i) => {
      if (i < 2) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return ok([]);
    };
    await expect(c.listCloudProjects()).resolves.toEqual([]);
    expect(recorded).toHaveLength(3);
  });

  it('does not retry POST on network failure', async () => {
    const c = client();
    responder = () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await expect(c.login('u', 'p')).rejects.toThrow(/连接被拒绝/);
    expect(recorded).toHaveLength(1);
  });
});

describe('RestClient network error messages', () => {
  it('reports a timeout for AbortError', async () => {
    const c = client();
    responder = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(c.login('u', 'p')).rejects.toThrow(/请求超时（500ms）/);
  });

  it('reports DNS failures', async () => {
    const c = client();
    responder = () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND mao.test'), { cause: { code: 'ENOTFOUND' } });
    };
    await expect(c.login('u', 'p')).rejects.toThrow(/DNS 解析失败/);
  });

  it('falls back to a generic message with the cause appended', async () => {
    const c = client();
    responder = () => {
      throw Object.assign(new Error('socket hang up'), { cause: { message: 'TLS closed' } });
    };
    const err = await c.login('u', 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('socket hang up');
    expect((err as CliError).message).toContain('TLS closed');
  });

  it('surfaces a non-JSON error body verbatim', async () => {
    const c = client();
    responder = () => httpErr(502, 'bad gateway');
    await expect(c.login('u', 'p')).rejects.toThrow(/HTTP 502: bad gateway/);
  });
});

describe('RestClient debug hook', () => {
  it('logs the request and the response code', async () => {
    const debug = vi.fn();
    const c = client({ debug });
    responder = () => ok({ id: 1 });
    await c.getSession(1);
    expect(debug.mock.calls[0][0]).toBe('GET https://mao.test/api/v1/sessions/1');
    expect(debug.mock.calls[1][0]).toContain('-> 200');
  });
});
