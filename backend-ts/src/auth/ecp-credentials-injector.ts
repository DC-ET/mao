import { writeAccessOneEcpToken } from '../harness/accessone-ecp-credentials.js';
import type { MysqlEcpSessionRepository } from './ecp-session.repository.js';

export interface EcpCredentialsInjector {
  /** 写入 AccessOne 布局；若用户有有效 ECP 票则返回明文 token 供 shell 注入 `ECP_TOKEN`。 */
  injectForUser(userId: number): Promise<string | null>;
}

export function createEcpCredentialsInjector(
  sessions: MysqlEcpSessionRepository,
  resolveUserHome: (userId: number) => string | null,
): EcpCredentialsInjector {
  return {
    async injectForUser(userId: number): Promise<string | null> {
      const row = await sessions.findByUserId(userId);
      if (!row) return null;
      if (row.renewStatus === 'FAILED' || new Date(row.expiresAt).getTime() <= Date.now()) return null;
      const token = sessions.decryptToken(row.sessionTokenEnc);
      if (!token) return null;
      const home = resolveUserHome(userId);
      if (home) await writeAccessOneEcpToken(home, token);
      return token;
    },
  };
}
