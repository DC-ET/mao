# Agent「客户端可见」开关技术方案

> 版本：v1.0（2026-10-21）
> 状态：已实施（2026-10-21，见 CHANGELOG 0.0.323）
> 实施记录：Bundle 字段按建议纳入（§4.6）；「全部 Agent 均不可见」采用列表页顶部警示条（非保存拦截）。
> 关联：2026-10-20 会话 Agent 身份可见性改造；2026-10-21 讨论「新建会话是否展示全部 Agent」
> 决策确认（2026-10-21）：① 默认 Agent **不允许**关闭客户端可见；② 开放接口 / 信号哨兵等客户端其他入口**不过滤**，仅新建会话选择列表过滤。

## 0. 决策摘要

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 可见性语义 | 新增 `agent.client_visible`，与 `enabled` **分离**：`enabled=0` 是运行时停用（已绑定会话不可执行、admin 不能停用默认 Agent）；`client_visible=0` 只表示「新建会话选择列表不展示」，不影响已绑定会话、不影响任何按 `agentId` 指定的入口 |
| 2 | 数据默认值 | `client_visible TINYINT NOT NULL DEFAULT 1`：升级后存量 Agent 全部保持可见，管理后台无感 |
| 3 | 默认 Agent 保护 | 双向校验：默认 Agent 不能关闭客户端可见；客户端不可见的 Agent 不能设为默认（与现有「不能停用默认 Agent」同口径） |
| 4 | 列表过滤范围 | 仅 `GET /v1/agents?scope=client` 过滤；不传参数保持全量（管理后台、开放接口、信号哨兵、搜索均不受影响） |
| 5 | 客户端过滤点 | 新建会话选择器（`stores/agent.ts` 的 `fetchAgents`）+ 团队共享目录（服务端 `listSharedAgents`） |
| 6 | 老会话 | 不受影响：`GET /agents/:id` 不做可见性校验，会话身份展示与继续对话照常 |
| 7 | 管理后台 | Agent 表单加开关（默认开）、列表加「仅管理端」标记；复制 Agent 继承原可见性 |
| 8 | Bundle 导入导出 | 纳入 `clientVisible`（可选字段，旧 bundle 缺失时按可见处理），避免跨实例搬运意外暴露 |

## 1. 背景与问题

### 1.1 现状

- `GET /v1/agents` 的仓储查询只过滤逻辑删除与 `enabled = 1`（`agent.repository.ts:18-32`），service 入参 `_userId` 未使用（`agent.service.ts:30`）——**返回全平台所有启用 Agent，不按创建者/使用者过滤**。
- 客户端 `stores/agent.ts:fetchAgents` 直接消费该列表，新建会话的 `AgentChip` / `AgentSelector` 因此展示全部启用 Agent。
- 管理后台另有 `enabled` 开关（列表「停用/启用」），但停用会让已绑定会话无法执行（`harness` 侧按 `session.agentId` 取 Agent 后校验），且默认 Agent 被禁止停用（`agent.service.ts:158-168`）。因此 `enabled` 无法承担「先别让用户看到，但老会话还能用」的产品诉求。

### 1.2 目标

1. 管理后台可按 Agent 配置「客户端可见」，关闭后**新建会话的选择列表**不再出现该 Agent。
2. 已绑定该 Agent 的历史会话完全不受影响：能继续对话、能正常显示身份（Tab 头像 / 工具条徽标 / 右栏分区）。
3. 不影响按 `agentId` 显式指定的入口：定时任务、信号哨兵、开放接口、飞书/钉钉渠道。
4. 升级零配置：所有存量 Agent 默认可见。

### 1.3 非目标

- 不做按用户 / 部门 / 用户组的细粒度授权（当前 Agent 本身是全平台共享资产，本次只做单开关）。
- 不做按渠道（Web / 飞书 / 钉钉 / embed）区分的可见性。
- 不改 Agent 运行时装配链路（`harness-service.buildContext` 仍按 `session.agentId` 取 Agent，不做可见性校验）。
- 不做「批量隐藏」「按创建人默认取值」等运营工具。

## 2. 现状盘点（代码事实）

