# 2026-10-21 当日提交代码审查

- 审查范围：`704aa516` → `852276f8`，共 14 个提交（仅代码，忽略文档变更）
- 重点提交：`852276f8`（自定义 HTTP 工具改为管理员配置 + Agent 关联）、`2b16bdc1`（移除团队共享）、`1182c459`（Agent 客户端可见）、`3abd268e`（飞书等待期刷新）、`4f3d2bbd`/`b2ff57ed`/`08183af7`（公共共享目录）、`fe8162c8`/`adc68998`/`289c6f5a`（进度列表）、`704aa516`（子代理上下文徽标）、`d3f6895f`（移除输入栏 Agent 徽标）
- 结论：确认 **6 个功能/安全问题**（3 中、3 低），均已用临时测试复现；测试文件验证后已删除，生产代码未改动。

## 汇总

| # | 严重度 | 问题 | 位置 |
|---|---|---|---|
| 1 | 中 | 加密密钥环境变量改名，旧 `APP_USER_TOOL_SECRET` 被静默忽略且不再从子进程剥离 | `config/app-config.ts`、`common/sensitive-env.ts` |
| 2 | 中 | 工具被删除/停用后，关联 Agent 的任何编辑都会被校验器拒绝 | `agent/agent.routes.ts`、`http-tool/http-tool-validator.ts` |
| 3 | 中 | 后台「敏感」勾选不参与提交与加密，非命中关键字的请求头明文落库并回显 | `admin/.../HttpToolListView.vue`、`http-tool-admin.routes.ts` |
| 4 | 低 | `httpToolIds` 缺运行时类型校验：非数组 500，字符串 id 静默丢关联 | `agent/agent.routes.ts`、`http-tool/types.ts` |
| 5 | 低 | 进度列表自动跟随的两个边界：超高任务项顶部被滚出视野；文件/Git 页签隐藏期间不跟随 | `desktop/.../TodoChecklist.vue`、`TaskInspector.vue` |
| 6 | 低 | Agent 列表搜索只命中隐藏 Agent 时误报「当前没有客户端可见的 Agent」 | `admin/.../AgentListView.vue` |

验证基线（改动的生产代码未做任何修改）：

- `backend-ts`：`npm run build` exit 0；`npm test` → `373 passed | 1 skipped`，`4527 passed | 14 skipped`
- `desktop`：`npm run build` exit 0；`npm run test:unit` → `76 files / 682 tests` 通过
- `admin`：`npm run build` exit 0；`npm test` → `6 files / 53 tests` 通过

---

## Bug 1【中】`APP_USER_TOOL_SECRET` 被改名，旧部署配置被静默忽略并失去子进程剥离开关

**位置**

- `backend-ts/src/config/app-config.ts:137-139,270-272,530-532`（只读取 `APP_HTTP_TOOL_SECRET`，默认密钥 `mao-http-tool-default-secret-change-me`）
- `backend-ts/src/common/sensitive-env.ts:13`（敏感键从 `APP_USER_TOOL_SECRET` 改成 `APP_HTTP_TOOL_SECRET`）
- 设计依据：`docs/plan/2026-10-21-custom-http-tools-agent-scoped-technical-design.md:338` 明确要求「环境变量 `APP_USER_TOOL_SECRET` **不改名**（部署配置兼容）」
- 现状文档也仍写旧名：`skills/mao-cli/reference/http-tool.md:21`、`DEPLOY.md:23`

**问题描述**

本次域重命名把加密密钥环境变量一并改成了 `APP_HTTP_TOOL_SECRET`，但设计明确要求保留旧名。线上若继续按运维文档配置 `APP_USER_TOOL_SECRET`：

1. `loadConfig()` 完全忽略旧变量，`cfg.app.httpTool.secretKey` 回退到源码中的硬编码默认值；
2. 新保存的工具敏感请求头将用默认密钥加密（V166 已重建表，不会立刻解密失败，但密钥强度/轮换假设被破坏）；
3. `isSensitiveChildEnvKey('APP_USER_TOOL_SECRET')` 变为 `false`，`sanitizeInheritedEnv(process.env)` 会把这个旧主密钥透传给 Agent shell / 云端终端子进程（`shell-session-manager.ts:732`、`terminal-manager.ts:400`），造成密钥泄露。

**触发场景**

