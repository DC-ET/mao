# 代码审查报告：超大文件拆分（TaskIndexPanel / ChatInput / session store）

- 日期：2026-09-30
- 范围：git 工作区未提交改动（`desktop/src/components/task/`、`desktop/src/components/chat/`、`desktop/src/stores/session*`）
- 审查方式：新旧文件逐段 diff、props/emits 透传核对、store 导出键对比，并执行 `vue-tsc -b`（exit=0）与 `vitest run`（22 files / 244 tests 全过，含 `stores/session.test.ts` 与新增 `task-panel-logic.test.ts`）。

## 1. 总体结论

**可合并，无阻塞项。** 拆分基本做到「纯搬运零逻辑改动」：对外 API 签名、props/emits、defineExpose、store 导出键均与拆分前一致（仅新增导出、无缺失）。未发现可触发功能 bug 的问题。

## 2. 逐项核对结果

### 2.1 子组件 props/emits 透传（TaskIndexPanel 系 / ChatInput 系）

- `TaskSessionGroupList` / `TaskFocusList` / `TaskArchivedSection` / `TaskContextMenu`：父组件传入的 props 与回调与模板消费一一对应，事件均通过函数 props 回调（非 emits），无遗漏绑定。拖拽、分组重命名、行内编辑/删除确认、归档/恢复等交互链路完整。
- `ChatNewTaskConfigBar` / `ChatPendingFileList` / `ChatInputToolbar` / `ChatMobileConfigRow`：工具条与移动配置行的事件链（AgentChip / WorkspaceChip / ModelSelector / PermissionLevelSwitcher → emit → ChatInput emit）逐层透传，包括 `update:selectedAgentId`、`update:workspace`、`update:gitBranch`、`update:permissionLevel`、`update:modelId`、`select:model`，无断链。
- ChatInput 的 `defineExpose({ focusInput, insertFileReference, clearInput, getPlainText, hasDraft, restoreContent, insertText })` 与拆分前完全一致，TaskView / SideChatPanel 等调用方不受影响。

### 2.2 defineModel 使用

- `renamingValue`、`editingTitle`（TaskSessionGroupList / TaskFocusList / TaskArchivedSection）、`focusVisibleCount`、`historyCollapsed`（TaskFocusList）均使用带名字的 `defineModel`，父侧对应 `v-model:renaming-value` 等绑定正确。
- `focusVisibleCount` 在子组件中被模板直接 `+=` 修改，经 `defineModel` 正确回写父组件 ref，`visibleFocusMainSessions`、`revealActiveSession` 等父侧逻辑读到的是最新值。
- 注意点（非 bug）：这些子组件的 `defineProps` 同时声明了同名只读字段（如 `editingTitle: string`）。Vue 3.4+ 中 `defineModel` 会自动注册同名 prop + `update:xxx` emit，重复声明是冗余的，但未声明 required，不会触发 missing-prop 警告，运行行为正确。后续可做小清理。

### 2.3 session store 领域模块拆分

- 无循环依赖：`list` / `messages` / `sideTask` / `subagent` 之间不互相 import，全部通过 `session.ts` 以依赖注入方式组装。
- list ↔ messageRuntime 存在**双向引用**（list 的 ctx getter 指向 messageRuntime 的 ref，messageRuntime 的 `getActiveSessionId` 指向 list 的 ref）。由于 `createSessionListModule` 只把 getter 函数存起来、在 computed / action 运行时才调用，而 `createMessageRuntimeModule` 同理，两者均不在模块创建时立即求值，因此创建顺序（list 在前）安全，无 TDZ 问题。
- getter 延迟求值正确：`focusedSessions`、`activeMessages` 等 computed 在首次访问时才执行，此时两个模块都已创建完毕。
- 响应式未被切断：所有共享状态以 ref 对象本身传入（`{ value }` 语义）或经 getter 返回 ref，ref 身份跨模块保持唯一；`ref<Map>` 内部 `.set()` 触发依赖、配合整体换新 Map 的写法与原文件一致。`useTaskPanelPrefs` 等外部依赖未受影响。
- `session.test.ts` 全量通过，行为回归有保障。

### 2.4 响应式引用边界

- `pendingFiles`、`editorContent` 等仍保留在 ChatInput 主文件，`ChatPendingFileList` 只接收数组 prop + `removeFile` 回调，单向数据流清晰。
- TaskIndexPanel 的 `contextMenu` / `groupContextMenu` 为 reactive 对象直接传给 TaskContextMenu 作 prop，子组件模板读取属性会追踪依赖，正常。

### 2.5 导出签名一致性

- store 旧 return 键集合（145 个）与新模块合并后的键集合逐一对比：**旧键零缺失**（`setViewingSideTask`、`viewingSideTaskId`、`reset` 在 session.ts 主文件补齐，reset 聚合四个模块 reset + viewingSideTaskId 置空 + forgetLastSession，顺序与原实现一致）。
- 新增导出（`applyRuntimeStatus`、`purgeSessionRuntime`、`sessionEntities`、`streamingAssistantMessageIds` 等 20 余个原内部实现细节）扩大了 store 表面，属可接受的副产品；如想收紧可后续从模块 return 中剔除纯内部成员。
- `stores/session.ts` 以 `export * from './session/types'` 保持原类型导出（`Session`、`TaskPhase`、`CloudProject` 等）路径不变；原来模块内私有的 `ACTIVE_PHASES`、`normalizeId`、`normalizeSession`、`persistLastSession`、`LAST_SESSION_KEY`、`DEFAULT_GROUP_*` 变为公开导出，无破坏性。

## 3. 建议（非阻塞）

| 级别 | 位置 | 说明 |
|---|---|---|
| 建议 | `TaskSessionGroupList.vue` / `TaskFocusList.vue` / `TaskArchivedSection.vue` | `defineProps` 中与 `defineModel` 同名的字段（`renamingValue`、`editingTitle`、`focusVisibleCount`、`historyCollapsed`）冗余，可删除 props 声明只留 defineModel。 |
| 建议 | `desktop/src/stores/session/*.ts` | 模块 return 中混入了原 store 的内部实现细节（如 `streamingAssistantMessageIds`、`filteredToolCallIds` 之外的内部 Map）。不影响正确性，后续可按需收窄导出面。 |
| 建议 | `docs/code-review` 之外的改动 | 本次未提交改动还包含 `scripts/e2e-setup.sh`（种子时间戳刷新/别名清理）与若干 Playwright 断言修正，属测试基建修复，与拆分无关，已抽看未见问题。 |

## 4. 已验证事项

- `cd desktop && npx vue-tsc -b` → exit 0（严格 TS 全量通过）。
- `cd desktop && npx vitest run` → 22 个测试文件、244 个用例全部通过。
- 模板事件链、defineModel 回写、store 模块间依赖注入与 computed 延迟求值均逐一人工核对。
