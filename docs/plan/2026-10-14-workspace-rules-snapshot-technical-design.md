# 工作区规则会话级快照（Workspace Rules Snapshot）技术方案

> 状态：**已确认（需求方五项决策已锁定，见 §10）；本轮暂不实施**，待排期
> 日期：2026-10-14
> 覆盖端：后端 backend-ts、数据库迁移。desktop / admin / android / shared/contracts **不改**。
> 上游：`docs/plan/2026-10-12-prompt-prefix-cache-optimization-technical-design.md`（评审项 c 提供了前缀指纹观测，本方案复用为验收手段；评审项 e 的邻域）
> 定位：**不改前缀结构、不改协议层**，只把「工作区规则」这一节的文本在会话维度冻结并持久化，消除"改一次 AGENTS.md 打掉全局前缀"的高频失效。

---

## 1. 需求背景

### 1.1 现象与实测证据（2026-10-14 生产数据）

同一工作区 `oc_4fc3cb715272aae592213f167743846d`（一个飞书群共用，100+ 会话）当天两次塌陷：

| 会话 | 事件 | 结果 |
|---|---|---|
| 811 「dc-pts-exector 压测重试」 | 13:06:09.519 同工作区**兄弟会话 818** 编辑 `AGENTS.md`（+1 行，知识索引表）→ 811 当时正在等一个 300s 超时的 `curl` 工具，恢复后于 13:11:11.539 建请求，日志 `prefix changed session=811 changedSections=[workspace-rules] toolsChanged=false messages=478` | prompt 453,569 / cached **8,576（1.9%）**，cost 0.8953 元，首字 7.29s |
| 756 「RabbitMQ登录鉴权与指标获取」 | 上轮 10-13 14:14:38 命中 99.8%；期间 10-13 16:14:57 / 17:17:31 **会话 790** 两次编辑 `AGENTS.md`；10-14 09:59:22.850 日志 `changedSections=[workspace-rules] messages=621` | prompt 447,652 / cached **9,216（2.1%）**，cost 0.9050 元，首字 7.62s |

- **命中残留 8,576 / 9,216 ≈ 系统提示中「工作区规则」节之前的长度**（同刻同工作区的 818 会话命中的也是 8,576，可交叉印证）：断点之后 = 剩余 system 文本 + 工具定义 + 全部历史，全部重算。
- **不是缓存 TTL**：同模型同期存在 18.5h / 20.3h / 21.0h 空闲后仍 100% / 99.7% / 99.9% 命中的实例（会话 435 / 797 / 521）。
- **单次代价**：命中态成本 = `prompt×0.04/M + completion×8/M ≈ 0.023 元`（811 实付 0.8953 元，多花 **0.872 元**）；756 命中态 0.0457 元，多花 **0.859 元**。当天该工作区（含 818 / 819 的连带损失）合计多花 **≈ 3.9 元**，且随上下文线性放大（45 万 token 时首字 +5~6s）。
- **占比**：过去 28 小时全站 `prefix changed` 告警 146 次，`[workspace-rules]` **110 次（75%）**，`[system-prompt,skills,subagent]` 24 次，`[skills]` 12 次。

### 1.2 现状代码事实（实施前已核对）

