# 信号哨兵凭据占位符注入技术方案（`{{MAO_TOKEN}}` / `{{ECP_TOKEN}}`）

- 状态：已实施（2026-11-07 合入 main；范围见 CHANGELOG 0.0.467；评审补充见 §8，逐条已落实）
- 日期：2026-11-06
- 需求来源：用户提案「创建信号哨兵时支持勾选注入 Mao 系统中已有的信息，如 MAO_TOKEN、ECP_TOKEN」（会话沟通；附图：新建哨兵表单截图）
- 上游设计：`docs/plan/2026-10-11-signal-watcher-technical-design.md`、`docs/plan/2026-10-27-selection-quote-technical-design.md`（复制继承）
- 规模：中小（后端 ~200 行 + 单测；前端表单一处 + 布局断言；装配层三处依赖透传；**零数据库迁移**）
- 关联：`backend-ts/src/signal/{watcher.service,probe-validate,probe-client}.ts`、`backend-ts/src/app-openapi-services.ts`、`desktop/src/views/settings/SignalWatchersView.vue`

## 1. 需求背景

### 1.1 要解决的问题

哨兵探针要访问需要登录态的目标服务时，用户只能把 token 手动粘贴进「自定义请求头」：

1. **`MAO_TOKEN` 是短效 shell JWT**（`jwt.service.ts:32` `generateShellToken`，按次签发，`cfg.jwt.shellExpiration` 控制有效期）——粘贴进配置必然很快过期，哨兵随后每轮探针都发无效凭据、连败到自动停用。
2. **`ECP_TOKEN` 是 ECP sessionToken**（12 小时自动 renew，`ecp-session.repository.ts`）——用户粘贴的是随时会被轮换的值，同样会静默失效。
3. 用户粘贴明文 token 还增加泄露面（虽然是 AES-GCM 加密落库，但用户复制粘贴过程会经过剪贴板/截图/分享）。

### 1.2 关键事实（设计建立在其上）

- 哨兵请求头整体 AES-GCM 加密落库（`headersJson`，`signal-cipher.ts`），回显时敏感头打码为 `******`（`probe-validate.ts` `maskProbeHeaders`），编辑回传时掩码经 `restoreMaskedHeaders` 还原库内原值——「明文永不落前端」是既有纪律，本方案沿用。
- 请求头校验白名单已存在：键名合法、禁覆盖 hop-by-hop 头、最多 20 个（`probe-validate.ts` `assertProbeHeaders`）。
- `MAO_TOKEN` 的生产签发链已有封装：`ShellTokenIssuer { generateShellToken(userId, username) }` + `ShellUserLookup { findById(userId) }`（`harness/tool/impl/shell-session-tool.ts:25-31`，`create-app.ts:270` 已有 `jwt` 实例）。签发失败（用户不存在/用户名为空）时 shell 的处理口径是**跳过注入 + 告警日志**（`shell-session-tool.ts:480`）。
- `ECP_TOKEN` 的生产读取链已有封装：`createEcpCredentialsInjector(sessions, resolveUserHome).injectForUser(userId)`（`auth/ecp-credentials-injector.ts`）。它自带完整容错：无票 / renew FAILED / 过期 / 解密失败 → 返回 `null` + 告警日志 + 清理 AccessOne 布局。`create-app.ts:579` 已有 `ecpInjector` 实例，其依赖 `ecpSessionRepo` 构造于 `create-app.ts:333`。
- 探针执行有两个入口都要覆盖：调度轮询 `runCheck` 和用户手动「立即测试」`test`（`watcher.service.ts`），两者都走 `decryptHeadersStrict` → `executeProbe`。
- `signal` 域的哨兵属主是 `watcher.userId`，探针执行时天然有用户上下文——「以谁的身份签发 token」无需新增配置。

### 1.3 与用户对齐过的三个决策（会话 2026-11-06）