| 项 | 现状 | 位置 |
|---|---|---|
| Agent 表 | `id/name/description/system_prompt/model_id/creator_id/config_json/...`，V119 追加 `enabled` | `db/migration/V001__init_schema.sql:73-83`、`V119__agent_enabled.sql:1-2` |
| 列表查询 | `selectList(keyword, includeDisabled)`：`not_deleted()` + 可选 `enabled = 1`，按 `is_default DESC, created_at DESC` | `agent.repository.ts:18-32` |
| 列表路由 | `GET /v1/agents` 支持 `keyword`、`includeDisabled`（后者需 `agent:read`/`agent:write`） | `agent.routes.ts:75-86` |
| VO 契约 | `AgentVO` 在共享包，含 `isDefault` / `enabled` / `defaultModelId` | `shared/contracts/src/agent.ts:22-41` |
| 编辑路由 | **`PUT /v1/agents/:id`**（管理后台表单走 PUT，不是 PATCH） | `agent.routes.ts:120-139`、`admin/src/views/agent/AgentFormDialog.vue:736` |
| 启停路由 | `PATCH /v1/agents/:id/enabled`，默认 Agent 禁止停用 | `agent.routes.ts:165-173`、`agent.service.ts:158-168` |
| 写入映射 | `updateById` / `insert` 用 camelCase → snake_case 自动转换，字段需显式列出 | `db/db.ts:55-63`、`agent.repository.ts:59-78`、`:91-102` |
| 客户端列表 | `agentStore.fetchAgents` 并行拉 `/agents` 与 `/shared-agents`，过滤 `enabled !== false` | `desktop/src/stores/agent.ts:35-62` |
| 共享目录 | `listSharedAgents` 只跳过 `!agent || agent.enabled === 0` | `shared-agent.service.ts:133-142` |
| 管理表单 | `form` 字段固定、提交 payload 手写；复制模式 `Object.assign` 回填 | `AgentFormDialog.vue:320-331`、`:589-604`、`:710-730` |
| 管理列表 | 「状态」列宽 88，只区分启用/停用 | `AgentListView.vue:64-70` |
| Bundle | 导入时 `enabled: 1` 写死，`BundleAgent` 无可见性字段 | `agent-bundle.service.ts:403-425`、`agent-bundle.types.ts:13-19` |

## 3. 数据模型

新增迁移 `V164__agent_client_visible.sql`（当前最新为 V163）：

```sql
-- 客户端新建会话可选性：与 enabled（运行时停用）分开，避免隐藏动作影响已绑定会话
ALTER TABLE `agent`
    ADD COLUMN `client_visible` TINYINT NOT NULL DEFAULT 1
    COMMENT '1-客户端新建会话可选 0-仅管理端可见' AFTER `enabled`;
```

说明：

- 默认 1，存量数据自动可见；无需数据回填。
- 不加索引：列表已按 `enabled` 过滤后规模很小，且 `client_visible` 基数极低（0/1），索引无收益。
- 列名与 `enabled` 保持同风格（`snake_case` + TINYINT + 中文 COMMENT）。

## 4. 后端改造

### 4.1 类型

`backend-ts/src/agent/types.ts`：

```ts
export interface Agent {
  // ...
  /** 1-启用 0-停用；缺省视为启用 */
  enabled?: number | null;
  /** 1-客户端新建会话可选 0-仅管理端可见；缺省视为可见 */
  clientVisible?: number | null;
}
```

`shared/contracts/src/agent.ts`（`AgentVO`）：

```ts
/** false = 客户端新建会话不展示；不影响已绑定会话与按 agentId 指定的入口 */
clientVisible?: boolean;
```

### 4.2 仓储

`agent.repository.ts`：

```ts
selectList(keyword?: string | null, includeDisabled = false, clientVisibleOnly = false): Promise<Agent[]> {
  const where: string[] = [notDeleted()];
  if (!includeDisabled) where.push('enabled = 1');
  if (clientVisibleOnly) where.push('client_visible = 1');
  // ...
}
```

- `insert` 增加 `clientVisible: agent.clientVisible ?? 1`
- `updateById` 的字段列表增加 `clientVisible: agent.clientVisible ?? 1`

> 现有 `tx.updateById('agent', id, {...})` 是全字段覆盖，漏写会重置为默认值；新列必须在两处都补。

### 4.3 服务层

