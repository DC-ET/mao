# 信号哨兵指定执行会话技术方案

- 状态：待实施（2026-11-17 定稿；同日经评审修订：补通道回流设计、修 `trigger_mode` 列宽、layout 测试冲突等，见 §8）
- 日期：2026-11-17
- 需求来源：用户反馈——通过对话任务创建的信号哨兵，用户默认认为触发任务会在当前会话执行；实际默认 `NEW_SESSION`，每次变化新建独立会话。尤其在飞书通道对话里创建的哨兵，触发结果落在独立 `signal` 分组会话中且**不会回流到飞书聊天**，用户永远无法感知。
- 规模：后端约 260 行（迁移 1 列 + 1 列改宽 + service 校验/分流 + 路由三态解析 + 工具默认会话逻辑 + 终态回流挂钩）+ desktop 约 120 行（表单第三态 + 会话远程搜索下拉）+ admin 约 20 行 + mao-cli 约 30 行 + 契约/测试；**一次数据库迁移（V197）、零新依赖**
- 关联：`backend-ts/src/signal/`、`backend-ts/src/session/task-terminal.service.ts`、`shared/contracts/src/signal.ts`、`backend-ts/src/harness/tool/impl/signal-watcher-tools.ts`、`desktop/src/views/settings/{SignalWatchersView.vue,signal-watcher-form.ts,SignalWatchersView.layout.test.ts}`、`admin/src/views/signal/SignalWatcherListView.vue`、`skills/mao-cli/{lib/commands/signal-watcher.js,reference/signal-watcher.md}`

## 1. 需求背景

信号哨兵（`signal_watcher`，V148）当前触发方式两态（V174）：

- `NEW_SESSION`：每次变化新建会话（默认，会话落 `source='signal'` 独立分组）；
- `REUSE_SESSION`：复用本哨兵自己的会话——复用指针 `reuse_session_id` **由系统维护**（首次触发自动建会话并回写），用户不选择会话，路由层刻意不解析该字段（防伪造指向他人生效中的会话）。

问题：用户在会话中让 Agent 创建哨兵时（`create_signal_watcher` 工具没有触发方式入参，落库恒 `NEW_SESSION`），默认预期是「哨兵触发时回到当前这个会话继续」。预期落空的两类代价：

1. **桌面/Embed**：触发结果散落在「信号」分组的新会话里，用户如果不知道去任务面板翻，会以为哨兵没生效；
2. **飞书通道（最严重）**：飞书会话与信号分组的独立会话互不相通，且 SIGNAL 触发路径（`open-run.service.ts` → `runExecution`）只挂 `WsStreamingEventListener` 向 WS 推流，**不挂任何飞书/钉钉回流 listener、不回帖聊天、也不进收件箱**（飞书通道会话在 `task-terminal.service.ts:134` 恒不计未读、`:218` 跳过收件箱记录）——通道内对哨兵活动零感知。既有「运行完成 → 回帖通道」链路只服务定时任务（`scheduled-task.service.ts` 的 `sendFeishuReplyIfApplicable` / `pushFinalReplyIfApplicable`）与崩溃恢复（`create-app.ts:941`），webhook/API/SIGNAL 共用的 openRun 路径不经过它。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **数据模型**：V197 迁移——`signal_watcher` 加 `specified_session_id BIGINT NULL`（`SPECIFIED_SESSION` 模式的执行会话 id，用户/Agent 指定，保存时校验）；**同时把 `trigger_mode` 从 `VARCHAR(16)` 放宽到 `VARCHAR(32)`**（`'SPECIFIED_SESSION'` 实测 17 字符，V174 的 16 位宽在 MySQL 严格模式下直接报 `Data too long`）。
2. **契约三处同步**：`shared/contracts/src/signal.ts` 的 `SignalTriggerMode` 加 `'SPECIFIED_SESSION'`；后端 `SIGNAL_TRIGGER_MODES` 同步并按 `session.repository.ts:22-31` 范式补 `_AssertExhaustive` 双向穷尽断言（`satisfies` 只守「数组 ⊆ 契约」，反向漏加靠断言兜住）；desktop 与 admin 的 `Record<SignalTriggerMode, string>` 汉化表各加一项（漏改编译期即失败）。
3. **service 校验与触发分流**：`WatcherInput` 加 `specifiedSessionId` 三态入参；保存时校验目标会话（存在 + 归属 + 主会话 + CLOUD + Agent 匹配 + 未归档，复用 webhook-trigger `assertBindableSession` 语义并补归档拒绝）；`runCheck` 触发时按模式取目标会话——`SPECIFIED_SESSION` 预检失效**不降级新建**，以具体原因判触发失败计连败。
4. **Agent 内置工具默认当前会话**：`create_signal_watcher` 加可选 `trigger_mode` / `session_id`；未显式指定时，当前会话是合法触发目标（主会话 + CLOUD + 未归档）则默认 `SPECIFIED_SESSION` + 当前会话 id，否则回退 `NEW_SESSION`（存量行为）。结果 JSON 透出实际生效的 `trigger_mode` / `execute_session_id`。
5. **SIGNAL 触发的通道回流**：`TaskTerminalService.finishExecution` 在 `notifySource === 'SIGNAL'` 且 `COMPLETED` 时，复用 `ScheduledTaskService.pushFinalReplyIfApplicable` 把最终 ASSISTANT 回复推回飞书/钉钉通道会话（非通道会话 pusher 内部 no-op）。直跑（openRun → `liveSourceBindings`）与忙时排队（message_queue 行带 `source_type='SIGNAL'`，autoConsume 消费后同样以 `SIGNAL` 收尾）两条路径都经过该统一终态收尾点，一处挂钩全覆盖。webhook/API 触发的回流不在本方案（见 §2.2）。
6. **desktop UI**：触发方式 radio 第三态「指定会话」；选中后显示按 Agent 过滤的会话远程搜索下拉（复用 webhook 触发器 `/v1/sessions/search` 先例，注意该接口按**会话内消息内容**搜索且 keyword 必填，见 §4.8）；列表卡对指定模式显示「执行会话 #id」；`SignalWatchersView.layout.test.ts` 既有「表单不出现会话选择器」用例按新安全边界重写（必改，见 §4.11）。
7. **admin 展示**：触发方式汉化表加项；详情加「指定会话」行（只读，含跳转）。
8. **mao-cli**：`signal-watcher create/update` 加 `--session-id`（单传时 CLI 显式同步下发 `triggerMode: 'SPECIFIED_SESSION'`），`--trigger-mode` 白名单扩为三值；reference 文档同步。
9. **测试与文档**：service / 路由 / 工具 / 表单 / 回流回归用例；`changelog/unreleased/`、`skills/mao-cli/reference/signal-watcher.md` 同步。

