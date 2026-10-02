# 提案：跨会话长期记忆（Memory 层）

- 状态：已转入实施，技术方案见 `docs/plan/2026-10-02-long-term-memory-technical-design.md`
- 日期：2026-10-02
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Mao 的 Agent 目前是"每次见面都从零开始"：

- **单会话内**：ContextManager / CompactionService 负责上下文压缩，会话结束即遗忘。
- **跨会话**：唯一的记忆资产是 Agent"经验"（`backend-ts/src/agent/agent-experience.service.ts`，`agent_experiences` 表）——管理员手工维护、单条上限 300 字（`MAX_CONTENT_LENGTH`）、Agent 级别而非用户级别。
- **注入点**：`backend-ts/src/harness/core/prompt-engine.ts` 的 `buildSystemPrompt()` 以 `## 最佳实践经验` 段落注入上述经验。

缺口：用户在会话里说过"我们仓库用 pnpm"、"报告用中文写"，下个会话、换个 Agent 就全部归零。这些信息其实已经躺在会话消息里，只是没有任何机制把它们沉淀下来。

## 2. 目标 / 非目标

**目标**

1. Agent 在完成任务后自动沉淀"值得记住的长期事实"（用户偏好、项目事实）。
2. 后续会话（跨 Agent、跨会话）在系统提示词中注入相关记忆。
3. 用户对自己的记忆有完全的可见性与控制权：查看、编辑、删除、关闭自动收集。
4. 管理后台可只读审计某个用户的记忆内容（治理平台的定位）。

**非目标**

- 不做跨用户记忆共享，不做组织级记忆（第一期）。
- 不引入向量库 / embedding 检索（MVP 用规范化去重 + 条数截断；规模上来后再评估）。
- 不做自动遗忘 / 过期衰减（只做用户手动删除）。
- 不改现有 `agent_experiences`（管理员手工经验）的结构与交互；它是第三级"人工沉淀"，与本提案的自动记忆互补。

## 3. 记忆模型

两级自动记忆 + 一级既有经验：

| 级别 | 绑定维度 | 示例 | 来源 |
|---|---|---|---|
| USER | 用户，跨 Agent、跨工作区 | "输出报告用中文"、"习惯 pnpm" | 自动抽取 + 用户手写 |
| PROJECT | 工作区（workspace），跨 Agent | "该仓库测试用 Vitest"、"部署脚本是 scripts/deploy.sh" | 自动抽取 + 用户手写 |
| AGENT | Agent（现有"最佳实践经验"） | 该 Agent 的方法论、注意事项 | 管理员手工（现状不变） |

注入优先级：AGENT（现状段落）→ PROJECT → USER，冲突时以用户当前消息为准（注入文案中显式声明）。

## 4. 技术方案

### 4.1 数据模型（迁移 V129）

```sql
CREATE TABLE IF NOT EXISTS `memory_item` (
    `id`                BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`           BIGINT NOT NULL,
    `scope`             VARCHAR(16) NOT NULL COMMENT 'USER/PROJECT',
    `workspace_key`     VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'PROJECT 级：工作区键（规范化路径 SHA-1 前 16 位）；USER 级为空串',
    `workspace_label`   VARCHAR(256) NULL COMMENT '工作区展示名（用户可读）',
    `content`           TEXT NOT NULL,
    `source`            VARCHAR(16) NOT NULL DEFAULT 'MANUAL' COMMENT 'AUTO=Agent 抽取 / MANUAL=用户手写',
    `status`            VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DISMISSED',
    `dedup_hash`        CHAR(40) NOT NULL COMMENT 'SHA-1(scope|workspace_key|规范化 content)',
    `origin_session_id` BIGINT NULL COMMENT 'AUTO 抽取来源会话',
    `created_at`        DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_memory_dedup` (`user_id`, `dedup_hash`),
    INDEX `idx_memory_user` (`user_id`, `scope`, `status`),
    INDEX `idx_memory_workspace` (`workspace_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- 去重哈希把 scope 与 workspace 算进内容，同一事实在用户级与项目级各自去重。
- LOCAL 模式的本机路径不做原文存储，只存哈希 + 用户可见的展示名，避免把本机用户名等敏感片段落库。

用户级开关复用 `src/preference` 域的 KV：`memory_auto_capture_enabled`（默认开）。

### 4.2 写入路径：任务收尾自动抽取

挂点与任务完成通知同源：`backend-ts/src/session/task-terminal.service.ts` 中相位收敛到 `COMPLETED`、调用 `TaskNotificationDeliveryService.prepare()` 的同一位置，追加投递一个**异步**记忆抽取任务。

抽取流程（`MemoryExtractionService`，新域 `backend-ts/src/memory/`）：

