import { loadAuth } from '../auth/auth-store';
import { remainingMs, formatRemaining, currentTokenSource } from '../auth/token';
import { getCliVersion } from '../util/version';

export function cmdStatus(opts: { baseUrl: string; cliToken?: string }): void {
  const src = currentTokenSource(opts.cliToken);
  const auth = loadAuth();
  const user = auth?.user;
  const name = user?.displayName || user?.username || (src.accessToken ? '(token)' : '未登录');
  const left = remainingMs(src.accessToken, auth?.savedAt, auth?.expiresIn);
  process.stdout.write(`mao-agent CLI ${getCliVersion()}\n`);
  process.stdout.write(`用户:        ${src.accessToken ? name : '未登录'}\n`);
  process.stdout.write(`baseUrl:     ${opts.baseUrl}\n`);
  process.stdout.write(`token 剩余:  ${src.accessToken ? formatRemaining(left) : '—'}\n`);
  process.stdout.write(`token 来源:  ${src.fromCli ? '--token' : src.fromEnv ? 'MAO_TOKEN' : src.accessToken ? '~/.mao/auth.json' : '无'}\n`);
  process.stdout.write(`执行模式:    CLOUD / LOCAL（--local 在本机执行工具）\n`);
  process.stdout.write(
    `说明:        --permission-level 在 CLOUD 下不产生审批、不限制写文件；` +
      `LOCAL 下按权限矩阵审批。工作区信任见 ~/.mao/agent-cli/config.json。\n`,
  );
}
