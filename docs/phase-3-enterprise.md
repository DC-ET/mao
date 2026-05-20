# Phase 3 - 企业级特性

> 目标: 让系统从"能用"变成"企业可用" — 审计日志持久化、文件处理、会话管理增强、使用统计、飞书/LDAP 认证
> 预计周期: 3-4 周
> 前置依赖: Phase 1 MVP 完成; Phase 2 中 Skills 体系和 AgentLoop 闭环完成

---

## 1. 本期目标

补齐企业级部署所需的审计、安全、文件处理和认证对接能力，使系统满足企业合规和运维需求。

**验收标准:**
- 所有 API 调用和 Agent 对话记录可持久化查询和导出
- 用户可上传文件给 Agent 处理，Agent 可生成文件供下载
- 支持飞书扫码登录和 LDAP 认证
- 管理后台可查看 Agent 使用统计和用户活跃度
- 系统配置可通过管理后台持久化管理

---

## 2. 功能清单

### 2.1 审计日志持久化 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| API 调用日志 | 记录所有 API 请求的用户、时间、路径、参数、响应 | P0 |
| Agent 对话日志 | 完整对话记录可回溯查看 | P0 |
| 操作审计日志 | 管理操作（创建/修改/删除 Agent/模型/用户等）的变更记录 | P0 |
| 日志查询 | Admin 后台按时间、用户、类型筛选日志 | P0 |
| 日志导出 | 支持 CSV/JSON 格式导出 | P1 |
| 日志保留策略 | 配置日志保留天数，自动清理过期日志 | P2 |

**依赖:** Phase 1 审计拦截器框架

**后端实现:**
- 完善 `AuditInterceptor` — 持久化写入 `audit_log` 和 `api_call_log` 表
- `AuditService` — 日志查询、导出逻辑
- `AuditController` — 完善现有 stub
- `audit_log`, `api_call_log` 表已存在

**前端实现:**
- Admin `AuditLogView.vue` — 已有 UI 框架，需对接后端

---

### 2.2 文件上传/下载 (后端 + 桌面端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 文件上传 | 用户可上传文件（文档、图片、代码等） | P0 |
| 文件存储 | 文件存储到对象存储（MinIO/OSS）或本地 | P0 |
| 文件下载 | Agent 生成的文件可供用户下载 | P0 |
| 文件预览 | 支持图片、文本、PDF 预览 | P1 |
| 文件大小限制 | 可配置单文件大小上限和类型白名单 | P0 |
| 文件清理 | 会话删除时清理关联文件 | P1 |

**依赖:** 会话管理

**后端实现:**
- `FileService` — 文件上传、下载、存储逻辑
- `FileController` — 文件上传/下载接口
- 配置 MinIO 或本地存储路径
- 新增 `file` 表记录文件元数据

**前端实现:**
- Desktop ChatView — 文件上传按钮、文件消息展示
- 文件预览组件

---

### 2.3 会话管理增强 (桌面端 + 后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 会话列表 | 侧边栏展示历史会话列表 | P0 |
| 会话搜索 | 按标题/内容搜索历史会话 | P1 |
| 会话置顶 | 置顶重要会话 | P0 |
| 会话收藏 | 收藏常用会话 | P1 |
| 会话归档 | 归档旧会话，不在默认列表展示 | P2 |
| 多会话切换 | 快速在多个会话间切换 | P0 |
| 会话标题自动生成 | 基于首条消息自动生成会话标题 | P1 |

**依赖:** Phase 1 会话基础接口

**后端实现:**
- `SessionService` — 完善会话 CRUD，支持置顶/收藏/归档
- `SessionController` — 完善现有 stub
- `session` 表已有 `is_pinned`, `is_favorite` 字段

**前端实现:**
- Desktop 会话侧边栏组件
- Desktop ChatView — 多会话切换

---

### 2.4 飞书 OAuth 登录 (后端 + 前端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 飞书扫码登录 | 用户通过飞书扫码完成认证 | P0 |
| 飞书用户信息同步 | 同步飞书用户名、头像、部门 | P0 |
| 飞书账号绑定 | 已有账号可绑定飞书 | P1 |
| 飞书配置管理 | Admin 后台配置飞书 App ID/Secret | P0 |

**依赖:** 认证框架 (Phase 1 已完成)

**后端实现:**
- `FeishuAuthService` — 飞书 OAuth 流程
- `AuthController` — 实现 `/auth/feishu/qrcode` 和 `/auth/feishu/callback`
- 飞书配置存储（系统配置表或 application.yml）