| # | 问题 | 用户答复 |
|---|---|---|
| 1 | 注入形态 | **动态注入**：不落库、不进前端，每次探针执行时后端现取当时有效 token |
| 2 | 注入位置 | **header 名称用户自填，值可选手填或插入凭据占位符**（否决了固定 `Authorization: Bearer` 形态） |
| 3 | token 签发不出时 | **跳过注入继续探针**（不计连败、不停用；目标服务的 401 本身就是有效信号） |

## 2. 方案概述

请求头的**值**支持两个占位符：`{{MAO_TOKEN}}`、`{{ECP_TOKEN}}`。

- 配置态：用户在请求头值里填 `Bearer {{MAO_TOKEN}}` 这类字符串，**落库的就是占位符本身**（不含任何明文 token），随 `headersJson` 整体 AES-GCM 加密。
- 执行态：`runCheck` / `test` 在 `decryptHeadersStrict` 之后、`executeProbe` 之前，把每个头值里的占位符替换为**当时**签发/读取的有效 token。
- 回显态：占位符本身不敏感（不含密文），现有打码逻辑只对「值等于 `******`」的敏感头还原；占位符值原样回显，用户能看到自己配了什么。
- 复制态：占位符随加密 headers 正常继承，无需改 `applyCopyInheritance`——复制出的是「同样的占位符」，每次执行各自解析，天然正确。

### 2.1 为什么是占位符而不是「勾选注入」

用户初始提案是勾选注入。占位符方案覆盖勾选方案的全部能力且更精确：勾选方案需回答「注到哪个头、什么格式」（`Authorization: Bearer`？自定义头？），而这些只有用户知道目标服务的口径。占位符把「注入什么」（白名单枚举）和「注到哪、什么格式」（用户自填）分离，header 名称与值格式完全由用户决定——这正是决策 2 的用户答复内容。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 占位符语法 | `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}`，双花括号 | 与 `promptTemplate` 的 `{url}`/`{diff}` 单花括号语法区分开，避免用户误以为二者同源；双花括号是常见模板惯例（vue/mustache），认知成本低。**注**：本项目自定义 HTTP 工具的 URL / body 模板已在用同一套双花括号（`harness/tool/impl/http-api-executor.ts:14` `PLACEHOLDER_RE`），语义是「替换为工具参数值」，两处语法同形但数据源不同——此处沿用双花括号反而**降低**了跨模块认知成本（用户已在该模块见过），且都在「服务端渲染时替换」这一层。差异点在方案 §8.7 单独立项说明。 |
| D2 | 占位符解析失败语义 | **跳过整个头**（该键值对不出现在发出去的请求里）+ `harnessLog('warn', ...)` | 决策 3 的直接推论。跳过「整个头」而非「留下占位符字面量」：把 `Bearer {{MAO_TOKEN}}` 原样发给目标服务毫无意义，还可能污染判定值。跳过后目标服务返回 401 → 探针正常完成、哈希参与变化判定，与「凭据失效」这一真实信号一致。 |
| D3 | token 不可用是否计连败 | 否。D2 跳过后探针照常执行，成功与否由目标服务响应决定 | 若计连败：ECP 票过期的用户没重新登录，哨兵会在 5 个间隔后自动停用——把「需要用户重新登录」误报成「目标服务故障」。跳过语义下目标服务的 401 响应本身就是有效判定输入。 |
| D4 | 未识别的 `{{XXX}}` 形态 | 校验层直接拒绝：请求头值里出现 `{{...}}` 且内部不是两个白名单名之一 → `PARAM_INVALID`「请求头 X 含不支持的占位符（仅支持 {{MAO_TOKEN}} / {{ECP_TOKEN}}）」 | 静默放过会让占位符字面量发往目标服务（同 D2 的污染问题），且用户以为注入生效了。校验放在 `assertProbeHeaders` 旁边（新函数），create/update 同一道闸。 |
| D5 | 占位符头是否敏感打码 | **不打码**：占位符不含明文密文，原样回显 | `isSensitiveProbeHeader` 按键名判定（含 `token`/`authorization` 即打码）。若 `Authorization: Bearer {{MAO_TOKEN}}` 被打成 `******`，用户回显时看不到自己配了占位符，反而误删重配。**需在 `maskProbeHeaders` 加例外：值只由白名单占位符组成时跳过打码**；混合形态（`Bearer {{MAO_TOKEN}}`）含非占位符字符 → 仍打码。例外必须写成「剥掉全部白名单占位符后为空串」而非「值里含占位符」——后者会让 `Bearer sk-real {{MAO_TOKEN}}`（用户把真实 token 和占位符混存）一并不打码，把明文泄露到回显里。D5 例外与 `restoreMaskedHeaders` 的还原判据互不干扰：还原判据是「值精确等于 `******`」，占位符值永远不等于它（详见 §8.5）。 |
| D6 | 签发依赖注入方式 | `WatcherServiceDeps` 增加可选 `credentialResolver?: WatcherCredentialResolver`，装配层传真实实现，缺省不解析（占位符字面量直发） | 与现有 `probe` / `disableNotifier` 可选依赖注入风格一致；单测注入假实现，不动 JWT secret。**但缺省路径不能静默**：resolver 为 null 而头值里确有占位符时，必须打一条 `harnessLog('warn', ...)` 说明「哨兵配了凭据占位符但本实例未装配 resolver」——否则装配遗漏（如将来新增一处 `new WatcherService` 忘传依赖）会让所有占位符头原样发 `{{MAO_TOKEN}}` 字面量，用户侧只看到目标服务 401，无从判断是配置错还是部署缺件。告警条件与 §5.1.3 一致：仅当值含白名单占位符时才打，无占位符的存量哨兵零噪音。 |
| D7 | body 里的占位符 | **不做**。仅请求头 | 决策 2 用户答复只提了 header；body 占位符（如 JSON 体里放 token）需求未确认，POST body 是完整用户内容、做字符串替换的误伤面大（用户业务数据可能合法包含 `{{...}}`）。有真实需求再立项。 |
| D8 | 多占位符组合 | 一个头值里可含多个占位符（如 `{{MAO_TOKEN}} {{ECP_TOKEN}}`），任一解析失败按 D2 跳过整头 | 无真实场景但语法上自然支持；跳过口径统一，不引入「部分替换」的中间态。 |

