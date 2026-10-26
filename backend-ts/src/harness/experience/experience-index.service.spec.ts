import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { parseExperienceFrontmatter } from './experience-frontmatter.js';
import {
  ExperienceIndexService,
  EXPERIENCE_INDEX_FILE,
  indexTmpPath,
  isValidExperienceFileName,
} from './experience-index.service.js';

const DOC_A = `---
title: MySQL 死锁排查实录
keywords: mysql, 死锁, innodb
summary: 三步定位法
applicable: MySQL 8
last_verified: 2026-10-24
---

正文`;
const DOC_B = `---
title: 飞书卡片回滚
keywords: 飞书
---

正文`;

function emptyFields() {
  return { title: '', keywords: '', summary: '', applicable: '', lastVerified: '' };
}

describe('parseExperienceFrontmatter', () => {
  it('parses standard fields and tolerates missing ones', () => {
    const full = parseExperienceFrontmatter(DOC_A);
    expect(full).toMatchObject({
      title: 'MySQL 死锁排查实录',
      keywords: 'mysql, 死锁, innodb',
      summary: '三步定位法',
      applicable: 'MySQL 8',
      lastVerified: '2026-10-24',
    });
    const partial = parseExperienceFrontmatter(DOC_B);
    expect(partial.title).toBe('飞书卡片回滚');
    expect(partial.lastVerified).toBe('');
    expect(partial.summary).toBe('');
  });

  it('returns empty fields for missing, broken or non-object frontmatter', () => {
    expect(parseExperienceFrontmatter('no frontmatter')).toEqual(emptyFields());
    expect(parseExperienceFrontmatter('---\n{{{broken\n---\nbody').title).toBe('');
    expect(parseExperienceFrontmatter('---\n- a\n- b\n---\nbody').title).toBe('');
  });

  it('keeps inline --- inside values from cutting the block', () => {
    const parsed = parseExperienceFrontmatter('---\ntitle: 步骤 --- 详细\n---\nbody');
    expect(parsed.title).toBe('步骤 --- 详细');
  });

  it('accepts lastVerified alias and flattens multi-line values', () => {
    const parsed = parseExperienceFrontmatter('---\ntitle: T\nlastVerified: 2026-10-01\nsummary: |\n  第一行\n  第二行\n---\n');
    expect(parsed.lastVerified).toBe('2026-10-01');
    expect(parsed.summary).toBe('第一行 第二行');
  });
});

describe('isValidExperienceFileName', () => {
  it('accepts dated markdown basenames and rejects traversal or non-md names', () => {
    expect(isValidExperienceFileName('2026-10-24-mysql-deadlock.md')).toBe(true);
    expect(isValidExperienceFileName('2026-10-24-死锁排查.md')).toBe(true);
    expect(isValidExperienceFileName('../escape.md')).toBe(false);
    expect(isValidExperienceFileName('a/b.md')).toBe(false);
    expect(isValidExperienceFileName('a\\b.md')).toBe(false);
    expect(isValidExperienceFileName('notes.txt')).toBe(false);
    expect(isValidExperienceFileName('')).toBe(false);
  });
});

