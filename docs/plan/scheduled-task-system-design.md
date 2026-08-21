# 定时任务调度系统技术方案

> 文档版本：v1.0  
> 文档状态：待实施  
> 编写日期：2026-07-27  
> 适用项目：Mao Agent Workbench

## 1. 需求背景

当前 Agent 执行完全依赖用户通过 WebSocket 主动发送消息触发——系统没有任何自动或定时触发 Agent 执行的机制。当用户提出类似"每天早上帮我检查新股申购"、"每天下午5点给我生成日报"等需求时，Agent 无法实现。

核心限制：
- Agent 只能被动响应，不能主动发起执行
- 没有后台定时任务能力
- 没有消息注入机制

本方案构建一个通用的**定时任务调度系统**，让用户可以通过自然语言对话创建定时任务，系统按 cron 计划自动向固定 Session 注入消息触发 Agent 执行，复用现有 AgentLoop 引擎，执行结果通过现有 Webhook 通知系统推送。

## 2. 需求描述

### 2.1 功能范围

| 模块 | 功能点 | 结论 |
|------|--------|------|
| 任务创建 | 用户通过自然语言对话让 Agent 创建定时任务（Agent 内置工具） | 做 |
| 任务创建 | 通过 UI 表单手动创建定时任务 | 不做，仅对话式 |
| 任务管理 | 管理后台（admin/）定时任务管理页面：列表、启用/禁用、删除 | 做 |
| 任务管理 | 桌面端（desktop/）定时任务侧栏面板：列表、启用/禁用、删除 | 做 |
| 任务管理 | 对话中查看和管理任务（Agent 内置工具：列出、更新、删除） | 做 |
| 触发方式 | Cron 表达式定时触发 | 做 |
| 触发方式 | 固定间隔触发（如每30分钟） | 做 |
| 触发方式 | 外部 Webhook 回调触发 | 不做 |
| 触发方式 | 事件驱动触发（如文件变更、外部系统回调） | 不做 |
| 执行机制 | 向固定 Session 注入用户消息，复用现有 AgentLoop 执行 | 做 |
| 执行机制 | 独立后台执行（不依赖 Session） | 不做 |
| Session 策略 | 每个任务绑定固定 Session，历史上下文可累积 | 做 |
| Session 策略 | 每次触发新建 Session | 不做 |
| Agent 绑定 | 绑定创建任务时的当前 Agent | 做 |
| Agent 绑定 | 用户手动指定 Agent | 不做 |
| 并发控制 | 上次执行未完成时跳过本次触发 | 做 |
| 并发控制 | 取消上次执行，启动新的 | 不做 |
| 并发控制 | 排队等待上次完成 | 不做 |
| 执行超时 | 不限制执行时间，由用户取消、任务正常完成或真实错误终止 | 做 |
| 结果通知 | 复用现有 Webhook 通知系统（钉钉/飞书）+ Session 未读标记 | 做 |
| 结果通知 | 邮件通知 | 不做 |
| 结果通知 | 微信通知 | 不做 |
| Prompt 定义 | Agent 智能解析自然语言，转化为结构化 prompt 和 cron 表达式 | 做 |
| Prompt 定义 | 用户直接输入 cron 表达式和 prompt 文本 | 做（Agent 工具也接受结构化输入作为后备） |
| 权限 | 用户只能管理自己创建的任务 | 做 |
| 权限 | 管理员可管理所有用户的任务 | 做 |

### 2.2 业务规则

1. 定时任务绑定到创建时的 Session 对应的 Agent，执行时复用该 Agent 的 system_prompt、技能、模型配置。
2. 每个任务拥有一个专属 Session，所有执行历史在同一 Session 中累积。
3. 任务触发时，系统检查目标 Session 是否正在执行（phase 为 RUNNING/RESUMING/WAITING_APPROVAL），若是则跳过本次触发，记录跳过日志。
4. 任务触发时，系统向目标 Session 持久化一条 USER 角色消息（内容为任务的 prompt），然后调用 `HarnessService.executeFromEvent()` 启动 Agent 执行。
5. 任务进入 COMPLETED 或 FAILED 终态后，复用现有 Webhook 通知判定逻辑：先尝试 WS 推送，无在线客户端时通过 Webhook 发送。
6. 用户只能管理自己创建的定时任务；管理员可在管理后台查看和管理所有用户的任务。
7. 禁用任务后不再触发，启用后恢复。删除任务为逻辑删除。
8. cron 表达式解析失败时，任务不触发并在日志中记录错误。

