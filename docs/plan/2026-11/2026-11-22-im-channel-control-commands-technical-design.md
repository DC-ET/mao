# IM 渠道控制命令补完技术方案（/new 对齐、/stop 文本兜底、/tasks 回看切换、/help）

- 状态：已确认（待实施）
- 评审结论（2026-11-22）：按 §3 全部定案实施——含 D7（群聊 `/stop` 不校验触发成员）与 D3（`/tasks` 列表按渠道 source 收窄）；群聊命令的 @ 门禁结论见 §1.3 第 9 条
- 二次评审补充（2026-11-22，实施前）：新增定案 **D9**（三渠道合并窗口豁免命令——§1.3 原第 5 条「防抖合并对命令无影响」结论有误，命令会被批次吞掉）、**D10**（`/tasks` 列表排除群聊绑定会话，防 p2p 指针切进群会话）、**D11**（飞书话题内 `/stop` 以话题会话为目标）；并勘误 §4.3 签名、§5/§6「不落库」表述；风险与测试清单追加 R9-R12 及对应用例
- 日期：2026-11-22
- 需求来源：[提案：IM 渠道控制命令补完 —— /new 三渠道对齐、/stop 文本兜底、/tasks 回看切换](../../proposals/2026-11/2026-11-22-im-channel-control-commands.md)（批次 31 已立项）
- 上游：第三十一批「IM 渠道控制命令、任务产出总览、Agent 能力详情卡」（后两项已否决，本方案仅含第一项）
- 规模：中（backend-ts 单端；约 4 人日；0 迁移；desktop / admin / android / agent-cli 零改动）
- 关联：`backend-ts/src/common/channel-command.ts`（新增）、`backend-ts/src/session/session.repository.ts`（新增 1 查询方法）、`backend-ts/src/feishu/agent-inbound-handler.ts`、`backend-ts/src/app-feishu-handler.ts`、`backend-ts/src/feishu/message.service.ts`、`backend-ts/src/dingtalk/agent-inbound-handler.ts`、`backend-ts/src/dingtalk/message.service.ts`、`backend-ts/src/dingtalk/runtime.ts`、`backend-ts/src/weixin/agent-inbound-handler.ts`、`backend-ts/src/weixin/session.service.ts`、`backend-ts/src/{feishu,dingtalk}/inbound-processor.ts` 与 `backend-ts/src/weixin/inbound-processor.ts`（D9 合并窗口豁免）

## 0. 名词约定

- **渠道会话绑定**：一条 IM 会话（聊天）当前指向的 Mao 会话。飞书私聊 / 钉钉私聊是「指针」（独立表，可切换）；飞书群聊是群级指针（`feishu_group_conversation`）；微信是「单活跃会话」（`session.project_key = WEIXIN_PROJECT_KEY` 且 `status = 'ACTIVE'` 的唯一一行）。
- **控制命令**：入站文本 trim 后**全等匹配**的指令（`/new`、`/stop`、`/tasks`、`/tasks <n>`、`/help`）。不命中即逐字节走原链路，本方案对未命中路径零改动。
- **拦截**：命令消息不落会话消息流（不 saveUserMessage）、不触发 Agent、不创建进度卡——与既有 `---`（私聊新建）和群 `/new` 的口径一致；群日志照常记录（见 §5 尾注）。

## 1. 现状与问题

### 1.1 三渠道命令能力现状（代码可查）

| 能力 | 飞书私聊 | 飞书群聊 | 钉钉私聊 | 钉钉群聊 | 微信 |
|---|---|---|---|---|---|
| 新建会话 | ✅ `---`（`isNewSessionCommand`，`feishu/agent-inbound-handler.ts:88-90`） | ✅ 群 `/new`（`:98-112` + `groupSessionControl`） | ✅ `---`（`dingtalk/agent-inbound-handler.ts:199,213-229`，带 abandon 语义） | ❌ | ❌ |
| 切换会话 | ✅ 引用切换（`parentId`→消息映射→`switchP2pSession`，归属校验 `app-feishu-handler.ts:201-215`） | —（群单指针） | ❌ | — | ❌ |
| 停止任务 | 进度卡按钮（`card-action.service.ts:155→handleProgressCancel`） | 同左 | 互动卡按钮（`dingtalk/card-action.service.ts:112`） | 同左 | ❌（无卡片；发新消息会打断旧执行） |
| 任务回看 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 命令帮助 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 文本命令解析 | 仅群 `/new` 等值匹配 | 同左 | 仅 `---` 正则 | ❌ | 完全没有 |

### 1.2 要解决的问题

1. **停止入口依赖卡片存活**：卡片被聊天流刷走 / 过期后，跑偏任务没有取消入口（微信连卡片都没有）。取消语义已在服务端闭环，缺的只是文本触达。
2. **回看与切换缺位**：IM 里看不到「我的最近任务」，也回不去早上的会话。飞书私聊虽有引用切换，但前提是「那条历史消息的消息映射还存在」，没有列表就没有发现入口。
3. **三渠道肌肉记忆不一致**：`---` 与 `/new` 各占一半，微信两者皆无。
4. **命令不可发现**：没有任何 `/help`。

