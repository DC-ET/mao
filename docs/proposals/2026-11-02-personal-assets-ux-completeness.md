# 提案：打开设置不再像查字典 —— 个人资产与配置体验补完（会话审批规则可见、变量免重填、搜索筛选）

> 随着长期记忆、审批规则、环境变量、快捷指令、信号哨兵、开放接口陆续上线，用户的个人资产已经攒出厚厚一摞，但日常维护它们时有三个「每次碰到都刺手」的体验毛刺：
> 1. **在审批卡上点了「总是允许」，之后在界面上再也找不到它**：后端早已支持 `GET /v1/approval-rules?includeSession=true&sessionId=x` 并支持按 ID 删除，但桌面端只展示了跨会话的用户级规则——用户在某个会话里手滑点错「总是允许」，或者想把某条好用的会话级规则提升为长期生效的用户级规则，今天完全没有入口，只能删掉整个会话重来。
> 2. **给环境变量改句备注，必须把密码重输一遍**：`EnvVariablesView.vue` 与 `EnvVarsDrawer.vue` 编辑时强制要求重填 `envValue`（「重新输入变量值，留空无法保存」），而隔壁的 Git 凭证（`GitCredentialsView.vue`）、MCP 环境变量、信号哨兵请求头全都支持「**留空则保留原值**」——唯独环境变量想补个备注就得去翻密码本。
> 3. **记忆、指令、审批规则攒到几十条后没有搜索框**：设置页的「长期记忆」「审批规则」「我的指令」以及工作区环境变量抽屉，目前只有分类 Tab，没有关键词搜索，条目一多只能一页页翻。

- 状态：提案（待评审）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（三项合计约 2~3 人日；**零迁移**，不动任何执行内核）
- 关联：`backend-ts/src/approval-rule/approval-rule.routes.ts`、`backend-ts/src/approval-rule/approval-rule.service.ts`、`backend-ts/src/env/env-variable.service.ts`、`backend-ts/src/memory/memory.repository.ts`、`desktop/src/views/settings/ApprovalRulesView.vue`、`desktop/src/views/settings/EnvVariablesView.vue`、`desktop/src/components/chat/EnvVarsDrawer.vue`、`desktop/src/views/settings/MemoryView.vue`、`desktop/src/components/command/CommandManager.vue`

## 1. 背景与现状

### 1.1 三个具体断点（代码可查）

| 断点 | 后端现状 | 前端现状 | 代码证据 |
|---|---|---|---|
| **会话级审批规则对用户隐形且不可撤销** | `listUserRules` 已实现 `scope='SESSION'` 与 `includeSession` 查询；但 `findOwnedUserRule` 写死了 `row.scope !== 'USER'` 抛 404，导致会话级规则无法删除或提升 | LOCAL 会话里没有任何地方展示「本会话已放行的规则」；设置页 `ApprovalRulesView.vue` 只查 `scope=USER`，文案写着「可在审批卡片点击总是允许创建会话级规则」，创建完却无处可看、无处可撤 | `approval-rule.service.ts:166-184, 235-283`、`ApprovalRulesView.vue:5-8` |
| **编辑环境变量备注强制重填密文** | `EnvVariableService.requireValueOnUpdate` 规定 `value == null` 报错（空串还会把原密文清空），哪怕用户只是想改 `note` 或 `envKey` | `EnvVariablesView.vue:85` 占位符写着「重新输入变量值（不回显，留空无法保存）」，`canSubmit` 在 `envValue` 为空时直接禁用保存按钮；而 `GitCredentialsView.vue:77,217` 早已是「留空则不修改 Token」 | `env-variable.service.ts:336-342, 383-400`、`EnvVariablesView.vue:85, 149-156` |
| **长期记忆 / 审批规则 / 快捷指令无搜索** | `memory.repository.ts:buildFilter` 只按 `scope / projectKey / status` 过滤，无 `keyword`；`approval-rule.repository.ts` 无 `keyword` | `MemoryView.vue`（上限 200 条 ACTIVE + 已忽略）、`ApprovalRulesView.vue`、`CommandManager.vue` 均无搜索输入框（反观管理后台 `SystemCommandListView.vue:20` 却有关键词搜索） | `memory.repository.ts:177-194`、`MemoryView.vue:21-38`、`CommandManager.vue:1-25` |

### 1.2 为什么现在值得做

这三件事都是**百分之百的「把既有能力打磨顺滑」**：
- 不新增概念、不新增数据库表、不改动 AgentLoop 或任何工具派发逻辑；
- 解决的都是重度用户用了一两周后必然撞上的摩擦点（点错「总是允许」不敢跑了、忘掉当初填的 API Key 不敢改环境变量备注、在百来条自动沉淀的记忆里大海捞针找某条错误记忆）。

