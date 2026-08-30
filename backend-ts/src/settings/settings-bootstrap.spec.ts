import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSettingsBootstrap } from './settings-bootstrap.js';
import type { SystemSetting } from './types.js';

function row(key: string, value: string | null): SystemSetting {
  return { id: 1, settingKey: key, value, category: '集成配置', editable: 1 };
}

describe('runSettingsBootstrap', () => {
  const findByKey = vi.fn<(key: string) => Promise<SystemSetting | null>>();
  const updateById = vi.fn<(s: SystemSetting) => Promise<void>>();
  const repo = { findByKey, updateById };

  beforeEach(() => {
    findByKey.mockReset();
    updateById.mockReset();
  });

  it('importsEnvValuesIntoNullRows', async () => {
    findByKey.mockResolvedValue(row('auth.ldap.url', null));
    await runSettingsBootstrap(repo, 'k', { LDAP_URL: 'ldap://h:389' });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(updateById.mock.calls[0][0].value).toBe('ldap://h:389');
  });

  it('skipsRowsAlreadySavedIncludingExplicitlyCleared', async () => {
    findByKey.mockImplementation(async (key: string) => (key === 'upload.storageMode' ? row('upload.storageMode', '') : null));
    await runSettingsBootstrap(repo, 'k', { UPLOAD_STORAGE_MODE: 'oss' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it('skipsWhenEnvMissing', async () => {
    findByKey.mockResolvedValue(row('auth.ldap.url', null));
    await runSettingsBootstrap(repo, 'k', {});
    expect(updateById).not.toHaveBeenCalled();
  });

  it('encryptsSecretValues', async () => {
    findByKey.mockResolvedValue(row('tools.tavilyApiKey', null));
    await runSettingsBootstrap(repo, 'k', { TAVILY_API_KEY: 'tvly-secret' });
    const stored = String(updateById.mock.calls[0][0].value);
    expect(stored).not.toBe('tvly-secret');
    expect(stored).toContain(':');
  });

  it('skipsSecretsWhenMasterKeyMissing', async () => {
    findByKey.mockResolvedValue(row('tools.tavilyApiKey', null));
    await runSettingsBootstrap(repo, '', { TAVILY_API_KEY: 'tvly-secret' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it('survivesIndividualImportFailure', async () => {
    findByKey.mockImplementation(async (key: string) => {
      if (key === 'auth.ldap.url') throw new Error('db down');
      return row(key, null);
    });
    await runSettingsBootstrap(repo, 'k', { LDAP_URL: 'ldap://h', UPLOAD_BASE_URL: 'https://f.example' });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(updateById.mock.calls[0][0].settingKey).toBe('upload.baseUrl');
  });
});
