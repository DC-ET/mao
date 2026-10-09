import { createHash, randomInt } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { MysqlApiTokenRepository } from './openapi.repository.js';
import { normalizeScopes, OPENAPI_SCOPES, type ApiTokenView, type OpenApiScope, type ApiToken } from './types.js';

export type { OpenApiScope };

/** 明文 token 前缀：鉴权层按此前缀分流到查库降级（jwt-hook.ts）。 */
export const API_TOKEN_PREFIX = 'mao_';
/** 明文随机段长度（base62）：mao_ + 48 位。 */
const TOKEN_RANDOM_LENGTH = 48;
/** 列表展示用明文前缀长度（mao_ + 8 位随机段）。 */
const TOKEN_PREFIX_LENGTH = 12;
/** 默认有效期（天），技术方案 §2.1 P1：90 天过期。 */
export const DEFAULT_TOKEN_TTL_DAYS = 90;
/** 每用户未吊销 token 数量上限（对齐触发器 20 / 订阅 10 的上限口径）。 */
export const MAX_TOKENS_PER_USER = 20;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[randomInt(BASE62.length)];
  }
  return out;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface IssuedToken {
  id: number;
  /** 明文仅此一次返回（落库只存 sha256）。 */
  plainToken: string;
  view: ApiTokenView;
}

export interface ApiTokenIdentity {
  userId: number;
  scopes: OpenApiScope[];
  tokenId: number;
}

export type TokenResolveResult =
  | { ok: true; userId: number; scopes: OpenApiScope[]; tokenId: number }
  | { ok: false; reason: 'not_found'; tokenPrefix: string }
  | { ok: false; reason: 'revoked' | 'expired' | 'auto_disabled'; tokenPrefix: string; tokenId: number; userId: number };

export interface TokenOutcomePolicy {
  enabled(): Promise<boolean>;
  threshold(): Promise<number>;
  notifyDisabled(input: { userId: number; tokenId: number; tokenName: string; failures: number; threshold: number }): Promise<void>;
}

/** scope 校验助手：run 端点只认显式持有 open:run 的 API Token 身份。 */
export function hasScope(scopes: string[] | null | undefined, scope: OpenApiScope): boolean {
  return scopes != null && normalizeScopes(scopes).includes(scope);
}

export class ApiTokenService {
  private outcomePolicy: TokenOutcomePolicy | null = null;

  constructor(private readonly repo: MysqlApiTokenRepository) {}

  setOutcomePolicy(policy: TokenOutcomePolicy): void {
    this.outcomePolicy = policy;
  }