## 2. 目标 / 非目标

**目标**

1. **P1 会话级审批规则可见、可撤、可提升**：
   - 后端：`DELETE /v1/approval-rules/:id` 放宽为允许删除本人名下的 `SESSION` 级规则（归属校验仍为 `row.userId === userId`）；新增 `POST /v1/approval-rules/:id/promote`（或复用创建接口）将某条 `SESSION` 级规则一键复制/提升为跨会话的 `USER` 级规则（幂等去重）。
   - 前端：设置页 `ApprovalRulesView.vue` 增加「会话级规则」二级 Tab/分组（展示规则值、所属会话标题、命中次数，支持「删除（恢复审批）」与「提升为用户级规则」）；入口只放在设置页，LOCAL 会话右侧不放入口（2026-11-02 决策，见 §8）。
2. **P2 环境变量编辑支持「留空不修改值」**：
   - 后端：`EnvVariableService.buildPatch` 在 `input.envValue === undefined`（或未传）时不更新 `env_value` 列，仅当显式传入非空字符串时重新加密写入（与其他凭据页完全对齐：Git 凭证 `GitCredentialsView`、MCP 环境变量 `McpServersView`、信号哨兵请求头 `SignalWatchersView` 全部都是「留空保留原值」）。
   - 前端：`EnvVariablesView.vue` 与 `EnvVarsDrawer.vue` 在编辑态下，`envValue` 留空即可直接保存修改后的备注（`note`），占位文案统一为「留空则保留原值；输入新值则覆盖」。
3. **P3 个人配置三件套补齐关键词搜索**：
   - **长期记忆（`MemoryView.vue`）**：工具栏补关键词搜索框（300ms 防抖），后端 `GET /v1/memory` 增加可选 `keyword` 参数（匹配 `content` 或 `project_key` LIKE），用户在百条自动记忆里搜一个词就能揪出那条需要修改或忽略的记忆；顺带在卡片上把后端早已返回的 `originSessionId`（来源会话 ID，见 `memory.service.ts:310`）渲染为可点击的 `#会话ID` 跳转链接（若会话未删则跳过去，已删则提示，零后端改动）。
   - **我的指令（`CommandManager.vue`）**：在「我的指令 / 系统指令」Tab 下方补一个轻量过滤框（指令总数通常几十条，纯前端按 `name + content` 即时过滤即可，与管理后台 `SystemCommandListView` 对齐）。
   - **审批规则（`ApprovalRulesView.vue`）**：补按命令关键字过滤（支持在 `git push`、`npm` 等规则间快速筛选）。

**非目标**

- 不复活已否决的「记忆就地可见（气泡下回执 / 选区一键记住）」（2026-10-27 否决）——对记忆的所有改动严格收敛在「设置 → 长期记忆」管理页内部。
- 不改变审批规则的匹配优先级、归一化算法与受保护命令（denylist）安全边界。
- 不允许回显环境变量明文（安全策略不变，只是编辑备注时不必重填密文）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 记忆就地可见（2026-10-27 否决） | 不在聊天气泡下加回执条、不加 WS 事件、不在对话选区加「记住这个」按钮；只在 `MemoryView.vue` 设置页内补搜索框和已有的 `originSessionId` 展示。 |
| 团队知识层（2026-10-19 否决） | 不涉及跨用户共享或提案审批，纯个人设置页内部体验。 |

## 4. 方案设计

### 4.1 P1：会话级审批规则闭环

- **后端（`approval-rule.service.ts` & `approval-rule.repository.ts`）**：
  - `removeUserRule(userId, id)`：校验 `row.userId === userId` 即可物理删除（无论 `scope` 是 `'USER'` 还是 `'SESSION'`），让用户随时能撤回自己在会话里点过的「总是允许」。
  - `listUserRules`：当 `scope === 'SESSION'` 时，LEFT JOIN `session` 表顺带返回 `sessionTitle`（复用 `pageAdmin` 既有的 `LEFT JOIN session s ON s.id = r.session_id` 查询模式，不到 10 行 SQL），供设置页展示「来自会话：xxx」。
- **前端（`ApprovalRulesView.vue`，入口仅限设置页）**：
  - 设置页顶部增加「用户级规则 / 会话级规则」二级 Tab 切换（或同页分节）：会话级规则卡片显示所属会话名称（可点击跳回该会话）、规则值、放行次数，操作区提供「提升为全局（转为 USER 级）」与「删除（恢复每次审批）」。
  - 不在 LOCAL 会话右侧检查器（`TaskInspector` / `PermissionLevelSwitcher`）放入口——规则的事后管理（查看/删除/提升）统一收敛到「设置 → 审批规则」页，对话现场只保留审批卡本身（2026-11-02 决策，见 §8）。

