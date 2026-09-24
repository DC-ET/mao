# 管理后台权限点补全

## 1. 背景

角色权限页的可选项来自 `permission` 表。当前能分配的只有 11 个码，后台侧栏有 15 个菜单。飞书机器人、钉钉机器人、指令、MCP、用量分析、调用流水只认 `ADMIN` 角色（`isAdmin`），权限页里根本没有对应项，无法授给自定义角色。

另有一批菜单借用了别的域的码，勾选含义和页面不一致：

| 菜单 | 现在用来挡页面的码 | 接口实际认的身份 |
| --- | --- | --- |
| Skills | `agent:read` / `agent:write` | 同上 |
| 定时任务 | `session:read` | 跨用户读 `session:read`，跨用户写 `scheduled-task:write` |
| 会话管理 | `session:read` | `ADMIN` 角色。有读权限的非管理员进得了菜单，接口 403 |
| 审计日志 | `user:read` | 只要求登录，不校验权限码 |
| 角色权限 | `user:write` | 写接口 `user:write`；`GET /roles`、`GET /permissions` 只要求登录 |
| 模型管理 | `model:read` | 列表接口只要求登录；明文 API Key 要 `model:write` |

`hasPermission` 只查角色上挂的权限行，不把 `ADMIN` 角色当成「拥有全部权限」。`isAdmin` 只表示用户绑了 `code=ADMIN` 的角色，用来保护最后一名管理员，以及挡住上面那些还没进权限表的页面。

## 2. 范围

### 2.1 要做

1. 把后台每个菜单收成独立的读/写权限点。已有且语义正确的码保留。缺的补进 `permission` 表，并接到对应接口和菜单。
2. 权限分配页按菜单分组显示中文组名，组内仍是「查看 / 管理」。`terminal:use` 单独成组，不和后台菜单混在一起。
3. 菜单、路由、写按钮、接口使用同一套码。不再用 `adminOnly` / `isAdmin` 决定能不能进某个管理页。
4. 迁移时把新码授给系统管理员（`role_id=1`）。原先靠借码才能看见的页面，按第 5 节的复制规则补到已有角色上，避免上线后菜单消失。
5. 同步 `skills/mao-cli/reference/role.md`：权限目录以本次清单为准，并说明 `terminal:use` 仍是 Shell 级能力。

### 2.2 不做

| 不做项 | 说明 |
| --- | --- |
| 按系统设置里的分类再拆权限 | `settings:read` / `settings:write` 继续覆盖公司 SSO、ECP、集成配置、运行参数。`settings:write` 已包含密钥 |
| 把桌面 / Web / 安卓的自助接口改成管理权限 | 个人资料、个人技能、个人 MCP（`/mcp-servers/me` 与 preferences）、个人定时任务、个人 Git 凭证、微信绑定，继续只要求登录且只能动自己的数据 |
| 用 `model:read` 挡住 `GET /v1/models` 等共享列表 | 桌面选模型不依赖这个码。`model:read` 只守管理后台路由；明文 Key、增删改、启停、连通性测试继续要 `model:write` |
| 取消 `ADMIN` 角色或最后一名管理员保护 | `isAdmin`、`changeRolesWithAdminGuard`、禁止停用最后一名管理员保持不变 |
| 给 `USER` 角色加新权限 | 普通用户仍只有 `agent:read`、`model:read` |
| 给自定义角色自动开原先只有管理员能进的页面 | 飞书、钉钉、指令、MCP 治理、用量分析、调用流水、会话删除/归档只授给 `role_id=1`，不从别的码复制 |

## 3. 权限清单

补齐后 28 个（原有 11 个，新增 17 个）。名称写入 `permission.name`，说明写入 `description`。分配页分组用下表顺序，不用权限码字母序。

### 3.1 能力

