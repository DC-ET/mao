# Phase 4 - 平台化

> 目标: 让系统从"企业可用"变成"企业平台" — Hub 增强、数据分析、开放 API、自动更新、上下文压缩
> 预计周期: 3-4 周
> 前置依赖: Phase 1-3 完成

---

## 1. 本期目标

将系统打造为企业内部的 AI Agent 平台，提供数据分析能力、开放接口、自动更新等平台级特性。

**验收标准:**
- Agent Hub 支持评分、推荐、分类，形成企业内部的 Agent 生态
- 管理后台提供多维度数据分析报表
- 提供开放 API 和 SDK 供第三方系统集成
- 桌面客户端支持自动更新
- 长对话场景下上下文自动压缩，避免 Token 超限

---

## 2. 功能清单

### 2.1 Agent Hub 增强 (桌面端 + 后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Agent 评分 | 用户可对已安装的 Agent 评分（1-5 星） | P0 |
| Agent 评论 | 用户可对 Agent 发表评论 | P1 |
| 推荐算法 | 基于使用量、评分、部门推荐 Agent | P1 |
| 分类体系 | Agent 按功能领域分类（开发、运维、设计等） | P0 |
| 排行榜 | 热门 Agent、新上架 Agent、高评分 Agent | P1 |
| 版本管理 | Agent 支持版本发布，用户可更新到新版 | P2 |
| 使用指南 | Agent 详情页展示使用说明和示例 | P1 |

**依赖:** Phase 2 Agent Hub 基础功能

**后端实现:**
- `HubService` 扩展 — 评分、评论、推荐、分类逻辑
- 新增 `agent_rating`, `agent_comment` 表
- `agent` 表扩展分类字段

**前端实现:**
- Desktop HubView — 评分、评论、分类筛选 UI
- Desktop Agent 详情页

---

### 2.2 数据分析与报表 (Admin 后台)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 使用趋势分析 | 按日/周/月的 Agent 使用趋势图表 | P0 |
| Token 消耗分析 | 各模型/Agent 的 Token 消耗排行 | P0 |
| 用户活跃分析 | 活跃用户排行、使用时段分布 | P1 |
| Agent 效能分析 | 平均对话轮次、工具调用频率、成功率 | P1 |
| 成本估算 | 基于 Token 消耗估算模型调用成本 | P2 |
| 报表导出 | 支持导出 PDF/Excel 报表 | P2 |
| 自定义看板 | 管理员可自定义 Dashboard 展示指标 | P2 |

**依赖:** Phase 3 使用统计基础

**后端实现:**
- `AnalyticsService` — 高级统计查询
- `AnalyticsController` — 分析接口
- 基于 `message`, `api_call_log`, `audit_log` 表聚合

**前端实现:**
- Admin 数据分析页面 — ECharts 图表
- Admin Dashboard 自定义看板

---

### 2.3 开放 API / SDK (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| API Key 管理 | 为第三方系统生成 API Key | P0 |
| API 限流 | 基于 API Key 的速率限制 | P0 |
| API 文档 | 完整的 OpenAPI/Swagger 文档 | P0 |
| Python SDK | 提供 Python SDK 供脚本调用 | P1 |
| JavaScript SDK | 提供 JS/TS SDK | P1 |
| Webhook 回调 | Agent 任务完成时回调通知 | P2 |

**依赖:** Phase 1 API 基础

**后端实现:**
- `ApiKeyService` — API Key 生成、校验、吊销
- `ApiKeyController` — API Key 管理接口
- `RateLimitInterceptor` — 基于 API Key 的限流
- 新增 `api_key` 表
- SDK 仓库（独立项目）

**前端实现:**
- Admin API Key 管理页面

---

### 2.4 桌面客户端自动更新 (桌面端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 版本检查 | 启动时检查是否有新版本 | P0 |
| 自动下载 | 后台下载更新包 | P0 |
| 更新提示 | 用户可选择立即更新或稍后更新 | P0 |
| 增量更新 | 仅下载变更部分，减少更新时间 | P2 |
| 更新日志 | 展示版本更新内容 | P1 |
| 强制更新 | 关键安全更新可强制推送 | P2 |

**依赖:** 无

**实现:**
- Electron `autoUpdater` 模块
- 更新服务器搭建（或使用 GitHub Releases）
- 版本号管理策略

---

### 2.5 上下文压缩 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 滑动窗口 | 保留最近 N 轮对话，超出部分丢弃 | P0 |
| 摘要压缩 | 将早期对话压缩为摘要 | P0 |
| 自动触发 | Token 数超过阈值时自动压缩 | P0 |
| 压缩策略配置 | 可配置窗口大小、压缩阈值 | P1 |
| 压缩质量监控 | 监控压缩后的对话质量 | P2 |

**依赖:** Phase 1 AgentLoop

**后端实现:**
- `ContextManager` — 上下文压缩逻辑
- 集成到 `AgentLoop` 和 `PromptEngine`
- 压缩策略: 滑动窗口 + LLM 摘要

---

### 2.6 通知系统 (后端)

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 站内通知 | 系统通知展示在客户端 | P0 |
| 飞书机器人通知 | 通过飞书 Webhook 发送通知 | P1 |
| 任务完成通知 | Agent 任务完成时通知用户 | P0 |
| 通知偏好设置 | 用户可配置通知方式 | P1 |

**依赖:** 飞书 OAuth (Phase 3)

**后端实现:**
- `NotificationService` — 通知发送逻辑
- `NotificationController` — 通知接口
- 新增 `notification` 表

**前端实现:**
- Desktop 通知铃铛组件
- 通知列表弹窗

---

## 3. 依赖关系图

```
Agent Hub 基础 (Phase 2) ──┐
                          ▼
                    Agent Hub 增强

使用统计 (Phase 3) ────────┐
                          ▼
                    数据分析与报表

开放 API / SDK (独立)
桌面客户端自动更新 (独立)
上下文压缩 (独立)
通知系统 (独立)
```

**开发顺序:**
1. Agent Hub 增强 (依赖 Phase 2)
2. 数据分析与报表 (依赖 Phase 3)
3. 开放 API / SDK (独立)
4. 桌面客户端自动更新 (独立)
5. 上下文压缩 (独立)
6. 通知系统 (独立)

---

## 4. API 接口清单

### Hub 增强
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/hub/agents/{id}/rate` | 评分 |
| GET | `/api/v1/hub/agents/{id}/comments` | 评论列表 |
| POST | `/api/v1/hub/agents/{id}/comments` | 发表评论 |
| GET | `/api/v1/hub/agents/recommended` | 推荐列表 |
| GET | `/api/v1/hub/agents/ranking` | 排行榜 |

### 数据分析
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/analytics/trends` | 使用趋势 |
| GET | `/api/v1/analytics/tokens` | Token 消耗分析 |
| GET | `/api/v1/analytics/users` | 用户活跃分析 |
| GET | `/api/v1/analytics/agents/{id}` | Agent 效能分析 |
| GET | `/api/v1/analytics/export` | 导出报表 |

### API Key
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/api-keys` | API Key 列表 |
| POST | `/api/v1/api-keys` | 生成 API Key |
| DELETE | `/api/v1/api-keys/{id}` | 吊销 API Key |

### 通知
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/notifications` | 通知列表 |
| PUT | `/api/v1/notifications/{id}/read` | 标记已读 |
| PUT | `/api/v1/notifications/preferences` | 通知偏好 |

---

## 5. 不在本期范围

以下功能如需实现，可作为后续迭代:
- 多租户支持
- Agent 编排（多 Agent 协作）
- 自定义工作流
- 移动端适配
- 国际化 (i18n)
