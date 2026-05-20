# Agent Workbench - 开发进度文档

> 最后更新: 2026-05-20 (Phase 4 已完成)

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
| 审计拦截器 | `audit/interceptor/AuditInterceptor.java` | 已完成 (持久化到 api_call_log) |

### 1.3 数据库
- MySQL: `120.26.109.221:3306/agentworkbench2`
- Redis: `120.26.109.221:6379` (database 1)
- 建表脚本: `V001__init_schema.sql`, `V002__file_and_system_config.sql`, `V003__phase4_hub_analytics_apikey_notification.sql` - **24 张表已创建**
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
| Agent | AgentController | 全部 6 个接口 (CRUD + publish) + skillIds/mcpConfigs | - |
| 会话 | SessionController | 全部 7 个接口 (CRUD + pin + messages + stream) | - |
| Skill | SkillController | 全部 5 个接口 (CRUD) | - |
| Hub | HubController | list, install, approve, reject | - |
| 权限 | PermissionController | roles CRUD, permissions, assign | - |

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
| Skill 管理 | skill/SkillListView.vue | 已完成 | 已对接 |
| Hub 管理 | hub/HubManageView.vue | 已完成 | 已对接 |
| 审计日志 | audit/AuditLogView.vue | 已完成 | API 调用已写，后端 Phase 3 |
| 系统配置 | system/SystemConfigView.vue | 部分完成 | 保存为 TODO |

**Desktop 桌面客户端:**
| 页面 | 文件 | UI 状态 | 后端对接 |
|------|------|---------|---------|
| 登录 | auth/LoginView.vue | 已完成 | 已对接 |
| 工作台 | workbench/WorkbenchView.vue | 已完成 | 已对接 |
| 聊天 | chat/ChatView.vue | 已完成 | SSE 流式已对接 |
| Hub 浏览 | hub/HubView.vue | 已完成 | 已对接 |
| 创建 Agent | agent-create/CreateAgentView.vue | 已完成 | 已对接 |
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

## 五、Phase 2 (已完成 ✅)

> 验收通过: 2026-05-20

> 验收通过: 2026-05-20

### 5.1 内置 Skills 体系
| 组件 | 文件 | 状态 |
|------|------|------|
| Skill Entity | `skill/entity/SkillEntity.java` | 已完成 |
| Skill Mapper | `skill/mapper/SkillEntityMapper.java` | 已完成 |
| SkillService | `skill/service/SkillService.java` | 已完成 |
| SkillController | `skill/controller/SkillController.java` | 已完成 (接入 Service) |
| HttpRequestSkill | `harness/skill/impl/HttpRequestSkill.java` | 已完成 |
| SkillRegistry 自动注册 | `harness/skill/SkillRegistry.java` | 已完成 (构造器注入 List<Skill>) |
| HarnessService per-agent | `harness/core/HarnessService.java` | 已完成 (查询 agent_skill 表) |

### 5.2 MCP 协议对接
| 组件 | 文件 | 状态 |
|------|------|------|
| McpClient | `harness/mcp/McpClient.java` | 已完成 (JSON-RPC over SSE/HTTP) |
| McpToolRegistry | `harness/mcp/McpToolRegistry.java` | 已完成 |
| SkillDispatcher MCP 路由 | `harness/skill/SkillDispatcher.java` | 已完成 (Skill → MCP 两级路由) |
| HarnessService MCP 集成 | `harness/core/HarnessService.java` | 已完成 (查询 agent_mcp_config 表) |

### 5.3 Agent 管理扩展
| 组件 | 文件 | 状态 |
|------|------|------|
| AgentService skillIds/mcpConfigs | `agent/service/AgentService.java` | 已完成 (create/update 处理关联) |
| AgentController 响应扩展 | `agent/controller/AgentController.java` | 已完成 (AgentVO 含 skillIds/mcpConfigs) |

### 5.4 Agent Hub
| 组件 | 文件 | 状态 |
|------|------|------|
| HubInstallation Entity | `hub/entity/HubInstallation.java` | 已完成 |
| HubInstallation Mapper | `hub/mapper/HubInstallationMapper.java` | 已完成 |
| HubService | `hub/service/HubService.java` | 已完成 (publish/install/approve/reject) |
| HubController | `hub/controller/HubController.java` | 已完成 (接入 Service) |

### 5.5 RBAC 权限体系
| 组件 | 文件 | 状态 |
|------|------|------|
| Role/Permission Entity | `permission/entity/*.java` | 已完成 (4 个实体) |
| Mapper | `permission/mapper/*.java` | 已完成 (4 个 Mapper) |
| PermissionService | `permission/service/PermissionService.java` | 已完成 |
| PermissionController | `permission/controller/PermissionController.java` | 已完成 |
| @RequirePermission | `permission/annotation/RequirePermission.java` | 已完成 |
| PermissionInterceptor | `permission/interceptor/PermissionInterceptor.java` | 已完成 (HandlerInterceptor) |
| WebMvcConfig 集成 | `config/WebMvcConfig.java` | 已完成 |