## 4. 数据契约

### 4.1 数据库

**零迁移。** 占位符是普通字符串，存在既有 `signal_watcher.headers_json` 加密列里。存量哨兵不含占位符，行为零变化。

### 4.2 接口

**REST 契约零改动。** `WatcherInput.headers` 的值域新增两个合法占位符；`SignalWatcherView.headers` 回显值新增占位符形态（D5）。无需改 `desktop/src/api/index.ts` 的类型定义（`Record<string, string>` 不变）。

## 5. 改动清单

### 5.1 后端 `backend-ts/src/signal/`

1. **`probe-validate.ts`**：新增导出
   - `CREDENTIAL_PLACEHOLDERS = ['MAO_TOKEN', 'ECP_TOKEN'] as const`
   - `CREDENTIAL_PLACEHOLDER_PATTERN = /\{\{(MAO_TOKEN|ECP_TOKEN)\}\}/g`
   - `containsUnsupportedPlaceholder(value): boolean`（值含 `{{...}}` 且非白名单）
   - `assertProbeHeaders` 内追加 D4 校验（不新开函数，与既有键名/值校验同层）。
   - `maskProbeHeaders` 追加 D5 例外（值剥掉全部白名单占位符后为空串 → 不打码）。
   - **正则写法**：`CREDENTIAL_PLACEHOLDER_PATTERN` 用 `g` 标志会带 `lastIndex` 状态，跨调用复用同一正则对象在 `.test()` / `.exec()` 之间会漏匹配。要么每次调用时新建字面量，要么统一用 `String.prototype.replace` 的函数式替换（单遍、不递归、无 lastIndex 问题，口径与 `http-api-executor.ts:14` 的 `PLACEHOLDER_RE` 一致）。`containsUnsupportedPlaceholder` 的实现必须与替换逻辑同源：判定「存在 `{{...}}` 且不在白名单」用 `/\{\{[^}]*\}\}/g` 扫出全部候选，逐个与白名单比对——不能反过来只扫白名单（那会漏掉 `{{EVIL}}`）。
