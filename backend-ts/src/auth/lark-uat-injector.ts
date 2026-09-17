import { createHash } from 'node:crypto';
import { harnessLog } from '../harness/log.js';
import { EcpClient } from './ecp.client.js';
import type { EcpConfig } from './ecp.config.js';
import type { EcpCredentialsInjector } from './ecp-credentials-injector.js';

/** 与 lark-cli refreshAheadMs 对齐：进入过期前 5 分钟即视为需刷新。 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_TTL_MS = 7200 * 1000;

export interface LarkUatCredentials {
  uat: string;
  appId: string;
}

export interface LarkUatInjector {
  /** ECP 开启且可换 UAT 时返回凭证；否则 null（不抛错，不阻断 shell）。 */
  injectForUser(userId: number): Promise<LarkUatCredentials | null>;
}

export interface LarkUatInjectorDeps {
  ecpInjector: EcpCredentialsInjector;
  ecpClient: EcpClient;
  getConfig: () => Promise<EcpConfig>;
}

interface LarkUatCacheEntry {
  uat: string;
  /** 换票时所用飞书 App；与当前配置不一致时强制重取，避免 UAT/App 错配。 */
  appId: string;
  expiresAt: number;
  fingerprint: string;
}

function fingerprintEcpToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url').slice(0, 24);
}

export function createLarkUatInjector(deps: LarkUatInjectorDeps): LarkUatInjector {
  const cache = new Map<number, LarkUatCacheEntry>();
  const inflight = new Map<number, Promise<LarkUatCredentials | null>>();

  return {
    async injectForUser(userId: number): Promise<LarkUatCredentials | null> {
      const existing = inflight.get(userId);
      if (existing) return existing;
      const promise = load(userId).finally(() => inflight.delete(userId));
      inflight.set(userId, promise);
      return promise;
    },
  };

  async function load(userId: number): Promise<LarkUatCredentials | null> {
    try {
      const config = await deps.getConfig();
      if (!config.enabled || !config.larkAppId) return null;
      const ecpToken = await deps.ecpInjector.injectForUser(userId);
      if (!ecpToken) {
        cache.delete(userId);
        return null;
      }
      const fingerprint = fingerprintEcpToken(ecpToken);
      const hit = cache.get(userId);
      const now = Date.now();
      if (hit && hit.fingerprint === fingerprint && hit.appId === config.larkAppId && hit.expiresAt - REFRESH_AHEAD_MS > now) {
        return { uat: hit.uat, appId: hit.appId };
      }
      try {
        const token = await deps.ecpClient.getUserAccessToken(config, ecpToken);
        const expiresAt = token.expiresAt.getTime();
        const normalizedExpiresAt = Number.isFinite(expiresAt) && expiresAt > now
          ? expiresAt
          : now + DEFAULT_FALLBACK_TTL_MS;
        cache.set(userId, {
          uat: token.accessToken,
          appId: config.larkAppId,
          expiresAt: normalizedExpiresAt,
          fingerprint,
        });
        harnessLog('debug', `Lark UAT refreshed userId=${userId} expiresAt=${new Date(normalizedExpiresAt).toISOString()}`);
        return { uat: token.accessToken, appId: config.larkAppId };
      } catch (e) {
        harnessLog('warn', `Lark UAT refresh failed userId=${userId}: ${(e as Error).message}`);
        if (hit && hit.fingerprint === fingerprint && hit.appId === config.larkAppId && hit.expiresAt > now) {
          return { uat: hit.uat, appId: hit.appId };
        }
        cache.delete(userId);
        return null;
      }
    } catch (e) {
      harnessLog('warn', `Failed to inject Lark UAT for userId=${userId}: ${(e as Error).message}`);
      cache.delete(userId);
      return null;
    }
  }
}