已有部署的 `.env` / systemd 环境只配置 `APP_USER_TOOL_SECRET=...`，升级到本版本后新建/编辑自定义 HTTP 工具。

**验证测试**

`backend-ts/src/__review_today.spec.ts`（验证后删除）：

```ts
it('keeps honouring APP_USER_TOOL_SECRET (design §5.12 says the name must not change)', async () => {
  process.env.APP_USER_TOOL_SECRET = 'legacy-ops-secret'
  delete process.env.APP_HTTP_TOOL_SECRET
  vi.resetModules()
  const { loadConfig, resetConfigCache } = await import('./config/app-config.js')
  resetConfigCache()
  const cfg = loadConfig()
  expect(cfg.app.httpTool.secretKey).toBe('legacy-ops-secret')
  expect(isSensitiveChildEnvKey('APP_USER_TOOL_SECRET')).toBe(true)
})
```

```text
$ cd backend-ts && npx vitest run src/__review_today.spec.ts
× keeps honouring APP_USER_TOOL_SECRET
  → expected 'mao-http-tool-default-secret-change-me' to be 'legacy-ops-secret'
Tests  5 failed | 1 passed (6)
```

**修复建议**

- `loadConfig()` 兼容读取：优先 `APP_HTTP_TOOL_SECRET`，否则回退 `APP_USER_TOOL_SECRET`；或按设计保持旧名只读旧名。
- `isSensitiveChildEnvKey` 同时把旧名列为敏感键，避免升级窗口期泄露。

---

## Bug 2【中】工具被停用/删除后，关联 Agent 的任何编辑都会被拒绝

**位置**

- `backend-ts/src/agent/agent.routes.ts:133-152`（PUT 入口）、`:252-264`（`resolveHttpToolIds`）
- `backend-ts/src/http-tool/http-tool-validator.ts:25-44`（停用 / 不存在直接抛业务错误）
- `backend-ts/src/agent/agent.routes.ts:306-309`（`toVO` 把残留 id 原样回显）
- `backend-ts/src/agent/agent.service.ts:141-145`（落库）

**问题描述**

「停用工具不允许**新**关联」是设计；问题在**存量关联**：

1. 管理员把工具关联给 Agent；
2. 之后该工具被停用或删除，`agent.http_tool_ids` 不会清理（设计 §5.1 / §8.7 明确允许残留，装配时「查不到即跳过、不报错」）；
3. `GET /v1/agents/:id` 的 `toVO` 仍返回残留 id，编辑表单回显并随全量提交；
4. `resolveHttpToolIds` 逐个调用校验器，遇到停用/不存在立即抛 `PARAM_INVALID`，整次 PUT 失败，`updateAgent` 根本没被调用。

结果：管理员无法修改该 Agent 的名称、提示词、模型、MCP、客户端可见性等任何字段，除非先手动清空全部自定义工具关联（删除工具时表单里只剩一个无意义的数字 tag）。这与设计「失效关联不报错」的意图冲突。接口 HTTP 状态仍是 200，业务码为 `2001`，前端表现为保存失败的错误提示。

**触发场景**

Agent 已关联工具 id=3 → 管理员在「自定义工具」页停用或删除该工具 → 打开 Agent 编辑只改名称并保存。

**验证测试**

使用真实 `registerAgentRoutes` + 真实 `HttpToolValidatorImpl`（fake lookup），断言 PUT 应成功：

```ts
const agent = { id: 1, name: 'A', systemPrompt: 'p', isDefault: 0, httpToolIds: '[3]' }
const lookup = { findById: async (id: number) => ({ id, name: 'orders', enabled: 0 }) } // 删除场景返回 null
const res = await app.inject({
  method: 'PUT', url: '/v1/agents/1',
  payload: { name: 'A2', httpToolIds: [3] },
})
expect(res.json().code).toBe(0)
expect(agentService.updateAgent).toHaveBeenCalled()
```

```text
$ cd backend-ts && npx vitest run src/__review_today.spec.ts
× allows editing the agent when the associated tool was disabled
  → 自定义 HTTP 工具「orders」已停用，无法关联: expected 2001 to be +0
× allows editing the agent when the associated tool was deleted
  → 自定义 HTTP 工具不存在（id=3）: expected 2001 to be +0
```

对照：同一请求传 `httpToolIds: []` 可以成功（清空语义正常），说明失败点仅是残留 id 校验。

