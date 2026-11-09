import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadUserConfig, saveUserConfig } from '../config/config-store';
import { CliError, EXIT } from '../util/exit-codes';
import { isUnder, realpathBoundary } from './sandbox';

export function listTrustedWorkspaces(): string[] {
  return (loadUserConfig().trustedWorkspaces ?? []).map((p) => path.resolve(p));
}

/**
 * 信任判定在 realpath 之后做：工作区内的软链目录指向外部时，
 * 纯字符串前缀比较会把外部目录也算成已信任。
 */
export function isWorkspaceTrusted(workspace: string | undefined): boolean {
  if (!workspace) return false;
  const resolved = realpathBoundary(workspace);
  return listTrustedWorkspaces().some((trusted) => isUnder(resolved, realpathBoundary(trusted)));
}

export function addTrustedWorkspace(workspace: string): void {
  const resolved = realpathBoundary(workspace);
  const current = listTrustedWorkspaces();
  if (current.some((trusted) => realpathBoundary(trusted) === resolved)) return;
  saveUserConfig({ trustedWorkspaces: [...current, resolved] });
}

export function workspaceExists(workspace: string): boolean {
  try {
    return fs.statSync(path.resolve(workspace)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 启动前确认工作区已信任。非交互（daemon / 打印模式）未信任直接退出，不静默信任。
 */
export async function ensureWorkspaceTrusted(workspace: string, canPrompt: boolean): Promise<void> {
  if (!workspaceExists(workspace)) {
    throw new CliError(`LOCAL 工作区不存在或不是目录: ${workspace}`);
  }
  if (isWorkspaceTrusted(workspace)) return;
  if (!canPrompt) {
    throw new CliError(
      `已拦截：工作区未信任\n  目录: ${workspace}\n  下一步: 先在交互终端运行 mao-agent --local 并输入 y，或把该路径写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces。`,
      EXIT.APPROVAL,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `此工作区尚未信任:\n  ${workspace}\n允许本机 Agent 在该目录执行命令与写文件？[y/N] `,
        resolve,
      );
    });
    if (!/^\s*y(es)?\s*$/i.test(answer)) {
      throw new CliError('已拒绝信任该工作区', EXIT.APPROVAL);
    }
    addTrustedWorkspace(workspace);
    process.stderr.write(`✔ 已信任 ${workspace}\n`);
  } finally {
    rl.close();
  }
}
