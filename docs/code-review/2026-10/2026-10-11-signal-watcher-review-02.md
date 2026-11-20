# 信号哨兵（Signal Watcher）第 2 轮代码审查

- 审查对象：`.worktrees/signal-watcher`（分支 `feat/signal-watcher`，HEAD `4f4c70c2`，无新 commit）未提交改动
- 审查性质：只读审查，未修改任何仓库源码；验证用临时 spec 全部写在 `/tmp/review2/` 并以 `--root` 运行，**跑完已整体删除**，仓库内无临时文件残留
- 审查范围：第 1 轮 7 项修复的正确性与完整性、修复是否引入新问题、第 1 轮未覆盖路径（desktop `SignalWatchersView.vue`、admin 视图与后端筛选参数对齐）、桌面端与管理后台新代码的其他功能逻辑 bug

## 已执行命令与基线

| 命令 | 结果 |
| --- | --- |
| `cd backend-ts && npx vitest run --coverage=false src/signal src/inbox src/common/ssrf.spec.ts` | 12 files / 162 tests 全绿 |
| `cd backend-ts && npx tsc -p tsconfig.build.json --noEmit` | exit 0 |
| `cd desktop && npx vue-tsc --noEmit` | exit 0 |
| `mysqld is alive` / `@@time_zone=CST` | 与 `formatDateTime` 的 Asia/Shanghai 一致 |

> 用户中途补充的前端改动（`collectHeaders()` 返回 `undefined`、`submitForm()` 按条件下发 `body`/`jsonPath`）已纳入本轮复查，并逐字与源码比对确认（见 BUG-A）。

## 总体结论

**不可合并。** 发现 **2 个阻塞级 + 1 个重要级 + 3 个建议级**问题。

其中最关键的是 **BUG-H**：第 1 轮 BUG-3（「任何编辑都重置轮询基线」）**只修了一半**——`watcher.service.ts` 的合并逻辑已改为 `!== undefined` 判定，但 `watcher.routes.ts` 的 `toInput` 仍把「未下发 headers」映射成 `null`，导致**真实 HTTP 入口上基线仍被重置**。仓库内 spec 直接调 `service.update({ name })`、绕过了路由层，所以覆盖不到这条路径，第 1 轮据此判定「已修复」不成立。

---

## 阻塞

### BUG-H：`toInput` 把「未下发 headers」映射成 `null`，PUT 编辑仍重置轮询基线（BUG-3 未修净）

- **文件**：`backend-ts/src/signal/watcher.routes.ts:30`（`let headers: Record<string, string> | null = null;`）
- **问题**：`toInput` 初始化为 `null`，仅当 `headersRaw != null` 才填充。请求体未带 `headers` 键时输出 `headers: null`（而非 `undefined`）。`WatcherService.update` 据此判定：
  - `merged.headers = headers ?? this.decryptHeaders(existing.headersJson)` —— `null` 被 `??` 当作「未下发」，库内原值被保留（值本身没丢）；
  - 但 `resetBaseline` 判定用 `input[field] !== undefined`：`null !== undefined` 成立，与 `existingRaw`（库内有请求头时返回 `{Authorization:...}`）比对不等 → **基线被重置**。
