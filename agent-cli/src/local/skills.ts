import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir, resolveSkillsDir } from './paths';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

function preferIpv4(url: string): string {
  return String(url || '').replace('://localhost', '://127.0.0.1');
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
  unixMode: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('技能包解析失败：不是合法的 zip（未找到 EOCD）');
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
    throw new Error('技能包解析失败：不支持 Zip64 格式');
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new Error('技能包解析失败：中央目录条目签名错误');
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localHeaderOffset, unixMode: externalAttrs >>> 16 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`技能包解析失败：本地头签名错误（${entry.name}）`);
  }
  const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`技能包解析失败：不支持的压缩方法 ${entry.method}（${entry.name}）`);
}

/** 逐条目校验落点必须在 destDir 内：拒绝 `../`、绝对路径与 symlink 条目（zip-slip）。 */
export function extractZip(zipBuffer: Buffer, destDir: string): string[] {
  const root = path.resolve(destDir);
  const written: string[] = [];
  for (const entry of readCentralDirectory(zipBuffer)) {
    const name = entry.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`技能包包含非法路径条目，已拒绝解压：${entry.name}`);
    }
    if ((entry.unixMode & S_IFMT) === S_IFLNK) {
      throw new Error(`技能包包含符号链接条目，已拒绝解压：${entry.name}`);
    }
    const target = path.resolve(root, name);
    const rel = path.relative(root, target);
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error(`技能包条目越出目标目录，已拒绝解压：${entry.name}`);
    }
    if (name.endsWith('/')) {
      ensureDir(target);
      continue;
    }
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, entryData(zipBuffer, entry), { mode: 0o600 });
    written.push(rel);
  }
  return written;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function syncSkills(opts: {
  sessionId: number;
  syncUrl: string;
  removed?: unknown;
  baseUrl: string;
  token: string | null;
}): Promise<void> {
  const origin = preferIpv4(opts.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, ''));
  const fullUrl = preferIpv4(/^https?:\/\//.test(opts.syncUrl) ? opts.syncUrl : `${origin}${opts.syncUrl}`);
  // 技能包只可能来自 CLI 自己连接的服务端；跨 origin 直接拒绝，避免被篡改的下发把 JWT 送到任意主机。
  const expected = originOf(origin);
  const actual = originOf(fullUrl);
  if (!expected || !actual || expected !== actual) {
    throw new Error(`拒绝跨源技能同步：${fullUrl}（当前服务端 ${origin}）`);
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const response = await fetch(fullUrl, { method: 'POST', headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} ${body}`.trim());
  }
  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const skillsDir = resolveSkillsDir(opts.sessionId);
  ensureDir(skillsDir);
  extractZip(zipBuffer, skillsDir);
  const removed = Array.isArray(opts.removed) ? opts.removed.map(String) : [];
  for (const name of removed) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
    const target = path.join(skillsDir, name);
    if (target.startsWith(skillsDir + path.sep)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
