# mao-cli「用量成本核算与预算管控」第 3 轮 Code Review（CLI 侧）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/usage-cost-budget`（分支 `feat/usage-cost-budget`，提交 `43f8551f`）
- 审查范围（功能性 bug）：
  - `skills/mao-cli/lib/commands/budget.js`（新增 `mao budget list|create|update|delete`）
  - `skills/mao-cli/lib/commands/model.js`（新增 `--price-input` / `--price-output` 与 `modelPrice()` 校验）
  - `skills/mao-cli/lib/cli.js`（budget 模块注册与帮助文本）
  - 文档一致性：`skills/mao-cli/reference/{budget,model,analytics,inbox,settings,llm-call,admin,desktop,project}.md`、`skills/mao-cli/SKILL.md`、`skills/mao-cli/package.json`
- 对照的后端事实：`backend-ts/src/budget/budget.{routes,service,repository}.ts`、`backend-ts/src/model/model.{routes,service}.ts`、`backend-ts/src/admin/admin-analytics.service.ts`、`backend-ts/src/inbox/{types.ts,inbox.service.ts}`、`shared/contracts/src/inbox.ts`、`backend-ts/db/migration/V136__usage_budget.sql`
- 审查方法（只读，未改任何代码；探针在 `/tmp`）：
  1. 本地起 HTTP 桩服务（`/tmp/mao-stub.cjs`）打印 method/url/body，用真实 CLI 回放 `budget` / `model` 全部子命令与边界输入（`node bin/mao-cli.js ... --base-url http://127.0.0.1:9911`；`model create/update` 因 `cli.js` 的 `reserveBaseUrl` 走 `MAO_BASE_URL` 指向桩）。
  2. 用真实后端源码驱动 `BudgetService.update()`（`/tmp/budget-probe.mts`，`backend-ts/node_modules/.bin/tsx`），按 `budget.routes.ts` PUT 的 `body.x ?? default` 口径重放 CLI 实际发出的请求体，验证后端是否接受。
  3. 逐一比对 CLI 校验（`normalizeLimitValue` / `modelPrice`）与后端 `validate()` / `normalizePrice()` 的语义；核对文档字段名、单位口径（微单位 vs 成本单位）与后端返回。
- 结论：发现 1 个高危功能性 bug（`budget update` 全部请求必然失败）+ 5 个低危问题（3 个 CLI 边界/单位陷阱、2 个文档与实现不符）。

---

## Bug 1（高危）：`budget update` 只发送变更字段，而后端 PUT 是全量替换 → 任何部分更新都必然 400 失败，文档示例全部不可用

**文件:行号**

- `skills/mao-cli/lib/commands/budget.js:114-139`（尤其 `116` `const body = {}`、`121-128`、`133-135`）
- 文档示例：`skills/mao-cli/reference/budget.md:87-105`（`mao budget update --id 1 --action WARN --enabled 0`、`mao budget update --id 1 --limit-type COST --limit-value 800`）
- 后端契约：`backend-ts/src/budget/budget.routes.ts:41-53`（PUT 把缺失字段一律 `?? '' / null / 0` 后交给 service）、`backend-ts/src/budget/budget.service.ts:232-252`（`update()` 调 `validate()`，`scope` 非 GLOBAL/USER/AGENT 即抛 `PARAM_INVALID`）
- admin 对照（说明后端就是全量替换语义）：`admin/src/views/budget/BudgetView.vue:275-287`（`buildPayload()` 总是发全字段）

**问题描述（最小复现）**

后端 PUT 是**全量替换**：`budget.routes.ts:45-51` 对每个字段做 `body.scope ?? ''`、`body.scopeId ?? null`、`body.limitType ?? ''`、`body.limitValue ?? 0`、`body.action ?? ''`，随后 `validate()`（`budget.service.ts:279-302`）要求 `scope/limitType/action` 在枚举内、`limitValue` 为正整数。CLI 的 `update` 却只把用户显式传入的字段放进 body（`budget.js:116-132`），未传的一个都不带。

实跑证据（本地打印请求体 + 后端 service 直放）：

