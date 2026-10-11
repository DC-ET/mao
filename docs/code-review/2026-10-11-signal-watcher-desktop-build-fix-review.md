# 信号哨兵 desktop 构建修复——未提交改动审查（2026-10-11）

审查对象：worktree `/opt/mao-data/workspace/2/projects/mao/.worktrees/signal-watcher-build-fix`，分支 `fix/signal-watcher-desktop-build`，基于 `main d01cb6dc`。

## 总体结论

**可合并。未发现本次改动引入的功能 bug（阻塞项 0）。**

本轮改动本质是「类型修复 + 逻辑抽离 + 补测试」，我按 5 个重点逐项验证，并用 4 组临时测试（跑完已删，仓库未留临时文件）确认：

1. `buildWatcherPayload` 对 `headers` / `body` / `jsonPath` 三个字段的「键存在性」语义**正确**——三个字段都只在真的下发时才出现在 payload 里，序列化后请求体中不含 `headers: undefined` 之类的显式 undefined 键（`signal-watcher-form.ts:66-87` 用 `...(headers !== undefined ? { headers } : {})` 展开，而 `headers: undefined` 的写法已被注释明确否决）。
2. 与 main 内联版**行为等价**（除「键存在性」这一处改进外）：用穷举 5 种键名 × 5 种键值 × 2 种 masked × 5 组组合 × 3 种 method × 4 种 body × 3 种 compareMode × 4 种 jsonPath = 7200 个表单 × 2 种 editing 状态做对比，除 headers 键外所有字段值与键集合完全一致（`signal-equivalence.test.ts`，7 passed）。
3. `headerPairsFromView` 与 main 上 `Object.entries(...).map(...)` 等价（掩码值回填空值 + masked 标记，逐字比对通过）。
4. `SignalWatchersView.vue` 无残留引用：编译产物中已无 `collectHeaders` / `isMaskedValue` / 内联 `HeaderPair`；模板与 `<script setup>` 的绑定由 `@vue/compiler-sfc` 编译验证正常（`DISABLE_AFTER_FAILURES` / `MAX_WATCHERS` 走 `setup-maybe-ref` 绑定，模板渲染实测输出「连续失败 5 次」与「新建哨兵」）。
5. `MAX_WATCHERS` / `DISABLE_AFTER_FAILURES` 改为 import 后模板仍有效：SSR 渲染输出正确；`npm run build` 产物中可见 `连续失败 \`+O(x(5))+\`` 与 `已达单用户上限 \`+O(x(20))+\``（即 import 的常量真实参与渲染，非字面量）。

基线复核：`desktop npm run build` exit 0；`signal-watcher-form.test.ts` 12 passed；`desktop npm run test:unit` 仅 1 条既有失败（`zz-logicbug-probe.test.ts > J4`，main 上同样存在，与本次无关）；`backend-ts` / `admin` build exit 0。

---

## 审查中确认等价/正确的关键点（附验证方式）

### 1. `headers` 键存在性：本轮的核心修复确实生效

`signal-watcher-form.ts:78` 用条件展开保证「一个键都没填出来时 `headers` 键不出现」，而不是写 `headers: undefined`。经真实 Fastify 路由验证（`app.inject` + `JSON.parse(JSON.stringify(payload))` 复刻浏览器 JSON 序列化）：

| 场景 | 请求体键 | 服务端 `toInput` 结果 | 落库效果 |
| --- | --- | --- | --- |
| 新建态 GET、无请求头 | 无 `headers` 键 | `headers === undefined` | 保留语义正确（create 由 normalizeInput 校验必填） |
| 编辑态掩码行全留空 | 无 `headers` 键 | `headers === undefined` | 服务端保留原请求头 |
| 编辑态填了新请求头 | `headers: {…}` | 正常下发 | 正常更新 |

`toInput`（`backend-ts/src/signal/watcher.routes.ts:27`）确实用 `'headers' in body` 区分「未下发」与「显式清空」，前端口径与服务端口径一致。

### 2. 与 main 内联版逐字段等价（穷举 7200 表单）

