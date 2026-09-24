# 飞书进度卡支持 ask_user_questions 作答

## 一、需求背景

飞书通道会话在组工具列表时会去掉 `ask_user_questions`（`HarnessService.filterToolsForSession`）。桌面 / Web / 安卓靠 WebSocket 把问题推到 `QuestionPanel`，用户提交 `ask_user_questions_result` 后，`AskUserQuestionsRegistry.complete` 唤醒挂起的工具调用。飞书会话没有这块面板：工具一旦暴露，模型调用后会在内存里空等，默认 15 分钟，用户在飞书里无法作答。

飞书侧已有可复用的交互面：任务进度卡（卡片 JSON 2.0）和 `card.action.trigger` 回调（取消、重试、排队插队）。卡片 2.0 支持 `form` 容器，提交后回调的 `action.form_value` 带回各字段值，且回调必须在 3 秒内返回整张新卡片，否则客户端会还原成点击前的内容。

## 二、需求描述

### 2.1 要做的

1. 飞书通道会话（私聊 `projectKey` 匹配 `feishu-{botId}-private-{userId}`，群聊工作区路径含 `/feishu-chat/`）恢复暴露 `ask_user_questions`。微信通道维持现状，继续去掉该工具。
2. 工具触发后，在**当前任务的进度卡**上渲染表单，不另发一条消息。一次调用里的 1–4 个问题放在同一个 `form` 里。同一轮并行多次调用时，同一张卡上堆多个 `form`，各自带自己的 `requestId`。
3. 原发送者提交后，按桌面端同一形状 `{ answers: [{ question, selectedLabels, customInput }] }` 调用 `AskUserQuestionsRegistry.complete`，模型收到工具结果后继续 loop。
4. 单选允许只填「其他」；多选可以同时选选项和填自定义文本。选项说明（`description`）用 markdown 展示，不塞进下拉项。
5. 群聊里所有人看得到表单（`update_multi: true`），只有触发该任务的原发送者能提交，其他人 toast「仅消息发送者可操作」。
6. 网页 / 桌面同时在线时仍推送 `ask_user_questions`。先到达的 `complete()` 生效；飞书提交成功后向已连接客户端补发 `ask_user_questions_cancelled`，收起另一端面板。
7. 进度卡成功挂上表单后，不再发「离线回来回答」的 Webhook。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 把提问登记持久化 | 与桌面端一致，`requestId` 只在内存。进程重启后这一轮 tool call 尚未落库，崩溃恢复从最后一条已保存消息重新 loop，不记得自己在提问。恢复时的第一次 PATCH（「任务正在恢复执行」）不含表单，旧表单被盖掉 |
| 重启后补交仍生效 | 重启后 `complete()` 找不到 `requestId`，回调 toast「问题已失效」，不把答案写进新 loop |
| 用飞书文字回复代替表单提交 | 用户在卡片下方再发一条消息，仍是新的入站消息（忙碌则排队），不解析为当前问题的答案 |
| 改桌面 `QuestionPanel` 交互 | 只复用已有的取消事件，让双端不要同时挂着已答完的题 |
| 微信通道 | 继续屏蔽 `ask_user_questions` |
| 新表 / 迁移 | 进度卡映射表 `feishu_progress_card` 够用，表单状态放内存 |

## 三、方案

表单是进度卡渲染状态的一部分，每次 PATCH 前现读，而不是注册提问时单独贴一次。`buildFeishuProgressCard` 每次都整卡重写；工具开始时进度监听会先刷「执行中」。若只追加一次表单，后到的进度更新会把表单盖掉。

数据流：

