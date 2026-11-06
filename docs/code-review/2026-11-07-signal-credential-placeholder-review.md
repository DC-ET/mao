# 信号哨兵凭据占位符（0.0.467）Code Review 报告

- 轮次：第 1 轮（2026-11-07）
- 审查对象：`feat/signal-credential-placeholder` 分支 HEAD `fc6328b2`（基线 `f04b75a8`），对照技术方案 `docs/plan/2026-11-06-signal-watcher-credential-placeholder-technical-design.md`（§3 决策表 D1-D8、§5 改动清单、§8 评审补充 8.1-8.10）逐条核对。
- 审查范围：仅功能逻辑（文档变更不审）。临时验证 spec 已在验证后删除，未留在仓库中。

## 结论

发现 **1 个低危 bug**（存量数据兼容缺口，已用真实测试复现）。核心功能逻辑（占位符校验/替换口径、跳头语义、去重并发、打码例外与掩码还原交互、runCheck/test 双入口插入位置、装配层只读 injector、前端插入控件、mao-cli 同口径校验）均核对无误。

---

## Bug 1（低危）：D4 校验闸使存量 `{{...}}` 字面量请求头的哨兵无法再编辑/复制（含不改请求头的编辑）

### 位置

- `backend-ts/src/signal/probe-validate.ts:140-142`（`assertProbeHeaders` 内新增的 D4 校验）
- `backend-ts/src/signal/watcher.service.ts:209-225`（`update`：`input.headers === undefined` 时取库内解密头进 `normalizeInput` → `assertProbeHeaders`，改名等不涉头的编辑同样过闸）
- `backend-ts/src/signal/watcher.service.ts:769-780` + `:175`（`applyCopyInheritance` 掩码行从源行还原的值随 `create` 进同一道闸）

### 触发条件

本功能上线**之前**落库的哨兵，请求头值里恰好有 `{{...}}` 形态的字面量（例如 `X-Tpl: {{EVIL}}`）。该数据在旧版是合法的（当时无占位符校验），技术上方案 §4.1「存量哨兵不含占位符，行为零变化」的前提对这批行不成立。之后：

1. 对该哨兵做**任意** `update`——包括只改名、只调间隔、不下发 `headers` 的编辑——`update` 会把库内解密出的存量头并入 `merged.headers` 再过 `normalizeInput`，D4 命中 `{{EVIL}}` → 抛 `PARAM_INVALID「请求头 X-Tpl 含不支持的占位符（仅支持 {{MAO_TOKEN}} / {{ECP_TOKEN}}）」`，编辑失败；
2. 复制该哨兵且源头的 `{{EVIL}}` 是敏感头（复制预填为掩码行、保存时由 `applyCopyInheritance` 从源行解密还原）→ 还原值进 `create` 的同一道闸 → `create` 失败。

### 影响

- 这批存量哨兵在用户手动删除/改写该请求头值之前**无法编辑、改名、启停改配置或复制**（探针执行不受影响：执行路径对非白名单占位符原样直发，与旧版一致，已实测）。
- 错误信息点名了具体请求头，恢复路径存在（删掉该行或改成白名单值即可保存），因此定级低危；但它是本次提交引入的行为回归，且与技术方案 §4.1 的存量零变化断言冲突，方案与 CHANGELOG 均未提示此不兼容。是否需要 grandfather（仅对 create 生效、update 对库内存量值放行）由团队定夺。

### 验证用例与运行结果

验证用临时 spec `backend-ts/src/signal/tmp-review-legacy-d4.spec.ts`（真实 `WatcherService` + 真实 `SignalSecretCipher`，密文按存量行构造后删除，未提交）。4 个用例全部通过（`npx vitest run` exit=0，Tests 4 passed）：

1. **改名即失败（复现主路径）**：存量 headersJson = `{"X-Tpl":"{{EVIL}}","Accept":"json"}`，调 `service.update(7, 1, { name: 'renamed' })`（不下发 headers）→ 断言 `rejects.toThrow(/不支持的占位符/)` ✓ 实测抛出。
2. **白名单占位符不受影响（对照）**：存量 `{"Authorization":"{{MAO_TOKEN}}", ...}`，同样只改名 → update 成功，回显 `Authorization` 仍为 `{{MAO_TOKEN}}` ✓。
3. **复制继承路径同闸**：存量敏感头 `{"Authorization":"{{EVIL}}"}`，`create(..., { headers: { Authorization: '******' }, copyFrom: 1 })`（掩码行走源行解密继承）→ 断言 `rejects.toThrow(/不支持的占位符/)` ✓ 实测抛出。
4. **执行路径不受影响（对照）**：同一存量行调 `service.test(7, 1)`，resolver 已装配 → 探针收到的头仍为 `{"X-Tpl":"{{EVIL}}"}` 原样直发、HTTP 200 正常返回 ✓（与旧版行为一致，无回归）。