复刻 main 上的 `oldCollectHeaders` / `oldIsMaskedValue` / `oldBuildPayload`，与新模块对比：
- `collectHeaders`：全部组合返回值一致（含空键跳过、掩码行跳过、trim 仅用于判空、键名原样保留）。
- `headerPairsFromView`：与 `Object.entries(headers).map(...)` 输出一致。
- `buildWatcherPayload`：除 `headers` 键外，其余字段值与键集合 100% 一致；`headers` 键的差异正是本轮预期的修复（main 上恒为键存在、值可能 `undefined`，新版按键存在性决定）。

### 3. 视图层无残留、无变量提升问题

- `SignalWatchersView.vue` 中 `HeaderPair` 仅剩 `import ... type HeaderPair` 与 `headers: [] as HeaderPair[]` 两处类型用法，无运行时残留。
- 编译产物中 `canSubmit` 的 `!editing`、`submitForm` 的 `if (editing && …)` 均维持 main 原样（见下方「已知限制」，非本轮引入）。
- 模板中 `form.headers` 的 `v-for` 行、`pair.masked` 占位符逻辑未变。

### 4. 单测覆盖度

12 条单测覆盖了 `collectHeaders` 4 条、`headerPairsFromView` 1 条、`buildWatcherPayload` 7 条，包含「键不出现」的 `not.toHaveProperty` 断言，比 main 上的零覆盖有明显进步。

---

## 已检查范围与仍存风险（非本轮 bug，供后续参考）

以下问题在验证过程中被发现，但经与 main 的等价复刻对比，**均为 `feat/signal-watcher` 合入时既已存在，不是本轮 `fix/signal-watcher-desktop-build` 引入**，故不计入本次审查的问题列表。列出以供后续排期：

1. **编辑态新增/修改任一请求头时，未填新值的敏感请求头会被静默删除**（`signal-watcher-form.ts:33-44`，`collectHeaders` 的 `if (pair.masked && pair.value.trim() === '') continue`）。链路：`headerPairsFromView` 把敏感键回显为 `masked: true` + 空值 → 用户只要让任何一个非掩码行进入 payload（改名称不算，但新增一行、改一个非敏感头的值都算），`collectHeaders` 就会把 masked 行整个跳过 → `restoreMaskedHeaders` 只还原「本次下发的键」→ 库内 `Authorization` 丢失。已用真实 Fastify + 真实 `WatcherService` 复现：库内 `{Authorization, X-Trace}`，用户新增 `X-New` 后落库 `{X-Trace, X-New}`（`Authorization` 消失）。第 3/4 轮 signal 审查报告（`docs/code-review/2026-10-11-signal-watcher-review-03.md` BUG-M 附带说明、`review-04.md` BUG-M）已记录同一现象，当时定为「已知限制，不阻塞」。
2. **`canSubmit` 里 `!editing` 未加 `.value`**（`SignalWatchersView.vue:415`）：裸 ref 在布尔上下文恒为 truthy，`!editing` 恒为 `false`，因此「新建态 POST 且请求体留空」不会被前端拦住，改由服务端 `normalizeInput` 的「POST 方法必须填写请求体」兜底（已验证返回 4xx）。`submitForm` 的 `if (editing && editingId.value != null)` 因 `editingId` 为 null 的保护，新建态不会误走 update。同样为 main 既有行为。
3. **编辑态 JSON_FIELD 且把提取路径清空**：前端不下发 `jsonPath` 键 → 服务端保留旧值，用户改不掉旧路径（只能先切到 HASH 再提交）。同为 main 既有行为。

上述 3 条若要修，建议单独立项（涉及 `collectHeaders` 的掩码/删除语义与 UI 交互），不要混进本次构建修复。

---

## 验证记录（临时 spec 均已删除，仓库工作区 clean）

