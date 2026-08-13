import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { formatDateTime, shanghaiYmd } from '../common/json.js';
import type { WeixinBotConfig } from './types.js';

const BASE_SUBDIR = 'weixin-files';
const MAX_NAME_LENGTH = 120;

export class StorageException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageException';
  }
}

export function sanitizeFileName(fileName: string | null | undefined): string {
  if (fileName == null || fileName.trim() === '') {
    return `file-${randomUUID()}.bin`;
  }
  let name = fileName;
  try {
    name = name.replace(/\p{Cc}/gu, '_');
    if (name.includes('/')) {
      name = path.basename(name);
    }
  } catch {
    return `file-${randomUUID()}.bin`;
  }
  name = name.replace(/[\\/:*?"<>|{}@]/g, '_').trim();
  if (name === '' || name === '.' || name === '..') {
    return `file-${randomUUID()}.bin`;
  }
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extLen = dot > 0 ? name.length - dot : 0;
    if (dot > 0 && extLen <= 20 && extLen < MAX_NAME_LENGTH) {
      name = name.slice(0, MAX_NAME_LENGTH - extLen) + name.slice(dot);
    } else {
      name = name.slice(0, MAX_NAME_LENGTH);
    }
  }
  return name;
}

export class WeixinFileStorageService {
  constructor(private readonly weixinBotConfig: WeixinBotConfig) {}

  saveFile(workspace: string | null | undefined, fileName: string | null | undefined, bytes: Buffer): string {
    if (bytes == null || bytes.length === 0) {
      throw new StorageException('文件内容为空');
    }
    const maxBytes = this.weixinBotConfig.maxInboundFileMb * 1024 * 1024;
    if (bytes.length > maxBytes) {
      throw new StorageException(`文件超过大小限制（${this.weixinBotConfig.maxInboundFileMb}MB）`);
    }
    const baseDir = this.resolveBaseDir(workspace);
    const cleaned = sanitizeFileName(fileName);
    try {
      mkdirSync(baseDir, { recursive: true });
      return this.writeUnique(baseDir, cleaned, bytes);
    } catch (e) {
      if (e instanceof StorageException) throw e;
      console.error(`微信文件保存失败, workspace=${workspace}, fileName=${cleaned}`, e);
      throw new StorageException('文件保存失败，请重试');
    }
  }

  private resolveBaseDir(workspace: string | null | undefined): string {
    const root = path.resolve(workspace != null && workspace.trim() !== '' ? workspace : '.');
    const dir = path.resolve(root, BASE_SUBDIR, shanghaiYmd());
    if (!dir.startsWith(root)) {
      throw new StorageException('非法的工作区路径');
    }
    return dir;
  }

  private writeUnique(dir: string, name: string, bytes: Buffer): string {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const ts = formatDateTime(new Date()).replace(/[-: ]/g, '').slice(0, 14);
    let seq = 0;
    while (true) {
      let candidateName: string;
      if (seq === 0) candidateName = name;
      else if (seq === 1) candidateName = `${base}_${ts}${ext}`;
      else candidateName = `${base}_${ts}_${seq - 1}${ext}`;
      const candidate = path.join(dir, candidateName);
      try {
        writeFileSync(candidate, bytes, { flag: 'wx' });
        return candidate;
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? (e as { code: string }).code : '';
        if (code === 'EEXIST') {
          seq++;
          continue;
        }
        throw e;
      }
    }
  }
}