### 1.3 关键事实（设计建立在其上）

- **取消链路已在装配层闭环，无需新写**：飞书 `cancelRunning` = `feishuInboundHandler.cancel(sessionId)`（置取消标志 + `onInterruptRunning`）+ `persistFeishuCancelIfIdle`（内存无循环且 DB 仍活跃时补写 CANCELLED 并排空队列），见 `app-feishu-handler.ts:458-467`；钉钉同构 = `handler.cancel()` + `persistDingtalkCancelIfIdle`（`dingtalk/runtime.ts:478-486`）。两个 helper 分别在 `feishu/cancel-running.ts`、`dingtalk/cancel-running.ts`。
- **微信是单会话模型**：`getOrCreateWeixinSession(userId)` → `findActiveByUserAndProjectKey(userId, WEIXIN_PROJECT_KEY)`（`session.repository.ts:350-355`，`status='ACTIVE'` 且未删除）；建会话写 `source='weixin'`（`weixin/session.service.ts:76`）。且 `onMessage` 对**任何**新消息先 `abortRunningExecution`（`weixin/agent-inbound-handler.ts:152`）——微信的既有语义是「新消息打断旧执行」。
- **会话来源闭集已含三渠道**：`SESSION_SOURCE_VALUES = ['web','embed','desktop','cli','android','feishu','dingtalk','weixin','signal','openapi']`（`session.repository.ts:23-25`）；`session.session_type` 区分 `NORMAL` / `SIDE_TASK` 等。**`/tasks` 列表的事实源只能是 `session` 表**（飞书 `feishu_p2p_message` 仅 message→session 映射、无用户维度；钉钉 conversation 表只存指针不存历史）。
- **入站授权先于命令**：飞书 processor 有 `authorizeSender` 门（`feishu-session.ts:174-190`），钉钉 / 微信入口各自有绑定校验；命令解析不新增、不绕过任何授权面。
- **防抖合并必须豁免命令（二次评审修正，定案 D9）**：合并只保证「合并文本不会**误触发**命令」（多段 `\n\n` 拼接后全等匹配不命中，`dingtalk/inbound-processor.ts:160-177`），但反过来命令会被批次**吞掉**——`/stop` 落在前序消息的合并窗口内时整条拼进批次，命令不执行、文本照常落进 Agent。三渠道 `canJoinEntry` 现有豁免清单均不含新命令：飞书 `feishu/inbound-processor.ts:422-436` 只豁免 `---` / 群 `/new` / p2p 引用，钉钉 `dingtalk/inbound-processor.ts:196-205` 只豁免 p2p `---`，微信 `weixin/inbound-processor.ts:175-180` 只豁免非纯文本。须在三渠道准入谓词中增加命令豁免；豁免条目按 `common/inbound-merge-window.ts:51-52` 既有「先冲刷在窗批次再单独触发」语义天然保序。
- **钉钉文本已剥 @ 前缀**：`cleanText` 剥开头 @ 段（`dingtalk/event-normalizer.ts:55-57`）；飞书群剥名逻辑在 `isGroupNewSessionCommand` 内（名单为空不命中——「漏触发优先」口径，可抽复用）。
- **命令回复通道现成**：飞书 `onReply`（handler 内 `reply()` 容错发送）；钉钉 `onReply`；微信 `onMessage` 返回 `WeixinReply`，由 `weixin/inbound-processor.ts:286` 消费。
- **`session.service.createSession` 已有 `source` 参数**（`session.service.ts:115-133`），微信 `/new` 复用现有建会话路径即可。
- **群聊命令以 @ 机器人为前提，且由入站门禁在上游保证，命令层无需自理**：飞书群消息未 @ 只落群日志、不进 handler（`feishu/inbound-processor.ts:233-236`，`if (!mentioned) return null`）；既有例外是话题会话映射已存在时话题消息免 @ 放行（`:224-229`）。钉钉群消息未 @（`isInAtList=false`）直接丢弃（`dingtalk/inbound-processor.ts:105-108`）。微信无群聊概念（weixin 目录无 group / chatType 引用），天然不适用。因此命令解析只需处理「已到达 handler」的消息；第二层保险是剥 @ 后全等匹配——`@机器人 你好 /stop` 这类不命中，照常走 Agent。

## 2. 目标与非目标

### 2.1 要做的

1. **共享命令解析器** `common/channel-command.ts`：纯函数，识别五个命令，三渠道共用一套语义。
2. **`/new` 对齐**：钉钉私聊、微信私聊补齐；飞书私聊把 `/new` 作为 `---` 的等价别名。群聊新建维持现状（仅飞书群已有，钉钉 / 微信群不做）。
3. **`/stop` 全渠道全场景**（私聊 + 群聊）：终止当前绑定会话的进行中执行，**复用卡片取消的同一服务闭包**；空闲时明确提示。
4. **`/tasks` / `/tasks <n>`**（仅私聊）：列出该渠道本人最近 5 个会话（群聊绑定会话除外，D10）；序号切换绑定。
5. **`/help`** 全渠道全场景：命令一览纯文本。

