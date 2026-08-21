# 代码审查报告（第三轮）：多 Git 仓库工作区（前端）

- 审查日期：2026-08-08
- 历史报告：`docs/code_review_20260808175635_frontend.md`、`docs/code_review_20260808180354_frontend.md`
- 本轮范围：核查 R1 修复、error 上屏修复的正确性与回归风险 + 遗漏排查。`vue-tsc` 类型检查通过。
- 结论：两项修复**均正确、无回归**；未发现新的功能性 bug。仅 2 条低优先级提示（均为修复#3 设计权衡的已知残留，非新缺陷）。

---

## 一、修复核查

### R1（useGitRepos.refresh `!p` 早退分支加 requestSeq++）— ✅ 正确完整

`useGitRepos.ts:33-40`：

```js
if (!p) {
  requestSeq++
  repos.value = []
  ...
  loading.value = false
  error.value = ''
  return
}
```

- **失效逻辑验证**：provider 有效时发起刷新（seq=1，在途）→ provider 变 null → `!p` 分支 `requestSeq++`（→2）→ 在途请求 resolve 时 `1 !== 2` 提前 return，不再写状态；finally 中 `1 === 2` 为 false 不会动 `loading`，而 `!p` 分支已同步置 `loading=false`，两者无冲突。✓
- **覆盖完整性**：`!p` 分支是同步早退，不进入 try/finally；新增的 `requestSeq++` 使该分支之前的**所有**在途请求（seq < 新值）全部失效，包括多级联的 provider null→有效→null 抖动序列。✓
- **immediate 初始调用**（provider=null 时 watch 首次触发）`requestSeq` 从 0→1，无在途请求，无影响。✓
- 与 `useGitStatus` 的同构存量问题（未改）在本次需求范围内无可见影响（gitProvider 为 null 时 `showGitTab`/`gitSummaryVisible` 均因 `!props.gitProvider` 恒为 false，残留状态不渲染）。

### 修复#3 残留（error 上屏）— ✅ 正确，无显示回归

改动三处：
1. `TaskInspector.vue:286` 解构 `error: reposError`；
2. `gitSummaryVisible` 新增 `if (reposError.value || gitError.value) return true`；
3. 摘要行错误分支 `v-else-if="gitError || reposError"` → 「Git 状态不可用」。

**逐一验证的显示场景（无回归）**：

| 场景 | reposError / gitError | 摘要行表现 | 结论 |
|---|---|---|---|
| 单仓库 git 工作区（正常） | 均为 ''（getRepos 返回 `isRootGit:true,error:undefined`→`error||''`；getStatus 成功） | 分支 / +X -Y，错误分支不触发 | ✓ 与旧版一致 |
| 单仓库非 git 工作区（正常） | 均为 ''（getRepos 返回 `{isRootGit:false,repos:[]}`；getStatus 返回 `{isGit:false}` → `error=''`） | gitSummaryVisible=false，不显示 | ✓ 与旧版一致 |
| 单仓库 git 工作区 + getStatus 失败 | gitError 非空 | 显示「Git 状态不可用」（旧版此场景完全静默） | ✓ 行为改进非回归 |
| 非 git 工作区 + getRepos 失败 | reposError 非空 | 显示「Git 状态不可用」 | ✓ 新增预期行为 |
| 加载中 | error 已被 refresh 起始处清空，与 loading 互斥 | 「检测 Git…」正常 | ✓ 无冲突 |
| 单仓库 git 工作区手动刷新中 | gitStatus.isGit 恒 true | 正常显示 | ✓ 不会误落 false |

- **reposError 生命周期完整**：`!p` 分支、refresh 起始、成功路径（`result.error || ''`）三处均会清空/更新，失败一次后保持非空属于「错误持续态」合理表现，非残留泄漏。✓

---

## 二、低优先级提示（均非新缺陷，可择机处理）

### P1：多仓库模式下 reposError 不上屏

- **位置**：`TaskInspector.vue:107-125`（摘要行多仓库分支无错误展示）+ 模板 `v-else-if="gitError || reposError"` 仅在非多仓库 `v-else` 分支。
- **表现**：多仓库模式 + `getRepos` 失败（保留旧数据）时，摘要行仍显示旧数据（changedRepos / 「N 个仓库 · 全部干净」），无「刷新失败」提示；Git Tab 下拉与列表同样无 reposError 展示。用户看到过期数据但无从感知。
- **说明**：这是修复#3「保留上次成功数据」设计的已知代价（第二轮已述「过期数据掩盖真实状态」），本轮 error 上屏仅覆盖了非多仓库分支。若需闭环，可在多仓库分支的「检测 Git…」旁追加轻量失败标记（如 `reposError ? '刷新失败' : ''`），不阻塞本次验收。

### P2：非多仓库错误态无重试入口

- 非 git 工作区 + 首次 `getRepos` 失败 → 摘要行显示「Git 状态不可用」，但 Git Tab 不显示（`showGitTab` 未包含 reposError 条件，属预期——无数据可展示），摘要行亦无重试按钮；用户只能等待任务阶段结束的自动刷新。可接受，如在意可在摘要行错误文案上加点击重试（复用 `refreshAll`）。

---

## 三、结论

- R1 修复：**正确完整**，在途请求污染已闭环，finally/loading 无冲突。
- error 上屏：**正确**，七种显示场景逐一验证无回归，错误仅在真实失败时触发，且改善了旧版「getStatus 失败完全静默」的问题。
- 未发现其他本次需求引入的潜在 bug。
