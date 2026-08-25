# 系统快捷指令管理后台技术方案

> 文档版本：v1.0
> 文档状态：待实施
> 编写日期：2026-08-25
> 适用项目：Mao Agent Workbench

## 1. 需求背景

当前 Mao 管理后台（admin/）已覆盖 Agent 管理、模型管理、Skill 管理、MCP 服务器、会话管理、定时任务、系统设置等功能模块，但**快捷指令**（Quick Command）的管理界面完全缺失。

快捷指令是 Mao Agent 的核心交互入口之一——用户在桌面端 ChatInput 输入 `/` 即可弹出快捷指令面板，选择系统预置或自定义的指令快速触发 Agent 执行。目前系统快捷指令（`user_id=0`）的维护完全依赖后端 SQL 迁移脚本（`V045__add_system_commands.sql`），存在以下问题：

- 运维人员无法通过 UI 查看当前所有系统指令；
- 新增/修改/删除系统指令需要修改 Flyway 迁移脚本并重新部署，效率低且容易出错；
- 桌面端用户看到的快捷指令由后端 `/v1/quick-commands` 聚合返回，但管理员无法自主管理这些指令的内容。

本方案为管理后台新增**系统快捷指令管理**页面，使管理员能够通过 UI 可视化管理全局系统指令，同时在后端新增一套管理员专用的系统指令路由，与现有用户指令路由职责分离。

## 2. 需求描述

### 2.1 目标

1. 管理后台新增「系统指令」菜单页面，支持系统级快捷指令的**列表查看、新增、编辑、删除**。
2. 后端新增管理员专用路由 `/v1/admin/system-commands`，通过 `requireAdmin` 权限校验，独立管理 `user_id=0` 的系统指令。
3. 前端页面仅对管理员可见（`adminOnly` 或 `user:write` 权限），普通用户无访问权限。
4. 名称在同级（系统指令范围内）唯一性校验。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|------|----|------|
| 管理范围 | 仅系统指令（`user_id=0` 的全局指令，所有用户可见） | 用户个人指令（`user_id>0`）不在管理范围内 |
| 编辑权限 | 管理员可 CRUD（通过 `requireAdmin` 校验） | 普通用户/非管理员不可编辑系统指令 |
| 后端 API | 新增 `/v1/admin/system-commands` 独立路由组 | 不扩展现有 `/v1/user-commands` 路由 |
| 路由保护 | `requireAdmin` 权限校验 | 不由 `user_id` 归属校验保护 |
| 页面功能 | 列表展示、新增、编辑、删除、名称唯一性校验 | 恢复默认、批量操作、导入导出不做 |
| 菜单位置 | 「系统」分组下独立菜单项，路由 `/system-commands` | 不作为系统设置的子 Tab |
| 桌面端影响 | 无影响，桌面端 `/v1/quick-commands` 聚合接口不变 | 不改动桌面端代码 |
| 用户端影响 | 无影响，用户个人指令 CRUD 路由 `/v1/user-commands` 不变 | 不改动用户端 API |

## 3. 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 后端框架 | NestJS + Fastify（现有） | 项目现有技术栈，路由注册方式与 `registerUserCommandRoutes` 一致 |
| 后端路由 | 新增 `registerAdminSystemCommandRoutes`，挂载在 `api` 路由组下 | 与 `registerAdminSessionRoutes`、`registerAdminAnalyticsRoutes` 模式一致 |
| 权限校验 | `requireAdmin(deps.permissionService, req)` | 复用现有管理后台权限校验机制 |
| 前端框架 | Vue 3 + Element Plus（现有） | 项目现有技术栈，复用现有组件模式 |
| 前端 API | 新增 `admin/api.ts` 或直接使用 `api.get/post/put/delete` | 复用现有 `admin/src/api.ts` 中的 `api` 实例 |
| 数据库 | 现有 `user_command` 表，`user_id=0` 代表系统指令 | 无需新增表或字段，利用现有模型 |

## 4. 实现步骤

### 4.1 后端：新增管理员系统指令路由

**文件：`backend-ts/src/command/admin-system-command.routes.ts`**（新建）