### 2.2 非目标（明确不做）

1. **不改 `REUSE_SESSION` 语义**：复用指针仍系统维护、首触自建、失效自动清指针走新建；不开放用户提交 `reuseSessionId`。「用户选会话」与「系统自建复用」是两个语义，分开建模（§3.1 决策 1）。
2. **不做 `SPECIFIED_SESSION` 失效自动降级**：指定会话被删/归档后触发直接失败（具体文案 + 计连败 → 5 次自动停用收件箱通知），不静默改走新建——静默降级会重新制造「不可感知」这个本方案要解决的问题。
3. **不做 LOCAL 会话作为触发目标**：哨兵触发链路 CLOUD-only 既有约束不动（`open-run.service.ts` 拒绝 LOCAL，决策 13）；工具在 LOCAL 会话里创建时回退 `NEW_SESSION`。
4. **不做跨用户会话指定**：指定会话必须属于哨兵属主本人；归属不匹配与不存在统一按「不存在」报错，不泄露会话存在性（与 `open-run` / webhook 同口径）。
5. **不做 SIDE_TASK / SUBAGENT 会话指定**：开放触发仅支持主会话（既有校验），工具在边路会话里创建时回退 `NEW_SESSION`。
6. **不做微信通道回流与 webhook/API 触发回流**：本方案的回流挂钩只认 `notifySource === 'SIGNAL'`，推复用 `pushFinalReplyIfApplicable`（飞书 + 钉钉；微信的 `sendWeixinReplyIfApplicable` 需要 userId 且属定时任务私有链路，不扩展）。webhook/API 触发指定通道会话同样没有回流——若要补齐须新提案（涉及来源语义与重复推送评估）。桌面可见性不依赖回流：非通道会话的任务面板 / WS 推流既有能力天然覆盖。
7. **不做归档会话的触发放行**：归档会话在任务面板「已归档」专区，用户看不到运行活动，往里触发等于静默烧额度（与 `isReusableSession` 对 ARCHIVED 的判定一致）。

## 3. 技术选型与决策

### 3.1 决策表