**修复建议（任选其一）**

- 删除工具时清理所有 Agent 的 `http_tool_ids`（JSON 数组移除该 id）；停用工具时管理端表单过滤掉不可用 id，保存时自动剔除而不是报错。
- 或校验器对「已存在但已停用/已删除」的 id 宽容跳过（与装配口径一致），仅对真正非法的 id 报错。

---

## Bug 3【中】管理后台「敏感」勾选不生效：非命中关键字的请求头明文落库并回显

**位置**

- `admin/src/views/http-tool/HttpToolListView.vue:192`（文案：「勾选「敏感」的值加密存储、保存后不再回显」）
- `admin/src/views/http-tool/HttpToolListView.vue:568-573`（`toPayload` 只提交 `{key,value}`，丢弃 `sensitive`）
- `backend-ts/src/http-tool/http-tool-admin.routes.ts:148-169`（`toHeadersInput` 只取 key/value）
- `backend-ts/src/http-tool/types.ts:33`（敏感判定实际只看键名正则 `token|secret|key|authorization|cookie`）

**问题描述**

新管理页把旧桌面编辑器的「敏感」勾选一起搬了过来，并明确承诺「勾选即加密、保存后不再回显」。但勾选状态既没有提交到后端，后端也只按 key 关键词决定是否加密。因此：

- 管理员给 `X-Credential`、`X-Sign`、`X-Auth` 这类不命中关键词的头勾选「敏感」后，值仍以明文写入 `http_tool.headers_json`；
- 重新打开编辑页时该值原样回显，列表 VO 的 `sensitive` 也是 `false`；
- 只有键名恰好包含 token/secret/key/authorization/cookie 时才加密（此时勾不勾选都一样）。

这既是安全承诺落空（管理员以为已加密），也是控件完全无效的功能缺陷。设计 §5.1 的加密口径是「按 key 名敏感词」，因此更可能需要修前端（去掉勾选或改成只读标识），或扩展接口接收 `sensitive` 标记。

**触发场景**

新建工具 → 添加请求头 `X-Credential: top-secret` → 勾选「敏感」→ 保存 → 再次编辑，值以明文显示。

**验证测试**

service 层复现（模拟 UI 勾选后的语义）：

```ts
const vo = await service.create({
  name: 'credential_tool', displayName: '凭据工具', description: '测试',
  method: 'GET', url: 'https://api.example.com/x',
  headers: { 'X-Credential': 'top-secret' },
})
// 期望：按 UI 文案打码 + 密文落库
expect(vo.headers).toEqual([{ key: 'X-Credential', value: '******', sensitive: true }])
expect(repo.tools[0].headersJson).not.toContain('top-secret')
```

```text
$ cd backend-ts && npx vitest run src/__review_today.spec.ts
× does not encrypt a header explicitly marked sensitive when the key misses the heuristic
-   "sensitive": true,  "value": "******"
+   "sensitive": false, "value": "top-secret"
```

**修复建议**

- 让 `toPayload` 提交 `sensitive`，路由/服务以「显式标记 **或** 键名命中」作为加密条件；或
- 明确按设计只支持键名启发式：把勾选框改为只读「敏感/普通」标识，并修正提示文案，避免误导。

---

## Bug 4【低】`httpToolIds` 缺运行时类型校验：非数组 500，字符串 id 会静默丢关联

**位置**

- `backend-ts/src/agent/agent.routes.ts:252-264`（`resolveHttpToolIds` 只判空数组与 null）
- `backend-ts/src/http-tool/http-tool-validator.ts:25-44`（直接 `for...of` / `result.push(id)`，无整数校验）
- `backend-ts/src/http-tool/types.ts:258-268`（`parseHttpToolIds` 用 `Number.isInteger` 过滤）

**问题描述**

`httpToolIds: number[]` 只存在于 TS 类型层，运行时没有任何校验：

1. `httpToolIds: 3`（数字）→ `3.length` 为 `undefined`，进入 `validateForAgent(3)` 后 `for...of` 抛 `TypeError`，最终 HTTP 500「服务内部错误」；
2. `httpToolIds: ["3"]`（字符串 id）→ 校验器 `findById("3")` 被 MySQL 隐式转成数字并查到工具，返回 `["3"]`，落库为 `["3"]`；运行时 `parseHttpToolIds` 又用 `Number.isInteger` 把字符串全部过滤掉，Agent 关联**静默变空**（目录/可调用集合都没有工具，且没有任何错误提示）。

