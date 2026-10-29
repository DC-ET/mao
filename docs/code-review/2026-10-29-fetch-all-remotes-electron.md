# 代码审查报告：Git 远端刷新升级为「并行逐远端 fetch」（Electron / LOCAL 侧）

- 审查对象：主检出 `mao/`（`/data/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`）未提交改动中的 Electron 部分 + 前端 provider：
  - `desktop/electron/gitStatus.cjs` —— `refreshGitStatus` 改为 `Promise.all` **并行逐远端** `git fetch --prune <remote>`；`gitTimeoutMs()`（`MAO_TEST_GIT_TIMEOUT_MS` 可注入，`<1000ms` 视为无效，默认 60s）；超时文案按实际预算插值
  - `desktop/electron/gitOperations.cjs` —— `fetch` 同并行化；`describeGitFailure` 定时文案同插值
  - `desktop/electron/gitStatus.test.cjs`、`desktop/electron/gitOperations.test.cjs` —— 挂起/超时/多失败/参照远端/并行有界用例
  - `desktop/src/composables/workspace-git-provider.ts` + `.test.ts` —— CLOUD 侧 refresh/fetch 的 `{ timeout: 150_000 }` 及其断言
- 审查基准：任务给出的 6 条规格 + 前三轮确认的修复口径。
- 修订：**第 3 轮复查（2026-10-29，收尾轮）**——只审本轮 delta（①env 改名 + `<1s` 回落；②3 条新用例；③provider 断言与注释），并复跑变异 B/C 确认已能捕获。结论：**本轮 delta 全部通过，无新 bug；观察 7/8/9 关闭，观察 10 按现状保留（理由成立）**。整体仍为**可合并、阻塞 0 条**。
- 审查日期：2026-10-29。审查方式为**只读**：未修改任何源码，未 commit / push。
- 审查时的文件指纹（md5）：

  | 文件 | 第 1 轮 | 第 1 轮复查 | 第 2 轮复查 | **第 3 轮复查（本轮）** |
  |---|---|---|---|---|
  | `desktop/electron/gitStatus.cjs` | `c083104f…` | `093f8dd3…` | `d2def617…` | `d398004c92bc5120f795a279baedfdd3` |
  | `desktop/electron/gitOperations.cjs` | `cc13bbdc…` | `ff62fc73…` | `fb8aab8e…` | `43b4f7272db51e7582fde63bce3a2537` |
  | `desktop/electron/gitStatus.test.cjs` | `bea37feb…` | `3a5c4130…` | `e6f3f7a1…` | `d3654955f0460a40f18339695ddce3c0` |
  | `desktop/electron/gitOperations.test.cjs` | `39a92658…` | `c0220969…` | `2ca584cf…` | `77551b2a4104224f0afa9ee03f2630dc` |
  | `desktop/src/composables/workspace-git-provider.ts` | — | — | `ac04d5ee…` | `645f4bce519dd8687464ec5c3d266f4c` |
  | `desktop/src/composables/workspace-git-provider.test.ts` | — | — | （未改） | `4b59f55f12b93790e6938aef534201bd` |

- 环境：node v22.14.0、git 2.34.1、`LANG=en_US.UTF-8`。
- 审查方式（本轮）：①delta diff 逐行走读（`gitStatus.cjs:7-12,36,514`、`gitOperations.cjs:7-12,34,62`、两个测试文件的新用例、`workspace-git-provider.ts:422-434,574-586`、provider 测试新用例）；②`node --test` 两目标文件 + 全量 `desktop/electron/*.test.cjs`；③`npx vitest run src/composables/workspace-git-provider.test.ts`；④**变异测试复跑**（在 `/tmp/mut3` 的源码副本上重放第 2 轮的变异 B/C，另加变异 D 检验 `<1000ms` 守卫）；⑤`MAO_TEST_GIT_TIMEOUT_MS` 边界探针（1000 / 999）。临时脚本与副本全部删除。

---

## 一、总体结论

**可合并；阻塞 0 条；前三轮问题全部关闭，本轮 delta 复核通过，无新 bug。**

