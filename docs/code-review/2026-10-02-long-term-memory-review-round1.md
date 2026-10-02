# 代码审查报告：跨会话长期记忆（Memory 层）Round 1

- 日期：2026-10-02
- 审查范围：工作区未提交变更（长期记忆功能全量：V129/V130 迁移、backend-ts/src/memory/ 域、task-terminal 挂点、harness 注入链、settings、admin 审计页、desktop MemoryView、E2E 用例）
- 评审基准：`docs/plan/2026-10-02-long-term-memory-technical-design.md`（重点对照第 3 节 D1–D12 与第 5 节详细设计）
- 验证手段：逐文件走读 + 关键依赖源码核对（Db/mysql2、AgentExecutor、MysqlLlmModelRepository、isFeishuChannelSession、feishu 群 key 生成、handleError 等）+ `npm run build`（通过）+ `npm test`（234 files / 2523 tests 全部通过）+ desktop/admin `vue-tsc -b`（均通过）

## 结论总览

功能逻辑总体正确，未发现高/中级别的功能性 bug。D1–D12 逐条核对均符合方案：触发条件（仅 COMPLETED、排除 SUBAGENT/SIDE_TASK）、抽取输入（最后一轮 USER+最后一条非空 ASSISTANT）、<20 字短路、模型回落链、DISMISSED 不复活 / DELETE 允许重插、编辑不改 status、200 条限额（创建路径）与注入 USER 8 / PROJECT 12 截断、机器人渠道项目键降级、同会话进程内互斥、注入查询失败降级不阻断会话启动、跨用户越权一律 404、admin 只读 + `memory:read` 权限码均按方案落地。

以下为发现的低级别问题与待确认项。

---

## 问题清单

### 问题 1（低）：DISMISSED → ACTIVE 恢复未校验 200 条 ACTIVE 上限

- 文件：`backend-ts/src/memory/memory.service.ts:131-136`（`update()` 的 status 分支）；对照 `assertActiveLimit`（:251-256）仅在 `create()`（:94）被调用
- 问题：方案 D7 约定「每用户 ACTIVE 状态记忆总量 ≤ 200 条」，但恢复（DISMISSED → ACTIVE）路径不做限额检查。
- 复现/触发条件：用户 ACTIVE 记忆已达 200 条 → 忽略某条（199）→ 新增 1 条（回到 200）→ 再「恢复」先前忽略的另一条 → ACTIVE 总量 201，突破上限。
- 影响：上限被小幅击穿；注入端有 8/12 条截断兜底，实际危害很小。
- 建议修复方向：在 `update()` 将 status 从 DISMISSED 切为 ACTIVE 时复用 `assertActiveLimit(userId)`（恢复成功后仍需 ≤200）。

### 问题 2（低）：手工 create/update 的唯一键并发冲突未转换为业务错误码

- 文件：`backend-ts/src/memory/memory.service.ts:96-109`（create 的 findByHash→insert 窗口）、`:126-139`（update 的 findByHash→updateContent 窗口）
- 问题：去重检查与写入之间存在竞态窗口。并发同内容插入时，后到一方撞 `uk_memory_dedup` 唯一键，抛出原始 mysql2 错误（errno 1062）。抽取路径已有 `isDuplicateKeyError`（memory.repository.ts:6-8）处理同况，手工路径没有。
- 复现/触发条件：同一用户两个端（或双击+重试）几乎同时提交相同内容；一方收到 HTTP 500 / `INTERNAL_ERROR(5001)`（`handleError` 兜底，http-error.ts:81-82），而非友好的 `MEMORY_CONTENT_DUPLICATE(3035)`。
- 建议：create/update 捕获唯一键冲突后转 `ErrorCode.MEMORY_CONTENT_DUPLICATE`（或重查后按语义返回）。

### 问题 3（低）：手工新增 PROJECT 级记忆时，飞书群聊 key 不会被拦截，产生永不注入的"死"记忆

