import readline from 'node:readline';
import { saveAuth } from '../auth/auth-store';
import type { RestClient } from '../rest/rest-client';
import { CliError } from '../util/exit-codes';

export async function cmdLogin(
  rest: RestClient,
  opts: { username?: string; password?: string },
): Promise<void> {
  const username = opts.username || (await prompt('用户名: '));
  const password = opts.password || (await prompt('密码: ', true));
  if (!username || !password) throw new CliError('用户名和密码不能为空');
  const vo = await rest.login(username, password);
  saveAuth({
    accessToken: vo.accessToken,
    refreshToken: vo.refreshToken,
    expiresIn: vo.expiresIn,
    user: vo.user,
  });
  const name = vo.user?.displayName || vo.user?.username || username;
  process.stderr.write(`✔ 已登录 ${name}\n`);
}

function prompt(query: string, _hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