| 权限码 | 名称 | 说明 | 状态 |
| --- | --- | --- | --- |
| `agent:read` | 查看 Agent | 打开 Agent 管理；列表包含停用 Agent | 保留 |
| `agent:write` | 管理 Agent | 创建、编辑、删除、启停、提示词回滚、经验 | 保留。不再覆盖 Skills |
| `model:read` | 查看模型 | 打开模型管理 | 保留。不新增到共享列表接口 |
| `model:write` | 管理模型 | 创建、编辑、删除、启停、连通性测试、查看明文 API Key | 保留 |
| `skill:read` | 查看 Skills | 打开 Skills 管理；查看系统技能与全部用户技能 | 新增 |
| `skill:write` | 管理 Skills | 上传、删除系统技能；代用户上传、删除个人技能 | 新增 |
| `feishu-bot:read` | 查看飞书机器人 | 列表、详情、连接状态 | 新增 |
| `feishu-bot:write` | 管理飞书机器人 | 创建、编辑、删除、启停、重连 | 新增 |
| `dingtalk-bot:read` | 查看钉钉机器人 | 列表、详情、连接状态 | 新增 |
| `dingtalk-bot:write` | 管理钉钉机器人 | 创建、编辑、删除、启停、重连 | 新增 |
| `command:read` | 查看指令 | 系统指令与用户指令列表、详情 | 新增 |
| `command:write` | 管理指令 | 系统指令增删改；把用户指令提升为系统指令；删除用户指令 | 新增 |
| `mcp:read` | 查看 MCP | 治理列表、详情、指定用户的私有服务器（环境变量不回明文） | 新增。与 V070 删除的同名码含义不同：只覆盖管理端治理，不覆盖用户自建 |
| `mcp:write` | 管理 MCP | 全局服务器增删改、启停、连通性测试；停用或删除他人私有服务器 | 新增。同上 |

### 3.2 运行

| 权限码 | 名称 | 说明 | 状态 |
| --- | --- | --- | --- |
| `session:read` | 查看会话 | 跨用户会话列表、详情、消息 | 保留。接口从 `ADMIN` 改为认这个码 |
| `session:write` | 管理会话 | 归档、删除会话 | 新增 |
| `scheduled-task:read` | 查看定时任务 | 跨用户列表、详情、Cron 预览 | 新增。菜单不再借用 `session:read` |
| `scheduled-task:write` | 管理定时任务 | 跨用户编辑、启停、删除 | 保留 |
| `llm-call:read` | 查看调用流水 | 全站调用流水 | 新增。只有读 |
| `analytics:read` | 查看用量分析 | 用量分析页，以及 `/v1/analytics/*`、`/v1/statistics/*` | 新增。只有读 |

### 3.3 安全

| 权限码 | 名称 | 说明 | 状态 |
| --- | --- | --- | --- |
| `user:read` | 查看用户 | 用户列表、详情、脱敏后的 Git 凭证 | 保留。不再覆盖审计日志 |
| `user:write` | 管理用户 | 创建、编辑、重置密码、启停、删除 Git 凭证；在用户表单里改该用户的角色 | 保留。不再覆盖角色权限页 |
| `role:read` | 查看角色 | 打开角色权限页，查看角色与权限目录 | 新增 |
| `role:write` | 管理角色 | 新建、编辑角色，给角色分配权限点 | 新增。给用户绑角色仍是 `user:write` |
| `audit:read` | 查看审计日志 | 审计列表与详情 | 新增 |

### 3.4 系统与产品能力

| 权限码 | 名称 | 说明 | 状态 |
| --- | --- | --- | --- |
| `settings:read` | 查看系统设置 | 打开系统设置 | 保留 |
| `settings:write` | 管理系统设置 | 修改配置；LDAP、飞书、OSS 连通性测试 | 保留 |
| `terminal:use` | 使用云端终端 | 在云端任务中打开服务器交互式终端，等同服务器 Shell | 保留。分组名「云端终端」，说明沿用现有风险提示 |

用户改自己的角色、停用自己，继续走现有的最后一名管理员校验，与本次权限码无关。

## 4. 接口怎么认

原则：管理端读接口认 `*:read`，写接口认 `*:write`。桌面和用户自助路径不改。一个接口被两个页面共用时，满足其中任一码即可，在下表单独写出。

### 4.1 从 `requireAdmin` / `assertAdmin` 改成权限码