`agent.service.listAgents` 增加透传参数：

```ts
listAgents(_userId: number, keyword?: string | null, includeDisabled = false, clientVisibleOnly = false) {
  return this.agentRepo.selectList(keyword, includeDisabled, clientVisibleOnly);
}
```

`createAgent` / `updateAgent` 增加 `clientVisible?: boolean | null`，并做**最终状态**校验（先合并出 next 值，再校验，避免「同一次请求同时改两个字段」的顺序依赖）：

```ts
// updateAgent 内
const nextClientVisible = clientVisible == null
  ? (agent.clientVisible ?? 1)
  : (clientVisible ? 1 : 0);
const nextIsDefault = isDefault ?? agent.isDefault ?? 0;
if (nextIsDefault === 1 && nextClientVisible === 0) {
  throw new BusinessException(ErrorCode.PARAM_INVALID,
    '默认 Agent 必须客户端可见，请先更改默认 Agent 或开启客户端可见');
}
agent.clientVisible = nextClientVisible;
```

- 只校验「默认 + 不可见」这一种非法组合，不阻断其它保存路径。
- `createAgent`：`clientVisible` 缺省为 1；若 `isDefault=1 && clientVisible=false` 同样拒绝（表单不会这么传，但接口需兜底）。
- 与 `setEnabled` 的关系：`setEnabled(false)` 仍禁止默认 Agent；`clientVisible=false` 不触碰 `enabled`，老会话可继续执行。

### 4.4 路由

`GET /v1/agents`：

```ts
const scope = queryOptStr(request, 'scope');
if (scope != null && scope !== 'client') {
  throw new BusinessException(ErrorCode.PARAM_INVALID, "scope 仅支持 'client'");
}
const agents = await agentService.listAgents(
  userId, keyword, includeDisabled, scope === 'client',
);
```

- 不传 `scope` → 全量（管理后台、开放接口、信号哨兵、搜索保持现状）。
- 非法值直接返回业务错误（HTTP 200 + `code=PARAM_INVALID`，项目统一 Result 约定），避免拼写错误静默退化成全量。
- `includeDisabled` 与 `scope=client` 可同时出现，但客户端不会传前者。

`PUT /v1/agents/:id` 与 `POST /v1/agents`：`UpdateAgentRequest` / `CreateAgentRequest` 增加 `clientVisible?: boolean | null`，透传给 service。

`toVO`：`clientVisible: agent.clientVisible !== 0`。

### 4.5 共享目录

`shared-agent.service.listSharedAgents`：

```ts
if (!agent || agent.enabled === 0 || agent.clientVisible === 0) continue;
```

理由：共享目录是客户端的新建入口之一，隐藏 Agent 若仍出现在这里，用户点选后依旧创建会话，开关形同虚设。

### 4.6 Bundle 导入导出（建议纳入）

- `BundleAgent` 增加 `clientVisible?: boolean`（可选，保持格式向后兼容）。
- 导出：`clientVisible: agent.clientVisible !== 0`。
- 导入：`clientVisible: raw.clientVisible === false ? 0 : 1`（旧 bundle 缺失字段按可见处理，与现状一致）。
- 更新 `docs/guides/agent-bundle-format.md` 字段表。
- 若本次不做，需注意：从隐藏 Agent 导出的 bundle 导入到另一实例后会变成可见——属于可接受但需记录的行为差异。**建议纳入**，改动量约 20 行。

## 5. 管理后台改造

### 5.1 表单开关

`admin/src/views/agent/AgentFormDialog.vue`：

- `form` 增加 `clientVisible: true`。
- 基础信息 tab 在「设为默认 Agent」开关旁新增：

```vue
<el-form-item label="客户端可见">
  <el-switch
    v-model="form.clientVisible"
    :disabled="form.isDefault"
  />
  <span class="form-hint">
    关闭后仅影响客户端「新建会话」的智能体列表；已绑定该 Agent 的会话不受影响。
    默认 Agent 必须保持可见。
  </span>
</el-form-item>
```

- 回填：`clientVisible: props.agentData.clientVisible !== false`。
- 复制：沿用原 Agent 的可见性（`Object.assign` 已覆盖，无需特殊处理）。
- 提交 payload：`clientVisible: form.clientVisible`。
- 交互细节：`form.isDefault === true` 时开关禁用 + tooltip「默认 Agent 必须客户端可见，请先更改默认 Agent」；若用户先把开关关掉再勾默认，前端在勾默认时自动回弹并提示（提交时后端仍会兜底拒绝）。