- **触发场景**：任何带请求头的哨兵，用户改个名称/间隔/提示词模板（这是最常规的编辑），`last_value_hash / last_value_snippet / last_changed_at` 三项被清空。
- **影响**：违反技术方案决策 9；用户感知为「我只改了个名字，哨兵却重新建基线」——下一轮轮询会被当成「首轮」只建基线不触发，错过一次本应触发的真实变化；同时已积累的 `lastChangedAt` 历史被抹掉。
- **为何第 1 轮漏掉**：`watcher.service.spec.ts` 的「keeps stored sensitive headers and body when they are not sent」直接调 `h.service.update(7, 1, { name: 'renamed' })`，**没有 `headers` 键**，因此 `input.headers === undefined`，走的是正确分支。spec 未覆盖 `toInput` → `update` 的真实链路。
- **附带证据（spec 自相矛盾）**：`watcher.service.spec.ts:589-592` 用例注释写「headers 无实质变化」，断言却是 `expect(stored.lastValueHash).toBeNull()`（即断言基线被重置）。且该用例的 watcher 未设 `lastValueHash`（默认 `null`），断言恒真，进一步掩盖问题。
- **修复建议**：`toInput` 的 headers 与 body/jsonPath 口径统一，缺省即 `undefined`：
  ```ts
  const headers: Record<string, string> | null | undefined =
    'headers' in body
      ? (body.headers == null ? null : normalizeHeadersObject(body.headers))
      : undefined;
  ```
  同时补一条**经过路由层**的回归 spec（用 Fastify `inject` 或至少调用导出的 `toInput`），断言「PUT 不带 headers 键 + 库内有请求头 → 基线三项保留」。
- **是否已用测试验证**：是。临时 spec 复刻 `toInput` 输出形态喂给真实 `WatcherService.update`，并另用真实 Fastify 路由注册 + `app.inject` 端到端复现（两条独立路径结论一致）。删除前输出：
  ```
  DIAG before: hash = null snippet = null changedAt = null   // update 之后
  after toInput-shaped input: hash = null | snippet = null | changedAt = null
  stored headers = {"Authorization":"Bearer SECRET"}         // 值没丢，但基线被清
  ```
  对照组（直接 `update({name})` 不带 headers 键）三种形态（有/无请求头、`headers: undefined` 键存在）**全部正确保留基线**，可精确归因到路由层映射。

### BUG-A：桌面端编辑 POST 哨兵只改名称仍被服务端拒绝

- **文件**：`desktop/src/views/settings/SignalWatchersView.vue:449`（`const body = form.method === 'POST' ? (form.body === '' ? null : form.body) : undefined`）、`backend-ts/src/signal/watcher.routes.ts:52`、`backend-ts/src/signal/watcher.service.ts:497`（`if (method === 'POST' && body == null)`）
- **问题**：`openEditDialog`（`SignalWatchersView.vue:382-398`）**不回填 `form.body`**（只回填 `bodyLength`，回显字段清单为 `name/agentId/url/method/bodyLength/intervalMinutes/compareMode/jsonPath/promptTemplate/headers`）。于是编辑态 POST 哨兵时 `form.body` 恒为 `''`，`submitForm` 下发 `body: null` → `toInput` 的 `'body' in body` 为 true 且值非字符串 → `body = null` → `update` 的 `input.body !== undefined` 成立 → `merged.body = null` → `normalizeInput` 抛「POST 方法必须填写请求体」。
- **触发场景**：编辑任意 POST 哨兵，只想改名称/间隔/提示词/URL，不重新粘贴请求体。
- **影响**：POST 哨兵**除重新粘贴完整请求体外无法编辑任何字段**；而输入框 placeholder 明确写着「留空不修改（当前已保存 N 字符）」（`SignalWatchersView.vue:103`），UI 承诺与服务端行为直接矛盾。用户补充的前端修正只把 `headers` 改成了按条件下发，`body` 这条支路漏掉了。
- **修复建议**：编辑态 POST 且输入为空时不下发 `body` 键：
  ```ts
  const body = form.method === 'POST' && (editing ? form.body !== '' : true)
    ? form.body
    : form.method === 'POST' ? form.body : undefined;
  ```
  更清晰的写法是显式区分新建/编辑：
  ```ts
  const body = form.method !== 'POST' ? undefined
    : (!editing || form.body !== '') ? form.body : undefined;
  ```
  新建态 `form.body === ''` 仍会下发 `body: ''`，由服务端必填校验拦住（已回归验证）。
