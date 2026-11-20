# 信号哨兵（Signal Watcher）第 3 轮代码审查

- 审查对象：`.worktrees/signal-watcher`（分支 `feat/signal-watcher`）未提交改动
- 审查性质：只读审查，未修改任何仓库源码；验证用临时 spec 写在仓库内 `backend-ts/src/signal/` 并以 `--root` 无关方式运行，**跑完已全部删除**；MySQL 实证用临时库 `tmp_review3`，**已 DROP**
- 审查重点：本轮 6 项修复的正确性与边界、新路由层 spec 是否名副其实、是否仍有遗漏

> **重要说明（审查期间代码变更）**：审查过程中 `backend-ts/src/signal/watcher.service.ts` 与 `watcher.service.spec.ts` 在 20:44 被再次修改（用户同步追加了两处修复：`normalizeInput` 改为「先归一化 method 再判 POST」、`effective` 改为「仅在下发 headers 时才覆盖」并新增 `canonicalHeaders`）。本报告全部结论均基于 **20:44 之后的最终代码**重跑验证得出；对中途版本的旧结论已作废重验。

## 已执行命令与基线（最终代码）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --coverage=false src/signal src/inbox` | 12 files / **170 tests 全绿** |
| `npx vitest run --coverage=false`（全量） | 282 files / **3476 tests passed**, 14 skipped |
| `npx tsc -p tsconfig.build.json --noEmit` | exit 0 |
| MySQL 8（`LEAST` / `IF` 语义实测） | 见 BUG-G / BUG-I |

## 总体结论

**可以合入，但建议先修 1 个重要级问题（BUG-I）。** 本轮 6 项修复全部正确落地，第 2 轮的阻塞项已全部消除。仍发现 **1 个重要 + 3 个建议**问题，均不阻塞合并；其中 BUG-I 与 CHANGELOG 承诺不符，建议随本轮一并修掉再收尾。

| 编号 | 级别 | 状态 |
| --- | --- | --- |
| BUG-I | 重要 | 新发现，第 1/2/3 轮均遗漏 |
| BUG-G | 建议（不阻塞） | 本轮修复**无效**（`LEAST` 语义误用），需重做 |
| BUG-L | 建议（不阻塞） | 新发现，多请求头键序不一致时误重置基线 |
| BUG-M | 建议（不阻塞） | 前端仍无法清空请求头（第 2 轮 BUG-B 前端侧遗留） |

---

## 重要

### BUG-I：`recordFailure` 第 4 次失败即停用，与「连续失败 5 次」的承诺不符

- **文件**：`backend-ts/src/signal/signal.repository.ts:171-186`（`recordFailure` 的 SQL）
- **问题**：SQL 为
  ```sql
  SET consecutive_failures = consecutive_failures + 1,
      status = IF(consecutive_failures + 1 >= ?, 'DISABLED', status)
  ```
  MySQL 的 `SET` 子句从左到右求值，第二个赋值引用的 `consecutive_failures` 已是「+1 之后」的值，因此 `IF(consecutive_failures + 1 >= 5)` 实际判断的是「+2 之后 >= 5」，即第 **4** 次失败就置 `DISABLED`。而 `WATCHER_DISABLE_AFTER_FAILURES = 5`（`watcher.service.ts:20`）、CHANGELOG 0.0.276 与 `skills/mao-cli/reference/signal-watcher.md` 均写「连续失败 5 次自动停用」。
- **触发场景**：任何哨兵连续失败，第 4 次即被停用并收到站内信。
- **影响**：与文档/CHANGELOG 承诺不一致；停用过早一轮，用户少一次自愈机会。第 5 次时 `WHERE status = 'ACTIVE'` 已不匹配，`consecutive_failures` 停在 4。
- **MySQL 实证**（`threshold = 5`）：
  ```
  第1次  1  ACTIVE
  第2次  2  ACTIVE
  第3次  3  ACTIVE
  第4次  4  DISABLED   ← 期望此处仍为 ACTIVE
  ```
