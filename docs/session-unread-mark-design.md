# 会话未读标记（Unread Mark）功能技术设计

## 1. 需求概述

### 1.1 问题

任务列表中存在多个已完成的任务时，用户无法快速区分哪些是**刚刚在后台完成**的，哪些是早已完成的。所有已完成任务在列表中的视觉表现完全一致（绿色圆点 + 已完成耗时），缺乏新旧区分。

### 1.2 方案

当任务在后台完成时，如果用户**未点击查看过该任务**，在任务标题右侧显示一个**青色小圆点**作为未读标记。用户点击该任务后，小圆点立即消失。

### 1.3 规则总结

| 规则 | 说明 |
|------|------|
| 触发时机 | 任务从非终态（RUNNING/WAITING_*/RESUMING）变为终态（COMPLETED/FAILED/CANCELLED） |
| 未读条件 | 变为终态后，用户未点击过该任务 |
| 消除时机 | 用户在任务列表中点击该任务（`selectSession`） |
| 持久化 | 后端数据库存储，跨会话保留 |
| 存量数据 | 功能上线时，已有的终态任务默认已读 |
| 批量场景 | 每个未读任务独立显示小圆点 |

---

## 2. 现状分析

### 2.1 session 表现状

当前 `session` 表没有任何未读/已读相关字段。最接近的概念是 `notification` 表的 `is_read` 字段，但与会话无关。

相关列：`phase`（VARCHAR(32)）、`last_activity_at`（DATETIME）。

### 2.2 相关代码

| 层级 | 文件 | 关键位置 |
|------|------|----------|
| 数据库迁移 | `db/migration/V028__*.sql` | 新增迁移文件 |
| Session 实体 | `session/entity/Session.java` | 新增字段 |
| SessionService | `session/service/SessionService.java:399` | `updatePhase()` 方法，终态判定逻辑 |
| SessionController | `session/controller/SessionController.java` | 新增已读接口；`SessionVO` 新增字段 |
| Session Store | `desktop/src/stores/session.ts:15` | `Session` 类型新增 `unread` 字段 |
| 任务列表 | `desktop/src/components/task/TaskIndexPanel.vue:71` | 标题右侧渲染未读圆点 |
| 任务列表点击 | `desktop/src/components/task/TaskIndexPanel.vue:300` | `selectSession()` 调用已读接口 |
| WS 事件 | `desktop/src/composables/useStreamWS.ts:264` | `session_status` 事件携带 unread 状态 |

---

## 3. 数据库设计

### 3.1 新增字段

在 `session` 表新增 `unread` 字段：

```sql
-- V028__add_session_unread.sql
ALTER TABLE `session` ADD COLUMN `unread` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '后台完成未读标记：0=已读，1=未读';
```

- 类型：`TINYINT(1)`，与现有 `is_pinned`、`is_favorite` 保持一致
- 默认值：`0`（已读），存量数据自动兼容
- 命名：`unread`，简洁且语义明确（不使用 `is_unread`，因为 MyBatis-Plus 对 `is_` 前缀布尔字段的映射有特殊处理，容易产生歧义）

### 3.2 Session 实体新增字段

```java
// Session.java
private Integer unread;
```

无需额外注解，MyBatis-Plus 自动映射 `unread` → `unread`。

---

## 4. 后端设计

### 4.1 未读标记写入

**修改 `SessionService.updatePhase()` 方法**（`SessionService.java:399`）：

在现有终态判定逻辑中，增加未读标记写入：

```java
public void updatePhase(Long sessionId, String phase) {
    Session session = getSession(sessionId);
    String oldPhase = session.getPhase();
    session.setPhase(phase);
    session.setLastActivityAt(LocalDateTime.now());

    if ("RUNNING".equals(phase)) {
        if (session.getStartedAt() == null) {
            session.setStartedAt(LocalDateTime.now());
        }
    } else if ("IDLE".equals(phase) || "COMPLETED".equals(phase)
            || "FAILED".equals(phase) || "CANCELLED".equals(phase)) {
        // 累计执行时间（现有逻辑）
        if (session.getStartedAt() != null) {
            long elapsed = Duration.between(session.getStartedAt(), LocalDateTime.now()).toMillis();
            session.setElapsedMs((session.getElapsedMs() != null ? session.getElapsedMs() : 0) + elapsed);
            session.setStartedAt(null);
        }

        // 新增：从非终态变为终态时，标记未读
        if (!isTerminalPhase(oldPhase) && isTerminalPhase(phase)) {
            session.setUnread(1);
        }
    }
    sessionMapper.updateById(session);
}

private boolean isTerminalPhase(String phase) {
    return "IDLE".equals(phase) || "COMPLETED".equals(phase)
        || "FAILED".equals(phase) || "CANCELLED".equals(phase);
}
```

