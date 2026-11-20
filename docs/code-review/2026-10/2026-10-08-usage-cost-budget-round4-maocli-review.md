# mao-cli budget CLI — Round 4 复审（复验 Round 3 修复）

- 复审对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/usage-cost-budget`，分支 `feat/usage-cost-budget`，修复已提交为 `a2ce471f`
- 复验范围：`skills/mao-cli/lib/commands/budget.js`（update merge / limit-value 校验 / fetchRowById）、`skills/mao-cli/reference/{budget,admin}.md`；create/delete 回归
- 复验方法（只读，未改任何代码；临时探针在 `/tmp`，另用一个项目内探针文件跑完即删）：
  1. 忠实还原后端响应形状的本地桩服务（`/tmp/mao-stub2.cjs`）：`GET /api/v1/admin/budgets` 返回 `{code:0,message:'success',timestamp,data:[...行...]}`（与 `budget.routes.ts:23` `sendOk(reply, list())` + `common/result.ts` `ok(data)` 一致）。
  2. 另建一个返回 `data:{records:[...]}` 的桩（`/tmp/mao-stub3.cjs`），用于在"解包修对"的前提下单独检验 merge 逻辑本身。
  3. 项目内 tsx 探针直接 `app.inject` 打印 `GET /v1/admin/budgets` 的真实响应体（跑完删除探针文件）。
  4. 用真实 `BudgetService.update()`（tsx + mock repo）复放 CLI 实际发出的全部 body，验证后端是否接受。
- 结论：**Round 3 的 6 个问题修复方向全部正确，但 Bug 1 的修法引入 1 个高危回归（`budget update` 现在 100% 失败），另发现 2 个 merge 边界隐患（低危）。**

---

## Bug A（高危，Round 3 Bug 1 修复引入的回归）：`fetchRowById` 读 `result.data.records`，而预算列表接口的 `data` 直接就是数组 → 所有 `budget update` 必然失败

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:92-104`（关键行 `:95` `const rows = result?.data?.records;`）

**问题描述**

`GET /v1/admin/budgets` 的响应体是 `{code:0, message:'success', timestamp, data: <数组>}`——`budget.routes.ts:23` 是 `sendOk(reply, await deps.budgetService.list())`，`list()` 返回 `BudgetListItem[]`，经 `common/result.ts:6-14` 的 `ok(data)` 原样放进 `data`。**没有 `records` 包装**（`{records,total,page,size}` 是 `llm-call` / `analytics` 那批接口的形状，budget 是个例外）。admin 前端也是按数组消费的：`admin/src/views/budget/BudgetView.vue:230-232` `const { data } = await api.get('/admin/budgets'); rows.value = data || [];`。

实跑证据（三重）：

1. 项目内 tsx 探针直接 inject 真实路由打印响应体：

   ```
   status 200
   body {"code":0,"message":"success","timestamp":1791430461105,"data":[{"id":1,"scope":"GLOBAL","scopeId":null,"limitType":"COST","limitValue":100000000,"action":"WARN","enabled":1}]}
   ```

2. 用忠实桩（`data` = 数组）重放 7 组 update，**全部** exit=1：

   ```
   mao budget update --id 1 --enabled 1      → ERROR: 拉取预算列表失败：响应不含 records 数组
   mao budget update --id 2 --action BLOCK   → ERROR: 拉取预算列表失败：响应不含 records 数组
   mao budget update --id 3 --limit-value 300→ ERROR: 拉取预算列表失败：响应不含 records 数组
   mao budget update --id 3 --limit-type COST --limit-value 300 → 同上
   mao budget update --id 2 --scope GLOBAL   → 同上
   mao budget update --id 99 --enabled 1     → 同上
   mao budget update --id 2 --scope USER     → 同上
   ```

   （桩日志显示只发出了 `GET /api/v1/admin/budgets`，PUT 从未发出——在第一屏就失败了。）

3. 对照组：把桩改成 `data:{records:[...]}`（即修复代码期望的形状）后，同样的 7 组命令全部成功并发出合法全字段 PUT——说明 merge 逻辑本身是对的（见 Bug B/C 与附录），**唯一错的就是解包路径**。Round 3 复审说明里"已用本地桩服务实测 5 组部分更新全部合法"应是用 `records` 形状的桩得出的结论，与真实后端形状不一致。

