# 用户级 MCP 服务器（用户自定义 McpServer）技术方案

> 文档状态：已与需求方逐项确认决策，形成共识。
> 适用版本：初版开发阶段，重构无需考虑存量数据与向后兼容。

---

## 1. 需求背景

当前系统的 MCP 服务器能力分两层：

1. **全局服务器**（管理员维护）：管理员在管理后台创建/编辑/删除 MCP 服务器（`mcp_server` 表），Agent 通过 `agent.mcp_server_ids` 关联；会话构建时按 Agent 关联加载。
2. **用户级偏好**（已上线）：桌面端「设置 → MCP 服务器」页可对全局服务器做启用/停用开关（`user_mcp_preference` 表），但**仅能开关，不能新增自己的服务器**。

痛点：MCP 服务器配置完全依赖管理员。普通用户想接入自己的 MCP 服务（如自建的文件服务器、私有知识库、企业内部工具），只能提交给管理员代为配置，流程长、无法自主控制，且管理员配置的服务器对所有关联用户共享。

**目标**：支持用户在客户端（桌面端）设置页面**新增、编辑、删除、测试自己的私有 MCP 服务器**，并自动注入本人会话使用；同时移除 MCP 相关权限控制维度，所有登录用户均可在会话中使用 MCP 工具。

---

## 2. 需求描述

### 2.1 要做的事（Do）

1. **数据模型**：在 `mcp_server` 表新增 `user_id` 列（`0` = 全局服务器，`>0` = 该用户私有服务器），字段结构与全局服务器完全一致。
2. **桌面端新增私有服务器管理**：桌面端「设置 → MCP 服务器」页新增「我的服务器」区块，支持：
   - 新增服务器（STDIO：命令 + 启动参数 + 环境变量；HTTP：URL）；
   - 编辑服务器（名称、描述、类型、命令/参数/URL、环境变量）；
   - 删除服务器（级联清理该服务器的用户偏好记录）；
   - 测试连接（真实连接并拉取工具清单，失败返回错误信息）；
   - 启用/停用开关（复用 `user_mcp_preference`，默认启用）。
3. **私有服务器自动生效**：用户创建的私有服务器（状态为 ENABLED 且未被用户停用）自动注入该用户**所有会话**（CLOUD 与 LOCAL、主会话与子任务），与 Agent 关联的全局服务器**合并加载**，全局在前、私有在后。
4. **权限维度移除**：
   - 会话注入不再拦截任何用户（移除 `HarnessService.buildContext` 与 `StreamingWsHandler.syncMcpServersToClient` 中的 `mcp:read` 检查）；
   - 管理接口移除 `@RequirePermission("mcp:read"/"mcp:write")` 注解；
   - 清理 `permission` / `role_permission` 表中 `mcp:read`、`mcp:write` 两条权限记录。
5. **全局写保护**：全局服务器（`user_id=0`）的创建、编辑、删除、启停、测试接口**仅限管理员角色**调用（复用现有 `PermissionService` 管理员角色判断），防止普通用户篡改全局配置。
6. **管理后台治理**：管理后台 MCP 服务器列表展示**全部**服务器（全局 + 所有用户私有），私有服务器标注归属用户名、**脱敏（不显示环境变量）**；对私有服务器提供**停用 / 启用 / 删除**治理操作，**不提供编辑与测试**（避免敏感配置暴露给管理员界面之外）。
7. **数据一致性**：删除任意服务器（全局或私有）时级联清理 `user_mcp_preference` 中指向该服务器的记录（修复现有遗漏）。

### 2.2 不做的事（Don't）

1. **不扩展 HTTP 鉴权能力**：私有服务器与全局服务器配置能力一致，HTTP 类型仅支持 URL，不支持自定义请求头 / OAuth / Token 配置（留待全局能力升级时统一做）。
2. **不做私有服务器与 Agent 的关联**：`agent.mcp_server_ids` 仍只关联全局服务器，管理后台 Agent 表单不出现私有服务器。
3. **不限制私有服务器数量**：每用户可创建任意数量私有服务器。
4. **不开放全局服务器管理**：普通用户不能通过任何接口创建、修改、删除、启停**全局**服务器。
5. **不提供环境变量明文回显**：编辑时环境变量不回显明文（与现有全局服务器编辑行为一致），修改时整体覆盖。
6. **不提供管理后台对私有服务器的编辑/测试**：仅治理（停用/启用/删除）。
7. **不对删除/停用中的会话做热回收**：服务器被停用/删除只影响之后构建的会话；已建立的会话连接在会话结束时统一关闭（沿用现状 `McpClientManager.closeSession`）。

---

