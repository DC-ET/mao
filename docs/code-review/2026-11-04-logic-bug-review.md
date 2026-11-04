# 核心逻辑 BUG 审查报告（2026-11-04）

> 审查范围：`backend-ts/src/` 全量结构通读（1035 个 TS 文件），对 5 个逻辑密集子系统做了逐文件深读——预算/用量、环境变量、审批规则、子代理数参校验、grep_search 工具实现；最近两个修复 commit 的改动点也逐行核对。`docs/plan/2026-11-04-group-chat-runtime-identity-*.md` 两个 commit 是纯文档，无代码可审。
>
> 审查方法：并行探查 + 人工逐行复核 + 单元测试复现。每个条目都给出「可达调用链 → 触发输入 → 期望 vs 实际」，并在 `backend-ts/src/logic-bug-review-2026-11-04.spec.ts` 中提供断言「正确行为」的用例。
>
> 验证口径：用例默认以 `it.fails` 固化（当前实现必然断言失败 → expected-failure 通过，CI 保持绿色）。**把文件顶部的 `const bugIt = it.fails;` 改成 `const bugIt = it;` 再运行，即得到 10 条真实失败**，即本报告的复现证据。
>
> **2026-11-04 当日复核修订**：初评 7 条候选经逐条核对代码与调用链后**保留 6 条**（5 条确定缺陷 + 1 条条件性潜在缺陷）。初评「BUG-6 子代理数参」经核对 manager 侧属主校验后**移入「已核查并排除」**——文档所述的「误取消/误追问、数据错乱」不成立，详见排除区；原 BUG-7（grep 负数）顺延为 BUG-6，严重度修正为低。spec 与本文计数已同步为 10 条。
>
> 本次审查**不修改任何产品代码**，只新增 1 个 spec 文件与本报告。

## 修复状态（2026-11-04，0.0.430）

**保留的 6 条已全部修复**，spec 同步转正为回归测试（`backend-ts/src/logic-bug-review-2026-11-04.spec.ts`，10 条用例全部通过；后端全量 5425 测试通过）：

| 编号 | 修复方式 | 位置 |
|---|---|---|
| 待定-1 | 进程级 TZ 对齐（首选方案，一次覆盖 `nowSql` 一族）：入口最早处 import 新模块设 `process.env.TZ='Asia/Shanghai'` | 新增 `backend-ts/src/config/process-timezone.ts`；`main.ts` 首个 import |
| BUG-2 | `containsDenyToken` 对每个 token 增加 basename 归一（`/bin/rm`→`rm`） | `approval-rule/approval-rule-normalize.ts` |
| BUG-3 | denylist 扫描对象改未截断全量命令（新增 `denyScanTargetForShell`，`normalizeShellCommand` 加 maxLength 参数），`buildApprovalHint` 与 `match()` 同步 | `approval-rule-normalize.ts`、`approval-rule/approval-rule.service.ts` |
| BUG-4 | `lookupPrice` 仅成功查到才写缓存（含负缓存），异常分支不写、保留重试 | `usage/llm-call.service.ts` |
| BUG-5 | `loadBundle`/`loadUser`/`loadWorkspace` 失败分支不写缓存，仅 fail-open 返回 `[]`/回落值 | `env/env-variable.service.ts` |
| BUG-6 | 负 `context_lines` 或 `<1` 的 `max_output_chars` 直接返回参数错误 | `harness/tool/impl/grep-search-tool.ts` |

## 复现

```bash
cd backend-ts
# 预期失败形态（证明 BUG 存在）：10 failed
sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' src/logic-bug-review-2026-11-04.spec.ts
npx vitest run src/logic-bug-review-2026-11-04.spec.ts

# 恢复为 expected-failure 形态（CI 绿色）：10 passed
sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' src/logic-bug-review-2026-11-04.spec.ts
npx vitest run src/logic-bug-review-2026-11-04.spec.ts
```

## 结论先行

