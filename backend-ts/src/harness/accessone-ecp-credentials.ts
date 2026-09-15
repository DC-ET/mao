import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROFILE_ID = 'mao';

function accessOneRoot(userHome: string): string {
  return path.join(userHome, '.config', 'com.access.accessone');
}

/**
 * 向 CLOUD 虚拟 HOME 写入 AccessOne ECP 票布局，供 bigdata-cli / access-cli 读取 Bearer。
 */
export async function writeAccessOneEcpToken(userHome: string, sessionToken: string): Promise<void> {
  const root = accessOneRoot(userHome);
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

/**
 * 清除 CLOUD 虚拟 HOME 里的 AccessOne ECP 布局。
 * 会话失效后必须清理，否则下游 CLI（bigdata-cli / access-cli）会读到已作废的旧票，
 * 把「无可用 ECP 会话」误报成「ECP 登录态已失效」，掩盖真实原因。
 */
export async function clearAccessOneEcpToken(userHome: string): Promise<void> {
  await rm(accessOneRoot(userHome), { recursive: true, force: true });
}