第二种更隐蔽：接口返回成功、管理端显示关联成功，但会话里工具不可见。

**触发场景**

通过 REST/CLI/脚本创建或更新 Agent 时，`httpToolIds` 传成数字或字符串数组（例如外部系统 JSON 序列化差异）。

**验证测试**

```ts
// 非数组：期望业务错误（HTTP 200 + code≠0），实际 500
const res = await app.inject({ method: 'PUT', url: '/v1/agents/1', payload: { name: 'B', httpToolIds: 3 } })
// 字符串数组：落库保留字符串，运行时被过滤为空
await app.inject({ method: 'PUT', url: '/v1/agents/1', payload: { name: 'B', httpToolIds: ['3'] } })
const stored = agentService.updateAgent.mock.calls.at(-1)?.at(7)
expect(stored).toEqual(['3'])
expect(parseHttpToolIds({ httpToolIds: JSON.stringify(stored) })).toEqual([])
```

```text
$ cd backend-ts && npx vitest run src/__review_today.spec.ts
× rejects a non-array httpToolIds with a business error instead of 500
  → expected 500 to be 200
✓ silently drops string ids at runtime after accepting them      # 现状行为被固定：["3"] 落库后解析为 []
```

**修复建议**

在 `resolveHttpToolIds` 入口统一校验：`Array.isArray` + 每项 `Number.isSafeInteger(id) && id > 0`，非法输入抛 `PARAM_INVALID`；不要依赖 MySQL 隐式类型转换。

---

## Bug 5【低】进度列表自动跟随的两个边界缺陷

### 5a. 单个任务高于列表可视高度时，顶部被滚出视野

**位置**：`desktop/src/components/task/TodoChecklist.vue:78-86`

```ts
el.scrollTop += itemRect.top - listRect.top - (el.clientHeight - itemRect.height) / 2
```

**问题**：居中公式假设焦点项高度小于视口。`289c6f5a` 让任务名换行完整展示后，单项高度可以超过 `max-height: 172px`（`session_todo.content` 最长 1024 字符，窄侧栏下可达几十行）。此时 `(clientHeight - itemHeight) / 2` 为负，滚动量反而把该项顶部推到可视区上方，用户只看到任务名中段，看不到开头。

**验证测试**（`desktop/src/__review_todo_scroll.test.ts`，验证后删除；沿用仓库既有 `task-inspector-context-race.test.ts` 的 client-render + 桩布局范式）：

```ts
const todos = reactive(Array.from({ length: 6 }, (_, i) => ({
  id: i + 1, content: `任务 ${i + 1}`, status: 'pending',
})))
// ...挂载后给列表桩 clientHeight=172、scrollHeight=1000，
// 第 6 项 rect={ top:150, height:300 }（高于视口），再把它置为 in_progress
todos[5].status = 'in_progress'
await flush()
expect(list.scrollTop).toBeLessThanOrEqual(150) // 焦点项原顶部 150，不能被滚过头
```

```text
$ cd desktop && npx vitest run src/__review_todo_scroll.test.ts
× keeps the beginning of a focus item taller than the viewport visible
  → expected 214 to be less than or equal to 150
```

实际 `scrollTop=214`，焦点项顶部变为 `150-214=-64`，前 64px 被隐藏。

**修复建议**：单项高度大于视口时改为顶部对齐：`el.scrollTop += itemRect.top - listRect.top`（或对居中偏移取 `Math.max(0, ...)`）。

### 5b. 列表在「文件 / Git」页签隐藏期间推进，切回后不跟随

**位置**

- `desktop/src/components/task/TodoChecklist.vue:100-102`（只在 `focusIndex` 变化和 mount 时调用 `revealFocus`）
- `desktop/src/components/task/TaskInspector.vue:32`（「任务」页签用 `v-show` 隐藏，`TodoChecklist` 仍挂载）

**问题**：`display:none` 时 `clientHeight/scrollHeight` 为 0，`revealFocus` 计算结果为 0、`hasMoreBelow` 也被置 false；切回任务页签时没有任何可见性监听触发重算，列表停留在旧位置，当前任务在视野外，底部渐隐也消失。用户只是去文件/Git 页签看了一眼，回来就失去自动跟随。