### 2.2 明确不做的

- **不做配置类命令**（定时任务 / 哨兵 / Agent 切换）——哨兵对话内配置批次 15 已否决，控制命令不越界。
- **不做钉钉 / 微信群聊的 `/new` 与 `/tasks`**：群指针为全体成员共享，切换 / 新建的误触代价高；飞书群 `/new` 是既有先例（chat 锁 + 确认文案），如需对齐另立小提案。
- **不做跨渠道会话迁移、会话删除 / 重命名 / 归档命令**。
- **不改动**：`---`、群 `/new`、引用切换、卡片按钮动作、防抖合并、进度卡协议、任何执行语义（取消复用既有闭包）。
- **不动会话表结构**：0 迁移；微信切换复用 `status='ACTIVE'/'ARCHIVED'` 既有值。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 命令解析位置 | `common/channel-command.ts` 纯函数，三渠道 handler 各自调用 | 语义须三渠道一致；等值匹配 + 单测一处覆盖。放 handler 内联会出现三份漂移的正则 |
| D2 | `/stop` 取消实现 | handler `options` 新增 `stopRunning?: (sessionId) => Promise<boolean>` 埠；装配侧把卡片服务的 `cancelRunning` 闭包抽成具名函数同时喂两处 | 取消依赖 `persistCancelledIfActive`（`app-feishu-handler.ts:132`）与 agentLoop 状态，全部收敛在装配层；handler 内自带会重复装配、双写终态 |
| D3 | `/tasks` 列表数据源 | 新增 session repository 方法 `listRecentChannelSessionBriefs(userId, source, limit)`：`WHERE user_id=? AND source=? AND session_type='NORMAL' AND (status IS NULL OR status<>'ARCHIVED') AND 未删除 ORDER BY updated_at DESC LIMIT ?` | 渠道映射表无用户维度（飞书）/无历史（钉钉）；`session.source` 是批次 19 已落地的渠道事实源；signal / openapi 来源天然被 source 过滤排除 |
| D4 | 切换实现 | 飞书复用 `switchP2pSession`（含归属校验）；钉钉新增 `switchP2pSession`（`saveConversation` 指针 upsert；归属校验在装配层 `switchSession`：`sessionRepo.findById` 核对 `session.userId === context.maoUserId`，实现口径，防「切到别人会话」核心属性；conversation 行 owner/workspace 与换绑后 maoUserId 的错配是既有问题，非本次引入）；微信新增 `switchSession`（`withUserLock` 内 status 互斥翻转） | 三渠道存储模型本就不同（指针表 / 指针表 / status 互斥），按各自既有心智实现，不做抽象层 |
| D5 | 切换时的在跑任务 | 飞书不取消（与引用切换一致，允许并行）；钉钉按 `---` 既有 abandon 序列收尾旧会话；微信先 abort 再切（与其「新消息打断」心智一致） | 渠道语义差异是既定现实，命令跟随渠道心智而非强求统一 |
| D6 | 命令回复形态 | 一律纯文本（各渠道既有 onReply / 返回值通道） | 卡片动作协议不动；飞书 `/stop` 后进度卡照常 PATCH 终态，「已停止」文本 + 卡片终态并存可接受 |
| D7 | 群聊 `/stop` 鉴权 | 不校验触发成员（群会话本就是共享决策面）；私聊命令只操作本人会话 | 卡片按钮有 operator 校验是因为它是 UI 操作；文本命令在群内天然公开。见 §7 R1 |
| D8 | 匹配规则 | trim 后全等（大小写敏感，与群 `/new` 一致）；`/tasks <n>` 用 `/^\/tasks\s+([1-9])$/` | 前缀 / 模糊匹配会误伤正常消息；越界序号回退列表 |
| D9 | 合并窗口与命令（二次评审新增） | 三渠道 `canJoinEntry` 增加命令豁免：纯文本经 `parseChannelCommand` 命中非 `NONE` 不入窗；普通群经 `groupCommandTextOf` 剥名后判定（名单为空不豁免，维持「漏触发优先」）；飞书话题内与 handler 侧同口径——正文剥 @ 名后直判（裸命令与 @ 命令都生效，覆盖 R8/D11 场景；三评补充，话题带 @ 命令原按 `groupCommandTextOf` 会因话题返回 null 而被吞） | 命令被合并批次吞掉后全等匹配失效，`/stop` 会连文带令落进 Agent（§1.3 第 5 条修正）；豁免后走既有「冲刷在窗批次 → 单独触发」保序 |
| D10 | `/tasks` 列表排除群聊绑定会话（二次评审新增） | `listRecentChannelSessionBriefs` 增加 `excludeProjectKeyPrefixes?: string[]` 参数；飞书传 `['feishu-chat-']`（群 + 话题同前缀）、钉钉传 `['dingtalk-chat-']`、微信不传 | 群会话由首次触发者 userId + 渠道 source 落库（`app-feishu-messaging.ts:87-97`、`dingtalk/runtime.ts:126-143`），不过滤会混入私聊列表；p2p 指针切进群会话会形成「群会话历史 + 私聊 workspace」错配（IM 执行 workspace 取 conversation 行，`app-feishu-handler.ts:157`），且群会话属共享决策面。群/话题 project_key 前缀由工厂写死（`dingtalk/workspace.ts:26-32`），判定可靠；不可用 `feishu_session_channel.chat_type` 过滤——隐式 `createConversation`（建会话主路径）不写 channel 行 |
| D11 | 飞书话题内 `/stop` 目标（二次评审新增） | 群命令 `/stop` 先经 `threadSessionControl.findSession`（只读）查话题映射：命中则停话题会话，未命中停群级指针 | 话题有独立会话映射；话题内消息本就免 @ 直达话题会话（R8 依赖此心智），`/stop` 停群级指针会停错会话（群指针可能空闲，话题会话照跑） |

