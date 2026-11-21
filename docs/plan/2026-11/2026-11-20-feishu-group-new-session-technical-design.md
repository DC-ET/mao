# 飞书群 `/new` 切换共享会话技术方案

- 状态：已评审可行（2026-11-21 评审，适配器副作用与切换原子性两处缺口已直接合入本文；本文只做方案，不含实现）
- 日期：2026-11-20
- 实施顺序：排在 [回复锚点方案](./2026-11-20-feishu-reply-anchor-technical-design.md) 落地之后。锚点未落地前不实施本方案。
- 一句话：普通对话群里，任何人 @ 机器人并只发送 `/new`，就新建一条 Mao 会话并把它设为这个群的活跃会话；之后任何人再 @ 机器人，都进入这条新会话。当前活跃会话还没有用户消息时，再次 `/new` 只再回复一次，不另建空会话。
- 关联代码（撰写时已核实的现状，全部为当前 `main`）：
  - 群入站：`backend-ts/src/feishu/agent-inbound-handler.ts:530-550`（`onGroupMessage`，非话题走群级单会话）
  - 私聊 `---` 对照：`backend-ts/src/feishu/agent-inbound-handler.ts:81-84`、`:455-464`（`isNewSessionCommand` / 拦截确认）
  - 合并窗口豁免：`backend-ts/src/feishu/inbound-processor.ts:356-368`（`canJoinEntry`）
  - 群上下文在 `onMessage` 之前拼好：`backend-ts/src/feishu/inbound-processor.ts:277-314`（`triggerMerged`）
  - 群指针：`backend-ts/src/feishu/message.service.ts:140-145`（`getOrCreateGroup`）、`message.repository.ts:125-130`（`saveConversation` 更新 `session_id`）
  - 水位线与摘要：`message.service.ts:250-282`、`message.repository.ts:240-258`
  - 会话工厂（工作区按 `chatId`、非话题群标题用群名）：`backend-ts/src/app-feishu-messaging.ts:59-81`
  - 群名补标题：`backend-ts/src/feishu-session.ts:60-71`（`ensureFeishuSessionTitle`）
  - 首条消息短标题：`agent-inbound-handler.ts:502-520`（`scheduleNewSessionTitle`，门禁在 `p2pSessionControl`）
- 关联方案：[2026-11-20-feishu-reply-anchor-technical-design.md](./2026-11-20-feishu-reply-anchor-technical-design.md)（图片/文件引用锚点。本方案依赖它先落地，不在本方案里改锚点）
- 既有设计：私聊多会话 `docs/plan/2026-09/2026-09-04-feishu-p2p-multi-session-design.md`；话题=会话 `docs/plan/2026-09/2026-09-15-feishu-thread-multi-session-design.md`

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 普通对话群 | `threadId` 为空的群消息。一个群（每个机器人一份）共用 `feishu_chat` 上的一条活跃会话 |
| 活跃指针 | `feishu_chat.session_id`。`(app_id, chat_id)` 唯一，一个机器人在一个群里只有一根指针 |
| `/new` | 剥掉对本机器人的 @ 之后，正文 trim 后恰好是 `/new`。大小写敏感，后面再有文字就不是指令 |
| 水位线 | `feishu_chat.last_context_log_id`。`buildGroupContext` 只注入 id 大于它的群日志 |
| 摘要缓存 | `feishu_chat.context_summary` / `context_summary_log_id`。窗口外未注入消息的 LLM 摘要，挂在群行上，不挂在会话上 |

## 1. 现状与问题

普通对话群是「一个群一个会话」：`getOrCreateGroup` 按 `(app_id, chat_id)` 取行，有则复用 `session_id`。所有人的 @ 进入同一条 Mao 会话，上下文越积越杂，群里没法另起一条干净的任务。

私聊已经能用 `---` 新建并切换指针，而且用 `chatType === 'p2p'` 守卫，群里发 `---` 仍是普通文本（`agent-inbound-handler.spec.ts` 有对应用例）。话题群不需要这条指令：一条话题已经对应一条会话。

