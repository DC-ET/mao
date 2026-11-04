import path from 'node:path';
import type { DockerToolRouter } from './docker-tool-router.js';
import type { SendBytesSupport } from '../tool/impl/send-file-bytes.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';

/**
 * 宿主机侧 SendBytesSupport 实现（技术方案 §5.8）：
 * - 容器用户：本地路径分支经 DockerToolRouter.readBytes 向容器请求字节；
 * - host 用户：返回 null（调用方降级为宿主机严格解析本地读）。
 * extraRoots 与容器内允许根同口径（§5.5）：当前用户 runtime/HOME + /tmp +
 * uploads/{uid}（图片产物按用户隔离，generate_image/edit_image 落盘目录）。
 */
export class DockerSendBytesBridge implements SendBytesSupport {
  constructor(
    private readonly deps: {
      router: DockerToolRouter;
      runtimeResolver: RuntimeDataResolver;
      runtimeDir: string;
      /** 图片产物上传根（FILE_UPLOAD_DIR）：host 模式放行本人 {uploadDir}/{userId} 子目录。 */
      uploadDir: string;
      /**
       * uploads 产物公开 URL 的 origin 提供者（best-effort，形如 https://host）：
       * 缺省/失败时跨成员文案不带具体 URL（技术方案 2026-11-04 §5.9 第 3 条）。
       */
      uploadOriginProvider?: () => Promise<string | null>;
    },
  ) {}

  /**
   * 跨成员本地路径预检（技术方案 2026-11-04 §5.9 第 3 条）：词法判定，与容器分发无关，
   * host / docker 用户同一条文案。命中他人 runtime/uploads 目录时返回可执行指引。
   */
  async foreignPathMessage(src: string, userId: number | null, hint?: string | null): Promise<string | null> {
    if (userId == null || !path.isAbsolute(src)) return null;
    const uid = String(userId);
    const suffix = hint != null && hint !== '' ? `（${hint}）` : '';
    const resolved = path.resolve(src);
    const relativeUnder = (root: string): string | null => {
      const rel = path.relative(path.resolve(root), resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel;
    };
    const runtimeRel = relativeUnder(this.deps.runtimeDir);
    if (runtimeRel != null && runtimeRel.split(path.sep)[0] !== uid) {
      return '该文件属于其他成员的会话运行目录（当前执行身份 ' + userId
        + '），本地路径不可读且无公开 URL；请让该成员本人操作，或重新生成到共享位置（如群共享工作区）: '
        + resolved + suffix;
    }
    const uploadRel = relativeUnder(this.deps.uploadDir);
    if (uploadRel != null && uploadRel.split(path.sep)[0] !== uid) {
      const owner = uploadRel.split(path.sep)[0];
      const rest = uploadRel.split(path.sep).slice(1).join('/');
      const origin = await this.resolveUploadOrigin();
      if (origin != null && rest !== '') {
        return '该文件属于其他成员的产物目录（当前执行身份 ' + userId
          + '），本地路径不可读；该文件有公开 URL，请改用其转发: ' + origin + '/uploads/' + owner + '/' + rest + suffix;
      }
      return '该文件属于其他成员的产物目录（当前执行身份 ' + userId
        + '），本地路径不可读；该文件有公开 URL，可改用其转发（向系统索取链接），或让该成员本人操作: '
        + resolved + suffix;
    }
    return null;
  }

  private async resolveUploadOrigin(): Promise<string | null> {
    try {
      const origin = (await this.deps.uploadOriginProvider?.()) ?? null;
      return origin != null && origin.trim() !== '' ? origin.trim().replace(/\/+$/, '') : null;
    } catch {
      return null;
    }
  }

  async readBytes(input: {
    userId: number | null; sessionId: number | null; workspace: string | null; path: string; maxBytes: number;
  }): Promise<Buffer | null> {
    if (input.userId == null) return null;
    return this.deps.router.readBytes({
      userId: input.userId,
      sessionId: input.sessionId,
      workspace: input.workspace,
      path: input.path,
      maxBytes: input.maxBytes,
    });
  }

  extraRoots(userId: number | null): string[] {
    const roots: string[] = ['/tmp'];
    if (userId != null) {
      roots.push(path.join(path.resolve(this.deps.runtimeDir), String(userId)));
      roots.push(path.join(path.resolve(this.deps.uploadDir), String(userId)));
      const home = this.deps.runtimeResolver.resolveUserHomeDir(userId);
      if (home) roots.push(home);
    }
    return roots;
  }
}
