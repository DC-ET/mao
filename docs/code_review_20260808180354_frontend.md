# 代码审查报告（第二轮）：多 Git 仓库工作区（前端）

- 审查日期：2026-08-08
- 历史报告：`docs/code_review_20260808175635_frontend.md`
- 本轮范围：核查三项修复的正确性与回归风险 + 遗漏 bug 排查。`vue-tsc` 类型检查通过。
- 结论：三项修复**方向正确、主体实现正确**，其中 #1、#2 可判定为已修复，#3 为部分修复（仍有残留缺口）。另发现 1 个新遗漏（requestSeq 的 `!p` 分支缺口，两处 composable 均存在）。

---

## 一、修复核查

### 修复 #1（切仓库窗口期 diff 错位）— ✅ 正确

`TaskInspector.vue` 新增 `watch(statusProviderRef, () => { gitFiles.value = [] })`。

- **执行顺序已验证**：用 Vue 3 实际运行验证（与组件内完全相同的两个 watch 顺序）——
  1. `useGitStatus` 内部 watch（先创建）先执行 → 同步置 `loading=true` 并发出异步请求；
  2. 后创建的 clear-files watch 再执行 → `gitFiles=[]`；
  3. 异步请求 resolve 后才写入新仓库文件。
  - 最终渲染时 `loading=true && files.length===0` → `GitChangeList` 命中「加载中…」占位，窗口期无法点击旧文件。✓
  - 两个 watch 在同一 pre-flush 队列中先后执行、早于任何 microtask，顺序无竞态。
- **单仓库回归**：单仓库模式下 `statusProviderRef === 原始 provider`，只在 `gitProviderRef`（会话/工作区切换）变化时触发；任务阶段结束触发的 `refreshAll` 不会改变 `statusProviderRef`（computed 缓存命中），**不会**清空文件造成闪烁。✓
- **残留（极轻微）**：该 watch 只清 `gitFiles`，不清 `gitStatus`/`gitError`。多仓库模式下 `gitStatus` 不参与渲染，无影响；仅在多仓库→单仓库模式切换的瞬间，摘要行可能短暂显示上一选中仓库的分支，随后被根仓库刷新结果覆盖。

### 修复 #2（useGitRepos.refresh 请求序号保护）— ✅ 正确（有一处小缺口，见新问题 R2）

- try/catch/finally 三处均有 `seq !== requestSeq` 守卫，与 `useGitStatus` 模式一致；finally 中 `loading` 仅由最新请求控制。✓
- 乱序场景（挂载立即刷新 vs 切 Tab refreshAll vs 阶段结束刷新）均以最后一次为准。✓

### 修复 #3（getRepos 失败保留数据）— ⚠️ 部分修复

catch 分支保留 `repos/isRootGit/selectedRepoPath`，仅记录 error——「网络抖动时多仓库 UI 不消失」的目标在**曾成功加载过**的前提下达成。但存在残留缺口：

1. **error 从未被展示**：`TaskInspector.vue:280-289` 解构 `useGitRepos` 时仍只取 `loading: reposLoading`，没有取 `error`。catch 里记录的 `error` 是死数据，用户看到的是**无任何提示的过期数据**（如摘要行的 +X -Y、下拉列表可能已过期）。
2. **首次加载失败仍会静默消失**：若从未成功过，`repos=[]`、`isRootGit=false` → `multiRepoMode=false`，同时根仓库探测也失败 → Git Tab 与摘要行整体消失，无错误、无重试入口（与原问题 #3 的故障表现相同）。
3. **过期数据掩盖真实状态**：离线期间仓库被删除 / 根目录变成 git 仓库时，UI 仍显示多仓库模式。此时点击过期摘要项 → `selectRepo` 校验通过（过期列表仍含该项）→ `getStatus` 报错 → 变更列表显示错误 + 重试，属可恢复的降级，不崩溃。✓（可接受）

建议：解构 `error` 并在 Git Tab 工具栏或摘要行展示「仓库列表刷新失败」轻提示 + 复用现有重试入口（`GitChangeList` 的 refresh 已走 `refreshAll`，天然可重试）。

---

## 二、新发现的问题

### R1（低-中）useGitRepos 的 `!p` 早退分支未递增 requestSeq，迟到响应可污染状态

- **位置**：`useGitRepos.ts:32-39`（`refresh()` 的 `!p` 分支）；`useGitStatus.ts:19-25`（同构，**本次需求前已存在**）。
- **场景**：provider 存在时发起刷新（seq=1 在途）→ provider 变为 null（如会话切换瞬间 `sessionId` 为空、LOCAL 工作区清空）→ watch 触发 `refresh()`，走 `!p` 分支清空 `repos`，但**没有 `requestSeq++`** → 在途请求（seq=1）返回时 `1 === requestSeq(1)` 判定通过 → **用旧会话/旧工作区的数据重新填满状态**，直到下一次 provider 变化才被纠正。
- **影响**：窗口期短暂显示错误仓库列表；多仓库模式下可能连带触发一次错误 repoPath 的 `getStatus`（失败后展示错误态，可恢复）。
- **建议**：在 `!p` 分支里也执行 `requestSeq++`（两处 composable 同步修改），使在途请求全部失效。

### R2（极轻微）clear-files watch 未同步清 `gitStatus`

- `TaskInspector.vue:314-316`。多仓库内部切换不渲染 `gitStatus` 无影响；仅「多仓库→单仓库」模式退出瞬间摘要行可能闪现旧分支名（下一帧被根仓库结果覆盖）。如在意可一并清 `gitStatus.value = null`。

### R3（提示，非 bug）多仓库首次加载 Git Tab 短暂闪烁

- 加载时序：根探测进行中 `showGitTab=true` → 根探测返回非 git → `showGitTab=false`（约一帧）→ repos 到达 → `multiRepoMode=true` → 再次显示。属过渡帧，功能无影响，可不处理。

---

## 三、对未修改项的意见

| 项 | 意见 |
|---|---|
| 低#5 单仓库每次多一次 getRepos | **同意不修**。成本为一次轻量 IPC/API 调用（LOCAL 下多为缓存级目录扫描），换来的复杂度不值当。 |
| 低#6 refreshAll 与 watch 冗余刷新 | **同意不修**。`requestSeq` 已保证结果正确，冗余仅限同一 repoPath 的一次重复请求，且发生在用户可感知之前。 |
| 低#7 canUseLocalGit 不校验 gitRepos | **同意，且理由成立**。若校验 `gitRepos`，旧 Electron 壳（仅有 gitStatus）会整体禁用 LOCAL Git 能力，退化比多仓库降级更严重。当前缺失时仅 getRepos 报错、被 try/catch 兜底，符合向后兼容。 |
| 低#8 GitReposDTO getter 命名 | **同意暂不修**，但提醒：`@Data` + 手写 `getIsRootGit()` + `@JsonProperty("isRootGit")` 的叠加在未来若有人改字段名/读 `getRootGit()` 会产生序列化双键的隐患，建议在该类下次被改动时顺手统一。 |

---

## 四、结论

- 修复 #1、#2 判定**已修复且无回归**（watcher 顺序经实证验证；requestSeq 覆盖 try/catch/finally）。
- 修复 #3 **部分修复**：需补「error 上屏」与「首次加载失败兜底」两处才能闭环。
- 新问题仅 1 个（R1，低严重度，两处 composable 同构缺口），其余为轻微提示。
- 未发现其他本次需求引入的遗漏 bug。
