import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { normalizeAndValidateGitDomain } from '../common/git-domain.js';
import { decryptAesCbc, encryptAesCbc } from '../crypto/aes-cbc.js';
import type { Db } from '../db/db.js';

export interface GitCredential {
  id?: number;
  userId: number;
  domain: string;
  accessToken: string;
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function assertGitCredentialSecret(secret: string | null | undefined): void {
  if (secret != null && secret.trim() !== '') return;
  console.error('============================================================');
  console.error('APP_GIT_CREDENTIAL_SECRET is not configured.');
  console.error('Set environment variable APP_GIT_CREDENTIAL_SECRET to a random');
  console.error('32-byte secret before starting the application.');
  console.error('Example: export APP_GIT_CREDENTIAL_SECRET=$(openssl rand -base64 32)');
  console.error('============================================================');
  throw new Error(
    'app.git-credential.secret-key is not configured. Set environment variable APP_GIT_CREDENTIAL_SECRET.',
  );
}

export class GitCredentialService {
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
  ) {}

  async listByUserId(userId: number): Promise<GitCredential[]> {
    return this.db.query<GitCredential>(
      'SELECT * FROM user_git_credential WHERE user_id = ? ORDER BY updated_at DESC',
      [userId],
    );
  }

  /** 管理端：删除指定用户的凭证（不校验归属，调用方负责权限）。 */
  async deleteByAdmin(id: number, userId: number): Promise<void> {
    const credential = await this.db.queryOne<GitCredential>(
      'SELECT * FROM user_git_credential WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    await this.db.execute('DELETE FROM user_git_credential WHERE id = ?', [id]);
  }

  async getByIdAndUserId(id: number, userId: number): Promise<GitCredential | null> {
    return this.db.queryOne<GitCredential>(
      'SELECT * FROM user_git_credential WHERE id = ? AND user_id = ?',
      [id, userId],
    );
  }

  async getTokenMapByUser(userId: number | null | undefined): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userId == null) {
      return map;
    }
    for (const c of await this.listByUserId(userId)) {
      map.set(c.domain, decryptAesCbc(c.accessToken, this.secretKey));
    }
    return map;
  }

  /**
   * 只解密指定域名集合内的 token（Agent 白名单过滤后调用，技术方案 2026-11-06 D3）：
   * SQL 侧 WHERE domain IN (...)，避免把用户全部 token 无谓解密。
   * domains 为空时直接返回空 Map（方法作为 API 的边界保护，防 IN () 非法 SQL）。
   * 注意：domains 必须是规范化后的 host（与 user_git_credential.domain 存储口径一致）。
   */
  async getTokenMapByUserFiltered(
    userId: number | null | undefined,
    domains: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userId == null || domains.length === 0) {
      return map;
    }
    const placeholders = domains.map(() => '?').join(', ');
    const rows = await this.db.query<GitCredential>(
      `SELECT * FROM user_git_credential WHERE user_id = ? AND domain IN (${placeholders})`,
      [userId, ...domains],
    );
    for (const c of rows) {
      map.set(c.domain, decryptAesCbc(c.accessToken, this.secretKey));
    }
    return map;
  }

  async create(userId: number, domain: string, accessToken: string, description?: string | null): Promise<GitCredential> {
    // 规范化与校验口径统一收敛到 common/git-domain（Agent 白名单校验共用，见 §4.2-1）
    const normalizedDomain = normalizeAndValidateGitDomain(domain);
    if (!hasText(accessToken)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Access Token 不能为空');
    }
    if (await this.findByUserAndDomain(userId, normalizedDomain)) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE);
    }
    const row: GitCredential = {
      userId,
      domain: normalizedDomain,
      accessToken: encryptAesCbc(accessToken.trim(), this.secretKey),
      description: description != null ? description.trim() : null,
    };
    const id = await this.db.insert('user_git_credential', row);
    row.id = id;
    return row;
  }

  async update(userId: number, id: number, accessToken?: string | null, description?: string | null): Promise<GitCredential> {
    const credential = await this.getByIdAndUserId(id, userId);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    if (hasText(accessToken ?? undefined)) {
      credential.accessToken = encryptAesCbc(accessToken!.trim(), this.secretKey);
    }
    if (description != null) {
      credential.description = description.trim() === '' ? null : description.trim();
    }
    await this.db.updateById('user_git_credential', id, {
      accessToken: credential.accessToken,
      description: credential.description,
    });
    return credential;
  }

  async delete(userId: number, id: number): Promise<void> {
    const credential = await this.getByIdAndUserId(id, userId);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    await this.db.execute('DELETE FROM user_git_credential WHERE id = ?', [id]);
  }

  maskToken(token: string | null | undefined): string {
    if (!hasText(token ?? undefined)) {
      return '****';
    }
    if (token!.length <= 8) {
      return '****';
    }
    return `${token!.slice(0, 4)}****${token!.slice(-4)}`;
  }

  static envVarNameForDomain(domain: string): string {
    return `GIT_TOKEN_${domain.replace(/[.-]/g, '_')}`;
  }

  private async findByUserAndDomain(userId: number, domain: string): Promise<GitCredential | null> {
    return this.db.queryOne<GitCredential>(
      'SELECT * FROM user_git_credential WHERE user_id = ? AND domain = ?',
      [userId, domain],
    );
  }
}