## 4. 详细设计

### 4.1 共享命令解析器 `backend-ts/src/common/channel-command.ts`

```ts
export type ChannelCommand =
  | { kind: 'NEW' }
  | { kind: 'STOP' }
  | { kind: 'TASKS' }
  | { kind: 'TASKS_SELECT'; index: number }
  | { kind: 'HELP' }
  | { kind: 'NONE' };

/** 群聊传入剥 @ 名后的文本；私聊传 context.text。全等匹配，大小写敏感。 */
export function parseChannelCommand(text: string | null | undefined): ChannelCommand
```

- 匹配表：`'/new'→NEW`、`'/stop'→STOP`、`'/tasks'→TASKS`、`/^\/tasks\s+([1-9])$/→TASKS_SELECT`、`'/help'→HELP`，其余 `NONE`。
- 无状态、无 I/O；单测覆盖命中 / 未命中 / `/tasks 0`、`/tasks 10`、`/tasks  帮我…`（不命中）、前后空白、全角空格（trim 后仍等值则命中）。

### 4.2 渠道通用基建：会话简报查询

`session.repository.ts` 新增（service 层加同名转发）：

```ts
export interface ChannelSessionBrief { id: number; title: string | null; phase: string | null; updatedAt: string | null; }
listRecentChannelSessionBriefs(
  userId: number, source: SessionSource, limit: number,
  excludeProjectKeyPrefixes?: string[],
): Promise<ChannelSessionBrief[]>
```

- SQL 口径：`session_type = 'NORMAL'`（排除 SIDE_TASK / 子代理）、`(status IS NULL OR status <> 'ARCHIVED')`、`notDeleted()`、`ORDER BY updated_at DESC`；`excludeProjectKeyPrefixes` 非空时对每个前缀追加 `AND project_key NOT LIKE CONCAT(prefix, '%')`（D10；`project_key` 无索引，但前缀过滤作用在 user_id + source 索引（`idx_session_user_agent_source_updated`，V109）筛完的小结果集上，量级可忽略）。列表渲染时进行中标记用既有 `isActivePhase(phase)`（`session/util/session-group-key.ts:264`）。
- 飞书 / 钉钉 / 微信分别传 `'feishu'` / `'dingtalk'` / `'weixin'`——IM 里只回看本渠道的任务，桌面 / CLI 会话不出现在列表里（有意收窄，见 §7 R5）。

### 4.3 飞书

**handler（`feishu/agent-inbound-handler.ts`）**

1. 抽剥名 helper：把 `isGroupNewSessionCommand` 内的剥名逻辑抽为 `groupCommandTextOf(event): string | null`（`botMentionNames` 为空返回 null——维持「漏触发优先」；非群 / 话题内返回 null），`isGroupNewSessionCommand` 改为其上的 `=== '/new'`。群命令统一走它。
2. **私聊**：`resolveP2pInbound` 内、`---` 判定处扩展为 `isNewSessionCommand(context.text) || parseChannelCommand(context.text).kind === 'NEW'`（等价：`/new` 与 `---` 同走 `control.createSession` 分支）；随后在同一临界区内依次判定 `STOP / TASKS / TASKS_SELECT / HELP`：
   - `STOP`：`session = await control.findActiveSession(...)`；null → 回复「当前没有进行中的任务。」；有 → `ok = await this.options.stopRunning?.(session.id)`，回复 ok ?「已停止当前任务。」:「当前没有进行中的任务。」拦截返回。
   - `TASKS`：`briefs = await this.options.listChannelSessions?.(context.maoUserId!, 5)`（新 options 埠，签名统一 `(userId, limit)`，source 由装配层闭包绑定；`maoUserId` 由 processor 入站时已解析进 context，见 `feishu/inbound-processor.ts:203`——不是「p2p 控制内解析的 triggerUserId」，那是 control 方法内部值，handler 拿不到）；渲染列表并回复「回复 /tasks <序号> 切换，如 /tasks 2」。拦截。
   - `TASKS_SELECT`：`active = await control.findActiveSession(...)`；越界（index > briefs.length）→ 回退列表；目标即当前 →「已在当前会话。」；否则 `control.switchSession(...)`（既有归属校验），返回 null（指针行不存在 / 归属拒绝——列表过期间隙目标被删或转移）→ 回退列表；成功回复切换确认（§4.6）。拦截。
   - `HELP`：回复命令一览。拦截。