| 接口 | 权限码 |
| --- | --- |
| `GET /v1/admin/feishu-bots`、`GET /:id`、`GET /status` | `feishu-bot:read` |
| `POST/PUT/DELETE /v1/admin/feishu-bots`、启停、重连 | `feishu-bot:write` |
| `GET /v1/admin/dingtalk-bots`、`GET /:id`、`GET /status` | `dingtalk-bot:read` |
| `POST/PUT/DELETE /v1/admin/dingtalk-bots`、启停、重连 | `dingtalk-bot:write` |
| `GET /v1/admin/system-commands`、`GET /:id`、`GET /v1/admin/user-commands`、`GET /:userId/:id` | `command:read` |
| `POST/PUT/DELETE /v1/admin/system-commands`、提升、删除用户指令 | `command:write` |
| `GET /v1/mcp-servers`、`GET /:id` | `mcp:read` |
| `GET /v1/admin/users/:id/mcp-servers` | `user:read` 或 `mcp:read` |
| `GET /v1/mcp-servers/enabled` | `mcp:read` 或 `agent:write` |
| `POST/PUT/DELETE /v1/mcp-servers`、`PUT /:id/status`、`POST /:id/test` | `mcp:write` |
| `GET /v1/admin/sessions`、详情、消息 | `session:read` |
| `GET /v1/admin/sessions/options/users` | `session:read`、`scheduled-task:read`、`llm-call:read`、`audit:read` 任一 |
| `GET /v1/admin/sessions/options/agents` | `session:read`、`scheduled-task:read`、`llm-call:read` 任一 |
| `DELETE /v1/admin/sessions/:id`、`PUT /:id/archive` | `session:write` |
| `GET /v1/admin/runtime/sessions` | `session:read` |
| `GET /v1/admin/llm-calls` | `llm-call:read` |
| `GET /v1/admin/analytics/*`、`GET /v1/analytics/*`、`GET /v1/statistics/*` | `analytics:read` |

`GET /v1/llm-calls/me`、`/v1/mcp-servers/me`、`/v1/mcp-servers/preferences` 保持只要求登录。

`GET /v1/mcp-servers/enabled` 放开给 `agent:write`，是因为 Agent 表单要选已启用的全局服务器。今天这个接口只认管理员，有 `agent:write` 的自定义角色其实选不了 MCP。

`GET /v1/admin/users/:id/mcp-servers` 同时接受 `user:read`，是因为用户详情里有只读的 MCP 页签，环境变量继续不回明文。

### 4.2 换掉借用的码

| 接口 | 现在 | 改为 |
| --- | --- | --- |
| `GET /v1/admin/user-skills`、用户筛选项、`GET /:userId/:name` | `agent:read` | `skill:read` |
| `POST /v1/admin/user-skills/upload`、`DELETE /:userId/:name` | `agent:write` | `skill:write` |
| `POST /v1/skill-docs/upload`、`DELETE /v1/skill-docs/:name` | `agent:write` | `skill:write` |
| `GET /v1/scheduled-tasks/all`、跨用户 `GET /:id`、`POST /cron-preview` | `session:read` | `scheduled-task:read` |
| `GET /v1/audit/logs`、`GET /:id` | 只要求登录 | `audit:read` |
| `POST/PUT /v1/roles`、`PUT /roles/:id/permissions` | `user:write` | `role:write` |
| `GET /v1/permissions` | 只要求登录 | `role:read` |
| `GET /v1/roles` | 只要求登录 | `role:read` 或 `user:write` |

`GET /v1/roles` 留一条 `user:write` 旁路：用户表单要拉角色选项，但不需要打开角色权限页。`PUT /v1/users/:id/roles`，以及创建、编辑用户时带上的 `roleIds`，继续认 `user:write`。

`GET/POST/DELETE /v1/user-skills`（本人）、`GET /v1/skill-docs`（已登录用户阅读系统技能）不改。本人定时任务的列表和增删改不改；跨用户写继续认 `scheduled-task:write`。

### 4.3 保持不动的管理接口

| 接口 | 权限码 |
| --- | --- |
| Agent 写接口、头像上传、经验写接口 | `agent:write` |
| `GET /v1/agents?includeDisabled=true` | `agent:read` 或 `agent:write`；不带该参数的列表仍只要求登录 |
| 模型写接口；列表是否回明文 API Key | `model:write` |
| `GET /v1/users`、`GET /:id`、管理端 Git 凭证列表 | `user:read` |
| 用户创建、编辑、重置密码、启停、删除他人 Git 凭证 | `user:write` |
| `GET/PUT /v1/system-settings`、LDAP / 飞书 / OSS 测试 | `settings:read` / `settings:write` |
| 云端终端 REST 与 WebSocket attach | `terminal:use` |