### 2.3 用户流程

```
【创建任务】
用户在对话中：  "每天早上9点帮我检查新股申购，有新股就提醒我"
  → Agent 调用 tool_create_scheduled_task({ prompt: "检查今日是否有新股申购...", cron: "0 0 9 * * ?" })
  → 后端创建定时任务 + 专属 Session
  → Agent 回复："已创建定时任务'新股申购检查'，每天早上9点执行"

【任务执行】
Spring Scheduler 扫描到期任务
  → 检查目标 Session 是否空闲
  → 空闲：持久化 USER 消息 → 调用 HarnessService.executeFromEvent()
  → 忙碌：跳过本次，记录日志
  → Agent 执行完毕 → 通知推送（WS 或 Webhook）

【管理任务】
用户在桌面端侧栏：查看任务列表、启用/禁用、删除
用户在管理后台：管理员查看所有任务、管理
用户在对话中："列出我的定时任务" / "取消新股提醒任务"
```

## 3. 当前代码分析

### 3.1 可复用能力

| 能力 | 当前实现 | 复用方式 |
|------|----------|----------|
| Agent 执行引擎 | `HarnessService.executeFromEvent()` → `AgentLoop.execute()` | 直接复用，注入 USER 消息后调用 |
| 定时调度基础设施 | `@EnableScheduling` 已启用，已有 5 个 `@Scheduled` 任务 | 新增 `ScheduledTaskScheduler` 扫描到期任务 |
| Webhook 通知系统 | `TaskCompletionNotificationService` + Outbox 模式 | 任务终态复用相同通知逻辑 |
| Session 管理 | `SessionService` 完整的 CRUD + 状态管理 | 为每个定时任务创建专属 Session |
| Message 持久化 | `SessionService.saveMessage()` | 直接调用持久化 USER 消息 |
| WebSocket 事件推送 | `StreamingWsRegistry` 多设备推送 | 任务执行过程的实时事件自动推送 |
| 内置工具注册 | `@Component` 实现 `Tool` 接口自动注册 | 新增 4 个内置工具 |
| 管理后台路由 | `admin/src/router/index.ts` Vue Router | 新增定时任务管理路由 |
| 桌面端侧栏 | 左侧面板组件体系 | 新增定时任务面板 |

### 3.2 关键代码路径

| 组件 | 文件路径 |
|------|----------|
| Agent 执行入口 | `backend/.../harness/core/HarnessService.java` |
| Agent 循环 | `backend/.../harness/core/AgentLoop.java` |
| WS 消息处理 | `backend/.../session/ws/StreamingWsHandler.java` |
| WS 连接注册 | `backend/.../session/ws/StreamingWsRegistry.java` |
| 工具接口 | `backend/.../harness/tool/Tool.java` |
| 工具实现目录 | `backend/.../harness/tool/impl/` |
| 现有 Scheduler 示例 | `backend/.../session/service/StaleSessionSweepScheduler.java` |
| Webhook 通知 | `backend/.../notification/task/` |
| Flyway 迁移 | `backend/src/main/resources/db/migration/` (当前最新 V060) |
| 管理后台路由 | `admin/src/router/index.ts` |
| 管理后台视图 | `admin/src/views/` |
| 桌面端 composables | `desktop/src/composables/` |
| 桌面端组件 | `desktop/src/components/` |

## 4. 整体设计

