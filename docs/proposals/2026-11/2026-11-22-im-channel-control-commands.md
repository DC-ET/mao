# 提案：IM 渠道控制命令补完 —— /new 三渠道对齐、/stop 文本兜底、/tasks 回看切换

> IM 渠道（飞书 / 钉钉 / 微信）是 README 主打的「免安装」入口，但渠道侧的**会话控制能力**远弱于工作台：文本命令只有飞书群聊 `/new` 一个（还是 11 月刚加的），钉钉 / 微信没有任何命令；停止任务只有进度卡上的按钮，卡片被聊天流刷走或过期后就失去入口（微信连卡片都没有）；「我的最近任务」在 IM 里完全不可见，无法切换回早上的会话继续追问。地基全部现成：渠道入站链路有成熟的文本规范化与防抖合并（钉钉 inbound-processor），取消链路已被飞书 / 钉钉卡片按钮使用（`handleProgressCancel` / `cancel-running.ts`），渠道会话绑定与 URL 跳转有独立 helper（feishu-session.ts），按用户列会话的服务端能力现成。本提案补一组**控制类**文本命令，全部是入站前置短路分支，不匹配的文本逐字节走原链路。

- 状态：已立项
- 日期：2026-11-22
- 技术方案：[docs/plan/2026-11/2026-11-22-im-channel-control-commands-technical-design.md](../../plan/2026-11/2026-11-22-im-channel-control-commands-technical-design.md)
- 提案总览见 [docs/proposals/README.md](../README.md)
- 规模：中（约 2-3 人日；0 迁移；backend 三渠道 inbound handler 各加命令分支 + 1 个共享命令解析 util + spec；无前端改动，回复走既有文本 / 卡片发送能力）
- 关联：`backend-ts/src/feishu/agent-inbound-handler.ts`（`/new` 现状 :100-112）、`backend-ts/src/dingtalk/inbound-processor.ts`（防抖合并 :160）、`backend-ts/src/dingtalk/cancel-running.ts`、`backend-ts/src/feishu/card-action.service.ts`（卡片取消 :153-155）、`backend-ts/src/feishu-session.ts`（渠道会话绑定 / URL helper）、`backend-ts/src/session/session.service.ts`（按用户列会话）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 新建会话命令 | 仅飞书群聊 `/new`（须 @机器人、主题外）；钉钉 / 微信无对应命令，私聊场景飞书也不支持 | `feishu/agent-inbound-handler.ts:100-112`（`text.trim() === '/new'`，钉钉 / 微信 handler 无命令解析） |
| 停止任务 | 飞书 / 钉钉有进度卡按钮（取消 / 重试），但卡片随聊天流上滚即失去入口；微信无卡片，跑偏任务只能干等 | `feishu/card-action.service.ts:153-155`（retry / dislike / cancel）、`dingtalk/cancel-running.ts` |
| 任务回看与切换 | IM 里看不到「我的最近任务」，无列表、无切换；回到旧会话只能去工作台找 | 无任何实现；服务端按用户列会话能力现成 |
| 命令帮助 | 无 `/help`；新用户不知道 `/new` 的存在 | 无 |
| 入站文本链路 | 三渠道均有成熟的规范化 + 防抖合并（合并后 `handler.onMessage` ×1），命令解析有干净的前置短路位置 | `dingtalk/inbound-processor.ts:160-177` |
| 渠道会话绑定 | 渠道上下文已有「当前会话」概念与 pinned session / URL helper | `feishu-session.ts:36-120`（FeishuSessionHelper / PinnedSessionAdapter / SessionUrlHelper） |

## 2. 目标 / 非目标

**目标**

