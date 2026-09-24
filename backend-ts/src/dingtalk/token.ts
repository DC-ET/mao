const NEW_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const OLD_TOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const REFRESH_SKEW_MS = 120_000;

interface CacheEntry { token: string; expiresAt: number; }

export class DingtalkTokenCache {
  private readonly fresh = new Map<string, CacheEntry>();
  private readonly legacy = new Map<string, CacheEntry>();
  private readonly pendingFresh = new Map<string, Promise<string>>();
  private readonly pendingLegacy = new Map<string, Promise<string>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  /** 发消息、下载、投放卡片：新版 accessToken。 */
  getAccessToken(clientId: string, clientSecret: string): Promise<string> {
    return this.get(this.fresh, this.pendingFresh, `${clientId}:${clientSecret}`, () => this.fetchNew(clientId, clientSecret));
  }

  /** 上传媒体、根据 unionId 查 userid：旧版 gettoken。与新版分开缓存。 */
  getLegacyToken(clientId: string, clientSecret: string): Promise<string> {
    return this.get(this.legacy, this.pendingLegacy, `${clientId}:${clientSecret}`, () => this.fetchOld(clientId, clientSecret));
  }

  private async get(cache: Map<string, CacheEntry>, pending: Map<string, Promise<string>>, key: string, load: () => Promise<CacheEntry>): Promise<string> {
    const hit = cache.get(key);
    if (hit != null && hit.expiresAt - this.now() > REFRESH_SKEW_MS) return hit.token;
    const existing = pending.get(key);
    if (existing != null) return existing;
    const task = load().then((entry) => {
      cache.set(key, entry);
      return entry.token;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  private async fetchNew(clientId: string, clientSecret: string): Promise<CacheEntry> {
    const response = await this.fetchImpl(NEW_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    });
    const body = await response.json() as { accessToken?: string; expireIn?: number; message?: string };
    if (!response.ok || body.accessToken == null || body.accessToken === '') {
      throw new Error(body.message || `钉钉 accessToken 获取失败: HTTP ${response.status}`);
    }
    return { token: body.accessToken, expiresAt: this.now() + Math.max(60, Number(body.expireIn ?? 7200)) * 1000 };
  }

  private async fetchOld(clientId: string, clientSecret: string): Promise<CacheEntry> {
    const url = `${OLD_TOKEN_URL}?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`;
    const response = await this.fetchImpl(url);
    const body = await response.json() as { access_token?: string; expires_in?: number; errmsg?: string; errcode?: number };
    if (!response.ok || body.errcode !== 0 || body.access_token == null || body.access_token === '') {
      throw new Error(body.errmsg || `钉钉 gettoken 获取失败: HTTP ${response.status}`);
    }
    return { token: body.access_token, expiresAt: this.now() + Math.max(60, Number(body.expires_in ?? 7200)) * 1000 };
  }
}
