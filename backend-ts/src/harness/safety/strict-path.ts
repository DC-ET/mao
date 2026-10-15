import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isUnder, SecurityException } from './path-sandbox.js';

/**
 * 宿主机侧越界收口共用解析器（技术方案 §5.9 / §5.8）。
 *
 * 与 PathSandbox 全局实例的区别：不读 allowedRoots（宿主机沙箱的允许根是跨用户
 * 动态累积的），只认调用方显式给出的根——REST 文件服务以会话工作区为唯一根，
 * 外部发送工具以「工作区 + 当前用户 runtime/HOME + /tmp」为根。跨用户路径一律拒绝。
 *
 * 校验口径与 workspace-write.service.resolveWritable 一致：词法解析 + 已存在部分
 * realpath 后再验归属（防符号链接逃逸；叶子尚未创建时逐段向上找最深的已存在祖先）。
 */
export class StrictPathResolver {
  /** 词法根 + 各根 realpath 的并集：根自身是符号链接时两种形态都放行。 */
  private readonly lexicalRoots: string[];
  private readonly realRoots: string[];

  /**
   * @param primaryRoot 相对路径的解析基准（通常是会话工作区）
   * @param extraRoots 额外允许的绝对根（当前用户的 runtime/HOME、/tmp 等）
   */
  constructor(primaryRoot: string, extraRoots: string[] = []) {
    const all = [primaryRoot, ...extraRoots].map((r) => path.resolve(r));
    this.realRoots = all.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        // 根不存在（尚未创建）时退回词法路径；挂载/写入阶段会先建目录
        return r;
      }
    });
    this.lexicalRoots = [...all, ...this.realRoots];
  }

  /**
   * 解析用户输入路径并校验归属。相对路径基于 primaryRoot；绝对路径必须落在
   * 任一登记根之内。越界抛 SecurityException。
   */
  resolve(userPath: string): string {
    if (userPath == null || userPath === '') {
      throw new SecurityException('Path cannot be empty');
    }
    if (userPath.startsWith('~')) {
      throw new SecurityException('Tilde paths are not supported on server: ' + userPath);
    }
    const resolved = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(this.lexicalRoots[0], userPath);

    if (!this.lexicalRoots.some((root) => isUnder(resolved, root))) {
      throw new SecurityException('Path escape attempt: ' + userPath);
    }

    // 已存在部分 realpath 后必须仍在根内：防 workspace/link -> /etc 这类符号链接逃逸
    const real = realpathOfExisting(resolved);
    if (real != null && !this.realRoots.some((root) => isUnder(real, root))) {
      throw new SecurityException('Path escape attempt (symlink): ' + userPath);
    }
    return resolved;
  }
}

/** 返回路径已存在部分的 realpath；整条链都不存在时返回 null。 */
function realpathOfExisting(resolved: string): string | null {
  let current = resolved;
  for (let depth = 0; depth < 64; depth++) {
    try {
      return realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}