- **是否已用测试验证**：是。用真实 `registerSignalWatcherRoutes` + Fastify `app.inject` 构造「前端 payload → 路由 → 服务端」完整链路：
  ```
  PUT status = 500 | body = {"statusCode":500,"code":"2001","error":"Internal Server Error","message":"POST 方法必须填写请求体"}
  ```
  修复方向验证（payload 不含 `body` 键）→ `status 200`、`body preserved = {"q":"x"}`、`hash = abc`（基线不重置）。

---

## 重要

### BUG-B：请求头无法清空，且 `body` / `headers` 的 `null` 语义自相矛盾

- **文件**：`backend-ts/src/signal/watcher.service.ts:154`（`headers: headers ?? this.decryptHeaders(existing.headersJson)`）
- **问题**：
  1. 显式 `headers: null` 想清空 → `null` 被 `??` 当「未下发」，库内原值保留；
  2. 前端 `collectHeaders()`（`SignalWatchersView.vue:423-429`）把所有请求头行删光时返回 `undefined`（不下发），同样清空不了；
  3. 而 `body` 走 `input.body !== undefined` 判定，`body: null` = 显式清空。**同一份 `toInput` 里 `body: null` 与 `headers: null` 语义相反。**
- **触发场景**：用户想撤掉一个已保存的 `Authorization` 头（例如接口改成免鉴权）。
- **影响**：用户没有任何入口清空请求头；API 直调 `headers: {}` 才能清空，但前端永远发不出 `{}`。隐晦且不可自助恢复。
- **修复建议**：headers 改用与 body 一致的 `!== undefined` 判定：
  ```ts
  headers: input.headers !== undefined ? headers : this.decryptHeaders(existing.headersJson),
  ```
  注意 `restoreMaskedHeaders(null, ...)` 已对 `null` 直接放行，此处无需额外处理。前端侧把 `collectHeaders()` 全删光时的返回值从 `undefined` 改为 `null`（`SignalWatcherInput.headers` 类型本就是 `Record<string,string> | null`），并同步 BUG-H 修复后 `toInput` 的口径，让「未下发」稳定等于 `undefined`。
- **是否已用测试验证**：是。经真实路由 `app.inject`：
  ```
  after headers:null → stored = {"Authorization":"Bearer SECRET"}   // 期望 null
  after headers:{}  → stored = null                                 // 这条路通
  HASH watcher body:null → status 200 | stored = null               // body 可清空
  ```

---

## 建议

### BUG-E：编辑态 POST→GET 切换后，请求体残留且不可见（探针仍会发送）

- **文件**：`backend-ts/src/signal/watcher.service.ts:154`（`merged.body` 用库内原值）+ `SignalWatchersView.vue:98`（body 输入框 `v-if="form.method === 'POST'"`）
- **问题**：方法从 POST 改成 GET 时，前端 body 输入框被隐藏、不下发 `body`，`merged.body` 取库内原值；`normalizeInput` 的 `const body = input.body == null || input.body === '' ? null : input.body` **不会对非 POST 方法强制清空**。
- **触发场景**：把 POST 哨兵改成 GET。
- **影响**：GET 哨兵仍带着一段用户看不见的请求体，`runCheck` 每次轮询照发（`probe.execute({ ..., body })`），既可能污染目标接口，也让界面上的「无请求体」与实际情况不符。
- **验证输出**：`view.hasBody = true | bodyLength = 9 | method = GET`，`stored body plaintext = {"q":"x"}`。
- **修复建议**：`normalizeInput` 中对 `method !== 'POST'` 强制 `body = null`（更彻底，覆盖所有调用方），或前端切到 GET 时下发 `body: null`。
- **是否已用测试验证**：是。

### BUG-F：`restoreMaskedHeaders` 键名大小写敏感，HTTP 头大小写不敏感 → 掩码可能被当真实凭据落库

