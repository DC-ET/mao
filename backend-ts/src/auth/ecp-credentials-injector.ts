import { writeAccessOneEcpToken } from '../harness/accessone-ecp-credentials.js';
import type { MysqlEcpSessionRepository } from './ecp-session.repository.js';

export interface EcpCredentialsInjector {
  injectForUser(userId: number): Promise<void>;
}

export function createEcpCredentialsInjector(
  sessions: MysqlEcpSessionRepository,
  resolveUserHome: (userId: number) => string | null,
): EcpCredentialsInjector {
  return {
    async injectForUser(userId: number): Promise<void> {
      const home = resolveUserHome(userId);
      if (!home) return;
      const row = await sessions.findByUserId(userId);
      if (!row) return;
      if (row.renewStatus === 'FAILED' || new Date(row.expiresAt).getTime() <= Date.now()) return;
      const token = sessions.decryptToken(row.sessionTokenEnc);
      if (!token) return;
      await writeAccessOneEcpToken(home, token);
    },
  };
}