直接把私聊的 `---` 放开到群，有四处对不上：

1. 群里必须 @ 机器人才触发，归一化后的正文是 `@机器人名 ---`，匹配不到 `^[-—]{3,}$`。
2. `feishu_chat` 的水位线和摘要是群级的。只换 `session_id`，下一次 @ 仍会把旧讨论注入新会话。
3. `triggerMerged` 先 `buildGroupContext`（并推进水位线），再在 `runInChatOrder` 之外调用 `onMessage`。不同发送者的合并窗口互相独立。甲的消息已经拼好上下文、乙的 `/new` 已经拨了指针之后，甲的 `getOrCreateGroup` 会读到新指针，旧任务正文跑进新会话。
4. 会话工厂对非话题群直接用群名做标题（`app-feishu-messaging.ts:72-74`）。`finalizeNewSessionTitle` 只改写仍为「飞书Bot会话」的标题。不绕开的话，每次 `/new` 都叫同一个群名，任务列表里分不开；`ensureFeishuSessionTitle` 还会把待命名标题改回群名。

图片/文件发到群里时引用「群最新一条消息」（`findLatestInboundMessageId`）由关联的锚点方案改为「本轮触发消息」。本方案等该方案落地后再实施，实施时直接使用锚点，不在这里重做。

## 2. 目标与非目标

### 2.1 目标

1. 普通对话群中，已绑定用户 @ 本机器人且正文恰好是 `/new` 时：若当前活跃会话已有用户消息（或还没有群会话），新建会话并切指针；若当前活跃会话还没有用户消息，不新建。本条都不进入会话、不触发 Agent。群里每次都回复确认。
2. 切换之后，任何人再 @ 本机器人，都进入新会话。切换之前已经确定会话的消息（含已入队、正在执行）留在旧会话。
3. 新会话不继承旧的群讨论：水位线推到这条 `/new` 的群日志 id，摘要缓存清空。
4. 新会话与这个群共用同一工作区目录、同一个任务分组键 `feishu-chat-{botId}-{chatId}`。会话归属发送 `/new` 的用户；群行上的 `owner_user_id` 不变。
5. 新会话标题用首条真正的 @ 生成短标题（复用现有待命名标志），不用群名。
6. 旧会话正在执行的任务继续跑完，进度卡照常更新；旧会话队列里的消息仍在旧会话消费。
7. 群里回复确认：「已开启新会话，之后本群里 @ 机器人的消息都会进入这个新会话。」确认句不提旧任务是否还在跑。当前已是空会话时再发 `/new`，回复同一句，不另建会话。失败时回复失败提示，指针和水位线都不动。

### 2.2 非目标

- 不改私聊 `---`，也不在群里把 `---` 当成 `/new`。
- 话题消息（`threadId` 非空）不认 `/new`，仍走话题会话。话题群里每条消息都有 `threadId`，因此这条指令只在普通对话群生效。
- 不做引用切回旧会话，不做会话列表指令。旧任务从网页 / 桌面打开。
- 不取消、不迁移旧会话上正在跑或排队的任务。
- 不拆工作区。群的文件和命令副作用仍在同一目录。
- 不改图片 / 文件的 reply 锚点，不新增 `feishu_session_channel` 列。锚点方案先落地；本方案的 `upsertSessionChannel` UPDATE 列保持现状，不写入 `last_trigger_message_id`。
- 不改桌面 / Web / 管理后台页面。新会话出现在同一飞书群分组下。
- 不认 `/new` 带参数（`@机器人 /new 帮我查` 是普通任务）。

## 3. 技术选型

