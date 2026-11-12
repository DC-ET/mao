# 钉钉互动卡片模板（排队 / 进度 / 终态一卡到底）

`dingtalk-card.json` 是 Mao 钉钉机器人互动卡片在钉钉开放平台卡片编辑器的导入文件（V192 起排队与进度合并为单一模板，一卡到底）。
排版与飞书进度卡同构：状态行 + 完整回复正文 + 本轮工具列表；排队态显示「立即发送 / 取消排队」，执行中显示「取消任务」，终态隐藏取消 / 重试等操作按钮、保留「会话详情」（completed 态另有「👎 不满意」点踩）。同时出现的按钮排在同一行（横排 ButtonList，与官方审批模板的「拒绝 / 同意」相同）。

## 怎么用

1. 打开[钉钉开放平台](https://open.dingtalk.com) → 你的企业内部应用 → **卡片平台** → 新建/编辑模板
2. 找**导入**入口（模板列表页右上角或「…」菜单），选择本 JSON 导入，会覆盖当前模板
3. **保存**，然后点**发布**——只保存不发布的话，投放用的还是上一个已发布版本，你会以为「改了没生效」
4. 到 Mao 管理后台「钉钉机器人」把**卡片模板**填成发布后的模板 ID（排队/进度共用这一个）

> 卡片列表里模板 ID 带 `.schema` 后缀是正常的，直接照抄，不要手动去掉。
> 若投放报 `param.templateUnpublished`，说明模板还是草稿，去卡片平台点发布。

**改完模板先自检再导入**：`node template/check-template.js`。它检查变量声明、Markdown 绑定、
按钮 actionId / actionType / 可见性 / 请求成功判定条件是否与后端契约一致，下面「改模板时的注意点」
里的坑它都能抓到。

## 这个文件有两份数据，按钮可见性必须用 boolean 变量

`dingtalk-card.json` 顶层有两个字段：

| 字段 | 作用 |
|------|------|
| `editorData` | 卡片平台可视化编辑器的 schema（JSON 字符串），**组件树、变量、按钮配置都在这里** |
| `widgetInfo` | 平台导出时生成的渲染快照（XML 字符串），**客户端实际渲染它** |

**按钮可见性必须用「boolean 变量 + isTrue」。** 曾经把可见性写成
「变量 `status`（string）`isEqual` `running`」，`editorData` 里条件完整、平台也照原样保留，
但平台生成的 `widgetInfo` 把条件抹成了空串：

```xml
visibility="@triple{'' , 'visible', 'gone'}"   <!-- 条件位是空串，恒假，按钮永远 gone -->
```

官方样例模板证明，只有 boolean 变量的 `isTrue` / `isFalse` 才会被渲染成可用的
`@data{...}` 条件（`@triple{@data{data.cardData.ready}, 'visible', 'gone'}`）。
所以按钮显隐改用 `canCancel` / `canRetry` 两个 boolean 变量，由后端
`card-body.ts` 的 `progressCardParams` 按状态下发（`running` → `canCancel=true`，
`failed` → `canRetry=true`，其余状态都为 `false`）。

> 踩坑过程：最初误判「客户端看 widgetInfo 不看 editorData」，转而只改 XML，无效；
> 再改 `editorData` 的 `isEqual` 条件，导入后仍被抹成空串，依旧无效。
> 最终靠平台导出的真实模板 + 官方样例才定位到「字符串比较不被渲染」这一约束。

## 变量契约（后端 `cardParamMap` 传入）

| 变量 | 类型 | 说明 |
|------|------|------|
| `title` | string | 卡片标题：`正在处理` / `处理完成` / `处理失败` / `任务已取消` |
| `body` | markdown | 正文，形如 `**状态：处理完成** · 共 3 轮 · 耗时 44 秒` + 空行 + 回复全文 + `**本轮工具**` 列表 |
| `status` | string | `running` / `completed` / `failed` / `cancelled`，**不渲染成文本**，仅作语义占位 |
| `canRun` | boolean | `true` 时显示「立即发送」+「取消排队」按钮（仅排队态） |
| `canCancel` | boolean | `true` 时显示「取消任务」按钮（仅 `running` 态） |
| `canRetry` | boolean | `true` 时显示「重试」按钮（仅 `failed` 态） |
| `canFeedback` | boolean | `true` 时显示「👎 不满意」点踩按钮（仅 `completed` 态；点击 toggle，文案随 `dislikeText` 翻转） |
| `canOpenSession` | boolean | `true` 时显示「会话详情」跳转按钮（进度/终态恒 `true`，排队态 `false`） |
| `requestOk` | boolean | 按钮回调成功标记。仅成功回包为 `true`，失败回包为 `false`。五个回传按钮的 Toast 都用 `isTrue(requestOk)` 判定 |
| `dislikeText` | string | 点踩按钮文案：`👎 不满意` ↔ `👎 已点踩 · 再点取消`（后端按 toggle 态下发） |
| `sessionUrl` | string | 会话详情深链 `/tasks/{id}`（「会话详情」按钮跳转目标） |
| `senderUserid` | string | 原发送者（按钮回调鉴权：只有本人能操作自己的卡片） |
| `queueId` | string | 队列行 ID（排队态回调定位） |
| `sessionId` | string | 会话 ID |
| `tag` | string | 卡片标签（当前后端未传，模板保留占位） |
| `config` | object | 卡片配置。子字段 `autoLayout`（boolean）为 `true` 时 PC 端按内容自适应宽度。投放走 `sys_full_json_obj`，不作为普通字符串字段传入 |

状态 `status` 取值并集：排队 `queued` / 已插队 `started` / 已取消 `cancelled` / 执行中 `running` / 完成 `completed` / 失败 `failed`。

按钮可见性：立即发送 `isTrue(canRun)`、取消排队 `isTrue(canRun)`（与「立即发送」同态并排）、点踩 `isTrue(canFeedback)`（仅完成态）、取消任务 `isTrue(canCancel)`、重试 `isTrue(canRetry)`、会话详情 `isTrue(canOpenSession)`（非排队态恒显，排序殿后）。
**不要再改回「`status` 字符串 `isEqual` 比较」**——平台不会把它渲染成可用条件。按钮可见性和「请求成功判定」都受这条约束。

## 改模板时的注意点

- **按钮可见性只能用「boolean 变量 + isTrue」**：字符串变量做 `isEqual` 比较时，平台导入后会把 `widgetInfo` 里的条件抹成空串（`@triple{'' , 'visible', 'gone'}`），按钮恒隐藏。要改按钮显隐就改 `canCancel` / `canRetry` 的下发逻辑（后端 `card-body.ts`），不要改条件写法
- **不要删 `status` 变量**：删了按钮条件会悬空，取消/重试按钮会行为异常（`status` 可以不显示，但必须在变量表里）
- `body` 是单个 markdown 变量，后端会把状态行、正文、工具列表拼成一个字符串再传，上限 6000 字符（与飞书进度卡正文相同；状态行和工具列表算在这 6000 里）
- **卡片头部不要再放标题**：状态已由 `body` 首行「**状态：正在处理** · 第 1 轮」表达，`Card.cardName` 和 Grid 里的 `${title}` 文本都已删掉，再加回去就是同一信息出现两次
- 卡片回调依赖四个 `actionId`：`run`（立即发送插队）、`cancel`（**「取消排队」与「取消任务」两个按钮共用**，靠 `canRun` / `canCancel` 可见性互斥）、`retry`（失败重试）、`dislike`（完成卡点踩 toggle），改按钮时别改这四个 id
- **「会话详情」是 `actionType: url` 的跳转按钮**：无 actionId、无成功判定条件，url 绑 `${sessionUrl}`；自检脚本对它走独立校验分支
- **`actionId` 必须填字面量**（`run` / `cancel` / `retry`），不能留空也不能绑变量：空 `dynamicString` 时点击不上报 actionId，后端 `parseCardCallback` 取不到值、整个回调分支不会触发（取消按钮曾因此完全无响应）
- **按钮 `status` 不能是 `disabled`**：置灰且不响应点击，取消/重试都点不动（重试按钮曾遗留该值）
- **按钮点击事件类型必须是「回传请求」**：若是「打开链接」，点击只会跳转、不会触发后端回调（重试按钮就曾因此完全失效）
- **「请求成功判定条件」必须是 `isTrue(requestOk)`，不能用 `status == '...'`**：和按钮可见性是同一类坑。`editorData` 里写成字符串 `isEqual` 时，平台照单保留，但编译进 `widgetInfo` 的 `@dtConditionalHandler` 第一参会被抹成空串。空条件恒假，客户端永远弹失败 Toast（「取消失败，任务可能已结束」/「取消失败，该消息可能已开始处理」），同时仍应用回包里的 `body`/`status`，所以卡片已经变成「已取消」。五个回传按钮（立即发送、取消排队、点踩、取消任务、重试）统一绑 `isTrue(requestOk)`。后端成功回包带 `requestOk=true`，失败回包只把 `requestOk` 置 `false`、不改其余字段。`status` 仍随终态更新，但不再参与 Toast 判定
- **按钮用横排 ButtonList（`direction: horizontal`），并带区块级 `visible`**（恒显示那个）：这是官方审批模板里「拒绝 / 同意」那一排的组件，窄屏也保持同一行（卡片宽度 ≤ 360 时两颗按钮均分，更宽时按文字宽度横排）。不要改回 ButtonBlock——它在非 PC、或卡片宽度 < 440 时会强制改成竖排，手机上「不满意」和「会话详情」就会叠成两行。区块级 `visible` 缺了的话整个按钮区块都不渲染，取消/重试会一起消失；单个按钮的显隐仍靠各自按钮里的可见性条件。按钮图标留空，点踩的 👎 来自 `dislikeText` 文案，不要套审批模板的拒绝/同意图标
- **PC 宽屏自适应靠 `config.autoLayout`，投放时传入布尔 `true`**：在变量表声明对象变量 `config`，下面加 boolean 子字段 `autoLayout`。开放接口的 `cardParamMap` 普通值只能是字符串，布尔值要放进 `sys_full_json_obj`：`{"config":{"autoLayout":true}}`。放在 `cardData` 下与 `cardParamMap` 平级、或只把组件宽度改成 `match_parent`，PC 端都不会变宽。创建时写入即可，之后的增量更新会保留。模板重新导入并发布后，新投放的卡片才生效
- **`preview` 变量已删除**：V192 起排队态正文也走 `body`（`queueCardParams` 拼状态行 + 消息摘要），不要在变量表里再加回 `preview`
- 一卡到底链路：排队卡实例在消息被消费时**就地升级**为进度卡（`updateCard` 增量刷新，不新建卡片），升级后同一张卡走完整生命周期（技术方案 2026-11-11-dingtalk-card-single-card §4）
- **点踩汇入与桌面/飞书同一张统计表**（source=`dingtalk`，固定 NO_REASON）；重复点击 toggle 取消
- **上线前需在钉钉客户端实测的三个首次依赖机制**：①按钮文案 `${dislikeText}` 变量插值（此前按钮全是静态文本）；②URL 按钮跳转变量 `${sessionUrl}`（此前无 URL 按钮）；③回调 cardParamMap 增量 merge 只传 `{status, dislikeText}` 是否正确保留其余变量（即方案 R1 的回调形态）

## 相关代码

| 关注点 | 位置 |
|--------|------|
| 卡片参数拼装（状态行 / 正文 / 工具列表） | `backend-ts/src/dingtalk/card-body.ts` |
| 投放与更新（`createAndDeliverCard` / `updateCard`） | `backend-ts/src/dingtalk/card-client.ts` |
| 卡片生命周期（建卡、进度推送、终态、恢复） | `backend-ts/src/dingtalk/runtime.ts` |
| 飞书同构实现（对照参考） | `backend-ts/src/feishu/progress-card.ts` |
| 使用说明与排障 | `../reference/dingtalk-bot.md` |