本报告保留 6 条：**5 条是无需讨论的确定缺陷**（均可单独断言、单独复现）；**1 条（预算时区）是条件性潜在缺陷**——设计文档明写「服务器本地时区」，全站其余口径（`common/json.ts`、`db.ts timezone:'+08:00'`、`rangeWindow` 注释）都是 `Asia/Shanghai`，而仓库内**没有任何地方强制后端主进程的 TZ**：systemd 单元（`scripts/systemd/mao-backend.service`）无 `Environment=TZ`，唯一的时区对齐代码在 runtime-agent 容器入口（`runtime-agent.ts:435`），管的是容器内 agent 进程而非后端主进程。若后端宿主为 +08:00（国内云主机默认）当前不炸；宿主时区一旦变动/迁移即静默错位。另注意初评「预算是唯一本地 getter 口径」的说法不实——`common/datetime.ts:51` 的 `nowSql()` 同样用本地 getter 写 SQL 时间列（session/memory/subagent 的 `updated_at`/`completed_at`），因此正解是**进程级 TZ 对齐**（先例：runtime-agent 容器入口），而非只改预算三个函数。

| 编号 | 标题 | 位置 | 严重度 | 用户可见后果 |
|------|------|--------|--------|--------------|
| 待定-1 | 预算月度窗口用服务器本地时区，与全站 Shanghai 口径的条件性冲突 | `budget/budget.service.ts:52-70` | 潜在（宿主 TZ 非 +08:00 时成立；仓库内无强制） | 月初误 BLOCK / 额外「复活」一个月超额 |
| BUG-2 | 审批 denylist 词匹配无 basename 归一，可用绝对路径绕过 | `approval-rule/approval-rule-normalize.ts:25-27,69-76` | 高 | 危险命令静默放行，不弹审批卡 |
| BUG-3 | denylist 扫描对象被截断为 512，长命令尾部绕过 | `approval-rule/approval-rule-normalize.ts:45,127` | 高 | 长命令 denylist 形同虚设（与 BUG-2 组合稳定绕过） |
| BUG-4 | 兜底价格缓存把「查库异常」也当「模型不存在」缓存 60s | `usage/llm-call.service.ts:311-333` | 中 | 60s 内该模型成本变 NULL，预算闸门被穿透 |
| BUG-5 | 环境变量缓存把「查库失败」缓存为空，5 秒内全会话丢变量 | `env/env-variable.service.ts:457-506` | 中 | shell/容器会话丢 API key，间歇性「缺凭据」失败 |
| BUG-6 | grep_search 负 `max_output_chars` 未校验 | `harness/tool/impl/grep-search-tool.ts:62-63,129,153` | 低 | 模型误判「无命中」继续推进，搜错/写错文件 |

---

## 待定-1：预算月度窗口用服务器本地时区，与全站 Shanghai 口径的条件性冲突

**位置**：`backend-ts/src/budget/budget.service.ts:52-56`（`monthStartLocal`）、`:59-63`（`currentPeriodLabel`）、`:66-70`（`nextMonthStartLocal`）；调用方 `getPeriodSpend` `:89-94`。

