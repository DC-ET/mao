import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { ExperienceIndexService } from './experience-index.service.js';
import { ExperienceMountService } from './experience-mount.service.js';

const MOUNT = '团队经验';

function setup() {
  const base = useTmpDir('exp-mount-');
  const root = join(base, 'agent-experience');
  const indexService = new ExperienceIndexService(root);
  const mountService = new ExperienceMountService(indexService);
  const workspace = join(base, 'ws');
  mkdirSync(workspace, { recursive: true });
  return { base, root, indexService, mountService, workspace };
}

describe('ExperienceMountService', () => {
  it('creates symlink + bootstraps library dir and index, idempotent on re-run', () => {
    const { root, indexService, mountService, workspace } = setup();
    mountService.syncForSession(workspace, 42, true);
    const link = join(workspace, MOUNT);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(indexService.dirFor(42));
    expect(existsSync(join(root, '42', 'INDEX.md'))).toBe(true);

    // 幂等：重复挂载不报错、不重复建
    expect(() => mountService.syncForSession(workspace, 42, true)).not.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('re-points the link when the same project workspace is reused by another agent', () => {
    const { indexService, mountService, workspace } = setup();
    mountService.syncForSession(workspace, 1, true);
    mountService.syncForSession(workspace, 2, true);
    const link = join(workspace, MOUNT);
    expect(readlinkSync(link)).toBe(indexService.dirFor(2));
  });

  it('removes the stale link when disabled, and leaves non-symlink paths untouched', () => {
    const { mountService, workspace } = setup();
    mountService.syncForSession(workspace, 5, true);
    mountService.syncForSession(workspace, 5, false);
    expect(existsSync(join(workspace, MOUNT))).toBe(false);

    // 工作区内已有同名真实目录：不覆盖用户数据
    const occupied = join(workspace, MOUNT);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.md'), 'user data');
    expect(() => mountService.syncForSession(workspace, 5, true)).not.toThrow();
    expect(lstatSync(occupied).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(occupied, 'keep.md'), 'utf8')).toBe('user data');
  });

  it('appends 团队经验 to .git/info/exclude once for git workspaces only', () => {
    const { base, mountService, workspace } = setup();
    // 非 git 工作区：不产生 .git
    mountService.syncForSession(workspace, 7, true);
    expect(existsSync(join(workspace, '.git'))).toBe(false);

    // git 工作区：追加一次，幂等；保留既有内容
    const gitWs = join(base, 'gitws');
    mkdirSync(join(gitWs, '.git', 'info'), { recursive: true });
    writeFileSync(join(gitWs, '.git', 'info', 'exclude'), '.DS_Store\n');
    mountService.syncForSession(gitWs, 7, true);
    mountService.syncForSession(gitWs, 7, true);
    const exclude = readFileSync(join(gitWs, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.DS_Store');
    expect(exclude.split('\n').filter((l) => l === MOUNT).length).toBe(1);
  });

  it('deleting the workspace (rmSync recursive, same as SessionService) does not touch library contents', () => {
    const { base, root, mountService, workspace } = setup();
    mountService.syncForSession(workspace, 9, true);
    // Agent 已沉淀一篇经验（经链接写入）
    writeFileSync(join(workspace, MOUNT, '2026-10-24-x.md'), '---\ntitle: X\n---\n');
    rmSync(workspace, { recursive: true, force: true });
    expect(existsSync(workspace)).toBe(false);
    // 链接被删，库内容完好（锁死 rmSync 不跟随符号链接的行为依赖）
    expect(existsSync(join(root, '9', '2026-10-24-x.md'))).toBe(true);
  });

  it('refreshIndex=false short-circuits when the link is already correct, full-mounts when missing', () => {
    const { base, root, mountService, workspace } = setup();
    // 首次挂载（会话创建路径），再人为把索引改陈旧
    mountService.syncForSession(workspace, 31, true);
    const staleIndex = '# stale\n<!-- count: 99 -->\n';
    writeFileSync(join(root, '31', 'INDEX.md'), staleIndex);
    // 每轮兜底：链接正确 → 短路，不扫库刷索引（陈旧内容原样保留）
    mountService.syncForSession(workspace, 31, true, false);
    expect(readFileSync(join(root, '31', 'INDEX.md'), 'utf8')).toBe(staleIndex);
    // 链接缺失（存量会话首遇）→ 完整挂载：索引被重建
    rmSync(join(workspace, MOUNT));
    writeFileSync(join(root, '31', '2026-10-24-a.md'), '---\ntitle: A\n---\n');
    mountService.syncForSession(workspace, 31, true, false);
    expect(readFileSync(join(root, '31', 'INDEX.md'), 'utf8')).toContain('2026-10-24-a.md');
    expect(lstatSync(join(workspace, MOUNT)).isSymbolicLink()).toBe(true);
  });
});
