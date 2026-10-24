import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { isUnder } from '../safety/path-sandbox.js';
import { parseExperienceFrontmatter, type ExperienceFrontmatter } from './experience-frontmatter.js';

/** 经验根在共享目录下的固定子目录名：<shareDir>/agent-experience/<agentId>/（技术方案 D10）。 */
export const EXPERIENCE_ROOT_SUBDIR = 'agent-experience';
/** 工作区内挂载点名（符号链接名）：固定常量，不做配置。 */
export const EXPERIENCE_MOUNT_NAME = '团队经验';
/** 自动生成的索引文件名；约定 Agent 不手改（路标文案与 admin 编辑接口同步约束）。 */
export const EXPERIENCE_INDEX_FILE = 'INDEX.md';
/** 单篇经验子文档大小上限：经验是长文档，1MB 已远超合理篇幅，防止误写大文件拖垮索引扫描。 */
export const EXPERIENCE_MAX_DOC_BYTES = 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 200;
/** 索引行各字段展示上限：索引是检索入口不是正文，超长截断。 */
const FIELD_MAX_CHARS = 120;

export interface ExperienceDocMeta extends ExperienceFrontmatter {
  fileName: string;
  sizeBytes: number;
  /** 文件 mtime 的 ISO 串（admin 列表展示「更新时间」）。 */
  updatedAt: string;
}

/**
 * 团队经验库索引服务（技术方案 2026-10-24 §3.5）。
 *
 * 纯文件系统操作、无 DB 依赖：宿主进程与容器内进程（container-tool-executor）
 * 各自实例化同一目录，靠「陈旧判定 + 原子替换写」达成最终一致——容器内写的
 * 子文档由写工具回调即时刷新，shell 写入等旁路由下一次会话挂载 / admin 读取兜底。
 */
export class ExperienceIndexService {
  private readonly root: string;
  /**
   * 根 realpath 的懒缓存（配置路径自身含符号链接祖先时与词法根不同，双根比对同
   * PathSandbox.addAllowedRoot）。必须懒：服务在启动时构造，而经验根是懒创建的
   * （首次挂载才 mkdir）——构造时 realpath 多半失败，缓存回退词法串会让双根退化。
   */
  private rootRealCache: string | null = null;

  /** @param experienceRoot 经验根绝对路径（<shareDir>/agent-experience）。 */
  constructor(experienceRoot: string) {
    this.root = path.resolve(experienceRoot);
  }

  getRoot(): string {
    return this.root;
  }

  /** 某 Agent 的库目录。用数字 id 而非名称：Agent 改名不影响既有路径。 */
  dirFor(agentId: number): string {
    return path.join(this.root, String(agentId));
  }