3. **群聊**：`onGroupMessage` 在 `isGroupNewSessionCommand` 判定旁新增：`groupCommandTextOf(context)` 得 `STOP` / `HELP`：
   - `STOP`：目标按 D11 解析——`threadId != null` 时先 `threadSessionControl.findSession(accountId, context)`（只读），命中以话题会话为目标，未命中落回群级；群级目标为 `messageService.findGroupSession(accountId, chatId)`（message.service 新增薄转发，内部即既有 `repository.findGroupConversation`，只读）；null →「本群还没有会话。」；否则 `stopRunning(conversation.sessionId)` 同上。拦截。
   - `HELP`：群命令一览（不含 /tasks）。拦截。
4. 新增 options：`stopRunning?: (sessionId: number) => Promise<boolean>`、`listChannelSessions?: (userId: number, limit: number) => Promise<ChannelSessionBrief[]>`。均未配置时对应命令回复「暂不支持」并**拦截**（不让命令文本落进 Agent——命令不进 Agent 是全案前提；二次评审明确此语义，测试直调 / 旧装配安全降级）。

**装配（`app-feishu-handler.ts`）**

- 把卡片服务的 `cancelRunning` 闭包（`:458-467`）抽为具名 `stopRunningSession`，同时喂给 `FeishuCardActionService` 与 handler `options.stopRunning`——同一实现，杜绝两份取消口径。
- `options.listChannelSessions`：`(userId, limit) => sessionService.listRecentChannelSessionBriefs(userId, 'feishu', limit, ['feishu-chat-'])`（D10 前缀过滤在装配层绑定，handler 不感知）。
- **D9 合并窗口豁免**：`feishu/inbound-processor.ts` 的 `canJoinEntry`（`:422-436`）在既有豁免旁增加：p2p 文本 `parseChannelCommand(text).kind !== 'NONE'` 不入窗；普通群 `groupCommandTextOf(event)` 非 null 且命中非 `NONE` 不入窗（名单为空维持既有的不豁免——群文本仍照常入窗，触发时剥名不命中即普通消息，漏触发优先）；话题内正文剥 @ 名后直判（与 handler `groupChannelCommand` 话题分支同口径）。

### 4.4 钉钉

**handler（`dingtalk/agent-inbound-handler.ts`）**

1. **私聊**：`onP2pMessage` 临界区内、`isNewSessionCommand` 判定并列处加 `parseChannelCommand`：
   - `NEW` → 复用既有 `openNewSession(context)`（`---` 完整语义：abandon + cancel + settleCancel + dropQueued）。
   - `STOP` / `TASKS` / `TASKS_SELECT` / `HELP`：结构与飞书私聊同构；切换新增调用 `control.switchSession`（见下）。
2. **群聊**：`onMessage` 非 p2p 分支前加命令判定（text 已由 `cleanText` 剥 @）：仅 `STOP` / `HELP`。`STOP` 用 `messageService.findActive(accountId, context.conversationId)`（conversation 表 group 行同样有存，只读）——null →「本群还没有会话。」；否则 `stopRunning`。
3. 新增 options：`stopRunning?`、`listChannelSessions?`（装配层转发）；`DingtalkP2pSessionControl` 增加可选 `switchSession(accountId, context, targetSessionId): Promise<{ id } | null>`。

**service / 装配（`dingtalk/message.service.ts`、`dingtalk/runtime.ts`）**

- `message.service.ts` 新增 `switchP2pSession(accountId, context, targetSessionId, ownerUserId)`：归属校验（经 `sessionFactory` 侧 `sessionRepo.findById` 核对 `session.userId === ownerUserId`，未绑定或归属不符返回 null 并 warn——口径对齐飞书 `app-feishu-handler.ts:201-215`）→ `repository.saveConversation({ botId, conversationId, chatType:'p2p', sessionId: target, ownerUserId, ... })`（既有 upsert）。
- `runtime.ts` 把卡片 `cancelRunning` 闭包（`:478-486`）抽具名函数同喂两处；`p2pSessionControl` 补 `switchSession` 装配；`listChannelSessions` 绑定 `(userId, limit) => sessionService.listRecentChannelSessionBriefs(userId, 'dingtalk', limit, ['dingtalk-chat-'])`（D10）。
- **D9 合并窗口豁免**：`dingtalk/inbound-processor.ts` 的 `canJoinEntry`（`:196-205`）在既有 p2p `---` 豁免旁增加：`parseChannelCommand(event.text).kind !== 'NONE'` 不入窗（`event.text` 已由 `cleanText` 剥 @，p2p / 群统一适用；群 `/tasks` 未实现但 `/stop` `/help` 同样豁免——命令不参与合并是渠道无关口径）。

### 4.5 微信