| 本轮 delta | 状态 | 复核证据 |
|---|---|---|
| 观察 7：env 生产暴露 | **已收敛 ✅** | 变量改名 `MAO_TEST_GIT_TIMEOUT_MS`（与仓库既有 `MAO_TEST_TMP_DIR`、以及 CLOUD 侧 `backend-ts/src/file/git-write-operation.service.ts:33-37` 完全同名同规则）；`<1000ms` 回落默认 60s；实测 `=1000` → 1s 且文案「Git fetch 超过 1 秒，已终止」，`=999` → 60s 且文案「Git fetch 超过 60 秒，已终止」（不会出现「超过 0 秒」） |
| 观察 8：变异 B/C 存活 | **已修复 ✅** | 变异 B（超时文案写死 60 秒）→ `not ok 41 - refreshGitStatus reports the timeout message for a single hanging remote`；变异 C（`fetch` 改回串行）→ `not ok 25 - fetch fetches hanging remotes in parallel within a single timeout budget`，`elapsed=6016ms` |
| 观察 9：客户端 150s 无断言 | **已修复 ✅** | provider 新用例断言 refresh/fetch 两个 POST 的完整入参（含 `{ timeout: 150_000 }`），该 describe 的 `beforeEach` 已 `api.post.mockClear()`（`workspace-git-provider.test.ts:154-157`），`mock.calls[0]/[1]` 索引安全；两处注释补「150s 客户端预算须大于该后端预算」；`vitest` 23/23 通过 |
| 观察 10：并发上限 / `FETCH_HEAD` | **保持现状（同意）** | 加并发上限会重新引入 `ceil(N/K)×60s` 叠加（正是建议 3 要消除的形态）；`FETCH_HEAD` 全仓无消费方（已 grep 确认）。两者均记录在 §六 |

- 回归：两目标文件 **72 例 / 71 过 / 1 已知基线**；全量 electron **180 例 / 178 过 / 1 已知基线 / 1 平台跳过**；provider **23/23**。
- 规格 1-6 保持成立，常规路径与并行竞态结论延续前两轮（§五）。

---

## 二、问题状态总表（最终）

| 项 | 级别 | 最终状态 |
|---|---|---|
| 重要 1 超时被判部分失败 → 误报成功 | 重要 | **已修复**（第 1 轮复查通过；第 3 轮无回归） |
| 建议 1 分母用已配置远端数（`skipDefaultUpdate` 误判） | 建议 | **已修复**（第 1 轮复查通过） |
| 建议 2 新增分支零用例覆盖 | 建议 | **已修复**（第 2 轮补齐主用例 + 第 3 轮补齐单挂起超时文案 / `fetch` 并行有界断言） |
| 建议 3 超时预算 N×60s | 建议 | **已修复**（第 2 轮并行化：2/3 挂起均 60s） |
| 观察 4 `skipDefaultUpdate` 语义 | 观察 | **产品决定保留全量获取**（CHANGELOG 已写明），关闭 |
| 观察 5 多失败文案无原因 | 观察 | **产品决定保留名单口径**，关闭 |
| 观察 6 JSDoc 陈旧 | 观察 | **已修复** |
| 观察 7 env 生产暴露 | 观察 | **已收敛**（改名 + `<1s` 无效），关闭 |
| 观察 8 两处细节无用例 | 观察 | **已修复**（变异 B/C 现已可捕获），关闭 |
| 观察 9 客户端预算无断言/无注释 | 观察 | **已修复**，关闭 |
| 观察 10 并发上限 / `FETCH_HEAD` | 观察 | **保持现状**（理由成立），关闭 |
| 跨层观察：部分失败文案在状态路径 UI 不展示 | 跨层 | 仍待 UI 侧跟进（不属 Electron 范围） |

---

## 三、规格逐条核对（6 条，结论延续前轮）

