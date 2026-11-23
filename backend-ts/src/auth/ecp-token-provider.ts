import { isShanghaiExpired } from './auth.service.js';
import type { UserEcpSession } from './ecp-session.repository.js';

/**
 * 取票结果。失败 reason 只用于日志与文案分流，绝不携带 token 片段等敏感内容。
 *
 * 判定口径与 `ecp-session.repository.ts` 的 `isUsableEcpSession` 保持一致
 * （无行 / renewStatus=FAILED / 已过期 / 解密失败 均视为不可用）。
 */
export type EcpTokenLookup =
  | { ok: true; token: string }
  | { ok: false; reason: 'disabled' | 'no_session' | 'renew_failed' | 'expired' | 'decrypt_failed' };

/** 只读会话仓储：Provider 只需要「查行 + 解密」两件事。 */
export interface EcpSessionReader {
  findByUserId(userId: number): Promise<UserEcpSession | null>;
  decryptToken(enc: string): string | null;
}

export interface EcpTokenProvider {
  /** 取该用户当前可用的 ECP 明文 token（结果结构化，不抛业务异常）。 */
  getUsableToken(userId: number): Promise<EcpTokenLookup>;
  /**
   * 票被轮换或作废后清掉该用户的缓存。
   * ECP renew 会吊销旧票、重新登录会换新票——缓存不跟着失效，就会在 TTL 窗口内继续拿死票发请求
   * （2026-11-23 会话 2736：renew 后 13s 的请求被网关判 INVALID_ECP_TOKEN）。
   */
  invalidate(userId: number): void;
}

export interface EcpTokenProviderOptions {
  /**
   * ECP 登录是否启用（系统配置 `auth.ecp.config` 的 enabled && appCode && baseUrl）。
   * 缺省视为启用（用于单测/无配置场景）；读取失败按「未启用」处理（fail-closed）。
   */
  isEnabled?: () => Promise<boolean>;
  /** 成功结果缓存时长（毫秒）。默认 60s：一轮对话内的多次 LLM 调用共享同一张票，避免重复查库解密。 */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const ENABLED_CACHE_TTL_MS = 60_000;

/**
 * ECP 票据提供器：按 userId 取「当前可用」的 ECP token。
 *
 * - 正结果缓存（默认 60s）：票在缓存期内被吊销的延迟可接受；
 * - 失败不缓存：用户刚完成 ECP 飞书登录后应立即生效；
 * - 缓存容量与用户规模同阶（数百），不做主动淘汰。
 */
export function createEcpTokenProvider(
  sessions: EcpSessionReader,
  options: EcpTokenProviderOptions = {},
): EcpTokenProvider {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const isEnabled = options.isEnabled ?? (async () => true);
  const tokenCache = new Map<number, { token: string; expiresAtMs: number }>();
  let enabledCache: { value: boolean; expiresAtMs: number } | null = null;

  async function enabled(): Promise<boolean> {
    const ts = now();
    if (enabledCache != null && enabledCache.expiresAtMs > ts) return enabledCache.value;
    let value: boolean;
    try {
      value = await isEnabled();
    } catch {
      value = false;
    }
    enabledCache = { value, expiresAtMs: ts + ENABLED_CACHE_TTL_MS };
    return value;
  }

  return {
    invalidate(userId: number): void {
      tokenCache.delete(userId);
    },

    async getUsableToken(userId: number): Promise<EcpTokenLookup> {
      if (!(await enabled())) return { ok: false, reason: 'disabled' };

      const ts = now();
      const cached = tokenCache.get(userId);
      if (cached != null && cached.expiresAtMs > ts) return { ok: true, token: cached.token };

      const row = await sessions.findByUserId(userId);
      if (row == null) {
        tokenCache.delete(userId);
        return { ok: false, reason: 'no_session' };
      }
      if (row.renewStatus === 'FAILED') {
        tokenCache.delete(userId);
        return { ok: false, reason: 'renew_failed' };
      }
      if (isShanghaiExpired(row.expiresAt, ts)) {
        tokenCache.delete(userId);
        return { ok: false, reason: 'expired' };
      }
      let token: string | null;
      try {
        token = sessions.decryptToken(row.sessionTokenEnc);
      } catch {
        token = null;
      }
      if (token == null || token === '') {
        tokenCache.delete(userId);
        return { ok: false, reason: 'decrypt_failed' };
      }
      tokenCache.set(userId, { token, expiresAtMs: ts + ttlMs });
      return { ok: true, token };
    },
  };
}