**handler（`weixin/agent-inbound-handler.ts`）**

`onMessage` 在会话解析（`:144`）与 `bindWeixinSessionPeer` 之后、`nextGeneration` / `abortRunningExecution` **之前**插入命令分支（此时 `session`、`userId` 已就绪）：

- `STOP`：运行判定 `this.cancelFlags.has(sessionId) || this.deps.agentLoop?.getCancelFlag?.(sessionId) != null`——无 → 回复「当前没有进行中的任务。」；有 → `abortRunningExecution(sessionId, userId)` 后回复「已停止当前任务。」。**不 bump generation、不落库、不开新执行**：旧循环由取消标志走既有 `finishCancelledSession` 收尾；本条命令消息因未 `saveMessage` 而自然消失。
- `NEW`：`await this.deps.weixinSessionService.createNewSession(userId)`（新方法，见下）→ 回复「已开启新会话，后续消息将在新的上下文中处理。」。拦截。**注意：不调用 `abortRunningExecution`**——旧会话若在跑，让它跑完写回旧会话（与飞书 `---`「允许并行」一致；微信互斥靠 ACTIVE 单行，互不污染）。
- `TASKS` / `TASKS_SELECT` / `HELP`：同构飞书私聊；`TASKS_SELECT` 调用 `switchSession(userId, targetId)`。
- 未命中文本逐字节走原链路（含 `abortRunningExecution` 在内的既有行为完全不变）。
- **D9 合并窗口豁免**：`weixin/inbound-processor.ts` 的 `canJoinEntry`（`:175-180`，纯文本即入窗）增加：批条目正文（`extractMessageBody`）trim 后 `parseChannelCommand` 命中非 `NONE` 不入窗；豁免条目按既有「冲刷在窗批次 → 单独触发」保序（`common/inbound-merge-window.ts:51-52`）。注意不豁免时 `/stop` 与前序消息合并的后果比飞书 / 钉钉更糟：合并批会先走 `abortRunningExecution` 把在跑任务打断，再把它当任务文本执行。

**service（`weixin/session.service.ts`）**新增三方法，均在既有 `withUserLock` 内：

- `createNewSession(userId)`：`findActiveByUserAndProjectKey` 命中则 `sessionRepo.updateFields(id, { status: 'ARCHIVED' })`；随后复用 `getOrCreateWeixinSession` 内同款 `sessionService.createSession(..., WEIXIN_PROJECT_KEY, ..., 'weixin', ...)` 建新 ACTIVE 会话（抽公共私有方法避免两份建会话参数）。
- `listRecentSessions(userId, limit)`：转发 §4.2 查询（`source='weixin'`）。
- `switchSession(userId, targetId)`：`sessionRepo.findById(targetId)` 校验 `userId` 归属、`project_key = WEIXIN_PROJECT_KEY`、未删除——不符返回 null；当前 ACTIVE 会话 `updateFields(status:'ARCHIVED')`；目标 `updateFields(status:'ACTIVE')`（目标本就是当前 ACTIVE → 返回特殊值「已在当前会话」）；**若旧会话有在跑执行（handler 传入 abort 回调或在 handler 侧完成 abort）先取消**（D5：微信心智是新会话打断旧执行）。

### 4.6 文案表（常量与渠道既有文案并列，中英混合禁用、emoji 禁用）

| 场景 | 文案 | 对齐来源 |
|---|---|---|
| /new 成功 | `已开启新会话，后续消息将在新的上下文中处理。` | 飞书 / 钉钉既有 `NEW_SESSION_CONFIRM_TEXT` 逐字复用 |
| /stop 成功 | `已停止当前任务。` | 飞书卡片取消终态文案（`card-action.service.ts` buildQueueCardText） |
| /stop 空闲 | `当前没有进行中的任务。` | 新增 |
| /tasks 空列表 | `该渠道还没有任务记录。` | 新增 |
| /tasks 列表 | `1. 标题（进行中）· 5 分钟前` 多行 + 尾行 `回复 /tasks <序号> 切换` | 标题超 20 字截断（对齐钉钉 `NEW_SESSION_TITLE_MAX_CHARS` 口径）；进行中徽标用 isActivePhase |
| /tasks 切换成功 | `已切换到「{标题}」，后续消息将以该会话上下文为准。` | 对齐飞书 `SWITCH_SESSION_CONFIRM_TEXT` |
| 已在当前会话 | `已在当前会话。` | 新增 |
| /help | 命令一览（按渠道可见命令渲染） | 新增 |

## 5. 行为对照表

