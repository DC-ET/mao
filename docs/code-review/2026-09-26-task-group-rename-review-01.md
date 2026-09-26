# 代码审查报告：任务分组右键重命名（2026-09-26）

## 审查范围

本次未提交改动（不含他人改动的 `desktop/src/components/chat/FileReferencePanel.vue`）：

- `backend-ts/db/migration/V122__add_group_aliases.sql`
- `shared/contracts/src/preference.ts`
- `backend-ts/src/preference/{types.ts, task-panel-preference.service.ts, preference.routes.ts, preference.repository.ts, task-panel-preference.service.spec.ts}`
- `desktop/src/utils/cloud-project.ts` + `cloud-project.test.ts`
- `desktop/src/composables/useTaskPanelPrefs.ts`
- `desktop/src/components/task/TaskIndexPanel.vue`
- `tests/desktop.spec.ts`

## 验证情况

- `cd backend-ts && npm test`：213 passed / 1 skipped，全部通过。
- `cd backend-ts && npm run build`（tsc）：通过。
- `cd desktop && npx vitest run src/utils/cloud-project.test.ts`：21 passed。
- `cd desktop && npx vue-tsc -b`：通过。
- 迁移 SQL 已在本地 MySQL 8（严格 sql_mode）实测：对已有行 `ALTER TABLE ... ADD COLUMN group_aliases JSON NOT NULL` 后旧行该列为 `null`，读取路径 `parseStringMap(null)` 返回 `{}`、写入路径 `?? '{}'` 均可兜住，不构成问题。

## 总体结论

后端实现与设计文档一致，单测覆盖充分，主流程（别名存取、旧客户端不传字段不清空、不可改名分组过滤、空值重置）逻辑正确，无阻塞性业务 bug。发现 1 个会导致 E2E 用例必然失败的问题（重要）、1 个可能打断行内编辑的交互缺陷（重要）及若干建议项。

---

## 问题列表

### 重要

#### 1. E2E 用例依赖的种子数据不存在，测试必然失败

- **位置**：`tests/desktop.spec.ts:512-580`（Task Group Rename 用例）、`scripts/e2e-setup.sh:153-161`
- **描述**：用例注释声明"依赖 e2e 种子：一条 LOCAL 会话（workspace=/home/mao-e2e/demo-project）"，但全仓库检索 `demo-project` 仅出现在 `desktop.spec.ts` 自身；`scripts/e2e-setup.sh` 的种子 `INSERT INTO session (...)` 只插入 3 条会话且**不含 workspace 列**（workspace 为 NULL，`cloudGroupKey` 会归入 `LOCAL:未设置` 分组），未随本需求补充带 workspace 的种子会话。
- **影响**：`page.locator('.group-header').filter({ hasText: 'demo-project' })` 永远不可见，`should rename group via context menu and persist after reload` 用例在 10s 超时后失败；第二个用例（临时工作区）也会因种子缺失被静默跳过，实际未验证任何内容。CI 跑 `npm test`（Playwright）会红。
- **修复建议**：在 `scripts/e2e-setup.sh` 种子段为其中一条 session（或新增一条）补 `workspace='/home/mao-e2e/demo-project'`（注意种子幂等判断是"已有 session 则跳过"，需在注释/文档中说明重建 e2e 库才能生效），或将用例改为自造数据（登录后通过 API 创建带 workspace 的会话）。