### 5.2 列表标记

`AgentListView.vue` 状态列（当前宽 88）改为宽 150，同时展示两个维度：

```vue
<el-table-column label="状态" width="150">
  <template #default="{ row }">
    <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
      {{ row.enabled === false ? '停用' : '启用' }}
    </el-tag>
    <el-tag v-if="row.clientVisible === false" type="warning" size="small" class="ml-4">仅管理端</el-tag>
  </template>
</el-table-column>
```

- 移动端卡片列表（`mobile-card-list`）同步补「仅管理端」标签。
- 不在列表增加筛选条件（本次只解决可见性配置；若后续 Agent 数量增长再加）。

## 6. 客户端改造

### 6.1 新建会话列表

`desktop/src/stores/agent.ts`：

```ts
api.get('/agents', { params: { scope: 'client' } })
```

- 影响面：`AgentChip`（居中态 / 移动 meta 行）、`AgentSelector`（docked 新建态）共用该 store，天然生效。
- `sharedAgents` 来自 `/shared-agents`，服务端已过滤，无需前端再过滤。
- `AgentChip` 现有的 `agents.length === 0` 空态「暂无可用智能体」可直接复用；若全部 Agent 被隐藏，用户会看到空态且无法发送（`ChatInput.vue:287` 的「未选 Agent 不允许发送」保护）。

### 6.2 默认 Agent 回退（无需改代码，但需确认）

`TaskView.resolveNewTaskDefaults` 取 `agentStore.agents.find(a => a.isDefault)`。由于列表已过滤，被隐藏的默认 Agent 不会出现在列表里，自动回退到 `agents[0]`；全部不可见时 `agentId` 为 `null`，触发「未选 Agent 不允许发送」。

> 该行为依赖「默认 Agent 不允许隐藏」的后端保护：正常配置下不会出现「默认 Agent 被隐藏」的组合；即使通过直接改库绕过，客户端也只会在可见集合里选，不会预选一个看不见的 Agent。

### 6.3 保持全量的客户端入口（按决策 ②）

以下位置继续调用不带 `scope` 的 `GET /agents`，能看到隐藏 Agent：

| 入口 | 文件 | 原因 |
|---|---|---|
| 开放接口配置 | `desktop/src/views/settings/OpenApiView.vue:477` | 给已有开放接口指定 Agent |
| 信号哨兵 | `desktop/src/views/settings/SignalWatchersView.vue:351` | 给已有哨兵指定 Agent |
| 会话搜索的 Agent 过滤 | `desktop/src/components/search/SessionSearchPopover.vue:196` | 需要按任意 Agent 过滤历史会话 |

> 注意：这三处不经过 `agentStore.fetchAgents`，各自发请求；本次不改。

### 6.4 老会话身份展示

`GET /agents/:id` 不做可见性校验；`AgentBadge` / `CenterTabBar` 的身份解析优先用 `activeAgent`（`loadSession` 已拉取），因此隐藏 Agent 的会话仍能显示头像、名称与描述。无需改动。

## 7. 边界与异常

| # | 场景 | 处理 |
|---|---|---|
| 1 | 把默认 Agent 设为不可见 | 业务错误「默认 Agent 必须客户端可见」；表单开关禁用 |
| 2 | 把不可见 Agent 设为默认 | 同一校验，返回同样的业务错误 |
| 3 | 关闭可见后，已绑定该 Agent 的会话 | 照常加载、显示身份、继续执行；仅新建列表不可见 |
| 4 | 关闭可见后，共享目录条目 | `listSharedAgents` 过滤，不再出现在「团队共享」分区 |
| 5 | 全部 Agent 均不可见 | 客户端新建会话显示「暂无可用智能体」，发送被拦截；建议 admin 列表给出空态提示（P1 可选） |
| 6 | 直接调用 `POST /sessions` 指定隐藏 agentId | 允许（可见性不是权限边界）；与开放接口/定时任务同口径 |
| 7 | 复制 Agent | 继承原可见性（`Object.assign` 回填） |
| 8 | 从隐藏 Agent 导出 bundle 再导入 | 携带 `clientVisible=false`，导入后仍隐藏；旧 bundle 无该字段时按可见处理 |
| 9 | 升级存量数据 | 迁移默认 1，全部可见，无行为变化 |
| 10 | 非法 `scope` 值 | 业务错误（code≠0），避免静默退化为全量 |
| 11 | `enabled=0` 且 `client_visible=0` | 允许，语义正交；客户端两处都看不到，admin 列表显示两个标签 |
| 12 | 管理后台无 `agent:write` | 只能看，不能改开关（沿用现有权限） |