---

## 已核对无误的重点项（抽查手段与结果）

以下方向均按审查清单核对并配了针对性验证（临时 spec，验证后删除；既有定向套件全绿）：

1. **校验层与替换层正则口径**（`probe-validate.ts`）：对 15 种形态逐一验证（`{{MAO_TOKEN}}`/`Bearer {{MAO_TOKEN}}`/`{{{MAO_TOKEN}}}`/`{{{{MAO_TOKEN}}}}`/`{{MAO_TOKEN}}}}`/`{{MAO_TOKEN}}{{BAD}`/`{{MAO_TOKEN`/`{{ MAO_TOKEN }}`/`{{mao_token}}`/`{{EVIL}}` 等）：凡完整 `{{...}}` 形态，校验拒绝集与白名单完全一致，不存在「校验放过但替换不生效」或反向错位；带 `g` 正则均为调用点新建或经 `String.replace/match`（无 lastIndex 污染），模块级 `WHITELISTED_PLACEHOLDER_RE` 无 `g` 标志、`.test()` 安全（§8.1/8.2 落实）。未终止的残缺形态（如 `{{MAO_TOKEN`）会原样直发，但它不属于方案 D4 承诺拒绝的 `{{XXX}}` 形态，不计为 bug。
2. **`resolveProbeHeaders` 语义**（`watcher-credential-resolver.ts`）：任一 kind 失败（null/抛错/空串）精确丢弃且只丢弃含该 kind 的头；同 kind 跨头、同头多次出现均只 resolve 一次且两处值一致（D8/§8.9）；不同 kind `Promise.all` 并发；resolver 抛错被按 kind 捕获不冒泡；缺 resolver 时仅含白名单占位符才告警并原样直发（D6）。全部有既有 spec 覆盖且通过。
3. **D5 打码例外与掩码还原、前端往返**：`isPlaceholderOnlyValue` 判据（剥占位符后为空）不会把 `Bearer sk-real {{MAO_TOKEN}}` 误判为纯占位符（仍打码）；纯占位符值 ≠ `******`，不会被 `restoreMaskedHeaders` 当掩码吞掉、也不会把掩码当占位符落库（`watcher.service.spec.ts` 与 `signal-watcher-form.test.ts` 覆盖，53+137 用例全绿）。复制继承（copyFrom）对纯占位符头（显式值直传）与混合头（掩码行还原）两条链路均正确。
4. **runCheck 插入位置**（`watcher.service.ts:417-425`）：解析在 decrypt/assertProbeUrl try 块之后、executeProbe 之前，独立 try/catch；解析失败只丢头、不进 `recordFailure`、探针照常（跳头后目标 401 属 ok 响应，只参与判定哈希、计连败——与 D2/D3 一致）；`test` 入口同口径（§8.4 落实）。
5. **装配层**（`app-openapi-services.ts` + `create-app.ts`）：`jwt/userRepo/ecpSessionRepo` 三依赖接口新增、解构、透传完整（`create-app.ts:271/294/334` 均早于 `:893` 调用点）；ECP injector 为装配层新建的只读实例 `createEcpCredentialsInjector(ecpSessionRepo, () => null)`，对照 `ecp-credentials-injector.ts` 确认 `home` 为 null 时 write/clear AccessOne 布局分支全部跳过、无文件副作用；`MysqlUserRepository.findById` 带 `notDeleted()` 过滤、MAO 签发链与 `shell-session-tool.ts:476-486` 逐行同口径。
6. **前端插入控件**（`SignalWatchersView.vue`）：按钮显式 `type="button"`（el-form submit 坑）；element-plus `InputInstance` 运行时确实 expose `input/textarea`（已核 node_modules dist），光标插入/退化追加逻辑正确；掩码行插入占位符即显式改值，与 `collectHeaders`「掩码行留空下发 SECRET_MASK」语义兼容；`{{MAO_TOKEN}}` 出现在绑定属性的 JS 字符串字面量与非绑定属性中均为字面文本，无 Vue 插值误解析。
7. **并发安全**：`resolveProbeHeaders` 全部状态（regex/Map/Set）为调用内局部，`createWatcherCredentialResolver` 闭包无共享可变状态，调度线程池并发调用无污染。
8. **mao-cli `parseHeaders`**（`signal-watcher.js:1007-1011`）：候选扫描与白名单锚定匹配和后端 `containsUnsupportedPlaceholder` 对同一值集合的判定完全等价，本地先行拒绝口径一致。
9. 定向回归：`backend-ts` 三个 signal spec（137 用例）、desktop 两个 signal 表单 spec（53 用例）全部通过；临时审查 spec 删除后 `git status` 干净。
