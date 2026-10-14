import path from 'node:path';
import type { DockerToolRouter } from './docker-tool-router.js';
import type { SendBytesSupport } from '../tool/impl/send-file-bytes.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';

/**
 * 宿主机侧 SendBytesSupport 实现（技术方案 §5.8）：
 * - 容器用户：本地路径分支经 DockerToolRouter.readBytes 向容器请求字节；
 * - host 用户：返回 null（调用方降级为宿主机严格解析本地读）。
 * extraRoots 与容器内允许根同口径（§5.5）：当前用户 runtime/HOME + /tmp。
 */
export class DockerSendBytesBridge implements SendBytesSupport {
  constructor(
    private readonly deps: {
      router: DockerToolRouter;
      runtimeResolver: RuntimeDataResolver;
      runtimeDir: string;
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
      const home = this.deps.runtimeResolver.resolveUserHomeDir(userId);
      if (home) roots.push(home);
    }
    return roots;
  }
}
