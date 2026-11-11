import type { FastifyInstance } from 'fastify';
import type { ContainerAdminRow, ContainerEntrySummary } from '@mao/contracts';
import { requirePermission, requireUserId, sendOk } from '../../common/http-error.js';
import { collectEntityIds, parseEntityId } from '../../common/request.js';
import type { ContainerOps } from './container-registry.js';

/** 名称装配只读到的用户 / Agent 字段（findByIds 的行是超集，结构上兼容）。 */
export interface ContainerUserRef {
  id?: number | string | null;
  username?: string | null;
  displayName?: string | null;
}

export interface ContainerAgentRef {
  id?: number | string | null;
  name?: string | null;
}

export interface AdminContainerRouteDeps {
  containerOps: ContainerOps;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  userLookup: { findByIds(ids: number[]): Promise<ContainerUserRef[]> };
  agentLookup: { findByIds(ids: number[]): Promise<ContainerAgentRef[]> };
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function indexById<T extends { id?: number | string | null }>(rows: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    const id = parseEntityId(row.id);
    if (id != null) map.set(id, row);
  }
  return map;
}

/** 给容器行补展示名。用户优先显示名称，否则用户名；查不到或名称为空则为 null。 */
export function attachContainerNames(
  rows: ContainerEntrySummary[],
  users: ContainerUserRef[],
  agents: ContainerAgentRef[],
): ContainerAdminRow[] {
  const userById = indexById(users);
  const agentById = indexById(agents);
  return rows.map((row) => {
    const user = userById.get(row.userId);
    return {
      ...row,
      userName: textOrNull(user?.displayName) ?? textOrNull(user?.username),
      agentName: textOrNull(agentById.get(row.agentId)?.name),
    };
  });
}

/**
 * 管理后台容器运维（Docker 模式）：
 * - `GET /v1/admin/containers`：容器列表 = 本进程在册容器 ∪ Docker 未在册残留容器，
 *   并补上用户展示名（显示名称，否则用户名）与 Agent 名称
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
    const rows = await deps.containerOps.listEntries();
    const userIds = collectEntityIds(rows.map((row) => row.userId));
    const agentIds = collectEntityIds(rows.map((row) => row.agentId));
    const [users, agents] = await Promise.all([
      userIds.length > 0 ? deps.userLookup.findByIds(userIds) : Promise.resolve([]),
      agentIds.length > 0 ? deps.agentLookup.findByIds(agentIds) : Promise.resolve([]),
    ]);
    return sendOk(reply, attachContainerNames(rows, users, agents));
  });
}