## 3. 现状分析（相关代码）

| 位置 | 说明 |
|------|------|
| `backend/src/main/java/cn/etarch/mao/harness/mcp/entity/McpServer.java` | 服务器实体，无 `userId` 字段 |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/service/McpServerService.java` | 全局服务器 CRUD、名称校验（`NAME_PATTERN`、`(user_id, name)` 维度 + 全局↔私有互斥）、env 加密、Agent 引用检查 |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/controller/McpServerController.java` | 管理接口（`@RequirePermission("mcp:read"/"mcp:write")`）+ 用户偏好接口 `/preferences` |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/local/McpSyncService.java` | `loadAgentServers(agent, userId)` 按 Agent 关联加载并按用户偏好过滤；`buildSyncPayload` 构造 LOCAL 下发载荷 |
| `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`（约 331 行） | CLOUD 模式 MCP 注入，`mcp:read` 权限拦截 |
| `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`（约 1454 行） | LOCAL 模式 `syncMcpServersToClient`，`mcp:read` 权限拦截 |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/preference/*` | `user_mcp_preference` 实体 / Mapper / Service（`getDisabledServerIds` 等） |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/McpClientManager.java` | CLOUD 会话级连接（`connectAndListTools` / `testConnection`），测试连接可复用 |
| `backend/src/main/java/cn/etarch/mao/harness/mcp/crypto/McpSecretCipher.java` | 环境变量 AES/GCM 加解密，私有服务器复用 |
| `desktop/src/views/settings/McpServersView.vue` | 桌面端设置页，目前仅全局服务器开关列表 |
| `desktop/src/api/index.ts`（198-216 行） | 偏好接口封装 `getMcpServerPreferences` / `saveMcpServerPreference` |
| `admin/src/views/mcp/McpServerListView.vue` | 管理后台 MCP 服务器列表页 |
| `backend/src/main/resources/db/migration/V067__mcp_server.sql` | `mcp_server` 表 + `agent.mcp_server_ids` + `mcp:read`/`mcp:write` 权限记录 |
| `backend/src/main/resources/db/migration/V068__user_mcp_preference.sql` | 用户偏好表 |

---

## 4. 技术选型与决策记录

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 存储方案 | 复用 `mcp_server` 表，新增 `user_id` 列（0=全局） | 字段结构、加密、名称校验、CLOUD/LOCAL 连接逻辑全部复用，改动最小、行为一致 |
| 2 | 注入方式 | 创建即自动生效，与全局合并加载 | 用户私有服务器无需再关联 Agent（Agent 为全局概念），符合"自己配的服务器自己用"的直觉 |
| 3 | 名称唯一性 | 同一用户内唯一 + 不与全局服务器重名；不同用户可重名；DB 唯一索引 `(user_id, name)` | 工具名 `mcp__{服务器名}__{工具名}` 在同一会话（全局+私有合并注入）内必须唯一；不同用户会话隔离可重名 |
| 4 | 启停开关 | 提供，默认启用，复用 `user_mcp_preference` | 注入链路已对偏好过滤生效，成本极低，体验完整 |
| 5 | 测试连接 | 提供（仅测自己的服务器） | 复用 `McpClientManager.testConnection`，创建时即时验证配置 |
| 6 | 管理后台可见性 | 可查看（标注归属、脱敏）、可停用/启用/删除治理 | 治理违规配置；不提供编辑/测试防敏感配置扩散 |
| 7 | 数量限制 | 不限制 | 实现最简，滥用风险由资源侧约束 |
| 8 | 配置能力 | 与全局一致，不扩展 HTTP 鉴权头 | 收敛范围，保持一致行为 |
| 9 | 权限 | 完全移除 `mcp:read`/`mcp:write`；会话使用全开放；全局写仅限管理员角色 | 需求明确"所有人都可以使用 MCP"；全局配置仍须防普通用户篡改 |

---

## 5. 总体设计

### 5.1 数据模型（迁移脚本 V070__user_mcp_server.sql）

```sql
-- 用户级 MCP 服务器：mcp_server 表增加归属用户列，0=全局服务器（现有数据全为全局）
ALTER TABLE mcp_server
    ADD COLUMN user_id BIGINT NOT NULL DEFAULT 0 COMMENT '归属用户ID，0=全局服务器' AFTER id;

-- 唯一索引改为按用户维度：同一用户内名称唯一；user_id=0 时全局服务器之间仍唯一
ALTER TABLE mcp_server DROP INDEX uk_mcp_server_name;
ALTER TABLE mcp_server ADD UNIQUE KEY uk_mcp_user_name (user_id, name);