```ts
// 周期起点：服务器本地时区当月 1 日 00:00（技术方案 §5.6）。
export function monthStartLocal(now: Date = new Date()): string {
  const y = now.getFullYear();               // ← 进程本地时区 getter
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01 00:00:00`;
}
```

**为什么是条件性缺陷**：

1. `common/json.ts:8` 强制 `SHANGHAI='Asia/Shanghai'`，`db/db.ts:111` 连接 `timezone:'+08:00'`（MySQL 会话时区随之设为 +08:00，`llm_call.created_at` 默认 `CURRENT_TIMESTAMP` 即按 +08:00 落库），`rangeWindow` 注释明写「时区口径同管理后台：Asia/Shanghai 日历日」；`getPeriodSpend` 的 `since` 正是与这些 +08:00 时间戳做范围比较，进程非 +08:00 时边界即错位；
2. 仓库内**无任何处强制后端主进程 TZ**：`scripts/systemd/mao-backend.service` 只有 PATH 与 `MAO_RESTART_DETACHED` 两个 Environment；唯一的时区对齐代码 `runtime-agent.ts:432-435` 在 runtime-agent 容器入口，对齐的是容器内进程，管不到后端主进程。即「后端进程 = +08:00」目前完全依赖宿主机的默认时区，属于未声明的环境依赖；
3. 修正初评一处不实：「预算是唯一的 `get*` 本地时区口径」不成立——`common/datetime.ts:51` `nowSql()` 同样用本地 getter，被 session/memory/subagent 的 `updated_at`/`completed_at` 写入直接使用。它与预算同根（都依赖宿主 TZ），但预算是**日历边界**（错位一个月才算错，月初 8 小时窗口内显形），`nowSql` 是**当前时刻**（宿主非 +08:00 会立刻与 CURRENT_TIMESTAMP 列混排）。真正彻底的修法是进程级对齐，只改预算函数只治标。

**触发输入**：进程 TZ=UTC，北京时间 2026-11-01 02:00（= UTC 10-31 18:00）。`monthStartLocal` 返回 `2026-10-01`，10 月消耗计入 11 月预算 → 误 BLOCK；12-01 同理，11 月已超额的预算额外「复活」一个月。

**已核查并说明（为何列待定而非确定）**：三条技术方案文档（`2026-10-26-user-budget-visibility` §6 等）自承「服务器本地时区」口径——该口径成立的前提是部署环境确为 +08:00；国内云主机默认如此，故生产大概率不显形，但仓库内无法证实亦无强制。用例 `BUG-1` 用子进程 `TZ=UTC` 求值，证明的是**表达式本身依赖进程 TZ**（复现成立）；是否在生产显形取决于宿主时区。**请维护方按部署实际确认后再定级/动代码**：若宿主确为 +08:00 且无迁移计划，本条可降为「加固建议」；否则按全站 Shanghai 口径修。

**期望 vs 实际**（用例 BUG-1，子进程 TZ=UTC、北京时间 2026-11-01 02:00）：

| | 结果 |
|---|---|
| 期望 | `since='2026-11-01 00:00:00'`（上海日历月） |
| 实际 | `since='2026-10-01 00:00:00'`（UTC 本地月） |

**修复建议**（两选一，首选前者，一次覆盖 `nowSql` 一族）：① 进程级对齐——后端入口（`main.ts` 最早处）设 `process.env.TZ='Asia/Shanghai'` 或启动期断言宿主时区，先例即 `runtime-agent.ts:435`；② 把 `monthStartLocal/currentPeriodLabel/nextMonthStartLocal` 改为 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 取年/月，与 `shanghaiYmd` 同源（仅治预算，不覆盖 `nowSql`）。

---

## BUG-2：审批 denylist 词匹配无 basename 归一，可用绝对路径绕过

**位置**：`backend-ts/src/approval-rule/approval-rule-normalize.ts:25-27`（`tokenizeCommand`）、`:69-76`（`containsDenyToken`）；调用链 `approval-rule.service.ts:151`（`buildHint` → `buildApprovalHint`）、`:117`（`match` 的 deny 检查）、`:230-232`（`normalizeUserInput` 创建放行规则时拒绝含 deny 的请求）。

```ts
export function tokenizeCommand(command: string): string[] {
  return command.split(/[\s;|&><]+/).filter((t) => t !== '');
  // "/bin/rm -rf /" → token "/bin/rm" ≠ "rm"（种子里只有裸 "rm"）
}
```

**为什么是 BUG**：防误伤注释（`:22-23`）说明仅靠「不切 `-`/`/`」保护 `rm-cache`/`docs/su/`，但同样把 `/bin/rm`、`/usr/bin/sudo` 放过——二者都是合法可执行路径。`shell` 工具的 `command` 是模型直接可控的字符串。

> 复现注意事项：seed 里有 `-rf` 这个 token，`'/bin/rm -rf /'` 会因第二 token `-rf` 命中而「偶然正确」；必须用不带 `-rf` 的命令（`/bin/rm /tmp/x`、`/usr/bin/sudo ...`）隔离才能复现 basename 缺失。用例里刻意避开 `-rf`。

**触发输入**：`shell` 命令 `"/bin/rm /tmp/victim"` 或 `"/usr/bin/sudo apt update"`。

**期望 vs 实际**（用例 BUG-2，3 条）：

| | 结果 |
|---|---|
| 期望 | `containsDenyToken('/bin/rm /tmp/victim', SEED) === true`；`buildApprovalHint(...)=null` |
| 实际 | 前者 `false`；`buildApprovalHint` 返回 `{ ruleType:'SHELL_PREFIX', ruleValue:'/bin/rm /tmp/victim', ... }` |

**用户后果**：三处全部失效——`match()` 自动放行、审批卡第三按钮、拒绝创建放行规则；危险命令静默放行。

**修复建议**：`containsDenyToken` 内对每个 token 取 basename 再比对：`const base = token.split('/').pop()`；注意保持 `docs/rm-cache/x` 不误伤（其 basename 是 `x`，天然不命中）。已知代价：`cat docs/rm` 这类「文件名恰为 deny 词」的命令会被误命中 → 多弹一次审批，方向安全（误伤不静默），可接受。

---

## BUG-3：denylist 扫描对象被截断为 512 字符，长命令尾部绕过

**位置**：`approval-rule-normalize.ts:45`（`normalizeShellCommand` 尾部 `.slice(0, RULE_VALUE_MAX_LENGTH)`，`RULE_VALUE_MAX_LENGTH=512`）、`:127`（`buildApprovalHint` 对「已截断的 EXACT ruleValue」扫 denylist）；同型问题在 `approval-rule.service.ts:117`（`match` 扫的 `candidates[0]` 也是截断后的归一化命令）。

```ts
return tokens.slice(start).join(' ').slice(0, RULE_VALUE_MAX_LENGTH); // 截断的是扫描对象本身
```

**为什么是 BUG**：截断是为 `rule_value` 存储宽度设计的（列宽 512），但 `buildApprovalHint` / `match` 拿截断后的字符串当 denylist 扫描对象。`echo <600 个 'a'> ; rm -rf /`（rm 位于第 ~608 字符）→ 扫描只看到无害前缀，denylist 形同虚设。与 BUG-2 组合即稳定绕过：不带 `-rf` 也能绕。

> 注：直传 `containsDenyToken(未截断长命令)` 本来就是 `true`——问题不在该函数，在调用方。复现用例只走 `buildApprovalHint`（真实调用链），不测裸函数。

**触发输入**：`shell` 命令前段 >512 字符无害前缀、后段 `rm ...`（用例用 `echo` + 600 个 `a` + ` ; rm -rf /`）。

**期望 vs 实际**（用例 BUG-3，2 条）：

| | 结果 |
|---|---|
| 期望 | `buildApprovalHint(...)=null` |
| 实际 | 返回 `{ ruleType:'SHELL_PREFIX', ruleValue:'echo aaaa…', label:'本会话总是允许以 echo aaaa… 开头的命令' }` |

**修复建议**：denylist 扫描基于截断**前**的全量归一化命令（`buildShellRuleCandidates` 内部或让调用方拿未截断串）；或截断发生时标记「不可安全放行」直接返回 null。注意 `match()` 侧要同步改（`:117`）。

---

## BUG-4：兜底价格缓存把「查库异常」也当「模型不存在」缓存 60s

**位置**：`backend-ts/src/usage/llm-call.service.ts:311-333`（`lookupPrice`）、`:332`（无条件 `priceCache.set`）；`PRICE_CACHE_TTL_MS = 60_000`（`:120`）。

```ts
} catch (e) {
  console.warn(...);
}                                          // price 保持 null
this.priceCache.set(modelId, { price, expiresAt: now + PRICE_CACHE_TTL_MS }); // 异常也缓存 null
```

**为什么是 BUG**：同文件注释 `:240,293` 明说负缓存语义是「模型不存在」——那是**成功查到 null**；查库抛异常是另一语义，应重试。当前 catch 后把异常结果也写进 60s TTL 缓存，毒化其后 60s 的该模型全部调用：`costMicros=NULL` → `SUM(cost_micros)` 忽略 NULL 行 → 当期消耗被低估，COST 类 BLOCK/WARN 静默穿透，总览成本亦偏小。

**触发输入**：兜底价格路径下 `modelPriceLookup` 因 DB 抖动抛错一次；60s 内同模型再次调用。

**期望 vs 实际**（用例 BUG-4）：

| | 结果 |
|---|---|
| 期望 | 第 2 次调用重试 lookup（`calls=2`），`costMicros` 非 null |
| 实际 | `calls=1`、`costMicros=null`（缓存命中） |

**修复建议**：仅在 `await lookup` 成功时写负缓存；抛异常分支 `return null` 且不写缓存（或写极短 TTL）。

---

## BUG-5：环境变量缓存把「查库失败」缓存为空数组，5 秒内全会话丢变量

**位置**：`backend-ts/src/env/env-variable.service.ts:457-477`（`loadBundle`）、`:479-491`（`loadUser`）、`:493-506`（`loadWorkspace`）；`CACHE_TTL_MS = 5000`（`:13`）。

```ts
let rows: EnvVariable[] = [];
try { rows = await this.repo.listUser(userId); }
catch (e) { harnessLog('warn', ...); }   // rows 仍为 []
this.userCache.set(userId, { value: rows, at: Date.now() }); // 缓存空数组，5s TTL
```

**为什么是 BUG**：这三处是 `resolveForSession`（三条注入链路共用的合并入口，`:237-256`）的热路径；失败不写缓存、直接回 `[]` 的语义（fail-open）本身没问题，问题是把空结果**当成功结果缓存**。一次日常 DB 抖动 → 其后 ≤5s 内新建的 shell/容器会话注入不了用户及工作区变量（API key、Token 全丢），命令以「缺凭据」失败——间歇性、难归因，用户看到的是随机发生的认证错误。触发窗口只有 5s（且要求抖动后 5s 内恢复），故定级中而非高。

**期望 vs 实际**（用例 BUG-5，repo 第一次抛错、第二次返回 1 行）：

| | 结果 |
|---|---|
| 期望 | 第 2 次 `resolveForSession` 重试查库，注入 `MY_API_KEY=sk-test`（`listUser` 调 2 次） |
| 实际 | 第 2 次直接返回 `{}`（缓存命中上一次的 `[]`，`listUser` 只调 1 次） |

**修复建议**：三个 `load*` 的 catch 分支不写缓存（直接返回 `[]`），与 `record()`/`settleWarn()` 那种 fire-and-forget 语义区分——这三处是同步注入链路。

---

## BUG-6：grep_search 负 `max_output_chars` 未校验

**位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts:62-63`（`asInt(...)` 裸透传）、`:129` / `:153`（`charsUsed + entrySize > maxOutputChars` 不判 `<0`）。