- **修复建议**：把阈值判断改成不依赖同语句内已更新列的写法，二选一：
  ```sql
  -- 方案 A：阈值参数改为「停用前允许的失败数」
  status = IF(consecutive_failures >= ?, 'DISABLED', status)   -- 调用方传 WATCHER_DISABLE_AFTER_FAILURES - 1
  -- 方案 B（推荐，语义不变）：用 GREATEST/条件表达避免引用已更新列
  status = IF(consecutive_failures + 1 >= ?, 'DISABLED', status)  -- 需先把 +1 拆到独立子查询/变量
  ```
  更稳妥的是方案 A 的等价写法：`status = IF(consecutive_failures >= ?, 'DISABLED', status)` 并保持 `WATCHER_DISABLE_AFTER_FAILURES = 5` 时传 `4`；或在 service 层算好「本次失败后是否达到阈值」再传入布尔参数。同时补一条真实 SQL 集成测试（可用现有 Db 测试基建，见 BUG-G 的说明）。
- **是否已用测试验证**：是，MySQL 实测复现；现有 spec 的 fake repo 自己实现了 `consecutiveFailures >= WATCHER_DISABLE_AFTER_FAILURES ? 'DISABLED'`（`watcher.service.spec.ts:107`），**与真实 SQL 行为不一致**，所以单测全绿也发现不了。

---

## 建议（均不阻塞）

### BUG-G：`markChecked` 的 `LEAST(?, consecutive_failures)` 修复无效

- **文件**：`backend-ts/src/signal/signal.repository.ts:150-166`
- **问题**：本轮把 `consecutive_failures = ?` 改成 `consecutive_failures = LEAST(?, consecutive_failures)`，注释称「取小后写 0……保留库里较大的那个」。但 `LEAST` 取的是**最小值**，而 `markChecked` 传入的 `patch.consecutiveFailures` 恒为 `0`（`watcher.service.ts:357/367/417` 三处调用均传 0），于是 `LEAST(0, x) ≡ 0`——**与修复前无条件写 0 行为完全等价，没有解决任何问题**。
- **触发场景**：探针在途期间库里已被并发 `recordFailure` 累加到 N，探针成功后 `markChecked` 传 0，N 被打回 0，「连续失败 5 次自动停用」被反复推迟。
- **影响**：长时间不稳定的接口可能永远达不到停用阈值，持续产生无用触发。
- **MySQL 实证**：库里 `consecutive_failures = 3`，执行 `UPDATE ... SET consecutive_failures = LEAST(0, consecutive_failures)` → 结果 `0`。
- **实际触发条件说明**：`WatcherScheduler` 的单飞是**进程内 Set**（`watcher-scheduler.ts:31`），单实例下同一哨兵不会并发；该窗口需要**多实例部署**（水平扩展）才真实存在。因此定为建议级、不阻塞。
- **修复建议**：需要「仅当本次没失败时才清零」的条件语义，`LEAST` 方向反了。可用项目里已有的 `GREATEST` 惯用法（参考 `feishu/message.repository.ts:242` 的「只进不清」）：
  ```sql
  -- 在途累加值更大时保留它，否则清零
  consecutive_failures = GREATEST(0, consecutive_failures - 0)  -- 仍不等价，见下
  ```
  更直接的做法是给 `markChecked` 增加「本次失败次数」入参，用条件更新表达「取两者较大」：
  ```sql
  consecutive_failures = GREATEST(?, consecutive_failures)   -- 传入本次读到的 0 时等于保留库里值
  ```
  但注意 `GREATEST(0, x) = x` 会让**正常成功路径也永远无法清零**，所以正确做法是让调用方传入「本次轮询是否失败」并由 SQL 分支处理，或引入单调的 `last_checked_at` 守卫。
- **是否需要补单测**：是，但需要能执行真实 SQL 的 Db 测试基建。当前 fake repo 的 `markChecked` 是 `Object.assign`，无法验证 SQL 语义。建议至少补一条「用真实 MySQL（或项目内现有 Db 集成测试模式）验证 `recordFailure` 第 5 次才停用 + `markChecked` 与 `recordFailure` 交错后计数保留」的集成测试——这也正是 BUG-I 一直没被发现的原因。
- **是否已用测试验证**：是，MySQL 实测；并已确认 `LEAST(0, x) ≡ 0` 的数学语义。