-- 移除 mcp:read / mcp:write 权限记录（需求：完全移除该权限维度）
DELETE FROM role_permission
WHERE permission_id IN (SELECT id FROM permission WHERE code IN ('mcp:read', 'mcp:write'));
DELETE FROM permission WHERE code IN ('mcp:read', 'mcp:write');
```

**唯一性约束说明**：
- `(user_id=0, name)` 保证全局服务器之间不重名（沿用现状）；
- `(user_id=N, name)` 保证同一用户的私有服务器不重名；
- **全局与私有服务器重名**无法由索引约束（`(N, name)` 与 `(0, name)` 不冲突），由 `McpServerService.validateName` 代码层**双向**校验：私有创建时检查 `user_id=0` 是否存在同名，全局创建/重命名时检查是否存在任何私有服务器同名，存在则拒绝。不同用户的私有服务器允许重名。

### 5.2 实体变更

`McpServer.java` 新增字段：

```java
/** 归属用户ID：0=全局服务器（管理员维护）；>0=该用户私有服务器 */
private Long userId;
```

### 5.3 后端 API 设计

**新增用户私有服务器接口**（任意登录用户可用，只能操作自己的服务器，路径 `/v1/mcp-servers/me`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/mcp-servers/me` | 当前用户的私有服务器列表（不含 env 明文） |
| POST | `/v1/mcp-servers/me` | 创建私有服务器（body 同现有 `SaveMcpServerRequest`） |
| PUT | `/v1/mcp-servers/me/{id}` | 编辑私有服务器（校验归属） |
| DELETE | `/v1/mcp-servers/me/{id}` | 删除私有服务器（校验归属；级联清理偏好记录） |
| POST | `/v1/mcp-servers/me/{id}/test` | 测试连接（校验归属；复用 `McpClientManager.testConnection`） |

**变更的现有接口**：

| 接口 | 变更 |
|------|------|
| `GET/PUT /v1/mcp-servers/preferences` | 返回列表扩展为「全局启用服务器 + 当前用户私有服务器」的合并集合，每个元素新增 `scope` 字段（`GLOBAL` / `USER`）标识来源；开关逻辑不变（`server_id` 均指向 `mcp_server.id`） |
| `GET /v1/mcp-servers`（管理列表） | 移除 `@RequirePermission("mcp:read")`，改为管理员角色校验；返回全部服务器（全局+私有），私有服务器带 `userId` / `userName` 归属；env 脱敏 |
| `GET /v1/mcp-servers/enabled` | 移除权限注解，改为管理员角色校验（供 Agent 表单勾选全局服务器） |
| `GET /v1/mcp-servers/{id}` | 移除权限注解，改为管理员角色校验；私有服务器也可查看（env 脱敏） |
| `POST /v1/mcp-servers`、`PUT /{id}`、`PUT /{id}/status`、`DELETE /{id}`、`POST /{id}/test` | 移除 `@RequirePermission("mcp:write")`，改为管理员角色校验；管理员可对私有服务器执行**停用/启用/删除**（治理），**不提供**对私有服务器的编辑与测试（接口层可放行编辑/测试或仅 UI 不暴露，文档取后者：接口保留管理员能力，管理后台 UI 不提供入口） |

**管理员角色校验方式**：在 `McpServerController` 管理接口内调用 `permissionService.userHasRole(userId, adminRoleId)`（复用 `PermissionService.getAdminRole()`），不新增权限注解。

### 5.4 注入链路改造

**核心修改点：`McpSyncService.loadAgentServers(Agent, Long userId)`**

```
1. 解析 agent.mcp_server_ids → 全局服务器（按配置顺序）
2. 过滤：跳过已停用/已删除/被用户停用（现有逻辑保留）
3. 追加：userId 的私有服务器（user_id=userId 且 status=ENABLED），按 id 升序
4. 过滤：被用户停用的私有服务器（复用 getDisabledServerIds，偏好表不区分来源）
5. 返回合并列表（全局在前、私有在后）
```

调用方无需改动：
- `HarnessService.buildContext`（CLOUD 注入）→ 调用 `loadAgentServers(agent, session.getUserId())`
- `StreamingWsHandler.syncMcpServersToClient`（LOCAL 下发）→ 同样调用，`buildSyncPayload` 对私有服务器与全局服务器同样生成载荷

**权限拦截移除（2 处）**：
- `HarnessService.buildContext`：删除 `userHasMcpPermission` 判断分支，所有用户执行 MCP 注入；
- `StreamingWsHandler.syncMcpServersToClient`：删除 `mcp:read` 检查分支，所有用户执行 LOCAL 下发。