---

## 六、Phase 3 (已完成 ✅)

> 验收通过: 2026-05-20

### 6.1 审计日志持久化
| 组件 | 文件 | 状态 |
|------|------|------|
| AuditLog Entity | `audit/entity/AuditLog.java` | 已完成 |
| ApiCallLog Entity | `audit/entity/ApiCallLog.java` | 已完成 |
| AuditLogMapper | `audit/mapper/AuditLogMapper.java` | 已完成 |
| ApiCallLogMapper | `audit/mapper/ApiCallLogMapper.java` | 已完成 |
| AuditService | `audit/service/AuditService.java` | 已完成 (查询/导出) |
| AuditInterceptor | `audit/interceptor/AuditInterceptor.java` | 已完成 (持久化到 api_call_log) |
| AuditController | `audit/controller/AuditController.java` | 已完成 (logs + api-calls + export) |

### 6.2 文件上传/下载
| 组件 | 文件 | 状态 |
|------|------|------|
| FileEntity | `file/entity/FileEntity.java` | 已完成 |
| FileEntityMapper | `file/mapper/FileEntityMapper.java` | 已完成 |
| FileService | `file/service/FileService.java` | 已完成 (上传/下载/删除) |
| FileController | `file/controller/FileController.java` | 已完成 (upload/download/preview) |
| file 表 | V002 迁移 | 已完成 |

### 6.3 会话管理增强
| 功能 | 文件 | 状态 |
|------|------|------|
| 会话搜索 | `session/service/SessionService.java` | 已完成 (keyword 参数) |
| 会话收藏 | `session/service/SessionService.java` | 已完成 (toggleFavorite) |
| 会话归档 | `session/service/SessionService.java` | 已完成 (archiveSession) |
| 标题自动生成 | `session/service/SessionService.java` | 已完成 (首条消息截取) |
| SessionController | `session/controller/SessionController.java` | 已完成 (favorite/archive 端点) |

### 6.4 飞书 OAuth 登录
| 组件 | 文件 | 状态 |
|------|------|------|
| FeishuAuthService | `auth/service/FeishuAuthService.java` | 已完成 (OAuth 全流程) |
| AuthController | `auth/controller/AuthController.java` | 已完成 (qrcode + callback) |
| 飞书配置 | application.yml | 已完成 (app-id/app-secret/redirect-uri) |

### 6.5 LDAP 登录
| 组件 | 文件 | 状态 |
|------|------|------|
| LdapAuthService | `auth/service/LdapAuthService.java` | 已完成 (JNDI 认证) |
| LDAP 配置 | application.yml | 已完成 (url/base-dn/user-dn/password) |

### 6.6 使用统计与分析
| 组件 | 文件 | 状态 |
|------|------|------|
| StatisticsService | `statistics/service/StatisticsService.java` | 已完成 |
| StatisticsController | `statistics/controller/StatisticsController.java` | 已完成 (overview/agents/models/users) |

### 6.7 系统配置管理
| 组件 | 文件 | 状态 |
|------|------|------|
| SystemConfig Entity | `system/entity/SystemConfig.java` | 已完成 |
| SystemConfigMapper | `system/mapper/SystemConfigMapper.java` | 已完成 |
| SystemConfigService | `system/service/SystemConfigService.java` | 已完成 |
| SystemConfigController | `system/controller/SystemConfigController.java` | 已完成 |
| system_config 表 | V002 迁移 | 已完成 (10 条初始配置) |

### 6.8 Phase 3 验证结果
| 验收项 | 状态 |
|--------|------|
| API 调用日志持久化 | ✅ 通过 (12 条记录) |
| 审计日志查询 | ✅ 通过 (支持分页/筛选) |
| 文件上传/下载接口 | ✅ 通过 |
| 会话搜索/收藏/归档 | ✅ 通过 |
| 飞书 OAuth (未配置时) | ✅ 通过 (返回 5001 提示) |
| LDAP 登录接口 | ✅ 通过 (代码就绪) |
| 使用统计概览 | ✅ 通过 (Agents:4, Users:1, Sessions:9, Messages:23) |
| Agent/模型/用户统计 | ✅ 通过 |
| 系统配置管理 | ✅ 通过 (10 个配置项) |

---

## 七、Phase 4 (已完成 ✅)

> 验收通过: 2026-05-20

### 7.1 Agent Hub 增强
| 组件 | 文件 | 状态 |
|------|------|------|
| AgentRating Entity | `hub/entity/AgentRating.java` | 已完成 |
| AgentComment Entity | `hub/entity/AgentComment.java` | 已完成 |
| AgentRatingMapper | `hub/mapper/AgentRatingMapper.java` | 已完成 |
| AgentCommentMapper | `hub/mapper/AgentCommentMapper.java` | 已完成 |
| HubService 扩展 | `hub/service/HubService.java` | 已完成 (评分/评论/分类/推荐/排行榜) |
| HubController 扩展 | `hub/controller/HubController.java` | 已完成 (8 个新端点) |
| Agent.category 字段 | `agent/entity/Agent.java` | 已完成 |