| 决策点 | 定案 | 理由 / 证据 |
|---|---|---|
| 建模方式 | 新增第三种触发方式 `SPECIFIED_SESSION` + 独立列 `specified_session_id`；不复用 `reuse_session_id` | 两列生命周期规则相反：复用指针系统维护（失效清空重建、`REUSE→NEW→REUSE` 往返即重置入口、路由不解析）；指定会话用户锚定（失效显式失败、编辑沿用、路由解析后服务端校验归属）。混用一列会让 `update` 的指针维护逻辑（`watcher.service.ts:331-337`）与「路由不解析」约定（`watcher.routes.ts:76`）互相打架，且展示口径（复用指针 vs 用户指定）无法区分 |
| 列宽 | V197 同时 `MODIFY COLUMN trigger_mode VARCHAR(32) NOT NULL DEFAULT 'NEW_SESSION'` | `'SPECIFIED_SESSION'.length === 17`，V174 的 `VARCHAR(16)` 在 MySQL8 严格模式写入即报 `Data too long for column`；MODIFY 保留默认值与注释，存量值不受影响 |
| 失效策略 | 触发时预检失效 → 判触发失败（error 记具体原因，计连败走既有退避/自动停用），不降级新建 | 指定模式的核心诉求是可感知性；降级新建 = 静默回到用户抱怨的原状。失败可见链路已有：轮询记录 error 文案 + 5 连败自动停用 + 收件箱通知（`WATCHER_DISABLE_AFTER_FAILURES = 5`） |
| 保存时校验 | `assertSpecifiedSession(userId, sessionId, agentId)`：存在（含归属，不匹配按不存在）→ 非边路 → 非 LOCAL → agentId 匹配 → 非 ARCHIVED，逐项给具体文案 | 与 webhook-trigger `assertBindableSession`（`webhook-trigger.service.ts:315-330`）同款语义，多一项 ARCHIVED 拒绝（哨兵周期性触发比 webhook 单次触发更依赖会话在任务面板的可见性；且 `openRun` 不拒 ARCHIVED，此项必须自兜）。保存时校验把错误前置到表单，而不是等轮询失败 |
| 触发时预检 | `runCheck` 内、`openRun.run` 之前用同一 `assertSpecifiedSession` 再验一次；读取源一律用触发前重读的 `fresh` 行（与 REUSE 分支同口径） | 保存到触发之间会话可能被删/归档、用户也可能在探针在途的 10~15 秒内切模式/改绑（`watcher.service.ts:650-676` 既有注释明确要求用 `fresh`）；预检异常在既有 try 内被捕获 → 走触发失败口径（`markCheckError` + `recordFailure`），不新增失败路径 |
| 通道回流挂点 | `TaskTerminalService.finishExecution`：`notifySource === 'SIGNAL' && phase === 'COMPLETED'` 时调用可选注入的回流函数（实现 = `scheduledService.pushFinalReplyIfApplicable`） | 该函数是直跑与排队两条 SIGNAL 路径的统一终态收尾点（直跑经 `liveSourceBindings` 传 source，排队经队列行 `source_type` → `queueSettlements` 传 source，见 `streaming-ws-handler.ts:388-396, 950-965`）；`pushFinalReplyIfApplicable`（`scheduled-task.service.ts:1358`）已按 `isFeishuChannelSession`/钉钉判定 no-op、取最终 ASSISTANT 回复、失败只记日志。挂在 openRun 直跑返回后只能覆盖直跑、漏忙时排队；挂在 runExecution 里则要动 WS 域且与三个 finisher 的来源传递重复。`SCHEDULED` 来源不触发该挂钩（定时任务已自有推送），无重复回帖 |
| 回流装配 | setter 晚绑定（`taskTerminal.setSignalChannelReplyPusher(...)`，装配于 `app-session-services.ts` 创建 `scheduledService` 之后） | 与 `scheduledService.setFailureNotifier` / `setFeishuResultPusher`（`scheduled-task.service.ts:377`）同款模式；`scheduledService` 创建在 `taskTerminal` 之后，构造参数注入需要反向排序，setter 免重构装配顺序 |
| 会话下拉数据源 | 复用 `GET /v1/sessions/search`（`session.routes.ts:278-296`）+ `agentId` 过滤参数 + `sessionType=NORMAL`，remote 搜索；**空关键词不发请求**（该接口空关键词直接抛 `PARAM_MISSING`，`session.service.ts:873-875`），placeholder 注明「按会话内消息内容搜索」 | webhook 触发器桌面端已用同一接口做「绑定会话」下拉（`OpenApiView.vue:230-260, 495-516`，靠 catch 吞错把空关键词变成空选项）；哨兵下拉沿用同一先例但把「keyword 必填、搜索对象是消息内容」的语义显式告知用户，不让用户以为是按标题搜 |
| Agent 工具默认值 | 工具代码内判定（非模型推断）：当前会话为主会话且 CLOUD 且未归档 → 默认 `SPECIFIED_SESSION` + 当前会话；否则 → `NEW_SESSION` | 模型不知道会话的 `executionMode`/`sessionType`，让模型推断会在 LOCAL 会话里选出必然失败的配置；工具已查当前会话（`resolveUserWithAgent`），扩展返回值即可判定。回退不静默：结果 JSON 与 message 都写明实际生效的方式 |
| 指定会话的复制继承 | `copyFrom` 时桌面表单预填继承 `specifiedSessionId`（服务端照常校验）；`applyCopyInheritance` 服务端继承面维持 headers/body 不变 | 指定会话是用户显式选择（与系统维护的复用指针相反），桌面表单继承合理且安全（同一属主 + 服务端再校验）；服务端 `applyCopyInheritance`（`watcher.service.ts:1081-1096`）只解密继承敏感值，会话 id 属明文结构性字段随入参走，无需改服务端。mao-cli 的 `--copy-from` 不带 `--session-id` 时副本为 `NEW_SESSION`（CLI 无表单预填），reference 文档写明 |
| 基线影响 | `specifiedSessionId` **不进** `AFFECTS_BASELINE` | 切换执行会话不改变判定值（探针对象不变），不清基线、不清 `last_checked_at`；与 `triggerMode` 既有处理一致 |
| agentId 变更时的指定会话 | 严格报错，不静默清列降级：编辑改 agentId 且模式仍为 `SPECIFIED_SESSION` 时，用**归一化后的 agentId** 校验库值/入参，不匹配 → 报「指定会话需属于该 Agent，请重新选择」 | 静默清列会触发「必须选择执行会话」的另一个错，用户反而看不到根因；严格校验让用户一次改对 |
| 入参三态口径 | `specifiedSessionId` 与 `scriptPath` 同口径：键未下发（undefined）= 编辑沿用库值；`null` = 显式清空；数字 = 指定。非 `SPECIFIED_SESSION` 模式时服务端单侧归空（normalize 强制 null） | 沿用 V189 三态先例（`watcher.routes.ts:73`、`watcher.service.ts:297`）；单侧归空防双字段语义漂移（库里非指定模式恒无会话 id），切模式后服务端自动清列，前端无需发 `null` |

