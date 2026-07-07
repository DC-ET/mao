# 会话管理功能设计文档

## 1. 背景与目标

管理后台目前缺少会话管理功能，管理员无法查看所有用户的 Agent 会话和聊天记录。

**核心目标**：
1. 会话分页列表 — 展示所有任务会话的基本信息，支持多维筛选
2. 会话详情 — 以聊天记录形式展示完整上下文，内容与桌面客户端一致

**设计原则**：
- 管理后台仅限管理员使用，不考虑普通用户视角
- 聊天记录为只读展示，不提供交互操作能力
- 后端分页，前端筛选

---

## 2. 后端设计

### 2.1 新增接口

#### 管理员会话分页接口

```
GET /api/v1/admin/sessions
```

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | int | 否 | 页码，默认 1 |
| size | int | 否 | 每页条数，默认 20 |
| userId | Long | 否 | 按用户筛选 |
| agentId | Long | 否 | 按 Agent 筛选 |
| executionMode | String | 否 | CLOUD / LOCAL |
| phase | String | 否 | IDLE/RUNNING/COMPLETED/FAILED/CANCELLED |
| keyword | String | 否 | 标题/摘要模糊搜索 |
| status | String | 否 | ACTIVE / ARCHIVED，默认 ACTIVE |

**响应**：
```json
{
  "code": 0,
  "data": {
    "records": [SessionVO...],
    "total": 100,
    "page": 1,
    "size": 20
  }
}
```

#### 会话消息接口（管理员）

```
GET /api/v1/admin/sessions/{id}/messages
```

复用现有 `SessionService.getMessages()` 和 `getFileChangesBySession()`，返回 `MessageVO` 列表。

#### 下拉选项接口

```
GET /api/v1/admin/sessions/options/users   → [{id, username, displayName}]
GET /api/v1/admin/sessions/options/agents  → [{id, name}]
```

### 2.2 数据库迁移

新增 `session:read` 权限，关联到 ADMIN 角色：

```sql
INSERT INTO permission (code, description) VALUES ('session:read', '查看会话');
INSERT INTO role_permission (role_id, permission_id) VALUES (1, LAST_INSERT_ID());
```

### 2.3 SessionService 新增方法

```java
public Page<Session> listSessionsForAdmin(int page, int size, Long userId,
        Long agentId, String executionMode, String phase, String keyword, String status)
```

使用 `LambdaQueryWrapper` 构建多条件查询。

---

## 3. 前端设计

### 3.1 页面结构

```
/sessions          → SessionListView（会话列表 + 筛选）
/sessions/:id      → SessionDetailView（会话详情 + 聊天记录）
```

### 3.2 会话列表页

**筛选条件**：用户、Agent、执行模式、任务阶段、关键词

**列表字段**：ID、标题、用户、Agent、执行模式、任务阶段、摘要、上下文Token、创建时间、最后活动

**交互**：行点击跳转详情页

### 3.3 会话详情页

**布局**：
- 顶部：返回按钮 + 会话基本信息（el-descriptions）
- 主体：聊天记录区域，按时间线渲染消息

**渲染内容**：

| 内容类型 | 组件 | 说明 |
|----------|------|------|
| 用户消息 | MessageItem | 纯文本 + 图片 |
| 助手消息 | MessageItem | Markdown 文本 |
| 思考过程 | ThinkingBlock | 折叠面板，等宽字体 |
| 工具调用 | ToolCallGroup → ToolCallCard | 折叠组，展示输入输出 |
| 文件变更 | FileChangePanel | 折叠面板，路径 + 行数统计 |
| 多模态图片 | el-image | 缩略图 + 预览 |

**TOOL 消息合并**：复用桌面端 `mapApiMessagesToChat` 逻辑，将独立 TOOL 消息合并到对应 ASSISTANT 消息的 toolCalls 中。

**Markdown 渲染**：使用 `marked` + `highlight.js`，与桌面端一致。

---

## 4. 文件清单

### 后端

| 操作 | 文件 |
|------|------|
| 新增 | `backend/src/main/resources/db/migration/V038__add_session_permission.sql` |
| 新增 | `backend/src/main/java/cn/etarch/mao/session/controller/AdminSessionController.java` |
| 修改 | `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java` |

### 前端

| 操作 | 文件 |
|------|------|
| 修改 | `admin/src/router/index.ts` |
| 修改 | `admin/src/components/Layout.vue` |
| 新增 | `admin/src/views/session/SessionListView.vue` |
| 新增 | `admin/src/views/session/SessionDetailView.vue` |
| 新增 | `admin/src/views/session/types/chat.ts` |
| 新增 | `admin/src/views/session/utils/chatMessage.ts` |
| 新增 | `admin/src/views/session/composables/useMarkdown.ts` |
| 新增 | `admin/src/views/session/components/MessageItem.vue` |
| 新增 | `admin/src/views/session/components/ThinkingBlock.vue` |
| 新增 | `admin/src/views/session/components/ToolCallGroup.vue` |
| 新增 | `admin/src/views/session/components/ToolCallCard.vue` |
| 新增 | `admin/src/views/session/components/FileChangePanel.vue` |

---

## 5. 验证标准

1. 后端编译通过：`cd backend && mvn compile`
2. 前端构建通过：`cd admin && npm run build`
3. 管理后台侧边栏显示"会话管理"菜单
4. 列表页筛选和分页正常工作
5. 详情页聊天记录完整展示，包括文本、思考过程、工具调用、文件变更、图片