| # | 决策点 | 结论 | 理由 / 备选否决 |
|---|---|---|---|
| D1 | 指针放哪 | **沿用 `feishu_chat.session_id`** | 群已经是一根指针。备选「每人一根指针」与「后续所有人的 @ 都走新会话」相反 |
| D2 | 指令形态 | **`@本机器人` + 正文恰好 `/new`** | 群触发本来就要 @。`---` 在群里既匹配不到，也容易和分隔线混淆 |
| D3 | 何时切 | **`runInChatOrder` 内、`buildGroupContext` 之前** | 水位线推进和指针切换必须挡住同群下一条上下文读取。放在 `onMessage` 且位于队列外，会和已拼好的上下文交错 |
| D4 | 已在路上的消息 | **`buildGroupContext` 当时的 `conversation.sessionId` 钉死，handler 不再二次 `getOrCreateGroup`** | 跨发送者窗口并发时，后拨的指针不能把先到的消息吸走 |
| D5 | 干净上下文 | **水位线设为这条 `/new` 的日志 id，摘要置 NULL** | 两列都在群行上。只换会话不清水位线，新会话仍吃到旧讨论。`/new` 自己是 @ 消息，本来就不会注入，用它的 id 做水位线可把它和更早的日志一起跳过 |
| D6 | 标题 | **创建时固定「飞书Bot会话」+ `awaiting_first_message_title=1`** | 工厂默认写群名，待命名逻辑不会覆盖。首条真正的 @ 再走现有 LLM 短标题 |
| D7 | 工作区与群主 | **工作区仍按 `chatId` 分配；`saveConversation` 沿用原 `owner_user_id` 和原 `workspace`** | 与「整群共享」一致。`ON DUPLICATE KEY UPDATE` 会改 owner，不能把发送者写进群行 |
| D8 | 旧任务 | **不取消** | 与私聊 `---` 相同：只拨指针。进度卡按会话更新，不依赖指针 |
| D9 | 数据迁移 | **无** | 指针、水位线、摘要、待命名标志都已存在 |
| D10 | 连续 `/new` | **当前会话没有 USER 消息则复用** | 每次都建会留下没有人说话的空会话。复用时指针、水位线、摘要都不变，确认回复照发。已有 USER 消息才新建 |
| D11 | 与锚点方案的关系 | **锚点方案落地后再实施本方案** | 旧会话发文件要引用本轮触发消息，避免挂到新会话的消息下。本方案不临时改发送锚点 |

## 4. 详细设计

### 4.1 指令识别

归一化之后，群消息正文含 `@机器人名`（`replaceMentionKeys`）。`FeishuNormalizedMessage` 只留了 mention id，没有名字。识别需要名字：

- `event-normalizer.ts` 在计算 `isBotMentioned` 的同一轮，把命中的本机器人提及展示名放进新字段 `botMentionNames: string[]`。识别条件与现有 `isBotMentioned` 相同，不另写一套。
- 新函数 `isGroupNewSessionCommand(event)`（放在 `agent-inbound-handler.ts`，与 `isNewSessionCommand` 并列）：
  1. `chatType === 'group'`；
  2. `threadId` 为空；
  3. `isBotMentioned === true`；
  4. 从 `text` 中去掉 `botMentionNames` 对应的 `@名字`（名字未知时不剥任何 `@`，匹配失败，整句当普通消息）；
  5. trim 后等于 `/new`。
- `@机器人 /new 帮我查`、`/New`、话题内的 `@机器人 /new`、没 @ 的 `/new` 都不命中。没 @ 的 `/new` 今天也不会触发，只进群日志。

`canJoinEntry` 对命中的消息返回 false，与私聊 `---` 一样：先冲刷该发送者窗口里的前序文本，再单独触发。这样 `@机器人 看下日志` 紧接着 `@机器人 /new` 不会被拼成一条任务。

### 4.2 切换（`FeishuMessageService.createGroupSession`）

在 chat 级锁内（已有 `withChatLock`，key `${accountId}:${chatId}`）完成，任一步失败则整段失败、不回复成功。返回 `{ sessionId, created }`：`created=false` 表示复用了还没有用户消息的会话。

