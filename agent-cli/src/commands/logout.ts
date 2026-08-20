import { clearAuth } from '../auth/auth-store';
import type { RestClient } from '../rest/rest-client';

export async function cmdLogout(rest: RestClient): Promise<void> {
  try {
    await rest.logout();
  } catch {
    // 服务端 logout 无副作用，本地必须清掉
  }
  clearAuth();
  process.stderr.write('已退出登录。\n');
}