- **文件**：`backend-ts/src/signal/watcher.service.ts:558`（`result[key] = value === SECRET_MASK && isSensitiveProbeHeader(key) ? (stored[key] ?? value) : value;`）
- **问题**：`isSensitiveProbeHeader` 内部用 `toLowerCase()` 判定（`probe-validate.ts:79-82`，大小写不敏感），但 `stored[key]` 是 JS 对象键精确匹配。库内键 `authorization`、入参键 `Authorization`（值均为掩码）时替换不到。
- **触发场景**：非前端来源的调用（mao-agent / OpenAPI / 手工 curl）按大写头名回传掩码值，而库内存的是小写键。
- **影响**：掩码 `******` 被当真实凭据落库，之后每次轮询真的发出 `Authorization: ******`（正是 BUG-4 想避免的问题，只是多了一个大小写缺口）。
- **验证输出**：`stored = {"Authorization":"******"}`（同大小写时正确还原为 `{"Authorization":"Bearer SECRET"}`）。
- **修复建议**：匹配时大小写归一，例如先建 `const lowered = new Map(Object.entries(stored).map(([k, v]) => [k.toLowerCase(), v]))`，再用 `lowered.get(key.toLowerCase())`；或在 `normalizeInput`/`assertProbeHeaders` 阶段统一键名大小写。
- **是否已用测试验证**：是。

### BUG-G：`markChecked` 仍无条件覆盖并发累加的 `consecutive_failures`（第 1 轮 SUG-1 未修）

- **文件**：`backend-ts/src/signal/signal.repository.ts:133-152`（`markChecked` 固定写 `patch.consecutiveFailures`）+ `backend-ts/src/signal/watcher.service.ts:349-364`
- **问题**：探针在途 10~15s 期间，并发调度可能已 `recordFailure` 把 `consecutive_failures` 累加到 4；探针返回成功后 `markChecked` 无条件写 0，把在途期间的失败计数打回 0，离「连续失败 5 次自动停用」的判定被反复推迟。
- **影响**：长时间不稳定的接口可能永远达不到停用阈值，持续产生无用的 Agent 触发。
- **修复建议**：`markChecked` 改为 `consecutive_failures = 0` 的 SQL 语义上可接受，但需与 `recordFailure` 的写入做互斥或改用「仅在本次轮询未失败时清零」的条件更新，例如 `SET consecutive_failures = IF(consecutive_failures < ?, 0, consecutive_failures)` 或按 `last_checked_at` 单调性守卫。
- **是否已用测试验证**：是（用真实 repo 方法签名复现 `in-flight failures = 4` → `after markChecked = 0`，`markChecked payload` 恒为 `consecutiveFailures: 0`）。

---

## 已验证无问题（避免空泛结论）