1. `findGroupConversation`。
2. **复用空会话**：群行已在，且该 `session_id` 没有任何（未软删的）`USER` 消息时，直接返回现有 `sessionId`，`created=false`。不建会话，不改指针，不推水位线，不清摘要。判定走 `message` 表 `session_id + role='USER'` 的 EXISTS 查询（`idx_session` 命中，排除软删，与 `session.repository.ts:998` 既有 USER 查询口径一致）；`/new` 本身不入库，所以刚建出的会话在下一条真正的 @ 之前一直算空。已钉住但还没落库的在途消息不阻止复用，它随后写进这条会话。
3. **需要新建**（没有群行，或当前会话已有 `USER` 消息）时，用会话工厂创建新 session。工厂增加可选参数 `pendingTitle: true`：标题写「飞书Bot会话」，不调群名。工作区叶子仍是 `chatId`（`app-feishu-messaging.ts:68-69`），与这个群同一目录。分组键仍是 `feishu-chat-{accountId}-{chatId}`。没有群行时这一条就是第一会话，不再额外建一条再切走。
4. `upsertSessionChannel(..., 'group', true)` 打上待命名标志。UPDATE 列保持今天的清单（`app_id` / `chat_id` / `chat_type` / `awaiting_first_message_title`），不写入锚点方案的 `last_trigger_message_id`。
5. **最后一步**：按 `messageId` 查 `feishu_group_message_log.id`（`prepareOne` 在触发前已经入库），然后**单条 UPDATE `feishu_chat` 原子完成「切指针 + 推水位线 + 清摘要」**——`session_id` 用新会话、`last_context_log_id = GREATEST(last_context_log_id, ?)`、`context_summary = NULL`、`context_summary_log_id = 0`。这四列同属群行，单语句天然原子，满足目标 7「任一步失败则指针和水位线都不动」，不需要跨服务事务（`db.transaction` 覆盖不到会话工厂的写入路径）。`owner_user_id` 与 `workspace` 不出现在 SET 清单，天然保持原值；还没有群行时改为单条 INSERT（用新会话的 owner 与 workspace，`last_context_log_id` 一并落到 `/new` 日志 id——否则此前未 @ 的群日志会在新会话首次 @ 时全部注入，违背 D5）。查不到日志 id 时省略 GREATEST 项（其余照写），指针仍切换并 `console.warn`（确认文案仍成功；极端情况下下一条可能看到未跳过的旧日志）。复用路径不做这一步。
6. 全部成功后锁外回复确认；新建和复用都回复同一句，不说明是不是刚建出来的，也不提旧任务。确认回复走现有 `onReply` → `sendFeishuText`，锚定这条 `/new` 消息。不写 `feishu_p2p_message`。

失败残留的口径：工厂创建成功、但第 4/5 步失败时，任务列表里会留下一条没人说话的「飞书Bot会话」（指针未动、不影响正确性，用户可手动删除），属可接受残留。

`/new` 的群日志行保持 `is_mention=1`。只有新建路径会把水位线推过它；即便复用路径没推，`buildGroupContext` 的注入循环本来就跳过所有 `is_mention=1` 行（`message.service.ts:283`），溢出摘要同样只取 `is_mention=0`（`message.repository.ts:218`），`/new` 不会漏进任何会话的上下文。

失败文案与私聊相同口径：「开启新会话失败，请稍后再试。」指针、水位线、摘要保持失败前的状态。

### 4.3 入站时序（`inbound-processor.ts` `triggerMerged`）

普通对话群、且本批是 `/new`（豁免出窗后批内只有这一条）：

```
runInChatOrder:
  createGroupSession(...)          ← 有 USER 消息才切指针、推水位线、清摘要；空会话则复用
                                      结果写入 context.groupSessionSwitch
onMessage(context)                 ← 无 groupContext；无论是否新建，都只回复确认
```

