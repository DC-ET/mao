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
    },
  ) {}

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
