import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { writeAccessOneEcpToken } from './accessone-ecp-credentials.js';

describe('writeAccessOneEcpToken', () => {
  it('writes profiles and account json', async () => {
    const home = useTmpDir('mao-ecp-home-');
    await writeAccessOneEcpToken(home, 'session-token-123');
    const profiles = JSON.parse(await readFile(join(home, '.config', 'com.access.accessone', 'profiles.json'), 'utf8'));
    const account = JSON.parse(await readFile(join(home, '.config', 'com.access.accessone', 'profiles', 'mao', 'account.json'), 'utf8'));
    expect(profiles.activeProfileId).toBe('mao');
    expect(account.ecp_session_token).toBe('session-token-123');
  });
});