**前端实现:**
- Admin/Desktop LoginView — 添加飞书扫码登录入口
- 飞书扫码弹窗组件

---

### 2.5 LDAP 登录 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| LDAP 认证 | 对接企业 LDAP 服务器进行用户认证 | P0 |
| 用户自动创建 | LDAP 认证成功后自动创建本地用户 | P0 |
| LDAP 配置管理 | Admin 后台配置 LDAP 服务器信息 | P0 |
| LDAP 同步 | 定期同步 LDAP 用户到本地 | P1 |

**依赖:** 认证框架

**后端实现:**
- `LdapAuthService` — LDAP 认证逻辑
- 扩展 `AuthService.login()` — 支持 LDAP 认证方式
- LDAP 配置存储

---

### 2.6 使用统计与分析 (后端 + Admin)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Agent 使用统计 | 每个 Agent 的对话次数、用户数、Token 消耗 | P0 |
| 用户活跃度 | 用户登录频率、对话频率 | P1 |
| 模型调用统计 | 各模型的调用次数、Token 消耗、响应时间 | P0 |
| Token 用量报表 | 按日/周/月的 Token 消耗趋势 | P1 |
| 数据概览 Dashboard | Admin 首页展示关键指标 | P1 |

**依赖:** 审计日志持久化

**后端实现:**
- `StatisticsService` — 统计查询逻辑
- `StatisticsController` — 统计接口
- 基于 `api_call_log` 和 `message` 表聚合查询

**前端实现:**
- Admin Dashboard 页面 — 图表展示统计数据

---

### 2.7 系统配置管理 (后端 + Admin)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 配置持久化 | 系统配置存储到数据库，非硬编码 | P0 |
| 配置分类 | 按模块分组展示配置项 | P1 |
| 配置修改 | Admin 后台修改配置并实时生效 | P0 |
| 配置变更日志 | 记录配置变更历史 | P2 |

**依赖:** 无

**后端实现:**
- `SystemConfigService` — 配置读写逻辑
- `SystemConfigController` — 配置接口
- 新增 `system_config` 表

**前端实现:**
- Admin `SystemConfigView.vue` — 已有 UI 框架，需对接后端

---

## 3. 依赖关系图

```
审计日志持久化 ──────┐
                    ▼
              使用统计与分析

文件上传/下载 (独立)

会话管理增强 (独立)

飞书 OAuth ──────┐
                ▼
          认证方式扩展
                ▲
LDAP 登录 ──────┘

系统配置管理 (独立)
```

**开发顺序:**
1. 审计日志持久化 → 使用统计与分析 (串行)
2. 文件上传/下载 (独立，可并行)
3. 会话管理增强 (独立，可并行)
4. 飞书 OAuth + LDAP 登录 (可并行)
5. 系统配置管理 (独立，可并行)

---

## 4. API 接口清单

### 审计日志
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/audit/logs` | 审计日志列表 |
| GET | `/api/v1/audit/logs/{id}` | 日志详情 |
| GET | `/api/v1/audit/logs/export` | 导出日志 |

### 文件
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/files/upload` | 上传文件 |
| GET | `/api/v1/files/{id}/download` | 下载文件 |
| GET | `/api/v1/files/{id}/preview` | 预览文件 |

### 会话 (扩展)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions` | 会话列表 (支持搜索/筛选) |
| PUT | `/api/v1/sessions/{id}/pin` | 置顶/取消置顶 |
| PUT | `/api/v1/sessions/{id}/favorite` | 收藏/取消收藏 |

### 统计
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/statistics/overview` | 数据概览 |
| GET | `/api/v1/statistics/agents` | Agent 使用统计 |
| GET | `/api/v1/statistics/models` | 模型调用统计 |
| GET | `/api/v1/statistics/users` | 用户活跃统计 |

### 认证 (扩展)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth/feishu/qrcode` | 获取飞书扫码 URL |
| GET | `/api/v1/auth/feishu/callback` | 飞书回调 |

### 系统配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/system/config` | 获取配置 |
| PUT | `/api/v1/system/config` | 更新配置 |

---

## 5. 不在本期范围

以下功能明确推迟到后续阶段:
- Agent Hub 增强（评分、推荐、分类）
- 数据分析与报表（高级）
- 开放 API / SDK
- 桌面客户端自动更新
- 上下文压缩