| # | 规格 | 实现 / 实测 | 结论 |
|---|---|---|---|
| 1 | 获取**全部**远端（`Promise.all` 并行逐远端 `fetch --prune`） | `gitStatus.cjs:501-504`、`gitOperations.cjs:423-426`；P1/S7 实测全部远端引用前进 | ✅ |
| 2 | 无 remote 两条既有文案 | `gitStatus.cjs:489-491`、`gitOperations.cjs:413`；S5 实测 | ✅ |
| 3 | 部分失败：`available=true` + 既有文案；不覆盖 ahead/behind 读失败 | `gitStatus.cjs:507-527`、`gitOperations.cjs:433-441`；S1 实测 | ✅ |
| 4 | 全部失败：超时文案（按预算插值）/ sanitize 摘要；`fetch` → `success=false` | `gitStatus.cjs:510-517`、`gitOperations.cjs:427-432`；P5（2s）→「Git fetch 超过 2 秒，已终止」/「Git 操作超过 2 秒，已终止」；本轮新增用例 72 锁定单挂起文案 | ✅ |
| 5 | 参照远端仍用 `selectFetchRemote`，为 null 时 `hasCommitsToPush=false` | `gitStatus.cjs:532-565`；S6 实测 | ✅ |
| 6 | 无「多个远端无法确认」判定、无 `fetch --all` / `extractUnfetchedRemotes` 残留 | 全仓 grep 零命中（`fetch --all` 仅存于历史报告文本） | ✅ |

---

## 四、本轮 delta 复核证据

### 4.1 观察 7：env 改名 + `<1000ms` 回落 —— 通过

**实现**（`gitStatus.cjs:7-12`、`gitOperations.cjs:7-12`，逐字相同）：

```js
const GIT_TIMEOUT_MS = 60_000
/** 测试可用 MAO_TEST_GIT_TIMEOUT_MS 覆盖以缩短挂起类用例的等待时间（小于 1s 视为无效）。 */
function gitTimeoutMs() {
  const override = Number(process.env.MAO_TEST_GIT_TIMEOUT_MS)
  return Number.isFinite(override) && override >= 1000 ? override : GIT_TIMEOUT_MS
}
```

- **命名一致性**：仓库既有同类钩子 `MAO_TEST_TMP_DIR`（`backend-ts/src/testing/tmp-dir.ts:33-35`）；CLOUD 侧 `backend-ts/src/file/git-write-operation.service.ts:33-37` 使用**同名** `MAO_TEST_GIT_TIMEOUT_MS` 且**同规则**（`>= 1000`），两端口径一致，不存在「后端认一个名、桌面端认另一个名」的坑。
- **边界实测**（假 `git` 只挂起指定远端；`env_probe.cjs`）：

  ```
  边界-有效 (MAO_TEST_GIT_TIMEOUT_MS=1000) → 1s,   error="Git fetch 超过 1 秒，已终止"
  边界-无效 (MAO_TEST_GIT_TIMEOUT_MS=999)  → 60s,  error="Git fetch 超过 60 秒，已终止"
  ```

  `=999` 走默认预算（不会出现「超过 0 秒」），`=1000` 生效；`Number('abc')`/`'0'`/负数/`'Infinity'` 均落到同一回落分支（`Number.isFinite && >= 1000`）。
- **不加 NODE_ENV 守卫的取舍**：同意——Electron 生产进程通常没有 `NODE_ENV`，加守卫只会形成「后端受保护、桌面端不受」的假安全感；改名 + `<1s` 下限已把误设后果压到最低（即便被误设也不是 0 秒级误报）。

### 4.2 观察 8：变异 B/C 现已可捕获 —— 通过

在 `/tmp/mut3`（当前源码副本）上重放第 2 轮的变异，跑对应测试文件：

| 变异 | 第 2 轮结果 | 本轮结果 |
|---|---|---|
| **B**：`refreshGitStatus` 超时文案写死 `Git fetch 超过 60 秒，已终止` | 存活（40/40 过） | **`not ok 41 - refreshGitStatus reports the timeout message for a single hanging remote`**（`# pass 40 / # fail 1`） |
| **C**：`gitOperations.fetch` 并行改回串行 | 存活（仅已知基线失败） | **`not ok 25 - fetch fetches hanging remotes in parallel within a single timeout budget`**，`error: 'elapsed=6016ms'` |
| **D**（本轮附加）：去掉 `<1000ms` 守卫 | — | 存活（41/41 过）→ 见 §六 遗留观察 11 |

新用例本身：①`refreshGitStatus reports the timeout message for a single hanging remote` 断言精确文案 + `remoteStatusAvailable=false`；②`fetch fetches hanging remotes in parallel within a single timeout budget` 用 3 个挂起远端 + `elapsed < 4000` + 全失败文案，串行必然 6s 越界，与 `gitStatus` 侧同类用例形成双端对称覆盖。挂起夹具沿用真实 TCP「accept 后不回包」（`t.after` 销毁 socket 并关服务器），预算注入 `withGitTimeout` 在 `finally` 还原/删除环境变量（无跨用例污染）。

