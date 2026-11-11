/**
 * 管理后台容器运维契约（前后端共用，admin 消费）。
 *
 * 事实源是后端 `backend-ts/src/harness/container/container-registry.ts`
 * （ContainerRegistry 的 listEntries / recycleUser，经 `export type` re-export）。
 *
 * 容器键为 (userId, agentId)，容器名 `mao-user-{userId}-agent-{agentId}`；
 * tracked=false 表示 Docker 中存在但当前后端进程不在册（重启/崩溃遗留的残留容器）。
 */

/** 容器注册表摘要（不含用户 / Agent 名称；管理端列表行见 ContainerAdminRow）。 */
export interface ContainerEntrySummary {
  userId: number;
  agentId: number;
  containerName: string;
  state: 'running' | 'stopped';
  /** 当前进程是否在册；false = Docker 残留容器（不在注册表内）。 */
  tracked: boolean;
  busy: boolean;
  startedAtMs: number;
  lastUsedAtMs: number;
  /** 容器内 agent 上报的运行时版本；null = 旧 agent 未上报 / 未连接 / 未在册。 */
  runtimeBuild: string | null;
  /** 本实例加载的运行时版本；null = dist manifest 缺失（自动升级检查关闭）。 */
  hostRuntimeBuild: string | null;
  /** 代码漂移待收敛（tracked 且 running 且两者不一致）。 */
  pendingUpgrade: boolean;
  /** Docker `RunningFor` 原文（如 "About a minute"）；仅未在册行展示，在册行为 null。 */
  ageText: string | null;
}

/**
 * 管理后台「容器管理」列表行。
 * 在注册表摘要上补用户 / Agent 展示名，由 `GET /v1/admin/containers` 装配（listEntries 不查库）。
 * `userName` / `agentName` 为 null：对应用户或 Agent 已删除、不存在，或名称字段为空。
 */
export interface ContainerAdminRow extends ContainerEntrySummary {
  /** 用户展示名：显示名称，否则用户名。 */
  userName: string | null;
  /** Agent 名称。 */
  agentName: string | null;
}

/** 容器重建操作结果（管理后台「重建容器」）。removed = 未在册残留容器已删除，下次使用时按最新配置自动重建。 */
export type ContainerRecycleStatus = 'rebuilt' | 'none' | 'skipped-busy' | 'failed' | 'removed';

export interface ContainerRecycleResult {
  userId: number;
  /** 被回收的容器 agentId；null = 整用户聚合结果（未指定 agentId 的全量回收）。 */
  agentId: number | null;
  status: ContainerRecycleStatus;
  /** status='failed' 时的错误摘要。 */
  error?: string;
}
