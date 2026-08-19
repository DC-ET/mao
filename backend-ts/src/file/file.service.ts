import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ImageFileSupport } from '../harness/tool/image-file-support.js';
import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';

export interface FileEntity {
  id?: number;
  originalName: string;
  storedName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string | null;
  uploaderId?: number | null;
  sessionId?: number | null;
  deleted?: number;
  createdAt?: string | null;
}

export interface WorkspaceFileDTO {
  path: string;
  name: string;
  size: number;
}

export class FileEntityRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<FileEntity | null> {
    return this.db.queryOne<FileEntity>(`SELECT * FROM \`file\` WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  async insert(file: FileEntity): Promise<number> {
    const id = await this.db.insert('file', {
      originalName: file.originalName,
      storedName: file.storedName,
      filePath: file.filePath,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      uploaderId: file.uploaderId,
      sessionId: file.sessionId,
      deleted: 0,
    });
    file.id = id;
    return id;
  }

  async logicalDelete(id: number): Promise<void> {
    await this.db.execute(`UPDATE \`file\` SET deleted = 1 WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  list(userId?: number | null, sessionId?: number | null): Promise<FileEntity[]> {
    const clauses = [notDeleted()];
    const params: unknown[] = [];
    if (userId != null) {
      clauses.push('uploader_id = ?');
      params.push(userId);
    }
    if (sessionId != null) {
      clauses.push('session_id = ?');
      params.push(sessionId);
    }
    return this.db.query<FileEntity>(
      `SELECT * FROM \`file\` WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.git', 'target', 'dist', 'build',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode',
]);

export class FileService {
  constructor(
    private readonly repo: FileEntityRepository,
    private readonly uploadDir: string,
    private readonly maxSizeMb: number,
  ) {}

  async uploadFile(bytes: Buffer, originalFilename: string | null, declaredMime: string | null, userId: number, sessionId: number | null): Promise<FileEntity> {
    this.assertUploadable(bytes);
    const dir = this.uploadDir;
    try {
      const entity = this.buildFileEntity(bytes, originalFilename, declaredMime, userId, sessionId);
      mkdirSync(dir, { recursive: true });
      entity.filePath = join(dir, entity.storedName);
      writeFileSync(entity.filePath, bytes);
      await this.repo.insert(entity);
      return entity;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error('Failed to save file', e);
      throw new BusinessException(5000, '文件保存失败');
    }
  }

  /**
   * 上传到会话运行时 incoming 目录（runtime/{userId}/{sessionId}/incoming）。
   * 会话删除时由 SessionService.deleteSession 级联清理该目录。
   */
  async uploadIncomingFile(
    bytes: Buffer,
    originalFilename: string | null,
    declaredMime: string | null,
    userId: number,
    sessionId: number,
    incomingDir: string,
  ): Promise<FileEntity> {
    this.assertUploadable(bytes);
    try {
      const entity = this.buildFileEntity(bytes, originalFilename, declaredMime, userId, sessionId);
      mkdirSync(incomingDir, { recursive: true });
      entity.filePath = join(incomingDir, entity.storedName);
      writeFileSync(entity.filePath, bytes);
      await this.repo.insert(entity);
      return entity;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error('Failed to save incoming file', e);
      throw new BusinessException(5000, '文件保存失败');
    }
  }

  private assertUploadable(bytes: Buffer): void {
    if (bytes.length === 0) {
      throw new BusinessException(4000, '文件不能为空');
    }
    const maxSizeBytes = this.maxSizeMb * 1024 * 1024;
    if (bytes.length > maxSizeBytes) {
      throw new BusinessException(4001, `文件大小超过限制: ${this.maxSizeMb}MB`);
    }
  }

  private buildFileEntity(
    bytes: Buffer,
    originalFilename: string | null,
    declaredMime: string | null,
    userId: number,
    sessionId: number | null,
  ): FileEntity {
    let originalName = originalFilename == null || originalFilename.trim().length === 0 ? 'upload' : originalFilename;
    // 仅保留文件名（剥掉路径），并替换 URL 编码/反斜杠等危险字符，防止展示与拼接异常
    const baseName = sanitizeBaseName(basename(originalName));
    const mimeType = resolveUploadMime(bytes, declaredMime, baseName);
    const imageExt = ImageFileSupport.extensionForMime(mimeType);
    if (imageExt && !ImageFileSupport.isImagePath(baseName)) {
      originalName = baseName + imageExt;
    } else {
      originalName = baseName;
    }
    const extension = safeExtension(originalName);
    const storedName = randomUUID() + extension;
    return {
      storedName,
      filePath: '',
      fileSize: bytes.length,
      mimeType,
      originalName,
      uploaderId: userId,
      sessionId,
    } as FileEntity;
  }

  getFile(id: number): Promise<FileEntity | null> {
    return this.repo.findById(id);
  }

  async listFiles(userId: number | null, sessionId: number | null): Promise<FileEntity[]> {
    const files = await this.repo.list(userId, sessionId);
    // runtime incoming 上传文件由会话删除统一清理，不暴露在通用文件列表中
    return files.filter((f) => !f.filePath.includes(`${sep}incoming${sep}`));
  }

  async deleteFile(id: number): Promise<void> {
    const file = await this.repo.findById(id);
    if (file != null) {
      try {
        if (existsSync(file.filePath)) {
          unlinkSync(file.filePath);
        }
      } catch (e) {
        console.warn(`Failed to delete file from disk: ${file.filePath}`, e);
      }
      await this.repo.logicalDelete(id);
    }
  }

  async getFilePath(id: number): Promise<string> {
    const file = await this.repo.findById(id);
    if (file == null) {
      throw new BusinessException(4040, '文件不存在');
    }
    return file.filePath;
  }

  listWorkspaceFiles(workspace: string, filter: string | null | undefined, limit: number): WorkspaceFileDTO[] {
    const root = resolve(workspace);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return [];
    }
    const lowerFilter = filter != null ? filter.toLowerCase() : null;
    const files: { path: string; mtime: number; dto: WorkspaceFileDTO }[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        const parts = rel.split(/[/\\]/);
        if (parts.some((name) => name.startsWith('.') || IGNORED_DIRS.has(name))) {
          continue;
        }
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (lowerFilter && lowerFilter.length > 0) {
            if (!rel.toLowerCase().includes(lowerFilter) && !entry.name.toLowerCase().includes(lowerFilter)) {
              continue;
            }
          }
          let size = 0;
          let mtime = 0;
          try {
            const st = statSync(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            // ignore
          }
          files.push({
            path: rel.replace(/\\/g, '/'),
            mtime,
            dto: { path: rel.replace(/\\/g, '/'), name: entry.name, size },
          });
        }
      }
    };
    walk(root);
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit).map((f) => f.dto);
  }
}

function resolveUploadMime(bytes: Buffer, declaredMime: string | null, originalName: string): string {
  return ImageFileSupport.resolveImageMime(bytes, declaredMime, originalName)
    ?? ImageFileSupport.normalizeMime(declaredMime)
    ?? 'application/octet-stream';
}

/**
 * 取安全扩展名：仅保留最后一个点号后的字母数字/点/横线/下划线（最多 16 字符），
 * 防止用户文件名中的路径分隔符或特殊字符拼入 storedName 造成路径逃逸。
 */
function safeExtension(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = originalName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9._-]{1,16}$/.test(ext) ? `.${ext}` : '';
}

/** 清洗文件名：仅处理路径穿越片段（如 %2e%2e 编码的 ../）与反斜杠/控制字符，保留正常字符。 */
function sanitizeBaseName(name: string): string {
  let out = name
    // 编码形式的 .. （%2e%2e 或 %2e. 等）替换为字面量，避免拼接歧义
    .replace(/%2e%2e/gi, '..')
    .replace(/%2e/gi, '.')
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '\\')
    // 反斜杠/正斜杠归一为下划线（Windows 风格路径）
    .replace(/[\\/]/g, '_');
  // 保留可打印字符（含中文等常用 UTF-8），其余替换为 _
  out = out.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
  return out.length === 0 ? 'upload' : out;
}