2. **新文件 `watcher-credential-resolver.ts`**：
   - `interface WatcherCredentialResolver { resolve(userId: number, kind: 'MAO_TOKEN' | 'ECP_TOKEN'): Promise<string | null> }`
   - `resolveProbeHeaders(headers, userId, resolver): Promise<Record<string, string>>`——扫描每个头值中的占位符，逐个 `resolve`；任一失败（返回 null）丢弃整个头并 `harnessLog('warn', '[signal] skip header ...')`；无占位符的头原样直通（零开销）。
   - **去重与并发**：同一头值里出现多个占位符（D8）时，按 `kind` 去重后并发 `resolve`（`MAO_TOKEN` 每次调用都重新签发，去重避免一个头里两个同种占位符签出两个不同 token）；不同头之间的 resolve 也并发执行——探针超时预算是 10s 连接 + 15s 读取，串行查库会把多个头的哨兵拖到超时。`Promise.all` 后统一装配。
   - **异常口径**：resolver 内部抛错（库瞬断、解密失败）与返回 null 同口径——跳过该头 + 告警，不让异常冒泡到 `runCheck` 的探针 try 块外（见 §5.1.3）。
   - 工厂 `createWatcherCredentialResolver({ tokenIssuer, userLookup, ecpInjector })`：
     - `MAO_TOKEN`：`userLookup.findById(userId)` → `tokenIssuer.generateShellToken(userId, username)`；用户不存在/无用户名 → null（对齐 `shell-session-tool.ts:480` 口径）。`userLookup` 直接用 `userRepo`（`user.repository.ts:32` `findById` 返回的 `User` 有 `username`，结构兼容 `ShellUserLookup`），无需新写适配层。
     - `ECP_TOKEN`：`ecpInjector.injectForUser(userId)`——但**不能直接用 `create-app.ts:579` 的 `ecpInjector`**：它会写 / 删 AccessOne 布局文件（`accessone-ecp-credentials.ts` 的 `writeAccessOneEcpToken` / `clearAccessOneEcpToken`），探针路径不该有文件副作用，且「探针跑一轮把用户 shell 的 ECP 布局清掉」是跨功能干扰。装配层用 `createEcpCredentialsInjector(ecpSessionRepo, () => null)` 新建一个只读实例：`resolveUserHome` 返回 null 时 injector 内的 `if (home)` 分支全部跳过，写与清都不发生，只做「查行 → 判 renew 状态 → 判过期 → 解密」四步只读判定（`ecp-credentials-injector.ts` 已支持，无需改 injector）。
3. **`watcher.service.ts`**：
   - `WatcherServiceDeps` 增加可选 `credentialResolver?: WatcherCredentialResolver | null`（D6）。
   - `runCheck` / `test`：在 `decryptHeadersStrict` 之后调 `resolveProbeHeaders`（resolver 存在且值含占位符时才真正解析）。
   - 注意：`runCheck` 头部已有的 try 块只包了 decrypt + `assertProbeUrl`，解析占位符的异常需单独兜住（resolver 抛错按 D2 跳过对应头，不让整轮探针失败）。
   - `test` 路径同样要解析：用户点「立即测试」看到的必须与调度轮询一致，否则「测试通过但轮询一直 401」会变成新的排查成本。