`buildGroupContext` 不调用。它会把水位线推过旧讨论，还会在溢出时把旧讨论写进摘要缓存。

其他群触发（含话题）维持现状，只多钉一次会话：

```
runInChatOrder:
  buildGroupContext → 除 prompt 外，把 conversation.sessionId 记入 context.pinnedSessionId
onMessage(context)                 ← 锁外执行
```

`onGroupMessage`：`threadId` 非空仍走话题分支。否则若 `pinnedSessionId` 有值，用它取工作区（`feishu_chat.workspace`，与指针同一次读出，随 context 传 `pinnedWorkspace`），**不再** `getOrCreateGroup`。没有钉住的会话（文件豁免路径、旧调用方）才回退 `getOrCreateGroup`。

**占位时机（实施补充）**：切换与上下文读取的 chat-order 槽位必须在 `triggerMerged` **入口、任何 await 之前**同步占位（引用解析 `resolveQuotedMessage` 是真实网络往返，前批可能长时间卡在那里）——否则 `/new` 豁免 flush 会插队到先到消息的占位之前，指针切换先于上下文读取，R1 复发。占位后路径异常由 `finally` 空跑释放（占位泄漏会让该群 chat 队列永久卡死）。

话题分支的映射是确定性的（`feishu_thread_session` 行，一根话题一根会话），不存在指针竞态，给它钉会话只是冗余字段——实现时可以只在非话题路径钉，无害任选。

文件豁免路径今天把整个 `onMessage` 放在 `runInChatOrder` 里，与 `/new` 的切换自然按到达顺序排队，不必再钉。

跨发送者的结果：

```
甲 @bot「查告警」  buildGroupContext 钉住 session=9
乙 @bot「/new」    runInChatOrder 内切到 session=10，水位线推到 /new
甲 onMessage       使用钉住的 9，不读新指针
丙 @bot「继续」    buildGroupContext 读到 session=10，且水位线已在 /new 之后
```

甲这条若还在合并窗口里、尚未 `buildGroupContext`，`/new` 的豁免只冲刷乙自己的窗口。甲的窗口键不同，要靠 `runInChatOrder` 和钉会话来分先后，不靠合并窗口。

### 4.4 Handler

`onGroupMessage` 在话题分支之前：

- `isGroupNewSessionCommand` 命中：处理器与 handler 之间的切换结果用 context 字段传递（新增 `groupSessionSwitch?: { sessionId: number; created: boolean }`，processor 在 `createGroupSession` 返回后写入）。字段有值时 handler 只负责确认回复（用返回的 `sessionId` 调 `onReply`，便于以后出站映射；今天群回复不记映射）；字段缺失时（单测直接调 `onMessage`）由 handler 自己调 `createGroupSession`，避免两条路径行为不一致。即使字段缺失导致重复调用，复用检查（无 USER 消息）会把第二次调用收敛为 `created=false`，不会建出第二条空会话。
- 切换抛错：回复失败文案，`return null`。
- 不调用 `executeWithSession`，不 `saveUserMessage`。

**钉会话路径不得绕开适配器的既有副作用。** 今天 `sessionService.getOrCreateSession` 适配器（`app-feishu-handler.ts:146-152`）除了取会话，还依次做三件事：`resolveFeishuUserId`（executionUserId）、`applyFeishuBotConfig`（机器人 Agent/模型热切换）、`ensureFeishuSessionTitle`（群名补标题）。pinned 命中时这三件都必须保留——适配器新增 `pinnedSession(accountId, context, sessionId, workspace)` 入口（或等价形态），内部照跑这三步后返回 `{ id, workspace, executionUserId }`。直接在 handler 里拼 session 对象会静默丢掉机器人热切换，属回归。

非指令的群消息在确定 session 之后调用 `scheduleNewSessionTitle`。该函数已有「待命名标志 + 标题仍为飞书Bot会话」门禁，旧会话多一次查询后直接返回。话题分支今天已经会调它，保持不动。