| 事项 | 现状 | 位置 |
|---|---|---|
| 该节的注入方式 | `AGENTS.md` 内容作为系统提示**最后一节**「工作区规则」（key `workspace-rules`，独立成节） | `harness/core/prompt-engine.ts:340`，节键见 `:119` |
| 读取与截断 | CLOUD：读 `${effectiveWorkspace}/AGENTS.md`，取前 200 行，超出追加上「仅展示前200行」提示；LOCAL：用桌面端上报的 `context.agentsMdContent` | `prompt-engine.ts:617-640`，常量 `:95` / `:121` |
| 变更即失效 | 该节文本参与前缀逐字节比对，任一变化都会打掉其后全部内容 | `prompt-engine.ts:143-145`（组 sections）、`:192`（前缀指纹观测） |
| 观测手段（已就位） | 每次 buildRequest 比对「系统提示逐节 hash + 工具 hash」，变化时 warn 点名节名 | `harness/core/prompt-prefix-monitor.ts`，进程内 Map（512 LRU，**重启即失忆**） |
| 该节的编辑来源 | 工作区约定要求"新增仓库/文档后同步更新本文件的表"，且知识索引表本就在本文件登记 → 各会话在任务收尾顺手 `edit_file` | 生产实测：10-13~10-14 共 8 次编辑，全部是这两张表加行 |
| 会话删除清理先例 | `SessionService.deleteSession()` 依次清理审批规则、压缩表、消息（逻辑删），并经 `onSessionDeleted` 钩子清理定时任务与 CLOUD MCP 快照 | `session/session.service.ts:514-545`、`create-app.ts:763-781` |
| 压缩提交点 | `SessionCompactionOrchestrator.compact()` 内 `sessionCompactionService.persist(...)` 返回 `persisted=true` 即 CAS 获胜、边界推进成功 | `harness/core/session-compaction-orchestrator.ts:41-125` |
| 迁移机制 | 启动时由 `db/flyway.ts` 自动执行 `V{n}__*.sql`（CRC32 校验），当前最新 `V152` | `backend-ts/db/migration/` |

### 1.3 为什么本轮不在文档层解决

"把两张索引表移出注入范围"（锚点注入）确实能根治，但真实成本在治理而非代码：需要迁移 100+ 个工作区各自的 `AGENTS.md`，并修改 DB 里 `experiences` 注入节中那条要求"在 AGENTS.md 用索引表登记"的经验文案——落地依赖每个会话守约定。本方案先在**机制层**消除代价（不改任何人的使用习惯），文档层拆分列为后续可选（§2.2）。

---

## 2. 需求描述

### 2.1 要做的

1. **会话级冻结**：同一会话内，「工作区规则」节文本固定不变；`AGENTS.md` 的任何编辑**只对新会话生效**。
2. **持久化**：快照落库（MySQL），后端重启 / 蓝绿切换后仍沿用同一文本 → 重启不再引发塌陷。
3. **压缩提交后失效**：会话压缩边界推进成功时删除快照，下一次 `buildRequest` 重新读取并落库（把"规则改了不生效"的窗口收窄到「新会话 / 压缩后 / 会话删除后」）。
4. **会话删除清理**：走既有 `onSessionDeleted` 钩子物理删行。
5. **可观测**：冻结、磁盘已变但被冻结、失效三类事件各一条日志，避免"我改了规则怎么没生效"的排障黑洞。

### 2.2 不做的

- **不做**文档层拆分（锚点注入 / 索引表外置）——与本题正交，另立方案评估。
- **不做**其他注入节的冻结：`memories` / `experiences` / `skills` / `system-prompt` 保持现状（28 小时窗口内它们没有产生告警；且记忆/技能的"改了立刻生效"是用户预期，冻结的语义代价远大于收益）。
- **不做**进程内 L1 缓存（见 §3.2）。
- **不做**前端 / 管理后台 UI（无需展示快照；排障走日志与 SQL）。
- **不做**快照历史留档 / 审计表（只保留"当前生效"一行；历史由日志与 `llm_call` 承载）。
- **不做**跨会话 / 跨用户共享快照（同一工作区不同会话各自冻结，语义简单）。

---

## 3. 技术选型

### 3.1 快照载体：数据库 vs 进程内存 vs 工作区文件

选**数据库**（`session_workspace_rules`，主键 `session_id`）。理由：需求方明确要求"避免后端重启导致快照失效"；进程内 Map 在每次蓝绿重启后全部失忆，届时每个在跑会话都会重新读盘——恰好在部署窗口制造一次全站塌陷（本方案要消除的正是这类事件）。落库同时天然获得跨实例一致性（见 §3.2）。

### 3.2 是否加进程内 L1

选**不加**：每次 `buildRequest` 直接做一次主键点查。理由：

