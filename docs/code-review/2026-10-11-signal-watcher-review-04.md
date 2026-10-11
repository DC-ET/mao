# 信号哨兵（Signal Watcher）第 4 轮代码审查（最终轮）

- 审查对象：`.worktrees/signal-watcher`（分支 `feat/signal-watcher`）未提交改动
- 审查性质：只读审查，未修改任何仓库源码；临时 spec 写在仓库内 `backend-ts/src/signal/`，**跑完已全部删除**；MySQL 实证用临时库 `tmp_review4`，**已 DROP**
- 审查重点：BUG-I / BUG-L / BUG-G 三项修复的正确性、是否引入反向问题、是否还有横穿多轮的遗留

## 已执行命令与基线

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --coverage=false src/signal src/inbox` | 13 files / **175 tests 全绿** |
| MySQL 8 实测（`recordFailure` / `markChecked` SQL 语义） | 见下文 |

> 说明：本轮沿用第 3 轮的方法论——SQL 语义用真实 MySQL 执行验证，service 层用复刻真实 SQL 求值顺序的模拟器验证，不依赖 fake repo。

## 总体结论

**本轮不可合入：发现 1 个阻塞级问题（BUG-N），由本轮 BUG-G 的修复引入。**

BUG-I 与 BUG-L 两项修复**完全正确**（MySQL 实测 + 单测验证）。BUG-G 的 SQL 写法本身方向正确，但 **service 层三处 `markChecked` 调用仍硬编码 `consecutiveFailures: 0`**，没有传「本次读到的快照值」，导致条件清零永远不成立——失败计数一旦非 0 就**永久卡住**，且「连续失败 5 次自动停用」退化为「累计失败 5 次即停用」。这是比原 BUG-G 更严重的反向缺陷。

| 编号 | 级别 | 结论 |
| --- | --- | --- |
| BUG-N | **阻塞** | 新引入，需修（改 3 处调用传快照值 + 1 行 SQL 微调） |
| BUG-I | — | 修复正确，已验证 |
| BUG-L | — | 修复正确，已验证 |
| BUG-M | 建议（不阻塞） | 前端仍无法清空请求头（第 2 轮遗留，已知限制） |

---

## 阻塞

### BUG-N：`markChecked` 条件清零永不生效——失败计数卡住，「连续失败」退化为「累计失败」

- **文件**：`backend-ts/src/signal/watcher.service.ts:360`、`:370`、`:419`（三处 `consecutiveFailures: 0`）+ `backend-ts/src/signal/signal.repository.ts:157`（`IF(consecutive_failures = ?, 0, consecutive_failures)`）
- **问题**：本轮 BUG-G 把 SQL 改成「仅当库里仍等于本次读到的值时才清零」，语义正确；但调用方传入的 `patch.consecutiveFailures` 是**硬编码的 `0`**，而不是本次 `findById` 读到的 `watcher.consecutiveFailures`。于是：
  - 库内为 0（常态）→ `IF(0 = 0, 0, 0)` → 清零 ✓
  - 库内为 1（上次失败、本次成功）→ `IF(1 = 0, 0, 1)` → **保持 1，永远清不了零**
- **触发场景**：任何哨兵失败 1 次后恢复稳定——计数器永久停在 1。
- **影响（两层）**：
  1. **展示错误**：桌面端 / admin 列表长期显示「连续失败 1」，用户误以为仍在故障；
  2. **语义错误（更严重）**：`recordFailure` 的停用判定 `IF(consecutive_failures >= 5)` 用的是**累加值**，而累加值永不归零 → 只要哨兵**累计**失败 5 次（哪怕中间成功过很多次）就被停用并发站内信，完全违背 CHANGELOG / mao-cli 文档承诺的「连续失败 5 次自动停用」，也违背技术方案决策 8。
- **MySQL 实测**（复刻真实 SQL）：
  ```
  失败1次后            1
  markChecked(传0)后   1
  再次成功后           1
  第三次成功后         1     ← 期望 0
  ```
- **service 层语义模拟**（复刻真实 SQL 求值顺序）：
  ```
  第1轮 失败+成功后: failures = 1 | status = ACTIVE
  第2轮 失败+成功后: failures = 2 | status = ACTIVE
  第3轮 失败+成功后: failures = 3 | status = ACTIVE
  第4轮 失败+成功后: failures = 4 | status = ACTIVE
  第5轮 失败+成功后: failures = 5 | status = DISABLED   ← 5 轮里每轮后面都成功了
  ```
  期望：每轮成功后清零，5 轮后 `failures = 1` 且仍 `ACTIVE`。
- **为何现有单测没发现**：`watcher.service.spec.ts:97` 的 fake repo `markChecked` 是 `row.consecutiveFailures = patch.consecutiveFailures`（无条件写 0），与真实 SQL 的 `IF(...)` 语义不一致；`signal.repository.spec.ts` 只断言 SQL 文本与参数下标，没有执行真实 SQL。两者都无法暴露「service 传错值」。
- **修复建议**（两处一起改，缺一不可）：
  1. `watcher.service.ts` 三处 `markChecked` 调用把 `consecutiveFailures: 0` 改为 `consecutiveFailures: watcher.consecutiveFailures ?? 0`（即本次入口 `findById` 读到的快照值）；
  2. `signal.repository.ts` 的注释已说明语义，可保持不变；`patch.consecutiveFailures` 字段名建议改为 `observedFailures` 以免再被误用为「要写入的值」。
- **修复后自校验**（已用模拟器反向验证）：
  - 传快照值 → 失败 1 次后成功，计数归 0 ✓
  - 多实例并发在途累加到 3，传快照 0 → 保留 3 ✓（原 BUG-G 的目标场景仍然达成）
- **是否已用测试验证**：是。MySQL 实测 + service 层真实 SQL 求值顺序模拟，双向（修复后预期行为）均已验证。

---

## 已验证正确的修复

### BUG-I：第 5 次失败才停用 ✓

`recordFailure` 的 `status = IF(consecutive_failures >= ?, 'DISABLED', status)` 利用了 MySQL SET 从左到右求值（第一个赋值已把列加成新值），与阈值直接比较。

MySQL 实测（`threshold = 5`）：
```
第1次  1  ACTIVE
第2次  2  ACTIVE
第3次  3  ACTIVE
第4次  4  ACTIVE
第5次  5  DISABLED   ← 与常量 WATCHER_DISABLE_AFTER_FAILURES=5、CHANGELOG、mao-cli 文档一致
```
`WHERE id = ? AND status = 'ACTIVE'` 保留：PAUSED 行（`consecutive_failures=4`）执行后 `affectedRows=0`、状态仍 `PAUSED`、计数仍 4，不会被误停用。新增 `signal.repository.spec.ts` 的 5 条断言覆盖了 SQL 文本、`WHERE` 子句、参数顺序 `[backoffMinutes, threshold, id]`、`markChecked` 不再出现 `LEAST(`，断言均成立。

### BUG-L：`canonicalHeaders` 键序归一 ✓

`Object.keys(headers).sort()` 后按小写输出，消除了 `JSON.stringify` 对键序的敏感性。

验证（经真实 `WatcherService.update`）：
- 库内 `{Authorization, X-Token}` + 入参 `{X-Token, Authorization}`（均掩码）→ `hash = abc`（基线保留），落库值正确；
- 部分键给新值（真实修改）→ `hash = null`（正确重置）。
`watcher.service.spec.ts` 新增的同场景用例通过。

---

## 建议（不阻塞）

### BUG-M：桌面端仍无法清空已保存的请求头（第 2 轮 BUG-B 前端侧遗留）

- **文件**：`desktop/src/views/settings/SignalWatchersView.vue:431`（`collectHeaders()` 返回 `undefined`）
- **问题**：服务端已支持显式 `headers: null` / `headers: {}` 清空（第 3 轮已验证），但前端把请求头行全删光时仍返回 `undefined`（表示「未下发」）→ 服务端保留原值。用户依然没有入口撤掉已保存的请求头。附带：未填新值的掩码行被 `continue` 静默跳过，删行时服务端会保留全部原请求头，与「我删了这行」的直觉相反。
- **影响**：接口改免鉴权后只能留着无用的 `Authorization` 头继续发送。
- **修复建议**：编辑态下 `form.headers` 为空数组且原哨兵有请求头时返回 `null`（显式清空）；或把「删除行」与「清空值」在 UI 上分成两个明确动作。
- **是否已用测试验证**：服务端清空能力已在第 3 轮用真实路由验证；前端返回值为代码走查（项目无该视图单测基建）。

---

## 横穿多轮问题的复盘（供后续参考）

| 问题 | 横穿轮次 | 根因 |
| --- | --- | --- |
| BUG-I（第 4 次即停用） | 3 轮 | fake repo 自己实现了 `>= threshold` 才停用，与真实 SQL 的 `+1 >=` 不一致 |
| BUG-G / BUG-N（失败计数） | 3 轮 | fake repo 的 `markChecked` 无条件写 0，与真实 SQL 的 `IF/LEAST` 条件语义不一致 |

两类的共同根因是**仓储 SQL 的条件求值语义没有真实 Db 覆盖**。建议收尾后补一个 Db 集成测试（项目已有 Db 测试基建可用于 signal 仓储），把 `recordFailure` / `markChecked` 的单条 UPDATE 在真实 MySQL 上跑一遍——这是唯一能兜住这类问题的测试层。

## 收尾建议

1. **必修 BUG-N**：改 3 处 `consecutiveFailures: 0` → `watcher.consecutiveFailures ?? 0`。这是纯参数修正，不动 SQL，风险极低。
2. 修完后建议**再跑一轮最小验证**（不必完整审查）：MySQL 实测「失败 1 次 → 成功 → 计数归 0」与「失败 5 次 → DISABLED」两条即可确认收尾。
3. BUG-M 记为已知限制，不阻塞收尾。
4. 建议补 Db 层集成测试（见上表），可放在收尾后的独立改动。

**在 BUG-N 修复前，本轮的明确结论是：存在 1 个阻塞级问题，不可合入。BUG-N 修复后，若无新问题即可合入。**
