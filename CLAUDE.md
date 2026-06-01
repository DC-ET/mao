# Agent Workbench
> 当前项目处于初版开发阶段，重构代码时无需考虑存量数据与向后兼容。

企业级 AI Agent 管理与协作平台。三端架构：Java 后端 + Vue 管理后台 + Electron 桌面客户端。

## 项目结构

- `backend/` — Spring Boot 3.5 + MyBatis-Plus + MySQL 8 + Redis，端口 9080
- `admin/` — Vue 3 + Element Plus 管理后台，端口 5200
- `desktop/` — Electron 28 + Vue 3 桌面客户端，端口 5201
- `docs/` — 需求、技术设计、开发阶段文档

## 常用命令

```bash
# 后端
cd backend && mvn clean install && mvn spring-boot:run

# 管理后台
cd admin && npm install && npm run dev

# 桌面端 (浏览器预览)
cd desktop && npm install && npm run dev

# 桌面端 (Electron)
cd desktop && npm run dev:electron
```

## 本地日志文件路径
> 可用于排查bug
```
# 桌面端日志文件路径
/data/logs/agent-workbench-mimo/desktop.out

# 后端日志文件路径
/data/logs/agent-workbench-mimo/backend.out
```

## 后端模块 (backend/src/main/java/com/agentworkbench/)

| 模块 | 说明 |
|------|------|
| `harness/` | Agent 运行引擎核心：AgentLoop、PromptEngine、ContextManager、LLM 适配器、MCP 客户端、技能系统 |
| `agent/` | Agent 管理 CRUD |
| `session/` | 会话与消息管理 |
| `auth/` | 认证（JWT / LDAP / 飞书） |
| `permission/` | RBAC 权限体系 |
| `hub/` | Agent Hub 市场 |
| `model/` | 模型管理 |
| `skill/` | 技能管理 |
| `audit/` | 审计日志 |
| `user/` | 用户管理 |

## 前端路由

- 管理后台 (`admin/`) 和桌面端 (`desktop/`) 共享 UI 组件库和 API 调用模式
- 均使用 Vue 3 + TypeScript + Pinia + Element Plus + vue-router

## 技能系统

7 个内置技能：BashSkill、ReadFileSkill、WriteFileSkill、EditFileSkill、HttpRequestSkill、TodoSkill、SubagentSkill。位于 `backend/src/.../harness/skill/`。

## 数据库

MySQL 8，迁移脚本在 `backend/src/main/resources/db/migration/`。共 24 张表。

## 注意事项

- 后端 Java 17，使用 Lombok
- 前端 TypeScript 严格模式，vue-tsc 类型检查
- API 路径前缀 `/api/v1/`
- SSE 流式对话使用 OkHttp
- 默认管理员账号 admin / admin123