## 4. 实现步骤

### 4.1 迁移 V197

`backend-ts/db/migration/V197__signal_watcher_specified_session.sql`：

```sql
-- 信号哨兵指定执行会话（docs/plan/2026-11/2026-11-17-signal-watcher-specified-session-technical-design.md §4.1）。
-- specified_session_id 为 SPECIFIED_SESSION 模式的执行会话 id：用户/Agent 指定，保存时校验
-- （存在 + 归属 + 主会话 + CLOUD + Agent 匹配 + 未归档）；与系统维护的 reuse_session_id 分列建模。
-- trigger_mode 放宽到 32：'SPECIFIED_SESSION' 实测 17 字符，V174 的 VARCHAR(16) 严格模式写入即报错。
ALTER TABLE `signal_watcher`
  ADD COLUMN `specified_session_id` BIGINT NULL
    COMMENT 'SPECIFIED_SESSION 模式的执行会话 id（用户/Agent 指定，保存时校验；失效触发判失败不降级新建）',
  MODIFY COLUMN `trigger_mode` VARCHAR(32) NOT NULL DEFAULT 'NEW_SESSION'
    COMMENT '触发方式：NEW_SESSION=每次新建会话，REUSE_SESSION=复用本哨兵自己的会话，SPECIFIED_SESSION=指定执行会话';
```

存量哨兵全部 NULL 且 `trigger_mode` 值不变，零行为变化。

### 4.2 契约与后端类型

- `shared/contracts/src/signal.ts`：`SignalTriggerMode` 加 `'SPECIFIED_SESSION'`，注释更新（三态语义与失效策略）。
- `backend-ts/src/signal/types.ts`：`SIGNAL_TRIGGER_MODES` 加 `'SPECIFIED_SESSION'`；照 `session.repository.ts:22-31` 范式补双向穷尽——`as const satisfies readonly SignalTriggerMode[]` 守「数组 ⊆ 契约」，`type _AssertExhaustive = Exclude<SignalTriggerMode, typeof SIGNAL_TRIGGER_MODES[number]> extends never ? true : never` 守「契约 ⊆ 数组」；`SignalWatcher` 接口加 `specifiedSessionId: number | null`（列注释指回方案）。

### 4.3 service（`watcher.service.ts`）

1. **`WatcherInput`** 加 `specifiedSessionId?: number | null`（注释写清三态）。
2. **`assertSpecifiedSession(userId, sessionId, agentId)`**（私有，保存与触发双侧共用）：基于既有 `deps.getSession`。逐项校验并抛 `BusinessException`：
   - `getSession` 抛 `SESSION_NOT_FOUND` 或返回 null 或 `userId` 不匹配 → `SESSION_NOT_FOUND`「指定的会话不存在」；
   - `sessionType` 为 `SUBAGENT`/`SIDE_TASK` → 「指定会话仅支持主会话」；
   - `executionMode === 'LOCAL'` → 「指定会话仅支持云端执行会话」；
   - `agentId !== watcher.agentId` → 「指定会话需属于该哨兵的 Agent」；
   - `status === 'ARCHIVED'` → 「指定会话已归档，请先恢复或重新选择」。
   - 其它异常上抛（库瞬断不作「失效」误判，与 `isReusableSession` 注释口径一致）。
3. **`normalizeInput`**：
   - `triggerMode` 白名单自然扩展（错误文案改「触发方式仅支持 NEW_SESSION/REUSE_SESSION/SPECIFIED_SESSION」）；
   - 新参 `specifiedSessionId` 校验：非 `SPECIFIED_SESSION` 模式 → 归 `null`；`SPECIFIED_SESSION` 模式 → 必须为正整数（`null`/缺省在 update 合并后仍空时报「指定会话模式必须选择执行会话」）。
   - 返回类型加 `specifiedSessionId: number | null`。
