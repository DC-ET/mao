# 钉钉通道对接调研

> 日期：2026-09-24
> 对照基准：当前已落地的飞书机器人通道（`backend-ts/src/feishu/`，能力截至 0.0.190），不是 2026-08-25 初版方案里「只回文本、不做卡片」的范围。
> 结论用途：判断钉钉能不能按飞书同一套功能逻辑接进来，以及哪些能力必须降级。本文不是实现设计。

## 1. 结论

钉钉**企业内部应用机器人 + Stream 模式**可以按飞书同一条链路接：管理后台多机器人、服务端长连接、私聊与群里 @ 触发、身份绑定、云端会话与工作区、入站排队、进度卡上的取消。接入形态和飞书长连接同级，不需要公网回调。

有四块对不齐。群上下文没有替代接口，按第 5.1 节降级。另外三块即使文档里有近似能力，产品范围也明确不做：

1. **群上下文**。只注入本机器人收到的 @ 往来，加上本条自带的引用正文。
2. **提问**。钉钉会话屏蔽 `ask_user_questions`，不发提问卡。卡片表单变量技术上能动态出题，不采用。
3. **会话**。私聊只支持 `---` 新建会话。不列出、不切换、不用引用切回旧会话。
4. **话题与并行**。不做话题群，不做多 Thread 并行。群固定一个会话；私聊在钉钉侧始终只有一个活跃会话。

第一期做：多机器人 Stream、绑定、私聊文本/图片/文件、群 @ 文本和图片、主动发送回复、进度卡、排队卡、私聊 `---` 新建会话。

现有「任务完成通知」里的钉钉地址是**自定义机器人 Webhook**（`oapi.dingtalk.com/robot/send`），只能往群里推一条文本，没有用户身份、没有收消息。通道不要复用它。

## 2. 飞书通道在做什么

飞书模块按「连接 → 归一化 → 入站处理 → Agent → 出站/卡片」分层，执行引擎复用 `SessionService` / `HarnessService`。钉钉应保持同样的边界，只换平台适配层。

| 能力 | 飞书现状 |
|------|----------|
| 接入 | `@larksuiteoapi/node-sdk` 的 `WSClient`，每个启用机器人一条长连接；`FeishuMonitorService` 按库里的启停做 reconcile。事件处理立刻返回，Agent 放到后台，靠消息 ID 去重 |
| 机器人 | `feishu_bot`：App ID / Secret（AES-GCM）、每机器人独立 Agent 与模型。管理后台 CRUD、启停、连接状态、重连 |
| 身份 | 绑定锚是跨应用的 `union_id`。桌面设置页 OAuth，或飞书里发绑定卡片。开启 ECP 时还要有未过期的 ECP 票 |
| 私聊 | 直接发消息即触发。`---` 新建会话；引用历史消息切回该消息所在会话。同一私聊共享根工作区 |
| 群聊 | @ 机器人才触发 Agent。未 @ 的消息写入 `feishu_group_message_log`，触发时注入最近讨论。一个群一个会话；话题（`thread_id`）另建会话，话题内可免 @ |
| 排队 | 会话忙时入 `feishu_inbound_queue`，发排队卡：立即发送（打断当前任务）或取消本条 |
| 进度卡 | 任务一开始发「正在处理」，按轮次 PATCH 工具摘要；终态写轮数和耗时。按钮：取消、失败重试、打开网页会话。只允许原发送者点 |
| 提问 | `ask_user_questions` 挂在当前进度卡的 `form` 上，回调 `form_value` 唤醒工具。重启后表单作废 |
| 媒体 | 图片下载后走多模态并落 `chat-files/`。独立文件先落盘，下一条文字才触发任务。出站有 `feishu_send_image` / `feishu_send_file`，另有读文档、下载云文档附件 |
| 部署假设 | 长连接只在单实例上跑。蓝绿/多进程同时连会抢事件 |

## 3. 钉钉侧对应能力

钉钉机器人有三类，只有第一类能对上飞书自建应用：

