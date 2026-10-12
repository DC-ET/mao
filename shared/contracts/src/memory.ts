/**
 * 长期记忆契约（前后端共用，desktop / admin 同步消费）。
 *
 * 事实源是后端 `backend-ts/src/memory/types.ts`：那里持有运行时常量
 * （`MEMORY_SCOPES` / `MEMORY_STATUSES`）与校验守卫，并通过
 * `as const satisfies` 约束到本文件的联合类型。
 */

/** 作用域：USER 用户级（跨项目）/ PROJECT 项目级（按 projectKey 隔离）。 */
export type MemoryScope = 'USER' | 'PROJECT';

/** 状态：ACTIVE 生效中（注入 prompt）/ DISMISSED 已忽略（不再注入）。 */
export type MemoryStatus = 'ACTIVE' | 'DISMISSED';

/** 来源：AUTO 任务对话自动沉淀 / MANUAL 用户手工添加。 */
export type MemorySource = 'AUTO' | 'MANUAL';