4. **`create`**：合并 `copyFrom` 继承后，`SPECIFIED_SESSION` 时调 `assertSpecifiedSession`，通过后随 `insert` 落 `specifiedSessionId`（非指定模式落 null）。
5. **`update`**：`merged` 补 `specifiedSessionId: input.specifiedSessionId !== undefined ? input.specifiedSessionId : existing.specifiedSessionId ?? null`（与 `scriptPath` 同口径）；`normalizeInput` 归一后，`SPECIFIED_SESSION` 时以**归一化后的 agentId** 调 `assertSpecifiedSession`；patch 写 `specifiedSessionId: normalized.specifiedSessionId`。`reuseSessionId` 既有维护逻辑不动。
6. **`runCheck`** 触发段重构（`watcher.service.ts:676-706`，读取源一律用触发前重读的 `fresh` 行，与 REUSE 分支既有口径一致）：
   ```
   fresh.triggerMode === 'REUSE_SESSION'：现行为原样保留
     （fresh.reuseSessionId 失效 → 清指针 → target=null 走新建，成功后回写指针）
   fresh.triggerMode === 'SPECIFIED_SESSION'：
     fresh.specifiedSessionId 为 null → 抛「指定会话模式未配置执行会话」；
     否则 assertSpecifiedSession(watcher.userId, fresh.specifiedSessionId, watcher.agentId) 预检
     （异常自然落入既有 try/catch 触发失败口径）；
     预检通过 → openRun.run({ sessionId: fresh.specifiedSessionId })；**不回写任何指针列**
   ```
   `effectiveReuseId` 回写判据仅剩 REUSE 分支使用，SPECIFIED 分支不触碰。
7. **`toView`** 透出 `specifiedSessionId`（`SignalWatcherView` 加字段，注释「只读展示」）。

### 4.4 路由（`watcher.routes.ts`）

`toInput` 解析 `specifiedSessionId`：`'specifiedSessionId' in body` 时，null → `null`，正整数 → 数值，其它 → `PARAM_INVALID`；未下发 → `undefined`。`reuseSessionId` 刻意不解析的注释保留并补充「指定会话走 specifiedSessionId，服务端校验归属」。

### 4.5 仓库（`signal.repository.ts`）

`insert` 与 `update` 各加 `specifiedSessionId` 一行（与 `reuseSessionId` 同款位置）。`SELECT *` 读侧零改动（Db 层 snake→camel 自动映射）。

### 4.6 Agent 工具（`signal-watcher-tools.ts`）

1. **`resolveUserWithAgent`** 扩展为返回 `{ userId, agentId, session }`（session 含 `id/sessionType/executionMode/status`），供默认值判定。
2. **`CreateSignalWatcherTool`**：
   - schema 加 `trigger_mode`（enum 三值，描述「缺省时自动选择：当前会话可作触发目标则指定当前会话，否则每次新建」）与 `session_id`（正整数，描述「SPECIFIED_SESSION 模式的执行会话，缺省=当前会话」）；
   - 生效逻辑（工具内判定，模型无需感知 LOCAL/边路）：
     ```
     显式 trigger_mode=NEW_SESSION/REUSE_SESSION → 照用
     显式 trigger_mode=SPECIFIED_SESSION → session_id ?? 当前会话 id（都无 → errorJson）
     未显式 trigger_mode 但传了 session_id → SPECIFIED_SESSION + 该 id
     都未传 → 当前会话为主会话 && CLOUD && 非归档 ? SPECIFIED_SESSION+当前会话 : NEW_SESSION
     ```
   - 服务端校验失败（如归属/归档）原样返回 errorJson——模型可据此提示用户在 UI 里改，不二次兜底重试；
   - 结果 JSON 加 `trigger_mode`、`execute_session_id`（`SPECIFIED_SESSION` 时为会话 id，其余 null）；`message` 按模式分流：指定模式写「变化时将在会话 #N 中执行；飞书/钉钉通道会话的回复会推回聊天，其余会话在任务面板可见」。
3. **`getToolPrompt`** 增补：默认在当前会话触发的说明（用户说「在我这个会话里盯…」时无需传 trigger_mode/session_id）；LOCAL / 边路会话回退 `NEW_SESSION` 的说明；「提示词模板必须自包含」约束对指定会话模式同样成立（会话上下文长期存在，但不要引用临时文件路径）。
4. `no-progress-notice` 不动（`watcher_id` / `execute_session_id` 均为语义 id，非随机 id）；`toolDisplay.ts` 参数预览维持 name 口径不动。

### 4.7 SIGNAL 触发的通道回流（`task-terminal.service.ts` + 装配）

1. **`TaskTerminalService`** 加可选依赖与 setter（模式对齐 `scheduledService.setFailureNotifier`）：
   ```ts
   /** SIGNAL 触发完成后的通道回流依赖（可选注入）：非通道会话由实现内部 no-op。 */
   export interface SignalChannelReplyPusher { pushFinalReply(sessionId: number): Promise<void>; }
   ```
   `finishExecution` 末尾（终态 WS 事件之后，失败仅记日志不影响终态链）：`notifySource === 'SIGNAL' && phase === 'COMPLETED'` 时 fire-and-forget 调用 `pusher.pushFinalReply(sessionId)`。