- 文件：`backend-ts/src/memory/memory.service.ts:228-240`（`parseProjectKey` → `isRobotChannelProjectKey(key, null)`，:49-52）；根因在 `backend-ts/src/harness/tool/feishu-channel-tool.ts:13-15`
- 问题：飞书私聊 key（`feishu-{accountId}-private-{userId}`）可被正则识别，但群聊 key 是 `feishu-chat-{accountId}-{chatId}`（create-app.ts:1176），其机器人判定依赖 workspace 含 `/feishu-chat/`。手工创建路径 workspace 传 null，群 key 穿透校验。
- 复现/触发条件：直接调 `POST /api/v1/memory` 传 `scope=PROJECT, projectKey="feishu-chat-3-oc_xxx"`（前端项目下拉来自 `listProjectKeyRows`，携带真实 workspace 会正确排除，故只能经 API 触发）。该记忆创建后，注入查询 `listForInjection` 用会话真实 workspace 判定为机器人渠道，永远不注入。
- 建议：`parseProjectKey`（或 `isRobotChannelProjectKey`）对 `feishu-chat-` 前缀补一条与 task-terminal 判定对齐的规则；顺带可给 `memory.service.spec.ts:82` 的用例补群 key 断言。

### 问题 4（低）：update() 中 status 切换与 content 写入为两条独立 SQL、无事务，失败时状态已被部分修改

- 文件：`backend-ts/src/memory/memory.service.ts:131-139`（先 `updateStatus` 后 `updateContent`）
- 问题：同一请求同时携带 content 与 status 时，status 先落库；随后 content 写入若失败（如并发撞唯一键，见问题 2），接口报错但 status 已被切换，前端展示与库内状态不一致，也无回滚。
- 复现/触发条件：同一请求双写 + 写 content 阶段出现并发冲突/DB 异常。窗口很窄。
- 建议修复方向：调换顺序（先写 content 后切 status），或用 `db` 事务包裹两步（域内已有事务用法先例，如 harness-service 的 tx）。

### 问题 5（低）：memoryExecutor（agentExecutor.submit）饱和时同步抛出，会沿 finishExecution 向上传导

- 文件：`backend-ts/src/session/task-terminal.service.ts:110`（`this.memoryExecutor(...)` 无 try-catch）；注入点 `backend-ts/src/create-app.ts:866` 附近（`(fn) => agentExecutor.submit(fn)`）
- 问题：`createAgentExecutor` 的 `submit` 在池饱和（active=max 且 queue 满）时同步抛 `AgentExecutorRejectedError`（agent-executor.ts:54）。该异常会从 `dispatchMemoryExtraction` 传播出 `finishExecution`，而此时 phase 已更新、WS 事件已发，调用方（streaming-ws-handler / scheduled-task / dingtalk / weixin / crash-recovery）会为一个已终态的会话收到异常。默认配置 core=20 / max=100 / queue=200，触发门槛很高；且同类先例 notificationExecutor 的 submit 抛错发生在 void 掉的 `.then()` 链内，路径不同。
- 建议：`dispatchMemoryExtraction` 内对 `this.memoryExecutor(...)` 调用包一层 try-catch 记日志即可。

### 问题 6（低）：admin 审计页回退显示 `#undefined`；本地接口类型声明与后端返回不符

- 文件：`admin/src/views/memory/MemoryAuditView.vue:54`（`row.displayName || row.username || `#${row.userId}` `）与 `:109-122`（`MemoryAuditItem` 声明 `userId: number`）
- 问题：后端 `MemoryItemVO`（backend-ts/src/memory/types.ts:39-49）不含 `userId`，admin 路由（admin.routes.ts `/v1/admin/memory`）也只在记录上补 `username/displayName`。当用户被删除或 `findByIds` 查无此人时，回退分支渲染 `#undefined`；接口类型声明指向一个永远不会到达的字段。
- 建议：admin 路由在 records 上补 `userId`，或前端去掉该回退并把类型改为可选。

### 问题 7（低）：admin 系统设置页新分类「记忆」未加入 TOC_GROUPS，兜底落入「其他」分组

- 文件：`admin/src/views/settings/SystemSettingsView.vue:183`（MODEL_SELECT_KEYS 已加入 `memory.extractionModelId`，控件正确渲染为模型下拉）与 `:218-266`（TOC_GROUPS 未声明 category「记忆」）
- 问题：V130 将该设置归入 category `记忆`，但设置页目录未声明该分类，按 ：217 注释的兜底规则归入「其他」。功能可用（下拉控件、编辑、权限均正常），仅目录位置与迁移的 category 值未对齐。
- 建议：TOC_GROUPS 对应分组补 `{ kind: 'category', name: '记忆' }`。

---

## 待确认项

