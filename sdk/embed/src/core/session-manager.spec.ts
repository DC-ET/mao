import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager';
import { RestClient, ApiError } from './rest-client';
import type { EmbedSessionVO } from '@mao/contracts';

// 最小 localStorage stub
class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const sessions = new Map<number, EmbedSessionVO>();

function fakeRest(): RestClient {
  const rest = Object.create(RestClient.prototype) as RestClient;
  (rest as unknown as { request: <T>(method: string, path: string) => Promise<T> }).request =
    async <T,>(method: string, path: string): Promise<T> => {
      if (method === 'GET' && path.startsWith('/sessions/')) {
        const id = Number(path.split('/')[2]);
        const s = sessions.get(id);
        if (!s) throw new ApiError(404, 'not found');
        return s as T;
      }
      if (method === 'POST' && path === '/sessions') {
        const id = sessions.size + 100;
        const s = { id, title: '网页助手' } as EmbedSessionVO;
        sessions.set(id, s);
        return s as T;
      }
      throw new ApiError(500, 'unexpected');
    };
  return rest;
}

describe('SessionManager', () => {
  const originalWindow = globalThis.window;
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    sessions.clear();
    (globalThis as Record<string, unknown>).window = { localStorage: storage };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = originalWindow;
  });

  it('首次 resolve 创建会话并写入 localStorage', async () => {
    const mgr = new SessionManager({ rest: fakeRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(100);
    expect(storage.getItem('mao_embed_session_3')).toBe('100');
  });

  it('有记录且会话存在时复用', async () => {
    sessions.set(42, { id: 42, title: 'T' } as EmbedSessionVO);
    storage.setItem('mao_embed_session_3', '42');
    const mgr = new SessionManager({ rest: fakeRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(42);
  });

  it('会话 404（被删除）时清除并新建', async () => {
    storage.setItem('mao_embed_session_3', '999');
    const mgr = new SessionManager({ rest: fakeRest(), agentId: 3 });
    const s = await mgr.resolveSession();
    expect(s.id).toBe(100);
    expect(storage.getItem('mao_embed_session_3')).toBe('100');
  });

  it('网络异常向上抛出不丢记录', async () => {
    storage.setItem('mao_embed_session_3', '7');
    const rest = Object.create(RestClient.prototype) as RestClient;
    (rest as unknown as { request: () => Promise<never> }).request = async () => {
      throw new ApiError(503, 'down');
    };
    const mgr = new SessionManager({ rest, agentId: 3 });
    await expect(mgr.resolveSession()).rejects.toThrow('down');
    expect(storage.getItem('mao_embed_session_3')).toBe('7');
  });

  it('startNewSession 替换记录', async () => {
    const mgr = new SessionManager({ rest: fakeRest(), agentId: 3 });
    const first = await mgr.resolveSession();
    const second = await mgr.startNewSession();
    expect(second.id).not.toBe(first.id);
    expect(storage.getItem('mao_embed_session_3')).toBe(String(second.id));
  });
});
