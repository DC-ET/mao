import { createHash, randomInt } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { MysqlApiTokenRepository } from './openapi.repository.js';
import { normalizeScopes, OPENAPI_SCOPES, type ApiTokenView, type OpenApiScope } from './types.js';

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

/** scope 校验助手：run 端点只认显式持有 open:run 的 API Token 身份。 */
export function hasScope(scopes: string[] | null | undefined, scope: OpenApiScope): boolean {
  return scopes != null && normalizeScopes(scopes).includes(scope);
}

export class ApiTokenService {
  constructor(private readonly repo: MysqlApiTokenRepository) {}

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
        createdAt: formatDateTime(new Date()),
      },
    };
  }

  /**
   * 鉴权层降级解析：sha256 后按唯一键查行，未吊销且未过期才放行。
   * 解析成功刷 last_used_at（fire-and-forget）；失败路径零额外写。
   */
  async resolveByToken(plainToken: string): Promise<ApiTokenIdentity | null> {
    const row = await this.repo.findByHash(sha256Hex(plainToken));
    if (row?.id == null || row.userId == null) return null;
    if (row.revokedAt != null) return null;
    if (row.expiresAt != null && row.expiresAt <= formatDateTime(new Date())) return null;
    void this.repo.touchLastUsed(row.id);
    const scopes = normalizeScopes(this.safeParseScopes(row.scopes));
    return { userId: row.userId, scopes, tokenId: row.id };
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
      createdAt: row.createdAt ?? null,
    }));
  }

  async revoke(userId: number, id: number): Promise<void> {
    const revoked = await this.repo.revoke(id, userId);
    if (!revoked) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Token 不存在或已吊销');
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