1. **BUG-1 修复有效**：`inbox.service.ts` 的 `isKindEnabled` 补 `case 'WATCHER_DISABLED': return true`，inbox spec 回归通过；自动停用通知可写进收件箱。
2. **BUG-2/3 修复对 GET 哨兵与 headers 场景有效**：直接调 `service.update({ name })` 时，headers/body/jsonPath 全保留、基线三项不重置（3 种入参形态均验证）。
3. **BUG-4 修复有效**：掩码替换为库内原值；非敏感键的掩码值原样保留；库内无该键时保留掩码不抛错；`headers: {}` 可清空。
4. **BUG-5 修复有效**：admin `buildParams` 本就下发 `compareMode`，后端 `compareModeRaw`/`compareMode` 读取 + `isSignalCompareMode` 校验 + SQL `compare_mode = ?` 拼接齐全，非法值被忽略；`signal-admin.routes.spec.ts` 3 条通过。前端筛选选项 `['HASH','JSON_FIELD','STATUS_CODE']` 与后端口径一致。
5. **BUG-6 修复有效**：`safeSize = Math.max(1, Math.min(200, size))`，`LIMIT`/`OFFSET` 统一用 `safeSize`，深页不再跳数据；`size=0` → `LIMIT 1 OFFSET 0`。
6. **BUG-7 修复有效**：`findById` 复读在「判定值变化」路径发生（入口 1 次 + 复读 1 次），未变化/首轮建基线路径无额外查询；复读发现 `null`（行已删）或非 `ACTIVE`（含 `DISABLED`）均不触发。用「每次 `findById` 返回新对象」的真实 repo 语义重验：复读只校验 `status`，`agentId`/`promptTemplate` 仍用入口快照（`agentId sent = 3`，消息未用新模板），复读与 `openRun` 之间仍存在极窄竞态窗口（`openRun called: 1`）——窗口窄、可接受，不单列问题。
7. **SUG-2/SUG-3 修复有效**：`rawKey.trim() === ''` 的空白键名被拒；`resetBaseline` 分支 `lastValueHash / lastValueSnippet / lastChangedAt` 三项全清。
8. **新建态服务端校验仍正确**（用户补充改动重点关注项）：经真实路由 `POST`，缺 `body` → 「POST 方法必须填写请求体」；缺 `jsonPath`（JSON_FIELD）→ 「JSON_FIELD 模式必须填写提取路径」；前端新建态 `jsonPath: ''` 空串同样被正确拦截。GET/HASH 新建态不下发 `jsonPath` → 服务端存 `null`，正确。
9. **编辑态切换到非 JSON_FIELD 模式**：前端不下发 `jsonPath`，`normalizeInput` 对非 JSON_FIELD 强制 `jsonPath = null`，库内旧值被清空——与用户说明一致，符合预期。
10. **类型检查**：后端 `tsc --noEmit`、前端 `vue-tsc --noEmit` 均 exit 0；`SignalWatcherInput.headers/body` 允许 `null`，`Partial<SignalWatcherInput>` 允许 `undefined`，前端按条件下发在类型层面成立。
11. **SSRF 防护**（`common/ssrf.ts`，第 1 轮未覆盖）：从 `weixin/qr-login.service.ts` 抽出为单一来源并复用，覆盖 RFC1918/环回/链路本地/0.x/255.x/组播保留段、`localhost`/`.localhost`/`.local`/`.internal`/IPv6 字面量，`assertProbeUrl` 调用点正确；spec 12 条通过。
12. **文档与 CHANGELOG**：`CHANGELOG.md` 0.0.276 已按「后端/前端/管理后台」分节写入；`DEPLOY.md`、`README.md`、`skills/mao-cli/`（SKILL + reference/config/desktop/inbox + 新增 signal-watcher.md）均已同步，符合 AGENTS.md 的同任务更新要求。

## 复现方式（供后续 worker 复核）

探针 spec 已随 `/tmp/review2/` 一并删除。复核时按以下要点重建即可（import 用仓库内文件相对路径）：

- **BUG-H / BUG-B**：注册真实 `registerSignalWatcherRoutes(app, { service })` 到 Fastify 实例，`onRequest` 钩子注入 `req.userId = 7`，用 `app.inject({ method: 'PUT', url: '/v1/signal-watchers/1', payload })`：
  - `payload = { name, agentId, url, method:'GET', intervalMinutes, compareMode:'HASH', promptTemplate }`（**不含** `headers`/`body` 键），库内 `headersJson` 有请求头且 `lastValueHash='abc'` → 期望 `lastValueHash` 仍为 `'abc'`，实际为 `null`。
  - `payload = { headers: null }` → 期望 `headersJson` 为 `null`，实际保留原值。
- **BUG-A**：`payload = { ..., method:'POST', body: null }` → 500「POST 方法必须填写请求体」；去掉 `body` 键 → 200 且 body 保留。
- **BUG-E**：库内 `method:'POST'` + 有 body，`payload` 改为 `method:'GET'` 且不含 `body` → 视图 `hasBody=true`。
- **BUG-F**：库内 `headersJson` 加密 `{"authorization":"Bearer SECRET"}`，`update(7,1,{ headers: { Authorization: '******' } })` → 落库含 `"Authorization":"******"`。
- **BUG-G**：`markChecked(id, { ..., consecutiveFailures: 0 })` 覆盖在途累加值。