1. **共享命令解析 util**：`common/`（或渠道同级）新增无状态 `channel-command.ts`——识别 `/new`、`/stop`、`/tasks`、`/tasks <序号>`、`/help`，返回归一化结果（命令 + 参数 + 原文其余部分）；三渠道 handler 在入站处理早期（防抖合并之后、组装 Agent 消息之前）调用，命中即短路回复，未命中逐字节走原链路。群聊场景沿用飞书 `/new` 的既有约束口径（@机器人剔除后等值匹配）。
2. **`/new` 三渠道对齐**：钉钉 / 微信补齐同语义命令（替换渠道上下文的会话绑定，回复确认文案）；飞书扩展到私聊场景（现仅群聊）。触发后的新会话创建复用各渠道既有「新建会话」内部链路（群聊 `/new` 已走过的路径），不新增执行语义。
3. **`/stop` 文本兜底**：终止渠道上下文当前绑定的进行中会话——**复用飞书卡片取消与钉钉 `cancel-running` 的同一服务链路**，不新写取消语义；无进行中任务时明确回复「当前没有进行中任务」。飞书 / 钉钉的卡片按钮保留不动，`/stop` 是卡片不可达时的兜底（也是微信的唯一停止入口）。
4. **`/tasks` 回看与切换**：列出该渠道用户最近 5 个会话（序号 + 标题 + 状态 + 相对时间，纯文本或轻量卡片）；`/tasks 2` 把渠道上下文切换绑定到第 2 个并回复确认；微信受回复窗口约束——窗口关闭时返回明确提示（对齐 `WEIXIN_REPLY_WINDOW_CLOSED` 的既有语义口径）。
5. **`/help`**：输出命令一览（各渠道用既有文本 / 卡片发送能力），无参数、无副作用。

**非目标**

- 不做对话内配置定时任务 / 哨兵 / Agent（哨兵对话内配置批次 15 已否决，控制类命令不越界到配置类）。
- 不做跨渠道会话迁移、会话删除 / 重命名命令。
- 不改动既有进度卡按钮行为、防抖合并策略、卡片协议。
- 不做会话历史消息回放（阅读视图批次 28 已否决）。
- 无前端改动：命令回复走渠道既有发送通道。

## 3. 与已落地 / 已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 飞书群聊 `/new`（已落地，unreleased） | 是本提案的既有基础之一；本提案把它对齐到三渠道并补私聊场景 |
| IM 渠道审批闭环（批次 30 否决） | 否决的是审批流进 IM（云端模式无需审批）；本提案是控制命令，不涉及审批 |
| 哨兵对话内配置（批次 15 否决） | 否决的是给哨兵补工具组 / 对话内配置；`/tasks`、`/stop` 是会话控制，不碰哨兵 |
| 会话移交（批次 15 否决） | 那是会话交接给另一用户；`/tasks` 切换的是**同一用户自己的**会话 |
| 待办未响应升级通知（批次 18 已落地） | 那是服务端外推提醒；本提案是用户主动发起的控制 |

## 4. 方案设计

- **命令解析**：`channel-command.ts` 纯函数——输入规范化文本（各渠道 handler 已剥离 @前缀），输出 `{ kind: 'new' | 'stop' | 'tasks' | 'tasks_select' | 'help' | 'none' }`；`/tasks <n>` 要求 n 为 1-9 整数，越界回退列表。等值匹配优先（与 `/new` 同口径），不做模糊前缀，避免误触发正常消息。
- **渠道接线**：三渠道 inbound handler 在既有文本入口处加同一短路分支（约每渠道 1 个调用点 + 各自的回复实现）。防抖合并的批内文本取合并后的首段做命令判定（命令消息本身极短，合并场景实际罕见，但要定清楚口径）。
- **取消链路复用**：`/stop` 调用与 `handleProgressCancel` / `cancel-running.ts` 相同的服务层入口；进行中判定、终态卡片 / 文本回复均复用既有逻辑，只在微信侧补「无卡片渠道」的纯文本终态回复。
- **列表与切换**：`/tasks` 走 session 服务按用户列最近会话（含进行中状态标记）；切换 = 更新渠道上下文绑定（各渠道既有的绑定存储），不复制、不新建会话。切换后下一条消息自然落入目标任务，与工作台切换会话的心智一致。
- **权限口径**：命令只操作**触发者本人可见的会话**（群聊中其他人发 `/stop` 只影响该群绑定的会话，与既有群聊绑定语义一致；私聊只影响本人会话）。
- **兼容性**：无迁移、无契约变更、无 WS 变更；每渠道命令分支独立可回滚（去掉短路分支即恢复原行为）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `common/channel-command.ts` 共享解析 util + spec；飞书 / 钉钉 / 微信 inbound handler 各加命令短路分支与回复实现；`/stop` / `/tasks` 复用既有取消与列会话服务；新增三渠道命令用例 spec |
| admin / desktop / android | 无 |
| agent-cli | 无 |
| 文档 | `skills/mao-cli/reference/feishu-bot.md` / `dingtalk-bot.md` / `weixin.md` 补命令一览；`changelog/unreleased/` 同任务碎片 |