**业务影响**：`mao budget update` 全部子用法（含文档示例）在真实后端上 100% 失败，报错停在"拉取预算列表失败"，连 PUT 都不会发。`create` / `delete` / `list` 不受影响（实测正常）。比 Round 3 的"部分更新失败"覆盖更全，但好在是显式报错而非静默错数据。

**修复方向（未改代码，仅建议）**：把 `:95` 改成同时容忍两种形状，或直接按后端事实取数组：

```js
const rows = Array.isArray(result?.data) ? result.data : result?.data?.records;
```

**严重度**：高（功能完全不可用）。

---

## Bug B（低）：改 `--limit-type` 而不带 `--limit-value` 时，旧口径的原始数值被跨单位带过去，后端照单全收

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:158`（`effectiveType = limitType ?? current.limitType`）、`:169-171`（`limitValueRaw === undefined ? current.limitValue : ...`）

**问题描述（最小复现，基于 `data:{records}` 桩的实测 body + 真实 `BudgetService.update` 验证）**

行 1 为 `GLOBAL / COST / limitValue=100000000`（= 100 成本单位）：

```
mao budget update --id 1 --limit-type TOKENS
→ PUT {"scope":"GLOBAL","scopeId":null,"limitType":"TOKENS","limitValue":100000000,"action":"WARN","enabled":0}
   # 100 成本单位的预算被改成 1 亿 token 的预算
```

反向同理：行 2 为 `USER / TOKENS / limitValue=20000000`：

```
mao budget update --id 2 --limit-type COST
→ PUT {"scope":"USER","scopeId":7,"limitType":"COST","limitValue":20000000,...}
   # 2000 万 token 变成 20 成本单位
```

两条 body 均通过真实 `BudgetService.update` 的 `validate()`（正整数），后端无感知地写入。

**业务影响**：用户切换预算口径但没同时重填上限时，上限数量级被静默改变（差 1e6 倍），WARN 预算表现为"立刻越线/永远不越线"，BLOCK 预算表现为"立刻开始拦/再也不拦"。这类错误在 `budget list` 上能看到数字，但用户不会想到是切换口径时丢的。

**修复方向（未改代码，仅建议）**：`--limit-type` 与既有行不同且未给 `--limit-value` 时，直接报错要求显式给新口径的上限（与 `limitType` 不可识别时的既有报错风格一致）。

**严重度**：低（需用户主动切口径却不填值；但一旦发生是静默错数据）。

---

## Bug C（低）：改 `--scope` 而不带 `--scope-id` 时，旧 scope 的目标 id 被带到新 scope，后端照单全收

**文件:行号**：`skills/mao-cli/lib/commands/budget.js:167`（`scopeId: effectiveScope === 'GLOBAL' ? null : (scopeId ?? current.scopeId ?? null)`）

**问题描述（最小复现，实测 body + 真实 service 验证）**

行 2 为 `USER / scopeId=7`：

```
mao budget update --id 2 --scope AGENT
→ PUT {"scope":"AGENT","scopeId":7,"limitType":"TOKENS","limitValue":20000000,"action":"WARN","enabled":0}
   # userId=7 被原样当成 agentId=7 提交；真实 BudgetService.update 验证：OK（后端无感知）