### 4.2 P2：环境变量编辑免重填密文

- **后端（`env-variable.service.ts`）**：
  - `UpdateInput.envValue` 改为可选：若 `input.envValue == null || input.envValue === ''`，`buildPatch` 不把 `envValue` 放进 `patch`（`MysqlEnvVariableRepository.updateBy` 第 44 行本来就是 `if (patch.envValue !== undefined)` 才拼 SQL！底层 Repository 早就写好了部分更新支持，只是被 Service 层的 `requireValueOnUpdate` 挡住了）。
- **前端（`EnvVariablesView.vue` & `EnvVarsDrawer.vue`）**：
  - `canSubmit` 在 `isEditing` 时不再要求 `form.envValue !== ''`，改为只要 `note` 或 `envValue` 有变化即可保存；提交时若 `form.envValue === ''` 则不下发 `envValue` 字段。

### 4.3 P3：设置页搜索与记忆来源微链

- **`GET /v1/memory`**：`MemoryListQuery` 增加 `keyword?: string | null`；`buildFilter` 在 `hasText(query.keyword)` 时追加 `AND (content LIKE ? ESCAPE '\\\\' OR project_key LIKE ? ESCAPE '\\\\')`。
- **`MemoryView.vue`**：在筛选栏右侧加搜索框；每张记忆卡片底部若 `item.originSessionId != null`，在「自动」徽标旁显示 `来源 #123` 小链接，点击经 `router.push('/tasks/' + item.originSessionId)` 跳回原会话（若原会话已删则 toast 提示「来源会话已删除」）。
- **`CommandManager.vue` & `ApprovalRulesView.vue`**：各自在列表上方增加轻量搜索框。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `approval-rule` 支持本人删除 SESSION 规则并带出 `sessionTitle`；`env-variable.service.ts` 编辑态允许不传 `envValue` 保留原密文；`memory` 列表查询支持 `keyword` 参数 |
| desktop | `ApprovalRulesView.vue`（会话级规则可见/删除/提升 + 搜索）、`EnvVariablesView.vue` & `EnvVarsDrawer.vue`（编辑免重填密文）、`MemoryView.vue`（关键词搜索 + `originSessionId` 跳转链接）、`CommandManager.vue`（关键词过滤） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 环境变量「留空不修改」导致用户无法把变量值改成空字符串 | 环境变量本身无「值为空串」的实际配置需求（需要停用直接删除即可）；与 Git 凭证、MCP 环境变量交互完全统一，消除认知分裂 |
| 删除会话级审批规则时正在等待审批的请求受影响 | 规则只在工具派发进入审批前匹配一次（`ApprovalRuleService.match`），删除规则只让**下一次**同类命令重新弹审批卡，不影响在途请求 |
| 记忆 `keyword` LIKE 模糊匹配性能 | `memory_item` 每用户 ACTIVE 上限为 200 条（`MEMORY_ACTIVE_LIMIT = 200`），且查询强制带 `WHERE user_id = ?` 走 `idx_memory_user_scope_status` 索引，单用户扫描行数极小，毫秒级返回 |

## 7. 测试要点

1. 审批规则：用户可查询并删除本人会话级（`SESSION`）规则，不可删除他人会话级规则（404）；提升为用户级规则后命中 denylist 仍受保护。
2. 环境变量：编辑用户级 / 工作区级 / 系统级环境变量时，不传 `envValue` 仅传 `note`，更新后原密文保持不变（`resolveForSession` 解密出的值与修改前一致）。
3. 长期记忆：`GET /v1/memory?keyword=vitest` 正确过滤，含 `%` / `_` 通配符的关键词正确转义不误匹配。
4. 前端组件：指令管理与记忆列表输入关键词后列表即时收敛，清空后恢复。

## 8. 决策记录

1. **会话级审批规则的入口**：只放在「设置 → 审批规则」页的二级 Tab，LOCAL 会话右侧不放入口。规则的事后管理（查看/删除/提升）统一收敛在设置页，对话现场只保留审批卡本身。
2. **记忆来源链接**：认可在**设置页卡片**上把已落库字段（`originSessionId`）渲染为 `来源 #123` 跳转链接——这不属于被否决的「记忆就地可见」（不在聊天气泡/选区做任何植入），仅是把已有字段在管理页内可视化。
