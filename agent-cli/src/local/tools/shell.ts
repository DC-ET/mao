import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatRuntimeDisplay, requireBash, resolveShellOutputDir, ensureDir } from '../paths';
import { resolveSandboxPath } from '../sandbox';

const requireFromHere = createRequire(__filename);

export interface LocalShellRuntime {
  handle: (
    args: Record<string, unknown>,
    ctx: {
      conversationId: number;
      workspace?: string;
      needApproval: boolean;
      approve?: (description: string) => Promise<boolean>;
    },
  ) => Promise<Record<string, unknown>>;
  closeAll: () => void;
}

/**
 * 只解析包内 vendor/localShell.cjs。历史实现还会回退到 process.cwd() 下的
 * desktop/electron/localShell.cjs —— 在任意第三方仓库里启动 CLI 就会 require 该仓库的文件。
 */
function resolveLocalShellPath(): string {
  const vendored = path.resolve(__dirname, '../../../vendor/localShell.cjs');
  if (!fs.existsSync(vendored)) {
    throw new Error(`找不到包内 vendor/localShell.cjs（${vendored}），请重新安装 mao-agent`);
  }
  return vendored;
}

let cachedLoginPath: string | null = null;

/**
 * 从登录 shell 取 PATH：mao-agent 可能被 cron / 其他 Agent 的非登录 shell 拉起，
 * 此时 process.env.PATH 缺少 nvm / brew / cargo 等用户工具目录。
 * 用 execFile 传参数组（不拼接命令字符串）避免 $SHELL 内容被当命令执行。
 */
async function resolveLoginPath(): Promise<string> {
  if (cachedLoginPath != null) return cachedLoginPath;
  const currentPath = process.env.PATH ?? '';
  const shell = process.env.SHELL;
  if (process.platform === 'win32' || !shell || !path.isAbsolute(shell)) {
    cachedLoginPath = currentPath;
    return cachedLoginPath;
  }
  const resolved = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-l', '-c', 'printf %s "$PATH"'],
      { timeout: 5000, env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => resolve(err ? currentPath : (stdout.trim() || currentPath)),
    );
  });
  cachedLoginPath = resolved;
  return resolved;
}

export function createCliShellRuntime(): LocalShellRuntime {
  const bashPath = requireBash();
  const mod = requireFromHere(resolveLocalShellPath()) as {
    createLocalShellRuntime: (opts: Record<string, unknown>) => LocalShellRuntime;
  };
  const runtime = mod.createLocalShellRuntime({
    // 有意不注入 MAO_TOKEN：shell 命令由模型生成，注入凭据等于把 JWT 交给模型可控的子进程。
    // 代价是子进程里的 mao / mao-agent 需要用户自己登录（~/.mao/auth.json）。
    buildEnv: async () => ({ ...process.env, PATH: await resolveLoginPath(), TERM: 'dumb', PS1: '' }),
    refreshToken: () => undefined,
    // vendor/localShell.cjs 固定 spawn('bash')，这里替换成已校验存在的绝对路径。
    spawn: (command: string, args: string[], options: Record<string, unknown>) =>
      spawn(command === 'bash' ? bashPath : command, args, options as never),
    resolveOutput: (maoSessionId: number, shellId: string) => {
      const fileName = `${shellId}.out`;
      const dir = resolveShellOutputDir(maoSessionId || 0);
      ensureDir(dir);
      return {
        absPath: path.join(dir, fileName),
        displayPath: formatRuntimeDisplay(maoSessionId || 0, 'shellOutput', fileName),
      };
    },
  });
  return {
    closeAll: () => runtime.closeAll(),
    handle: async (args, ctx) => {
      // workdir 会成为子 shell 的 cwd，必须与文件工具一样受沙箱约束。
      if (typeof args.workdir === 'string' && args.workdir.trim() !== '') {
        try {
          resolveSandboxPath(args.workdir, ctx.workspace, ctx.conversationId);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return runtime.handle(args, ctx);
    },
  };
}