## 5. 数据与存量角色

新增一条 Flyway，实现时取当时最大版本号加 1（写本文时最大为 `V120`）。不写死自增 id，用 `WHERE NOT EXISTS` 按 `code` 插入。

授予规则：

1. 第 3 节里所有「新增」码，授给 `role_id=1`。
2. 已有角色若拥有左列码，补上右列码。只补这些，避免借码页面在切换后从菜单消失。

| 已有 | 补上 |
| --- | --- |
| `agent:read` | `skill:read` |
| `agent:write` | `skill:write` |
| `session:read` | `scheduled-task:read` |
| `user:read` | `audit:read` |
| `user:write` | `role:read`、`role:write` |

3. 不给 `role_id=2`（`USER`）加任何新码。
4. 不把 `session:read` 复制成 `session:write`。原先能进会话菜单的非管理员，补齐后可以真正看列表和详情；归档和删除仍要单独授予。
5. 飞书、钉钉、指令、MCP、用量分析、调用流水不从旧码复制。这些页面今天只有管理员进得去，迁移后仍只有 `role_id=1` 默认拥有。

`ADMIN` 角色上已有的 11 个码不动。

## 6. 管理后台

路由 `meta.permission`、侧栏、写按钮使用第 3 节的码。去掉 `adminOnly`。进页看读权限，按钮看写权限：

| 页面 | 进页 | 写按钮 |
| --- | --- | --- |
| Agent、模型、用户、系统设置 | 原读码 | 原写码 |
| Skills | `skill:read` | `skill:write` |
| 飞书 / 钉钉机器人 | 各自 `:read` | 各自 `:write` |
| 指令、MCP | 各自 `:read` | 各自 `:write` |
| 会话 | `session:read` | 归档、删除看 `session:write` |
| 定时任务 | `scheduled-task:read` | 他人任务的编辑、启停、删除仍看 `scheduled-task:write`；本人任务不看这个码 |
| 调用流水、用量分析、审计 | 各自 `:read` | 无写操作 |
| 角色权限 | `role:read` | 新建、编辑、保存权限看 `role:write` |

权限分配页的分组标题用第 3 节的四个组名（能力、运行、安全、系统），组内顺序与清单一致。未知前缀仍按权限码前缀兜底，避免以后加码后页面空白。

登录落地页：有 `analytics:read` 进用量分析，否则按会话、Agent、用户、系统设置、模型的顺序找第一个有读权限的页面。不再因为 `isAdmin` 就强制进用量分析——管理员若被拿掉 `analytics:read`，不应落在一个自己打不开的地址。

头部「修改密码」继续只要求登录本人操作，不随 `user:write` 调整（现状把该项绑在 `user:write` 上，本次不顺手改产品行为）。

## 7. 验收

- 系统管理员打开角色权限页，能看到第 3 节全部 28 个码，分组为中文，且自己的角色已勾选全部新增码。
- 只授某一菜单的读权限：能进该页，看不到或点不了写操作；直接调写接口返回无权限。
- 只授写权限、不授读权限：进不了对应菜单。写接口本身仍只校验写码，与现在 Agent、模型的行为一致。
- 有 `session:read`、没有 `session:write`：能看会话列表和详情，归档和删除被拒绝。
- 有 `user:write`、没有 `role:write`：能在用户表单里改角色，进不了角色权限页，也不能改角色的权限集合。
- 有 `agent:write`、没有 `mcp:read`：Agent 表单仍能拉到已启用 MCP；进不了 MCP 管理页。
- 普通用户角色的权限集合不变。桌面选模型、个人技能、个人 MCP、本人定时任务不要求新码。
- `USER` 以外、迁移前已有 `agent:read` 的角色，迁移后仍能打开 Skills；已有 `session:read` 的仍能打开定时任务；已有 `user:read` 的仍能打开审计；已有 `user:write` 的仍能打开角色权限。
- 后端相关路由测试覆盖新码的通过与拒绝。`mao permission list` 能列出新码。
