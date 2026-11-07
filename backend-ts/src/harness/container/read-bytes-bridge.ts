import path from 'node:path';
import type { DockerToolRouter } from './docker-tool-router.js';
import { sendToolRoundContext, type SendBytesSupport } from '../tool/impl/send-file-bytes.js';
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
       * 会话 Agent id 查询（容器键第二维，2026-11-07 复合容器方案 §5.8）：send 工具的
       * 执行上下文只有 sessionId，容器路由所需的 agentId 由这里按会话解析。
       */
      sessionAgentIdOf(sessionId: number): Promise<number | null>;
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
   *
   * 只认「{root}/{纯数字 uid}/…」形态：uploads 根下还有平台平坦文件（{uuid}.png）与
   * releases/ 等非用户目录，runtime 根下有 channels/ 等运行期目录，均不参与跨成员判定，
   * 回落通用越界文案（避免把平台文件归因给「某位成员」并给出错误指引）。
   */
  async foreignPathMessage(src: string, userId: number | null, hint?: string | null): Promise<string | null> {
    if (userId == null || !path.isAbsolute(src)) return null;
    const uid = String(userId);
    // hint（如 edit_image 的「改图请重新生成，或由该成员本人操作」）替代/补充默认出路建议：
    // 替代是为了避免两句建议连读；补充是因为 URL 对不接受 URL 的调用方（edit_image）只能用于转发。
    const hintText = hint != null && hint !== '' ? hint : null;
    const resolved = path.resolve(src);
    const memberDirOf = (root: string): { owner: string; rest: string[] } | null => {
      const rel = path.relative(path.resolve(root), resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      const segments = rel.split(path.sep);
      if (!/^\d+$/.test(segments[0] ?? '')) return null;
      return { owner: segments[0]!, rest: segments.slice(1) };
    };
    const runtimeHit = memberDirOf(this.deps.runtimeDir);
    if (runtimeHit != null && runtimeHit.owner !== uid) {
      const advice = hintText ?? '请让该成员本人操作，或重新生成到共享位置（如群共享工作区）';
      return '该文件属于其他成员的会话运行目录（当前执行身份 ' + userId + '），本地路径不可读且无公开 URL；'
        + advice + '。路径: ' + resolved;
    }
    const uploadHit = memberDirOf(this.deps.uploadDir);
    if (uploadHit != null && uploadHit.owner !== uid) {
      const origin = await this.resolveUploadOrigin();
      const encodedRest = uploadHit.rest
        .filter((segment) => segment !== '')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      if (origin != null && encodedRest !== '') {
        const url = origin + '/uploads/' + uploadHit.owner + '/' + encodedRest;
        // 有 hint 时（edit_image 不接受 URL）URL 只标注转发用途，出路走 hint，避免引导无效重试。
        return '该文件属于其他成员的产物目录（当前执行身份 ' + userId + '），本地路径不可读；'
          + (hintText != null
            ? '该文件有公开 URL（可用于 send_* 转发）: ' + url + '；' + hintText
            : '该文件有公开 URL，请改用其转发: ' + url);
      }
      return '该文件属于其他成员的产物目录（当前执行身份 ' + userId + '），本地路径不可读；'
        + (hintText != null
          ? '该文件有公开 URL，可向系统索取链接用于转发；' + hintText
          : '该文件有公开 URL，可改用其转发（向系统索取链接），或让该成员本人操作')
        + '。路径: ' + resolved;
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
    // 容器键第二维（2026-11-07 复合容器方案 §5.6）：优先取 dispatcher 按轮快照放入
    // AsyncLocalStorage 的 agentId——轮中切 Agent 后与同轮 docker-only 工具路由到同一
    // 容器；快照缺失（host 用户 / 旧调用方）时按会话查库兜底。解析失败明确报错，不
    // 静默降级到宿主机读（容器内 /tmp 文件宿主机不存在，静默降级会把「无法路由」
    // 误导为「文件不存在」）。
    const fromRound = sendToolRoundContext.getStore()?.agentId;
    const agentId = fromRound != null
      ? fromRound
      : input.sessionId != null ? await this.deps.sessionAgentIdOf(input.sessionId) : null;
    if (agentId == null) {
      throw new Error(`容器读字节无法路由：会话不存在或缺少 Agent 维度 (sessionId=${input.sessionId})`);
    }
    return this.deps.router.readBytes({
      userId: input.userId,
      agentId,
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