- 现状 CLOUD 路径下 `workspaceRules()` 每轮已经在做 `existsSync + statSync + readFileSync` 三次文件系统调用；换成 PK 点查（微秒级、走连接池）不增加量级。LOCAL 路径本就用桌面端上报的内存内容，无 fs 开销，加一次点查也仍可在同一量级。
- 有 L1 就重新引入"多实例各自一份、失效后短暂不一致"的问题；无 L1 则**不存在单活实例假设**（解除了上一轮讨论中"横向扩容后每次必 miss"的风险）。
- 仍保留文件读取（CLOUD 下每轮读 `AGENTS.md` 只为**比对**，不用于注入）：这样才能打「磁盘已变但被冻结」的提示日志，并在"文件被删/被建"时给出明确痕迹。读文件的成本已包含在现状里。

### 3.3 冻结键：`session_id` 主键 + `workspace` 守卫列

会话与工作区是 1:1，主键取 `session_id` 即可。额外存 `workspace` 作为守卫：与当前有效工作区不一致时视为无效快照（覆盖重写），避免测试/异常路径下把 A 工作区的规则注入到 B 工作区。

### 3.4 空文本是否冻结

**只在读到非空内容时冻结**。若首轮读到空（`AGENTS.md` 不存在 / 为空）就不落行、每轮重读——否则"会话早于规则文件创建"的会话将永远看不到规则，而"Agent 刚被要求写一份 AGENTS.md、自己却看不到"是最容易引发困惑的场景。代价是该文件**首次出现**时会引发一次前缀变化（一次 miss），属低频一次性事件，且此时会话通常较短（代价小）。

### 3.5 失效时机：压缩提交成功

选**压缩提交成功（`persisted=true`）后失效**，而不是"每轮检测磁盘变化就失效"（那就等于不做冻结）或"仅会话删除"（规则时效性太差）。压缩后历史已被摘要替换、messages 段本来就要整段重算，此时失效只需多付 system 前缀（约 8.5k token ≈ 0.017 元）就能让新规则生效——这也是需求方确认的第二项决策。

### 3.6 是否加 `system_setting` 开关

**不加**（默认行为即新行为，回滚 = 回滚代码 + 重新部署；2026-10-14 需求方已确认，见 §10）。理由：本项目部署是"push 到 main → `deploy-mao.sh`"，回滚成本约 5 分钟；加开关会长期留下一条无人验证的第二路径，与 AGENTS.md「不引入不必要的特性开关」的约定冲突。（若将来确需一键关停，最小改法是 V153 增一条 `system_setting`（`harness.prompt.pinWorkspaceRules`，默认启用）+ `create-app.ts` 读取后决定是否注入快照服务，改动点与 V152 同构。）

---

## 4. 详细设计

### 4.1 表结构（`V153__session_workspace_rules.sql`）

```sql
CREATE TABLE IF NOT EXISTS `session_workspace_rules` (
    `session_id`   BIGINT       NOT NULL COMMENT '会话ID（一行一会话）',
    `workspace`    VARCHAR(512) NOT NULL COMMENT '冻结时的有效工作区绝对路径；与当前值不一致视为无效快照',
    `rules_text`   MEDIUMTEXT   NOT NULL COMMENT '该节完整注入文本（含 ## 工作区规则 标题与 200 行截断提示）',
    `rules_hash`   CHAR(64)     NOT NULL COMMENT 'rules_text 的 sha256（与 prompt-prefix-monitor 同口径，排障用）',
    `source_path`  VARCHAR(512) NULL COMMENT '来源文件绝对路径；LOCAL 模式为 NULL（内容由桌面端上报）',
    `source_mtime` BIGINT       NULL COMMENT '来源文件 mtime（毫秒）；LOCAL 模式为 NULL',
    `created_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '冻结时刻',
    `updated_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话级工作区规则快照（提示词前缀缓存稳定化）';
```

- 存**注入文本本身**（所见即所存），不存原始文件：截断规则（200 行）只在一个地方生效，读侧不再二次加工。
- 不建外键（与项目既有表一致）；`created_at` 用毫秒精度（对齐 V142 口径）。
- 体量：一行 ≤ 一次注入量（示例文件 15KB）；行数 ≈ 有活跃规则的会话数。不设 TTL，靠会话删除回收。

