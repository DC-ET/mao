import { spawn } from 'node:child_process';

function spawnStdin(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(text);
  });
}

/** 把文本写入系统剪贴板。无可用命令时返回 false。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  const plat = process.platform;
  if (plat === 'darwin') return spawnStdin('pbcopy', [], text);
  if (plat === 'win32') return spawnStdin('clip', [], text);
  if (await spawnStdin('wl-copy', [], text)) return true;
  if (await spawnStdin('xclip', ['-selection', 'clipboard'], text)) return true;
  if (await spawnStdin('xsel', ['--clipboard', '--input'], text)) return true;
  return false;
}