```
模型调用 ask_user_questions
        │
        ▼
ToolDispatcher.dispatchAskUserQuestions
        │  register(requestId)          ← 现有内存登记，继续 waitForAnswer
        │  飞书进度卡状态写入本题
        │  触发一次进度卡刷新（带表单）
        │  若用户有 WebSocket 连接，照旧推 ask_user_questions
        ▼
用户在进度卡表单提交
        │
        ▼
card.action.trigger  kind=feishu_ask
        │  校验发送者、至少答了一项
        │  AskUserQuestionsRegistry.complete(sessionId, requestId, answersJson)
        │  清掉这组表单状态
        │  回调返回不含该表单的整卡；并排再 PATCH 一次给群内其他人
        │  向桌面/网页发 ask_user_questions_cancelled
        ▼
waitForAnswer 返回，AgentLoop 把工具结果交给模型
```

挂载目标：只挂本会话自己的进度卡。子代理不参与。

- 本会话在 `feishu_progress_card` 有活跃进度卡 → 挂到这张卡。
- 没有进度卡、且用户没有 WebSocket 连接 → 不空等 15 分钟，直接返回 `{"error":"当前通道无法向用户提问"}`，让模型用文字继续。用户已连接桌面时仍走现有 WebSocket 等待，不走这条失败捷径。
- 前台委派和后台子代理一律从工具列表去掉 `ask_user_questions`（`SUBAGENT_EXCLUDED_TOOLS`，`buildSubContext` 两处共用）。不挂父会话进度卡，也不把提问交给子代理。主会话被飞书过滤掉的现状，在放开主会话之后仍然适用于子代理。

## 四、详细设计

### 4.1 放开工具

`HarnessService.filterToolsForSession`：飞书分支只去掉微信通道工具，保留 `ask_user_questions`。非飞书会话仍去掉飞书通道工具。系统提示里已有「若可用则优先使用 `ask_user_questions`」，不必改通用提示。

飞书会话额外加一句执行说明（挂在该会话的系统提示或飞书入站上下文，二选一，实现时跟现有飞书提示注入点放在一起）：用户在进度卡片的表单里作答；调用工具后等待工具结果，不要在正文里再要求用户打字回复。

### 4.2 进度卡上的表单

`buildFeishuProgressCard` 增加可选参数 `pendingAsks`。仅 `RUNNING` 且列表非空时，在工具摘要下方、取消按钮上方，为每组问题输出一个 `form`：

| 区块 | 卡片组件 |
| --- | --- |
| 题目标题 | markdown：`header` + 问题原文；每个选项一行 `label`：`description` |
| 选项 | `multiSelect === true` 用 `multi_select_static`，否则 `select_static`。都不设 `required`。选项 `value` 用下标字符串（`"0"`…），避免 label 里的特殊字符 |
| 其他 | `input`，placeholder「其他（可选）」，不设必填 |
| 提交 | 放在该 `form` 内的按钮，`form_action_type: "submit"`，`behaviors: [{ type: "callback", value }]` |

按钮 `value`：

```json
{ "kind": "feishu_ask", "act": "submit", "sessionId": 1, "requestId": "...", "sender": "ou_xxx" }
```

`form.name` 用 `ask_0`、`ask_1` 这种序号，字段名用 `q0` / `c0`（选择 / 自定义文本）。`requestId` 只放在按钮 value 里，不放进飞书组件 name。

「取消任务」和「会话详情」保持在表单外面的 `column_set` 里，避免点取消时把表单一并提交。终态（完成 / 失败 / 取消）不渲染表单。

### 4.3 答案映射

回调 `action.form_value`：

- 单选：`q{i}` 为选项下标字符串；`c{i}` 为自定义文本。自定义文本去空白后非空时，忽略下拉选择，`selectedLabels = []`，`customInput` 为该文本（对齐桌面端单选时填写「其他」会清掉选项）。
- 多选：`q{i}` 为下标字符串数组，映射回 `label` 放入 `selectedLabels`；`customInput` 同时保留。
- 某一题两项都空：不调用 `complete`，toast「请至少选择一项或填写其他」，回调仍返回带表单的当前卡。
- `question` 回填工具入参里的问题原文，保证和 `getOutputSchema` 一致。

### 4.4 卡片状态与覆盖顺序

在 `create-app.ts` 的进度卡闭包旁增加会话级内存状态（不入库）：