### 4.2 读写路径

```
workspaceRules(rawText, workspace) 每轮 buildRequest 调用一次：

  rawText 为空            → 原样返回 ''（不落库、不注入该节）        [§3.4]
  sessionId == null       → 原样返回 rawText（非 harness 场景，保持现状）
  否则查 session_workspace_rules：
    1) 命中且 workspace 一致
         → 用快照 rules_text 注入；若 hash(rawText) != rules_hash
            → 打一条 info「磁盘已变但被冻结」（同一磁盘 hash 每会话只打一次）
    2) 未命中 / workspace 不一致 / rules_text 为空（异常行）
         → INSERT ... ON DUPLICATE KEY UPDATE（让并发同刻只留一行）
         → 用本次 rawText 注入，info「快照已冻结」
```

- 首次落库用 `INSERT ... ON DUPLICATE KEY UPDATE session_id = session_id`（no-op 保底），避免并发首轮撞主键报错。
- 极端竞态（同一会话两个请求同时 miss，且两者之间文件被改）会留下"快照为 v1、某轮注入 v2"的偏差，下一轮回到 v1 时多一次 miss —— 概率极低、代价一次，不做补偿（§7 登记为已知边界）。
- 失效与删除：
  - `invalidate(sessionId)` → `DELETE FROM session_workspace_rules WHERE session_id = ?`；下一轮重新读取落库。
  - `deleteBySessionId(sessionId)` → 同上，用于会话删除。

### 4.3 PromptEngine 改造（最小侵入）

现状 `buildSystemPromptSections(context)` 是**同步**方法，而查快照需要 `await`。改法是只在 `buildRequest` 里 await 一次，把结果往下传，不把整棵分节构建改成异步：

```ts
// prompt-engine.ts:143 一带
const effectiveWorkspace = hasText(context.workspace) ? context.workspace! : this.pathSandbox.getWorkspaceRoot();
const rulesText = await this.resolveWorkspaceRules(context, effectiveWorkspace); // 读盘 + 查/建快照
const sections = this.buildSystemPromptSections(context, effectiveWorkspace, rulesText);
```

- `buildSystemPromptSections` 增加两个入参，原 `:340` 处改为 `if (rulesText.length > 0) sections.push({ key: 'workspace-rules', ... })`；`effectiveWorkspace` 的计算从节内上提到 `buildRequest`（节内不再自行计算）。
- 原 `workspaceRules()` 拆成**纯读**的 `readWorkspaceRules(context, effectiveWorkspace): { text, sourcePath, sourceMtime }`（CLOUD 读文件 + 200 行截断；LOCAL 用 `context.agentsMdContent`）+ 快照服务的冻结/取用。
- `private buildSystemPrompt()`（`:254`，当前无调用方，仅作重构前的逐字节参照）同步补传参，保持可编译与语义一致。
- 构造参数追加第 6 个**可选**依赖 `workspaceRulesSnapshot?: WorkspaceRulesSnapshotService | null`：缺省时退化为现状行为（每轮读盘、不落库）——既有 9 处 `new PromptEngine(...)` 测试**全部不用改**。

### 4.4 新增模块

| 文件 | 职责 |
|---|---|
| `harness/core/workspace-rules-snapshot.repository.ts` | 纯 SQL：`selectBySessionId` / `insertIgnore` / `deleteBySessionId`，构造注入 `Db`（与 `session-compaction.repository.ts` 同风格） |
| `harness/core/workspace-rules-snapshot.service.ts` | 语义：`resolve(sessionId, workspace, rawText, source)`（冻结/取用 + 日志）、`invalidate(sessionId)`、`deleteBySessionId(sessionId)`；`resetForTest()` |

### 4.5 压缩提交后失效

`SessionCompactionOrchestrator` 构造追加可选依赖 `workspaceRulesSnapshot`，在 `sessionCompactionService.persist(...)` 返回 `persisted === true` 分支内（`session-compaction-orchestrator.ts:76-96`）调用：