4. **`app-openapi-services.ts` 装配**：`new WatcherService({...})` 增加真实 resolver。依赖要穿透两层——`assembleOpenApiServices` 的 `OpenApiServicesDeps` 目前没有 `jwt` / `userRepo` / `ecpSessionRepo`，需在 deps 接口新增这三个字段，并由 `create-app.ts:892` 的调用点透传（`jwt` 构造于 `create-app.ts:270`、`userRepo` 于 `:293`、`ecpSessionRepo` 于 `:333`，三处都早于 `:892`，时序无碍）。**ECP injector 必须在 `app-openapi-services.ts` 内新建只读实例**，不要从 `create-app` 传 `ecpInjector` 进来——传进来的是带写文件副作用的那个，与 §5.1.2 的只读要求相反；只传 `ecpSessionRepo` 让装配层自己 `createEcpCredentialsInjector(ecpSessionRepo, () => null)`。

### 5.2 前端 `desktop/src/views/settings/SignalWatchersView.vue`

请求头编辑区每个值输入框旁加一个「插入凭据」小控件（下拉或两个按钮）：点击在光标处插入 `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}`；输入框 placeholder 提示支持占位符。安卓窄屏已有布局回归测试（`SignalWatchersView.layout.test.ts`），需补一条控件存在的断言并验证不破坏既有布局。

布局注意点（`SignalWatchersView.vue:848-853` `.header-row` 是 `grid-template-columns: 1fr 1.4fr 32px` 三列）：插入控件不能挤进这三列把删除按钮顶出窄屏。建议放在 header 行的值输入框内部右侧（`el-input` 的 `suffix` 插槽）或整块 `.header-editor` 下方做一条「插入凭据」工具行，二者都不改动现有三列结构。控件上的按钮必须显式 `type="button"`——该文件 :120-127 的注释已记录「el-form 内 button 不写 type 会触发表单提交致整页重载」的既有坑。

文案要求（对应 §6.2 知情权，**已定案：只在控件 tooltip 内提示，不做常驻警示行**）：插入控件的 tooltip 文案必须包含「插入的凭据会在每次探针时自动发往上面配置的 URL」这一句，不能只写「插入 MAO_TOKEN」。用 `el-tooltip` 的 `content` 承载，`:show-after` 与页面既有 tooltip 口径一致（该文件 :36 等处用 300ms）。

### 5.3 测试

- `watcher.service.spec.ts`（或新增 `watcher-credential-resolver.spec.ts`）：
  - 占位符成功替换（fake resolver 回固定值，断言探针收到的 headers）；
  - resolver 返回 null → 整头被丢弃、其余头保留、探针照常执行、不计失败；
  - 值含未识别占位符 → create/update 被 `PARAM_INVALID` 拒绝（D4）；
  - 回显：`Authorization: Bearer {{MAO_TOKEN}}` 打码、纯占位符值 `{{MAO_TOKEN}}` 不打码（D5）；
  - 无 resolver / 值无占位符 → headers 原样直通（存量行为回归）。
  - **resolver 抛错**（非返回 null，如库瞬断）→ 与 null 同口径跳过头，不冒泡成探针失败；
  - **复制继承**：源哨兵头值为占位符 → 副本解密出的还是占位符，每次执行各自解析（§2 复制态断言的回归）；
  - **D5 反例**：`Bearer sk-real {{MAO_TOKEN}}` 混合值必须仍打码（防明文泄露的护栏）；
  - **编辑态回传**：纯占位符值回传时不被 `restoreMaskedHeaders` 当掩码处理、落库仍是占位符（§8.5 的回归）；
  - **多占位符去重**：一个头里两个 `{{MAO_TOKEN}}` 只 resolve 一次，且替换后两处值一致。