> 安全说明（需求方已确认"所有人都可以使用 MCP"）：移除拦截后，普通用户会话可注入管理员配置的全局服务器（含其环境变量凭据），LOCAL 模式同样会向桌面端下发全局服务器配置。这是开放使用的必然结果，接受该风险。

### 5.5 服务层改造（McpServerService）

- `validateName(name, userId)`：校验规则升级为「`(userId, name)` 唯一 + 全局↔私有双向禁止重名」，沿用 `NAME_PATTERN` 与 `__` 禁用规则；
- 新增 `listMine(userId)` / `getMine(userId, id)` / `createMine(userId, ...)` / `updateMine(userId, id, ...)` / `deleteMine(userId, id)`：
  - 归属校验：`update/delete/test` 必须 `server.userId == userId`，否则返回 403；
  - `deleteMine` 级联删除 `user_mcp_preference` 中 `(userId, serverId)` 记录（可复用 `UserMcpPreferenceService` 新增 `deleteByServer(userId, serverId)`）；
  - **删除采用物理删除**（`McpServerMapper.physicalDeleteById`）：唯一索引 `(user_id, name)` 与逻辑删除不兼容，逻辑删除后索引残留同名记录会导致无法重建；该表无恢复/审计需求，删除即物理删除；
- `delete(id)`（管理删除）同样物理删除，并级联清理该服务器在所有用户的偏好记录；
- `list(keyword, status)`（管理列表）改为返回全部服务器并填充归属用户名（联查 `user` 表）；
- `listEnabled()` 保持仅返回全局已启用服务器（Agent 表单用）。

### 5.6 桌面端改造

**`desktop/src/views/settings/McpServersView.vue` 改版**为两个区块：

1. **我的服务器**（新增）：
   - 「新增服务器」按钮 → 弹窗表单：名称（小写字母/数字/下划线/连字符，提示不能与全局重名）、描述、类型（STDIO/HTTP 切换）、命令/启动参数（STDIO）、URL（HTTP）、环境变量（键值对动态行）；
   - 卡片列表：名称、类型 tag、描述、状态（启用/被管理员停用 tag）、启用开关、操作按钮（编辑 / 测试连接 / 删除）；
   - 编辑弹窗复用新增表单，环境变量不回显（留空提示"不修改则保留原值"）；
   - 测试连接：调用 `/me/{id}/test`，成功展示拉取到的工具数量，失败展示错误信息；
   - 被管理员停用（status=DISABLED）的服务器显示"已被管理员停用"，开关禁用。
2. **全局服务器**（现有区块保留）：开关列表语义不变（管理员启用的全局服务器对所有用户开放）。

**`desktop/src/api/index.ts` 新增封装**：`getMyMcpServers` / `createMyMcpServer` / `updateMyMcpServer` / `deleteMyMcpServer` / `testMyMcpServer`；`getMcpServerPreferences` 返回类型扩展 `scope` 字段。

### 5.7 管理后台改造（admin）

**`admin/src/views/mcp/McpServerListView.vue`**：
- 列表加载 `GET /v1/mcp-servers`（返回全部），新增「归属」列：全局显示「全局」，私有显示归属用户名；
- 私有服务器行操作：停用 / 启用 / 删除（治理），**不显示**编辑、测试连接、查看详情入口；
- 全局服务器行操作保持现状（编辑 / 测试连接 / 启停 / 删除）；
- 列表 env 一律不显示（现状已脱敏）。

---

## 6. 实现步骤

### 阶段 A：后端数据层

1. 编写迁移脚本 `backend/src/main/resources/db/migration/V070__user_mcp_server.sql`（见 5.1）。
2. `McpServer.java` 增加 `userId` 字段。
3. `McpServerMapper` 无需改动（MyBatis-Plus 自动映射）。

### 阶段 B：后端服务与控制器

4. `McpServerService`：`validateName` 增加 userId 维度；新增 `listMine/getMine/createMine/updateMine/deleteMine`；`delete` 增加偏好级联清理；`list` 返回归属用户名。
5. `UserMcpPreferenceService`：新增 `deleteByServer(Long serverId)`（清理所有用户对该服务器的偏好）。
6. `McpSyncService.loadAgentServers(agent, userId)`：追加私有服务器合并逻辑。
7. `HarnessService.buildContext`：移除 `mcp:read` 拦截。
8. `StreamingWsHandler.syncMcpServersToClient`：移除 `mcp:read` 拦截。
9. `McpServerController`：
   - 移除全部 `@RequirePermission("mcp:read"/"mcp:write")`；
   - 管理接口方法体增加管理员角色校验（`userHasRole(userId, adminRoleId)`）；
   - 新增 `/me` 五个接口；
   - `/preferences` 返回列表合并私有服务器并增加 `scope` 字段。