2. **装配（`app-session-services.ts`）**：创建 `scheduledService` 之后
   `taskTerminal.setSignalChannelReplyPusher({ pushFinalReply: (id) => scheduledService.pushFinalReplyIfApplicable(id) })`。
   `pushFinalReplyIfApplicable`（`scheduled-task.service.ts:1358`）内部取最终 ASSISTANT 回复、按 `isFeishuChannelSession`/钉钉判定、非本渠道 no-op、推送失败只记日志——全部复用，不改推送实现。
3. **不重复回帖**：`SCHEDULED` 来源不触发挂钩（定时任务完成路径已自有 `sendFeishuReplyIfApplicable` 调用）；webhook/API 来源不触发（§2.2-6）。飞书/钉钉入站会话自带的卡片 listener 只挂在其入站发起的执行上，与 SIGNAL 触发的执行互斥，无双推。

### 4.8 desktop

1. **`signal-watcher-form.ts`**：
   - `TRIGGER_MODE_LABELS` 加 `SPECIFIED_SESSION: '指定会话'`（Record 穷尽，漏项编译失败）；
   - `SignalWatcherForm` 加 `specifiedSessionId: number | null`；`copyFormFromView` 继承该字段；
   - `buildWatcherPayload`：仅 `SPECIFIED_SESSION` 且已选时下发 `specifiedSessionId`；其它模式不下发（服务端单侧归空清列）。
2. **`SignalWatchersView.vue`**：
   - 触发方式 radio 加第三态；选中时显示 `el-select`（`filterable remote clearable` + `remote-method`），选项来自 `searchSessions(keyword, { agentId: form.agentId, sessionType: 'NORMAL' })`，label 为会话标题、value 为 id（webhook `OpenApiView.vue:230-260` 同款交互）；**空关键词不发请求**（该接口 keyword 必填，空则 `PARAM_MISSING`），placeholder 注明「按会话内消息内容搜索目标会话」；编辑（`openEditDialog`）与复制（`copyFormFromView`）两条回显路径都要预填 `specifiedSessionId` 与选项 `[{ id, title: '#id' }]`；
   - `watch(agentId)`：变更时清空 `specifiedSessionId` 与已加载选项（会话必须属于所选 Agent），触发方式为指定模式时提示重选；
   - `canSubmit`：`SPECIFIED_SESSION` 时要求 `specifiedSessionId != null`；
   - 列表卡 meta：`SPECIFIED_SESSION` 且有 id 时显示「执行会话 #id」（可点击跳任务面板，与轮询记录的会话链接同款）；
   - 触发方式 field-hint 文案补「指定会话」一句：被删/归档后触发会失败并计入连败。
3. **`desktop/src/api/index.ts`**：`SignalWatcherView` 加 `specifiedSessionId: number | null`；`SignalWatcherInput` 加 `specifiedSessionId?: number | null`（注释三态）。

### 4.9 admin

`SignalWatcherListView.vue`：`TRIGGER_MODE_LABELS` Record 加 `SPECIFIED_SESSION: '指定会话'`；行类型与详情描述加「指定会话」行（`triggerMode === 'SPECIFIED_SESSION'` 时显示 `#id`，复用 REUSE 行的 `goSession` 跳转先例 `:127-129`）；列表视图类型补字段。admin 只读，无表单改动。

### 4.10 mao-cli

- `skills/mao-cli/lib/commands/signal-watcher.js`：`TRIGGER_MODES` 扩为三值；`create`/`update` 加 `--session-id`（正整数）；**单传 `--session-id` 不传 `--trigger-mode` 时 CLI 显式同步下发 `triggerMode: 'SPECIFIED_SESSION'`**——否则后端按「键未下发沿用库值」合并，`normalizeInput` 会把指定会话单侧归空静默丢弃；update 的「至少一个待修改字段」校验补 `--session-id`。
- `skills/mao-cli/reference/signal-watcher.md`：API 表、create 参数段、复用指针段落各补指定会话说明（含失效策略：触发失败计连败，不自动降级；`--copy-from` 复制指定模式哨兵时服务端不继承会话 id，副本须显式 `--session-id` 重指定）。

### 4.11 测试

- `watcher.service.spec.ts`：
  1. create `SPECIFIED_SESSION` + 合法会话 → 落库；
  2. create 缺 `specifiedSessionId` / 非正整数 → PARAM_INVALID；
  3. create 会话归属他人 / 边路 / LOCAL / agent 不匹配 / ARCHIVED → 各自文案；
  4. update 切出指定模式 → 列清空；切回未重选 → PARAM_INVALID；
  5. update 改 agentId 而会话属旧 Agent → 报错文案；
  6. `runCheck` 指定模式 → `openRun.run` 收到 `fresh` 行的指定 sessionId，指针列不动；
  7. `runCheck` 指定会话已删/归档 → 触发失败计连败、check error 文案具体、无新会话创建、不回写指针；
  8. 并发边界：探针在途期间切走 `SPECIFIED_SESSION` / 改绑会话 → `runCheck` 以 `fresh` 行为准，不按开头快照的旧值触发；
  9. 改绑有效会话 + `setStatus ACTIVE` 重新启用 → 连败清零、基线重建（既有口径回归）。