- `probe-validate.spec.ts` 补 `containsUnsupportedPlaceholder` 的白名单/黑名单用例（`{{MAO_TOKEN}}` 通过、`{{EVIL}}`/`{{mao_token}}` 小写/`{{ MAO_TOKEN }}` 带空格均拒绝——大小写与空格口径必须与替换正则严格一致，否则出现「校验放过但替换不生效」或反过来）。
- 前端 `SignalWatchersView.layout.test.ts` 补「插入凭据」控件断言。
- 前端 `signal-watcher-form.test.ts` 补占位符值的 payload 往返（`{{MAO_TOKEN}}` 既不是掩码也不被吞）。

### 5.4 文档与 CHANGELOG

- `skills/mao-cli/reference/signal-watcher.md` **核心规则表**加一行「凭据占位符」，说明必须包含「占位符在每次探针执行时由后端替换为当时有效的 token，并随请求发往上面配置的 URL」这一句（CLI 用户看不到桌面端 tooltip，§6.2 的知情权在这里补上）；并在「常见排障」补一条「哨兵 401 但凭据配了占位符」的排查路径（区分「ECP 票过期需重新登录」与「目标服务侧失效」）。这是主文档——占位符是用户侧功能，写在这里而不是只写 config.md。
- `skills/mao-cli/reference/config.md`：仅在 `APP_SIGNAL_SECRET` 那行补一句「占位符本身不含明文，落库即密文，轮换密钥不影响占位符」，避免用户以为轮换后要重配占位符。
- `skills/mao-cli/lib/commands/signal-watcher.js` 的 `parseHeaders`（:95）：与后端 `assertProbeHeaders` 对齐，补占位符白名单校验，让 CLI 本地就能报错（现该校验只覆盖键名/禁覆盖/CRLF，见该文件 :60-70 常量区）。不加校验则 CLI 用户要等一次请求往返才拿到 `PARAM_INVALID`。
- CHANGELOG：桌面共用 UI 小节 + 后端小节各一条（同一次发布）。
- AGENTS.md 无需改动（无新增仓库/目录，signal 域与 mao-cli 技能都已在既有条目内）。

## 6. 安全考量

1. **明文 token 永不落库、永不回显**：落库的是占位符；回显的是占位符（D5 例外只透出占位符本身）。解密-替换只发生在探针执行前的内存中，与 shell 注入 `MAO_TOKEN` 同一信任边界（同为服务端、同以 userId 定界）。
2. **凭据外传到第三方是本方案新增的攻击面，必须显式承认**：shell 路径的 `MAO_TOKEN` 只注入用户自己的 shell 进程，由用户自己决定敲什么命令；本方案则是**服务端自动**把有效 token 发往用户配置的任意公网 URL。缓解点：(a) 用户本来就是哨兵属主，能配 URL 就能配 shell，不存在越权提权；(b) `MAO_TOKEN` 是 shell 级 JWT，与该用户在 CLOUD shell 里能拿到的完全同权，不放大能力；(c) 目标服务若被攻陷或本身是恶意服务，拿到的是「该用户自己的」短期凭据，影响面等同该用户 shell 泄露。**结论：能力边界不扩大，但「自动外传」比「用户手动粘贴」更隐蔽。** 知情权落在插入控件的 tooltip 文案上（已定案：仅 tooltip，不做常驻警示行，避免抬高表单视觉密度）——文案必须写明「插入的凭据会在每次探针时自动发往上面配置的 URL」，不能只写「插入 MAO_TOKEN」。这同时约束 mao-cli：`signal-watcher.md` 的占位符说明里也要有同一句（CLI 用户看不到桌面端 tooltip）。
3. **SSRF 面不变**：占位符只影响头值，URL 校验（私网/环回禁止）与禁重定向逻辑零改动。注意探针**不跟随重定向**（3xx 判失败，`probe-client.ts`），所以不存在「重定向到恶意主机时凭据头被带走」的问题——这一点比自定义 HTTP 工具（`http-api-executor.ts` 需显式 `stripCredentialHeaders`）更安全，无需额外剥离逻辑。
4. **探测信息泄露面**：跳过头 + 目标服务 401 只暴露「该服务需要登录」这一用户本来就知道的事实，不暴露内网拓扑（`safeError` 只回协议级错误的口径不变）。
5. **MAO_TOKEN 能力边界**：签发的是 shell 类型 JWT，与 CLOUD shell 里 CLI 用的完全同权。用户本来就能在任意会话 shell 里拿到它，探针路径不产生新权限面。shell JWT 被 `validateAccessToken` 接受为访问凭据（`jwt.service.ts:118`），即该 token 能调用该用户的全部 REST 接口——这正是第 2 条要求前端明示的原因。
6. **ECP_TOKEN 只读化**：探针用独立 injector 实例禁掉 AccessOne 布局写文件副作用（§5.1.3），只读解密。
7. **日志不落 token**：跳头的告警日志只含 `watcherId` / `userId` / `kind`，绝不含头值原文或解析出的 token（`structured-logger.ts` 无凭据脱敏，写了就会进 stderr 日志）。同理不能把整个 headers 对象塞进告警。

