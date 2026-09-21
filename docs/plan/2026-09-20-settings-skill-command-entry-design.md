# 技能 / 指令管理入口迁移至设置页 — 技术方案

- 日期：2026-09-20
- 范围：desktop 前端（Electron / Web / 安卓共用 UI），无后端改动
- 状态：已与需求方确认，待开发

## 1. 需求背景

当前用户管理「我的技能」「我的指令」的唯一入口位于工作台顶部栏（`TopNav.vue` 两个图标按钮），点击后分别打开 `SkillDrawer.vue`、`CommandDrawer.vue` 两个 420px 侧滑抽屉。随着设置页模块不断增多（个人信息、服务器、使用记录、Git 凭证、消息通知、微信Bot、飞书机器人、MCP 服务器、定时任务），个人内容管理类功能仍散落在顶部栏，入口不统一、顶部栏拥挤，用户难以发现管理能力。

本次需求：将「我的技能」「我的指令」两个管理模块迁移到设置页面，作为与「MCP 服务器」「定时任务」同级的一等模块，并移除顶部栏入口，使个人内容管理与系统配置类模块在设置页统一收敛。

## 2. 需求描述（已确认的决策）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 顶部栏入口 | 彻底移除「我的技能」「我的指令」两个按钮，不保留任何形式的顶部入口 |
| 2 | 设置页组织 | 新增两个独立导航项：**我的技能**（`/settings/skills`）、**我的指令**（`/settings/commands`），各对应独立路由页面 |
| 3 | 导航位置 | 两个导航项放在「MCP 服务器」之后、「定时任务」之前 |
| 4 | 内容实现方式 | 将两个抽屉的内部内容抽取为可复用管理组件，设置页直接嵌入；不拷贝代码 |
| 5 | 聊天「添加到我的指令」 | 现有 CommandDrawer 承担聊天消息预填创建指令的职责；迁移后聊天侧改为弹出独立的「新建指令」编辑弹窗（从原抽屉中抽取的 dialog 组件），彻底删除 CommandDrawer 抽屉外壳 |
| 6 | 预填保存后行为 | 保存成功即关闭弹窗并 toast 提示，不额外引导到设置页 |
| 7 | 功能与交互 | 与现有抽屉完全一致（技能：上传/查看/删除/本地技能/系统 Tab；指令：CRUD/系统 Tab/确认删除），不新增不删减 |
| 8 | 安卓端 | 不做专项适配，沿用设置页已有响应式布局（窄屏侧边栏横排、内容区自适应）；原抽屉的安卓专用样式随抽屉删除一并清理 |

## 3. 明确不做（Non-Goals）

- 不改动任何后端接口与表结构（`/user-skills`、`/skill-docs`、`/user-commands`、`/user-commands/system` 原样使用）。
- 不删除管理后台的「Skills 管理」模块，两者互不相干。
- 不改动 `QuickCommandPanel`（聊天输入区的快捷指令面板），它只消费指令列表数据，不依赖被删除的抽屉。
- 不为技能/指令管理新增搜索、排序、批量操作等原抽屉没有的功能。
- 不改 `agent-cli`、admin、android 原生壳（`android/android/app/`）任何代码。
- 不做 LOCAL 模式、工具审批等范围外事项。
- 不保留 `useSkillDrawer` composable（唯一调用方是 TopNav，随顶部入口一起删除）。

## 4. 技术选型

沿用项目现有技术栈，无新增依赖：

- Vue 3 `<script setup>` + 严格 TS（vue-tsc 校验）。
- Element Plus：新页面沿用抽屉内已有的 `el-tabs`、`el-dialog`、`el-tooltip`、`el-tag` 等；页面容器使用设置页统一的内容区布局，不再使用 `el-drawer`。
- 路由：vue-router，`/settings/*` 子路由模式与现有 `WeixinBotView`、`McpServersView` 等一致。
- 状态：不新增 Pinia store；技能/指令数据为页面局部状态，与现抽屉一致（进页面拉取）。
- 样式：沿用抽屉内已有的语义 class 与设计变量（`--aw-*`），将抽屉专属样式迁移为组件 scoped 样式；删除抽屉外壳相关样式及安卓专用的全屏/滚动适配样式。

### 组件拆分设计

```
desktop/src/components/skill/
  SkillManager.vue        # 新增：技能管理主体（上传区 + 系统/已上传/本地技能 Tab + 详情弹窗），
                          # 由 SkillDrawer 内容整体抽取，无 drawer 外壳
desktop/src/components/command/
  CommandManager.vue      # 新增：指令管理主体（我的/系统 Tab + 列表 + 新建/编辑弹窗），
                          # 由 CommandDrawer 内容整体抽取
  CommandEditDialog.vue   # 新增：独立的新建/编辑指令弹窗，支持传入预填内容（content），
                          # 供聊天「添加到我的指令」直接调用
desktop/src/views/settings/
  SkillsView.vue          # 新增：<SkillManager /> 页面壳
  CommandsView.vue        # 新增：<CommandManager /> 页面壳
```

删除项：`SkillDrawer.vue`、`CommandDrawer.vue`、`composables/useSkillDrawer.ts`、`composables/useCommandDrawer.ts`。

聊天预填链路改造：`ChatPanel.vue`、`SideChatPanel.vue`、`SubagentChatPanel.vue` 现通过 `useCommandDrawer().openWithContent(content)` 打开抽屉；改为通过组件 ref 直接打开 `CommandEditDialog`（`open({ content })`），保存成功后 toast「指令已创建」并关闭，行为与原抽屉预填路径一致（含"正在编辑时提示先完成/关闭"的互斥逻辑，迁移进 CommandEditDialog/调用方）。

## 5. 实现步骤