```ts
if (persisted) {
  // 压缩边界已推进：解冻工作区规则，让后续请求重新读取 AGENTS.md（技术方案 §3.5）
  await this.workspaceRulesSnapshot?.invalidate(sessionId);
  this.compactionArchiveService.writeArchive(...); // 既有逻辑
}
```

- **只在 CAS 获胜时失效**：`persisted=false`（并发被他人推进）不失效，避免白刷一次前缀。
- 失效发生在压缩请求**之后**（该请求早已发出），不会污染压缩请求自身的严格前缀不变量；紧随其后的 `afterRequest` 只用于 token 估算，用新文本无副作用。

### 4.6 会话删除清理

`create-app.ts:776-779` 的 `onSessionDeleted` 回调内追加一行（该钩子已在清理定时任务与 CLOUD MCP 快照，是既有的"会话绑定资源回收"位置）：

```ts
async (sessionId) => {
  await deleteScheduledTasksForSession?.(sessionId);
  mcpSyncRef?.clearCloudSnapshot(sessionId);
  await workspaceRulesSnapshotService.deleteBySessionId(sessionId); // 新增
}
```

不接三个执行出口（结束/中断/失败）——与 CLOUD MCP 快照同样的存活期语义：会话级资源只在会话删除时回收。

### 4.7 日志与可观测

| 时机 | 级别 | 内容（示例） |
|---|---|---|
| 首次冻结 | info | `workspace rules snapshot pinned session=811 chars=15169 source=/…/AGENTS.md mtime=…` |
| 磁盘已变但被冻结 | info | `workspace rules changed on disk but snapshot retained session=811 disk_hash=ab12… pinned_hash=cd34… effective=on-next-snapshot`（同一 `disk_hash` 每会话只打一次，避免每轮刷屏） |
| 失效 | info | `workspace rules snapshot invalidated session=811 reason=compaction-committed` |
| 取用快照 | — | 不打日志（每轮都发生） |

与既有 `prompt-prefix-monitor` 的分工：monitor 继续负责"实际发出的前缀是否变化"（本方案上线后 `changedSections=[workspace-rules]` 应只在"新会话首次"与"压缩后"出现），本服务的日志解释"为什么变了 / 为什么没变"。

---

## 5. 实施步骤

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0-1 | 迁移 `V153__session_workspace_rules.sql` + repository + service（含 `resolve` / `invalidate` / `deleteBySessionId`）+ 单测 | 无 |
| P0-2 | `PromptEngine`：`buildRequest` 上提 `effectiveWorkspace` + await 取文本；`workspaceRules()` 拆成 `readWorkspaceRules()`；构造追加可选依赖 | P0-1 |
| P0-3 | 装配：`create-app.ts` 构造 repo/service 注入 `PromptEngine` 与 `SessionCompactionOrchestrator`；`onSessionDeleted` 追加清理 | P0-2 |
| P0-4 | 压缩提交点调用 `invalidate`（CAS 获胜分支） | P0-1 |
| P1-1 | 文档与发版：`CHANGELOG.md` 顶部后端小节；`docs/agents/*.md` 记一条（含"规则改了本会话不生效"的行为变化与排障日志） | 全部 |
| P1-2 | 观察窗：部署后看 `changedSections=[workspace-rules]` 频次与该工作区 `cached/prompt` 是否不再出现 8~9k 指纹 | 部署 |

## 6. 测试要点

**repository / service**
- `selectBySessionId` 命中与 miss；`insertIgnore` 重复键不抛错；`deleteBySessionId` 返回影响行数。
- `resolve` 三分支：无快照 → 落库并用本次文本；有快照且同 workspace → 用快照文本（**即使 rawText 已不同**）；workspace 不一致 → 覆盖重写（不误用旧文本）。
- 空文本不落库；`sessionId=null` 不走快照。
- 磁盘已变日志：同一 `disk_hash` 只打一次；`disk_hash` 再变时再打一次。
- `invalidate` 后下一次 `resolve` 落到新文本。