| 类型 | 能做什么 | 和本通道的关系 |
|------|----------|----------------|
| 企业内部应用机器人 | Stream 收消息、OpenAPI 发消息、互动卡片、OAuth 身份 | **采用** |
| 第三方企业应用机器人 | 能力接近，但是给 ISV 跨企业授权用的 | 不做。Mao 是给本企业用的 |
| 自定义机器人 / 群模板机器人 | Webhook 往群里发消息，没有单聊、没有发送者身份 | 就是现有任务通知那条路，不扩展成通道 |

### 3.1 接入：Stream，而不是 HTTP 回调

官方推荐 Stream：应用用 Client ID（旧称 AppKey）和 Client Secret（旧称 AppSecret）建 WebSocket，平台把数据推下来。不需要公网 URL、签名密钥和解密。HTTP 推送仍可用，但是要公网、验签、解密，和飞书长连接的部署方式相反。

一条连接上按 Topic 注册：

| Topic | 作用 | 飞书对应 |
|-------|------|----------|
| `/v1.0/im/bot/messages/get` | 单聊消息，以及群里 @ 机器人的消息 | `im.message.receive_v1` |
| `/v1.0/card/instances/callback` | 卡片按钮/表单回传。创建卡片时 `callbackType=STREAM` | `card.action.trigger` |
| `*` | 开发者后台勾选的事件（通讯录、审批等） | 通道用不到，不要订 |