```ts
const contextLines = args.context_lines != null ? asInt(args.context_lines, 0) : 0;
const maxOutputChars = args.max_output_chars != null ? asInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS) : DEFAULT_MAX_OUTPUT_CHARS;
// 后续：if (charsUsed + entrySize > maxOutputChars) { truncated=true; break; } 而不判 <0
```

**为什么是 BUG**：`asInt(-10)` 经 `Math.trunc` 原样返回 `-10`。`max_output_chars=-10` 时首个条目 `0+size > -10` 恒成立 → 返回 `matches:[]`、无 error，模型误以为「无命中」继续推进（搜错关键词/写错文件）。工具是模型直接可控的参数。

> 修正初评一处不实：初评称负 `context_lines` 在 JS 路径与 rg 路径「行为不一致」——实际二者一致（均等价 0）：JS 路径 `afterUntil=line-1` 使后上下文不产出、`before` 收集有 `contextLines>0` 守卫（`:185`），rg 路径 `if (contextLines>0)` 才传 `--context`（`:89`）。真正的问题仅在负 `max_output_chars`。

**触发输入**：`max_output_chars: -10`（模型输出负整数才会触发，概率低，故定级低；但后果是静默错误结果）。

**期望 vs 实际**（用例 BUG-6，JS 路径、工作区内有 1 行 `hello`）：

