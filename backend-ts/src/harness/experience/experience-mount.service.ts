import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { EXPERIENCE_MOUNT_NAME, type ExperienceIndexService } from './experience-index.service.js';

/**
 * 工作区挂载服务（技术方案 2026-10-24 §3.3）：把 Agent 库目录以符号链接
 * `团队经验` 挂进会话工作区，Agent 用现成文件工具直接读写（不新增内置工具）。
 *
 * 符号链接而非虚拟路径映射：read/write/edit/grep/glob/shell 全部天然可用；
 * 沙箱两侧均已放行（宿主 addAllowedRoot(shareDir)；容器严格模式对「链接目标
 * 命中允许根」放行，见 path-sandbox assertNoSymlinkEscape）。
 *
 * 幂等：项目/git 工作区跨会话共享，换 Agent 的会话重挂时自动重指；关开关后移除链接。
 */
export class ExperienceMountService {
  constructor(private readonly indexService: ExperienceIndexService) {}

  /**
   * 会话创建时同步挂载。enabled=false：移除残留链接即返回（保证关开关后不再暴露）。
   * 失败由调用方（SessionService）降级记日志，不阻断会话创建。
   */
  syncForSession(workspace: string, agentId: number, enabled: boolean): void {
    const linkPath = path.join(workspace, EXPERIENCE_MOUNT_NAME);
    if (!enabled) {
      removeSymlinkIfPresent(linkPath);
      return;
    }
    // 先建库目录并刷新索引（空库引导出带表头的 INDEX.md），再挂链接——
    // Agent 挂载瞬间看到的 INDEX.md 一定是合法内容
    this.indexService.ensureFresh(this.indexService.dirFor(agentId));
    ensureDirSymlink(this.indexService.dirFor(agentId), linkPath);
    appendGitLocalExclude(workspace);
  }
}

function removeSymlinkIfPresent(linkPath: string): void {
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      unlinkSync(linkPath);
    }
  } catch {
    // 不存在即无残留
  }
}

function ensureDirSymlink(target: string, linkPath: string): void {
  let st;
  try {
    st = lstatSync(linkPath);
  } catch {
    st = null;
  }
  if (st == null) {
    symlinkSync(target, linkPath, 'dir');
    return;
  }
  if (!st.isSymbolicLink()) {
    // 工作区内已有同名真实文件/目录（早于本功能由 Agent 创建）：不覆盖用户数据，仅告警
    harnessLog('warn', `experience mount skipped: ${linkPath} exists and is not a symlink`);
    return;
  }
  const current = readlinkSync(linkPath);
  if (path.resolve(path.dirname(linkPath), current) === path.resolve(target)) return;
  unlinkSync(linkPath);
  symlinkSync(target, linkPath, 'dir');
}

/**
 * git/项目工作区是真实检出：链接会污染 git status 且可能被误提交。
 * 写 .git/info/exclude（本地生效、不入库、不影响远端）。幂等追加。
 * 仅处理 .git 为目录的普通检出；.git 为文件（worktree/子模块）不适用，跳过。
 */
function appendGitLocalExclude(workspace: string): void {
  const gitDir = path.join(workspace, '.git');
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const infoDir = path.join(gitDir, 'info');
    if (!existsSync(infoDir)) {
      mkdirSync(infoDir, { recursive: true });
    }
    const excludePath = path.join(infoDir, 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').some((line) => line.trim() === EXPERIENCE_MOUNT_NAME)) return;
    const next = existing.length === 0 || existing.endsWith('\n')
      ? existing + EXPERIENCE_MOUNT_NAME + '\n'
      : existing + '\n' + EXPERIENCE_MOUNT_NAME + '\n';
    writeFileSync(excludePath, next);
  } catch (e) {
    harnessLog('warn', `git local exclude append failed for ${workspace}: ${(e as Error).message}`);
  }
}