**关键判定逻辑**：只有从非终态（RUNNING/RESUMING/WAITING_USER/WAITING_APPROVAL）变为终态（COMPLETED/FAILED/CANCELLED）时才设置 `unread=1`。从 IDLE 变为其他状态不触发（IDLE 是初始状态，不代表任务执行过）。

### 4.2 未读标记清除

**新增 `SessionService.markAsRead()` 方法**：

```java
public void markAsRead(Long sessionId) {
    Session session = getSession(sessionId);
    if (Integer.valueOf(1).equals(session.getUnread())) {
        session.setUnread(0);
        sessionMapper.updateById(session);
    }
}
```

### 4.3 API 设计

#### 4.3.1 已读接口

**新增端点**：`PUT /v1/sessions/{id}/read`

```java
// SessionController.java
@PutMapping("/{id}/read")
public Result<Void> markAsRead(@PathVariable Long id,
                                @RequestAttribute Long userId) {
    Session session = sessionService.getSession(id);
    if (!session.getUserId().equals(userId)) {
        return Result.error(403, "无权操作");
    }
    sessionService.markAsRead(id);
    return Result.ok();
}
```

#### 4.3.2 SessionVO 新增字段

`SessionVO` 是 `SessionController` 的内部类（`SessionController.java:381`），负责将实体转换为前端响应。

新增 `unread` 字段：

```java
// SessionVO 内部类
private Boolean unread;

// 构造方法中
this.unread = Integer.valueOf(1).equals(session.getUnread());
```

使用 `Boolean` 而非 `Integer`，前端直接可用作布尔判断。

#### 4.3.3 列表接口响应

`GET /v1/sessions` 和 `GET /v1/sessions/{id}` 的响应中自动包含 `unread` 字段，无需额外修改。

---

## 5. 前端设计

### 5.1 Session 类型扩展

```typescript
// desktop/src/stores/session.ts
export interface Session {
  // ... 现有字段
  unread?: boolean
}
```

### 5.2 Session Store 新增方法

```typescript
// desktop/src/stores/session.ts

// 标记已读（本地状态 + 远端同步）
async function markAsRead(sessionId: string) {
  const session = sessions.value.find(s => s.id === sessionId)
  if (!session?.unread) return

  session.unread = false
  try {
    await api.put(`/sessions/${sessionId}/read`)
  } catch {
    // 静默失败，下次 fetchSessions 会同步
  }
}
```

乐观更新：先改本地状态（UI 立即响应），再发请求。失败时不影响用户体验，下次列表刷新会同步。

### 5.3 fetchSessions 合并逻辑

现有 `fetchSessions()` 合并远端数据时，需要保留 `unread` 字段：

```typescript
// session.ts fetchSessions() 合并逻辑中
unread: remote.unread ?? local.unread
```

确保在已读请求尚未完成时，本地乐观更新不被列表刷新覆盖。

### 5.4 任务列表未读圆点渲染

**修改文件**：`desktop/src/components/task/TaskIndexPanel.vue`

**位置**：在 `.session-item-meta` 区域（line 73-76），耗时文本 `session-elapsed` 之前插入未读圆点：

```html
<div class="session-item-meta">
  <span v-if="session.running" class="session-spinner"></span>
  <!-- 新增：未读圆点 -->
  <span v-if="session.unread" class="session-unread-dot"></span>
  <span class="session-elapsed">{{ formatElapsed(session) }}</span>
</div>
```

**样式**：

```css
.session-unread-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #00d4aa; /* 青色，与 Element Plus 的 --el-color-primary 接近 */
  margin-right: 6px;
  flex-shrink: 0;
}
```

- 尺寸 8px，与现有 phase-dot 视觉权重一致
- 颜色选择青色（#00d4aa），与已完成状态的绿色（#67c23a）、运行中的蓝色有明确区分
- 使用 `flex-shrink: 0` 防止在 flex 布局中被压缩

### 5.5 点击已读逻辑

**修改 `selectSession()` 函数**（`TaskIndexPanel.vue:300`）：

```typescript
function selectSession(session: Session) {
  if (editingSessionId.value === session.id) return
  confirmingDeleteId.value = null
  editingSessionId.value = null

  // 新增：标记已读
  if (session.unread) {
    sessionStore.markAsRead(session.id)
  }

  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
}
```

在 `setActiveSession` 之前调用 `markAsRead`，确保 UI 即时响应（圆点在点击瞬间消失）。

### 5.6 WebSocket 实时同步