新增路由组，所有路由均需 `requireAdmin` 权限校验：

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| GET | `/v1/admin/system-commands` | 列表查询所有系统指令 | 返回 `user_id=0` 的全部指令，按 `created_at DESC` 排序 |
| GET | `/v1/admin/system-commands/:id` | 查询单条系统指令 | 同现有查询逻辑 |
| POST | `/v1/admin/system-commands` | 新增系统指令 | 写入 `user_id=0`，校验名称唯一性（同 `/v1/user-commands` 的 `create` 逻辑，但 `userId` 固定为 0） |
| PUT | `/v1/admin/system-commands/:id` | 编辑系统指令 | 更新名称/内容，校验名称唯一性 |
| DELETE | `/v1/admin/system-commands/:id` | 删除系统指令 | 软删除（`deleted=1`），与现有 `deleteById` 一致 |

**关键设计点：**

- 不走 `UserCommandService` 的 `create/update/delete` 方法，因为这些方法内部有 `isSystemCommand` 只读校验（`COMMAND_SYSTEM_READONLY`）。
- 新建 `AdminSystemCommandService` 或直接在路由中调用 `UserCommandRepository` 的方法，以 `userId=0` 写入。
- 名称唯一性校验范围：仅限系统指令（`user_id=0`）内部，不限制用户指令名称是否与系统指令同名——这与现有 `listAvailableForUser` 的合并逻辑一致（用户指令同名覆盖系统指令）。
- 数据操作复用 `MysqlUserCommandRepository` 的现有方法。

**文件：`backend-ts/src/create-app.ts`**（修改）

在 `api` 路由组注册 `registerAdminSystemCommandRoutes`，传入 `userCommandService` 和 `permissionService`（或直接传入 `commandRepo` + `permissionService`）。

**文件：`backend-ts/src/command/command.service.ts`**（修改）

保留现有 `COMMAND_SYSTEM_READONLY` 校验不变（面向用户指令的 `update/delete` 仍保护系统指令），新增 `AdminSystemCommandService` 不受此限制。

### 4.2 前端：新增系统指令管理页面

**文件：`admin/src/views/system-commands/SystemCommandListView.vue`**（新建）

页面结构：

```
┌─────────────────────────────────────────────────────┐
│ 系统指令                            [+ 新增指令]    │
│ 管理员可在此管理所有用户可见的全局快捷指令。          │
├─────────────────────────────────────────────────────┤
│ ┌─────────┬──────────┬────────────────┬──────────┐ │
│ │ 指令名称  │ 指令内容   │ 创建时间        │ 操作      │ │
│ ├─────────┼──────────┼────────────────┼──────────┤ │
│ │ review  │ Review当… │ 2026-08-01     │ 编辑 删除 │ │
│ │ codebase│ 基于当前… │ 2026-08-01     │ 编辑 删除 │ │
│ │ plan    │ 请你基于… │ 2026-08-01     │ 编辑 删除 │ │
│ │ ...     │ ...      │ ...            │ ...      │ │
│ └─────────┴──────────┴────────────────┴──────────┘ │
└─────────────────────────────────────────────────────┘
```

- **列表表格**：展示字段：ID、指令名称（name）、指令内容（content 截取前 100 字符 + 展开）、创建时间（created_at）
- **新增/编辑对话框**：与现有 `UserFormDialog.vue` 风格一致，使用 `ResponsiveDialog` 包裹的 `el-form`
  - 表单字段：指令名称（`el-input`，必填，校验格式 `^[a-zA-Z0-9\u4e00-\u9fa5_-]+$`）、指令内容（`el-input type="textarea"`，必填，多行）
  - 新增时校验名称唯一性，编辑时支持修改名称和内容
- **删除确认**：`ElMessageBox.confirm` 二次确认后删除
- **权限守卫**：路由 meta 设置 `permission: 'user:write'` 或 `adminOnly: true`

**文件：`admin/src/router/index.ts`**（修改）

新增路由配置：

```ts
{
  path: 'system-commands',
  name: 'SystemCommands',
  component: () => import('../views/system-commands/SystemCommandListView.vue'),
  meta: { title: '系统指令', keepAlive: true, permission: 'user:write' }
}
```

**文件：`admin/src/components/SideMenu.vue`**（修改）

在「系统」分组下新增菜单项：