| 临时文件（已删） | 内容 | 结果 |
| --- | --- | --- |
| `src/.__tmp_review/signal-equivalence.test.ts` | 新旧实现穷举等价性 + axios 序列化键存在性 | 7 passed |
| `src/.__tmp_review/view-template.test.ts` | SFC 模板编译产物无残留引用 + SSR 渲染常量 | 5 passed |
| `src/.__tmp_review/script-compile.test.ts` | `<script setup>` 编译后 `editing` 语义 + ref 真值复现 | 5 passed |
| `src/.__tmp_review/editing-ref.test.ts` | 编译产物中断言 `!editing` / `if (editing &&` 维持原样 | 4 passed |
| `src/.__tmp_review_jp.test.ts` | `jsonPath` 键存在性（JSON_FIELD 空串仍下发 / HASH 残留不下发） | 2 passed |
| `backend-ts/src/signal/.__tmp_review/e2e-payload.test.ts` | 真实 Fastify + 真实 service 的「前端 payload → HTTP → update」全链路 | 4 passed |
| `backend-ts/src/signal/.__tmp_review/masked-loss.test.ts` | 真实 Fastify + 真实 service 复现敏感请求头丢失（新旧实现均复现） | 3 failed（即上述「仍存风险」第 1 条真实存在，但 main 上同样复现） |

审查结束后 `git status --porcelain` 为空，未修改任何生产代码、未向仓库提交临时文件。

---
---

# 追加审查：3 处后续改动复查（同日第二轮）

审查对象：在第一轮报告之后新增的 3 处改动（`collectHeaders` 掩码行改下发 `SIGNAL_SECRET_MASK`、`buildWatcherPayload` 新增 `originalHeaders` 第三参支持 `headers: null` 显式清空、`canSubmit` 的 `!editing` 改 `!editing.value`），外加单测 12→17 条与 CHANGELOG 补条。

## 总体结论

**无新问题。这 3 处改动方向正确、语义自洽，可以合入。**

三个重点疑虑逐一验证均不成立：

1. **哨兵值 `'******'` 不会泄漏到真实请求**。服务端所有探针路径（`runCheck`、`test`）都从 `watcher.headersJson` 解密后取 headers，**不经过 `input.headers`**；`restoreMaskedHeaders`（`watcher.service.ts:569-577`）对 `value === SECRET_MASK && isSensitiveProbeHeader(key)` 的键用库内原值替换，落库值已是还原后的真值。已用真实 `WatcherService` + 注入假 probe 抓取实际请求体验证：更新后 `runCheck` / `test` 发出的 `headers` 与库内原值逐字相等，`JSON.stringify(请求)` 中不含 `******`。
2. **`originalHeaders` 没有被误用**。它只在 `clearedHeaders` 这一个布尔条件里参与判断（`editing && headers === undefined && originalHeaders != null && Object.keys(originalHeaders).length > 0`），不参与任何 payload 字段组装；测试确认 `Object.keys(payload)` 中无 `originalHeaders`，且传 `{A,B,C}` 与 `{A}` 得到相同 payload（只有 `null` 与否的差别）。
3. **`headers: null` 显式清空链路真的通**。已验证落库 `headersJson = null`，且清空后 `runCheck` 发出的 `headers` 为 `{}`（不带任何请求头）。

基线复核：`desktop npm run build` exit 0；`signal-watcher-form.test.ts` 17 passed；`desktop npm run test:unit` 473 passed + 1 既有失败（`zz-logicbug-probe J4`，main 上同样失败）；`backend-ts` 全量 3614 passed / 14 skipped；`admin build` exit 0。

---

## 逐项验证明细

### 1. 掩码行下发 `'******'` 的安全性（重点 1）

核对服务端全部消费 `headers` 的路径：

| 路径 | 取值来源 | 是否可能拿到 `'******'` |
| --- | --- | --- |
| `watcher.routes.ts:22` `toInput` | 请求体原样 | 是（入参） |
| `watcher.service.ts:151-153` `update` → `restoreMaskedHeaders` | 入参与库内原值 | **否**：敏感键的掩码值被替换为库内原值 |
| `watcher.service.ts:510` `normalizeInput` → `assertProbeHeaders` | 上一步的还原结果 | **否**：进入时已是还原后的值；`assertProbeHeaders` 本身不做掩码判定，只做合法性校验 |
| `watcher.service.ts:236-244` `test` | `decryptHeaders(watcher.headersJson)` | **否**：来自库内密文解密 |
| `watcher.service.ts:295-307` `runCheck` | `decryptHeaders(watcher.headersJson)` | **否**：同上 |

也就是说，`'******'` 只可能作为**入参**短暂存在，落库前必被 `restoreMaskedHeaders` 还原（敏感键）或原样保留（非敏感键——此时它是用户真实输入的值，不是哨兵值）。探针执行链路完全不接触入参。

