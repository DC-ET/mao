# 钉钉互动卡片模板（排队 / 进度 / 终态一卡到底）

`dingtalk-card.json` 是 Mao 钉钉机器人互动卡片在钉钉开放平台卡片编辑器的导入文件（V192 起排队与进度合并为单一模板，一卡到底）。
排版与飞书进度卡同构：状态行 + 完整回复正文 + 本轮工具列表；排队态显示「立即发送 / 取消排队」，执行中显示「取消任务」，终态只保留结果、隐藏操作按钮。

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
| `senderUserid` | string | 原发送者（按钮回调鉴权：只有本人能操作自己的卡片） |
| `queueId` | string | 队列行 ID（排队态回调定位） |
| `sessionId` | string | 会话 ID |
| `tag` | string | 卡片标签（当前后端未传，模板保留占位） |

状态 `status` 取值并集：排队 `queued` / 已插队 `started` / 已取消 `cancelled` / 执行中 `running` / 完成 `completed` / 失败 `failed`。

按钮可见性：立即发送 `isTrue(canRun)`、取消排队 `isTrue(canRun)`（与「立即发送」同态并排）、取消任务 `isTrue(canCancel)`、重试 `isTrue(canRetry)`。终态卡片全部 `false`，不带按钮。
**不要再改回「`status` 字符串 `isEqual` 比较」**——平台不会把它渲染成可用条件。

## 改模板时的注意点

- **按钮可见性只能用「boolean 变量 + isTrue」**：字符串变量做 `isEqual` 比较时，平台导入后会把 `widgetInfo` 里的条件抹成空串（`@triple{'' , 'visible', 'gone'}`），按钮恒隐藏。要改按钮显隐就改 `canCancel` / `canRetry` 的下发逻辑（后端 `card-body.ts`），不要改条件写法
- **不要删 `status` 变量**：删了按钮条件会悬空，取消/重试按钮会行为异常（`status` 可以不显示，但必须在变量表里）
- `body` 是单个 markdown 变量，后端会把状态行、正文、工具列表拼成一个字符串再传，上限 6000 字符（与飞书进度卡正文相同；状态行和工具列表算在这 6000 里）
- **卡片头部不要再放标题**：状态已由 `body` 首行「**状态：正在处理** · 第 1 轮」表达，`Card.cardName` 和 Grid 里的 `${title}` 文本都已删掉，再加回去就是同一信息出现两次
- 卡片回调依赖三个 `actionId`：`run`（立即发送插队）、`cancel`（**「取消排队」与「取消任务」两个按钮共用**，靠 `canRun` / `canCancel` 可见性互斥）、`retry`（失败重试），改按钮时别改这三个 id
- **`actionId` 必须填字面量**（`run` / `cancel` / `retry`），不能留空也不能绑变量：空 `dynamicString` 时点击不上报 actionId，后端 `parseCardCallback` 取不到值、整个回调分支不会触发（取消按钮曾因此完全无响应）
- **按钮 `status` 不能是 `disabled`**：置灰且不响应点击，取消/重试都点不动（重试按钮曾遗留该值）
- **按钮点击事件类型必须是「回传请求」**：若是「打开链接」，点击只会跳转、不会触发后端回调（重试按钮就曾因此完全失效）
- **「请求成功判定条件」不能留空**：留空时平台会告警，且成功/失败 Toast 文案都不生效。判定条件要与后端回调契约一致——取消成功时后端回传 `cardParamMap` 把 `status` 置为 `cancelled`，失败路径只回 `tips`、不更新 `status`（仍为 `running`），故 cancel 绑 `status == 'cancelled'`；retry 同理绑 `status == 'running'`
- **ButtonBlock 要带区块级 `visible`**（恒显示那个）：缺了它整个按钮区块都不渲染，取消/重试两个按钮会一起消失；单个按钮的显隐靠各自按钮里的可见性条件
- **`preview` 变量已删除**：V192 起排队态正文也走 `body`（`queueCardParams` 拼状态行 + 消息摘要），不要在变量表里再加回 `preview`
- 一卡到底链路：排队卡实例在消息被消费时**就地升级**为进度卡（`updateCard` 增量刷新，不新建卡片），升级后同一张卡走完整生命周期（技术方案 2026-11-11-dingtalk-card-single-card §4）

## 相关代码

| 关注点 | 位置 |
|--------|------|
| 卡片参数拼装（状态行 / 正文 / 工具列表） | `backend-ts/src/dingtalk/card-body.ts` |
| 投放与更新（`createAndDeliverCard` / `updateCard`） | `backend-ts/src/dingtalk/card-client.ts` |
| 卡片生命周期（建卡、进度推送、终态、恢复） | `backend-ts/src/dingtalk/runtime.ts` |
| 飞书同构实现（对照参考） | `backend-ts/src/feishu/progress-card.ts` |
| 使用说明与排障 | `../reference/dingtalk-bot.md` |
