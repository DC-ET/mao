# 钉钉进度卡 / 排队卡模板

`dingtalk-progress-card.json` 是 Mao 钉钉机器人**进度卡**在钉钉开放平台卡片编辑器的导入文件。
排版与飞书进度卡同构：状态行 + 完整回复正文 + 本轮工具列表，终态后只保留结果、隐藏操作按钮。

## 怎么用

1. 打开[钉钉开放平台](https://open.dingtalk.com) → 你的企业内部应用 → **卡片平台** → 新建/编辑模板
2. 找**导入**入口（模板列表页右上角或「…」菜单），选择本 JSON 导入，会覆盖当前模板
3. **保存**，然后点**发布**——只保存不发布的话，投放用的还是上一个已发布版本，你会以为「改了没生效」
4. 到 Mao 管理后台「钉钉机器人」把**进度卡模板 ID** 填成发布后的模板 ID

> 卡片列表里模板 ID 带 `.schema` 后缀是正常的，直接照抄，不要手动去掉。
> 若投放报 `param.templateUnpublished`，说明模板还是草稿，去卡片平台点发布。

## 变量契约（后端 `cardParamMap` 传入）

| 变量 | 类型 | 说明 |
|------|------|------|
| `title` | string | 卡片标题：`正在处理` / `处理完成` / `处理失败` / `任务已取消` |
| `body` | markdown | 正文，形如 `**状态：处理完成** · 共 3 轮 · 耗时 44 秒` + 空行 + 回复全文 + `**本轮工具**` 列表 |
| `status` | string | `running` / `completed` / `failed` / `cancelled`，**不渲染成文本**，仅用于按钮可见性条件 |
| `tag` | string | 卡片标签（当前后端未传，模板保留占位） |

按钮可见性：取消任务 `status == running`，重试 `status == failed`。终态卡片不带按钮，
与飞书进度卡「终态 PATCH 不带按钮、随卡片重写自动消失」是同一思路。

## 改模板时的注意点

- **不要删 `status` 变量**：删了按钮条件会悬空，取消/重试按钮会行为异常（`status` 可以不显示，但必须在变量表里）
- `body` 是单个 markdown 变量，后端会把状态行、正文、工具列表拼成一个字符串再传，上限 1500 字符
- 卡片回调依赖两个 `actionId`：`cancel`（取消任务）、`retry`（失败重试），改按钮时别改这两个 id
- 排队卡是另一个模板（`queueCardParams`：`title` / `preview` / `status` / `queueId` / `senderUserid`），不要与进度卡混用

## 相关代码

| 关注点 | 位置 |
|--------|------|
| 卡片参数拼装（状态行 / 正文 / 工具列表） | `backend-ts/src/dingtalk/card-body.ts` |
| 投放与更新（`createAndDeliverCard` / `updateCard`） | `backend-ts/src/dingtalk/card-client.ts` |
| 卡片生命周期（建卡、进度推送、终态、恢复） | `backend-ts/src/dingtalk/runtime.ts` |
| 飞书同构实现（对照参考） | `backend-ts/src/feishu/progress-card.ts` |
| 使用说明与排障 | `../reference/dingtalk-bot.md` |