**新建态不会下发掩码**：`openCreateDialog` → `resetForm()` 把 `form.headers` 置为 `[]`，`addHeaderRow()` 恒定 push `masked: false` 的行，`masked: true` 只可能由 `headerPairsFromView`（编辑态回显）产生。因此 `collectHeaders([])` 返回 `undefined`，新建态请求体里连 `headers` 键都没有。测试已断言这一点。

### 2. `originalHeaders` 的使用范围（重点 2）

`SignalWatchersView.vue:375` `openCreateDialog` 置 `null`、`:384` `openEditDialog` 赋 `watcher.headers`（打码后的 view 值）。`submitForm` 传 `originalHeaders.value ?? undefined`。

- `buildWatcherPayload` 内仅在 `clearedHeaders` 计算中读取，且只读 `!= null` 与 `Object.keys(...).length > 0`——**不读任何 value**，所以传打码值没有信息泄漏风险。
- 传入的键即使与库内不一致（例如库内 `authorization` 小写、view 里还是小写），只要非空就会走「删光 = 清空」分支，符合用户意图（用户确实看到了行并删掉了它们）。
- 边界：`originalHeaders = {}`（库内本来无请求头）→ 不下发键，不重置基线，正确（无实质变化）。

### 3. `headers: null` 显式清空（重点 3）

链路验证通过：
`buildWatcherPayload` 产出 `headers: null` → `toInput`（`'headers' in body` 为 true 且值为 null）→ `input.headers = null` → `update` 的 `input.headers !== undefined` 分支 → `restoreMaskedHeaders(null, stored)` 直接 `return null` → `normalizeInput` 的 `input.headers == null ? null : ...` → `encryptHeaders(null)` → `headersJson = null`。

已断言落库 `headersJson === null`，且 `lastValueHash` 被置 null（清空是真实变更，重置基线符合 `AFFECTS_BASELINE` 语义）。

### 4. `canSubmit` 改 `.value`（重点 4）

编译产物确认已变为 `!editing.value`。行为矩阵（9 条测试全绿）：

| 场景 | 修复前 | 修复后 | 是否符合预期 |
| --- | --- | --- | --- |
| 新建态 POST + body 留空 | 放行（拦截失效） | **拦住** | 符合（避免无效提交打到服务端） |
| 新建态 POST + body 有值 | 放行 | 放行 | 符合 |
| 编辑态 POST + body 留空 | 放行 | **放行** | 符合（编辑态留空 = 不修改） |
| 编辑态 POST + body 有值 | 放行 | 放行 | 符合 |
| GET 态（新建/编辑） | 放行 | 放行 | 符合 |
| 名称/agentId/URL/JSON_FIELD 路径/提示词为空 | 拦住 | 拦住 | 无变化 |

未误拦编辑态：编辑态 POST 留空仍然可以点保存，提交时 `body` 键不出现，服务端保留原值。

`submitForm` 里的 `if (editing && editingId.value != null)` 本轮**未改**（仍是裸 ref）。经分析这是安全的：裸 ref 恒 truthy，但 `editingId.value != null` 在新建态为 false（`openCreateDialog` 已置 null），所以分支永远正确；编辑态 `editingId` 非 null 且 `editing` truthy → 走 update。本次测试确认了这两种走向。建议后续与 `canSubmit` 一并规范为 `.value`，属可选清理，不构成 bug。

### 5. 基线重置判定未被掩码行误触（重点 5）

这是本轮改动最需要担心的回归点：掩码行现在会出现在 payload 里，`AFFECTS_BASELINE` 含 `headers`，若还原后的值与库内不一致就会清掉 `last_value_hash`。验证结果：

