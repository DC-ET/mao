# 飞书合并转发消息展开

## 一、需求背景

用户把飞书聊天记录合并转发到机器人私聊，或在群里把合并转发发给机器人时，Agent 只能看到固定英文 `Merged and Forwarded Message`，看不到被转发的原文。

这是飞书接口的契约，不是文案映射漏了。`im.message.receive_v1` 里合并转发的 `message_type` 为 `merge_forward`，`content` 固定是这句话（JSON `{"text":"Merged and Forwarded Message"}`，或解析失败时的纯文本）。子消息不在事件里。官方说明：合并转发新消息的内容是固定值，子消息要用「获取指定消息的内容」另拉（[获取指定消息的内容](https://open.feishu.cn/document/server-docs/im-v1/message/get)、[合并转发消息](https://open.feishu.cn/document/server-docs/im-v1/message/merge_forward)）。

当前入站把这段 `content.text` 原样当成用户正文：

- `event-normalizer.ts` 的 `extractText` 读取 `content.text`。
- `inbound-processor.ts` 的 `normalizeText` 只在文本为空时才生成类型占位符。这句话非空，私聊触发、群 @ 触发、群消息日志都带上它。
- 引用预取和卡片回拉已经调用 `GET /open-apis/im/v1/messages/:message_id`（`fetchFeishuMessageDetail`），但只取 `data.items[0]`。合并转发的第一条就是外壳，正文仍是那句英文。

单条转发（不是合并转发）一般保持原来的 `text` / `post` / `image`，事件里就有正文，不在本需求内。

## 二、需求描述

### 2.1 要做的

1. `message_type = merge_forward` 在交给 Agent 之前展开成可读摘录：每条子消息保留时间、发送人、正文。文本、富文本、卡片抽出文字；图片、文件、语音、视频、表情包沿用现有占位符，并带上**子消息**的 `message_id`。
2. 私聊，以及群里这条合并转发本身会触发 Agent（@ 机器人，或已有话题会话的免 @）时，**同步展开**后再入站。本轮用户消息必须是摘录，不能仍是英文固定句。
3. 群里未触发的合并转发走现有 `enrich_pending`：先落占位，展开成功后回写 `feishu_group_message_log.content`。后续 @ 的【群内最近消息】读到的是摘录。水位线规则不变：未富化完的行挡住水位线。
4. 引用一条合并转发时同样展开。群日志里已经是摘录则直接用日志；日志仍是固定英文，或私聊没有日志时，再调接口。
5. 子消息本身又是 `merge_forward`（整包再转发）时递归展开，深度有上限。
6. 展开失败、消息已删除、无权限时保留现在这句英文，打日志，不阻断入站、不向用户报错。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 解析接收事件里的隐藏字段 | 事件 content 没有子消息，也没有子消息 id |
| 改「获取会话历史消息」 | 历史接口对合并转发同样只返回固定英文 |
| 上线前已入库的历史行回补 | 水位线已经推过的旧行不再重放。之后若被引用，且日志内容仍是固定英文，引用路径会重新展开 |
| 展开时预下载全部图片和文件 | 一条转发里可能有几十个附件。文本摘录带 `msg=`，需要时走现有 `feishu_download_file` |
| 转发附言的特殊拼接 | 用户转发时另打的说明是另一条普通文本，现有入站已经能看到 |
| 单条转发 | 事件里已有原文 |
| 新表 / 迁移 | 群日志 `content` 是 `TEXT`。入库的是截断后的摘录加文件路径，不存全文 |
| 新开飞书权限的产品流程 | 与现有拉消息详情共用权限。群里引用预取若已成功，则不用改应用权限；失败码 `230027` 由运维补 `im:message.group_msg` |

## 三、方案

用已经在用的 `GET /open-apis/im/v1/messages/:message_id`。查询合并转发那条 `message_id` 时，`data.items` 为 **1 条外壳 + N 条子消息**：

- 外壳 `msg_type = merge_forward`，正文仍是固定英文，丢弃。
- 其余每条有自己的 `message_id`、`msg_type`、`body.content`、`sender`、`create_time`、`mentions`，并用 `upper_message_id` 指回这一层外壳。
- 机器人不必在原始会话里。子消息挂在当前这条、已经投递到本私聊或本群的合并转发上。

一次 GET 只展开一层。子项若仍是 `merge_forward`，用该子项的 `message_id` 再 GET。

`fetchFeishuMessageDetail` 继续只返回 `items[0]`，给下载工具和普通消息兜底用。合并转发另走新函数，避免把「按子消息 id 查一张图片」读成整包摘录。

数据流：

```
im.message.receive_v1  message_type=merge_forward
        │
        ▼
normalizeText（正文仍是固定英文，先不阻断）
        │
        ├─ 私聊，或群里本条会触发 Agent
        │     await expandMergeForward
        │     成功 → 替换 event.text，群日志回写摘录并清 enrich_pending
        │     失败 → 保持英文，清 enrich_pending，本轮照常触发
        │
        └─ 群里未触发
              先落日志，enrich_pending=1
              异步 expandMergeForward
              成功则 updateGroupMessageContent；无论成败都 markGroupMessageEnriched
        │
        ▼
Agent 用户消息 / 【群内最近消息】/ 【引用的消息】看到摘录
```

群日志先落占位再回写，与图片、文件、卡片同一套水位线，不把 GET 放进 `runInChatOrder`，避免一次慢请求挡住同群后续消息入库。本条若会触发 Agent，在 `onMessage` 之前 await 展开，用户消息用展开结果，不依赖从日志再读一遍（触发消息本身不会进入【群内最近消息】）。

## 四、详细设计

### 4.1 拉取与分层

新增 `backend-ts/src/feishu/merge-forward.ts`。对同一个 `message_id` 调现有 GET（保留 `card_msg_content_type=user_card_content`，转发里的卡片才能拿到原始 JSON）。

从 `items` 中取出子消息：`upper_message_id` 等于本次查询的 `message_id`。没有 `upper_message_id` 的那条是外壳，跳过。若响应里只有外壳、没有任何子消息，视为展开失败，调用方保留英文。

子消息按 `create_time` 升序。`deleted = true` 的渲染为「（已撤回）」，不解析 content。

递归：子消息 `msg_type = merge_forward` 时再展开。限制：

| 限制 | 值 | 原因 |
| --- | --- | --- |
| 递归深度 | 3 | 飞书不允许把已带 `upper_message_id` 的子消息拆出来再合并，但可以把整包再转发。三层足够，并挡住异常循环 |
| 单次渲染条数 | 100 | 与客户端一次合并转发的选择上限同量级。超出的条数在摘录末尾写「其余 M 条未展开」 |
| 内联字数 | 4000 | 这是用户正文，不是引用旁注。引用注入的 500 字阈值太短，这里不复用 `buildQuotedInjection` 的阈值 |

同一 `message_id` 在一次展开中只请求一次。

查询参数 `user_id_type` 不传，发送人 id 用默认 `open_id`，与现有 `contact.v3.user.basicBatch` 一致。

### 4.2 摘录格式

每一条非嵌套子消息一行，时间用 `create_time`（毫秒）格式化为 `YYYY-MM-DD HH:mm`（Asia/Shanghai），与群日志行的日期时间可读性对齐：

```
【合并转发，共 3 条】
[2026-10-08 09:12] 张三：大家好，这个告警看一下
[2026-10-08 09:13] 李四：[图片 msg=om_child_image]
[2026-10-08 09:14] 王五：已处理
```

嵌套再包一层标题，子行缩进两个空格：

```
【合并转发，共 2 条】
[2026-10-08 09:20] 张三：外层说明
[2026-10-08 09:21] 张三：
  【合并转发，共 1 条】
  [2026-10-07 18:00] 赵六：内层原文
```

正文规则：

- `text` / `post` / `interactive` 走现有 `describeMessageText`。卡片降级文案 `请升级至最新版本客户端，以查看内容` 已在该函数里被丢掉。
- `text`、`post` 里的 `@_user_N` 用该子消息 `mentions[].name` 换成 `@姓名`，与 `event-normalizer.ts` 的 `replaceMentionKeys` 相同。抽成两边共用的小函数，或在展开侧复制同一替换，避免 Agent 只看到占位符。
- `image` / `file` / `audio` / `media` / `sticker` 用 `describeMessageText` 的占位符，`msg=` 必须是子消息 id，不能是外壳 id。`feishu_download_file` 用这个 id 再 GET 一次：普通图片或文件的 `items[0]` 就是该子消息，现有 `fetchFeishuMessageDetail` 能拿到 `file_key`。表情包维持工具里已有的「平台不支持下载」错误。
- 富文本里内嵌的图片仍是 `describeMessageText` 的「 [图片] 」，没有单独的 `msg=`。下载工具只认消息顶层的 `file_key` / `image_key`，与今天普通 post 未预下载时一样，本期不补。
- 发送人：先收集本层及嵌套里 `sender_type = user` 的 open_id，按 50 个一批调用已有的 `contact.v3.user.basicBatch`（不受通讯录授权范围限制）。`sender_type = app` 用现有机器人占位名；`anonymous` 写「匿名」。查不到姓名时用 open_id，不因此让整包失败。

### 4.3 超长落盘

内联超过 4000 字时，全文写入会话工作区 `quoted/merge-forward-{外壳messageId}.txt`（与引用全文同一目录，不新开目录）。提示词和群日志里保留前 4000 字，并追加一行：全文见 `@{绝对路径}@`。

工作区路径沿用 `resolveFeishuChatWorkspace`：群聊按 chatId，私聊按 `private-{userId}`。目录不存在则创建。这与群图片预下载相同，不要求 `feishu_chat` 行已经存在。

落盘失败时只保留前 4000 字，末尾加「（其余已截断）」，不阻断入站。

群日志 `content` 只存这段内联文本（含文件提示），不存未截断全文，避免顶满 `TEXT`（64KB）。

### 4.4 入站接入

`FeishuInboundProcessorOptions` 增加：

```ts
expandMergeForward?: (accountId: string, messageId: string, workspace: string | null) => Promise<string | null>;
```

返回 `null` 或空串表示失败。`create-app.ts` 里用 bot 的 tenant token 调 4.1，姓名解析复用 `resolveFeishuSenderName` 的批量版本（不要对每个发送人各打一次，合并转发里经常是同一批人）。

`inbound-processor.ts`：

1. `messageType === 'merge_forward'` 算进 `needsEnrich`，群日志 `enrich_pending=1`。
2. 私聊在 `onMessage` 之前 await。成功则替换 `text`。
3. 群聊在确定 `mentioned`（含话题免 @）之后：会触发则 await，再 `updateGroupMessageContent`；不会触发则 `void` 异步展开，模式与 `prewarmGroupCardText` 相同。无论成败都要 `markGroupMessageEnriched`，否则水位线永远停在该行之前。
4. 固定英文的判断只认 `messageType`，不拿文案做分支。文案只用于「日志里还没展开」的识别（见 4.5）。

未授权、未绑定的分支发生在展开之后也可以，但展开会多一次 GET。放在授权通过之后再展开：未绑定用户的合并转发不拉子消息。群里未 @ 的消息不经过授权，仍按 4.4 第 3 点异步展开，否则【群内最近消息】永远是英文。这与今天群里未 @ 的卡片、图片也会预拉一致。

### 4.5 引用

`create-app.ts` 的 `resolveQuotedMessage`：

1. 群日志命中且 `msgType !== 'merge_forward'`：保持现在的日志优先。
2. 群日志命中、`msgType === 'merge_forward'`、且 `content` 不是固定英文：说明已经展开过，直接用日志（超长时日志里已有文件路径）。
3. 其余（私聊、日志未命中、日志仍是固定英文）：对 `parentId` 调用 `expandMergeForward`。工作区用现有 `resolveQuotedWorkspace`；定位失败则只做 4000 字截断。
4. 父消息不是合并转发时，仍走 `fetchFeishuMessageDetail`，行为不变。

话题内 `parent_id === root_id` 的跳过规则不变。那是话题根，不是用户主动引用。

### 4.6 权限与错误

| 条件 | 要求 |
| --- | --- |
| 调用身份 | 现有 bot `tenant_access_token`，不改用 user token |
| 单聊 | `im:message` 或 `im:message:readonly` 之一。获取单聊消息文档还提到可与 `im:message.history:readonly` 组合，以开发者后台已开通且当前引用预取能成功为准 |
| 群聊 | 在单聊权限之外再开 `im:message.group_msg`。机器人必须在群里 |

失败只打 `console.warn`（带 `messageId` 和飞书 `code`），然后降级：

| code | 含义 | 处理 |
| --- | --- | --- |
| 230027 | 缺权限 | 保留英文 |
| 230002 | 机器人不在群 | 保留英文 |
| 230110 | 消息已删除 | 保留英文 |
| 230050 | 对当前调用方不可见 | 保留英文 |
| 其他 / 网络错误 | | 保留英文 |

不把错误文案写进 Agent 上下文，避免模型把权限错误当成用户内容。

## 五、改造清单

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | GET 全量 items、递归、摘录渲染、字数与条数上限、落盘 | `backend-ts/src/feishu/merge-forward.ts`、`merge-forward.spec.ts` |
| 2 | `@_user_N` 替换若从 normalizer 抽出，两边共用 | `event-normalizer.ts`（仅当抽出函数时） |
| 3 | 合并转发同步展开（触发路径）与异步富化（群未触发） | `inbound-processor.ts`、`inbound-processor.spec.ts` |
| 4 | 装配展开函数；引用合并转发走展开 | `create-app.ts` |
| 5 | 姓名批量查询，供展开使用；单条入站仍走现有缓存 | `create-app.ts` 中现有 `resolveFeishuSenderName` 旁 |
| 6 | 单测见第六节 | 上表 spec |
| 7 | 发版说明与使用说明 | 根 `CHANGELOG.md`；`skills/mao-cli/reference/feishu-bot.md` 补一句：合并转发会展开为聊天摘录，超长时全文在会话工作区 `quoted/` |

不改：`fetchFeishuMessageDetail` 的 `items[0]` 语义、`feishu_download_file` 的参数、表结构、微信 / 钉钉通道、桌面端。

## 六、测试计划

`cd backend-ts && npm test`，至少覆盖：

- 外壳加三条子消息（text、image、file）：摘录不含 `Merged and Forwarded Message`；图片和文件占位符里的 `msg=` 是子消息 id；顺序按 `create_time`。
- `@_user_N` 换成 mentions 里的姓名。
- 子消息再次是 `merge_forward`：第二层 GET 被调用，摘录嵌套；深度超过 3 时停止并有未展开提示。
- 超过 100 条、超过 4000 字：内联截断，全文写入 `quoted/merge-forward-{id}.txt`；写文件失败时只有截断、不抛错。
- `deleted = true` 渲染为已撤回。
- GET 返回 `230027` 或抛错：展开结果为 null。
- 入站：私聊 `merge_forward` 在 `onMessage` 的 `text` 已是摘录。群 @ 同步展开并回写日志。群未 @ 先以 `enrich_pending=1` 入库，异步回写后清标记；展开失败也清标记。
- 引用：日志已是摘录则不再 GET；日志仍是固定英文，或私聊无日志时 GET 并注入【引用的消息】。普通文本引用仍走 `fetchFeishuMessageDetail`。
- `fetchFeishuMessageDetail` 对普通图片消息仍只读 `items[0]` 的 `image_key`（防止展开改造把下载兜底读坏）。

手工：用真实合并转发（含一条图片）在私聊发给机器人，确认 Agent 用户消息是摘录，且 `feishu_download_file` 用子消息 id 能下到图。群里先发一条不 @ 的合并转发，再 @ 机器人，确认【群内最近消息】里是摘录而不是英文。

## 七、风险与对策

| 风险 | 对策 |
| --- | --- |
| GET 慢，拖住本轮触发 | 只在会触发的那条上 await；同群其他消息的入库不进这次等待。失败立即降级 |
| 未 @ 的合并转发富化未完成，后面的 @ 被水位线挡住 | 与图片、卡片相同，这是现有语义。富化结束（含失败）必须清 `enrich_pending` |
| 摘录过长撑爆提示词或群日志 `TEXT` | 内联 4000 字，全文落工作区；日志只存内联 |
| 子消息发送人没有姓名 | 批量通讯录失败时退回 open_id，摘录仍然交付 |
| 转发里的 post 内嵌图不能按张下载 | 本期只保证独立 image/file 子消息可下载。内嵌图保持「 [图片] 」文字 |
| 应用缺 `im:message.group_msg` 时群展开全部失败 | 私聊仍可用。群失败保留英文并打 `230027`，由运维补权限，不在代码里申请权限 |
| 历史消息已经以英文进过会话 | 不回放旧水位线。新转发、以及之后引用到的未展开日志会走新逻辑 |