### 4.3 观察 9：provider 断言与注释 —— 通过

- 注释已补（`workspace-git-provider.ts:424`、`:576`）：「…最坏等待以单个远端的 60s 超时为界；150s 客户端预算须大于该后端预算」。
- 新用例（`workspace-git-provider.test.ts:204-217`）用 `toEqual` 断言两次调用的**完整**入参：

  ```ts
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(['/files/workspace-git-refresh', { sessionId: 7, repoPath: 'r' }, { timeout: 150_000 }])
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(['/files/workspace-git-fetch', { sessionId: 7, repoPath: 'r' }, { timeout: 150_000 }])
  ```

  该 describe 的 `beforeEach` 已 `vi.mocked(api.post).mockClear()`（`:155-156`），`calls[0]/[1]` 索引不会串到前序用例，断言稳定。
- 实测：`npx vitest run src/composables/workspace-git-provider.test.ts` → **23/23 通过**。

### 4.4 整体回归（本轮实跑）

```
node --test desktop/electron/gitStatus.test.cjs desktop/electron/gitOperations.test.cjs
  → # tests 72  # pass 71  # fail 1（已知基线：commit 身份）
node --test desktop/electron/*.test.cjs
  → # tests 180 # pass 178 # fail 1（同上） # skipped 1（pwsh 不可用）
npx vitest run src/composables/workspace-git-provider.test.ts
  → 23/23 通过
```

---

## 五、前两轮结论保持（本轮未触及相关代码，摘要）

1. **重要 1（超时误判为部分失败）已修复**：第 1 轮复现形态（快速失败 + 挂起，恰好 2 远端）→ `available=false` + `全部远端获取失败：aaa-broken、bbb-hang`；单远端挂起 → `Git fetch 超过 60 秒，已终止`。
2. **建议 1 已修复**：`skipDefaultUpdate` 远端现在确实被 fetch（`behind` 真实 1、引用前进）。
3. **建议 3 已修复**：并行化后 P4（2 挂起）= **60s**、P4b（3 挂起）= **60s**（此前 2 挂起 = 120s）；P1 复跑仍保持「挂起不阻断其余远端 + 失败归属到具体远端」（`available=true`、`zzz-good` 引用前进、`behind=1`）。
4. **常规路径零回归**：S1 部分失败 / S2 单失败脱敏（无 `secret`）/ S3 多失败名单 / S4 `skipDefaultUpdate` / S5 无远端 / S6 参照远端 null / S7 全成功多远端 / S8 三远端连续 20 轮刷新（`badRounds=0`）。
5. **并行引用竞态未复现**：240 轮「两远端各新增同名新 tag → 并发 fetch」非零退出 0 次、无 lock 报错；应用零引用 `FETCH_HEAD`。

---

## 六、遗留观察与风险

1. **遗留观察 11（极低优先，新增）**：`<1000ms` 守卫本身没有用例锁定（变异 D 存活）。该守卫的目的只是避免误设出「超过 0 秒」文案，触发前提是环境变量被误配，风险极低；若想锁定，可加一条断言 `MAO_TEST_GIT_TIMEOUT_MS=999` 时 `gitTimeoutMs()` 结果仍为 60000（需导出该函数）或在测试里以短预算 + 999 无法验证（会等 60s），故不强制。
2. **同远端并发竞态（既有形态，建议另起跟进）**：开发者实测 refs 前进时 `cannot lock ref 'refs/remotes/…': is at X but expected Y`（双方一个失败、ref 最终正确）。该竞态源于 `refreshGitStatus`（不持写锁）与 `fetch`（`withWriteLock`）可能并发 fetch **同一个**远端，第 1 轮之前即存在；本轮并行只作用不同远端，未改变它。用户可见后果是一次伪「部分远端获取失败」。建议后续单独立项：失败重试一次，或写操作在途时 `refreshGitStatus` 跳过 fetch。
3. **`MAO_TEST_GIT_TIMEOUT_MS` 仍可影响生产进程**（改名后误设概率已极低）：若被设成 >150_000，CLOUD 路径会先撞客户端 150s 超时（LOCAL 无此问题）；两处注释已互指该关系，无需改动。
4. **未做真机 Electron UI 手测**：仍为 node 层调用被测模块 + 真实 git 夹具 + vitest 单测；UI 呈现按代码走读判断（§七）。
5. **假 git / 本地路径夹具的边界**：挂起用假 `git` 确定性触发 SIGKILL；tag 竞态压测用本地路径远端（传输极快、竞态窗口小于网络远端），理论上窗口更大但形态相同。
6. **工作区并发**：同工作区存在他人（CLOUD 侧审查）的未跟踪报告 `docs/code-review/2026-10-29-fetch-all-remotes-backend.md`；本轮未改动、未依赖任何他人文件，临时脚本/副本均在 `/tmp` 且已删除。