- `set(sessionId, requestId, questions, senderOpenId)`
- `remove(sessionId, requestId)` / `clearSession(sessionId)`
- `list(sessionId)` 供每次 PATCH 读取

`createPatchedProgress` 在节流等待结束、真正 `message.patch` 之前读取 `list`。这样「工具开始」时排队的那次更新，只要发生在登记之后，就会带上表单。登记之后再主动触发一次刷新，避免登记前已经发出的 PATCH 把卡定格在无表单状态。

提交路径：

1. 同步 `remove` 这组问题。
2. 用去掉表单后的卡片作为回调 `card`（点击者立即看到）。
3. 经同一进度对象再 PATCH 一次，给群内其他人。
4. 若有一次更早发出、快照里仍带表单的 PATCH 后到，进度对象在每次 PATCH 结束后再读一遍当前快照，不一致就补一次 PATCH。点击者和群成员最终都停在无表单的卡上。

超时、`failAllForSession`（用户点「取消任务」）、任务终态：先清掉该会话的表单状态，再让随后的进度更新把表单刷掉。取消任务的回调卡本身就不含表单。

### 4.5 回调分发

`FeishuCardActionValue` 增加 `kind: 'feishu_ask'`。`FeishuCardActionService.handle` 在 progress / queue 之外增加该分支：

- `operator.open_id` 必须等于按钮里的 `sender`，否则 toast「仅消息发送者可操作」。
- `complete()` 返回 `true`：按 4.4 收起表单，toast「已提交」。并让调用方发 `ask_user_questions_cancelled`（与 `StreamingWsHandler.handleAskUserQuestionsResult` 相同），再 `treeSignalPublisher.publishForSession`。
- `complete()` 返回 `false`：toast「问题已失效」，回调返回不含这组表单的卡。不报错给模型（等待方已经不在了）。

回调里只做内存 `complete` 和组卡，不在返回前等待飞书 PATCH。3 秒限制与现有排队卡「回调带回新卡片、PATCH 不阻塞」相同。

`FeishuCardActionEvent.action` 补上 `form_value` 与 `name`，`unwrapCardActionEvent` 要把它带出来。

### 4.6 分发器

`dispatchAskUserQuestions` 在 `register` 之后：

1. 若本会话是飞书通道且有活跃进度卡：写入 4.4 的状态并刷新卡片。成功则**不**调用 `askUserOfflineNotifier.prepareAskUser`。不查找父会话进度卡。
2. 飞书通道、没有可挂的进度卡、且用户没有 WebSocket 连接：不 `register`（或立刻 `complete` 掉），返回 `{"error":"当前通道无法向用户提问"}`。
3. 有 WebSocket 连接：保持现在的推送。飞书表单和桌面面板可以同时出现，先 `complete` 的一方生效。

超时或 `cancelled` 时清表单状态。现有的 `ask_user_questions_cancelled` 推送保留，桌面端面板靠它收起。

### 4.7 重启

不改变崩溃恢复语义，只保证飞书卡片不要留下无法提交的表单：

- 提问进行中进程退出：这一轮助手消息和 tool call 还没落库，恢复从最后一条已保存消息重新 `execute`。
- 新进程内存里没有表单状态。`createFeishuRecoveryProgress` 的首次 PATCH 用现有「任务正在恢复执行」文案，整卡重写后表单消失。
- 用户在旧卡上点提交（恢复 PATCH 尚未到达时）：`complete()` 为 `false`，toast「问题已失效」。