| 输入（trim 后） | 飞书私聊 | 飞书群聊 | 钉钉私聊 | 钉钉群聊 | 微信 |
|---|---|---|---|---|---|
| `/new` | 新建+切指针（`---` 别名） | 已有行为，不变 | 新建（abandon 旧会话，同 `---`） | 普通消息走 Agent | 归档旧+建新（旧会话在跑则并行跑完） |
| `/stop` | 取消当前绑定会话执行 | 取消群会话执行 | 取消当前绑定会话执行 | 取消群会话执行 | abort 后确认（不落库） |
| `/tasks` | 列最近 5（本人+feishu，排除群聊绑定，D10） | 普通消息走 Agent | 列最近 5（本人+dingtalk，排除群聊绑定，D10） | 普通消息走 Agent | 列最近 5（本人+weixin） |
| `/tasks 2` | 切指针（不取消旧执行） | 普通消息走 Agent | abandon 旧+切指针 | 普通消息走 Agent | abort 旧+status 翻转 |
| `/help` | 命令一览 | 命令一览 | 命令一览 | 命令一览 | 命令一览 |
| 其他任何文本 | 原链路，逐字节不变 | 同左 | 同左 | 同左 | 同左 |

所有命令消息均：不落会话消息流（不 saveUserMessage）、不触发 Agent、不建进度卡；回复走各渠道既有文本通道。**落库口径精确化（二次评审）**：私聊命令不落任何表；群命令消息仍会照常落群日志（飞书在 @ 门禁前统一落日志 `feishu/inbound-processor.ts:227-237`、钉钉 @ 后落 `dingtalk/inbound-processor.ts:111-113`），后续同群消息的【群内最近消息】上下文可能带到 `/stop` 等命令文本——可接受（命令本是群内公开行为），不做日志过滤。

> 群聊两列（飞书群 / 钉钉群）均以「@ 机器人」为前提——未 @ 的群消息在入站门禁处即被丢弃（飞书落群日志后返回、钉钉直接 return），不会进入命令判定（§1.3 第 9 条）。飞书话题内已有会话映射时沿用既有免 @ 放行语义，命令同样生效。

## 6. 兼容与迁移

- **0 数据库迁移**：`feishu_p2p_message` / `dingtalk conversation` / `session.status` 全部复用既有表与值。
- **未命中零影响**：`parseChannelCommand` 返回 `NONE` 时所有代码路径与今日完全一致；命令分支全部是入站处理早期的前置短路。
- **旧装配安全**：`stopRunning` / `listChannelSessions` / `switchSession` 均为可选埠，未配置时命令回复「暂不支持」并拦截（不落进 Agent；实现口径，勘误原文「照旧走原链路」的自相矛盾表述）。
- **客户端无关**：纯服务端行为，desktop / admin / android / agent-cli 无感知。
- **落库口径**：「不落库」指不落会话消息流与入站队列；群日志照常记录命令文本（见 §5 尾注），属既有群日志语义的自然延伸。
- **审计**：命令不走 `/v1/**` HTTP 面，不触 Audit 拦截器；取消副作用与卡片按钮同源，审计口径不变。

## 7. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 群聊 `/stop` 任何成员可停群任务 | 有意决策（群会话共享决策面，与卡片按钮 operator 校验的差异在 §3 D7 写明）；`/help` 文案注明「群内任意成员可停止群任务」。评审若要求收紧，可按飞书群消息日志（`feishu_group_message_log`）取最近触发者校验，钉钉 / 微信需补同款记录——本期不做，另立 |
| R2 | 微信 `/stop` 与「新消息打断」语义叠加 | `/stop` 拦截点在 `nextGeneration` 之前：不打断自己（generation 未变），旧循环由 cancel 标志收尾；未运行时仅回复提示，无副作用 |
| R3 | 钉钉 `/tasks` 切换 / `/new` 的 abandon 序列误伤旧会话排队消息 | 与 `---` 既有序列逐字复用（cancel→settleCancel→dropQueued→abandoned.add），不发明新语义；行为对照表写明「切换会放弃旧会话的排队消息」 |
| R4 | 标题过长 / 列表溢出 | 标题 20 字码点截断（防 emoji 切半——复用仓库码点截断口径教训）；列表固定 LIMIT 5 |
| R5 | 微信归档后旧会话在桌面列表「消失」错觉 | `ARCHIVED` 会话仍可见于列表按 status 筛选（`listSessions` 的 status 参数）；`/tasks` 列表只列未归档项，与 IM 绑定口径一致。设计上接受该差异 |
| R6 | 用户真想发「/tasks」当任务文本 | 等值匹配 + 裸 `/tasks` 只列不执行，误伤面≈0；`/tasks 帮我查…`（带其他文字）不命中正则，照常进 Agent |
| R7 | 飞书群聊名单为空（is_at_me 兜底）时误剥名 | 沿用群 `/new` 既有「名单为空一律不命中」口径（`groupCommandTextOf` 返回 null）——漏触发优于误触发 |
| R8 | 飞书话题内免 @ 场景（映射已存在）下发裸 `/stop` / `/help` 会命中命令 | 既有免 @ 放行语义的自然延伸：该话题内消息本就直达机器人会话，命令生效符合「正与机器人对话」的用户心智；裸 `/tasks` 只列不执行，误伤面≈0。接受，不加话题特判 |
| R9 | 命令落进合并窗口被批次吞掉（三渠道，二次评审新增——原§1.3第5条结论有误） | 定案 D9：三渠道 `canJoinEntry` 增加命令豁免；豁免条目走 `common/inbound-merge-window.ts:51-52` 既有「冲刷在窗批次 → 单独触发」保序；三渠道 processor spec 各补「命令不与前序文本合并、单独触发」用例 |
| R10 | 群聊绑定会话混入私聊 `/tasks` 列表，p2p 指针可切进群会话（二次评审新增） | 定案 D10：`excludeProjectKeyPrefixes` 过滤（飞书 `feishu-chat-`、钉钉 `dingtalk-chat-`）；前缀由两渠道工厂写死，判定可靠 |
| R11 | 飞书话题内 `/stop` 停到群级指针而非话题会话（二次评审新增） | 定案 D11：群命令 `/stop` 先查话题映射（只读），命中停话题会话，未命中停群指针 |
| R12 | `/tasks` 列表跨 bot 可见：同渠道多 bot 的会话互相出现在列表（二次评审新增） | 接受：列表按 user+source 过滤，是「该用户本渠道任务」的合理口径；`/tasks` 切换后 `applyFeishuBotConfig` 把当前 bot 的 Agent/模型套到目标会话——与引用切换既有行为完全一致，不加 bot 维度过滤 |