`ensureFeishuSessionTitle` 增加同一门禁：`awaiting_first_message_title = 1` 时不把标题写成群名（`feishuMessageService.findSessionChannel(sessionId)` 读标志即可）。否则它和短标题互相覆盖。

执行身份不变：每条消息的 `executionUserId` 仍是这条消息的发送者（钉会话路径取 `context.maoUserId`，与适配器 `resolveFeishuUserId` 同源），不是 `/new` 的发送者，也不是群行 `owner_user_id`。

### 4.5 旧会话与新会话并行

- 忙碌和队列按 `sessionId`。指针切走后，新消息在新会话上另做忙碌判断；旧会话 RUNNING 时，新会话可以同时跑。群里会同时看到两张进度卡。
- 已写入旧会话队列的消息仍由旧会话消费。
- 进度卡按会话 PATCH，不读活跃指针。
- 文本回复在触发时就绑定了 `event.messageId`，不受指针影响。
- 实施时锚点方案已经落地：`send_image` / `send_file` 引用本轮触发消息。旧会话的文件挂在自己的触发消息下，不挂到新会话的消息上。本方案不改这条发送路径。

### 4.6 时序

```
乙 @bot "/new"                         ──► prepareOne 落群日志（is_mention=1）
                                           ├─ canJoinEntry=false，先冲刷乙自己的窗口
                                           └─ runInChatOrder
                                                ├─ createGroupSession
                                                │    新 session（标题=飞书Bot会话，待命名=1）
                                                │    feishu_chat.session_id = 新 id
                                                │    owner / workspace 不变
                                                │    last_context_log_id = 本条日志 id
                                                │    context_summary = NULL
                                                └─ 回复「已开启新会话…」（reply 这条 /new）
乙再次 @bot "/new"（新会话仍无 USER）   ──► createGroupSession 发现 session 无 USER 消息
                                                ├─ 不新建、不改指针、不推水位线
                                                └─ 仍回复同一句确认（reply 这一条 /new）
丙 @bot "看下今天的告警"                ──► buildGroupContext 只看到水位线之后的群日志
                                           onMessage 使用此时的指针 = 新会话
                                           首条消息触发 LLM 短标题
甲此前已钉住的旧会话任务                ──► 继续在旧会话执行，进度卡照常更新
```

## 5. 行为对照表

| # | 场景 | 今天 | 改后 |
|---|---|---|---|
| 1 | 普通群 @bot `/new`，当前会话已有用户消息 | 把「/new」交给当前会话执行 | 新建并切换，本条不执行，群里确认（不提旧任务） |
| 2 | `/new` 之后他人 @bot | 进原会话 | 进新会话 |
| 3 | `/new` 之前已钉住会话、尚未执行的 @ | 进原会话 | 仍进原会话 |
| 4 | 旧会话正在跑时 `/new` | — | 旧任务跑完；新的 @ 进新会话，可并行 |
| 5 | 旧会话队列里还有消息 | 旧会话消费 | 不变 |
| 6 | `@bot /new 帮我查`、`/New`、没 @ 的 `/new` | 普通文本或根本不触发 | 不变（不视为指令） |
| 7 | 话题内 @bot `/new` | 进该话题会话 | 不变 |
| 8 | 私聊 `---` / 私聊 `/new` | `---` 新建；`/new` 当普通文本 | 不变 |
| 9 | 连续两次 `/new`，中间没有用户消息 | — | 只建一条。第二次不新建、不改指针、不推水位线，群里再回复一次同一句确认 |
| 10 | 引用旧会话里的消息 | 只注入引用内容 | 不变，不切回 |
| 11 | 新会话首条 @ | — | LLM 短标题；失败则保持「飞书Bot会话」，下一条可重试（现有门禁） |
| 12 | 未绑定用户 @bot `/new` | 绑定引导，不建会话 | 不变 |

## 6. 兼容与迁移