```ts
{ index: '/system-commands', label: '系统指令', icon: Document, permission: 'user:write' }
```

### 4.3 数据库

无需新增表或修改表结构。现有 `user_command` 表完全满足需求，系统指令通过 `user_id=0` 标识。

## 5. 落地清单

### 5.1 后端（3 个文件变更）

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `backend-ts/src/command/admin-system-command.routes.ts` | **新建** | 管理员系统指令路由组，注册 GET/POST/PUT/DELETE 四个端点，均通过 `requireAdmin` 校验 |
| 2 | `backend-ts/src/create-app.ts` | **修改** | 导入并注册新的路由函数，传入 `commandRepo` 和 `permissionService` |
| 3 | `backend-ts/src/command/command.service.ts` | **修改** | 可选项：将 `COMMAND_SYSTEM_READONLY` 校验保留，新增 `AdminSystemCommandService` 类（或不在 service 层做，直接在路由中调用 repo 操作） |

### 5.2 前端（3 个文件变更）

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 4 | `admin/src/views/system-commands/SystemCommandListView.vue` | **新建** | 系统指令管理页面：列表表格 + 新增/编辑对话框 + 删除确认 |
| 5 | `admin/src/router/index.ts` | **修改** | 添加 `/system-commands` 路由，配置 `meta.permission: 'user:write'` |
| 6 | `admin/src/components/SideMenu.vue` | **修改** | 「系统」分组下新增菜单项「系统指令」 |

### 5.3 接口汇总

| 方法 | 路径 | 权限 | 请求体 | 返回 |
|------|------|------|--------|------|
| GET | `/v1/admin/system-commands` | admin | - | `UserCommandVO[]` |
| GET | `/v1/admin/system-commands/:id` | admin | - | `UserCommandVO` |
| POST | `/v1/admin/system-commands` | admin | `{ name, content }` | `UserCommandVO` |
| PUT | `/v1/admin/system-commands/:id` | admin | `{ name?, content }` | `UserCommandVO` |
| DELETE | `/v1/admin/system-commands/:id` | admin | - | 空 |

### 5.4 不做的事项

- 不实现「恢复默认」功能（将系统指令重置为初始预置的几条）
- 不管理用户个人指令（`user_id>0`）
- 不修改桌面端代码（`QuickCommandPanel.vue`、`ChatInput.vue` 等不受影响）
- 不修改用户端 `/v1/user-commands` 路由行为
- 不修改后端 `UserCommandService` 中已有的 `COMMAND_SYSTEM_READONLY` 保护（面向用户端）
- 不新增数据库表或字段
- 不添加批量操作、导入导出功能
- 不添加操作审计日志（现有系统级审计日志已覆盖所有 API 请求）

## 6. 附录

### 6.1 现有相关代码路径

| 路径 | 说明 |
|------|------|
| `backend-ts/src/command/command.routes.ts` | 现有用户指令路由 + 快捷指令聚合路由 |
| `backend-ts/src/command/command.service.ts` | 现有 `UserCommandService`，含 `SYSTEM_USER_ID = 0` 和只读保护 |
| `backend-ts/src/command/command.repository.ts` | `MysqlUserCommandRepository`，复用现有方法 |
| `backend-ts/src/command/types.ts` | `UserCommand`、`UserCommandRepository` 等接口定义 |
| `backend-ts/db/migration/V039__add_user_command.sql` | 建表迁移 |
| `backend-ts/db/migration/V045__add_system_commands.sql` | 预置系统指令迁移 |
| `admin/src/views/settings/SystemSettingsView.vue` | 参考风格：系统设置页面的卡片布局和对话框样式 |
| `admin/src/views/mcp/McpServerListView.vue` | 参考风格：列表 + 新增/编辑对话框的管理页面 |
| `admin/src/router/index.ts` | 路由配置 |
| `admin/src/components/SideMenu.vue` | 侧边栏菜单配置 |
| `admin/src/views/scheduled-tasks/index.vue` | 参考风格：定时任务管理页面 |

### 6.2 名称校验规则

与现有 `UserCommandService.validateName` 保持一致：

```
/^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/
```

支持字母、数字、中文、下划线、短横线。不支持空格和特殊字符。