```
# 1) CLI 实际发出的请求体（桩服务抓包）
mao budget update --id 3 --enabled 0        → PUT /api/v1/admin/budgets/3  body={"enabled":0}
mao budget update --id 3 --limit-value 100  → PUT /api/v1/admin/budgets/3  body={"limitValue":100}
mao budget update --id 3 --limit-type COST --limit-value 55 → body={"limitType":"COST","limitValue":55000000}
mao budget update --id 3 --scope USER --scope-id 5 --limit-type COST --limit-value 100 --action BLOCK --enabled 1
                                             → body={...全字段...}
mao budget delete --id 3                    → DELETE /api/v1/admin/budgets/3

# 2) 用真实 BudgetService 重放上述 body（先 findById 到既有行，再走 routes 的 ?? 默认值）
PUT partial: --limit-value only            => REJECTED: scope 只能是 GLOBAL / USER / AGENT
PUT partial: --enabled 0 only              => REJECTED: scope 只能是 GLOBAL / USER / AGENT
PUT partial: --limit-type + --limit-value  => REJECTED: scope 只能是 GLOBAL / USER / AGENT
PUT partial create-missing-action          => REJECTED: action 只能是 WARN / BLOCK
PUT full payload                           => OK
```

即：**只有一次传齐 `--scope [--scope-id] --limit-type --limit-value --action`（+可选 `--enabled`）才会成功**；`budget.js:133-135` 的「至少一个字段即可」校验、以及 HELP/文档把全部参数标为可选（`[...]`），与后端契约直接矛盾。

**业务影响**

- 文档里给出的两个 `update` 示例（`--id 1 --action WARN --enabled 0`、`--id 1 --limit-type COST --limit-value 800`）在真实后端上必然返回 `scope 只能是 GLOBAL / USER / AGENT`（HTTP 200 + 业务错误码），用户按文档操作 100% 失败。
- 最常见的运维动作全部不可用：停用/启用某条预算（`--enabled 0/1`）、只调上限、只改动作。用户必须先从 `budget list` 肉眼读出该行全部字段再原样回传，CLI 未提供任何提示或合并逻辑。
- 报错信息（"scope 只能是 GLOBAL/USER/AGENT"）与用户实际操作（我只改 enabled）完全对不上，排障成本高。

**严重度**：高（功能不可用，且是文档首推用法）

**修复方向（未改代码，仅建议）**

`update` 前先 `GET /admin/budgets`（`budget list` 已实现）按 `--id` 取到既有行，把用户显式传入的字段 merge 进全量 body 再 PUT（与 admin `buildPayload`/`toggleEnabled` 同口径）。这也顺带消除 Bug 2 的口径降级问题（merge 后可直接沿用既有行的 `limitType`）。

---

## Bug 2（低）：`budget update --limit-value` 不带 `--limit-type` 时静默按 TOKENS 口径换算，成本上限会被悄悄缩小 100 万倍

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:126-127`；文档说明 `skills/mao-cli/reference/budget.md:91`

**问题描述（最小复现）**

现有预算为 `USER 7 / COST / 上限 100`（`limitValue=100000000` 微单位）。用户想上调到 200 成本单位：

```
mao budget update --id 1 --limit-value 200
# body={"limitValue":200}  →（Bug 1 修好后）limitType 若沿用 TOKENS 换算，200 被当作 200 token，
# 相对原 100000000 微单位（=100 成本单位）等于上限被降到 ~0.0002 成本单位
```

CLI 无法知道该行当前的 `limitType`（`GET /admin/budgets` 只返回列表，无按 id 查询），于是用 `limitType ?? 'TOKENS'` 兜底，且不报错。

**业务影响**：用户误把成本单位数值填成 token 数时没有任何提示，预算上限静默改变数量级；WARN 预算表现为"立刻越线刷提醒"，BLOCK 预算表现为"立刻开始拦新任务"。

**严重度**：低（文档 `budget.md:91` 已明确建议两参数一起给；但"建议"不是防护，且与 Bug 1 并存时用户必须先拼全字段，很容易漏 `--limit-type`）。若按 Bug 1 建议改为"先拉既有行再 merge"，此风险自然消失。

---

## Bug 3（低）：TOKENS 口径 `--limit-value` 无上限保护，超出 BIGINT 的值会 500 而非可读报错

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:43-59`（`LIMIT_MAX_COST` 只约束 COST）；列定义 `backend-ts/db/migration/V136__usage_budget.sql:10`（`limit_value BIGINT`）

**问题描述（最小复现）**

