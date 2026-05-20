# Agent Workbench - 开发进度文档

> 最后更新: 2026-05-20 (Phase 1 MVP 已完成，进入 Phase 2)

## 项目概述

Agent Workbench 是一个企业级 AI Agent 管理平台，包含三个子系统：
- **Backend** - Java Spring Boot 后端服务 (端口 9080)
- **Admin** - Vue 3 管理后台 (端口 5200)
- **Desktop** - Electron 桌面客户端 (端口 5201)

---

## 一、基础设施 (已完成)

### 1.1 项目脚手架
| 模块 | 技术栈 | 状态 |
|------|--------|------|
| Backend | Spring Boot 3.5.14, Java 17, Maven, MyBatis-Plus 3.5.6 | 已完成 |
| Admin | Vue 3, Element Plus, Pinia, Vue Router, Axios | 已完成 |
| Desktop | Electron 28, Vue 3, Element Plus | 已完成 |

### 1.2 后端基础设施
| 组件 | 文件 | 状态 |
|------|------|------|
| 统一响应封装 | `common/result/Result.java` | 已完成 |
| 错误码定义 | `common/result/ErrorCode.java` | 已完成 (18 个错误码) |
| 业务异常 | `common/exception/BusinessException.java` | 已完成 |
| 全局异常处理 | `common/exception/GlobalExceptionHandler.java` | 已完成 |
| Spring Security 配置 | `config/SecurityConfig.java` | 已完成 |
| JWT 过滤器 | `config/JwtAuthenticationFilter.java` | 已完成 (含 SSE query param fallback) |
| CORS 配置 | `config/WebMvcConfig.java` | 已完成 |
| MyBatis-Plus 分页 | `config/MybatisPlusConfig.java` | 已完成 |
| MyBatis-Plus 自动填充 | `config/MybatisPlusMetaObjectHandler.java` | 已完成 |
| Redis 配置 | `config/RedisConfig.java` | 已完成 |
| 审计拦截器 | `audit/interceptor/AuditInterceptor.java` | 部分完成 (仅日志，未持久化) |

### 1.3 数据库
- MySQL: `120.26.109.221:3306/agentworkbench2`
- Redis: `120.26.109.221:6379` (database 1)
- 建表脚本: `V001__init_schema.sql` - **17 张表已创建**
- HikariCP: maximum-pool-size=20, connection-timeout=10s

---

## 二、认证模块 (已完成)

### 2.1 后端认证
| 功能 | 文件 | 状态 |
|------|------|------|
| JWT 服务 (生成/验证/解析) | `auth/service/JwtService.java` | 已完成 |
| 本地账号登录 | `auth/service/AuthService.java` | 已完成 |
| Token 刷新 | `auth/service/AuthService.java` | 已完成 |
| 登出 (Redis 黑名单) | `auth/service/AuthService.java` | 已完成 |
| 登录接口 | `auth/controller/AuthController.java` | 已完成 |
| 刷新接口 | `auth/controller/AuthController.java` | 已完成 |
| 登出接口 | `auth/controller/AuthController.java` | 已完成 |
| 获取当前用户 | `user/controller/UserController.java` GET /me | 已完成 |
| 飞书 OAuth | `auth/controller/AuthController.java` | TODO (Phase 3) |

### 2.2 前端认证
| 功能 | 文件 | 状态 |
|------|------|------|
| Admin 登录页 | `admin/src/views/auth/LoginView.vue` | 已完成 |
| Desktop 登录页 | `desktop/src/views/auth/LoginView.vue` | 已完成 |
| Auth Store (Admin) | `admin/src/stores/auth.ts` | 已完成 |
| Auth Store (Desktop) | `desktop/src/stores/auth.ts` | 已完成 |
| 路由守卫 (Admin) | `admin/src/router/index.ts` | 已完成 |
| 路由守卫 (Desktop) | `desktop/src/router/index.ts` | 已完成 |

### 2.3 默认账号
- 用户名: `admin`, 密码: `admin123`, 角色: 系统管理员

---

## 三、Harness 核心引擎 (已完成)

### 3.1 LLM 适配层
| 组件 | 文件 | 状态 |
|------|------|------|
| LLM 适配器接口 | `harness/llm/LlmAdapter.java` | 已完成 |
| OpenAI 协议流式调用 | `harness/llm/OpenAiLlmAdapter.java` stream() | 已完成 |
| OpenAI 协议同步调用 | `harness/llm/OpenAiLlmAdapter.java` chat() | 已完成 |
| 请求/响应数据类 | `ChatRequest.java`, `ChatResponse.java`, `StreamChunk.java` 等 | 已完成 |