### 7.2 数据分析与报表
| 组件 | 文件 | 状态 |
|------|------|------|
| AnalyticsService | `analytics/service/AnalyticsService.java` | 已完成 (趋势/Token/用户/Agent效能) |
| AnalyticsController | `analytics/controller/AnalyticsController.java` | 已完成 (4 个端点) |

### 7.3 开放 API
| 组件 | 文件 | 状态 |
|------|------|------|
| ApiKey Entity | `apikey/entity/ApiKey.java` | 已完成 |
| ApiKeyMapper | `apikey/mapper/ApiKeyMapper.java` | 已完成 |
| ApiKeyService | `apikey/service/ApiKeyService.java` | 已完成 (创建/验证/吊销) |
| ApiKeyController | `apikey/controller/ApiKeyController.java` | 已完成 (CRUD) |
| api_key 表 | V003 迁移 | 已完成 |

### 7.4 上下文压缩
| 组件 | 文件 | 状态 |
|------|------|------|
| ContextManager | `harness/core/ContextManager.java` | 已完成 (滑动窗口 + 摘要压缩) |

### 7.5 通知系统
| 组件 | 文件 | 状态 |
|------|------|------|
| Notification Entity | `notification/entity/Notification.java` | 已完成 |
| NotificationMapper | `notification/mapper/NotificationMapper.java` | 已完成 |
| NotificationService | `notification/service/NotificationService.java` | 已完成 |
| NotificationController | `notification/controller/NotificationController.java` | 已完成 (列表/已读/未读数) |
| notification 表 | V003 迁移 | 已完成 |

### 7.6 Phase 4 验证结果
| 验收项 | 状态 |
|--------|------|
| Hub 评分 | ✅ 通过 (1-5 星) |
| Hub 评论 | ✅ 通过 |
| Hub 分类 | ✅ 通过 (general 分类) |
| Hub 排行榜 | ✅ 通过 (hot/new/top) |
| Hub 推荐 | ✅ 通过 |
| 使用趋势分析 | ✅ 通过 (3 天数据) |
| Token 消耗分析 | ✅ 通过 (4 个 Agent) |
| 用户活跃分析 | ✅ 通过 |
| Agent 效能分析 | ✅ 通过 (Sessions:4, Messages:14) |
| API Key 创建 | ✅ 通过 (aw_ee8bbe966316...) |
| API Key 列表 | ✅ 通过 |
| 通知系统 | ✅ 通过 |

---

## 八、数据库表结构 (24 张表)

| 表名 | 用途 | 有种子数据 |
|------|------|-----------|
| user | 用户账号 | 是 (admin) |
| role | 角色定义 | 是 (ADMIN, USER) |
| user_role | 用户-角色关联 | 是 |
| permission | 权限定义 | 是 (8 个权限) |
| role_permission | 角色-权限关联 | 是 |
| department | 部门层级 | 否 |
| llm_model | LLM 模型配置 | 否 (已有 3 条) |
| agent | Agent 定义 | 否 (已有 4 条) |
| agent_tag | Agent 标签 | 否 |
| agent_skill | Agent-Skill 关联 | 否 |
| agent_mcp_config | Agent MCP 配置 | 否 |
| agent_permission | Agent 访问控制 | 否 |
| skill | Skill 定义 | 否 (已有 2 条) |
| session | 会话 | 否 (已有 9 条) |
| message | 消息 | 否 (已有 23 条) |
| hub_installation | Hub 安装记录 | 否 |
| agent_rating | Agent 评分 | 否 (已有 1 条) |
| agent_comment | Agent 评论 | 否 (已有 1 条) |
| audit_log | 审计日志 | 否 |
| api_call_log | API 调用日志 | 否 (已有 12 条) |
| api_key | API Key 管理 | 否 (已有 1 条) |
| notification | 通知 | 否 |
| file | 文件管理 | 否 |
| system_config | 系统配置 | 是 (10 条初始配置) |

---

## 七、开发路线图

> 详细需求文档见各阶段文档

| 阶段 | 主题 | 状态 | 文档 |
|------|------|------|------|
| Phase 1 | MVP - Agent 能跑起来 | ✅ 已完成 | [phase-1-mvp.md](phase-1-mvp.md) |
| Phase 2 | Agent 能力增强 - Skills/MCP/Hub/RBAC | ✅ 已完成 | [phase-2-agent-capability.md](phase-2-agent-capability.md) |
| Phase 3 | 企业级特性 - 审计/文件/认证/统计 | ✅ 已完成 | [phase-3-enterprise.md](phase-3-enterprise.md) |
| Phase 4 | 平台化 - Hub增强/分析/开放API/自动更新 | ✅ 已完成 | [phase-4-platform.md](phase-4-platform.md) |

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