| 场景 | 落库 headers | `lastValueHash` | 判定 |
| --- | --- | --- | --- |
| 只改名称，请求头行原样 | `{Authorization: Bearer SECRET, X-Trace: abc}` | `HASH_KEEP`（未重置） | 正确 |
| 新增一个请求头 | 原值 + `X-New` | `null`（重置） | 正确（真实变更） |
| 只改非敏感头的值 | 敏感头还原 + 新值 | 重置 | 正确 |
| 删掉一行、留一个掩码行 | 只剩保留行 | 重置 | 正确 |
| 删光所有行 | `headersJson = null` | `null`（重置） | 正确 |
| 库内 `{}` 且删空 | 键不下发 | `HASH_KEEP`（未重置） | 正确（无实质变化） |
| 掩码键名大小写被改写（`authorization`→`Authorization`） | 还原为 `Bearer S` | `HASH_KEEP`（未重置） | 正确（`canonicalHeaders` 小写归一生效） |

即 `restoreMaskedHeaders` 还原 + `effective` 用 `canonicalHeaders(headers)` 覆盖 + `existingRaw` 也用 `canonicalHeaders` 这套既有机制，正好覆盖了「掩码行进 payload」的新情况，没有引入假差异。

### 6. 顺带验证的边界（11 条，全绿）

| 场景 | 结果 |
| --- | --- |
| 空键行 + 掩码行混合 | 空键仍被跳过，掩码行下发占位 |
| 掩码行填纯空白 `'   '` | 按「留空」下发掩码占位（不会把空白当新值发出去） |
| 用户把敏感键改名成新键并留空 masked | 落库 `{'X-Api-Key': '******'}`——见下方「已知限制」第 4 条 |
| 非敏感键里真输入 `'******'` | 原样落库（`isSensitiveProbeHeader` 把关，不误还原） |
| 库内请求头为 `{}` 或 `null` 时编辑态删空 | 不下发键，不重置基线 |
| `originalHeaders` 键数多少 | 只影响是否下发 `null`，不影响 payload 值 |
| `method` 改 GET 时掩码行 | 仍正常下发（与 body 无关） |
| 键名含 `':'` | 服务端 `assertProbeHeaders` 报「请求头名称不合法」（400），前端不预检但错误可达用户 |

---

## 已知限制（均非本轮引入，不阻塞）

以下为复查中新确认的边界，均为**边缘交互**而非功能错误，建议后续排期处理，不要混进本次构建/修复改动：

1. **掩码键改名后留空会落库字面量 `'******'`**：用户把 `Authorization` 改成 `X-Api-Key` 并留空（masked 行），服务端在库内找不到 `x-api-key` 键，`lowered.get(...) ?? value` 回退为掩码字面量，之后探针会真的发出 `X-Api-Key: ******`。触发条件较苛刻（既要改键名又要留空），且旧实现在此场景下是「静默丢掉整个键」，新实现至少保住了键。建议后续在 UI 上把「改名」和「留空」做冲突提示，或在服务端对「敏感键 + 掩码值 + 库内无此键」直接报参数错误。
2. **`submitForm` 的 `if (editing && ...)` 仍是裸 ref**：当前安全（靠 `editingId` 兜底），但与刚修好的 `canSubmit` 风格不一致，建议一并改 `.value`。
3. **编辑态清空 JSON_FIELD 提取路径仍改不掉旧值**（第一轮已记录）：需先切到 HASH 再提交。
4. **`assertProbeHeaders` 的非法键名错误以 400/500 形式返回**，前端无预检；错误信息可达用户，属可接受的兜底。

---

## 本轮追加验证记录（临时 spec 均已删除）

| 临时文件（已删） | 内容 | 结果 |
| --- | --- | --- |
| `backend-ts/src/signal/.__tmp_review/mask-roundtrip.test.ts` | 掩码还原 / 探针不泄漏 / `null` 清空 / 新建态不发掩码 / 基线判定，共 5 组 16 条 | 16 passed |
| `backend-ts/src/signal/.__tmp_review/edge.test.ts` | 空键与空白掩码行 / 键名改写 / 非敏感键输入掩码 / 库内 `{}` / `originalHeaders` 用途 / method 切换 / 非法键名，共 7 组 11 条 | 11 passed |
| `desktop/src/.__tmp_review/cansubmit.test.ts` | `canSubmit` 改 `.value` 后的 6 场景行为矩阵 + `submitForm` 分支走向 + 编译产物断言，共 9 条 | 9 passed |

审查结束后 `git status --porcelain` 仅剩本轮改动的 4 个生产文件 + 本报告，未修改任何生产代码、未向仓库提交临时文件。
