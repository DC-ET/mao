import { describe, expect, it } from 'vitest';
import { isSensitiveChildEnvKey, sanitizeInheritedEnv } from './sensitive-env.js';

describe('sensitive-env', () => {
  it('flags git tokens, askpass and backend secrets', () => {
    expect(isSensitiveChildEnvKey('GIT_TOKEN_git_example_com')).toBe(true);
    expect(isSensitiveChildEnvKey('GIT_ASKPASS')).toBe(true);
    expect(isSensitiveChildEnvKey('GIT_TERMINAL_PROMPT')).toBe(true);
    expect(isSensitiveChildEnvKey('APP_GIT_CREDENTIAL_SECRET')).toBe(true);
    expect(isSensitiveChildEnvKey('JWT_SECRET')).toBe(true);
    expect(isSensitiveChildEnvKey('MYSQL_URL')).toBe(true);
    expect(isSensitiveChildEnvKey('MYSQL_PASSWORD')).toBe(true);
    expect(isSensitiveChildEnvKey('APP_NOTIFICATION_WEBHOOK_SECRET')).toBe(true);
    expect(isSensitiveChildEnvKey('APP_MCP_SECRET')).toBe(true);
    expect(isSensitiveChildEnvKey('MAO_TOKEN')).toBe(true);
    expect(isSensitiveChildEnvKey('ECP_TOKEN')).toBe(true);
    expect(isSensitiveChildEnvKey('LARKSUITE_CLI_USER_ACCESS_TOKEN')).toBe(true);
  });

  it('keeps non-sensitive runtime keys', () => {
    expect(isSensitiveChildEnvKey('PATH')).toBe(false);
    expect(isSensitiveChildEnvKey('TERM')).toBe(false);
    expect(isSensitiveChildEnvKey('WORKSPACE_ROOT')).toBe(false);
    expect(isSensitiveChildEnvKey('LARKSUITE_CLI_APP_ID')).toBe(false);
    expect(isSensitiveChildEnvKey('NVM_DIR')).toBe(false);
  });

  it('strips sensitive keys and preserves the rest', () => {
    const out = sanitizeInheritedEnv({
      PATH: '/usr/bin',
      GIT_TOKEN_git_example_com: 'leak',
      APP_GIT_CREDENTIAL_SECRET: 'secret',
      MYSQL_URL: 'jdbc:…',
      MAO_TOKEN: 'stale',
      WORKSPACE_ROOT: '/data/ws',
    });
    expect(out).toEqual({ PATH: '/usr/bin', WORKSPACE_ROOT: '/data/ws' });
    expect(out.GIT_TOKEN_git_example_com).toBeUndefined();
    expect(out.APP_GIT_CREDENTIAL_SECRET).toBeUndefined();
  });
});