### 待确认 A：手工新增与 DISMISSED 行同内容时仅报错，用户看不到可恢复的对象

- 位置：`backend-ts/src/memory/memory.service.ts:96-98`（create 对任意 status 的已有行一律抛 3035）
- 说明：方案 D3 只规定了「抽取」对 DISMISSED 行不复活、DELETE 允许重插，未规定「手工创建」命中 DISMISSED 行的语义。当前实现：用户先忽略了一条自动记忆，再手写完全相同内容 → 报「已存在相同内容的记忆」，但默认「生效中」过滤下该行不可见，用户难以自行发现需切到「已忽略」去恢复。不构成功能性错误（去重与 D3 语义自洽），属产品语义缺口，建议与需求方确认：手工创建命中 DISMISSED 行时是否应直接恢复该行。

### 待确认 B：EMBED 嵌入页会话未在 D6 渠道列举中，实现会对其抽取

- 位置：`backend-ts/src/session/task-terminal.service.ts:105-107`（仅排除 SUBAGENT/SIDE_TASK）
- 说明：D6 列举「Web/桌面/LOCAL/钉钉/微信/飞书/定时任务」，未提嵌入页（embed page）会话；实现按"非 SUBAGENT/SIDE_TASK 的主会话"处理，embed 会话完成任务后也会派发抽取。嵌入页会话通常极短（D11 <20 字短路），实际成本趋近于零。仅提示方案与实现对齐口径，无需改动或补一行排除均可。

### 待确认 C：「条目数 >3 整体放弃」的计数口径比方案宽松一线

- 位置：`backend-ts/src/memory/memory-extraction.service.ts:253-264`（`parseExtractionOutput` 先过滤非对象元素）+ `:127-130`（对过滤后的 items 判长）
- 说明：模型输出 4 条且其中 1 条为 null/垃圾元素时，过滤后剩 3 条有效项会通过（方案原文是"条目数 >3 整体放弃"）。护栏目的（防跑飞输出）已达成，实际风险趋零，仅口径说明。

---

## 已核对无误的关键点（抽样）

- 触发与挂点：`finishExecution` 已在 `updatePhase`/`markLastMessageFinished` 之后追加派发，fire-and-forget 双层 catch（task-terminal.service.ts:97/110-124），FAILED/CANCELLED、SUBAGENT/SIDE_TASK、已终态会话均不触发（有 spec 覆盖）。
- 注入链：`buildContext` 独立 try-catch 降级 memories=null（harness-service.ts:300-302/455-464），prompt-engine 段落位置、冲突声明文案、空列表不产生段落均与 5.2 一致；`listForInjection` 的 USER 8 / PROJECT 12 截断与机器人渠道 key 排除正确。
- 去重与限额：dedup_hash 计算口径（scope|projectKey|规范化 content）在 create / update / extraction 三处一致；USER 级 projectKey 统一空串；抽取的并发撞键转更新分支、DISMISSED 跳过、200 条放弃均符合 5.6 第 5 点。
- 抽取模型回落链与 `session-title.service.ts:112-126` 完全同构；`MysqlLlmModelRepository` 同时具备 `selectById/selectDefault` 别名（model.repository.ts:86-92），create-app 装配无误。
- 基础设施核对：`isDuplicateKeyError` 检查 `errno===1062` 与 mysql2 错误对象匹配；`LlmAdapter.chat` 签名与 ChatRequest 字段（reasoning/thinking/enableThinking）与 session-title 调用同构；`userRepo.findByIds`、`LIMIT ? OFFSET ?` 参数化写法均有既有先例。
- 权限与越权：memory 用户域路由全部 `requireUserId` + `user_id` 归属校验（越权 404 语义正确，有 spec）；admin 路由 `requireRequestPermission('memory:read')`，V129 权限码 + role 1 授权与 V121 模式一致；desktop/admin 路由与导航、`llmCallLabels` 的 `memory_extract` 场景标签齐全。
- 前端：MemoryView 的 500 字码点计数与后端口径一致（el-input maxlength 按 UTF-16 更严，不会误放行）；开关失败回滚、删除分页回退、编辑仅改 content（D12）均正确；E2E 用例 mock 路由与页面选择器匹配。

## 建议的处理优先级

问题 1–4 建议在本迭代内顺手修复（都是几行改动）；问题 5、6、7 可随下个迭代；待确认 A 建议先与需求方对齐语义再决定是否改动。