### BUG-L：多请求头且入参键序与库内不一致时，掩码回传仍误重置基线

- **文件**：`backend-ts/src/signal/watcher.service.ts:641-649`（`canonicalHeaders` 只做键名小写归一、**不排序**）+ `:171-173`（`JSON.stringify` 比对）
- **问题**：`JSON.stringify` 对对象键序敏感。库内请求头为 `{Authorization, X-Token}`，入参为 `{X-Token, Authorization}`（均掩码值）时，`restoreMaskedHeaders` 按入参键序还原 → `canonicalHeaders` 得 `{x-token, authorization}`，而 `existingRaw` 得 `{authorization, x-token}`，stringify 不等 → 误判「判定字段变化」→ 基线被重置。
- **触发场景**：非前端来源调用（mao-agent / OpenAPI / 手工 curl）按不同键序回传掩码值。桌面端 `collectHeaders()` 的键序来自服务端回显，顺序一致，**前端不受影响**。
- **验证输出**：`R3-2c: hash = null | headers = {"X-Token":"tok","Authorization":"Bearer S"}`（落库值正确，基线被误清）。
- **修复建议**：`canonicalHeaders` 里对键排序后再输出，使比对与键序无关：
  ```ts
  for (const key of Object.keys(headers).sort()) result[key.toLowerCase()] = headers[key];
  ```
- **是否已用测试验证**：是。

### BUG-M：桌面端仍无法清空已保存的请求头（第 2 轮 BUG-B 前端侧遗留）

- **文件**：`desktop/src/views/settings/SignalWatchersView.vue:431`（`collectHeaders()` 返回 `undefined`）
- **问题**：服务端已支持显式 `headers: null` / `headers: {}` 清空（本轮 BUG-B 已修并经路由验证），但前端把请求头行全删光时 `collectHeaders()` 返回 `undefined`（表示「未下发」），服务端据此保留原值 → **用户依然没有任何入口撤掉已保存的请求头**。
- **触发场景**：接口改成免鉴权，用户想删掉 `Authorization` 头。
- **附带语义问题**：`collectHeaders()` 中 `if (pair.masked && pair.value.trim() === '') continue` 会**静默跳过**未填新值的掩码行。用户删掉其他行、只留一个未填的掩码行时，返回 `undefined` → 服务端保留**全部**原请求头（含用户已删的那些），与「我删了这行」的直觉相反。
- **修复建议**：编辑态下区分「一行都没删/没改」与「用户删空了」：当 `form.headers` 为空数组且原哨兵有请求头时返回 `null`（显式清空）；掩码行未填新值时维持 `undefined` 语义但需与「删除」区分（可在 UI 上把「删除」与「清空值」分成两个明确动作，或删除掩码行时记录一个 `removed` 标记）。
- **是否已用测试验证**：部分。服务端清空能力已用真实路由验证（`headers: null` / `{}` 均可清空）；前端返回值路径为代码走查，未跑 Vue 单测（项目无该视图的单测基建）。

---

## 已验证无问题（本轮 6 项修复逐项结论）

全部基于 **20:44 最终代码**重跑，均通过：

1. **BUG-H（阻塞→已修）**：`toInput` 改为 `'headers' in body` 键存在性判定，未带键 = `undefined`、带键为 `null` = 显式清空、带对象 = 解析。经真实 Fastify 路由验证：
   - 库内**无**请求头 + 只改名称 → `status=200, hash=abc`（基线三项全保留）；
   - 库内**有**请求头 + 只改名称 → `hash=abc`，请求头原样保留。
   第 2 轮指出的「spec 直接调 service、绕不过路由层」缺口已由 `watcher.routes.spec.ts`（真实 Fastify + `app.inject`）补上，该 spec 声称的链路真实存在（我用同手法独立复现，结论一致）。