**PromptEngine**
- 同会话两次 `buildRequest`，中途改写 `AGENTS.md` → `request.messages[0]` 字节不变（复用 `observePrefix` 断言 `changedSections` 为空）。
- 换 `sessionId`（新会话）→ 使用新内容。
- 无快照服务注入（第 6 参缺省）→ 行为与改造前一致（既有 9 处 `new PromptEngine(...)` 用例保持绿色即为回归证据）。
- 空文本 → 不注入该节；随后出现非空文件 → 该节出现（验证 §3.4 的取舍）。
- 压缩/删除后重新读取：`deleteBySessionId` → 下次 build 用磁盘最新内容。
- 既有 g 项守卫用例（`sameContextBuildsByteIdenticalRequest` / `appendingUserMessageKeepsPreviousPrefix`）保持绿色。

**Orchestrator 接入点**
- `persist` 返回 true → `invalidate` 被调用一次；返回 false（CAS 冲突）→ 不被调用。
- 压缩请求自身的严格前缀不变量测试（`compaction-service.spec.ts` 的 `derivesStrictPrefixWithoutMutatingNormalRequestAndUsesStream`）保持绿色。

**会话删除**
- `SessionService.deleteSession` 触发 `onSessionDeleted` → 快照行被删（沿用 `session-extra.spec.ts` 既有钩子断言风格）。

## 7. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 规则改了但本会话不生效 | 会话内编辑 `AGENTS.md`（含 Agent 自己写的） | 属本方案的预期语义；info 日志明确告知；压缩提交 / 新会话 / 会话删除后自动刷新；写入 `docs/agents/` 与 CHANGELOG 供客服与用户解释 |
| 长会话看到过期索引 | 会话跨天、期间别处 clone 了新仓库 | 需求方已确认**跨天不失效**（换跨天前缀命中，见 §10.1）；影响面小（模型可 `ls`/`glob` 工作区自查）；压缩后即刷新 |
| 每轮多一次 DB 点查 | 所有 `buildRequest` | 主键点查，量级低于现状的三次 fs 调用；无 L1 换取跨实例一致与零状态 |
| 快照行累积 | 会话删除路径异常未清 | 一行一会话、无 TTL；必要时按 `updated_at` 老化清理（不在本轮） |
| 并发首轮撞主键 | 同会话并发首次 `buildRequest` | `ON DUPLICATE KEY UPDATE` no-op 保底；极端竞态仅多一次 miss（§4.2 已登记） |
| 压缩后失效导致一次 system 前缀重算 | 每次压缩提交 | 压缩后上下文已降到万级 token，重算成本 ≈ 0.017 元，换取规则时效性（需求方已确认） |
| 工作区规则文本本身变大 | `AGENTS.md` 持续膨胀 | 不属本方案目标；不影响命中率（冻结后变更不再失效），另立文档层方案评估 |
| 数据库不可用 | 极端故障 | 与 `llm_call` 落账同级依赖；`resolve` 失败时**降级为直接使用本次 `rawText`**（不阻断对话），并打 warn——即退化回改造前行为 |

## 8. 落地清单

**backend-ts（新增）**
- `db/migration/V153__session_workspace_rules.sql`
- `src/harness/core/workspace-rules-snapshot.repository.ts`
- `src/harness/core/workspace-rules-snapshot.service.ts`
- `src/harness/core/workspace-rules-snapshot.service.spec.ts`

**backend-ts（修改）**
- `src/harness/core/prompt-engine.ts`（`buildRequest` 上提 `effectiveWorkspace`、await 取文本；`workspaceRules()` → `readWorkspaceRules()`；构造追加可选依赖）
- `src/harness/core/session-compaction-orchestrator.ts`（构造追加可选依赖 + CAS 获胜分支调用 `invalidate`）
- `src/create-app.ts`（构造 repo/service、注入两处、`onSessionDeleted` 追加清理）
- `src/harness/core/prompt-engine.spec.ts`（新增冻结/换会话/空文本用例）
- `src/harness/core/session-compaction-orchestrator.spec.ts`（invalidate 调用时机）