| | 结果 |
|---|---|
| 期望 | `error`（或钳到合法下限后仍返回命中） |
| 实际 | `{ matches:[], truncated:…, total_matches:0 }` 且 `error===undefined` |

**修复建议**：`max_output_chars` 钳到 `≥1`（`context_lines` 顺手钳到 `≥0`）；负数入参直接 `errorJson`，与同文件 `pattern` 缺失时回 error 的口径一致——本文件对「失败吞成 0 命中成功」已有明确防线（rg 退出码处理，`:95-103`），此处补齐同一口径。

---

## 已核查并排除（不算 BUG，避免误报）

- **子代理数参裸 `Number()`（初评 BUG-6，复核后移出）**：`SubagentFollowupTool:111` / `CheckSubagentTool:151` 的 `Number(raw)` 确实把 `false→0`、`[5]→5` 当合法 id（初评 3 条用例可复现该校验缺口，已随本条移出 spec）。但初评所述「误取消/误追问、会话级数据错乱」**不成立**：`BackgroundSubagentManager.followup/progress/cancel` 均有属主校验——`sessionType!=='SUBAGENT'`、`parentSessionId!==parentSessionId` 一律拒绝（`background-subagent-manager.ts:173-178,307,325`），类型混淆的 id 要么不存在、要么属于别的会话 → 只得到 graceful error，无跨会话动作；真正有破坏力的 `cancel_subagent` 早已按 `asIntStrict` 修掉（`:181-184` 注释即为此案）。残留仅是「错误文案不友好」级别的防御一致性小瑕，修复价值低，不列正棒；日后统一口径时可顺手改。
- **`shell` envelope 计数（b294e8e0）败者/胜者口径**：`skill-view.service.ts` 的 meta 临时文件固定名、跨实例并发指纹错位——为待部署环境的猜想，且作者已在注释里明示部署清理兜底；不以本报告名义记 BUG。
- **`enterWaitingApproval` 等终态守卫的 `NOT IN` 未含 `IDLE`**、**`updatePhase` 非 CAS**：状态机注释与实现的偏差真实，但复现需并发时序控制，无法在本报告口径下稳定断言；记疑似，不列正棒。
- **容器并行 envelope 的跨会话覆盖**、**64-bit/timeout 溢出类**（`wait_subagents` 已显式钳制 `MAX_WAIT_SUBAGENTS_TIMEOUT_MS`）：已核查有显式处理，不记。
- **PdfViewer 面积 vs 单边 canvas 上限**：作者注释自承「面积防护」，单边超限的概率低且需浏览器渲染验证，不用单测用例作证据，不列正棒。
- **2026-11-03 报告的 8 条**：已全部修复（`bugIt` 留作回归），不重复列。

## 局限说明

- 本轮结论限于逐行读代码且能由单测复现的项；并发/时序类（如 `updatePhase` 读-改-写、子代理竞态）在修前复现成本太高，未计入正棒，见「已核查并排除」。
- 待定-1（预算时区）的生产显形取决于后端宿主时区，仓库内无强制亦无记录，请维护方确认后再定级/动代码；若确认宿主非 +08:00，注意 `nowSql()`（`common/datetime.ts:51`）同源受影响，进程级 TZ 对齐是覆盖两者的修法。
