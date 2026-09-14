import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROFILE_ID = 'mao';

/**
 * 向 CLOUD 虚拟 HOME 写入 AccessOne ECP 票布局，供 bigdata-cli / access-cli 读取 Bearer。
 */
export async function writeAccessOneEcpToken(userHome: string, sessionToken: string): Promise<void> {
  const root = path.join(userHome, '.config', 'com.access.accessone');
  const profileDir = path.join(root, 'profiles', PROFILE_ID);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(root, 'profiles.json'),
    JSON.stringify({ activeProfileId: PROFILE_ID }),
    { encoding: 'utf8', mode: 0o600 },
  );
  await writeFile(
    path.join(profileDir, 'account.json'),
    JSON.stringify({ ecp_session_token: sessionToken }),
    { encoding: 'utf8', mode: 0o600 },
  );
}