**验证测试**（`admin/src/__review_todo_hidden.spec.ts`，验证后删除；admin 是 happy-dom 环境，通过 `createApp` 挂载 desktop SFC）：

```ts
// 隐藏态：布局尺寸为 0
define(list, 'clientHeight', 0); define(list, 'scrollHeight', 0)
todos[5].status = 'in_progress'   // 隐藏期间推进到第 6 项
await flush()
// 切回任务页签：恢复可见尺寸，焦点项在 150~180，超出 172 视口
define(list, 'clientHeight', 172); define(list, 'scrollHeight', 400)
await flush()
expect(scrollTop).toBeGreaterThan(0)
```

```text
$ cd admin && npx vitest run src/__review_todo_hidden.spec.ts
× follows the focus item after the list becomes visible again
  → expected 0 to be greater than 0
```

**修复建议**：在页签激活时（`TaskInspector` 监听 `inspectorActiveTab` 变为 `workspace`）`nextTick` 调用一次跟随 + 渐隐重算；或用 `ResizeObserver` 在列表尺寸从 0 变正时重算。

---

## Bug 6【低】Agent 列表搜索只命中隐藏 Agent 时误报「当前没有客户端可见的 Agent」

**位置**

- `admin/src/views/agent/AgentListView.vue:297-300`

```ts
/** 全量视角（不受搜索/状态筛选影响）：全部 Agent 都被设为客户端不可见时给出提示。 */
const allClientHidden = computed(
  () => allAgents.value.length > 0 && allAgents.value.every(agent => agent.clientVisible === false),
)
```

- `admin/src/views/agent/AgentListView.vue:303-311`：`fetchAgents()` 把 `keyword: searchQuery.value` 传给 `/agents`，`allAgents` 实际是**搜索过滤后**的集合。

**问题**：注释声称「不受搜索筛选影响」，但数据源已被 keyword 过滤。管理员搜索一个「仅管理端」Agent 时，返回列表只含隐藏项，`every(...)` 为真，页面错误弹出「当前没有客户端可见的 Agent」——而全局其实仍有可见 Agent。会误导管理员去改错配置。

**验证测试**（`admin/src/__review_agent_list_alert.spec.ts`，验证后删除；mock `/agents` 按 keyword 过滤）：

```ts
// 全局：[默认助手(可见), 代码助手(隐藏)]
// 搜索「代码」后接口只返回隐藏项
const alerts = document.querySelectorAll('.client-hidden-alert')
expect(alerts.length).toBe(0)
```

```text
$ cd admin && npx vitest run src/__review_agent_list_alert.spec.ts
× does not warn when the global list still contains a client-visible agent
  → expected 1 to be +0
```

**修复建议**：为可见性统计维护独立的全量数据（如不带 keyword 的请求结果，或后端返回 `visibleCount`），不要复用搜索过滤后的 `allAgents`。

---

## 其他观察（不计入本次引入的 bug）

1. **跨源重定向转发凭据（存量）**：`http-api-executor.ts` 复用同一份 headers 跟随 301/302/307/308，未在跨 origin 时剥离 `Authorization` / `Cookie`。该文件本次仅类型改名，问题不是今天引入的，但建议单独排期修复。
2. **共享目录的 `send_file` / `edit_image` 在 host 模式不可用（边界）**：`DockerSendBytesBridge.extraRoots()` 未包含 `shareDir`，host 模式降级到 `StrictPathResolver` 后拒绝共享目录路径，docker 模式则可用。设计 §1.2 只承诺 `read_file / glob_search / grep_search / shell`，故未计入 bug；若希望共享文件能直接发到飞书/钉钉，需要把 `shareDir` 接入 bridge。
3. **V166 直接 DROP `user_tool` / `user_tool_param`**：属于设计明确接受的数据丢失（§9），不作为 bug。

---

## 附：验证方式与清理

- 所有复现测试均为临时文件，运行后已删除：
  - `backend-ts/src/__review_today.spec.ts`
  - `desktop/src/__review_todo_scroll.test.ts`
  - `admin/src/__review_todo_hidden.spec.ts`
  - `admin/src/__review_agent_list_alert.spec.ts`
- 最终 `git status` 仅剩审查开始前已存在的未跟踪文档 `docs/plan/2026-10-21-agent-no-progress-guard-technical-design.md`。
- 未修改任何生产代码、配置、迁移或部署。