| 项 | 处理 |
|---|---|
| 迁移 | 无。不改表 |
| 存量群 | 不切指针，直到有人发送 `/new`。水位线和摘要保持原样 |
| 回滚 | 回退代码。已切到新会话的群停在新 `session_id` 上，旧会话仍在任务列表里，不自动拨回 |
| 蓝绿 | 无新列。新旧实例都能读 `feishu_chat`；旧实例不认 `/new`，会把指令当普通消息执行 |
| 锚点方案 | 先落地。本方案在其后实施，不扩展 `upsertSessionChannel` 的 UPDATE 列表 |

## 7. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `/new` 与下一条 @ 分属两个窗口，交错读指针 | 先到的任务跑进新会话 | D3 + D4：切换在 `runInChatOrder` 内，上下文读取时钉死 `sessionId` |
| R2 | `buildGroupContext` 在指令路径上先跑了 | 水位线被推进，摘要缓存写入旧讨论 | 指令路径不调用 `buildGroupContext` |
| R3 | 水位线越过 `/new` 之前尚未富化的行 | 那些旧图片/文件回填后不再进入任何会话 | 接受。它们属于被跳过的旧讨论。`/new` 之后的未富化行 id 更大，水位线规则不变，仍会挡住后续注入 |
| R4 | 日志 id 查不到 | 新会话可能看到切换前还没注入的群日志 | 指针照切，打 warn。不因为缺 id 让指令失败 |
| R5 | `ensureFeishuSessionTitle` 把待命名标题写成群名 | 每次 `/new` 在任务列表里同名，短标题被跳过 | 待命名标志为 1 时不补群名 |
| R6 | 两人同时 `/new`，或同一人连发两次 | 空会话多一条 | chat 锁串行。后一次看到的会话还没有 USER 消息，复用并只回复确认 |
| R7 | 旧会话 `send_image` 挂到新消息下 | 文件看起来回错了地方 | 不在本方案处理。等锚点方案落地后，按会话上的本轮触发消息引用 |
| R8 | 共享工作区 | 新会话能读到旧任务留下的文件 | 产品口径就是整群共享工作区，不隔离 |
| R9 | 钉会话路径绕开适配器，丢失机器人热切换 / 标题补写 / executionUserId 解析 | 所有非话题群消息静默回归（Agent/模型配置不生效） | §4.4：适配器新增 `pinnedSession` 入口，三步副作用照跑；handler spec 断言 |
| R10 | 切换分多条 SQL，中途失败指针已动 | 违背目标 7「失败时指针和水位线都不动」 | §4.2 步骤 5：切指针 + 水位线 + 摘要合为 `feishu_chat` 单条 UPDATE，最后执行；单语句原子 |

## 8. 测试

### 8.1 单测清单

| 文件 | 用例 |
|---|---|
| `feishu/agent-inbound-handler.spec.ts` | ① `@名字 /new`、前后空白命中；`/new 帮我`、`/New`、无名字可剥、话题、私聊不命中；② 命中后 `createGroupSession` 一次、不 `execute`、回复确认且确认归属返回的 sessionId，文案不提旧任务；③ `created=false` 时同样回复确认、不执行；④ 创建抛错回复失败文案且不执行；⑤ 钉住的 `pinnedSessionId` 被使用，不再 `getOrCreate`；⑥ 非指令群消息会调 `scheduleNewSessionTitle`；⑦ 钉会话路径仍触发 `applyFeishuBotConfig` / `ensureFeishuSessionTitle`，`executionUserId` 来自发送者（R9 回归防护） |
| `feishu/message.service.spec.ts` | ① 当前会话已有 USER 消息：指针改为新 id，`owner_user_id` 与 workspace 保持原值；② 待命名标志为 1；③ 水位线推进到 `/new` 日志 id，摘要被清空（断言为单条 UPDATE，R10）；④ 工厂以 `pendingTitle` 调用；⑤ 无群行时只建一条；⑥ 当前会话没有 USER 消息：不调用工厂，不改指针，不推水位线，返回 `created=false`（判定排除软删 USER 消息）；⑦ 查不到日志 id 仍切指针（仅新建路径）；⑧ 最终 UPDATE 抛错时整体失败、群行保持原值 |
| `feishu/inbound-processor.spec.ts` | ① `@bot /new` 不入合并窗口，先冲刷前一条再单独触发；② 指令路径不调用 `buildGroupContext`；③ 普通 @ 把 `buildGroupContext` 返回的 sessionId 放进 context |
| `app-feishu-messaging` 对应工厂测试，或 `message.service` 已覆盖的工厂调用 | `pendingTitle` 时标题为「飞书Bot会话」，workspace 叶子仍是 `chatId` |
| `feishu-session` 标题补写 | 待命名标志为 1 时 `ensureFeishuSessionTitle` 不写群名 |