## 七、跨层观察（UI，仍待跟进，不属 Electron 范围）

部分失败文案在状态路径上仍不会显示：徽标仅在 `remoteStatusAvailable === false` 时使用 `remoteStatusError`（`desktop/src/components/git/GitManagerPanel.vue:319-348`）；`GitChangeList.vue:137-138` 的 `remoteStatusError` prop 未被使用；`useGitStatus.ts:75-97` 自动确认不弹 toast。即「部分远端获取失败」只有手动点刷新（`fetch` → `ElMessage.success`，`desktop/src/composables/useGitOperations.ts:64-66`）才可见。产品已决定本轮不动，结论保持。

## 附录 A：历史问题与决定（全部关闭）

| # | 轮次 | 内容 | 终态 |
|---|---|---|---|
| 重要 1 | 第 1 轮 | `partial` 判定未排除 `timedOut` → 超时被当作部分失败（`available=true` + 「其余远端已更新」/`success=true`） | 已修复（逐远端循环 + 失败归属） |
| 建议 1 | 第 1 轮 | 分母用已配置远端数 → `skipDefaultUpdate` 误判 | 已修复 |
| 观察 6 | 第 1 轮复查 | `gitOperations.cjs` JSDoc 仍写 `fetch --all --prune` | 已修复 |
| 建议 3 | 第 1 轮复查 | 串行逐远端使超时叠成 N×60s（2 挂起 = 120s） | 已修复（并行化，2/3 挂起均 60s） |
| 建议 2 | 第 1/2/3 轮 | 新增分支用例缺口 | 已修复（4 + 2 条新用例，变异 B/C 均可捕获） |
| 观察 4 / 5 | 第 1 轮复查 | `skipDefaultUpdate` 语义、多失败文案无原因 | 产品决定保留现状（CHANGELOG 已写明），关闭 |
| 观察 7 / 8 / 9 | 第 2 轮复查 | env 生产暴露、两处细节无用例、客户端预算无断言 | 已收敛 / 已修复 / 已修复 |
| 观察 10 | 第 2 轮复查 | 并发上限、`FETCH_HEAD` 归属 | 保持现状（理由成立） |

## 附录 B：各轮复现脚本清单（均已删除，可按正文重建）

| 轮次 | 用途 | 关键结论 |
|---|---|---|
| 1 | 真实 git 失败形态矩阵、`--all` 跳过 `skipDefaultUpdate`、假 git 超时 | 五类失败均 `error: Could not fetch <name>`；`--all` 跳过 skip 远端；超时被误判为部分失败（当时的 bug） |
| 1 复查 | 逐远端循环版 P1/P4/P4b/P5、常规矩阵 S1-S8 | 超时归属正确；**2 挂起 = 120s（叠加）** |
| 2 复查 | 并行版 P1/P4/P4b、8 组矩阵 + 20 轮连刷、变异 A/B/C、240 轮 tag 竞态 | **2/3 挂起均 60s**；`badRounds=0`；变异 A 被捕获、B/C 存活 |
| 3 复查（本轮） | `MAO_TEST_GIT_TIMEOUT_MS` 边界探针（1000/999）、变异 B/C/D 复跑、provider 断言核对 | `=1000`→1s / `=999`→60s；**变异 B/C 现被捕获**、D 存活（见 §六 观察 11）；provider 23/23 |

