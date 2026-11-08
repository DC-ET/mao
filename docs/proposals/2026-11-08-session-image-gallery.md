# 提案：会话图片快览 —— 散落各轮的图片一网打尽，点击回跳原消息

> 图片密集的会话（图片生成、截图分析、多轮视觉对比）里，图片散落在各轮消息与工具卡片中：想找「十几轮之前生成的那张图」，只能滚动硬翻。各处的单点预览都做了——用户消息图片有 el-image 灯箱（`MessageBubble.vue:44-50`，`preview-src-list`）、图片生成卡片有网格与放大（`ToolImageGenView.vue:9-22`、`:49`）——但**没有跨轮次的会话级集合视图**，全仓无任何 gallery 实现。而拼出这个视图的零件全部现成：图片数据在前端 store 已加载的消息与工具富视图里，跳转有 `useMessageLocate`（`LOCATE_FLASH_KEY` 定位 + 高亮闭环，批次 23 打磨过），灯箱 el-image 自带多图浏览。

- 状态：已否决（2026-11-08：图片密集会话是低频场景，暂无需求。见 [README](README.md) 台账）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小-中（约 1.5-2 人日；**零数据库迁移、零后端改动**，数据全部来自前端已加载轮次）
- 关联：`desktop/src/components/chat/{MessageBubble,ToolImageGenView,ChatPanel,ChatInputToolbar}.vue`、`desktop/src/composables/useMessageLocate.ts`、`desktop/src/utils/toolRichView.ts`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 用户消息图片 | el-image 灯箱，单条消息内可翻 | `MessageBubble.vue:44-50`（`preview-src-list="message.images"`） |
| 图片生成工具产出 | 卡片内网格 + 放大，失败项带路径复制 | `ToolImageGenView.vue:9-22`、`previewList`（`:49`） |
| 会话级图片集合视图 | **无** | 全仓无 gallery 匹配 |
| 图片 → 原消息跳转 | `useMessageLocate` 已有：定位 + 滚动 + 高亮闪 | `useMessageLocate.ts:8,22` |
| 抽屉范式 | el-drawer 会话级浮层有先例（收件箱 / 用量） | `InboxDrawer`、`UsageDrawer` |

## 2. 目标 / 非目标

**目标**

1. **P1 会话图片快览抽屉**：当前会话内**已加载轮次**的全部图片聚合为一网格（用户消息图 + 图片生成工具成功产出图），按时间倒序（最新在前）；缩略图网格 + 单图信息（来源消息角色 / 相对时间）。
2. **P1 全会话灯箱**：抽屉内点击任意图，el-image `preview-src-list` 传**全会话图片列表**——灯箱内左右翻可横跨整个会话的图片（单点预览今天做不到的）。
3. **P1 跳回原消息**：网格图下方「定位」按钮 → 关闭抽屉 → `useMessageLocate` 滚动定位到来源消息 + 高亮闪；边路会话图跳边路面板（同会话域内）。
4. **P1 入口**：`ChatInputToolbar` 加图标按钮（`aria-label="会话图片"`，符合图标按钮命名规范），带图片计数徽标；主聊天与边路面板各自持有本会话的抽屉。

**非目标**

- **不做全历史回溯**：覆盖当前已加载轮次（REST `roundLimit` 分页口径一致），抽屉头部注明「已加载 N 轮内的图片」；加载更早轮次后网格自动纳入，不做一次性拉取全会话。
- 不做文件 / 视频 / 音频附件快览（文件在文件管理器有完整交互，图片是唯一散落不可枚举的媒体）。
- 不做图片保存到工作区 / 批量下载（工具产出已可在工作区文件系统按 path 取用）。
- 不做失败产出的聚合（失败项在卡片内已带原因与路径）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 交付物中心（批次 11 否决） | 不登记不可变交付物、无生命周期语义，纯只读视图。 |
| 分享一览（批次 22 否决） | 与分享无关，是会话内媒体聚合。 |
| 消息级上下文菜单（2026-11-08 驳回） | 不重组任何操作入口，新增的是内容集合视图。 |
| 工具卡片完整化（批次 23 已落地） | 卡片内富视图不动，本提案是其上的会话级聚合层。 |

## 4. 方案设计

- 数据收集：`utils/session-images.ts` 纯函数 `collectSessionImages(messages, toolRichViews)`——遍历已加载消息：`message.images`（用户 / 助手消息）+ 图片生成工具的富视图 `items`（成功项），产出 `{ url, sourceMessageId, ts }[]`；来源与 `MessageBubble` / `ToolImageGenView` 同一份数据字段，不重复解析。
- 组件：`components/chat/SessionImageGalleryDrawer.vue`（el-drawer，会话级实例挂 `ChatPanel`；边路面板 `SideChatPanel` 复用同组件）。
- 灯箱：网格 el-image 统一 `preview-src-list` = 全部 url（全会话横翻），`initial-index` 定位点击项。
- 跳转：定位按钮调既有 `useMessageLocate`（同会话内）；跨面板（主 ↔ 边路）不做跳转——**定案：快览与跳转都在当前面板会话域内**，另一面板的图片不进本抽屉。
- 流式期间：新图随轮次完成进入网格（数据 watch 驱动，不做特殊处理）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `utils/session-images.ts` + `components/chat/SessionImageGalleryDrawer.vue`；`ChatInputToolbar.vue`（入口按钮 + 徽标）；`ChatPanel.vue` / `SideChatPanel.vue`（抽屉挂载）；测试新增 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI（触屏点选 / 灯箱手势 el-image 自带） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 大会话图片多，网格加载压力 | 缩略图 el-image 懒加载（`loading="lazy"`）；灯箱翻页按需加载原图 |
| 图片 URL 是临时签名 / 会过期 | 与消息气泡 / 工具卡片同一 URL 来源，过期口径一致（重新打开轮次重取），抽屉不做缓存兜底 |
| 富视图解析口径漂移（工具输出结构变化） | 收集函数只读 `toolRichView` 既有 view model 字段，不自行解析原始 JSON；该口径已有回归测试维护 |
| 抽屉与审批 / 提问浮层 z-index 冲突 | 沿用既有 drawer 层级体系（InboxDrawer 同层） |
| 计数徽标与实际网格数不一致（分页加载中） | 徽标与网格同一数据源 computed，天然一致 |

## 7. 测试要点

1. 含用户上传图 + 图片生成产出的会话：网格两类图齐全、时序正确、失败产出不出现。
2. 灯箱：从任意图进入可左右翻遍全会话图片；Esc 关闭回到抽屉。
3. 「定位」：抽屉关闭、滚动到来源消息、高亮闪一次；来源消息不在已加载页时按钮置灰并提示「加载更早轮次后可定位」。
4. 边路会话抽屉只含本边路图片；主 / 边路互不串。
5. 「加载更早」后重开抽屉，更早轮次图片纳入且计数更新。
6. `aria-label` 存在；安卓壳触屏抽屉 / 灯箱手势可用。
7. 源码级断言：收集函数字段来源（`message.images` / 富视图 items）；入口按钮 aria-label。

## 8. 决策记录

待评审确认：

1. **排序方向**：最新在前（P1 取此，找「刚生成的图」高频）还是正序。
2. **入口位置**：ChatInputToolbar 图标钮（P1 取此）还是聊天区顶部——倾向前者，与既有工具钮同排。
3. **无图会话入口形态**：按钮置灰（计数 0）还是隐藏——倾向置灰可见（可发现性）。
