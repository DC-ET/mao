# 代码审查报告（第三轮）：多 Git 仓库性能优化修复核查（前端）

- 审查日期：2026-08-08
- 前两轮报告：`docs/code_review_20260808211948_frontend.md`、`docs/code_review_20260808213014_frontend.md`
- 本轮范围：核查「unavailable 仓库点开显示占位 + 重试」修复的正确性与新引入问题
- 涉及文件：`desktop/src/components/task/TaskInspector.vue`（模板 v-if/v-else + 解构 selectedRepo + 样式）
- 验证手段：`vue-tsc --noEmit` 通过；`mvn -q -o compile` 通过；node 实测 Electron `listGitRepos` 损坏→unavailable / 恢复→unavailable 消失 全流程

## 结论摘要

- 修复**正确**，未引入功能性 bug：四种渲染场景（不可用选中/正常选中/切换/重试恢复）逐一验证通过；单仓库模式不受影响。
- 发现 1 个轻微 UI 问题（重试恢复瞬间 GitChangeList 可能短暂展示旧文件数据，有 loading 兜底）与 2 条遗留/提示项（上轮发现 3 类型契约未修、unavailable 仓库被占位遮挡真实数据的设计取舍）。

---

## 一、修复核查

### 1.1 模板 v-if/v-else 渲染切换 — ✅ 正确

```vue
<div v-if="selectedRepo?.unavailable" class="git-state">该仓库 Git 状态不可用 + 重试</div>
<GitChangeList v-else ... />
```

| 场景 | selectedRepo | 渲染 | 结论 |
|---|---|---|---|
| 多仓库 + 选中仓库不可用 | unavailable=true | git-state 占位 | ✅ |
| 多仓库 + 选中仓库正常 | unavailable=undefined | GitChangeList | ✅ |
| 多仓库 + 下拉切到不可用仓库 | selectedRepoPath 变 → computed 重算 → unavailable=true | git-state（gitFiles 已被 watch(statusProviderRef) 清空） | ✅ 无残留 |
| 多仓库 + 切回正常仓库 | computed 重算 → falsy | GitChangeList（loading） | ✅ |
| **单仓库（根是 git）** | repos=[] → `find(...) ?? null` = **null** → `selectedRepo?.unavailable` = undefined → falsy | **恒 GitChangeList** | ✅ 不受影响 |

- 单仓库模式分析：`multiRepoMode=false` 时 repos 恒为空（根 git 或非 git 均返回 `repos: []`），`selectedRepo` 恒为 null，`selectedRepo?.unavailable` 恒 falsy，v-else 恒走 GitChangeList，与修复前行为完全一致。✅

### 1.2 重试按钮 refreshAll 后 unavailable 清除 — ✅ 正确（实测）

`refreshAll` → `refreshRepos()` → repos 更新 → `selectedRepo` computed（依赖 repos + selectedRepoPath）重算：
- 仓库恢复（getRepos 不再返回 unavailable）→ falsy → 自动切回 GitChangeList，随后 `refreshGit()` 拉取新状态；
- 仍不可用 → 占位保持。

**实测**：损坏 index 仓库 `listGitRepos` → `{unavailable: true}`；修复后 → `{branch, changedFileCount: 0}`（unavailable 消失）。恢复链路闭环。✅

### 1.3 selectedRepo computed 与模板联动 — ✅ 一致

`selectedRepo = computed(() => repos.value.find(r => r.path === selectedRepoPath.value) ?? null)`（useGitRepos.ts:30），依赖 repos 与 selectedRepoPath 两个响应源；refresh 成功、下拉切换均触发重算，模板同步更新。CLOUD/LOCAL 两 provider 均原样透传 `data.repos`，`unavailable` 字段不丢失。✅

### 1.4 单仓库模式 +N/-Y 摘要行 — ✅ 不受影响

本轮仅改 Git Tab 内部模板，摘要行（workspace tab）未动，单仓库分支仍走 `gitStatus.insertions/deletions`。✅

### 1.5 样式 — ✅ 无冲突

`.git-state` / `.git-retry` 在 TaskInspector 与 GitChangeList 各为 scoped 样式，作用域隔离，互不覆盖。✅

---

## 二、发现的问题

### [低] 问题 1：重试恢复瞬间 GitChangeList 可能短暂展示旧文件数据（有 loading 兜底，非功能性）

- **位置**：TaskInspector.vue git-tab 模板 + `watch(statusProviderRef)`（仅 statusProviderRef 变化时清空 gitFiles）
- **表现**：unavailable 仓库点重试 → refreshRepos 成功（unavailable 消失）→ 模板立即切回 GitChangeList，但**同一 repoPath 下 statusProviderRef 未变化**，`gitFiles` 不被清空；在 `refreshGit()` 完成前，GitChangeList 短暂展示该仓库上一轮的旧 `gitFiles`：
  - 若旧 files 为空 → `loading && files.length===0` 显示「加载中…」✅ 无误导；
  - 若旧 files 非空（该仓库在变 unavailable 前曾正常展示过）→ 短暂展示旧文件列表 + 旋转图标，随后被新数据覆盖。
- **建议**（可选）：在 `refreshAll` 内 refreshRepos 返回后、refreshGit 前主动 `gitFiles.value = []`（或在 git-state 占位期间即清空），消除旧数据闪现窗口。

### [低] 问题 2（遗留，上轮发现 3 未修）：unavailable 占位条目缺 `changedFileCount` 字段，与 TS 必填类型不符

- `git.ts` / `electron.d.ts` 仍声明 `changedFileCount: number` 必填；Electron `summarizeRepoDir` 的 unavailable 分支返回 `{name, path, unavailable: true}`（无 changedFileCount）。后端 unavailable DTO 因 `int` 默认值返回 0，与前端 undefined 不一致。
- 运行时无害（`undefined > 0 === false` 恰好符合「不可用不计变更」语义，CLOUD 的 0 同理）；但契约不严谨，建议 unavailable 分支统一补 `changedFileCount: 0` 或改类型为可选。

### [低] 问题 3（设计提示，非缺陷）：unavailable 仓库即使 getStatus 可用也被占位遮挡

- getRepos 扫描超时/失败（porcelain 超时、索引损坏）的仓库，点开后**一律**显示「该仓库 Git 状态不可用 + 重试」，不再展示 getStatus 可能返回的真实变更（上轮「getStatus 显示具体错误」的未闭环方案已由本方案取代，与需求声明一致）。
- 影响面：仅「getRepos 扫描失败但 getStatus 链路可用」的仓库（如瞬时超时）——用户需点重试等待重新扫描。属可接受的设计取舍，提示记录。

---

## 三、结论

- 本轮修复**正确完整**：v-if/v-else 切换、重试清除 unavailable、computed 联动、单仓库模式不受影响，全部验证通过；`vue-tsc` 与后端编译通过。
- 未引入功能性 bug；仅 1 条轻微 UI 闪现（问题 1，可选优化）与 2 条遗留/提示项（问题 2/3）。
- 后端进程管理健壮性修复（上轮发现 2/4：daemon 读线程 + waitFor 前置 + stderr DISCARD + destroyForcibly 后 waitFor）已一并核查，实现正确。