### 3.2 Agent 执行核心
| 组件 | 文件 | 状态 |
|------|------|------|
| Agent 执行上下文 | `harness/core/AgentExecutionContext.java` | 已完成 |
| Agent 事件监听接口 | `harness/core/AgentEventListener.java` | 已完成 |
| Prompt 构建引擎 | `harness/core/PromptEngine.java` | 已完成 |
| Agent 循环 (Think-Act-Observe) | `harness/core/AgentLoop.java` | 已完成 (含工具执行 + 消息持久化回调) |
| 上下文压缩管理 | `harness/core/ContextManager.java` | TODO (Phase 4) |
| Harness 编排服务 | `harness/core/HarnessService.java` | 已完成 (从 DB 加载配置，ConcurrentHashMap 事件桥接) |

### 3.3 Skill 系统
| 组件 | 文件 | 状态 |
|------|------|------|
| Skill 接口 | `harness/skill/Skill.java` | 已完成 |
| Skill 注册中心 | `harness/skill/SkillRegistry.java` | 已完成 |
| Skill 调度器 | `harness/skill/SkillDispatcher.java` | 已完成 (MCP 委派 TODO) |

### 3.4 MCP 协议
| 组件 | 文件 | 状态 |
|------|------|------|
| MCP 工具数据类 | `harness/mcp/McpTool.java` | 已完成 (stub) |
| MCP 客户端 | `harness/mcp/McpClient.java` | 已完成 (stub) |

---

## 四、Phase 1 MVP (已完成 ✅)

> 验收通过: 2026-05-20

### 4.1 后端 Controller 状态
| 模块 | Controller | 已实现接口 | TODO 接口 |
|------|-----------|-----------|-----------|
| 认证 | AuthController | login, refresh, logout | feishu/qrcode, feishu/callback |
| 用户 | UserController | GET /me, listUsers, updateUserStatus | - |
| 模型 | ModelController | 全部 6 个接口 (CRUD + test) | - |
| Agent | AgentController | 全部 6 个接口 (CRUD + publish) | - |
| 会话 | SessionController | 全部 7 个接口 (CRUD + pin + messages + stream) | - |

### 4.2 后端 Service 状态
| Service | 状态 |
|---------|------|
| AuthService | 已完成 |
| JwtService | 已完成 |
| ModelService | 已完成 |
| AgentService | 已完成 (含 skillIds/mcpConfigs 处理) |
| SessionService | 已完成 |
| UserService | 已完成 |
| SkillService | 已完成 |
| HubService | 已完成 |
| PermissionService | 已完成 |
| AuditService | Phase 3 |

### 4.3 前端页面状态

**Admin 管理后台:**
| 页面 | 文件 | UI 状态 | 后端对接 |
|------|------|---------|---------|
| 登录 | auth/LoginView.vue | 已完成 | 已对接 |
| Agent 管理 | agent/AgentListView.vue | 已完成 | 已对接 |
| 模型管理 | model/ModelListView.vue | 已完成 | 已对接 |
| 用户管理 | user/UserListView.vue | 已完成 | 已对接 |
| Skill 管理 | skill/SkillListView.vue | 已完成 | API 调用已写，后端 Phase 2 |
| Hub 管理 | hub/HubManageView.vue | 已完成 | API 调用已写，后端 Phase 2 |
| 审计日志 | audit/AuditLogView.vue | 已完成 | API 调用已写，后端 Phase 3 |
| 系统配置 | system/SystemConfigView.vue | 部分完成 | 保存为 TODO |

**Desktop 桌面客户端:**
| 页面 | 文件 | UI 状态 | 后端对接 |
|------|------|---------|---------|
| 登录 | auth/LoginView.vue | 已完成 | 已对接 |
| 工作台 | workbench/WorkbenchView.vue | 已完成 | 已对接 |
| 聊天 | chat/ChatView.vue | 已完成 | SSE 流式已对接 |
| Hub 浏览 | hub/HubView.vue | 已完成 | API 调用已写，后端 Phase 2 |
| 创建 Agent | agent-create/CreateAgentView.vue | 已完成 | API 调用已写，后端 Phase 2 |
| 设置 | settings/SettingsView.vue | 已完成 | 本地存储 |