2. **BUG-A（阻塞→已修）**：`submitForm` 改为 `form.method !== 'POST' ? undefined : (!editing || form.body !== '') ? form.body : undefined`。复刻前端逻辑验证：编辑态 POST 留空 → `undefined`（不下发）、编辑态 POST 有值 → 下发、新建态 POST 留空 → 下发 `''`（由服务端拦住）、编辑态 GET → `undefined`。经路由验证 POST 只改名称 → `200` 且 body 原样保留；新建态 POST 缺 body 仍被「POST 方法必须填写请求体」拦住；编辑态主动下发 `body: ''` 仍被拒（符合预期）。
3. **BUG-B（重要→已修）**：`update` 改为 `input.headers !== undefined ? restoreMaskedHeaders(...) : storedHeaders`，与 body 口径一致。经路由验证：显式 `headers: null` → `headersJson = null`（清空）；显式 `headers: {}` + 库内有请求头 → 清空且重置基线（真实变更，正确）；显式 `headers: {}` + 库内无请求头 → **不**重置（无实质变化，正确）。
4. **BUG-E（建议→已修）**：`normalizeInput` 改为先归一化 method 再判 POST（`const isPost = method === 'POST'`），规避了中间版本「用未归一化 `input.method` 判定」的缺陷。验证：POST 改 GET → 残留 body 被清空（`body = null`）；小写 `post` + 有 body → `200`、`method=POST`、`hasBody=true`（正常保留）；`" POST "` 带空格 + 有 body → `200`；GET 但下发 body → 被清空（`hasBody=false`）。
5. **BUG-F（建议→已修）**：`restoreMaskedHeaders` 先用 `lowered` Map 做键名小写归一再匹配。验证：库内 `authorization` + 入参 `Authorization`（均掩码）→ 落库 `{Authorization: "Bearer SECRET"}` 且**基线保留**（`hash=abc`）；同大小写场景同样保留基线。**注意**：本轮修复同时解决了「掩码回传误重置基线」这一第 2 轮未触及的问题（通过 `effective` 只在下发 headers 时才覆盖 + 双侧 `canonicalHeaders`）。残余缺陷仅为 BUG-L 的键序问题。
6. **BUG-G（建议→修复无效）**：见上，`LEAST` 语义误用，需重做。

### 其他确认无问题的点

- **新 spec `watcher.routes.spec.ts` 本身正确**：`makeHarness` 的 fake repo 覆盖了 `update`/`findById`/`findOwned`/`countByUser` 等全部被用到的接口，`onRequest` 钩子注入 `req.userId = 7` 与 `requireJwtIdentity` 的真实读取路径一致；8 条用例的断言与真实行为相符（我独立复现了其中 5 条场景，结论一致）。该 spec 使用的 `probe: { execute: executeProbe }` 在编辑链路上不会被触发，无副作用。
- **`toInput` 其他边界**：`headers` 值为非字符串 → `String(value ?? '')` 归一（`{X-N: 123}` → `{"X-N":"123"}`）；`body` 值为非字符串 → `null`（显式清空口径）；`headers` 为数组或字符串 → 抛「headers 必须为对象」。
- **admin 视图与后端参数对齐**：`SignalWatcherListView.vue` 的 `buildParams` 下发 `status` / `compareMode` / `userId` / `page` / `size`，后端 `signal-admin.routes.ts` 三个筛选参数均读取 + 白名单校验 + SQL 拼接，`compareModeOptions = ['HASH','JSON_FIELD','STATUS_CODE']` 与后端一致；`page-sizes=[20,50,100]` 在后端 `Math.min(100, size)` 与 repo `safeSize` 钳制范围内。
- **测试与类型**：全量 282 files / 3476 tests 通过，`tsc --noEmit` exit 0。
- **文档**：CHANGELOG 0.0.276、README、DEPLOY、`skills/mao-cli/` 均已同步（注意 BUG-I 修好后需确认 CHANGELOG 文案「连续失败 5 次自动停用」与实现一致——修好后即一致，无需改文案）。

## 收尾建议

- **建议本轮一并修掉 BUG-I**（改一行 SQL + 补一条真实 SQL 集成测试），因为它与 CHANGELOG/mao-cli 文档的公开承诺直接冲突，且第 1/2/3 轮都因 fake repo 与真实 SQL 行为不一致而漏掉。
- BUG-G 可安排在收尾后的独立小改动：它需要先补 Db 集成测试基建才能安全修，且当前单实例部署下窗口极小。
- BUG-L / BUG-M 可记为已知限制，不影响收尾。
