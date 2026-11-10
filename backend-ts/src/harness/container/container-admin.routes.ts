import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../../common/http-error.js';
import type { ContainerOps } from './container-registry.js';

export interface AdminContainerRouteDeps {
  containerOps: ContainerOps;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * 管理后台容器运维（Docker 模式）：
 * - `GET /v1/admin/containers`：容器列表 = 本进程在册容器 ∪ Docker 未在册残留容器
 *   （后台「容器管理」区块的数据源，也是「重建全部」的前端遍历来源）。
 *
 * 单用户重建在 user.routes（`POST /v1/users/:id/container/recycle`）。
 * 两个路径分别命中审计拦截器既有前缀 `/v1/admin`、`/v1/users`，变更操作自动留痕。
 * 权限统一为 `container:manage`（V177，默认授予管理员角色）。
 */
export function registerAdminContainerRoutes(app: FastifyInstance, deps: AdminContainerRouteDeps): void {
  app.get('/v1/admin/containers', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(deps.permissionService, userId, 'container:manage');
    return sendOk(reply, await deps.containerOps.listEntries());
  });
}