### 4.1 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        用户层                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 桌面端侧栏    │  │ 管理后台页面   │  │ 对话式交互        │   │
│  │ (定时任务面板) │  │ (任务管理)    │  │ (Agent 内置工具)  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│         ▼                 ▼                    ▼             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              REST API / WebSocket                     │   │
│  └──────────────────────────┬───────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                        后端核心                              │
│                              │                               │
│  ┌───────────────────────────▼───────────────────────────┐  │
│  │           ScheduledTaskScheduler (每分钟扫描)           │  │
│  │     ┌─────────────────────────────────────────┐       │  │
│  │     │ 1. 查询 enabled=true 且 next_fire_time  │       │  │
│  │     │    <= now 的任务                         │       │  │
│  │     │ 2. 检查目标 Session 是否空闲             │       │  │
│  │     │ 3. 空闲 → 持久化 USER 消息 + 触发执行    │       │  │
│  │     │ 4. 忙碌 → 跳过，计算下次触发时间          │       │  │
│  │     │ 5. 更新 next_fire_time                  │       │  │
│  │     └─────────────────────────────────────────┘       │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         HarnessService.executeFromEvent()             │   │
│  │              (现有 AgentLoop 引擎)                     │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │     TaskCompletionNotificationService (现有)          │   │
│  │     WS 推送 / Webhook (钉钉/飞书) / 未读标记           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    数据层                              │   │
│  │     scheduled_task 表 + session 表 + message 表       │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 核心数据模型

**scheduled_task 表：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT AUTO_INCREMENT PK | 主键 |
| user_id | BIGINT NOT NULL | 创建者用户 ID |
| agent_id | BIGINT NOT NULL | 绑定的 Agent ID |
| session_id | BIGINT NOT NULL | 专属 Session ID |
| name | VARCHAR(200) NOT NULL | 任务名称 |
| prompt | TEXT NOT NULL | 触发时注入的 prompt 内容 |
| cron_expression | VARCHAR(100) NOT NULL | Cron 表达式（Spring cron 格式：秒 分 时 日 月 周） |
| status | VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' | 状态：ACTIVE / PAUSED / DELETED |
| last_fire_time | DATETIME | 上次触发时间 |
| last_execution_status | VARCHAR(20) | 上次执行状态：COMPLETED / FAILED / SKIPPED |
| next_fire_time | DATETIME | 下次触发时间（预计算，用于快速查询） |
| fire_count | INT DEFAULT 0 | 累计触发次数 |
| created_at | DATETIME NOT NULL | 创建时间 |
| updated_at | DATETIME NOT NULL | 更新时间 |
| deleted | TINYINT DEFAULT 0 | 逻辑删除标记 |

### 4.3 Cron 表达式格式

使用 Spring `CronExpression`（6 位：秒 分 时 日 月 周），支持：

| 用户意图 | Cron 表达式 | 说明 |
|----------|-------------|------|
| 每天早上 9 点 | `0 0 9 * * ?` | 标准 cron |
| 每个工作日早上 9 点 | `0 0 9 * * MON-FRI` | 周一到周五 |
| 每 30 分钟 | `0 */30 * * * ?` | 固定间隔 |
| 每周一上午 10 点 | `0 0 10 * * MON` | 指定星期 |
| 每月 1 号上午 9 点 | `0 0 9 1 * ?` | 指定日期 |

## 5. 实现步骤

### 5.1 数据库迁移

**文件**：`backend/src/main/resources/db/migration/V061__scheduled_task.sql`

```sql
CREATE TABLE scheduled_task (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL,
    agent_id        BIGINT       NOT NULL,
    session_id      BIGINT       NOT NULL,
    name            VARCHAR(200) NOT NULL,
    prompt          TEXT         NOT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
    last_fire_time  DATETIME              DEFAULT NULL,
    last_execution_status VARCHAR(20)     DEFAULT NULL,
    next_fire_time  DATETIME              DEFAULT NULL,
    fire_count      INT          NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_user_id (user_id),
    INDEX idx_status_next_fire (status, next_fire_time, deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.2 后端 — 实体与 Mapper

**新增文件：**

| 文件 | 说明 |
|------|------|
| `backend/.../schedule/entity/ScheduledTask.java` | 实体类，`@TableName("scheduled_task")` |
| `backend/.../schedule/mapper/ScheduledTaskMapper.java` | MyBatis-Plus Mapper 接口 |

**ScheduledTask 关键字段映射：**

```java
@Data
@TableName("scheduled_task")
public class ScheduledTask {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long agentId;
    private Long sessionId;
    private String name;
    private String prompt;
    private String cronExpression;
    private String status;       // ACTIVE / PAUSED
    private LocalDateTime lastFireTime;
    private String lastExecutionStatus;  // COMPLETED / FAILED / SKIPPED
    private LocalDateTime nextFireTime;
    private Integer fireCount;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
```

### 5.3 后端 — Service 层

**新增文件：**

| 文件 | 说明 |
|------|------|
| `backend/.../schedule/service/ScheduledTaskService.java` | 核心业务逻辑 |

**ScheduledTaskService 职责：**

```java
@Service
@RequiredArgsConstructor
public class ScheduledTaskService {