  /**
   * 确保索引与子文档一致（幂等）。目录不存在则引导创建（空索引）。
   * 陈旧判定两条：任一子文档 mtime 晚于索引 mtime（新增/改写），或索引头 count
   * 与实际子文档数不符（删除——mtime 比对对删除恒真，必须靠 count 兜住）。
   */
  ensureFresh(agentDir: string): void {
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }
    const indexPath = path.join(agentDir, EXPERIENCE_INDEX_FILE);
    if (existsSync(indexPath)) {
      const docs = this.scanDocs(agentDir);
      const indexMtime = statSync(indexPath).mtimeMs;
      const recorded = readIndexCount(readFileSync(indexPath, 'utf8'));
      if (docs.every((doc) => doc.mtimeMs <= indexMtime) && recorded === docs.length) return;
    }
    this.rebuild(agentDir);
  }

  /** 强制重建索引（admin「重建索引」入口），不看陈旧判定。 */
  rebuild(agentDir: string): void {
    const docs = this.scanDocs(agentDir);
    this.writeIndexAtomic(agentDir, docs);
  }

  /** 子文档元信息列表（admin 列表；先 ensureFresh 保证与索引同口径）。 */
  listDocs(agentDir: string): ExperienceDocMeta[] {
    this.ensureFresh(agentDir);
    return this.scanDocs(agentDir)
      .sort((a, b) => b.fileName.localeCompare(a.fileName))
      .map(({ mtimeMs, ...meta }) => meta);
  }

  /** 读单篇子文档；不存在返回 null。 */
  readDoc(agentDir: string, fileName: string): string | null {
    if (!isValidExperienceFileName(fileName)) return null;
    const filePath = path.join(agentDir, fileName);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  }

  /** 写（upsert）单篇子文档并刷新索引。返回写盘字节数。INDEX.md 禁写（只由重建生成）。 */
  writeDoc(agentDir: string, fileName: string, content: string): number {
    if (!isValidExperienceFileName(fileName) || isIndexFileName(fileName)) {
      throw new Error(`非法经验文件名: ${fileName}`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > EXPERIENCE_MAX_DOC_BYTES) {
      throw new Error(`经验文档超过大小上限 ${EXPERIENCE_MAX_DOC_BYTES} 字节`);
    }
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }
    writeFileSync(path.join(agentDir, fileName), content);
    this.ensureFresh(agentDir);
    return bytes;
  }

  /** 删除单篇子文档并刷新索引；INDEX.md 禁删（只由重建生成）。不存在视为已删，幂等。 */
  deleteDoc(agentDir: string, fileName: string): void {
    if (!isValidExperienceFileName(fileName) || isIndexFileName(fileName)) {
      throw new Error(`非法经验文件名: ${fileName}`);
    }
    const filePath = path.join(agentDir, fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this.ensureFresh(agentDir);
  }

  /**
   * 写工具落盘回调入口（技术方案 §3.5 触发点 2）：路径位于经验根下时，
   * 刷新对应 Agent 库目录的索引。任何失败只记日志——索引刷新失败不应让写工具报错。
   *
   * 写工具回调拿到的是 resolveLenient 的词法路径：Agent 经工作区符号链接 团队经验/
   * 写入时路径不在经验根词法前缀下，须 realpath（链接目标即 <root>/<agentId>/...）
   * 后再判定；路径不存在（已被并发删除）静默跳过。
   */
  refreshIfUnderRoot(absPath: string): void {
    try {
      let resolved = path.resolve(absPath);
      let matchedRoot = this.matchRoot(resolved);
      if (matchedRoot == null) {
        try {
          resolved = realpathSync(resolved);
        } catch {
          return;
        }
        matchedRoot = this.matchRoot(resolved);
        if (matchedRoot == null) return;
      }
      const firstSegment = path.relative(matchedRoot, resolved).split(path.sep)[0];
      if (firstSegment == null || firstSegment === '' || !/^\d+$/.test(firstSegment)) return;
      this.ensureFresh(path.join(this.root, firstSegment));
    } catch (e) {
      harnessLog('warn', `experience index refresh failed for ${absPath}: ${(e as Error).message}`);
    }
  }

  /** 词法根或 realpath 根任一命中即视为在经验根下；都不命中返回 null。 */
  private matchRoot(resolved: string): string | null {
    if (isUnder(resolved, this.root)) return this.root;
    const real = this.rootReal();
    if (real != null && isUnder(resolved, real)) return real;
    return null;
  }

  /** 根 realpath（懒缓存）；根尚未创建时返回 null——该路径必不在根下。 */
  private rootReal(): string | null {
    if (this.rootRealCache == null) {
      try {
        this.rootRealCache = realpathSync(this.root);
      } catch {
        return null;
      }
    }
    return this.rootRealCache;
  }

  private scanDocs(agentDir: string): (ExperienceDocMeta & { mtimeMs: number })[] {
    if (!existsSync(agentDir)) return [];
    const out: (ExperienceDocMeta & { mtimeMs: number })[] = [];
    for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (isIndexFileName(entry.name)) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(agentDir, entry.name);
      try {
        const st = statSync(filePath);
        // frontmatter 只在文件头：只读头部 64KB，shell 误写的超大文件不拖垮整库扫描
        const content = readHead(filePath, st.size);
        out.push({
          fileName: entry.name,
          ...parseExperienceFrontmatter(content),
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs,
        });
      } catch (e) {
        // 单篇损坏（并发删除/权限）不该让整库索引失败
        harnessLog('warn', `experience doc scan failed: ${filePath}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private writeIndexAtomic(agentDir: string, docs: (ExperienceDocMeta & { mtimeMs: number })[]): void {
    const sorted = [...docs].sort((a, b) => b.fileName.localeCompare(a.fileName));
    const lines = [
      '# 团队经验索引（系统自动生成，请勿手改；按关键词 grep 本文件检索，命中后读取对应子文档）',
      `<!-- count: ${sorted.length} -->`,
      '',
      ...sorted.map((doc) => indexLine(doc)),
      '',
    ];
    const indexPath = path.join(agentDir, EXPERIENCE_INDEX_FILE);
    const tmpPath = indexPath + '.tmp';
    writeFileSync(tmpPath, lines.join('\n'));
    // 原子替换：并发重建 last-wins，读者不会看到半截索引
    renameSync(tmpPath, indexPath);
  }
}

function indexLine(doc: ExperienceDocMeta): string {
  return [
    `- ${doc.fileName}`,
    clip(doc.title || doc.fileName),
    clip(doc.keywords || '—'),
    clip(doc.summary || '—'),
    doc.lastVerified ? `验证 ${clip(doc.lastVerified)}` : '—',
  ].join(' | ');
}

function clip(text: string): string {
  return text.length > FIELD_MAX_CHARS ? text.slice(0, FIELD_MAX_CHARS) + '…' : text;
}

/** 读索引头 `<!-- count: N -->`；缺失/畸形返回 null（视为陈旧，强制重建）。 */
function readIndexCount(indexContent: string): number | null {
  const match = /<!-- count: (\d+) -->/.exec(indexContent);
  return match ? Number(match[1]) : null;
}

/** 索引文件名比对：大小写不敏感（Agent 写 index.md 不产生并列垃圾文件）。 */
function isIndexFileName(fileName: string): boolean {
  return fileName.toLowerCase() === EXPERIENCE_INDEX_FILE.toLowerCase();
}

/** 只读文件头部（frontmatter 所在处），至多 64KB。 */
function readHead(filePath: string, size: number): string {
  const length = Math.min(size, 64 * 1024);
  if (length <= 0) return '';
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * 经验文件名校验：basename（禁路径分隔符与 ..）、.md 后缀、长度上限。
 * INDEX.md 允许读（admin 预览）但写入/删除入口另行拒绝。
 */
export function isValidExperienceFileName(fileName: string): boolean {
  return typeof fileName === 'string'
    && fileName.length > 0
    && fileName.length <= MAX_FILE_NAME_LENGTH
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && !fileName.includes('..')
    && !fileName.includes('\0')
    && fileName.toLowerCase().endsWith('.md');
}