**文档**
- `CHANGELOG.md` 顶部新增后端小节（用户可见的行为变化：会话内编辑 AGENTS.md 不生效，下次会话生效）
- `docs/agents/*.md` 新增一条（关键词：workspace-rules / 前缀缓存塌陷 / 8~9k 命中指纹 / 快照 / 排障日志）

**不改**：desktop / admin / android / shared；协议层与缓存字段（`prompt_cache_key` / `cache_control`）；`prompt-prefix-monitor`（继续作为验收观测手段）。

## 9. 验收口径

1. **不塌陷**：同工作区任一兄弟会话编辑 `AGENTS.md` 后，在跑会话的 `cached/prompt` 不再出现 8~9k 级（1%~3%）塌陷；`prompt-prefix-monitor` 的 `changedSections=[workspace-rules]` 只出现在「新会话首次」与「压缩提交后」。
2. **重启不失效**：蓝绿重启后，重启前在跑的会话首次请求仍高命中（`cached/prompt` 与重启前同量级），日志可见 `snapshot pinned` 之外没有新的 `pinned` 行（说明直接复用了库里的快照）。
3. **压缩后生效**：会话内改写 `AGENTS.md` → 本会话不生效（日志出现 `snapshot retained`）→ 触发一次压缩 → 下一轮 system 提示出现新内容（日志出现 `invalidated reason=compaction-committed` + `pinned`）。
4. **会话删除回收**：删除会话后 `SELECT COUNT(*) FROM session_workspace_rules WHERE session_id = ?` = 0。
5. **不退化**：backend-ts 全量 `npm test` 全绿；改造前后"同一上下文 + 同一工具集 + 同一 AGENTS.md"的请求体逐字节一致。
6. **成本**：该工作区单日因 `workspace-rules` 失效产生的额外成本从 ≈ 3.9 元降到 0（可用 `llm_call` 的 `cached/prompt` 与 `cost_micros` 按会话核对）。

## 10. 已确认决策（2026-10-14 需求方，全部锁定）

| 决策点 | 结论 | 章节 |
|---|---|---|
| 快照载体 | **持久化到 MySQL**，避免后端重启/蓝绿切换导致快照失效 | §3.1 |
| 失效时机 | **压缩提交后失效**（`persisted=true` 分支），收窄"规则不生效"窗口 | §3.5、§4.5 |
| 全局开关 | **不加** `system_setting` 开关，行为即新行为，回滚走代码 | §3.6 |
| 文档层拆分 | **不做**（本轮不动 `AGENTS.md` 的索引表结构） | §1.3、§2.2 |
| 跨天 | **不失效**：会话跨天时继续用冻结快照，不为"日期推进"主动刷新 | §10.1 |

### 10.1 关于"跨天不失效"

需求方明确期望**跨天也能命中前缀缓存**，因此本方案不为日期推进主动失效。这与既有设计是自洽的：

- 系统提示的「当前日期」节锚定**会话首条用户消息日期**（`context.sessionBaseYmd`，来自 `sessionRepository.selectFirstUserStamp`），会话内固定不变；真实日期推进通过**尾部** `<date-change>` 标签消息（`session-date-notice.ts`，只作用于本次请求副本、不落库）表达。
- 因此跨天本身不会改变 system 前缀——只要「工作区规则」节也被冻结，跨天的首个请求仍能整段命中前缀缓存（新增的只有尾部那条标签消息）。
- 代价（已知并接受）：会话跨天期间在别处 clone 的新仓库 / 新写的知识索引，本会话看不到（§7 已登记）；模型可用 `ls` / `glob` 自查工作区兜底。

**后续可选（不在本轮，仅登记）**：文档层拆分（索引表移出注入范围）。它是"规则文件持续膨胀"与"长会话看到过期索引"的根治手段，与本方案不冲突，待有实例触发时再评估。

## 附：回滚

- **回滚代码 + 重新部署**即回到现状行为（每轮读盘、不落库）；`session_workspace_rules` 表残留无副作用（不被读取），需要时可 `DROP TABLE`。
- 运行期"强制刷新某会话"无需重启：`DELETE FROM session_workspace_rules WHERE session_id = ?` 即可（这是本方案顺带获得的一个运维能力）。