## 8. 测试

**单元（新增 spec）**

1. `common/channel-command.spec.ts`：五命令命中；`NONE` 兜底；`/tasks 0` / `/tasks 10` / `/tasks abc` / `/tasks  2`（多空白，命中）/ `/TASKS`（大小写敏感，不命中）/ 前后空白与全角空格。
2. `feishu/agent-inbound-handler.spec.ts`：私聊 `/new` 与 `---` 同路径；`/stop` 忙（置取消+确认）/ 空闲（提示）；`/tasks` 列表渲染与截断；`/tasks 2` 归属校验拒绝（他人会话）/ 越界回退列表 / switch 返回 null（指针行不存在）回退列表 / 切换确认；群 `/stop`（有会话 / 无会话 / 话题映射命中停话题会话、未命中停群指针）；名单为空不命中；未命中文本原链路（断言 saveUserMessage 未被调用）。
3. `dingtalk/agent-inbound-handler.spec.ts` + `dingtalk/message.service.spec.ts`：私聊命令矩阵同构；`switchP2pSession` 归属校验 / upsert 指针；群 `/stop` 只读查询（findActive 为 null 不创建）；`/new` 与 `---` 行为一致（abandon 序列断言）。
4. `weixin/agent-inbound-handler.spec.ts` + `weixin/session.service.spec.ts`：`/stop` 忙 / 空闲 / 不落库断言；`/new` 归档+新建（旧 ACTIVE 翻 ARCHIVED）；`switchSession` 归属 / projectKey 校验、ACTIVE 翻转、目标即当前；未命中文本 `abortRunningExecution` 仍被调用（原语义不变）。
5. `session.repository.spec.ts`：`listRecentChannelSessionBriefs` 的 source / session_type / ARCHIVED / 删除过滤 / `excludeProjectKeyPrefixes`（群前缀会话不入列）与 LIMIT 排序。
6. 合并窗口豁免（D9，三渠道 processor spec 各一）：`/stop` 在前序纯文本合并窗口内到达时不入批、冲刷后单独触发；`/stop` 与普通文本同批被豁免后原批次照常合并触发。
7. 豁免误伤面：`/tasks 帮我查…`（带其他文字）等非命令文本照常入窗合并（豁免只对全等命中生效）。

**手工验收**：三渠道真实群 / 私聊各跑一遍命令矩阵（§5）；飞书 `/stop` 后确认进度卡终态正常 PATCH；微信 `/tasks` 切换后下一条消息落目标任务；桌面端同账号观察 `user_message_saved` / `session_status` 事件不受命令消息干扰；合并窗口场景：紧跟一条普通文本后 2 秒内发 `/stop`，确认命令单独触发而非并入批次（三渠道各一遍）。

## 9. 实施步骤与工作量

| 步骤 | 内容 | 量级 |
|---|---|---|
| 1 | `channel-command.ts` + spec | 0.5 人日 |
| 2 | session repo / service 简报查询 + spec | 0.5 人日 |
| 3 | 飞书（剥名抽取、p2p/群分支、stopRunning 埠与装配复用、findGroupSession 转发、话题 /stop 目标、processor 合并豁免）+ spec | 1 人日 |
| 4 | 钉钉（p2p/群分支、switchP2pSession、装配复用、processor 合并豁免）+ spec | 1 人日 |
| 5 | 微信（命令分支、session.service 三方法、切换 abort 协同、processor 合并豁免）+ spec | 1 人日 |
| 6 | 文档（`skills/mao-cli/reference/{feishu-bot,dingtalk-bot,weixin}.md` 命令表）+ `changelog/unreleased/` 碎片 | 0.5 人日 |

合计约 4 人日（含二次评审 D9-D11 增量约 0.5 人日）；`cd backend-ts && npm run build && npm test` 全绿为准出。三渠道实现彼此独立，可按 3→4→5 顺序分批合入，每渠道可独立回滚（删分支即恢复原行为）。
