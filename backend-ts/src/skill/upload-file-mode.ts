/**
 * 浏览器目录上传（multipart）不携带 Unix 权限位，writeFileSync 落盘默认 0644，
 * 技能内的 CLI 脚本会失去执行位，Agent 通过 shell 调用时报 Permission denied。
 * 上传落盘时按扩展名与文件头恢复可执行位：能被直接执行的文件必然是 .sh、
 * 带 shebang 的脚本或 ELF 二进制。
 */
export function uploadFileMode(relativePath: string, buffer: Buffer): number {
  if (relativePath.toLowerCase().endsWith('.sh')) return 0o755;
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head.startsWith('#!') || head === '\x7fELF') return 0o755;
  return 0o644;
}