## 7. 明确不做的

- 不做 body 占位符（D7）。
- 不做「勾选注入固定 Authorization 头」的形态（被决策 2 否决）。
- 不做新端点、不做数据库迁移、不改探针超时/大小上限/重定向策略。
- 不改管理后台（`signal-admin` 只读视图原样可用，占位符在 admin 详情里同样只见占位符不见明文）。
- 不做「token 即将过期提前告警」；ECP 票过期的既有 renew 调度器职责不变。

## 8. 评审补充（2026-11-06，逐条核验源码后补充）

评审结论：**需求与方案均可行**。方案对现状的六个关键判断经源码核验全部成立，无推翻性缺陷：

| 方案断言 | 核验结果 |
|---|---|
| 哨兵请求头整体 AES-GCM 加密、回显打码、掩码可还原 | 成立（`signal-cipher.ts`、`probe-validate.ts`、`watcher.service.ts` `restoreMaskedHeaders`） |
| 请求头校验白名单已存在（键名/hop-by-hop/20 个上限） | 成立（`probe-validate.ts:48-76`） |
| `MAO_TOKEN` 签发链已封装、失败口径是「跳过 + 告警」 | 成立（`shell-session-tool.ts:25-31` 定义、`:473-482` 口径） |
| `ECP_TOKEN` 读取链已封装且自带完整容错 | 成立（`ecp-credentials-injector.ts`，四类失败均返回 null + 告警） |
| 探针有 `runCheck` / `test` 两个入口，都走 `decryptHeadersStrict → executeProbe` | 成立（`watcher.service.ts` 两处同构） |
| 哨兵属主是 `watcher.userId`，执行时天然有用户上下文 | 成立（`runCheck` 开头即取到行，`test` 经 `requireOwned`） |

以下为不完善处的补充（已同步回写对应章节，此处集中留痕）：

### 8.1 正则复用缺陷（已补入 §5.1.1）
`CREDENTIAL_PLACEHOLDER_PATTERN` 若按方案原文写成带 `g` 的模块级常量，`.test()` / `.exec()` 会因 `lastIndex` 跨调用漏匹配。改为函数式 `replace` 单遍替换，与 `http-api-executor.ts:14` 既有口径一致。`containsUnsupportedPlaceholder` 必须正向扫 `{{...}}` 再比对白名单，不能只扫白名单（否则 `{{EVIL}}` 漏拒）。

### 8.2 大小写与空格口径（已补入 §5.3）
占位符是精确匹配还是宽松匹配，方案未定。定 **精确匹配**（大小写敏感、不允许内部空格），与自定义 HTTP 工具的 `PLACEHOLDER_RE`（`[A-Za-z0-9_]+`，不含空格）口径一致；校验层与替换层必须共用同一正则，否则会出现「校验放过但替换不生效」的静默不一致——这正是要补 `probe-validate.spec.ts` 反例的原因。