1. 取该会话最后一轮 USER 消息与 ASSISTANT 最终答复（已有消息持久化，不重读全量）。
2. 构造抽取 prompt：只抽"明确的长期事实/偏好"，输出 JSON 数组，每条 ≤ 120 字，最多 3 条；无值得记的输出空数组。
3. 经 LlmAdapter 调用。模型走系统级"轻量模型"配置（`settings` 域新增配置项，缺省回落到 Agent 默认模型）。
4. 解析失败 / 超时 / 超条数一律静默放弃（记 metrics），**绝不影响任务本身的完成语义**。
5. 命中 `uk_memory_dedup` 的重复条目更新 `updated_at`（视为"再次确认"，利于排序）。

约束：只在 `COMPLETED` 抽取（`FAILED` 的教训沉淀是否纳入作为开放问题）；同一会话并发任务串行抽取，避免重复。

### 4.3 注入路径

- `AgentExecutionContext` 增加 `memories?: MemoryHint[]`，由 HarnessService 在会话启动时查询（USER 级 + 当前会话工作区的 PROJECT 级）。
- `prompt-engine.ts` 的 `buildSystemPrompt()` 在"最佳实践经验"段之后新增：

  ```
  ## 长期记忆
  以下是关于这位用户与当前项目的已确认记忆；与用户当前消息冲突时，以当前消息为准：
  - [项目:xxx] ...
  - [用户] ...
  ```

- 上限（建议初值，评审可调）：USER 8 条 + PROJECT 12 条，按 `updated_at` DESC 取，注入预算约 400 token。
- CLOUD / LOCAL 均走服务端注入，无执行边界差异。

### 4.4 API 面（用户域，登录态，`Result<T>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/memory` | 分页列表，支持 `scope` / `workspaceKey` / `status` 过滤 |
| POST | `/api/v1/memory` | 手工新增（scope、content，PROJECT 级需带 workspaceKey） |
| PATCH | `/api/v1/memory/:id` | 编辑内容 / DISMISS |
| DELETE | `/api/v1/memory/:id` | 删除 |
| GET/PATCH | `/api/v1/memory/settings` | 自动收集开关 |

归属校验：全部只允许操作 `user_id = 当前用户` 的行。管理后台新增只读查询 `/api/v1/admin/memory?userId=`，按 V121 `admin_permission_catalog` 的模式注册权限码。

### 4.5 前端落点（桌面 / Web / 安卓共用 UI）

- `desktop/src/views/settings/` 新增 **MemoryView（我的记忆）**：scope 过滤（全部 / 用户 / 项目）、来源徽标（自动 / 手动）、行内编辑、删除、新增、自动收集总开关；SettingsView 挂入口。三端同源自动获得。
- 会话内不新增 UI；Agent 是否记住了什么，用户去设置页看（保持聊天界面克制）。

### 4.6 工具化（第三阶段，可选）

给 Agent 提供 `memory_save` 显式写入工具，与隐式抽取互补。注意遵守仓库规范：同步补 `backend-ts/src/session/util/tool-result-summarizer.ts` 摘要与 `desktop/src/utils/toolDisplay.ts` 中文名/参数预览，并补成功/失败/缺参回归测试。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 表 + 注入路径 + 手工管理 API + MemoryView（先让用户能手动攒记忆、Agent 能用上） | 中 |
| P2 | 收尾钩子自动抽取 + 去重 + 轻量模型配置项 | 中 |
| P3 | `memory_save` 工具；embedding 检索评估；FAILED 教训抽取评估 | 小 |

建议 P1 与提案五（任务收件箱）错开排期，两者都动 `task-terminal.service.ts` 附近的收敛点，避免并行改同一段代码。

## 6. 风险与开放问题

- **记忆污染**：错误事实被固化后反复注入。缓解：来源与来源会话可追溯、注入条数上限、DISMISS 一步可达成、抽取 prompt 强调"只抽明确事实"。
- **抽取成本**：每次完成任务多一次廉价 LLM 调用；异步执行不阻塞任务结束。需要"轻量模型"配置项落在 settings 域。
- **隐私**：记忆对用户全可见可删；admin 只读审计入口需在页面明确提示用途；LOCAL 工作区路径哈希化存储。
- **去重质量**：精确哈希挡不住改写（"用 pnpm" vs "包管理器是 pnpm"）。MVP 接受该粗糙度，条数上限兜底。
- **开放问题**：PROJECT 级记忆是否应该跟随共享工作区跨用户可见？（第一期：否，记忆永远归属个人。）

## 7. 测试要点

- prompt-engine：注入顺序 / 上限截断 / 空列表不产生段落 / 冲突声明文案存在。
- MemoryExtractionService：LLM 返回非法 JSON、空数组、超 3 条、去重命中更新 `updated_at` 而非报错。
- routes：跨用户操作 404、`Result` 错误码、分页。
- 收尾钩子：COMPLETED 触发一次、FAILED 不触发、抽取异常不影响任务完成事件链。