- `task-terminal` 回流用例：`notifySource='SIGNAL' && COMPLETED` → pusher 被调；`SCHEDULED`/`WEBHOOK`/`MANUAL` 或 FAILED/CANCELLED → 不调；pusher 抛错 → 仅记日志不影响终态。
- `watcher.routes.spec.ts`：`toInput` 三态解析（未下发/显式 null/数字/非法值）。
- `signal-watcher-tools.spec.ts`：
  1. 当前会话主会话 + CLOUD → 默认 `SPECIFIED_SESSION` + 当前会话；
  2. 当前会话 LOCAL / SIDE_TASK → 回退 `NEW_SESSION`；
  3. 显式 `trigger_mode=REUSE_SESSION` → 照用、不带 session；
  4. 显式 `session_id`（未传 trigger_mode）→ `SPECIFIED_SESSION`；
  5. 结果含 `trigger_mode` / `execute_session_id`、message 文案分流。
- `desktop/src/views/settings/signal-watcher-form.test.ts`：payload 组装（指定模式下发 id / 其它模式不下发 / 复制继承）。
- `desktop/src/views/settings/SignalWatchersView.layout.test.ts`（**必改**）：既有「表单不出现会话选择器」用例（`:122-134` 断言不含 `sessionId` 子串、不出现「选择会话/指定会话」文案）与第三态正面冲突——重写为新的安全边界表述：选择器只列本人会话（`agentId` 过滤 + 服务端 `assertSpecifiedSession` 归属校验接住越权面）、不出现 `reuseSessionId` 提交入口；补第三态 radio 断言。
- mao-cli：如该包有测试则补 `--session-id` 单传隐含 `SPECIFIED_SESSION` 的用例。
- 构建验证：`cd backend-ts && npm run build && npm test`；`cd desktop && npm run build`；`cd admin && npm run build`（vue-tsc -b，Record 穷尽由编译期兜底）。

### 4.12 文档与 CHANGELOG

- `changelog/unreleased/2026-11-17-signal-watcher-specified-session.md`：后端 / 管理后台 / 前端（桌面 / Web / 安卓）/ 终端 CLI（mao-cli）四节；
- `skills/mao-cli/reference/signal-watcher.md`（§4.10）；`USER_GUIDE.md` 哨兵章节如涉及触发方式则补一句（实施时核对）。

## 5. 落地清单

| 层 | 文件 | 改动 |
|---|---|---|
| 迁移 | `backend-ts/db/migration/V197__signal_watcher_specified_session.sql` | 新增（1 列 + trigger_mode 放宽到 32） |
| 契约 | `shared/contracts/src/signal.ts` | `SignalTriggerMode` 加成员 + 注释 |
| 后端 | `backend-ts/src/signal/types.ts` | 常量/接口加字段 + `_AssertExhaustive` |
| 后端 | `backend-ts/src/signal/watcher.service.ts` | Input/view 字段、`assertSpecifiedSession`、normalize/create/update/runCheck 分流 |
| 后端 | `backend-ts/src/signal/watcher.routes.ts` | `toInput` 三态解析 |
| 后端 | `backend-ts/src/signal/signal.repository.ts` | insert/update 加列 |
| 后端 | `backend-ts/src/session/task-terminal.service.ts` | `SignalChannelReplyPusher` 依赖 + setter + SIGNAL 完成回流 |
| 后端 | `backend-ts/src/app-session-services.ts` | setter 装配（→ `pushFinalReplyIfApplicable`） |
| 后端 | `backend-ts/src/harness/tool/impl/signal-watcher-tools.ts` | schema + 默认会话逻辑 + prompt |
| 后端 | `backend-ts/src/signal/watcher.service.spec.ts` 等 spec + 终态回流用例 | 新用例 |
| desktop | `desktop/src/api/index.ts` | View/Input 类型 |
| desktop | `desktop/src/views/settings/signal-watcher-form.ts` | label/form/payload |
| desktop | `desktop/src/views/settings/SignalWatchersView.vue` | 第三态 radio + 会话下拉 + 列表展示 |
| desktop | `desktop/src/views/settings/SignalWatchersView.layout.test.ts` | 重写会话选择器安全边界用例（必改） |
| admin | `admin/src/views/signal/SignalWatcherListView.vue` | label + 详情行（含跳转） |
| CLI | `skills/mao-cli/lib/commands/signal-watcher.js` | `--session-id`（单传隐含指定模式）+ 三值枚举 |
| CLI | `skills/mao-cli/reference/signal-watcher.md` | 参数与失效策略说明 |
| CHANGELOG | `changelog/unreleased/2026-11-17-signal-watcher-specified-session.md` | 新增 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户删掉指定会话后哨兵反复触发失败直至停用 | 属预期行为：轮询记录 error 文案具体（「指定会话不存在」），5 连败自动停用 + 收件箱通知，用户可改绑后重新启用（重启用清零连败并重建基线，既有口径）；基线 hash 已推进（既有触发失败路径），不会重复触发刷量 |
| 飞书群聊会话与线程的对应关系复杂（群聊按 chat 建会话），指定群聊会话后回流回复在群内可见范围可能超出预期 | 属通道既有行为（任何在该会话内的运行都同样可见）；提示词模板自包含约束 + 表单 hint 提醒「触发内容将在所选会话的通道内可见」 |
| `/v1/sessions/search` 按消息内容搜索且 keyword 必填，下拉空态可能让用户误以为没有会话 | 未输入关键词不发请求 + placeholder 注明「按会话内消息内容搜索」；不在本方案扩 search 接口（标题搜索/LOCAL/归档过滤须新提案）；LOCAL/归档会话被选中由保存时 `assertSpecifiedSession` 拦截并给具体文案（webhook 先例同姿态） |
| 回流推送与飞书入站卡片链路重复推送 | 入站卡片 listener 只挂在入站发起的执行（`active-progress` 仅入站 bind）；挂钩只认 `notifySource='SIGNAL'`，与 `SCHEDULED`（自有推送）互斥，无重叠 |
| 工具在 LOCAL 会话回退 `NEW_SESSION` 与用户「在当前会话执行」的口头预期不符 | 回退非静默：结果 JSON 与 message 写明实际方式；tool prompt 告知模型主动向用户说明原因（LOCAL 会话无法被服务端触发） |
| `specifiedSessionId` 与 `agentId` 的合并校验在编辑态边界（未下发=沿用库值）出错 | 用例 4/5 覆盖：以归一化后的 agentId 校验合并值；文案指明「重新选择」 |
| Record 穷尽漏改导致 admin/desktop 编译失败 | 属预期防线（AGENTS.md 契约规范），`vue-tsc -b` 构建期暴露，两端同步改 |
| `TaskNotifySource` 直跑/排队两条路径 source 传递若有遗漏（排队行 source_type 落库/回读） | 实现时先写回流用例验证两条路径；若排队路径 source 缺失，修 `queueSettlements` 的来源回读（`streaming-ws-handler.ts:950-965` 已有读取逻辑，预期仅需断言） |

