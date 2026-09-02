/**
 * 默认拒绝清单。优先级高于 --yolo / allow 规则，只能被 --i-know-what-im-doing 豁免。
 *
 * 规则按「参数会被怎么用」分流：
 * - EXEC_PATTERNS 只作用于会交给 shell 执行的字段（shell.command / shell.input）；
 * - SENSITIVE_PATH_PATTERNS 作用于执行文本与文件路径类字段；
 * - 文件内容（content/old_string/new_string）不参与危险命令匹配 —— 写一篇提到 mkfs 的文档不该被拦，
 *   写文件的真实风险由目标路径规则与路径沙箱共同约束。
 */
const EXEC_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'rm-root', re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\s+(\/|\/*\s|\/\s|\/\*|~\/?\s*$)/, reason: '禁止 rm -rf /' },
  { id: 'rm-root2', re: /\brm\s+-[^\n]*\s+\/\s*$/, reason: '禁止删除根目录' },
  { id: 'fork-bomb', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: '禁止 fork bomb' },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/, reason: '禁止格式化磁盘' },
  { id: 'dd-disk', re: /\bdd\b[^\n]*\bof=\s*\/dev\/(sd|nvme|hd|xvd|vd)/, reason: '禁止 dd 写入块设备' },
  { id: 'pipe-sh', re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(ba)?sh\b/, reason: '禁止把远程脚本直接交给 shell' },
  { id: 'chmod-root', re: /\bchmod\s+(-R\s+)?777\s+\//, reason: '禁止 chmod 777 /' },
  { id: 'shutdown', re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/, reason: '禁止关机/重启' },
  { id: 'iptables-flush', re: /\b(iptables|nft)\b[^\n]*\s-F\b/, reason: '禁止清空防火墙' },
];

const SENSITIVE_PATH_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'ssh-write', re: /(^|[^\w])(~|\$HOME|\/root|\/home\/[^/\s]+)\/\.ssh\b/, reason: '禁止操作 ~/.ssh' },
  { id: 'etc-shadow', re: /\/etc\/(passwd|shadow|sudoers)\b/, reason: '禁止改写系统认证文件' },
];

/** 会被 shell 执行的参数字段：exec 的 command 与 write_stdin 的 input 都会落到同一个 bash 会话。 */
const EXEC_FIELDS = ['command', 'input'];
const PATH_FIELDS = ['path', 'file', 'filePath', 'file_path', 'target_file', 'workdir'];

export interface DenyMatch {
  id: string;
  reason: string;
}

function matchAll(text: string, patterns: Array<{ id: string; re: RegExp; reason: string }>): DenyMatch | null {
  for (const p of patterns) {
    if (p.re.test(text)) return { id: p.id, reason: p.reason };
  }
  return null;
}

/** 执行文本检测：全量扫描，不做长度截断（超长命令尾部同样会被 bash 执行）。 */
export function matchDenyList(text: string | undefined | null): DenyMatch | null {
  if (!text) return null;
  return matchAll(text, EXEC_PATTERNS) ?? matchAll(text, SENSITIVE_PATH_PATTERNS);
}

export function matchSensitivePath(text: string | undefined | null): DenyMatch | null {
  if (!text) return null;
  return matchAll(text, SENSITIVE_PATH_PATTERNS);
}

export function checkToolDeny(args: Record<string, unknown>): DenyMatch | null {
  for (const key of EXEC_FIELDS) {
    const hit = matchDenyList(typeof args[key] === 'string' ? (args[key] as string) : null);
    if (hit) return hit;
  }
  for (const key of PATH_FIELDS) {
    const hit = matchSensitivePath(typeof args[key] === 'string' ? (args[key] as string) : null);
    if (hit) return hit;
  }
  return null;
}
