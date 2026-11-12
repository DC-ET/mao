import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { normalizeAndValidateGitDomain } from '../common/git-domain.js';
import { decryptAesCbc, encryptAesCbc } from '../crypto/aes-cbc.js';
import { harnessLog } from '../harness/log.js';
import type { Db } from '../db/db.js';

/** 系统默认 Git 凭据行（技术方案 2026-11-12 §5.2）。 */
export interface SystemGitCredential {
  id?: number;
  domain: string;
  accessToken: string;
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * 系统默认 Git 凭据服务（技术方案 2026-11-12 §5.3）：结构对齐 GitCredentialService，
 * 但不挂用户——域全局唯一（uk_system_git_domain）。表空 = 功能未启用（解析合并 no-op）。
 */
export class SystemGitCredentialService {
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
  ) {}

  /** 全量列表（供管理面板；token 由路由层脱敏，本方法不解密）。 */
  async list(): Promise<SystemGitCredential[]> {
    return this.db.query<SystemGitCredential>(
      'SELECT * FROM system_git_credential ORDER BY domain ASC',
      [],
    );
  }

  async create(domain: string, accessToken: string, description?: string | null): Promise<SystemGitCredential> {
    // 域名规范化与校验口径统一收敛到 common/git-domain（与用户凭据 / Agent 白名单同口径）
    const normalizedDomain = normalizeAndValidateGitDomain(domain);
    if (!hasText(accessToken)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Access Token 不能为空');
    }
    if (await this.findByDomain(normalizedDomain)) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE);
    }
    const row: SystemGitCredential = {
      domain: normalizedDomain,
      accessToken: encryptAesCbc(accessToken.trim(), this.secretKey),
      description: description != null && description.trim() !== '' ? description.trim() : null,
    };
    const id = await this.db.insert('system_git_credential', row);
    row.id = id;
    return row;
  }

  /** Token 留空（null/undefined/空串）不修改；备注缺省/null 不改、空串清空（与用户凭据 update 口径一致）。 */
  async update(id: number, accessToken?: string | null, description?: string | null): Promise<SystemGitCredential> {
    const credential = await this.getById(id);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    if (hasText(accessToken ?? undefined)) {
      credential.accessToken = encryptAesCbc(accessToken!.trim(), this.secretKey);
    }
    if (description != null) {
      credential.description = description.trim() === '' ? null : description.trim();
    }
    await this.db.updateById('system_git_credential', id, {
      accessToken: credential.accessToken,
      description: credential.description,
    });
    return credential;
  }

  async delete(id: number): Promise<void> {
    const credential = await this.getById(id);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    await this.db.execute('DELETE FROM system_git_credential WHERE id = ?', [id]);
  }

  /** 全量解密（lenient 无白名单路径）。解密失败的行跳过 + warn（只记域名），不拖垮整表。 */
  async getTokenMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const c of await this.list()) {
      try {
        map.set(c.domain, decryptAesCbc(c.accessToken, this.secretKey));
      } catch (e) {
        harnessLog('warn', `[git-scope] default credential decrypt failed, skipped domain=${c.domain}: ${(e as Error).message}`);
      }
    }
    return map;
  }

  /**
   * 只解密指定域名集合内的 token（Agent 白名单过滤后调用）。
   * domains 为空时直接返回空 Map（防 IN () 非法 SQL，与 getTokenMapByUserFiltered 同口径）。
   * domains 必须是规范化后的 host（与 system_git_credential.domain 存储口径一致）。
   */
  async getTokenMapFiltered(domains: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (domains.length === 0) {
      return map;
    }
    const placeholders = domains.map(() => '?').join(', ');
    const rows = await this.db.query<SystemGitCredential>(
      `SELECT * FROM system_git_credential WHERE domain IN (${placeholders})`,
      domains,
    );
    for (const c of rows) {
      try {
        map.set(c.domain, decryptAesCbc(c.accessToken, this.secretKey));
      } catch (e) {
        harnessLog('warn', `[git-scope] default credential decrypt failed, skipped domain=${c.domain}: ${(e as Error).message}`);
      }
    }
    return map;
  }

  /** 全站域枚举（系统默认侧）：供 /v1/admin/git-domains 与用户端「系统默认」灰行。 */
  async listDomains(): Promise<string[]> {
    const rows = await this.db.query<{ domain: string }>(
      'SELECT domain FROM system_git_credential ORDER BY domain ASC',
      [],
    );
    return rows.map((r) => r.domain);
  }

  private async getById(id: number): Promise<SystemGitCredential | null> {
    return this.db.queryOne<SystemGitCredential>('SELECT * FROM system_git_credential WHERE id = ?', [id]);
  }

  private async findByDomain(domain: string): Promise<SystemGitCredential | null> {
    return this.db.queryOne<SystemGitCredential>('SELECT * FROM system_git_credential WHERE domain = ?', [domain]);
  }
}