### 4.4 Phase 1 验收结果
| 验收项 | 状态 |
|--------|------|
| 管理员配置 LLM 模型 (baseUrl/apiKey/modelId) | ✅ 通过 |
| 创建 Agent 关联模型和系统提示词 | ✅ 通过 |
| 用户选择 Agent 发起对话 | ✅ 通过 |
| 流式输出 (SSE) | ✅ 通过 (Access GPT-5.4 端到端验证) |
| 消息持久化 + 历史查看 | ✅ 通过 (含 token 统计) |

---

## 五、Phase 2 开发中 🚧

> 目标: Agent 能力增强 — Skills/MCP/Hub/RBAC
> 开始日期: 2026-05-20

### 5.1 内置 Skills 体系
| 组件 | 状态 |
|------|------|
| Skill 实体/Mapper | TODO |
| SkillService CRUD | TODO |
| SkillController | TODO (替换现有 stub) |
| HttpRequestSkill 实现 | TODO |
| Skill 执行沙箱 | TODO |
| SkillRegistry 从 DB 加载 | TODO |

### 5.2 MCP 协议对接
| 组件 | 状态 |
|------|------|
| McpClient 完整实现 | TODO |
| MCP Server 配置管理 | TODO |
| MCP 工具发现 | TODO |
| MCP 工具调用 | TODO |

### 5.3 AgentLoop 工具执行闭环
| 组件 | 状态 |
|------|------|
| SkillDispatcher 接入 Skill 执行 | TODO |
| MCP 工具委派 | TODO |
| 工具调用超时控制 | TODO |

### 5.4 用户自建 Agent
| 组件 | 状态 |
|------|------|
| Agent 创建 (含 Skills/MCP) | TODO |
| Desktop CreateAgentView 对接 | TODO |

### 5.5 Agent Hub
| 组件 | 状态 |
|------|------|
| HubService | TODO |
| HubController | TODO |
| Desktop HubView 对接 | TODO |

### 5.6 RBAC 权限体系
| 组件 | 状态 |
|------|------|
| PermissionService | TODO |
| @RequirePermission 注解 | TODO |
| 前端 v-permission 指令 | TODO |

---

## 六、数据库表结构 (17 张表)

| 表名 | 用途 | 有种子数据 |
|------|------|-----------|
| user | 用户账号 | 是 (admin) |
| role | 角色定义 | 是 (ADMIN, USER) |
| user_role | 用户-角色关联 | 是 |
| permission | 权限定义 | 是 (8 个权限) |
| role_permission | 角色-权限关联 | 是 |
| department | 部门层级 | 否 |
| llm_model | LLM 模型配置 | 否 (已有 3 条) |
| agent | Agent 定义 | 否 (已有 3 条) |
| agent_tag | Agent 标签 | 否 |
| agent_skill | Agent-Skill 关联 | 否 |
| agent_mcp_config | Agent MCP 配置 | 否 |
| agent_permission | Agent 访问控制 | 否 |
| skill | Skill 定义 | 否 |
| session | 会话 | 否 |
| message | 消息 | 否 |
| hub_installation | Hub 安装记录 | 否 |
| audit_log | 审计日志 | 否 |
| api_call_log | API 调用日志 | 否 |

---

## 七、开发路线图

> 详细需求文档见各阶段文档

| 阶段 | 主题 | 状态 | 文档 |
|------|------|------|------|
| Phase 1 | MVP - Agent 能跑起来 | ✅ 已完成 | [phase-1-mvp.md](phase-1-mvp.md) |
| Phase 2 | Agent 能力增强 - Skills/MCP/Hub/RBAC | 🚧 进行中 | [phase-2-agent-capability.md](phase-2-agent-capability.md) |
| Phase 3 | 企业级特性 - 审计/文件/认证/统计 | TODO | [phase-3-enterprise.md](phase-3-enterprise.md) |
| Phase 4 | 平台化 - Hub增强/分析/开放API/自动更新 | TODO | [phase-4-platform.md](phase-4-platform.md) |

---

## 八、服务端口

| 服务 | 端口 |
|------|------|
| Backend | 9080 |
| Admin | 5200 |
| Desktop | 5201 |
| MySQL | 120.26.109.221:3306 |
| Redis | 120.26.109.221:6379 |
| Swagger UI | http://localhost:9080/api/swagger-ui.html |
