import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
    if (bytes.length === 0) {
      throw new BusinessException(4000, '文件不能为空');
    }
    const maxSizeBytes = this.maxSizeMb * 1024 * 1024;
    if (bytes.length > maxSizeBytes) {
      throw new BusinessException(4001, `文件大小超过限制: ${this.maxSizeMb}MB`);
    }
    try {
      let originalName = originalFilename == null || originalFilename.trim().length === 0 ? 'upload' : originalFilename;
      const mimeType = resolveUploadMime(bytes, declaredMime, originalName);
      const imageExt = ImageFileSupport.extensionForMime(mimeType);
      if (imageExt && !ImageFileSupport.isImagePath(originalName)) {
        originalName = originalName + imageExt;
      }
      let extension = '';
      if (originalName.includes('.')) {
        extension = originalName.slice(originalName.lastIndexOf('.'));
      }
      const storedName = randomUUID() + extension;
      mkdirSync(this.uploadDir, { recursive: true });
      const filePath = join(this.uploadDir, storedName);
      writeFileSync(filePath, bytes);
      const fileEntity: FileEntity = {
        originalName,
        storedName,
        filePath,
        fileSize: bytes.length,
        mimeType,
        uploaderId: userId,
        sessionId,
      };
      await this.repo.insert(fileEntity);
      return fileEntity;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error('Failed to save file', e);
      throw new BusinessException(5000, '文件保存失败');
    }
  }

  getFile(id: number): Promise<FileEntity | null> {
    return this.repo.findById(id);
  }

  listFiles(userId: number | null, sessionId: number | null): Promise<FileEntity[]> {
    return this.repo.list(userId, sessionId);
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