### 8.3 装配层依赖穿透被低估（已补入 §5.1.4）
方案原文「依赖从 `create-app.ts` 透传」过于轻描淡写：`assembleOpenApiServices` 的 deps 接口当前**没有** `jwt` / `userRepo` / `ecpSessionRepo`，需要改 `OpenApiServicesDeps` 接口 + `create-app.ts:892` 调用点两处。另需明确 ECP injector **在装配层内新建只读实例**，不要把 `create-app.ts:579` 那个带写文件副作用的 `ecpInjector` 传进来——传错就同时违反 §5.1.2 与 §6.6 两条。

### 8.4 `test` 入口易漏（已补入 §5.1.3）
方案提到两个入口，但改动清单只在 `runCheck` 上下文中讨论。`test` 路径必须同步解析，否则「立即测试返回 200、调度轮询一直 401」会成为高频排查成本。

### 8.5 D5 例外与 `restoreMaskedHeaders` 的交互（已补入 D5 / §5.3）
二者判据不同（前者「剥掉占位符后为空」，后者「值精确等于 `******`」），不会互相干扰，但必须补回归测试锁死：纯占位符值回传时不得被当掩码还原、落库仍是占位符。同时 D5 例外的实现必须防住 `Bearer sk-real {{MAO_TOKEN}}` 这种混合值——它含真实 token，必须仍打码。

### 8.6 resolver 缺省不能静默（已补入 D6）
D6 的「缺省不解析」若无声告警，装配遗漏会让占位符字面量直发目标服务，用户只看到 401 而无从判断。补一条仅在有占位符时触发的告警。

### 8.7 与自定义 HTTP 工具占位符的关系（已补入 D1）
方案原文称双花括号「与单花括号区分开、认知成本低」，但未注意到**项目内已有双花括号占位符**（自定义 HTTP 工具的 `{{参数名}}`）。实际影响是正面的（用户已见过同形语法、都在服务端渲染时替换），但数据源不同（工具参数 vs 系统凭据），需在文档里点明，避免用户以为两者同源可互填。

### 8.8 凭据自动外传的知情权（已补入 §6.2，文案形态已定案）
原方案安全考量漏了一条本质差异：shell 路径是「用户自己决定把 token 发给谁」，本方案是「服务端按配置自动外传」。能力边界不扩大（§6.5），但自动化让外传更隐蔽。

**定案：知情权只落在插入控件的 tooltip 上**（用户 2026-11-06 决定），不做请求头编辑区常驻警示行——常驻行会持续抬高表单视觉密度，而哨兵表单已有触发方式、判定模式、提示词模板等多段说明文案，再加一行会让「凭据」这一项的权重超过其实际复杂度。

tooltip 文案必须包含「每次探针时自动发往上面配置的 URL」这一实质信息（不能只写「插入 MAO_TOKEN」），`show-after` 与页面既有 tooltip 一致（300ms）。同时因为 CLI 用户看不到桌面端 tooltip，`skills/mao-cli/reference/signal-watcher.md` 的占位符说明必须带同一句（§5.4）。

### 8.9 并发与去重（已补入 §5.1.2）
探针有 10s 连接 + 15s 读取的时间预算，多个头的 `resolve` 必须并发；同一种类占位符要去重（否则一个头里两个 `{{MAO_TOKEN}}` 会签出两个不同 token，替换后两处值不一致，目标服务会看到自相矛盾的凭据）。

### 8.10 文档主位置（已补入 §5.4）
方案只提 `config.md`，但 `config.md` 是环境变量手册、没有哨兵功能章节；占位符是用户侧功能，主文档应是 `skills/mao-cli/reference/signal-watcher.md`（核心规则表 + 排障）。另 mao-cli 的 `parseHeaders` 未同步该校验，CLI 用户要多付一次请求往返才拿到 `PARAM_INVALID`。
