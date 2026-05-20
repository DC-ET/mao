# Phase 2 - Agent 能力增强

> 目标: 让 Agent 从"能对话"变成"能干活" — 接入 Skills 工具体系、MCP 协议、用户自建 Agent、企业 Hub、RBAC 权限
> 预计周期: 3-4 周
> 前置依赖: Phase 1 MVP 完成

---

## 1. 本期目标

在 Phase 1 打通核心链路的基础上，赋予 Agent 真正的工具调用能力，让用户可以创建自己的 Agent，并在企业内部共享。

**验收标准:**
- Agent 能调用内置 Skills（如 HTTP 请求、代码执行、文件读写等）完成实际任务
- Agent 能通过 MCP 协议连接外部工具服务
- 普通用户可通过可视化界面创建个人 Agent 并配置 Skills/MCP
- 用户可将自己的 Agent 发布到企业 Hub，其他用户可浏览和安装
- 基于 RBAC 的权限控制，不同角色看到不同的 Agent 和功能

---

## 2. 功能清单

### 2.1 内置 Skills 体系 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Skill 注册与发现 | SkillRegistry 管理所有已注册的 Skill | P0 |
| Skill 执行沙箱 | Skill 在受限环境中执行，防止恶意操作 | P0 |
| HTTP 请求 Skill | 发起 HTTP GET/POST/PUT/DELETE 请求 | P0 |
| 代码执行 Skill | 执行 Python/JS 代码片段（沙箱隔离） | P1 |
| 文件读写 Skill | 读取/写入指定目录下的文件 | P1 |
| 数据库查询 Skill | 执行只读 SQL 查询（白名单库表） | P2 |
| Skill 管理接口 | Admin 后台管理 Skill 的 CRUD | P0 |
| Skill 权限控制 | 不同 Agent 可使用的 Skill 白名单 | P1 |

**依赖:** Phase 1 Harness 核心框架

**后端实现:**
- 完善 `SkillRegistry` — 从数据库加载 Skill 配置
- 实现 `SkillDispatcher` — 解析 LLM 工具调用意图，分发到对应 Skill
- 实现具体 Skill 类: `HttpRequestSkill`, `CodeExecutionSkill`, `FileOperationSkill`
- `SkillService` — Skill CRUD 逻辑
- `SkillController` — 完善现有 stub，接入 Service
- `skill` 表已存在，无需改表

---

### 2.2 MCP 协议对接 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| MCP Client 实现 | 实现 MCP 协议客户端，支持 stdio/SSE 传输 | P0 |
| MCP Server 配置 | Agent 可配置连接外部 MCP Server | P0 |
| MCP 工具发现 | 自动发现 MCP Server 提供的工具列表 | P0 |
| MCP 工具调用 | 通过 MCP 协议调用外部工具 | P0 |
| MCP 连接管理 | 连接池、重连、超时处理 | P1 |

**依赖:** Skill 体系 (SkillDispatcher 需要支持 MCP 委派)

**后端实现:**
- 实现 `McpClient` — MCP 协议通信
- 扩展 `SkillDispatcher` — 识别 MCP 工具调用并委派给 McpClient
- `agent_mcp_config` 表已存在，无需改表

---

### 2.3 用户自建 Agent (桌面端 + 后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 创建 Agent 表单 | 可视化配置名称、描述、图标、系统提示词 | P0 |
| Skills 选择 | 从已注册 Skills 中选择 Agent 可用的工具 | P0 |
| MCP 配置 | 填写 MCP Server URL，自动发现可用工具 | P0 |
| 模型选择 | 选择使用哪个已配置的 LLM 模型 | P0 |
| Agent 预览/测试 | 创建后可立即测试对话 | P1 |
| Agent 编辑 | 修改已创建的 Agent 配置 | P0 |
| Agent 删除 | 删除个人 Agent | P0 |

**依赖:** Skills 体系、MCP 对接、Agent 管理接口

**后端实现:**
- `AgentService` — Agent CRUD，关联 Skill/MCP/Model
- `AgentController` — 完善现有 stub
- `agent`, `agent_skill`, `agent_mcp_config` 表已存在

**前端实现:**
- Desktop `CreateAgentView.vue` — 已有 UI 框架，需对接后端
- Desktop `WorkbenchView.vue` — 展示个人创建的 Agent

---

### 2.4 Agent Hub (桌面端 + 后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 发布到 Hub | 用户可将个人 Agent 发布到企业 Hub | P0 |
| Hub 浏览 | 展示已发布的 Agent，支持搜索和筛选 | P0 |
| 安装 Agent | 从 Hub 安装 Agent 到自己的工作台 | P0 |
| 审核机制 | 管理员审核 Hub 中的 Agent | P1 |
| 使用统计 | 显示 Agent 的安装量、使用次数 | P2 |

