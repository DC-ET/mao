/**
 * 默认拒绝清单。优先级高于 --yolo / allow 规则，只能被 --i-know-what-im-doing 豁免。
 */
const PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'rm-root', re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\s+(\/|\/*\s|\/\s|\/\*|~\/?\s*$)/, reason: '禁止 rm -rf /' },
  { id: 'rm-root2', re: /\brm\s+-[^\n]*\s+\/\s*$/, reason: '禁止删除根目录' },
  { id: 'fork-bomb', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: '禁止 fork bomb' },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/, reason: '禁止格式化磁盘' },
  { id: 'dd-disk', re: /\bdd\b[^\n]*\bof=\s*\/dev\/(sd|nvme|hd|xvd|vd)/, reason: '禁止 dd 写入块设备' },
  { id: 'ssh-write', re: /(^|[^\w])(~|\$HOME|\/root)\/\.ssh\b/, reason: '禁止操作 ~/.ssh' },
  { id: 'etc-shadow', re: /\/etc\/(passwd|shadow|sudoers)\b/, reason: '禁止改写系统认证文件' },
  { id: 'pipe-sh', re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(ba)?sh\b/, reason: '禁止把远程脚本直接交给 shell' },
  { id: 'chmod-root', re: /\bchmod\s+(-R\s+)?777\s+\//, reason: '禁止 chmod 777 /' },
  { id: 'shutdown', re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/, reason: '禁止关机/重启' },
  { id: 'iptables-flush', re: /\b(iptables|nft)\b[^\n]*\s-F\b/, reason: '禁止清空防火墙' },
];

export interface DenyMatch {
  id: string;
  reason: string;
}

export function matchDenyList(text: string | undefined | null): DenyMatch | null {
  if (!text) return null;
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  for (const p of PATTERNS) {
    if (p.re.test(sample)) return { id: p.id, reason: p.reason };
  }
  return null;
}

export function describeToolForDeny(toolName: string, args: Record<string, unknown>): string {
  const parts = [toolName];
  if (typeof args.command === 'string') parts.push(args.command);
  if (typeof args.path === 'string') parts.push(args.path);
  if (typeof args.file === 'string') parts.push(args.file);
  if (typeof args.content === 'string') parts.push(args.content.slice(0, 500));
  if (typeof args.old_string === 'string') parts.push(args.old_string);
  if (typeof args.new_string === 'string') parts.push(args.new_string);
  return parts.join(' ');
}