### 阶段 C：前端

10. 桌面端 `api/index.ts` 新增私有服务器接口封装；`McpServersView.vue` 改版为双区块（新增/编辑/删除/测试连接/开关）。
11. 管理后台 `McpServerListView.vue` 增加归属列与治理操作。

### 阶段 D：测试与验证

12. 后端单测：`McpSyncServiceTest` 增加「私有服务器合并注入」「私有被停用不注入」用例；新增 `McpServerService` 私有 CRUD 与名称唯一性用例（可选）。
13. 前端构建：`cd backend && mvn compile`、`cd admin && npm run build`、`cd desktop && npm run build`（Electron 壳代码有改动时同步升 `package.json` version）。
14. 手工验证路径（见 7.4）。

---

## 7. 落地清单

### 7.1 后端改动文件

| 文件 | 改动 |
|------|------|
| `db/migration/V070__user_mcp_server.sql` | 新增：`user_id` 列、唯一索引替换、权限记录清理 |
| `harness/mcp/entity/McpServer.java` | 新增 `userId` 字段 |
| `harness/mcp/service/McpServerService.java` | 名称校验维度化；私有 CRUD；管理删除级联清理；列表归属 |
| `harness/mcp/preference/service/UserMcpPreferenceService.java` | 新增 `deleteByServer` |
| `harness/mcp/local/McpSyncService.java` | `loadAgentServers` 合并私有服务器 |
| `harness/core/HarnessService.java` | 移除 `mcp:read` 注入拦截 |
| `session/ws/StreamingWsHandler.java` | 移除 `mcp:read` 下发拦截 |
| `harness/mcp/controller/McpServerController.java` | 移除权限注解、管理接口管理员校验、新增 `/me` 接口、`/preferences` 扩展 |

### 7.2 前端改动文件

| 文件 | 改动 |
|------|------|
| `desktop/src/api/index.ts` | 新增私有服务器接口封装；偏好类型扩展 `scope` |
| `desktop/src/views/settings/McpServersView.vue` | 双区块改版（新增/编辑/删除/测试/开关） |
| `admin/src/views/mcp/McpServerListView.vue` | 归属列 + 私有服务器治理操作 |

### 7.3 测试文件

| 文件 | 改动 |
|------|------|
| `backend/src/test/java/cn/etarch/mao/harness/mcp/local/McpSyncServiceTest.java` | 增加私有服务器合并/停用过滤用例 |

### 7.4 验证路径

1. 管理员在管理后台创建全局 STDIO/HTTP 服务器并关联 Agent；普通用户 A 登录桌面端：
   - 设置页「我的服务器」新增 STDIO 服务器（env 含密钥）→ 测试连接成功 → 新开会话 → 调用该服务器暴露的工具成功；
   - 新增名称与全局服务器同名的服务器 → 被拒绝（提示重名）；
   - 关闭该私有服务器开关 → 新会话不再注入其工具；
   - 删除该私有服务器 → 新会话不再注入，`user_mcp_preference` 无残留记录。
2. 管理员在管理后台：MCP 列表可见用户 A 的私有服务器（归属用户名、无 env）；停用该私有服务器 → 用户 A 设置页显示"已被管理员停用"且开关禁用；恢复启用后用户 A 可用。
3. 普通用户 B（未在角色中）：会话可注入全局服务器工具（权限已开放）。
4. 普通用户调用 `POST /v1/mcp-servers`（创建全局）→ 403。
5. 用户 A 调用 `PUT /v1/mcp-servers/me/{B的服务器id}` → 403（归属校验）。

---

## 8. 风险与安全说明

1. **权限开放风险**（需求方已确认接受）：移除 `mcp:read` 拦截后，普通用户可使用管理员配置的全局服务器及其环境变量凭据。若全局服务器含付费 API Key，存在资源被普通用户消耗的可能。缓解：全局服务器仍由管理员维护与启停；必要时后续可加「按角色开放指定全局服务器」的细粒度策略（本轮不做）。
2. **工具名冲突防护**：同一会话中全局+私有合并注入，靠「不与全局重名 + 同用户唯一」的名称规则保证 `mcp__{server}__{tool}` 不冲突。
3. **越权防护**：所有 `/me` 接口强制归属校验；管理写接口仅限管理员角色；环境变量解密结果只出现在服务端运行时（CLOUD 直连）与本人桌面端（LOCAL 下发），管理列表与偏好接口一律脱敏。
4. **遗留数据**：`mcp_server` 表现有数据全为全局（`user_id=0`），迁移脚本 `DEFAULT 0` 无需回填。