**依赖:** 用户自建 Agent

**后端实现:**
- `HubService` — 发布、搜索、安装、审核逻辑
- `HubController` — 完善现有 stub
- `hub_installation` 表已存在

**前端实现:**
- Desktop `HubView.vue` — 已有 UI 框架，需对接后端
- Admin `HubManageView.vue` — 审核管理

---

### 2.5 RBAC 权限体系 (后端 + 前端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 角色管理 | 系统管理员、部门管理员、普通用户 | P0 |
| 权限定义 | 功能权限（管理模型/Agent/用户等） | P0 |
| 角色-权限分配 | 为角色分配权限 | P0 |
| 用户-角色分配 | 为用户分配角色 | P0 |
| Agent 访问控制 | 控制哪些角色/用户可以使用特定 Agent | P1 |
| 接口权限校验 | 基于注解的接口级权限校验 | P0 |
| 前端权限指令 | Vue 按钮级权限控制 | P1 |

**依赖:** 用户管理 (Phase 1 已完成基础)

**后端实现:**
- `PermissionService` — 权限校验逻辑
- `@RequirePermission` 注解 + AOP 拦截器
- `role`, `permission`, `role_permission`, `user_role` 表已有种子数据
- `agent_permission` 表已存在

**前端实现:**
- Admin 角色管理页面（新增）
- Admin 权限分配页面（新增）
- Vue `v-permission` 指令

---

### 2.6 AgentLoop 工具执行闭环 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 工具调用解析 | 解析 LLM 返回的 tool_calls | P0 |
| 工具执行 | 调用 SkillDispatcher 执行工具 | P0 |
| 结果回传 | 将工具执行结果回传给 LLM 继续推理 | P0 |
| 多轮工具调用 | 支持连续多轮工具调用循环 | P0 |
| 工具调用超时 | 单次工具调用超时控制 | P1 |
| 工具调用日志 | 记录每次工具调用的输入输出 | P1 |

**依赖:** Skills 体系、MCP 对接

**后端实现:**
- 修改 `AgentLoop.execute()` — 完整的 Think → Act → Observe 循环
- 接入 `SkillDispatcher` 进行工具执行
- 在回调中持久化工具调用消息到 `message` 表

---

## 3. 依赖关系图

```
内置 Skills 体系 ──────┐
                      ▼
               MCP 协议对接 ──┐
                              ▼
                    AgentLoop 工具闭环 ──┐
                                        ▼
                              用户自建 Agent ──┐
                                              ▼
                                        Agent Hub
                                              
RBAC 权限体系 (独立，可并行开发)
```

**开发顺序:**
1. 内置 Skills 体系 (无依赖，可立即开始)
2. MCP 协议对接 (依赖 Skill 框架)
3. AgentLoop 工具执行闭环 (依赖 Skills + MCP)
4. 用户自建 Agent (依赖以上全部)
5. Agent Hub (依赖用户自建 Agent)
6. RBAC 权限体系 (独立，可与 1-3 并行)

---

## 4. API 接口清单

### Skill 管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/skills` | Skill 列表 |
| POST | `/api/v1/skills` | 创建 Skill |
| PUT | `/api/v1/skills/{id}` | 更新 Skill |
| DELETE | `/api/v1/skills/{id}` | 删除 Skill |
| POST | `/api/v1/skills/{id}/test` | 测试 Skill |

### Agent 管理 (扩展)
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agents` | 创建 Agent (含 Skills/MCP 配置) |
| PUT | `/api/v1/agents/{id}` | 更新 Agent |
| POST | `/api/v1/agents/{id}/publish` | 发布到 Hub |

### Hub
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/hub/agents` | Hub Agent 列表 |
| POST | `/api/v1/hub/agents/{id}/install` | 安装 Agent |
| POST | `/api/v1/hub/agents/{id}/approve` | 审核通过 |
| POST | `/api/v1/hub/agents/{id}/reject` | 审核拒绝 |

### 权限管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/roles` | 角色列表 |
| POST | `/api/v1/roles` | 创建角色 |
| PUT | `/api/v1/roles/{id}` | 更新角色 |
| GET | `/api/v1/permissions` | 权限列表 |
| PUT | `/api/v1/roles/{id}/permissions` | 分配权限 |
| PUT | `/api/v1/users/{id}/roles` | 分配角色 |

---

## 5. 不在本期范围

以下功能明确推迟到后续阶段:
- 审计日志持久化
- 文件上传/下载
- 飞书 OAuth / LDAP 登录
- 上下文压缩
- 使用统计与分析
- 桌面客户端自动更新
