# 提案：任务产出总览 —— 会话级文件变更与交付物汇总（纯前端）

> 任务收尾时用户最想问的一句是「**这个任务到底产出了什么**」。现状是答案散在两处：文件变更是**轮次级**的——长会话里每轮聊天流内插一条「文件变更 (n)」折叠条，收尾要逐轮翻找；交付物（`send_image` / `send_file` 已发送的图片 / 文件）在聊天流里独立展示，与文件变更是两套信息。Git 管理器只覆盖 git 仓库，非 git 工作区连任务级变更视角都没有。而数据其实**全在前端 store 里已经齐了**：`useMessageRounds` 已按轮聚合出 `fileChanges`（含服务端 diff 快照）与 deliveries，`mergeFileChangesByPath` 合并算法现成——唯一缺的是「会话级」这一层聚合和一个统一出口。本提案纯前端补齐：聚合 + 徽标入口 + 汇总抽屉，零后端改动、零新端点、不改任何既有渲染路径，回归风险接近零。

- 状态：已否决（2026-11-22 评审）
- 日期：2026-11-22
- 提案总览见 [docs/proposals/README.md](../README.md)
- 规模：小（约 1-1.5 人日；0 迁移；desktop only：1 个聚合 computed + 1 个抽屉组件 + 工具行入口；无 backend / admin / agent-cli 改动）
- 关联：`desktop/src/composables/useMessageRounds.ts`（轮次级聚合 :90-100）、`desktop/src/utils/mergeFileChanges.ts`（按路径合并 :7）、`desktop/src/components/chat/FileChangePanel.vue`（轮次级面板与点击口径）、`desktop/src/components/chat/ChatDeliveryBar.vue`（交付物展示）、`desktop/src/types/chat.ts`（FileChange 类型 :38-51）、`desktop/src/components/chat/ToolCallCard.vue`（diff 快照来源 :513）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 轮次级文件变更 | 每轮渲染「文件变更 (n)」折叠条，realtime / history 双模式都支持，点击进中心区 diff | `ChatRoundList.vue:76-107`（`round.fileChanges.length > 0` 才显示） |
| 变更数据来源 | 轮次模型已 flatMap 聚合各消息 `fileChanges`；diff 快照由服务端另存，`SNAPSHOT` / `PATCH` 双模式带 before / after / patch | `useMessageRounds.ts:90-100`、`types/chat.ts:38-51`、`ToolCallCard.vue:513` |
| 同路径合并 | `mergeFileChangesByPath` 已实现按路径合并 | `mergeFileChanges.ts:7` |
| 交付物 | `send_image` / `send_file` 活引用 + 交付卡片重设计（中心文件预览 / 下载、tar 归档）刚落地；轮次级 deliveries 聚合已有专门用例 | `ChatDeliveryBar.vue`、`useMessageRounds.deliveries.test.ts` |
| 会话级汇总 | **不存在**——长会话收尾无法一眼看到「总共动了哪些文件 / 发了哪些东西」 | 全仓库无会话级聚合实现 |
| git 仓库以外 | Git 管理器只服务 git 工作区；非 git 工作区无任务级变更视角 | — |
| 交互先例 | 用量抽屉（预算 Tab）已确立「工具行入口 + 抽屉」范式 | `2026-10-26-user-budget-visibility` 落地能力 |

## 2. 目标 / 非目标

**目标**

1. **会话级聚合 computed**：全轮次 `flatMap(fileChanges)` → `mergeFileChangesByPath` → 同路径多次编辑收敛为最终态类型（新增 / 修改 / 删除）与累计 ± 行数；交付物同层聚合。纯派生值，实时轮次与历史加载天然继承（轮次模型已覆盖双模式）。
2. **入口与徽标**：ChatPanel 顶部工具行加「产出」按钮，徽标显示变更文件数 / 交付物数（有变更才显示，会话无产出则不出现）。
3. **汇总抽屉**：对齐用量抽屉的交互范式——左侧列表两组：「文件变更」（新增 / 修改 / 删除徽标、± 行数、路径）与「已发送交付物」（活引用卡）；点击行为与 `FileChangePanel.handleFileClick` **同口径**（中心区打开 diff / 文件预览），交付物复用交付卡片的预览 / 下载动作。LOCAL / CLOUD 分支沿用既有口径。
4. **空态与边界**：无产出的会话不显示入口；超大变更列表（> 200 项）折叠为计数 + 搜索框。

**非目标**

- 不新增任何后端端点 / 契约 / 迁移——数据全部来自前端已有 store 状态。
- 不做跨会话聚合、不做产出登记 / 不可变快照（交付物中心批次 11 已否决）。
- 不改 FileChangePanel 的轮次级渲染与既有工具卡展示。
- 不做导出（Markdown 导出批次 20 已否决，本提案不沾导出）。
- 不做变更的「撤销 / 回滚」（执行回滚批次 3 已否决）。

## 3. 与已落地 / 已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 轮次级文件变更面板（已落地） | 保留不动；本提案是其上的会话级聚合出口，点击行为刻意同口径 |
| 交付卡片重设计（unreleased） | 是单卡片体验；本提案是会话级汇总入口，复用其预览 / 下载动作 |
| 交付物中心（批次 11 否决） | 否决的是登记不可变交付物与跨会话聚合；本提案是当前会话的只读派生视图 |
| 工作区总览与生命周期（批次 19 已落地） | 那是工作区视角（占用 / 关联会话 / 删除）；本提案是任务产出视角 |
| 任务检查点与回滚（批次 3 否决） | 不做任何回滚语义，纯只读展示 |

## 4. 方案设计

- **聚合**：`useMessageRounds` 同族新增 `sessionFileChanges` / `sessionDeliveries` 派生 computed（或独立 composable `useSessionOutput`），输入轮次模型、零副作用；同路径类型优先级「删除 > 新增 > 修改」（后轮删除覆盖先前编辑），行数为各轮绝对值累加并在 title 里注明口径。
- **组件**：`SessionOutputDrawer.vue`（抽屉容器 + 两组列表 + 空态）；入口按钮挂 ChatPanel 顶部工具行，徽标数取聚合长度；打开时不发任何请求。
- **点击口径**：复用 FileChangePanel 既有的 `openDiffTab` / 文件预览打开逻辑（CLOUD / LOCAL 分支同口径，:303 注释已声明该口径为两处共用的基准）；交付物区直接内嵌既有交付卡片组件的预览动作。
- **回归控制**：不动 ChatRoundList / FileChangePanel / ChatDeliveryBar 的任何现有 prop 与事件；抽屉为纯新增挂载点；聚合 computed 用 `mergeFileChanges.test.ts` 同风格补单测（含同路径多轮编辑、删除覆盖、空会话）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `SessionOutputDrawer.vue` + 聚合 composable + 工具行入口与徽标；新增聚合单测 |
| backend-ts / admin / android / agent-cli | 无 |
| 文档 | `changelog/unreleased/` 同任务碎片；`skills/mao-cli/reference/desktop.md` 工作台一节补一句入口说明 |
