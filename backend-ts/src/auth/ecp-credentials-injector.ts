import { harnessLog } from '../harness/log.js';
import { clearAccessOneEcpToken, writeAccessOneEcpToken } from '../harness/accessone-ecp-credentials.js';
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
      const home = resolveUserHome(userId);
      const row = await sessions.findByUserId(userId);
      if (!row) {
        if (home) await clearAccessOneEcpToken(home);
        return null;
      }
      if (row.renewStatus === 'FAILED') {
        harnessLog('warn', `Skip ECP_TOKEN inject: session renew failed, userId=${userId}；需重新 ECP 飞书登录`);
        if (home) await clearAccessOneEcpToken(home);
        return null;
      }
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        harnessLog('warn', `Skip ECP_TOKEN inject: session expired at ${row.expiresAt}, userId=${userId}；需重新 ECP 飞书登录`);
        if (home) await clearAccessOneEcpToken(home);
        return null;
      }
      const token = sessions.decryptToken(row.sessionTokenEnc);
      if (!token) {
        harnessLog('warn', `Skip ECP_TOKEN inject: session token decrypt failed, userId=${userId}`);
        if (home) await clearAccessOneEcpToken(home);
        return null;
      }
      if (home) await writeAccessOneEcpToken(home, token);
      return token;
    },
  };
}