当后台任务完成时，后端通过 `session_status` 事件推送 phase 变更。需要在事件中携带 `unread` 状态。

**后端**：`WsStreamingEventListener` 发送 `session_status` 事件时，从数据库读取最新 session 并包含 `unread` 字段。

**前端**：`useStreamWS.ts` 的 `session_status` 处理逻辑中，同步更新 `unread`：

```typescript
case 'session_status':
  if (sessionId) {
    sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
    // 新增：同步未读状态
    if (data.unread !== undefined) {
      sessionStore.updateSession(sessionId, { unread: data.unread })
    }
    // ... 现有终态处理逻辑
  }
  break
```

---

## 6. 数据流全景

```
后台任务执行完成
       │
       ▼
AgentLoop 终态判定
       │
       ▼
SessionService.updatePhase(sessionId, "COMPLETED")
  ├─ 旧 phase = RUNNING，新 phase = COMPLETED
  ├─ isTerminalPhase(RUNNING) = false, isTerminalPhase(COMPLETED) = true
  ├─ → 设置 unread = 1
  └─ sessionMapper.updateById(session)
       │
       ▼
WsStreamingEventListener 发送 session_status 事件
  └─ data = { phase: "COMPLETED", unread: true }
       │
       ├──────────────────────────────────┐
       ▼                                  ▼
用户在线（WebSocket 连接）            用户离线/不在该页面
       │                                  │
useStreamWS.routeEvent()              下次打开客户端
  ├─ updateSessionPhase()                  │
  ├─ updateSession({ unread: true })       ▼
  └─ TaskIndexPanel 响应式渲染       fetchSessions()
       │                            ├─ GET /sessions 返回 unread: true
       ▼                            └─ TaskIndexPanel 响应式渲染
  显示青色圆点                          │
       │                            ▼
       │                        显示青色圆点
       ▼
用户点击该任务
  ├─ selectSession() 调用 sessionStore.markAsRead()
  ├─ 本地 session.unread = false（圆点立即消失）
  └─ PUT /sessions/{id}/read（持久化到 DB）
```

---

## 7. 边界场景处理

| 场景 | 处理方式 |
|------|----------|
| 任务 FAILED/CANCELLED | 同样标记未读，用户需要知道任务失败了 |
| 用户正在查看的任务完成 | 不标记未读（`updatePhase` 时无法判断当前查看的是哪个任务，由前端在 `session_status` 事件处理中，如果该 session 是 activeSession，则立即调用 `markAsRead`） |
| 任务重新执行（RUNNING → COMPLETED） | 再次标记未读，符合"每次完成都提示"的预期 |
| 功能上线时存量数据 | `unread` 默认 0，所有存量任务已读 |
| 多标签页/多窗口 | 通过 WebSocket 事件同步；已读操作通过 REST API 写 DB，其他标签页下次 fetchSessions 时同步 |
| session 被删除 | 无需处理，记录不存在则未读状态也不存在 |

### 7.1 当前查看任务的特殊处理

当用户正在查看某个任务时，该任务在后台完成，不应显示未读标记。处理方式：

**前端**：在 `useStreamWS.ts` 的 `session_status` 事件处理中：

```typescript
case 'session_status':
  if (sessionId) {
    sessionStore.updateSessionPhase(sessionId, data.phase as TaskPhase)
    if (data.unread !== undefined) {
      // 如果是当前正在查看的 session，直接标记已读
      if (sessionId === sessionStore.activeSessionId) {
        sessionStore.markAsRead(sessionId)
      } else {
        sessionStore.updateSession(sessionId, { unread: data.unread })
      }
    }
    // ... 现有逻辑
  }
  break
```

这样用户正在查看的任务完成时，圆点不会出现；而其他后台任务完成时，圆点正常显示。

---

## 8. 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `backend/.../db/migration/V028__add_session_unread.sql` | 新增 | 数据库迁移脚本 |
| `backend/.../session/entity/Session.java` | 修改 | 新增 `unread` 字段 |
| `backend/.../session/service/SessionService.java` | 修改 | `updatePhase()` 增加未读标记；新增 `markAsRead()` |
| `backend/.../session/controller/SessionController.java` | 修改 | 新增 `PUT /{id}/read` 端点；`SessionVO` 新增 `unread` |
| `desktop/src/stores/session.ts` | 修改 | `Session` 类型新增 `unread`；新增 `markAsRead()` |
| `desktop/src/components/task/TaskIndexPanel.vue` | 修改 | 模板新增圆点；`selectSession()` 调用已读 |
| `desktop/src/composables/useStreamWS.ts` | 修改 | `session_status` 事件同步 `unread` 状态 |

共 7 个文件，其中 1 个新增，6 个修改。