## 7. 测试要点

除 §4.11 用例清单外，重点手测链路：

1. 桌面 UI：新建 → 指定会话 → 下拉按 Agent 过滤（输入消息关键词）→ 保存 → 列表卡显示「执行会话 #id」→ 轮询变化触发后运行落在所选会话；
2. 会话内创建：在 CLOUD 主会话让 Agent「创建一个盯 xxx 的哨兵」→ 默认指定当前会话（结果 JSON 可见 `execute_session_id`）；在 LOCAL 会话重复 → 回退 `NEW_SESSION` 且回复说明原因；
3. 飞书回流：绑定飞书 Bot 的会话里创建哨兵 → 变化触发、运行完成后**飞书聊天收到最终回复**；会话忙（正与 Bot 对话）时触发 → 排队消费完成后同样回流；
4. 失效路径：删掉指定会话 → 下一轮变化触发失败，轮询记录文案「指定会话不存在」，5 轮后自动停用收件箱可见；
5. 归档路径：归档指定会话 → 触发失败文案「指定会话已归档」；
6. 编辑改 Agent → 指定会话校验报错，重新选择后保存成功；
7. 桌面非通道会话：指定桌面 CLOUD 会话 → 触发运行落任务面板（无聊天回流，属预期）。

## 8. 决策记录

1. **三态建模而非扩 REUSE**：`REUSE_SESSION` 的指针维护逻辑（失效清空、往返重置、路由不解析）与「用户锚定」语义冲突，分列 + 新枚举值是改动最小且不破坏存量的方案；`SignalTriggerMode` 两端 `Record` 穷尽 + 后端 `_AssertExhaustive` 三处编译期强制同步。
2. **失效不降级**：本需求的核心是可感知性，任何静默改道（新建会话）都会复现原始问题；触发失败 + 连败 + 自动停用通知是既有的、用户可见的失败链路。
3. **工具默认值在代码而非模型**：会话是否可作为触发目标取决于 `sessionType`/`executionMode`/`status`，模型无从得知；工具已在会话上下文里，代码判定一次到位，模型只透传用户显式指定的 `trigger_mode`/`session_id`。
4. **保存时严格校验（含 ARCHIVED）**：错误前置到表单，避免「保存成功但永远不触发」的静默故障；ARCHIVED 拒绝与 `isReusableSession` 口径一致（归档会话的活动在任务面板不可见），且 `openRun` 不拒 ARCHIVED，必须自兜。
5. **回流挂在终态收尾点而非 openRun/WS 执行器**（评审定案）：`finishExecution` 是直跑与忙时排队两条 SIGNAL 路径的共同终点且已带来源；openRun 直跑返回后推送会漏掉排队路径，改 WS 执行器则侵入三个 finisher 的来源传递。复用 `pushFinalReplyIfApplicable` 零新推送实现，`SCHEDULED`/`WEBHOOK`/`API` 来源不触发挂钩，无重复回帖。
6. **`trigger_mode` 列宽随本迁移放宽**（评审定案）：新枚举值 17 字符超出 V174 的 16 位宽，严格模式写入即失败；MODIFY 保留默认值，存量零影响。
