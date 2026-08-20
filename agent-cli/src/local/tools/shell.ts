import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatRuntimeDisplay, resolveShellOutputDir, ensureDir } from '../paths';

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

function resolveLocalShellPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../vendor/localShell.cjs'),
    path.resolve(__dirname, '../../../../desktop/electron/localShell.cjs'),
    path.resolve(__dirname, '../../../../../desktop/electron/localShell.cjs'),
    path.resolve(process.cwd(), '../desktop/electron/localShell.cjs'),
    path.resolve(process.cwd(), 'desktop/electron/localShell.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`找不到 localShell.cjs（已尝试: ${candidates.join(', ')}）`);
}

export function createCliShellRuntime(): LocalShellRuntime {
  const mod = requireFromHere(resolveLocalShellPath()) as {
    createLocalShellRuntime: (opts: Record<string, unknown>) => LocalShellRuntime;
  };
  return mod.createLocalShellRuntime({
    buildEnv: async () => ({ ...process.env, TERM: 'dumb', PS1: '' }),
    refreshToken: () => undefined,
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
}

export function hostHome(): string {
  return os.homedir();
}
