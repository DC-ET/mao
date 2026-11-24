import { isShanghaiExpired } from './auth.service.js';
import type { UserCompanySsoToken } from './company-sso-token.repository.js';

export interface CompanySsoTokenInjector {
  /** 返回该用户仍有效的公司 SSO token；无票、过期或解密失败时返回 null。 */
  injectForUser(userId: number): Promise<string | null>;
}

export interface CompanySsoTokenLookup {
  findByUserId(userId: number): Promise<UserCompanySsoToken | null>;
  decryptToken(enc: string): string | null;
}

export function createCompanySsoTokenInjector(tokens: CompanySsoTokenLookup): CompanySsoTokenInjector {
  return {
    async injectForUser(userId: number): Promise<string | null> {
      const row = await tokens.findByUserId(userId);
      if (!row || isShanghaiExpired(row.expiresAt)) return null;
      return tokens.decryptToken(row.tokenEnc);
    },
  };
}
