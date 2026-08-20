import { saveAuth } from '../auth/auth-store';
import type { RestClient } from '../rest/rest-client';
import { CliError } from '../util/exit-codes';
import { promptHidden, promptVisible } from '../ui/hidden-prompt';

export async function cmdLogin(
  rest: RestClient,
  opts: { username?: string; password?: string },
): Promise<void> {
  const username = opts.username || (await promptVisible('用户名: '));
  const password = opts.password || (await promptHidden('密码: '));
  if (!username || !password) throw new CliError('用户名和密码不能为空');
  const vo = await rest.login(username, password);
  saveAuth({
    accessToken: vo.accessToken,
    refreshToken: vo.refreshToken,
    expiresIn: vo.expiresIn,
    user: vo.user,
  });
  const name = vo.user?.displayName || vo.user?.username || username;
  process.stderr.write(`✔ 已登录 ${name}\n之后可直接运行 mao-agent。\n`);
}