```
mao budget create --scope GLOBAL --limit-type TOKENS --limit-value 9999999999999999999 --action WARN
# CLI 校验通过（Number.isInteger(1e19) 为真），实际发出 body={"limitValue":10000000000000000000}
# 后端 validate() 同样放行（正整数），写入 BIGINT 触发 MySQL 1264 out-of-range
# → handleError 走 500 INTERNAL_ERROR（backend-ts/src/common/http-error.ts:81-82），用户看到"内部错误"
```

另外 > 2^53 的 token 数在 JSON 往返中已丢精度（`--limit-value 9007199254740993` 实际提交 9007199254740992）。

**业务影响**：误输入超大 token 预算时得到无信息量的 500，而不是"超出允许范围"的可读错误。COST 侧已有 `LIMIT_MAX_COST` 保护，两侧不一致。

**严重度**：低（正常运维不会输入 9e18 token）。

---

## Bug 4（低）：COST 口径 `--limit-value` 对超过 6 位小数静默四舍五入，而 HELP/文档声明"最多 6 位小数"

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:28`（HELP 文案）、`:52-54`（`Math.round(value * 1000000)`）、`:50`；`skills/mao-cli/reference/budget.md:69`

**问题描述（最小复现）**

```
mao budget create --scope GLOBAL --limit-type COST --limit-value 1.0000005 --action WARN
# 预期（按 HELP/文档"最多 6 位小数"）：拒绝
# 实际：无报错，body={"limitValue":1000001}（= 1.000001 成本单位，用户输入被悄悄进位）
mao budget create --scope GLOBAL --limit-type COST --limit-value 0.0000004 --action WARN
# 实际：报"换算后不是正整数"（Math.round(0.4)=0）
```

对照：`model.js:39-41` 的价格校验对 >6 位小数是显式拒绝（与后端 `normalizePrice` 同语义），budget 侧却是静默取整，同一 CLI 内两种口径。

**业务影响**：亚微（<1e-6 成本单位）级别的取整，数值影响可忽略；但 HELP/文档把它写成约束条件而非"会被取整"，属文档与实现不一致（用户以为超精度会被拒，实际被改数）。

**严重度**：低。

---

## Bug 5（低，文档与实现不符）：`budget.md` 列的 BLOCK 准入点含不存在的"打开已有会话的任务"，漏掉实际存在的开放 API/Webhook 触发

**文件:行号**：`skills/mao-cli/reference/budget.md:27`

**问题描述**

文档称 5 个准入点为"WebSocket 手动发送、消息编辑重发、排队消息自动消费、打开已有会话的任务、定时任务直接执行"。实际 `checkAdmission` 调用点共 5 处，但集合不同：

- WS：`backend-ts/src/session/ws/streaming-ws-handler.ts:501`（`handleSendMessage` 手动发送）、`:850`（`handleEditAndResend` 编辑重发）、`:1714`（`autoConsumeQueue` 排队消费）
- 定时任务直跑：`backend-ts/src/create-app.ts:1309-1312`（`scheduledService.setBudgetCheck`）
- 开放 API/Webhook 触发：`backend-ts/src/create-app.ts:1325-1329` → `backend-ts/src/openapi/open-run.service.ts:92-93`

WS 事件表（`streaming-ws-handler.ts:360-379`）没有任何"打开已有会话的任务"入口；`subscribe`（打开会话）不做预算判定。`SKILL.md:54` 反而正确写了"预算判定同样作用于这两类来源"。

**业务影响**：用户会误以为"打开已有会话继续任务"会被拦（实际不会），并误以为开放 API/Webhook 触发不受预算管控（实际会拦）。运维配 BLOCK 时的覆盖面判断错误。

**严重度**：低（仅文档）。

---

## Bug 6（低，文档与实现不符）：`admin.md` 称预算页侧边栏在「能力」分组，实际在「运行」分组

**文件:行号**：`skills/mao-cli/reference/admin.md:151`；实现 `admin/src/components/SideMenu.vue:125`（`id: 'runtime'` / `label: '运行'`，与 analytics/llm-calls 同组）

**问题描述**：文档写"侧边栏位于「能力」分组"，而 SideMenu 把「用量预算」放在「运行」分组下（`budget:read` 权限控制显隐）。

**业务影响**：按文档去「能力」分组找不到入口，误以为页面没部署/没权限。

**严重度**：低（仅文档）。

---

## 已验证无问题的点（覆盖清单）

- **请求路径/方法**：`GET|POST /api/v1/admin/budgets`、`PUT|DELETE /api/v1/admin/budgets/{id}`（桩服务实测 URL 与后端路由完全一致）；`POST|PUT /api/v1/models[/{id}]`、`PATCH /models/{id}/status`、`POST /models/{id}/test`。
- **字段名逐一对应**：budget body `scope/scopeId/limitType/limitValue/action/enabled` ↔ `budget.routes.ts` 的 `BudgetUpsertRequest`；model body `priceInput/priceOutput` ↔ `model.routes.ts` 的 `CreateModelRequest`（均为 camelCase，实测桩抓包确认）。
- **`--enabled 0`**：`args.js:30-36` 把 `--enabled 0` 解析为字符串 `'0'`（不是布尔 true），`getBool01`（`args.js:166-174`）返回数字 `0`，body 实测为 `"enabled":0`；后端归一 `Number(0) ? 1 : 0` = 0（`budget.service.ts:303`），停用语义正确。`--enabled 1/true` 亦实测为 `1`。
- **COST 单位换算与 admin 口径一致**：`Math.round(value * 1e6)`（`budget.js:53`）与 `BudgetView.vue:281-283` 的 `Math.round((limitInput ?? 0) * 1000000)` 完全同式；实测 `100→100000000`、`0.000001→1`、`999999.999999→999999999999`（BIGINT 范围内）；浮点偏差经 `Math.round` 吸收（如 `1.000001*1e6=1000000.9999999999→1000001`）。不会因浮点产生 0（`0.0000004` 有显式报错）。
- **TOKENS 原值取整**：`Math.round(value)`，`1000.5→1001`（`budget.js:54`）。
- **`modelPrice` 与后端 `normalizePrice` 同语义**：实测 `--price-input 0` 通过（免费，与"不计成本"的 null 可区分，`pickDefined` 不会丢 0）、`999999.999999` 通过、`1000000`/`999999.9999995` 拒绝、`1e-7`/`0.0000004`/`0.1234567` 按"最多 6 位小数"拒绝（与 `model.service.ts:75` 的 `Number(value.toFixed(6)) !== value` 判据一致）、`abc` 报"必须是数字"；`model update` 走 `pickDefined` 部分字段，PUT 后端 `updateModel` 对 `undefined` 是"保留"，部分更新语义正确（与 budget 相反）。
- **`cli.js` 注册与帮助**：`budget` 已加入 `MODULES`（`cli.js:155`）并出现在「管理端模块」帮助（`cli.js:79`）；`mao budget --help` / 未知子命令均正常输出 HELP。
- **`package.json` files 列表**：`bin/ lib/ SKILL.md business_process.md reference/` 为目录级包含，`lib/commands/budget.js` 与 `reference/budget.md` 自动被打包，无需改动。
- **文档单位口径自洽**：`budget.md:46-48`（list 返回 `limitValue` 微单位 / `periodSpend` COST 已是成本单位，且警告了直接相除会小 1e6 倍）与 `budget.repository.ts:22-27`、`budget.service.ts:204-205` 一致；`analytics.md:37`（`cost/totalCost` 为成本单位、`COALESCE(SUM(cost_micros),0)/1e6`）与 `admin-analytics.service.ts:344,425,452` 一致；`llm-call.md:42`（`costMicros` 微单位、null/0 语义、管理后台成本列为 `costMicros/1e6`）一致；`inbox.md` 七类 kind、`budgetWarnEnabled` 默认开、TRIGGER_DISABLED 始终写入，与 `shared/contracts/src/inbox.ts`、`inbox/types.ts`、`inbox.service.ts:54-62,355-371` 一致；`settings.md` 的 `compaction.modelId` 与 `V136` 种子、`compaction-model-resolver.ts` 一致；`model.md:153-158` 价格规则（含"CLI 只能设价不能清空"）与 `updateModel` 的 `undefined=保留 / null=清空` 语义一致；`desktop.md` 预算提醒条目不跳会话、徽标与 `InboxDrawer.vue:33,83-95`、`inbox.service.ts:183`（`sessionId: null`）一致。

## 非缺陷观察（不要求改）

- `--limit-value -5` 这类负值因 `args.js:30` 把 `-5` 当 flag 前缀，最终报"缺少必填参数 --limit-value"而非"必须是正数"——属 `parseArgs` 全 CLI 既有行为，且仍以错误退出，不产生错误数据。
- `budget create --scope USER` 漏 `--scope-id` 时不前置校验，由后端返回"USER / AGENT 预算必须指定目标 id"，文案可读，可接受。
