import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type { Db } from '../db/db.js';
import { formatDateTime } from '../common/json.js';

export interface UserCompanySsoToken {
  id?: number;
  userId: number;
  tokenEnc: string;
  expiresAt: string;
}

/** 换票成功后覆盖写入该用户最近一次公司 SSO token。 */
export interface CompanySsoTokenWriter {
  save(userId: number, token: string, expiresAt: Date): Promise<void>;
}

export class MysqlCompanySsoTokenRepository implements CompanySsoTokenWriter {
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
  ) {}

  encryptToken(token: string): string {
    return encryptAesGcmNonNull(token, this.secretKey, '公司 SSO token 加密失败');
  }

  decryptToken(enc: string): string | null {
    try {
      const token = decryptAesGcm(enc, this.secretKey, '公司 SSO token 解密失败');
      return token === '' ? null : token;
    } catch {
      return null;
    }
  }

  async findByUserId(userId: number): Promise<UserCompanySsoToken | null> {
    return this.db.queryOne<UserCompanySsoToken>(
      'SELECT * FROM user_company_sso_token WHERE user_id = ?',
      [userId],
    );
  }

  async save(userId: number, token: string, expiresAt: Date): Promise<void> {
    const tokenEnc = this.encryptToken(token);
    await this.db.execute(
      `INSERT INTO user_company_sso_token (user_id, token_enc, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE token_enc = VALUES(token_enc), expires_at = VALUES(expires_at)`,
      [userId, tokenEnc, formatDateTime(expiresAt)],
    );
  }
}
