import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';

/**
 * 容器挂载清单（技术方案 §5.1）：隔离边界即挂载清单。
 * 清单由本类单点生成并校验，调用点（ContainerRegistry）不得自行拼接 docker -v 参数。
 *
 * 路径空间原则（决策 15/16）：容器内绝对路径与宿主机逐字节一致，不做翻译。
 */
export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
  purpose: string;
}

export interface MountPlannerRoots {
  userHomeDir: string;
  runtimeDir: string;
  workspaceRoot: string;
  depsDir: string;
  userSkillsDir: string;
  channelDir: string;
  /** 只读项：后端 dist（runtime agent 代码）。 */
  distDir: string;
  /** 只读项：外部共享技能目录。 */
  skillsDir: string;
}

export class MountPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountPlanError';
  }
}

export class ContainerMountPlanner {
  constructor(private readonly roots: MountPlannerRoots) {}

  /**
   * 生成 userId 的挂载清单。生成后立即 assertSafe，任何不合法条目直接抛错
   * （宁可启动失败也不把越界挂载带进容器）。
   */
  plan(userId: number): ContainerMount[] {
    const u = String(userId);
    const mounts: ContainerMount[] = [
      { hostPath: this.under(this.roots.userHomeDir, u), containerPath: this.under(this.roots.userHomeDir, u), mode: 'rw', purpose: 'userHome' },
      { hostPath: this.under(this.roots.workspaceRoot, u), containerPath: this.under(this.roots.workspaceRoot, u), mode: 'rw', purpose: 'workspace' },
      { hostPath: this.under(this.roots.runtimeDir, u), containerPath: this.under(this.roots.runtimeDir, u), mode: 'rw', purpose: 'runtime' },
      { hostPath: this.under(this.roots.depsDir, u), containerPath: this.under(this.roots.depsDir, u), mode: 'rw', purpose: 'deps' },
      { hostPath: this.under(this.roots.channelDir, u), containerPath: this.under(this.roots.channelDir, u), mode: 'rw', purpose: 'channel' },
      { hostPath: this.under(this.roots.userSkillsDir, u), containerPath: this.under(this.roots.userSkillsDir, u), mode: 'rw', purpose: 'userSkills' },
      { hostPath: this.under(this.roots.distDir, ''), containerPath: this.under(this.roots.distDir, ''), mode: 'ro', purpose: 'dist' },
      { hostPath: this.under(this.roots.skillsDir, ''), containerPath: this.under(this.roots.skillsDir, ''), mode: 'ro', purpose: 'skills' },
    ];
    this.assertSafe(mounts, userId);
    return mounts;
  }

  /**
   * 校验规则（技术方案 §5.1）：
   * - 每条源路径必须位于已登记数据根之下（或 ro 项等于其根自身）；
   * - rw 项的源路径必须以 /{userId} 结尾或包含 /{userId}/ 段，拒绝任何上级目录；
   * - 只读项（dist/skills）不得被覆写为 rw；
   * - 源路径不得是另一个已登记数据根的父目录（如挂 /opt/mao-data 整体）；
   * - 符号链接源路径 realpath 后仍必须在登记根内（防链接逃逸）；
   * - 同一容器内路径不得重复挂载。
   */
  assertSafe(mounts: ContainerMount[], userId: number): void {
    const u = String(userId);
    const registeredRoots = [
      this.roots.userHomeDir, this.roots.runtimeDir, this.roots.workspaceRoot,
      this.roots.depsDir, this.roots.userSkillsDir, this.roots.channelDir,
      this.roots.distDir, this.roots.skillsDir,
    ].map((r) => path.resolve(r));

    const seenContainerPaths = new Set<string>();
    for (const mount of mounts) {
      const host = path.resolve(mount.hostPath);
      if (mount.containerPath !== host) {
        // 路径空间一致性：容器内路径必须与宿主机逐字节一致（决策 15）
        throw new MountPlanError(`mount ${mount.purpose}: container path must equal host path (${mount.containerPath} != ${host})`);
      }
      if (mount.mode !== 'ro' && mount.mode !== 'rw') {
        throw new MountPlanError(`mount ${mount.purpose}: invalid mount mode '${String(mount.mode)}'`);
      }
      const ro = mount.mode === 'ro';
      // 登记根校验：源路径必须等于某个登记根（仅 ro 项允许）或位于其下
      const owningRoot = registeredRoots.find((root) => host === root || host.startsWith(root + path.sep));
      if (!owningRoot) {
        throw new MountPlanError(`mount ${mount.purpose}: host path ${host} is not under any registered data root`);
      }
      if (!ro) {
        // rw 项必须含 userId 尾段/中间段，拒绝把整个数据根或上级挂进容器
        const rel = path.relative(owningRoot, host);
        if (!this.containsUserSegment(rel, u)) {
          throw new MountPlanError(`mount ${mount.purpose}: rw path ${host} must contain /${u}/ segment (got relative '${rel}')`);
        }
      }
      // 父目录防护：不得挂任何登记根的父目录（含 /opt/mao 与 /opt/mao-data 互为父子的场景）
      for (const root of registeredRoots) {
        if (root === host) continue;
        if (root.startsWith(host + path.sep) || root === host) {
          throw new MountPlanError(`mount ${mount.purpose}: ${host} is a parent of registered root ${root}`);
        }
      }
      // 符号链接逃逸：realpath 后必须仍在该条目声称的登记根之下
      if (existsSync(host)) {
        if (lstatSync(host).isSymbolicLink()) {
          const real = realpathSync(host);
          if (!real.startsWith(owningRoot + path.sep) && real !== owningRoot) {
            throw new MountPlanError(`mount ${mount.purpose}: symlink ${host} -> ${real} escapes registered root ${owningRoot}`);
          }
        }
      } else if (mount.mode === 'rw') {
        // rw 目录必须存在（容器启动前由宿主机创建）
        try { mkdirSync(host, { recursive: true }); } catch (e) {
          throw new MountPlanError(`mount ${mount.purpose}: cannot create host dir ${host}: ${(e as Error).message}`);
        }
      }
      if (seenContainerPaths.has(mount.containerPath)) {
        throw new MountPlanError(`mount ${mount.purpose}: duplicate container path ${mount.containerPath}`);
      }
      seenContainerPaths.add(mount.containerPath);
    }
  }

  /** 生成 docker -v 参数（assertSafe 通过后调用）。 */
  toDockerArgs(mounts: ContainerMount[]): string[] {
    const args: string[] = [];
    for (const m of mounts) {
      args.push('--volume', `${m.hostPath}:${m.containerPath}:${m.mode === 'ro' ? 'ro' : 'rw'}`);
    }
    return args;
  }

  /** 挂载清单审计日志（userId + 完整挂载表）。 */
  auditLog(userId: number, mounts: ContainerMount[]): void {
    for (const m of mounts) {
      harnessLog('info', `[container-mount] user=${userId} ${m.purpose}: ${m.hostPath} -> ${m.containerPath} (${m.mode})`);
    }
  }

  private containsUserSegment(rel: string, u: string): boolean {
    if (rel === u) return true;
    const parts = rel.split(path.sep);
    return parts.includes(u);
  }

  private under(root: string, leaf: string): string {
    return leaf === '' ? path.resolve(root) : path.join(path.resolve(root), leaf);
  }
}