官方 Node SDK 是 [`dingtalk-stream`](https://www.npmjs.com/package/dingtalk-stream)（仓库 `open-dingtalk/dingtalk-stream-sdk-nodejs`）。连接、心跳、重连由 SDK 做，和飞书把长连接交给 `WSClient` 一样。OpenAPI 建议继续用 Node `fetch` 调 `api.dingtalk.com`，不必引入体积很大的 Tea SDK。

约束和飞书相同，而且文档写得更硬：

- 应用要能访问公网。
- 每个客户端默认一条 WebSocket；一个应用最多约 50 条连接。
- 卡片示例明确要求：**同一个 Client ID 同一时间只跑一个 Stream**。线上和本地同时连会抢回调。生产仍按单实例部署，reconcile 启停，不要在蓝绿两个进程上各拉一条。
- 机器人消息要尽快 ACK。卡片回传要在 **2 秒**内返回（飞书进度卡回调大约是 3 秒）。Agent 执行不能放在回调里。文档还要求不要在卡片回调处理过程中再调「更新卡片」接口，需要更新时把新变量放在回调响应里；耗时更新改成回调返回之后再调更新接口。

机器人要在开发者后台选 **Stream 模式并发布**。未发布时，入站里的 `senderStaffId`（企业内 userid）经常不返回，绑定对不上人。

### 3.2 收消息

回调里和通道有关的字段：

| 字段 | 含义 |
|------|------|
| `conversationType` | `"1"` 单聊，`"2"` 群聊 |
| `conversationId` | 会话 ID，群发消息时就是 `openConversationId`（`cid...`） |
| `msgId` | 加密消息 ID，用来去重 |
| `msgtype` | `text` / `richText` / `picture` / `audio` / `video` / `file` |
| `senderStaffId` | 企业内 userid。**发布上线后**才有；外部群里的外部用户为空 |
| `senderUnionId` | 发送者 unionId。部分文档列为可选，不能当唯一锚 |
| `senderNick` | 昵称，可作群里的显示名 |
| `senderId` | 加密发送者 ID。文档写明不要拿它当 userid |
| `robotCode` | 机器人编码，企业内部应用里通常就是本应用的 AppKey |
| `sessionWebhook` / `sessionWebhookExpiredTime` | 本条消息的临时回复地址和过期时间 |
| `text.content` | 文本正文。群里 @ 后正文前常有空格，要 trim |
| `atUsers` | 被 @ 的人，含 `staffId` |
| `isInAtList` | 本机器人是否在 @ 列表中 |

消息类型限制（官方接收消息文档）：

- 单聊（人与机器人）：文本、富文本、图片、语音、视频、文件都能收。语音带 `recognition` 识别文本。
- 群里 @：文本、富文本、图片可以收。**语音、文件、视频不收**。
- 人与人会话里的机器人（酷应用单聊）也不收语音、文件、视频。本通道走的是「人与机器人」单聊，不受这一条限制。

下载：图片/文件回调里是临时 `downloadCode`，调 `POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`（body：`downloadCode` + `robotCode`）换 `downloadUrl`，再把文件拉下来。下载码会过期，而且必须用收到这条消息的那个 `robotCode`。

引用：部分机器人回调在文本上带 `isReplyMsg` 和 `repliedMsg`（被引用消息的类型、正文、媒体 `downloadCode`）。另有接入方报告回调里根本没有被引用消息的 ID 和正文。两套观察都存在，**不能写进第一期设计**，要拿真实回调对一下字段。

### 3.3 发消息

长任务不能靠 `sessionWebhook`。官方示例里 `sessionWebhookExpiredTime` 大约比 `createAt` 晚 90 分钟；社区也有「任务跑完 webhook 已失效、回复丢了」的报告。Mao 任务经常超过这个窗口，重启后续跑时 webhook 一定已经没了。

出站走主动发送，和飞书用 `tenant_access_token` 发消息一样：

| 场景 | 接口 | 寻址 |
|------|------|------|
| 私聊 | `POST /v1.0/robot/oToMessages/batchSend` | `userIds` = 发送者 `senderStaffId`，单次最多 20 人 |
| 群聊 | `POST /v1.0/robot/groupMessages/send` | `openConversationId` = 入站 `conversationId` |

两者都要 `robotCode`、`msgKey`、`msgParam`（JSON 字符串）。权限是「企业内机器人发送消息」`qyapi_robot_sendmsg`。凭证是新版 `accessToken`：`POST https://api.dingtalk.com/v1.0/oauth2/accessToken`，请求头 `x-acs-dingtalk-access-token`。

常用 `msgKey`：

| msgKey | 用途 | 注意 |
|--------|------|------|
| `sampleText` | `{ "content" }` | 纯文本 |
| `sampleMarkdown` | `{ "title", "text" }` | 语法是标题、粗斜体、链接、图片、列表。不同文档对 markdown 长度的写法不一致：有的「建议 500 字」，有的「最大 5000 字」。长回复要截断或拆条，不能照搬飞书「超过 2000 字截断」而不做实测 |
| `sampleImageMsg` | `{ "photoURL" }` | 图片地址 |
| `sampleLink` | 标题、正文、封面、跳转 | 绑定引导、会话详情可以用 |
| `sampleFile` | `{ "mediaId", "fileName", "fileType" }` | 仅 xlsx、pdf、zip、rar、doc、docx。代码、日志、压缩包以外的格式发不出去 |
| `sampleAudio` / `sampleVideo` | 语音、视频 | 通道第一期不必做 |

返回的 `processQueryKey` 是加密消息 ID，可用来撤回和查已读。它是否等于用户后来引用时看到的 `msgId`，文档没有写明。

上传媒体仍走旧接口 `POST https://oapi.dingtalk.com/media/upload`，用的是旧版 `gettoken`，和上面的 `api.dingtalk.com` token **不是同一套**。`media_id` 只在钉钉客户端内有效。图片最大 20MB（jpg/gif/png/bmp），普通文件最大 20MB。

主动发送接口的参数里**没有**「引用某条消息 / reply_id」。群里的回复会是一条新消息，不能像飞书那样引用触发消息。@ 人在这组 OpenAPI 上也不支持（自定义机器人 Webhook 才支持 @）。

### 3.4 卡片

钉钉互动卡片是模板驱动的：

1. 在[卡片平台](https://open-dev.dingtalk.com/fe/card)搭模板、配变量和按钮，发布，拿到 `cardTemplateId`。
2. `POST /v1.0/card/instances/createAndDeliver` 投放。`outTrackId` 由我们生成，相当于飞书的卡片 `message_id`。
3. 场域：单聊 `im_robot.{userId}`，群聊 `im_group.{openConversationId}`。`openSpaceId` 形如 `dtv1.card//IM_ROBOT.xxx` 或 `dtv1.card//IM_GROUP.cid...`。
4. 更新走「更新卡片」或 AI 流式接口 `PUT /v1.0/card/streaming`。流式接口按变量 key 覆盖或追加，`isFinalize` / `isError` 切换卡片状态。权限 `Card.Streaming.Write`。
5. 按钮回传 Topic 见 3.1。用户点的 `actionIds` 和表单值在 `content.cardPrivateData.params`。响应里返回 `cardData` / `userPrivateData`，并用 `updateCardDataByKey` 做增量。公有数据所有人可见，私有数据按 userid 隔离。

AI 流式更新有体积限制，两份官方文档还不一致：单次不要超过 1KB；总大小一份写「不要超过 10KB」，另一份写「建议不要超过 3KB」。markdown 变量必须每次给全量。这个上限装不下 Mao 的完整回复，**不要把助手正文流式灌进卡片**。卡片只放状态、轮次摘要和按钮；正文用 `sampleMarkdown` 另发。

进度卡和排队卡只用按钮和状态变量。钉钉通道不使用表单变量，见第 5.2 节。

### 3.5 身份

钉钉和飞书的身份粒度不一样，但「多机器人绑一次」仍然成立。

| ID | 范围 | 通道里怎么用 |
|----|------|----------------|
| `userid`（`senderStaffId`） | 同一企业内唯一。该企业的多个内部应用看到的是同一个 userid | **入站匹配主键**。私聊发消息也用它 |
| `unionId` | 当前开发者企业账号下唯一。OAuth「获取用户通讯录个人信息」返回的是它 | **绑定表锚点**，用来把扫码登录的人和 userid 对上 |
| `senderId` | 加密，不稳定 | 不入库、不匹配 |
| `corpId` | 企业 | 单企业部署可以只存一份；外部群成员没有 `senderStaffId` |

同一企业里，userid 已经跨内部应用稳定，不需要再像飞书那样用 `union_id` 解决「每个机器人一个 open_id」。OAuth 拿到的却是 unionId，所以绑定流程是：

1. 桌面或卡片按钮打开 `https://login.dingtalk.com/oauth2/auth`（`client_id`、`scope=openid` 或 `openid corpid`、`prompt=consent`）。回调地址必须和开发者后台「登录与分享」里配置的一致。
2. `authCode` 换用户 token，再调「获取用户通讯录个人信息」（`unionId=me`）。
3. 用应用 token 调「根据 unionid 查询用户」得到 userid。
4. 绑定表同时记下 `unionId` 和 `userid`。入站优先用 `senderStaffId`，没有时再看 `senderUnionId`。

未发布、外部群、拿不到 staffId 时，按未绑定处理并打日志，不要用加密 `senderId` 凑合。

Mao 今天没有钉钉登录，只有飞书 OAuth 和 ECP。钉钉通道的绑定是一套新的 OAuth，**不要复制飞书的 ECP 票闸门**。ECP 是飞书身份体系，钉钉用户没有这张票。

通讯录详情（姓名、部门、邮箱、手机）要另开权限。和飞书一样，第一期不必把组织架构注入给 Agent，显示名用 `senderNick` 即可。

## 4. 能力对照

| 飞书能力 | 钉钉可行性 | 说明 |
|----------|------------|------|
| 多机器人、每机器人 Agent/模型、后台启停 | 可对齐 | 一应用一条 Stream。表可以按 `feishu_bot` 的字段来，密钥仍用 AES-GCM。`robotCode` 单独存，避免假定它永远等于 Client ID |
| 长连接、立刻 ACK、断线重连、单实例 | 可对齐 | SDK 负责重连。处理模型照抄飞书：回调里只入队 |
| 私聊触发 | 可对齐 | `conversationType=1` |
| 群 @ 触发 | 可对齐 | 只收到 @ 自己的消息，误触发比飞书少 |
| 群内未 @ 消息入库并注入 | **做不到，按 §5.1 降级** | 只记录机器人收到的 @，并注入本条引用正文。不把这段记录叫做完整群聊 |
| 未绑定引导卡 | 可对齐，链接要短 | ActionCard / 链接消息的 URL 有长度上限（有的文档写 500 字）。学习飞书被截断的教训：卡片按钮指向 Mao 自己的短链，再 302 到钉钉授权页 |
| 私聊 `---` 新建会话 | 做 | 纯文本指令。新建后成为该私聊在钉钉侧的唯一活跃会话 |
| 列出 / 切换会话、引用切回 | **不做** | 没有 `会话`、`切换 N`，引用不改变活跃会话。见 §5.3 |
| 群话题、多 Thread 并行 | **不做** | 一群一会话，私聊不并行。见 §5.4 |
| 入站排队、插队、取消本条 | 可对齐 | 排队卡做成固定模板。插队/取消走卡片回调，2 秒内返回 |
| 进度卡：状态、轮次摘要、耗时、取消、失败重试、会话链接 | 大部分可对齐 | 模板变量更新，不流式灌全文。会话链接同样走短链或确认 URL 长度 |
| `ask_user_questions` | **屏蔽** | 钉钉会话从工具列表去掉该工具，与微信通道相同。见 §5.2 |
| 图片入站（多模态 + 落盘） | 单聊和群 @ 都可以 | `downloadCode` 换链。群 @ 的富文本图片同样有 `downloadCode` |
| 文件入站 | **仅单聊** | 群 @ 收不到文件。单聊可对齐飞书：文件先落盘，下一条文字再跑任务 |
| 语音 | 单聊有识别文本 | 第一期可忽略，或只把 `recognition` 当文本。群里没有 |
| 出站文本 | 可对齐 | 主动发送，截断长度按实测的 `sampleMarkdown` 上限，不预设 2000 |
| 出站引用回复 | **做不到** | 接口没有 reply 参数。群里就是一条新消息 |
| 出站图片 | 可对齐 | 上传拿 `media_id`，或 `sampleImageMsg` 的 `photoURL`。两套 token 都要维护 |
| 出站文件 | 部分对齐 | 扩展名白名单比飞书窄，20MB |
| 读钉钉文档 / 下载钉钉文档附件 | 未纳入 | 钉钉文档是另一套 OpenAPI，和机器人消息无关。飞书的 `feishu_read_doc` 不要在第一期找等价物 |
| 网页端会话跟着飞书任务刷新 | 与平台无关 | 飞书入站已经会把执行过程推到已打开的网页。钉钉只要走同一套 `HarnessService`，这条不用在钉钉侧重做 |
| ECP 登录闸门 | 不适用 | 钉钉绑定成功即可用，除非产品以后单独要求 |

## 5. 四块缺口：替代方案与降级

补查了企业机器人、酷应用、卡片变量、助理 API 和消息查询。群上下文没有等价接口。提问、列出会话、话题并行文档里有近似做法，产品决定不采用。

### 5.1 群上下文

飞书能注入最近群聊，是因为 `im.message.receive_v1` 在申请对应权限后能收到群里没 @ 机器人的消息。钉钉这边对过的入口：

| 入口 | 实际给到的内容 |
|------|----------------|
| 企业机器人 `/v1.0/im/bot/messages/get` | 单聊，以及群里 @ 本机器人的消息。接收消息文档的字段表里没有「订阅全部群消息」 |
| 群聊酷应用事件 | `im_cool_app_install` / `im_cool_app_uninstall`，以及成员进出、改名、解散。事件体是群 ID 和操作人，没有消息正文 |
| 个人 IM 事件 `user_im_message_receive_group_all` | 当前登录用户能看到的群消息。这是个人身份的事件流，不是企业机器人回调。用它补上下文等于拿某个员工的眼睛读群 |
| 消息菜单 H5「获取消息内容」 | 用户在客户端里点选一批消息后，JSAPI 才返回 `msgList`。不是进群就自动入库 |
| 已读查询 | `/v1.0/robot/groupMessages/query`、`/v1.0/robot/oToMessages/readStatus` 只返回已读人和发送状态，不返回正文。没有按 `msgId` 拉历史的企业机器人接口 |

个人事件和消息菜单都不接入。

降级到这个程度：

- 只落库机器人真正收到的群消息（每一次 @）以及机器人自己发出的短摘要。
- 下一次 @ 时，把这段记录放在用户消息前面，标题写明「只有 @ 机器人的往来，不是完整群聊」。条数可以少，例如最近 10 次 @。
- 本条回调如果带了引用正文（`repliedMsg` 里有文本），接在这段记录后面。用户想让机器人看到某句没 @ 的话，就引用那条，或把原话贴进 @ 内容。
- 不建飞书那种全量群日志，提示词里也不要假设看过旁人的讨论。

群聊多轮追问仍然成立，缺的是没 @ 时的旁路讨论。

### 5.2 提问：屏蔽 `ask_user_questions`

产品决定钉钉通道不提供这个工具。

卡片平台有表单变量，运行时可以传入 `fields`（文本、单选、多选）做成独立提问卡。这条路不走。钉钉会话组工具列表时去掉 `ask_user_questions`，处理方式和微信通道一致：模型看不到该工具。不发布提问模板，不解析卡片下面的文字当作答案。需要用户作选择时，模型用普通文字问，下一条消息按新的入站处理。

### 5.3 会话：只新建，不列出、不切换

产品决定钉钉通道不做会话列表，也不做切换。

飞书靠消息 ID 把引用切回旧会话。钉钉发消息不能指定回复目标；引用机器人自己的卡片时经常没有正文，也没有按消息 ID 拉回原文的接口。即便以后 ID 能对上，也不做「引用即切换」，不做 `会话` / `切换 N`。

钉钉侧的会话规则：

- 私聊 `---` 新建会话，并把活跃指针切到它。之后钉钉消息都进这个会话。
- 当前会话还在执行时收到 `---`：取消当前执行，再新建。同一私聊不并行两条执行。
- 引用里有正文：注入到本次用户消息前，仍留在当前会话。
- 旧会话留在网页 / 桌面，钉钉里回不去。

### 5.4 话题群与多 Thread 并行：不做

产品决定不做话题群，也不做多 Thread 并行。

钉钉收发协议、场景群、酷应用都没有话题 ID。Assistant API 的 Thread（`POST /v1.0/assistant/threads/{threadId}/messages`）是钉钉 AI 助理自己的对话容器，不接入。

落到通道上：

- 群：一个（机器人，`conversationId`）一个会话。忙了排队，不按话题拆开，也不免 @。
- 私聊：钉钉侧只有当前这一个活跃会话。`---` 是换一条新的当前会话，不是再开一条并行 Thread。
- 不建话题映射表，不把某条消息当成话题根。

## 6. 建议的模块边界

不新造执行引擎。钉钉目录与飞书平行，会话、队列、取消、工作区策略复用同一类端口。

```
钉钉客户端（私聊 / 群 @）
        │  Stream
        ▼
backend-ts/src/dingtalk/
├─ monitor.service.ts          # 扫启用机器人，一机器人一个 dingtalk-stream 客户端
├─ event-normalizer.ts         # 收成与飞书同形的内部消息：chatType、sender、msgId、文本、媒体码
├─ inbound-processor.ts        # 绑定校验、私聊/群分流、下载、去重后交给 handler
├─ agent-inbound-handler.ts    # 排队、代际、进度卡。逻辑对齐飞书，卡片调用换成钉钉模板更新
├─ card-action.service.ts      # /v1.0/card/instances/callback：取消、重试、排队
├─ message.service.ts          # 私聊会话、群会话、工作区
├─ binding.routes.ts           # 设置页绑定 / 解绑
└─ admin.routes.ts             # 机器人 CRUD
        │
        ▼
SessionService / HarnessService / 现有工具（通道专用工具另注册）
```

归一化之后，handler 不要出现钉钉字段名。这样排队、取消、`---` 新建会话可以沿用飞书已经验证过的状态机，而不是再写一套。

工作区建议和飞书对称：

- 私聊：机器人 × 用户，`projectKey` 带 bot id 和 user id。
- 群：机器人 × `conversationId`，目录放在独立命名空间，不挂某个用户的个人目录。`session.userId` 记群内第一个完成绑定的成员。
- 解绑只让机器人认不出这个人，不删会话和工作区。

群成员白名单仍建议自动维护：已绑定的人 @ 过就入表。管理后台不做群成员手工增删，和飞书一致。

## 7. 分期

### 第一期：能对话、能看进度、能停

- 管理后台配置多个企业内部机器人（Client ID、Secret、robotCode、Agent、模型），Stream 热启停。
- 设置页绑定 / 解绑；未绑定回一张「点我绑定」卡，按钮走短链。
- 私聊：文本、图片、文件。群：@ 后的文本、图片。群文件直接说明不支持。
- 回复走主动发送。进度卡模板：执行中 / 完成 / 失败 / 取消，变量放状态、最近工具摘要、轮次和耗时；按钮为取消、失败重试、打开会话（短链）。
- 会话忙时排队卡：立即发送、取消本条。
- 私聊 `---` 新建会话；执行中收到 `---` 先取消再新建。不列出、不切换。引用正文只注入当前会话。
- 钉钉会话屏蔽 `ask_user_questions`（§5.2）。
- 群上下文只用 @ 往来加本条引用（§5.1）。一群一会话，无话题、无并行 Thread（§5.4）。
- 单实例长连接。消息 ID 去重。

明确不做：`ask_user_questions`、会话列表、切换会话、引用切会话、话题群、多 Thread 并行、群全量日志、出站引用、钉钉文档工具、语音视频、组织架构注入、多实例抢连接、用个人 IM 事件读群。

### 第二期：只收紧消息限制

按实测收紧 `sampleMarkdown` 和 `sampleFile` 的长度、扩展名，以及群图片是否稳定。不补提问卡，不补会话切换，不补话题。

### 不建议排期的

- 用自定义机器人 Webhook 冒充通道。
- 为了群上下文去抓客户端或非公开接口。
- 把 AI 流式卡片当成飞书进度卡的替代品来灌全文。体积上限和质量不稳定，状态卡 + 单独正文更接近现在飞书的阅读方式。
- 第一期就做钉钉文档读取。那是独立产品，和「先能在钉钉里跑任务」无关。

## 8. 开放平台准备清单

做一个企业内部应用即可打通第一期，多机器人就多建几个应用。

1. 创建企业内部应用，拿到 Client ID / Client Secret。
2. 添加机器人，消息接收选 Stream，填写机器人名称后发布。
3. 权限至少包括：企业内机器人发送消息、卡片实例写、AI 卡片流式更新（若进度卡用流式接口）、上传媒体、根据 unionid 获取用户、通讯录个人信息读。
4. 卡片平台发布两张模板：进度卡、排队卡。绑定引导若用链接消息可以不单独做模板。不发布提问表单卡。
5. 「登录与分享」配置回调域名，和设置页、短链最终跳转的地址一致。
6. 后端增加加密密钥（与 `APP_FEISHU_BOT_SECRET` 同类，不要复用飞书那把钥匙的配置项名，避免两个通道耦合）。

开发期注意：不发布就没有 `senderStaffId`，绑定和私聊主动发送都会失败。联调应用和线上应用分开，避免两条 Stream 抢同一个 Client ID。

## 9. 风险

| 风险 | 影响 | 处理 |
|------|------|------|
| 同一 Client ID 多条 Stream | 消息和卡片回调被另一套环境拿走，表现为「有时没反应」 | 和飞书一样单实例；本地调试用另一个应用 |
| 未发布就没有 userid | 全员未绑定，或私聊发不出去 | 发布后再测绑定；日志里区分「没有 staffId」和「未绑定」 |
| 群里看不到未 @ 的讨论 | Agent 只能看到 @ 往来和本条引用 | 注入时标明不是完整群聊；需要旁路讨论时让用户引用或贴原文 |
| 卡片模板发布才能改交互 | 进度卡文案和按钮的迭代比飞书慢 | 模板变量尽量留宽；交互结构第一期定死 |
| 卡片回调 2 秒，且回调里不能再调更新接口 | 把 Agent 或 PATCH 放进回调会导致超时、按钮弹回 | 回调只改内存状态并返回新变量；重活异步 |
| markdown / URL / 文件类型限制 | 长回复、长授权链接、非白名单文件失败 | 短链、截断、明确错误文案 |
| 内容安全（不安全外链、不合适文本） | 代码或日志被钉钉拒发 | 失败要回写到进度卡，不要静默 |
| 外部群没有 staffId | 外部成员无法绑定 | 第一期只支持企业内部群和内部员工单聊 |
| 两套 access token | 发消息用新 token，上传文件用旧 token，混用会 401 | 适配层分开缓存、分开提前刷新 |
| 流式卡片体积文档互相矛盾 | 按 10KB 设计会在另一环境被拒 | 正文不进流式变量 |

## 10. 参考

飞书实现（对照用）：

- `backend-ts/src/feishu/`，入口 `monitor.service.ts`、`inbound-processor.ts`、`agent-inbound-handler.ts`、`progress-card.ts`、`card-action.service.ts`
- `skills/mao-cli/reference/feishu-bot.md`
- `docs/plan/2026-08-25-feishu-bot-technical-design.md`（初版范围，卡片和多会话以当前代码为准）
- `docs/plan/2026-09-24-feishu-card-ask-user-questions-design.md`

钉钉开放平台（2026-09-24 检索）：

- [事件订阅概述](https://open.dingtalk.com/document/development/event-subscription-overview)（Stream 与 HTTP）
- [开发 Stream 模式推送服务端](https://open.dingtalk.com/document/orgapp/develop-stream-mode-push-server)
- [Stream 协议 Topic](https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md)
- [接收消息](https://open.dingtalk.com/document/development/receive-message)
- [批量发送人与机器人会话消息](https://open.dingtalk.com/document/development/chatbots-send-one-on-one-chat-messages-in-batches)
- [机器人发送群聊消息](https://open.dingtalk.com/document/development/the-robot-sends-a-group-message)
- [企业机器人发送消息类型](https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots)
- [上传媒体文件](https://open.dingtalk.com/document/development/upload-media-files)
- [下载机器人接收消息的文件](https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message)
- [创建并投放卡片](https://open.dingtalk.com/document/development/create-and-deliver-cards)
- [卡片回调](https://open.dingtalk.com/document/development/event-callback-card)
- [AI 卡片流式更新](https://open.dingtalk.com/document/development/api-streamingupdate)（总大小「建议 3KB」）与[另一份流式文档](https://open.dingtalk.com/document/app/api-streamingupdate)（总大小「10KB」）
- [网页登录获取个人信息](https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information)
- [查询用户详情](https://open.dingtalk.com/document/orgapp/query-user-details)（userid / unionid 定义）
- [感知群变化](https://open.dingtalk.com/document/orgapp/group-change-awareness-event-subscription)（酷应用安装/卸载与群成员，无消息正文）
- [获取消息内容](https://open.dingtalk.com/document/orgapp/obtain-message-content)（消息菜单 H5，需用户点选）
- [卡片变量类型](https://open.dingtalk.com/document/development/variable-type)（含表单变量、本地变量）
- [绑定变量](https://open.dingtalk.com/document/development/binding-variables)（循环渲染、条件显隐）
- [助理 API 调用流程](https://open.dingtalk.com/document/development/assistantapi-call-process)（Thread 属于钉钉 AI 助理，不是群话题）
- Node SDK：<https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs>
