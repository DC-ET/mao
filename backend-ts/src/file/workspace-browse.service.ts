import {
  closeSync, createWriteStream, existsSync, lstatSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, rmSync, statSync, type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import sharp from 'sharp';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { ImageFileSupport } from '../harness/tool/image-file-support.js';
import { isUnder, PathSandbox, SecurityException } from '../harness/safety/path-sandbox.js';

const MAX_ENTRIES = 500;
const DEFAULT_READ_LIMIT = 5000;
const MAX_READ_LIMIT = 5000;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export interface DirectoryEntryDTO {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  isSymlink: boolean;
}

export interface DirectoryListingDTO {
  entries: DirectoryEntryDTO[];
  truncated: boolean;
}

export interface FileContentDTO {
  content: string;
  total_lines: number;
  media_type?: string;
  mime?: string;
  data_uri?: string;
}

export interface DownloadResult {
  path: string;
  size: number;
  fileName: string;
}

export interface ZipResult {
  zipPath: string;
  size: number;
  fileName: string;
}

export class WorkspaceBrowseService {
  private maxZipBytes = DEFAULT_MAX_ZIP_BYTES;

  constructor(private readonly pathSandbox: PathSandbox) {}

  setMaxZipBytes(bytes: number): void {
    this.maxZipBytes = bytes;
  }

  listDirectory(sessionWorkspace: string, relativeDir: string | null | undefined): DirectoryListingDTO {
    const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
    const dir = this.normalizeRelativeDir(relativeDir);
    const dirPath = this.resolvePath(dir, sessionWorkspace);
    if (!existsSync(dirPath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目录不存在');
    }
    if (!statSync(dirPath).isDirectory()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不是目录');
    }
    const entries: DirectoryEntryDTO[] = [];
    let truncated = false;
    let children: string[];
    try {
      children = readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.warn(`Failed to list directory: ${dirPath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取目录失败');
    }
    if (children.length > MAX_ENTRIES) {
      truncated = true;
    }
    for (const name of children) {
      if (entries.length >= MAX_ENTRIES) break;
      const child = join(dirPath, name);
      const entry: DirectoryEntryDTO = {
        name,
        path: relative(workspaceRoot, resolve(child)).replace(/\\/g, '/'),
        isSymlink: false,
        isDirectory: false,
        size: 0,
      };
      try {
        const lst = lstatSync(child);
        entry.isSymlink = lst.isSymbolicLink();
        entry.isDirectory = lst.isDirectory() && !entry.isSymlink;
        entry.size = lst.size;
      } catch {
        entry.size = 0;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    });
    return { entries, truncated };
  }

  downloadFile(sessionWorkspace: string, relativePath: string | null | undefined): DownloadResult {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    this.assertRealPathInWorkspace(filePath, sessionWorkspace, relativePath);
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat file for download: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    return { path: filePath, size, fileName: basename(filePath) };
  }

  readPdfFile(sessionWorkspace: string, relativePath: string | null | undefined): DownloadResult {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    if (!relativePath.toLowerCase().endsWith('.pdf')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '仅支持预览 .pdf 文件');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    this.assertRealPathInWorkspace(filePath, sessionWorkspace, relativePath);
    let head: Buffer;
    try {
      head = readN(filePath, 8);
    } catch (e) {
      console.warn(`Failed to read pdf header: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    if (!isPdfHeader(head, head.length)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是有效的 PDF 文件或文件已损坏：${relativePath}`);
    }
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat pdf file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    return { path: filePath, size, fileName: basename(filePath) };
  }

  async zipDirectory(sessionWorkspace: string, relativeDir: string | null | undefined): Promise<ZipResult> {
    const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
    const dir = this.normalizeRelativeDir(relativeDir);
    const dirPath = this.resolvePath(dir, sessionWorkspace);
    if (!existsSync(dirPath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目录不存在');
    }
    if (!statSync(dirPath).isDirectory()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不是目录');
    }
    let totalBytes = 0;
    walkFiles(dirPath, (p, st) => {
      if (!lstatSync(p).isSymbolicLink() && st.isFile()) {
        totalBytes += st.size;
      }
    });
    if (totalBytes > this.maxZipBytes) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `目录过大（${formatSize(totalBytes)}），请选择子目录下载`);
    }
    const rootName = this.resolveZipRootName(dirPath, workspaceRoot);
    const zipPath = join(tmpdir(), `mao-workspace-${randomUUID()}.zip`);
    let written = false;
    try {
      await writeZip(dirPath, rootName, zipPath);
      written = true;
    } catch (e) {
      console.warn(`Failed to write zip for directory: ${dirPath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '打包目录失败');
    } finally {
      if (!written) {
        try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      }
    }
    let zipSize = 0;
    try {
      zipSize = statSync(zipPath).size;
    } catch {
      zipSize = 0;
    }
    return { zipPath, size: zipSize, fileName: `${rootName}.zip` };
  }

  async readFile(sessionWorkspace: string, relativePath: string | null | undefined, offset: number, limit: number): Promise<FileContentDTO> {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    this.assertRealPathInWorkspace(filePath, sessionWorkspace, relativePath);
    if (ImageFileSupport.mimeFromPath(relativePath)) {
      return this.readImageFile(filePath, relativePath);
    }
    // 文本预览整文件读入内存，必须先做大小上限（与图片/PDF 路径对齐），防止大文件触发 OOM
    if (lst.size > MAX_TEXT_PREVIEW_BYTES) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `文件过大（${formatSize(lst.size)}），文本预览上限为 ${formatSize(MAX_TEXT_PREVIEW_BYTES)}，请下载后查看`,
      );
    }
    const effectiveOffset = Math.max(offset, 0);
    const effectiveLimit = limit > 0 ? Math.min(limit, MAX_READ_LIMIT) : DEFAULT_READ_LIMIT;
    let allLines: string[];
    try {
      const raw = readFileSync(filePath);
      if (raw.includes(0)) {
        throw new Error('nul');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      allLines = text.split('\n');
      if (allLines.length > 0 && allLines[allLines.length - 1] === '' && text.endsWith('\n')) {
        allLines = text.replace(/\n$/, '').split('\n');
        if (text.length === 0) allLines = [];
      }
    } catch {
      console.warn(`Failed to read file as text: ${filePath}`);
      throw new BusinessException(ErrorCode.PARAM_INVALID, '二进制文件，无法预览');
    }
    const totalLines = allLines.length;
    const from = Math.min(effectiveOffset, totalLines);
    const to = Math.min(from + effectiveLimit, totalLines);
    let content = allLines.slice(from, to).join('\n');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_CONTENT_BYTES) {
      let end = MAX_CONTENT_BYTES;
      while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
      content = bytes.subarray(0, end).toString('utf8');
    }
    return { content, total_lines: totalLines };
  }

  private async readImageFile(filePath: string, relativePath: string): Promise<FileContentDTO> {
    let sizeBytes: number;
    try {
      sizeBytes = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat image file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `文件过大（${ImageFileSupport.formatSize(sizeBytes)}），图片预览上限为 ${ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES)}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch (e) {
      console.warn(`Failed to read image file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    const detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!detectedMime) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不支持的图片格式或文件内容无效：${relativePath}`);
    }
    const dataUri = `data:${detectedMime};base64,${bytes.toString('base64')}`;
    let width: number | undefined;
    let height: number | undefined;
    try {
      const meta = await sharp(bytes).metadata();
      width = meta.width;
      height = meta.height;
    } catch {
      // ignore
    }
    let summary = `${relativePath} (${detectedMime}, ${ImageFileSupport.formatSize(sizeBytes)}`;
    if (width != null && height != null) {
      summary += `, ${width}×${height}`;
    }
    summary += ')';
    return {
      content: summary,
      total_lines: 0,
      media_type: 'image',
      mime: detectedMime,
      data_uri: dataUri,
    };
  }

  private normalizeRelativeDir(relativeDir: string | null | undefined): string {
    if (relativeDir == null || relativeDir.trim().length === 0 || relativeDir === '.') {
      return '.';
    }
    return relativeDir;
  }

  private resolvePath(userPath: string, sessionWorkspace: string): string {
    try {
      return this.pathSandbox.resolve(userPath, sessionWorkspace);
    } catch (e) {
      if (e instanceof SecurityException) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
  }

  private assertRealPathInWorkspace(filePath: string, sessionWorkspace: string, relativePath: string): void {
    try {
      const realPath = realpathSync(filePath);
      const realRoot = realpathSync(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
      if (!isUnder(realPath, realRoot)) {
        console.warn(`Path escape via symlink blocked: ${relativePath} (real: ${realPath})`);
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
  }

  private resolveZipRootName(dirPath: string, workspaceRoot: string): string {
    try {
      const normalizedDir = resolve(dirPath);
      const normalizedRoot = resolve(workspaceRoot);
      return normalizedDir === normalizedRoot ? basename(normalizedRoot) : basename(normalizedDir);
    } catch {
      return 'workspace';
    }
  }
}

function isPdfHeader(head: Buffer, read: number): boolean {
  let offset = 0;
  if (read >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    offset = 3;
  }
  if (read - offset < 5) return false;
  return head[offset] === 0x25 && head[offset + 1] === 0x50 && head[offset + 2] === 0x44
    && head[offset + 3] === 0x46 && head[offset + 4] === 0x2d;
}

function readN(filePath: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  const fd = openSync(filePath, 'r');
  try {
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function walkFiles(dir: string, visit: (p: string, st: Stats) => void): void {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      try {
        const lst = lstatSync(p);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) stack.push(p);
        else visit(p, lst);
      } catch {
        // skip
      }
    }
  }
}

function zipEntryName(baseDir: string, rootName: string, file: string): string {
  const base = resolve(baseDir);
  const target = resolve(file);
  if (base === target) return rootName;
  const rel = relative(base, target).replace(/\\/g, '/');
  return `${rootName}/${rel}`;
}

async function writeZip(dirPath: string, rootName: string, zipPath: string): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });
    output.on('close', () => resolveP());
    archive.on('error', reject);
    archive.pipe(output);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (lstatSync(p).isSymbolicLink()) continue;
        files.push(p);
        if (e.isDirectory()) walk(p);
      }
    };
    files.push(dirPath);
    walk(dirPath);
    files.sort((a, b) => zipEntryName(dirPath, rootName, a).localeCompare(zipEntryName(dirPath, rootName, b)));
    for (const p of files) {
      const lst = lstatSync(p);
      if (lst.isSymbolicLink()) continue;
      const name = zipEntryName(dirPath, rootName, p);
      if (lst.isDirectory()) {
        archive.append(Buffer.alloc(0), { name: `${name}/` });
      } else if (lst.isFile()) {
        archive.file(p, { name });
      }
    }
    void archive.finalize();
  });
}