  async issue(userId: number, name: string, scopes: string[]): Promise<IssuedToken> {
    const trimmedName = name?.trim() ?? '';
    if (trimmedName.length === 0 || trimmedName.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Token 名称需为 1~128 字符');
    }
    const validScopes = normalizeScopes(scopes);
    if (validScopes.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `scopes 至少包含一个有效值（${OPENAPI_SCOPES.join('/')}）`);
    }
    const active = await this.repo.countActive(userId);
    if (active >= MAX_TOKENS_PER_USER) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `每用户最多 ${MAX_TOKENS_PER_USER} 个未吊销 Token，请先吊销不用的 Token`);
    }
    const plainToken = `${API_TOKEN_PREFIX}${randomBase62(TOKEN_RANDOM_LENGTH)}`;
    const expiresAt = formatDateTime(new Date(Date.now() + DEFAULT_TOKEN_TTL_DAYS * 24 * 3600 * 1000));
    const id = await this.repo.insert({
      userId,
      name: trimmedName,
      tokenPrefix: plainToken.slice(0, TOKEN_PREFIX_LENGTH),
      tokenHash: sha256Hex(plainToken),
      scopes: JSON.stringify(validScopes),
      expiresAt,
    });
    return {
      id,
      plainToken,
      view: {
        id,
        name: trimmedName,
        tokenPrefix: plainToken.slice(0, TOKEN_PREFIX_LENGTH),
        scopes: validScopes,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        autoDisabledAt: null,
        autoDisableReason: null,
        logFullBody: false,
        createdAt: formatDateTime(new Date()),
      },
    };
  }

  /**
   * 鉴权层降级解析。失败区分查无 / 吊销 / 过期 / 自动停用，供调用流水落不同的行。
   * 只有放行才刷 last_used_at。
   */
  async resolveByToken(plainToken: string, opts?: { onReject?: (result: Extract<TokenResolveResult, { ok: false }>) => void }): Promise<TokenResolveResult> {
    const presentedPrefix = plainToken.slice(0, TOKEN_PREFIX_LENGTH);
    const row = await this.repo.findByHash(sha256Hex(plainToken));
    const reject = (result: Extract<TokenResolveResult, { ok: false }>): TokenResolveResult => {
      opts?.onReject?.(result);
      return result;
    };
    if (row?.id == null || row.userId == null) {
      return reject({ ok: false, reason: 'not_found', tokenPrefix: presentedPrefix });
    }
    const tokenPrefix = (row.tokenPrefix ?? presentedPrefix).slice(0, TOKEN_PREFIX_LENGTH);
    if (row.revokedAt != null) {
      return reject({ ok: false, reason: 'revoked', tokenPrefix, tokenId: row.id, userId: row.userId });
    }
    if (row.expiresAt != null && row.expiresAt <= formatDateTime(new Date())) {
      return reject({ ok: false, reason: 'expired', tokenPrefix, tokenId: row.id, userId: row.userId });
    }
    if (row.autoDisabledAt != null) {
      return reject({ ok: false, reason: 'auto_disabled', tokenPrefix, tokenId: row.id, userId: row.userId });
    }
    void this.repo.touchLastUsed(row.id);
    const scopes = normalizeScopes(this.safeParseScopes(row.scopes));
    return { ok: true, userId: row.userId, scopes, tokenId: row.id };
  }

  async list(userId: number): Promise<ApiTokenView[]> {
    const rows = await this.repo.listByUser(userId);
    return rows.map((row) => ({
      id: row.id!,
      name: row.name ?? '',
      tokenPrefix: row.tokenPrefix ?? '',
      scopes: normalizeScopes(this.safeParseScopes(row.scopes)),
      expiresAt: row.expiresAt ?? null,
      revokedAt: row.revokedAt ?? null,
      lastUsedAt: row.lastUsedAt ?? null,
      autoDisabledAt: row.autoDisabledAt ?? null,
      autoDisableReason: row.autoDisableReason ?? null,
      logFullBody: Number(row.logFullBody) === 1,
      createdAt: row.createdAt ?? null,
    }));
  }

  async revoke(userId: number, id: number): Promise<void> {
    const revoked = await this.repo.revoke(id, userId);
    if (!revoked) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Token 不存在或已吊销');
    }
  }

  async setLogFullBody(userId: number, id: number, enabled: boolean): Promise<void> {
    const updated = await this.repo.setLogFullBody(id, userId, enabled);
    if (!updated) throw new BusinessException(ErrorCode.PARAM_INVALID, 'Token 不存在或已吊销');
  }

  async reEnable(userId: number, id: number): Promise<void> {
    const updated = await this.repo.clearAutoDisable(id, userId);
    if (!updated) throw new BusinessException(ErrorCode.PARAM_INVALID, 'Token 不存在或已吊销');
  }

  findById(id: number): Promise<ApiToken | null> {
    return this.repo.findById(id);
  }

  /**
   * 连续失败自动停用。completed 清零；failed/rejected 在 1 小时窗口内累加；
   * cancelled 不动。总开关关闭时完全不计数。调用方负责排除 429、重放与鉴权层拒绝。
   */
  async recordTokenOutcome(tokenId: number, outcome: 'completed' | 'failed' | 'rejected' | 'cancelled'): Promise<void> {
    if (this.outcomePolicy == null) return;
    if (!(await this.outcomePolicy.enabled())) return;
    if (outcome === 'cancelled') return;
    if (outcome === 'completed') {
      await this.repo.resetFailures(tokenId);
      return;
    }
    const now = formatDateTime(new Date());
    const count = await this.repo.bumpFailure(tokenId, now);
    if (count == null) return;
    const threshold = await this.outcomePolicy.threshold();
    if (count < threshold) return;
    const disabled = await this.repo.casAutoDisable(tokenId, now, `连续失败 ${count} 次（阈值 ${threshold}/小时）`);
    if (!disabled) return;
    const token = await this.repo.findById(tokenId);
    if (token?.userId == null) return;
    try {
      await this.outcomePolicy.notifyDisabled({
        userId: token.userId,
        tokenId,
        tokenName: token.name ?? '',
        failures: count,
        threshold,
      });
    } catch (e) {
      console.warn(`[openapi] failed to notify token disabled, tokenId=${tokenId}: ${(e as Error).message}`);
    }
  }

  private safeParseScopes(value: string | null | undefined): unknown {
    try {
      return value == null ? [] : JSON.parse(value);
    } catch {
      return [];
    }
  }
}