    // 创建定时任务
    // 1. 创建专属 Session（title=任务名, agent_id=绑定Agent, session_type=NORMAL）
    // 2. 计算 next_fire_time
    // 3. 持久化 scheduled_task 记录
    public ScheduledTask createTask(Long userId, Long agentId, String name,
                                     String prompt, String cronExpression);

    // 更新任务（名称、prompt、cron、启用/禁用）
    // 若 cron 变更，重新计算 next_fire_time
    public ScheduledTask updateTask(Long taskId, Long userId, ...);

    // 删除任务（逻辑删除）
    public void deleteTask(Long taskId, Long userId);

    // 查询用户的任务列表
    public List<ScheduledTask> listByUser(Long userId);

    // 查询所有任务（管理员用）
    public Page<ScheduledTask> listAll(PageParams params);

    // 执行定时任务（由 Scheduler 调用）
    // 1. 检查 Session 是否空闲
    // 2. 空闲 → 持久化 USER 消息 → 调用 HarnessService.executeFromEvent()
    // 3. 更新 last_fire_time、fire_count、next_fire_time
    public void executeTask(ScheduledTask task);

    // 计算下次触发时间
    public LocalDateTime calculateNextFireTime(String cronExpression);
}
```

### 5.4 后端 — Scheduler

**新增文件：**

| 文件 | 说明 |
|------|------|
| `backend/.../schedule/scheduler/ScheduledTaskScheduler.java` | 定时扫描与触发 |

**核心逻辑：**

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class ScheduledTaskScheduler {

    private final ScheduledTaskService scheduledTaskService;
    private final ScheduledTaskMapper scheduledTaskMapper;

    // 每分钟扫描一次
    @Scheduled(fixedDelay = 60_000)
    public void scanAndExecute() {
        LocalDateTime now = LocalDateTime.now();

        // 查询：status=ACTIVE AND next_fire_time <= now AND deleted=0
        List<ScheduledTask> dueTasks = scheduledTaskMapper.selectList(
            new LambdaQueryWrapper<ScheduledTask>()
                .eq(ScheduledTask::getStatus, "ACTIVE")
                .le(ScheduledTask::getNextFireTime, now)
                .eq(ScheduledTask::getDeleted, 0)
        );

        for (ScheduledTask task : dueTasks) {
            try {
                scheduledTaskService.executeTask(task);
            } catch (Exception e) {
                log.error("定时任务执行失败: taskId={}", task.getId(), e);
                // 更新状态为 FAILED，计算下次触发时间
            }
        }
    }
}
```

### 5.5 后端 — Agent 内置工具

**新增 4 个工具，放置在 `backend/.../harness/tool/impl/` 目录：**

| 工具文件 | 工具名 | 说明 |
|----------|--------|------|
| `CreateScheduledTaskTool.java` | `create_scheduled_task` | 创建定时任务 |
| `ListScheduledTasksTool.java` | `list_scheduled_tasks` | 列出用户的定时任务 |
| `UpdateScheduledTaskTool.java` | `update_scheduled_task` | 更新任务（名称、prompt、cron、启用/禁用） |
| `DeleteScheduledTaskTool.java` | `delete_scheduled_task` | 删除定时任务 |

**CreateScheduledTaskTool 示例结构：**

```java
@Component
@RequiredArgsConstructor
public class CreateScheduledTaskTool implements Tool {

    private final ScheduledTaskService scheduledTaskService;

    @Override
    public String getName() { return "create_scheduled_task"; }

    @Override
    public String getDescription() {
        return "创建定时任务。任务将按照指定的 cron 计划自动执行。" +
               "例如：每天早上9点检查新股申购、每小时检查服务器状态等。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        // 参数：name(任务名), prompt(执行内容), cron_expression(Spring cron 6位)
        return Map.of(
            "type", "object",
            "properties", Map.of(
                "name", Map.of("type", "string", "description", "任务名称"),
                "prompt", Map.of("type", "string", "description", "任务触发时执行的 prompt 内容"),
                "cron_expression", Map.of("type", "string",
                    "description", "Spring cron 表达式（6位：秒 分 时 日 月 周），如 '0 0 9 * * ?' 表示每天9点")
            ),
            "required", List.of("name", "prompt", "cron_expression")
        );
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        // 1. 解析参数
        // 2. 从 sessionId 获取 agent_id
        // 3. 调用 scheduledTaskService.createTask()
        // 4. 返回任务创建结果 JSON
    }
}
```

**工具行为指南（toolPrompt）关键内容：**

```markdown
## create_scheduled_task 使用指南

当用户希望创建定时自动执行的任务时使用此工具。

### cron 表达式规则
- 格式：秒 分 时 日 月 周（Spring 6位 cron）
- "每天早上9点" → "0 0 9 * * ?"
- "每30分钟" → "0 */30 * * * ?"
- "工作日早上9点" → "0 0 9 * * MON-FRI"

### prompt 编写要求
- prompt 应该是完整的、自包含的指令
- 应包含足够的上下文，因为 Agent 执行时只有任务历史，没有用户实时对话
- 示例："检查今日是否有新股可申购。如果有，列出新股代码、名称、申购价格和上限；如果没有，简要说明即可。"
```

### 5.6 后端 — REST API

**新增文件：**

| 文件 | 说明 |
|------|------|
| `backend/.../schedule/controller/ScheduledTaskController.java` | REST 接口 |

**接口定义：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/v1/scheduled-tasks` | 查询当前用户的任务列表 | 登录用户 |
| GET | `/api/v1/scheduled-tasks/all` | 查询所有任务（分页） | 管理员 |
| PUT | `/api/v1/scheduled-tasks/{id}` | 更新任务（名称、prompt、cron、状态） | 任务创建者 |
| DELETE | `/api/v1/scheduled-tasks/{id}` | 删除任务 | 任务创建者 |

> 注：创建任务通过 Agent 工具（`create_scheduled_task`）完成，不提供 REST 创建接口。
> 注：管理员接口需添加 `@RequirePermission` 注解。

### 5.7 管理后台 — 定时任务管理页面

**新增文件：**

| 文件 | 说明 |
|------|------|
| `admin/src/views/scheduled-tasks/index.vue` | 定时任务管理页面 |

**页面功能：**

- 任务列表表格：名称、创建者、Agent、Cron 表达式、状态、上次执行状态、上次触发时间、下次触发时间、触发次数
- 操作列：启用/禁用开关、删除按钮
- 支持分页

**路由配置：**

在 `admin/src/router/index.ts` 中新增：

```typescript
{
  path: 'scheduled-tasks',
  name: 'ScheduledTasks',
  component: () => import('@/views/scheduled-tasks/index.vue'),
  meta: { title: '定时任务', icon: 'Clock' }
}
```

### 5.8 桌面端 — 定时任务侧栏面板

**新增文件：**

| 文件 | 说明 |
|------|------|
| `desktop/src/components/ScheduledTaskPanel.vue` | 定时任务面板组件 |
| `desktop/src/composables/useScheduledTasks.ts` | 定时任务数据管理 composable |

**面板功能：**

- 任务列表：名称、状态（Active/Paused）、下次触发时间
- 操作：启用/禁用切换、删除
- 空状态提示："还没有定时任务，试试对 Agent 说'每天早上9点帮我检查新股'"

**集成位置：**

在桌面端左侧面板或设置区域添加入口，点击后展开定时任务面板。

### 5.9 消息注入与执行流程

**核心执行流程（ScheduledTaskService.executeTask）：**

```
executeTask(task)
  │
  ├─ 1. 查询 Session 当前 phase
  │     └─ 若 phase 为 RUNNING/RESUMING/WAITING_APPROVAL
  │          → 标记 last_execution_status = 'SKIPPED'
  │          → 计算 next_fire_time
  │          → return
  │
  ├─ 2. 持久化 USER 消息
  │     └─ sessionService.saveMessage(sessionId, "USER", task.prompt, ...)
  │
  ├─ 3. 更新 Session 状态
  │     └─ sessionService.updatePhase(sessionId, "RUNNING")
  │
  ├─ 4. 创建 WsStreamingEventListener（用于推送执行事件）
  │
  ├─ 5. 提交到 agentExecutor 线程池
  │     └─ agentExecutor.submit(() -> {
  │          harnessService.executeFromEvent(sessionId, eventId, listener, cancelFlag)
  │        })
  │
  ├─ 6. 更新任务状态
  │     ├─ last_fire_time = now
  │     ├─ fire_count++
  │     ├─ next_fire_time = calculateNextFireTime(cron)
  │     └─ last_execution_status = 根据执行结果设置
  │
  └─ 7. 通知判定
        └─ 复用现有 TaskCompletionNotificationService 逻辑
```

## 6. 落地清单

### 6.1 后端

| 序号 | 任务 | 文件 | 依赖 |
|------|------|------|------|
| B1 | 创建数据库迁移脚本 | `V061__scheduled_task.sql` | 无 |
| B2 | 创建实体类 | `schedule/entity/ScheduledTask.java` | B1 |
| B3 | 创建 Mapper | `schedule/mapper/ScheduledTaskMapper.java` | B2 |
| B4 | 创建 Service | `schedule/service/ScheduledTaskService.java` | B2, B3 |
| B5 | 创建 Scheduler | `schedule/scheduler/ScheduledTaskScheduler.java` | B4 |
| B6 | 创建内置工具 `create_scheduled_task` | `harness/tool/impl/CreateScheduledTaskTool.java` | B4 |
| B7 | 创建内置工具 `list_scheduled_tasks` | `harness/tool/impl/ListScheduledTasksTool.java` | B4 |
| B8 | 创建内置工具 `update_scheduled_task` | `harness/tool/impl/UpdateScheduledTaskTool.java` | B4 |
| B9 | 创建内置工具 `delete_scheduled_task` | `harness/tool/impl/DeleteScheduledTaskTool.java` | B4 |
| B10 | 创建 REST Controller | `schedule/controller/ScheduledTaskController.java` | B4 |
| B11 | 编写单元测试 | `schedule/service/ScheduledTaskServiceTest.java` 等 | B4-B10 |

### 6.2 管理后台

| 序号 | 任务 | 文件 | 依赖 |
|------|------|------|------|
| A1 | 创建定时任务管理页面 | `admin/src/views/scheduled-tasks/index.vue` | B10 |
| A2 | 注册路由 | `admin/src/router/index.ts` 修改 | A1 |

### 6.3 桌面端

| 序号 | 任务 | 文件 | 依赖 |
|------|------|------|------|
| D1 | 创建定时任务 composable | `desktop/src/composables/useScheduledTasks.ts` | B10 |
| D2 | 创建定时任务面板组件 | `desktop/src/components/ScheduledTaskPanel.vue` | D1 |
| D3 | 集成到桌面端布局 | 相关布局组件修改 | D2 |
| D4 | 更新 package.json version | `desktop/package.json` | 全部 |

### 6.4 执行顺序

```
Phase 1 — 后端基础（B1 → B2 → B3 → B4）
Phase 2 — 后端核心（B5, B6, B7, B8, B9, B10 并行，均依赖 B4）
Phase 3 — 后端测试（B11）
Phase 4 — 管理后台（A1 → A2，依赖 B10）
Phase 5 — 桌面端（D1 → D2 → D3 → D4，依赖 B10）
```

## 7. 风险与注意事项

| 风险 | 说明 | 应对 |
|------|------|------|
| Session 消息膨胀 | 定时任务长期运行后 Session 消息量过大 | 现有 CompactionService 自动压缩机制兜底 |
| Scheduler 扫描性能 | 任务量大时每分钟全表扫描 | `idx_status_next_fire` 索引保证查询效率，仅查询 `next_fire_time <= now` 的记录 |
| 线程池饱和 | 大量定时任务同时触发 | 复用现有 `agentExecutor` 线程池，已有队列机制；跳过策略也避免并发堆积 |
| 时区问题 | Cron 触发时间与用户期望不一致 | 使用系统默认时区（Asia/Shanghai），后续可扩展用户级时区设置 |
| LLM 费用 | 定时任务频繁调用 LLM 产生费用 | 用户自行控制任务频率；管理员可在管理后台监控触发次数 |