describe('ExperienceIndexService', () => {
  it('bootstraps an empty library with a header-only INDEX.md', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(join(root, 'agent-experience'));
    const dir = svc.dirFor(3);
    svc.ensureFresh(dir);
    const index = readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8');
    expect(index).toContain('请勿手改');
    expect(index).toContain('<!-- count: 0 -->');
  });

  it('generates sorted single-line index entries and refreshes on newer docs', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(5);
    svc.ensureFresh(dir);
    writeFileSync(join(dir, '2026-10-20-feishu-rollback.md'), DOC_B);
    writeFileSync(join(dir, '2026-10-24-mysql-deadlock.md'), DOC_A);
    svc.ensureFresh(dir);
    let index = readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8');
    expect(index).toContain('<!-- count: 2 -->');
    // 文件名倒序：新日期在前
    expect(index.indexOf('2026-10-24-mysql-deadlock.md')).toBeLessThan(index.indexOf('2026-10-20-feishu-rollback.md'));
    expect(index).toContain('MySQL 死锁排查实录 | mysql, 死锁, innodb | 三步定位法 | 验证 2026-10-24');
    // 缺失字段占位
    expect(index).toContain('飞书卡片回滚 | 飞书 | — | —');

    // 索引新于全部子文档：不重建（内容原样，mtime 未被动过）
    const before = readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8');
    svc.ensureFresh(dir);
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toBe(before);

    // shell 旁路写入（未触发回调）：索引陈旧，ensureFresh 自愈
    writeFileSync(join(dir, '2026-10-25-new-one.md'), '---\ntitle: 新经验\n---\n');
    utimesSync(join(dir, EXPERIENCE_INDEX_FILE), new Date('2026-01-01'), new Date('2026-01-01'));
    svc.ensureFresh(dir);
    index = readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8');
    expect(index).toContain('<!-- count: 3 -->');
    expect(index).toContain('2026-10-25-new-one.md');
  });

  it('tolerates malformed docs without dropping them from the index', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(7);
    svc.ensureFresh(dir);
    writeFileSync(join(dir, '2026-10-24-broken.md'), '---\n{{{bad yaml\n---\nbody');
    svc.ensureFresh(dir);
    const index = readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8');
    expect(index).toContain('2026-10-24-broken.md');
    // 无 title 回落文件名做标题列
    const line = index.split('\n').find((l) => l.includes('2026-10-24-broken.md'))!;
    expect(line).toContain('2026-10-24-broken.md | 2026-10-24-broken.md');
  });

  it('writeDoc/deleteDoc keep index in sync and enforce guards', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(9);
    svc.writeDoc(dir, '2026-10-24-a.md', DOC_A);
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toContain('2026-10-24-a.md');
    expect(svc.readDoc(dir, '2026-10-24-a.md')).toBe(DOC_A);
    expect(svc.readDoc(dir, 'missing.md')).toBeNull();

    svc.deleteDoc(dir, '2026-10-24-a.md');
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toContain('<!-- count: 0 -->');
    // 幂等删除
    expect(() => svc.deleteDoc(dir, '2026-10-24-a.md')).not.toThrow();

    expect(() => svc.writeDoc(dir, '../escape.md', 'x')).toThrow();
    expect(() => svc.writeDoc(dir, 'INDEX.md', 'x')).toThrow(/INDEX/);
    expect(() => svc.deleteDoc(dir, 'INDEX.md')).toThrow(/INDEX/);
    expect(() => svc.writeDoc(dir, 'big.md', 'x'.repeat(1024 * 1024 + 1))).toThrow(/大小上限/);
  });

  it('refreshIfUnderRoot only refreshes the matching numeric agent dir', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(11);
    svc.refreshIfUnderRoot(join(root, '11', '2026-10-24-x.md'));
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toContain('count: 0');

    // 经验根之外 / 非数字首段：静默跳过，不建目录
    svc.refreshIfUnderRoot(join(root, 'elsewhere', 'a.md'));
    svc.refreshIfUnderRoot(join(root, 'README.md'));
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });

  it('refreshIfUnderRoot follows workspace symlink paths (write-tool callback gets lexical path)', () => {
    // 回归（round-01 Bug 1）：写工具回调收到 <workspace>/团队经验/x.md 词法路径，
    // 不在经验根词法前缀下——必须 realpath 后命中 <root>/<agentId>/ 才刷新索引
    const base = useTmpDir('exp-link-');
    const root = join(base, 'agent-experience');
    const svc = new ExperienceIndexService(root);
    svc.ensureFresh(svc.dirFor(21));
    const workspace = join(base, 'ws');
    mkdirSync(workspace, { recursive: true });
    symlinkSync(svc.dirFor(21), join(workspace, '团队经验'), 'dir');
    // Agent 经链接写入子文档（文件真实落在库目录，路径仍是工作区词法路径）
    writeFileSync(join(workspace, '团队经验', '2026-10-24-via-link.md'), '---\ntitle: 链接写入\n---\n');
    expect(readFileSync(join(svc.dirFor(21), EXPERIENCE_INDEX_FILE), 'utf8')).toContain('count: 0');
    svc.refreshIfUnderRoot(join(workspace, '团队经验', '2026-10-24-via-link.md'));
    expect(readFileSync(join(svc.dirFor(21), EXPERIENCE_INDEX_FILE), 'utf8')).toContain('2026-10-24-via-link.md');
    // 不存在的词法路径（并发删除）静默跳过不抛错
    expect(() => svc.refreshIfUnderRoot(join(workspace, '团队经验', 'gone.md'))).not.toThrow();
  });

  it('rejects index.md in any letter case so no parallel junk file gets indexed', () => {
    // 回归（round-01 轻微）：小写 index.md 曾绕过字面比对，产生并列垃圾文件还被收录
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(13);
    svc.ensureFresh(dir);
    expect(() => svc.writeDoc(dir, 'index.md', 'x')).toThrow();
    expect(() => svc.writeDoc(dir, 'INDEX.MD', 'x')).toThrow();
    expect(() => svc.deleteDoc(dir, 'index.md')).toThrow();
    // 旁路落盘的小写 index.md 不进索引
    writeFileSync(join(dir, 'index.md'), 'junk');
    svc.rebuild(dir);
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toContain('count: 0');
    expect(svc.listDocs(dir)).toHaveLength(0);
  });

  it('scans frontmatter from the file head only, so oversized docs do not stall the scan', () => {
    const root = useTmpDir('exp-root-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(17);
    svc.ensureFresh(dir);
    const body = 'x'.repeat(200 * 1024);
    writeFileSync(join(dir, '2026-10-24-huge.md'), `---\ntitle: 大文档\nkeywords: huge\n---\n${body}`);
    const docs = svc.listDocs(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('大文档');
    expect(docs[0].sizeBytes).toBeGreaterThan(200 * 1024);
  });

  it('matches the real path even when the configured root itself sits behind a symlink', () => {
    // 回归（round-02 N1 + round-03 R3-1）：经验根配置路径含符号链接祖先（如 /tmp → /private/tmp）
    // 时，realpath 得到的全解析路径与词法根失配——须双根（词法 + realpath）比对；且根是懒创建的，
    // 服务构造先于根存在（首启时序），realpath 缓存必须懒解析而非构造时回退词法串
    const base = useTmpDir('exp-alias-');
    const realRoot = join(base, 'real-agent-experience');
    const aliasRoot = join(base, 'alias-agent-experience');
    // 首启时序：服务构造在前，根（含别名链接）尚未创建
    const svc = new ExperienceIndexService(aliasRoot);
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, aliasRoot, 'dir');
    // 经真实路径写入子文档，回调也收到真实路径（另一侧是词法路径的情形已由链接用例覆盖）
    const docPath = join(realRoot, '23', '2026-10-24-x.md');
    mkdirSync(join(realRoot, '23'), { recursive: true });
    writeFileSync(docPath, '---\ntitle: X\n---\n');
    svc.refreshIfUnderRoot(docPath);
    expect(readFileSync(join(aliasRoot, '23', EXPERIENCE_INDEX_FILE), 'utf8')).toContain('2026-10-24-x.md');
  });

  it('rejects symlinked doc files so container-created links cannot escape the library', () => {
    // share 改 rw 后容器内 shell 可在库内建链（ro 时代建不出来）：admin 读/写经链接
    // 会穿透到宿主任意路径——读视为不存在、写拒绝、扫描不收录
    const base = useTmpDir('exp-link-guard-');
    const svc = new ExperienceIndexService(join(base, 'agent-experience'));
    const dir = svc.dirFor(29);
    svc.ensureFresh(dir);
    const outside = join(base, 'secret.md');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, '2026-10-24-link.md'));

    expect(svc.listDocs(dir)).toHaveLength(0);
    expect(svc.readDoc(dir, '2026-10-24-link.md')).toBeNull();
    expect(() => svc.writeDoc(dir, '2026-10-24-link.md', 'evil')).toThrow(/符号链接/);
    expect(readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('refuses a library dir that was replaced by a symlink instead of writing through it', () => {
    const base = useTmpDir('exp-dir-guard-');
    const svc = new ExperienceIndexService(join(base, 'agent-experience'));
    const dir = svc.dirFor(31);
    svc.ensureFresh(dir);
    const outsideDir = join(base, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const victim = join(outsideDir, '2026-10-24-v.md');
    writeFileSync(victim, 'data');
    rmSync(dir, { recursive: true });
    symlinkSync(outsideDir, dir, 'dir');

    expect(() => svc.ensureFresh(dir)).toThrow(/符号链接/);
    expect(() => svc.writeDoc(dir, '2026-10-24-x.md', 'x')).toThrow(/符号链接/);
    expect(() => svc.deleteDoc(dir, '2026-10-24-v.md')).toThrow(/符号链接/);
    // 未穿透：宿主目标目录没有被写入索引，也没有被删除
    expect(existsSync(join(outsideDir, EXPERIENCE_INDEX_FILE))).toBe(false);
    expect(existsSync(victim)).toBe(true);
  });

  it('cleans a pre-existing INDEX.md.tmp symlink before the atomic write', () => {
    // 原子写先清残留再落盘：预置 .tmp 符号链接不会被写穿，最终索引仍是常规文件
    const base = useTmpDir('exp-tmp-guard-');
    const svc = new ExperienceIndexService(join(base, 'agent-experience'));
    const dir = svc.dirFor(32);
    svc.ensureFresh(dir);
    const outside = join(base, 'cron-target.md');
    writeFileSync(outside, 'orig');
    rmSync(join(dir, EXPERIENCE_INDEX_FILE));
    symlinkSync(outside, join(dir, `${EXPERIENCE_INDEX_FILE}.tmp`));

    svc.rebuild(dir);

    expect(lstatSync(join(dir, EXPERIENCE_INDEX_FILE)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, EXPERIENCE_INDEX_FILE), 'utf8')).toContain('count: 0');
    expect(readFileSync(outside, 'utf8')).toBe('orig');
    expect(existsSync(join(dir, `${EXPERIENCE_INDEX_FILE}.tmp`))).toBe(false);
  });

  it('索引 tmp 名带进程唯一后缀：连续两次不重复，不同进程不碰撞', () => {
    const first = indexTmpPath('/lib/INDEX.md');
    const second = indexTmpPath('/lib/INDEX.md');
    expect(first).not.toBe(second);
    expect(first).toMatch(new RegExp(`^/lib/INDEX\\.md\\.${process.pid}-\\d+\\.tmp$`));
    expect(second).toMatch(new RegExp(`^/lib/INDEX\\.md\\.${process.pid}-\\d+\\.tmp$`));
  });

  it('重建后库内不留任何 .tmp 残留（唯一名写坏也不积垃圾）', () => {
    const root = useTmpDir('exp-tmp-leftover-');
    const svc = new ExperienceIndexService(root);
    const dir = svc.dirFor(33);
    svc.ensureFresh(dir);
    writeFileSync(join(dir, '2026-10-24-doc.md'), DOC_A);
    svc.rebuild(dir);
    svc.rebuild(dir);
    svc.writeDoc(dir, '2026-10-25-doc.md', DOC_B);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['2026-10-24-doc.md', '2026-10-25-doc.md', EXPERIENCE_INDEX_FILE]);
  });
});