#### 2. 分组重命名输入框使用内联 function ref，任意列表重渲染都会触发 focus + select，可能吞掉用户输入

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue:82-89`（`v-if` 内 `:ref="(el) => setGroupRenameInput(group.key, el)"`）及 `setGroupRenameInput` 实现（约 545-556 行）
- **描述**：Vue 3 中内联箭头函数 ref 在**每次组件更新时**都会被重新调用（每次渲染生成新函数引用，patch 时先以 `null` 调旧 ref、再以元素调新 ref）。`setGroupRenameInput` 每次被调用都执行 `focus()` + `select()`。`groupedSessions` 是响应式的，运行中会话的状态推送（WS 更新 phase/unread/steps 等）会触发分组列表重渲染——此时用户正在输入框里打字，`select()` 会全选已输入文本，下一个键入字符将**整体替换**掉刚输入的别名。
- **影响**：存在运行中会话时重命名分组，输入内容可能被意外清空替换；属于用户可稳定复现的数据丢失类交互 bug（原会话重命名实现用 `document.querySelector` 只在进入编辑时 focus 一次，正是为规避此问题，本次实现引入了回归）。
- **修复建议**：不要在 ref 回调里无条件 focus/select。可在 ref 回调中只记录元素引用，`startGroupRename` 里 `nextTick` 后执行一次 `focus()` + `select()`；或将 `renamingGroupKey`、焦点逻辑解耦（如 `watch(renamingGroupKey)` 触发一次）。

### 建议

#### 3. 前端未做 50 字符截断，与后端归一化规则不一致

- **位置**：`desktop/src/composables/useTaskPanelPrefs.ts` 的 `renameGroup`；`backend-ts/src/preference/task-panel-preference.service.ts` 的 `normalizeAliases`（`GROUP_ALIAS_MAX_LENGTH = 50`）
- **描述**：前端 `renameGroup` 只 trim 不截断，本地 `groupAliases` 立即显示超长名并 PUT；后端 normalize 截断到 50 字符后落库。在多端同步/刷新前，本端显示与持久化值不一致（输入框重新打开时 `renamingValue` 取自本地 map，仍是超长值），且其他端拿到的是截断后的名字。
- **影响**：轻微的一致性问题，无功能性破坏。
- **修复建议**：`renameGroup` 中对 `trimmed.slice(0, 50)` 与后端对齐（常量可放 shared/contracts）。

#### 4. 右键分组头不会关闭已打开的会话右键菜单

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue` 的 `openGroupContextMenu`（约 672 行）
- **描述**：`openContextMenu`（会话菜单）与 `openGroupContextMenu`（分组菜单）互相不感知：若会话菜单已打开，再右键分组头，两个 `task-context-menu` 浮层会同时显示叠放。全局 click/Esc/scroll 会把它们一起关掉，但叠加期间可能误点。
- **修复建议**：`openGroupContextMenu` 入口先 `closeContextMenu()`（反之亦然）。

#### 5. 单测 `saveDropsNonStringValueEntries` 未实际覆盖非字符串值

- **位置**：`backend-ts/src/preference/task-panel-preference.service.spec.ts:120-127`
- **描述**：用例名为"剔除非字符串值条目"，但入参只有 `{ 'LOCAL:/ws/a': 'ok' }`，没有传入非 string 值（如 `42`、`null`、对象），断言等于没验证 `normalizeAliases` 中 `typeof rawValue === 'string'` 分支的剔除行为。
- **修复建议**：入参补 `{ 'LOCAL:/ws/b': 42, 'LOCAL:/ws/c': null } as unknown as Record<string, string>`，断言仅保留 string 条目。

#### 6. `confirmGroupRename` 的 try/catch 不可达

- **位置**：`desktop/src/components/task/TaskIndexPanel.vue` 的 `confirmGroupRename`
- **描述**：`renameGroup`/`resetGroupAlias` 是纯同步本地状态操作 + 防抖保存（保存失败走 `ElMessage.warning`），不会抛异常，`catch { ElMessage.error('重命名失败') }` 永不触发，注释"失败保持编辑态让用户重试"承诺实际无效。
- **影响**：无功能危害，仅误导后续维护者。
- **修复建议**：移除无效 try/catch，或在注释中如实说明失败路径由 `persistPrefs` 的 warning 兜底。

### 流程提醒（非代码 bug）

- 本次为用户可见功能，按仓库规范应在 `CHANGELOG.md` 顶部补 `0.0.x` 小节（当前改动未包含 CHANGELOG）；如 `skills/mao-cli` 中有任务面板相关说明也需同步。
- 设计文档 §4 提到的 tooltip（别名+推导名）已实现，`groupAliasTooltip` 用 `resolveGroupLabel(key, {})` 计算推导名，正确。

## 已检查未发现问题的点

- 后端 save 对 `undefined`（旧客户端未传，保留已有别名）与 `{}`（显式清空）的区分，单测覆盖且逻辑正确。
- `isGroupRenameable` 前后端规则一致（`LOCAL:未设置`、`CLOUD:临时工作区`、`FEISHU_*`、`DINGTALK_*` 均拒绝）。
- 行内编辑 Enter/Esc/blur 不会双重提交（confirm 后 `renamingGroupKey` 置空，blur 回调里已短路）。
- 分组 key 未变，`groupOrder`/折叠/过滤/分页均不受影响；`formatGroupLabel` 双轨已按设计删除，`resolveGroupLabel` fallback 与原逻辑等价（已过单测）。
- 迁移版本号 V122 正确（当前最大 V121）；JSON NOT NULL 列对存量行读到 null 的路径已被 `parseStringMap`/`?? '{}'` 兜住。
- E2E 用例中 `page.evaluate` 直连 `:9180` 的跨域 fetch：后端 `@fastify/cors` 非 exchange 请求 `origin: true`（反射 origin）、headers 默认反射，可正常通过。