```

该预算会静默绑定到 Agent 7（很可能是另一个人/不存在的 Agent）：`list()` 里 `targetDeleted` 显示「已删除」，`checkAdmission` 因 `targetExists=false` 直接跳过——预算形同虚设，但不报任何错。

对照组（符合预期的路径）：`GLOBAL` 行不带 `--scope-id` 改 `--scope USER` 时，`current.scopeId` 为 null，下发 `scopeId:null`，真实 service 明确拒绝：`USER / AGENT 预算必须指定目标 id`——可读报错，这条是对的。即只有"非 GLOBAL → 另一个非 GLOBAL scope"这一格会静默串目标。

**业务影响**：切 scope 忘带 `--scope-id` 时预算悄悄指向错误目标（或失效目标），无任何提示。

**修复方向（未改代码，仅建议）**：`scope` 显式改变且未传 `--scope-id`（或新 scope 与旧 scope 不同类且目标 id 显然跨了对象类型）时，要求显式 `--scope-id`；最简做法是 `scope` 变化且 `scopeId === undefined` 时下发 null，让后端给出与 GLOBAL→USER 一致的可读报错。

**严重度**：低（需主动切 scope 且漏参数）。

---

## 复验通过的点（Round 3 六个问题的修复确认）

| Round 3 问题 | 复验结果 |
|---|---|
| Bug 1 update 部分更新必失败 | merge 逻辑正确（在 `data:{records}` 桩上全部发出合法全字段 PUT，并经真实 `BudgetService.update` 验证 OK）：`--enabled 1` 保留 GLOBAL/COST/100000000/WARN；`--action BLOCK` 保留 USER/7/TOKENS/20000000；`--limit-value 300` 在 COST 行得 300000000；`--scope GLOBAL` 强制 scopeId=null。**但解包路径错，见 Bug A** |
| Bug 2 `--limit-value` 不带 `--limit-type` 静默按 TOKENS | 已修：`effectiveType = limitType ?? current.limitType`，沿用既有行口径；`limitType=WEIRD` 时报错要求显式传（实测 `该预算当前 limitType=WEIRD 无法识别`）。注意这同时是 Bug B 的来源（显式改 type 时反而带旧数值） |
| Bug 3 TOKENS 无上限 | 已修：`LIMIT_MAX_TOKENS=9007199254740991`，实测 `9007199254740992` 报 `--limit-value 不能超过 9007199254740991（token 数）`，边界值 9007199254740991 放行 |
| Bug 4 COST >6 位小数静默取整 | 已修：实测 `--limit-value 1.0000005` 报 `--limit-value 最多保留 6 位小数（成本单位）`，与 `modelPrice`、后端 `normalizePrice` 同口径 |
| Bug 5 BLOCK 准入点文档 | 已修：`budget.md` 改为「WebSocket 手动发送、消息编辑重发、排队消息自动消费、定时任务直接执行、开放 API / 入站 Webhook 触发」，与 `streaming-ws-handler.ts:501/850/1714`、`create-app.ts:1309-1312/1325-1329`、`open-run.service.ts:92-93` 五处调用点一一对应，不存在的「打开已有会话的任务」已删 |
| Bug 6 admin.md 侧边栏分组 | 已修：改为「运行」，与 `admin/src/components/SideMenu.vue:120-125`（`id:'runtime'`/`label:'运行'`，含 `/budgets`）一致 |

## 补充确认（非缺陷）

- **`enabled` 补下发（自查发现的第二个 bug）确已修**：merge 时 `enabled: 用户值 ?? current.enabled ?? 1`。实测行 1/行 2 `enabled=0` 时，`--action BLOCK` / `--limit-value 1000` / `--limit-type TOKENS` 等部分更新发出 `enabled:0`，未发生"悄悄重新启用"。
- **`.data` 解包与 `outputResult` 不互相干扰**：`budget list --json` 在忠实桩下正确打印数组；`budget update --json` 只打印 `data` 对象，`--raw` 打印完整信封（`output.js:21-35` 两种分支均正常）。
- **create / delete 无回归**：`create`（COST 500→500000000、USER/7/TOKENS/20000000、7 位小数拒绝、TOKENS 超 2^53-1 拒绝）与 `delete --id 3` 实测全部正常。
- **文档自洽**：`budget.md` update 节已改为"部分更新 + 先拉当前行合并"的准确描述，并明确"换算口径跟随改后的 limit-type，未显式改时沿用当前口径"；create 表格的 TOKENS 上限（9007199254740991）与 HELP、实现一致。"只改上限时不带 `--limit-type` 也能安全工作"的说法与实现相符（Bug B 是**显式改** limit-type 的场景，不影响该结论）。
- **遗留小口径（不要求改）**：① TOKENS 非整数仍静默取整（`--limit-value 1000.5` → 1001），与 Round 3 一致；② `--limit-value -5` 因 `args.js` 把 `-5` 当 flag 前缀，最终报"至少需要一个待修改字段"而非"必须是正数"（全 CLI 既有行为，仍以错误退出，不发请求）；③ update 现在除 `budget:write` 外还需要 `budget:read`（多一次 GET），若未来有只授 write 的角色会被 403 挡在第一步。