`isGroupNewSessionCommand` 的匹配与 `isNewSessionCommand` 分开测，避免群指令误伤私聊 `---`。

### 8.2 手工验证（测试群，普通对话群，不是话题群）

1. 甲 @bot 发一个会跑一会儿的任务。
2. 任务未完成时，乙 @bot 只发 `/new`。群里应出现确认回复，且引用乙这条 `/new`。
3. 丙 @bot 发一个新问题。新问题的进度卡是另一张；桌面端同一飞书群分组下出现新会话，标题随后变成这句的短标题。旧任务的卡继续更新直到结束。
4. 打开新会话，历史里没有甲那次任务，也没有「/new」这句。
5. 新会话还没有任何用户消息时，再 @bot `/new` 一次。群里再出现一句相同确认，任务列表里不增加新会话。
6. 对照：话题里 @bot `/new` 应作为普通任务进入该话题会话。

## 9. 实施步骤与工作量

| # | 文件 | 改动 |
|---|---|---|
| 1 | `feishu/event-normalizer.ts`、`feishu/types.ts` | `botMentionNames` |
| 2 | `feishu/agent-inbound-handler.ts` | `isGroupNewSessionCommand`；群指令分支；使用 `pinnedSessionId`；非指令也调度短标题 |
| 3 | `feishu/message.service.ts`、`message.repository.ts` | `createGroupSession`、按 messageId 取日志 id、推进水位线并清空摘要 |
| 4 | `app-feishu-messaging.ts` | 工厂 `pendingTitle` |
| 5 | `feishu/inbound-processor.ts` | 窗口豁免；指令路径跳过 `buildGroupContext` 并在 `runInChatOrder` 内切换；普通路径钉会话 |
| 6 | `app-feishu-handler.ts`、`feishu-session.ts` | 装配 `createGroupSession` 与适配器 `pinnedSession` 入口（保留热切换 / 标题 / executionUserId 三步副作用）；待命名时不补群名 |
| 7 | 上表 spec | 见 §8.1 |
| 8 | `skills/mao-cli/reference/feishu-bot.md`、`changelog/unreleased/` | 群聊用法补 `/new`；用户可见变更记一条 |

无迁移。验证：`cd backend-ts && npm test`，至少覆盖 `src/feishu`。发布走后端部署。

实施前提：回复锚点方案已落地。本方案内部顺序：识别与窗口豁免 → `createGroupSession`（含空会话复用）→ 处理器时序与钉会话 → 标题门禁 → 单测 → 文档。

## 10. 已确认

| # | 事项 | 结论 |
|---|---|---|
| 1 | 确认文案是否要写明「旧任务会继续跑完」 | 不写。确认句只说明之后的 @ 进新会话 |
| 2 | 连续 `/new` | 不重复创建空会话。当前活跃会话还没有 USER 消息时，不新建、不改指针；群里可以再回复一次同一句确认 |
| 3 | 与回复锚点方案的关系 | 本方案在锚点方案落地后再实施，不在这里临时改媒体引用 |