## 五、改造清单

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | 飞书会话保留 `ask_user_questions` | `backend-ts/src/harness/core/harness-service.ts`、`harness-service.spec.ts` |
| 2 | 飞书执行说明：在卡片表单作答，不要改要文字回复 | 现有飞书系统提示注入点（与 `prompt-engine.ts` 的「若可用」并存，不改桌面文案） |
| 3 | 进度卡渲染表单；终态不渲染 | `backend-ts/src/feishu/progress-card.ts`、`progress-card.spec.ts` |
| 4 | 会话级表单状态；PATCH 前读取；提交后补 PATCH 防覆盖 | `backend-ts/src/create-app.ts`（`createPatchedProgress`） |
| 5 | 登记 / 超时 / 取消时写入或清掉表单；无卡且无连接时立即返回错误；挂上表单则跳过离线 Webhook；桌面在线仍推 WebSocket | `backend-ts/src/harness/tool/tool-dispatcher.ts`、`tool-dispatcher.spec.ts` |
| 6 | 所有子代理去掉 `ask_user_questions`（已落地） | `backend-ts/src/harness/delegate/background-subagent-manager.ts` 的 `SUBAGENT_EXCLUDED_TOOLS`；`delegate-tool.ts` 与后台 `buildSubContext` 共用 |
| 7 | 动作类型、`form_value` | `backend-ts/src/feishu/types.ts` |
| 8 | 提交分支：鉴权、映射答案、`complete`、失效 toast | `backend-ts/src/feishu/card-action.service.ts`、`card-action.service.spec.ts` |
| 9 | 飞书提交成功后向 WebSocket 客户端发 `ask_user_questions_cancelled` | `create-app.ts` 装配 `FeishuCardActionService` 时接到现有 `wsRegistry` |
| 10 | 单测见第六节 | 上表已列 spec |
| 11 | 发版说明与使用说明 | 根 `CHANGELOG.md`；`skills/mao-cli/reference/feishu-bot.md` 进度卡片一行补充「提问时卡片内出现表单，仅原发送者可提交」 |

不改：`AskUserQuestionsRegistry` 的存储模型、桌面 `QuestionPanel`、安卓原生、管理后台。

## 六、测试计划

`cd backend-ts && npm test`，至少覆盖：

- `filterToolsForSession`：飞书私聊 `projectKey`、群聊工作区都保留 `ask_user_questions` 并去掉微信工具；微信 `projectKey` 仍去掉该工具；普通会话行为不变。
- 进度卡：一组单选 + 一组多选同时出现；下拉不设 required；提交按钮在 form 内、取消按钮在 form 外；`COMPLETED` / `FAILED` / `CANCELLED` 无表单。
- 卡片回调：非发送者拒绝；单选只填输入框时 `selectedLabels` 为空且 `customInput` 有值；多选两者都保留；两项都空时不调用 `complete`；`complete() === false` 时 toast「问题已失效」且不抛错。
- 分发器：飞书会话登记后刷新进度卡且不 `prepareAskUser`；超时后状态被清掉；无进度卡、无 WebSocket 时立即返回错误 JSON，不进入 `waitForAnswer`；有 WebSocket 时仍发送 `ask_user_questions`。
- 子代理：前台 `DelegateTool.buildSubContext` 与后台 `BackgroundSubagentManager.buildSubContext` 的工具列表都不含 `ask_user_questions`。
- 覆盖顺序：表单状态清空之后的 `update` 不再包含该 `requestId`。

## 七、风险与对策

| 风险 | 对策 |
| --- | --- |
| 进度更新整卡重写盖掉表单 | 表单属于每次 PATCH 的输入；登记后强制刷新；PATCH 结束后按最新快照补写 |
| 回调超过 3 秒或空响应导致卡片回弹 | 回调只做内存完成和返回新卡；群内 PATCH 不 await 在回调路径上 |
| 桌面和飞书同时作答 | `complete()` 只有第一次返回 true；飞书成功后发 `ask_user_questions_cancelled` |
| 子代理向用户提问会挂住父任务 | 所有子代理工具列表去掉 `ask_user_questions`；需要用户决策时由主会话自己提问 |
| 重启后用户点旧表单 | toast「问题已失效」；恢复 PATCH 会整卡去掉表单。不把答案补进新 loop |
| 模型在正文里又问一遍，用户改用文字回复 | 飞书执行说明明确要求等工具结果；文字回复仍按普通入站处理 |
