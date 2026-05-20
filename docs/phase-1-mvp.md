# Phase 1 - MVP: Agent 能跑起来

> 目标: 打通核心链路 — 管理员配置模型 → 创建 Agent → 用户选择 Agent → 对话交互 → 流式输出
> 预计周期: 2-3 周

---

## 1. 本期目标

让系统从"脚手架"变成"可用产品"。用户登录后能选择一个 Agent 进行对话，Agent 能调用 LLM 返回流式结果。

**验收标准:**
- 管理员可在 Admin 后台配置 LLM 模型（填写 baseUrl/apiKey/modelId）
- 管理员可创建 Agent 并关联模型和系统提示词
- 桌面端用户登录后能看到 Agent 列表
- 用户点击 Agent 可发起对话，看到流式输出
- 对话消息持久化到数据库，刷新后可查看历史

---

## 2. 功能清单

### 2.1 模型管理 (Admin 后台)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 模型列表 | 展示已配置的模型，支持启用/禁用 | P0 |
| 创建模型 | 填写 name、provider、baseUrl、apiKey、modelId、maxTokens | P0 |
| 编辑模型 | 修改模型配置 | P0 |
| 删除模型 | 删除模型配置 | P0 |
| 测试连通性 | 调用 LLM API 验证配置是否正确 | P1 |

**依赖:** 无 (基础功能)

**后端实现:**
- `ModelService` - CRUD 逻辑
- `ModelController` - 完善现有 stub，接入 Service
- `llm_model` 表已存在，无需改表

---

### 2.2 Agent 管理 (Admin 后台)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Agent 列表 | 展示所有 Agent，支持搜索 | P0 |
| 创建 Agent | 填写名称、描述、系统提示词、关联模型 | P0 |
| 编辑 Agent | 修改 Agent 配置 | P0 |
| 删除 Agent | 删除 Agent | P0 |

**依赖:** 模型管理 (需要关联模型)

**后端实现:**
- `AgentService` - CRUD 逻辑
- `AgentController` - 完善现有 stub
- `agent` 表已存在，无需改表

---

### 2.3 会话与消息 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 创建会话 | 用户选择 Agent 后创建 session | P0 |
| 会话列表 | 获取用户的历史会话列表 | P0 |
| 会话详情 | 获取单个会话信息 | P0 |
| 删除会话 | 删除会话及其消息 | P1 |
| 历史消息 | 获取会话下的消息列表 | P0 |
| 发送消息 | 用户发送消息，触发 Agent 执行 | P0 |

**依赖:** Agent 管理 (会话关联 Agent)

**后端实现:**
- `SessionService` - 会话和消息 CRUD
- `SessionController` - 完善现有 stub
- `session`、`message` 表已存在

---

### 2.4 Harness 接入真实配置 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| HarnessService 从 DB 加载配置 | 替换硬编码，从 agent/llm_model 表读取 | P0 |
| AgentLoop 接入 SkillDispatcher | 工具调用时走 SkillDispatcher 分发 | P1 |
| AgentLoop 消息持久化 | 每轮对话的 user/assistant/tool 消息写入 message 表 | P0 |

**依赖:** Agent 管理、会话管理

**后端实现:**
- 修改 `HarnessService.buildContext()` 从数据库加载
- 修改 `AgentLoop.execute()` 接入工具执行
- 在 AgentLoop 回调中写入 message 表

---

### 2.5 桌面端工作台 (Desktop)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Agent 列表展示 | 工作台首页展示可用 Agent | P0 |
| 进入对话 | 点击 Agent 进入 ChatView | P0 |
| 流式对话 | SSE 流式输出，展示 Agent 回复 | P0 |
| 工具调用展示 | 展示 Agent 的 Skill 调用过程 | P1 |
| 历史消息加载 | 进入会话时加载历史消息 | P0 |

**依赖:** 后端会话/消息接口

---

### 2.6 用户列表 (Admin 后台)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 用户列表 | 展示所有用户，支持分页 | P1 |
| 启用/禁用用户 | 切换用户状态 | P1 |

**依赖:** 无 (独立功能)

**后端实现:**
- `UserController.listUsers()` 和 `updateUserStatus()` 完善

---

## 3. 依赖关系图

```
模型管理 ──────┐
              ▼
         Agent 管理 ──┐
                      ▼
              会话与消息管理 ──┐
                              ▼
                    Harness 接入 DB ──┐
                                      ▼
                              桌面端对话功能
```

**开发顺序:**
1. 模型管理 (无依赖，可立即开始)
2. Agent 管理 (依赖模型)
3. 会话与消息管理 (依赖 Agent)
4. Harness 接入真实配置 (依赖以上全部)
5. 桌面端对话功能 (依赖后端接口)

---

## 4. API 接口清单

### 模型管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/models` | 模型列表 |
| POST | `/api/v1/models` | 创建模型 |
| PUT | `/api/v1/models/{id}` | 更新模型 |
| DELETE | `/api/v1/models/{id}` | 删除模型 |
| POST | `/api/v1/models/{id}/test` | 测试连通性 |

### Agent 管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/agents` | Agent 列表 |
| GET | `/api/v1/agents/{id}` | Agent 详情 |
| POST | `/api/v1/agents` | 创建 Agent |
| PUT | `/api/v1/agents/{id}` | 更新 Agent |
| DELETE | `/api/v1/agents/{id}` | 删除 Agent |

### 会话与消息
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/sessions` | 创建会话 |
| GET | `/api/v1/sessions` | 会话列表 |
| GET | `/api/v1/sessions/{id}` | 会话详情 |
| DELETE | `/api/v1/sessions/{id}` | 删除会话 |
| GET | `/api/v1/sessions/{id}/messages` | 历史消息 |
| POST | `/api/v1/sessions/{id}/messages` | 发送消息 |
| GET | `/api/v1/sessions/{id}/stream` | SSE 流式输出 |

### 用户管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/users` | 用户列表 |
| PUT | `/api/v1/users/{id}/status` | 启用/禁用用户 |

---

## 5. 不在本期范围

以下功能明确推迟到后续阶段:
- Skills 管理和内置 Skill 实现
- MCP 协议对接
- Agent Hub (发布/安装)
- 审计日志持久化
- 飞书 OAuth 登录
- 上下文压缩
- RBAC 细粒度权限
- 文件上传/下载