## 8. 测试与验收

### 8.1 后端单测

- `agent.repository.spec.ts`：`selectList(..., clientVisibleOnly=true)` 生成的 SQL 含 `client_visible = 1`；默认不追加该条件。
- `agent.service.spec.ts`：
  - 默认 Agent 关闭可见 → 抛 `PARAM_INVALID`；
  - 不可见 Agent 设默认 → 抛 `PARAM_INVALID`；
  - 非默认 Agent 关闭可见 → 成功且 `clientVisible=0`；
  - `clientVisible` 缺省时不改动原值。
- `agent.routes.spec.ts`：
  - `GET /v1/agents?scope=client` 透传 `clientVisibleOnly=true`；
  - `GET /v1/agents?scope=foo` → 业务错误（code≠0）；
  - `PUT /v1/agents/:id` 带 `clientVisible:false` 时写入；
  - `toVO` 输出 `clientVisible` 布尔值（`undefined` 视为 true）。

### 8.2 管理后台 E2E

新增 `tests/admin-agent-client-visible.spec.ts`，沿用 `tests/admin-agent-enabled.spec.ts` 的 mock 登录方式：

1. 列表渲染：`clientVisible: false` 的行显示「仅管理端」标签；默认 Agent 不显示。
2. 表单：打开编辑 → 关闭「客户端可见」→ 保存 → 断言 `PUT /agents/:id` 的 payload 含 `clientVisible: false`。
3. 默认 Agent：编辑默认 Agent 时开关为 disabled。

### 8.3 客户端验证

- `stores/agent` 单测（如现有测试基础设施允许）或 Playwright 断言请求 URL 含 `scope=client`：
  - 在 `tests/desktop-session-agent-identity.spec.ts` 的 mock 中记录 `/agents` 请求 URL，断言带 `scope=client`；
  - 断言列表过滤后 `AgentChip` 只渲染可见项（mock `/agents?scope=client` 返回 1 个，全量返回 2 个）。
- 老会话不受影响：现有 `desktop-session-agent-identity` 用例继续覆盖（`/agents/:id` 仍返回隐藏 Agent）。

### 8.4 手工验收

- [ ] 管理后台关闭某 Agent 的「客户端可见」→ 客户端刷新 → 新建会话列表不出现该 Agent。
- [ ] 该 Agent 的历史会话仍可打开、继续对话，Tab 头像 / 工具条徽标 / 右栏分区正常。
- [ ] 团队共享目录不再出现该 Agent。
- [ ] 默认 Agent 的表单开关禁用，直接调接口关闭返回业务错误 + 明确文案。
- [ ] 把隐藏 Agent 设为默认 → 业务错误。
- [ ] 复制一个隐藏 Agent → 副本仍为「仅管理端」。
- [ ] `enabled` 与 `clientVisible` 组合的四种状态在列表上可区分。
- [ ] 全部隐藏时新建会话显示空态且无法发送。

## 9. 发布与回滚

1. 迁移先行：`V164__agent_client_visible.sql` 随后端启动由 Flyway 自动执行。
2. 后端先具备 `scope` 参数与新字段，再发 admin / desktop 静态资源（同仓一次发布即可；旧前端不传 `scope` 时行为不变，向后兼容）。
3. 回滚：
   - 前端回滚 → 不再传 `scope=client`，列表回到全量（隐藏 Agent 重新可见），无故障；
   - 后端回滚 → 新列保留但无代码引用，无害；不建议删列。
4. 交付物同步：`CHANGELOG.md`（新版本条目，前端 + 管理后台）、`skills/mao-cli/reference/desktop.md`（新建会话列表说明）、`docs/guides/agent-bundle-format.md`（若纳入 bundle）。