1. **抽取 SkillManager**：将 `SkillDrawer.vue` 的模板与脚本（上传区、`fetchAll`/`fetchSkills`/`fetchSystemSkills`/`fetchLocalSkills`、Electron `listLocalSkills` 本地技能、详情弹窗、删除确认）整体迁入 `SkillManager.vue`，去掉 `el-drawer` 外壳与 `visible` watch，改为组件挂载时（`onMounted`）拉取数据。
2. **抽取 CommandManager 与 CommandEditDialog**：将 `CommandDrawer.vue` 的双 Tab 列表、CRUD 逻辑迁入 `CommandManager.vue`；将新建/编辑 `el-dialog` 连同名称校验（`namePattern`）、提交逻辑抽为 `CommandEditDialog.vue`，暴露 `open({ content? })` 与 `saved` 事件。
3. **改造聊天预填**：三个聊天面板移除 `useCommandDrawer` 依赖，挂载 `CommandEditDialog` 并改调 `open({ content })`；删除预填成功后的额外引导（按决策 6 仅 toast）。
4. **新增设置页视图与路由**：创建 `SkillsView.vue`、`CommandsView.vue`；在 `desktop/src/router/index.ts` 注册 `/settings/skills`、`/settings/commands` 子路由。
5. **设置导航与入口清理**：`SettingsView.vue` 导航在「MCP 服务器」之后插入两项；`TopNav.vue` 删除两个按钮及 `useSkillDrawer`/`useCommandDrawer` 引用与相关样式；`Layout.vue` 移除 `<SkillDrawer />`、`<CommandDrawer />` 挂载。
6. **删除旧代码**：删除 `SkillDrawer.vue`、`CommandDrawer.vue`、`useSkillDrawer.ts`、`useCommandDrawer.ts`，确认无残留引用。
7. **样式收尾**：`management-drawer` 等抽屉专属样式（含安卓全屏适配）随删除清理；确认新组件在设置页容器内的间距、卡片、Tab 视觉与现有设置页模块（如 MCP 服务器）一致。
8. **文档与 CHANGELOG**：按仓库规范更新 `CHANGELOG.md`（新增 `## x.y.z` 小节，归入"前端（桌面 / Web / 安卓）"）；检查 `skills/mao-cli/SKILL.md` 与 README 中对顶部入口的描述并同步。

## 6. 验证方案

- 构建：`cd desktop && npm run build`（含 vue-tsc 类型检查），零报错。
- 全局搜索确认：`grep -r "SkillDrawer\|CommandDrawer\|useSkillDrawer\|useCommandDrawer" desktop/src` 无结果。
- 手动检查（Electron / Web 各一轮）：
  - 设置页出现两个新导航项，位置在 MCP 服务器之后；页面内上传、删除、查看、Tab 切换、指令 CRUD 全部可用。
  - 顶部栏两个按钮消失，其余顶部功能不受影响。
  - 聊天消息「添加到我的指令」弹出新建弹窗、内容预填正确、保存成功 toast 并关闭。
  - Electron 下本地技能区块正常展示（`listLocalSkills`）。
  - 窄屏（响应式断点 640px）下设置页导航横排、新页面内容可用。
- Playwright：现有用例不覆盖抽屉（仅 admin 端 Skills 测试，不受影响）；本次不新增桌面端 E2E 用例（仓库约定 CI 不跑 Playwright，改动为纯入口迁移，以构建 + 手动验证为准）。

## 7. 落地清单

### 新增
- [ ] `desktop/src/components/skill/SkillManager.vue`
- [ ] `desktop/src/components/command/CommandManager.vue`
- [ ] `desktop/src/components/command/CommandEditDialog.vue`
- [ ] `desktop/src/views/settings/SkillsView.vue`
- [ ] `desktop/src/views/settings/CommandsView.vue`
- [ ] 路由：`desktop/src/router/index.ts` 注册 `/settings/skills`、`/settings/commands`

### 修改
- [ ] `desktop/src/views/settings/SettingsView.vue`（导航两项，MCP 服务器之后）
- [ ] `desktop/src/components/common/TopNav.vue`（移除两入口及引用）
- [ ] `desktop/src/components/common/Layout.vue`（移除两个 Drawer 挂载）
- [ ] `desktop/src/components/chat/ChatPanel.vue`、`SideChatPanel.vue`、`SubagentChatPanel.vue`（预填链路改 CommandEditDialog）
- [ ] `CHANGELOG.md`（新版本小节）
- [ ] `README.md` / `skills/mao-cli/SKILL.md`（如提及顶部入口则同步更新）

### 删除
- [ ] `desktop/src/components/skill/SkillDrawer.vue`
- [ ] `desktop/src/components/command/CommandDrawer.vue`
- [ ] `desktop/src/composables/useSkillDrawer.ts`
- [ ] `desktop/src/composables/useCommandDrawer.ts`

### 明确不动
- [ ] 后端 `backend-ts`（无任何改动）
- [ ] `admin`、`agent-cli`、`android/android/app/`（无任何改动）
- [ ] `desktop/src/components/chat/QuickCommandPanel.vue`（仅消费数据，不受影响）

## 8. 风险与说明

- `CommandEditDialog` 被聊天三处面板复用，预填互斥逻辑（编辑中再触发添加时的 toast 提示）需在迁移时保留原语义，属实现细节中最易遗漏点。
- 原 SkillDrawer 中 Electron 本地技能（`window.electronAPI.listLocalSkills`）分支为 Electron 专属，抽取时原样保留，Web/安卓端行为不变（该区块不渲染）。
- 抽屉迁移为页面后，数据拉取时机从"打开时"变为"进入页面时"，接口调用频次不变（用户进入页面才会拉取）。
