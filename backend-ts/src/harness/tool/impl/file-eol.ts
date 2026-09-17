/**
 * 写回文件时保留原 BOM / CRLF。模型给出的 content 一律是 LF 且无 BOM。
 * 与 agent-cli `local/tools/files.ts` 的 detectEol / applyEol / stripBom 同语义。
 */

export interface FileEol {
  bom: boolean;
  crlf: boolean;
}

export function detectEol(raw: string): FileEol {
  return { bom: raw.charCodeAt(0) === 0xfeff, crlf: raw.includes('\r\n') };
}

export function applyEol(content: string, eol: FileEol): string {
  let out = content;
  if (eol.crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (eol.bom && out.charCodeAt(0) !== 0xfeff) out = `\uFEFF${out}`;
  return out;
}

export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}