## 10. 工作量估算

| 任务 | 文件 | 预估 |
|---|---|---|
| 迁移 + 类型 + 仓储 | `V164__agent_client_visible.sql`、`agent/types.ts`、`agent.repository.ts` | 0.2 人天 |
| service / 路由 / VO 契约 | `agent.service.ts`、`agent.routes.ts`、`shared/contracts/src/agent.ts` | 0.2 人天 |
| 共享目录 + bundle | `shared-agent.service.ts`、`agent-bundle.{types,service}.ts`、格式文档 | 0.2 人天 |
| 管理后台表单 + 列表 | `AgentFormDialog.vue`、`AgentListView.vue` | 0.3 人天 |
| 客户端 store | `desktop/src/stores/agent.ts` | 0.05 人天 |
| 测试（后端单测 + admin E2E + 客户端断言） | 见 §8 | 0.3 人天 |
| CHANGELOG / 文档 | — | 0.1 人天 |
| **合计** | | **约 1.35 人天** |

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 管理员误关唯一可见 Agent | 客户端无法新建会话 | 列表「仅管理端」标记显眼；可选 P1：保存时若为最后一个可见 Agent 给 warning（不阻断） |
| 与 `enabled` 语义混淆 | 管理员以为「隐藏」等于「停用」 | 表单文案明确「已绑定会话不受影响」；列表两个标签并列展示 |
| 漏改 `updateById` 字段 | 每次保存把可见性重置为默认 1 | 单元测试覆盖「保存其它字段后 clientVisible 不变」 |
| 非法 `scope` 静默退化 | 隐藏 Agent 意外出现在客户端 | 严格拒绝（§4.4） |
| 默认 Agent 保护的组合顺序 | 同请求改两个字段时校验失效 | 先合并出 next 状态再统一校验（§4.3） |
| 共享目录遗漏过滤 | 用户从共享入口仍能选到隐藏 Agent | 后端过滤 + 验收项覆盖 |
| bundle 导入意外暴露 | 跨实例搬运后可见性变化 | 纳入字段（§4.6），旧包按可见处理 |

## 附录 A 代码位置索引

| 主题 | 位置 |
|---|---|
| agent 表定义 / enabled 迁移 | `backend-ts/db/migration/V001__init_schema.sql:73-83`、`V119__agent_enabled.sql` |
| 列表 SQL | `backend-ts/src/agent/agent.repository.ts:18-32` |
| 插入 / 更新字段列表 | `agent.repository.ts:59-78`、`:91-102` |
| 列表路由 | `agent.routes.ts:75-86` |
| 编辑路由（PUT） | `agent.routes.ts:120-139` |
| 启停保护 | `agent.service.ts:158-168` |
| VO 契约 | `shared/contracts/src/agent.ts:22-41` |
| 共享目录过滤 | `shared-agent.service.ts:133-142` |
| Bundle 导入写死 enabled | `agent-bundle.service.ts:403-425` |
| 管理表单字段 / 回填 / 提交 | `admin/src/views/agent/AgentFormDialog.vue:320-331`、`:589-604`、`:710-730` |
| 管理列表状态列 | `admin/src/views/agent/AgentListView.vue:64-70` |
| 客户端列表拉取 | `desktop/src/stores/agent.ts:35-62` |
| 新建态默认 Agent | `desktop/src/views/task/TaskView.vue:811-814` |
| 未选 Agent 拦截 | `desktop/src/components/chat/ChatInput.vue:287` |
| 其他客户端入口（不过滤） | `OpenApiView.vue:477`、`SignalWatchersView.vue:351`、`SessionSearchPopover.vue:196` |

## 附录 B 接口契约变更

```ts
// GET /v1/agents?scope=client
//   scope 缺省：全量（含客户端不可见）
//   scope=client：仅 client_visible = 1
//   scope 其它值：业务错误 code≠0

// PUT /v1/agents/:id 、POST /v1/agents
{
  // ...现有字段
  clientVisible?: boolean   // 缺省不改动（PUT）/ 默认 true（POST）
}

// AgentVO
{
  // ...现有字段
  clientVisible: boolean    // false = 客户端新建会话不展示
}
```
