# LOCAL 工具审批规则（feat/approval-rules）代码审查

- **日期**：2026-10-08
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/approval-rules`，分支 `feat/approval-rules`，单一提交 `0c87173b feat(approval): 工具审批规则（本会话总是允许 + 持久放行名单）`，diff 相对 `main`（`git diff main...HEAD`，44 文件）。
- **范围**：仅功能代码（`docs/`、`CHANGELOG.md`、`skills/` 按要求未审）。逐文件走读：backend 侧 `approval-rule/`（normalize / service / repository / routes / admin.routes / types + 3 份 spec）、`approval/approval-hint.ts`、`approval/approval-registry.ts(+spec)`、`harness/tool/tool-dispatcher.ts(+spec)`、`harness/local/local-tool-executor.ts(+spec)`、`harness/local/local-tool-session-registry.ts(+spec)`、`harness/tool/tool-result.ts`、`session/ws/streaming-ws-handler.ts(+spec)`、`session/session.service.ts`、`create-app.ts`、`common/error-code.ts`、`db/migration/V135__approval_rule.sql`；desktop 侧 `ApprovalStack.vue`、`ToolCallCard.vue`、`useChat.ts`、`useStreamWS.ts`、`types/chat.ts`、`utils/chatMessage.ts`、`api/index.ts`、`views/settings/ApprovalRulesView.vue`、`SettingsView.vue`、`router/index.ts`、`electron/main.cjs`、`electron/preload.cjs`；admin 侧 `views/approval/ApprovalRuleView.vue`、`router/index.ts`、`components/SideMenu.vue`。
- **方法**：以技术方案（`docs/plan/2026-10-06-approval-rules-technical-design.md`）为基准通读实现，对重点怀疑点实际编写测试验证（测试随审查保留在对应 spec 文件中，未改动任何实现代码）。
  - `cd backend-ts && npx vitest run src/approval-rule src/harness/approval src/harness/tool/tool-dispatcher.spec.ts src/harness/local/... src/session/ws/streaming-ws-handler.spec.ts`：8 文件 215 passed。
  - `cd backend-ts && npm test`（全量，含新增验证测试）：**253 files passed | 1 skipped，2853 tests passed | 13 skipped，exit 0**。
  - `cd desktop && npx vitest run`：24 files / 286 passed；`npx vue-tsc --noEmit`：exit 0。
- **结论**：确认 **3 个可复现的功能缺陷**（1 中 2 低，均不涉安全放行越权与审批链断裂）+ 4 条观察/建议。规则匹配优先级、denylist 双重拦截、幂等落库、hint 恰好一次消费、档位准入、越权校验、迁移 SQL、Electron 透传链按方案红线逐条核验**未发现 bug**（详见「已验证无问题的重点项」）。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中 | desktop 设置页 | 审批规则「类型」tab 是**前端对当前一页**过滤：后端 `/v1/approval-rules` 只支持 scope/page 分页、无类型过滤，规则数 >20 时选「MCP 工具/命令前缀」看不到落在第 2 页以后的规则，还可能误显示「暂无用户级规则」；重复创建的查重同样只看当前页 |
| BUG-2 | 低 | backend approval-rule.service | `listUserRules` 开 `includeSession=1` 时 `records` 追加了 SESSION 规则而 `total` 只统计主 scope（records.length 可大于 total）；`scope=SESSION` 叠加 `includeSession` 时同一会话规则**重复出现** |
| BUG-3 | 低 | desktop 设置页 vs backend normalize | 「将保存为」预览把**任意位置**的 env 赋值 token 都过滤掉，而服务端只剥离**首部**连续 env 前缀，预览值可能比实际落库值短（如 `npm run FOO=bar build` 预览 `npm run build`、实际存 `npm run FOO=bar build`） |
| 观察-1 | 观察 | hint 生命周期 | `tool_approval` 帧与 `tool_result` 帧理论上存在竞态（后者先到时 executor finally 的 unregister 已清 hint，alwaysAllow 静默降级为普通执行）；实测顺序有利于审批帧，且降级方向安全 |
| 观察-2 | 观察 | admin 端 | `GET /v1/admin/approval-rules` 的 `size` 未按 100 截断（与 audit/usage 等既有 admin 端一致，沿袭现有约定） |
| 观察-3 | 观察 | denylist | 切词器不识别 `$(...)`、反引号、引号包裹等命令结构，可构造绕过；技术方案 §8 已明确 denylist 定位为「缓解而非安全边界」，按方案口径不计 bug |
| 观察-4 | 观察 | 构建 | `desktop/src/stores/session/messages.ts:372` 的 `approval_mark` 行内类型仍只写 `'llm' | 'jev'`（运行期透传 `rule` 不受影响，vue-tsc 通过因为赋给更宽的 `ToolCall.approvalMark`） |

---

## BUG-1【中】设置页类型 tab 只过滤当前页，服务端无类型过滤参数

**位置**

- 前端：`desktop/src/views/settings/ApprovalRulesView.vue:185`（只传 page/pageSize，不传类型）、`:187`（`items.value = ... records.filter(r => r.ruleType === typeFilter.value)`，对已拉取的当前页做过滤）、`:188`（`total` 用未过滤的总数）、`:30-32`（items 为空即显示「暂无用户级规则」）、`:236`（重复创建查重只比对 `items.value`，即当前页）。
- 服务端契约：`backend-ts/src/approval-rule/approval-rule.routes.ts:42-57` 只读 `scope/includeSession/sessionId/page/pageSize`，**没有类型过滤**；`approval-rule.service.ts:235-256` / `approval-rule.repository.ts:52-65`（`listByUser` 只按 user+scope 分页）。

**问题**

规则按 `hit_count DESC` 排序分页。当某用户的规则超过一页（pageSize=20）且被选类型的规则分布在第 2 页及以后时：选择该类型 tab 后列表为空，页面显示「暂无用户级规则」——而规则实际存在，只是没被拉到。`total`（未过滤）与列表内容互相矛盾，分页器仍显示全部页数。连带影响：`:236` 的重复创建提示也只覆盖当前页，可能漏判导致同值重复创建（表无唯一键，服务端允许）。

**验证测试**（新增，随报告保留）

- `backend-ts/src/approval-rule/approval-rule.routes.spec.ts` → `listIsPagedServerSideAndHasNoRuleTypeFilter`：构造 20 条 `SHELL_PREFIX`（高 hit）+ 5 条 `MCP_TOOL`（低 hit，落第 2 页），断言 `GET /v1/approval-rules?page=1&pageSize=20` 的 `records` 全是 `SHELL_PREFIX`、`total=25`，且带 `type=MCP_TOOL` 参数时服务端**不识别**（仍返回全部类型的第 1 页）——即客户端只能在已拉取的一页内过滤，构成 BUG-1 的根因。
  - 运行：`npx vitest run src/approval-rule/approval-rule.routes.spec.ts` → 3 passed。

**修复方向（未实施）**：后端 `listUserRules/listByUser` 增加 `ruleType` 过滤并把分页 total 建立在过滤后口径上；或前端切 tab 时传 type 参数。二选一即可让列表、total、查重三者口径一致。

---

## BUG-2【低】`includeSession` 时 `total` 与 `records` 口径不一致，且 `scope=SESSION` 叠加会重复

**位置**：`backend-ts/src/approval-rule/approval-rule.service.ts:235-256`

```ts
const [rows, total] = await Promise.all([
  this.repo.listByUser(userId, scope, pageSize, (page - 1) * pageSize),
  this.repo.countByUser(userId, scope),
]);
let records = rows.map((row) => this.toVo(row));
if (options.includeSession === true && options.sessionId != null) {
  const sessionRows = await this.repo.listEnabledForMatch(userId, options.sessionId);
  records = [...records, ...sessionRows.filter((row) => row.scope === 'SESSION').map((row) => this.toVo(row))];
}
return { records, total };
```

**问题**：`total` 只统计主 scope（默认 USER），而 `records` 在主分页之外又追加了 SESSION 规则，二者口径不一致（records 可多于 total / pageSize）；若调用方显式传 `scope=SESSION` 且 `includeSession=1`，同一会话的 SESSION 规则会同时出现在主列表与追加列表中而**重复**。当前桌面端 `listApprovalRules` 只传 page/pageSize（不开 includeSession、不传 SESSION），故仅 API 调用方可见，影响面小。

**验证测试**（新增，随报告保留）

- `backend-ts/src/approval-rule/approval-rule.service.spec.ts` → `listUserRulesTotalCoversOnlyMainScopeWhenAppendingSessionRules`：USER 主列表 1 条 + 追加 2 条 SESSION，断言 `total===1` 而 `records.map(id)` 为 `[1,5,6]`；再以 `scope=SESSION&includeSession` 断言 records 为 `[5,5,6]`（5 重复、6 未在主分页）。
  - 运行：`npx vitest run src/approval-rule/approval-rule.service.spec.ts` → 25 passed。

**修复方向（未实施）**：追加 SESSION 规则时按 `(session_id, rule_type, rule_value)` 或 id 去重，并让 `total` 反映追加后的条数（或改为独立字段如 `sessionTotal`）。

---

## BUG-3【低】「将保存为」预览与服务端归一化口径不一致（env 赋值位置）

**位置**

- 前端预览：`desktop/src/views/settings/ApprovalRulesView.vue:162` —— `raw.split(/\s+/).filter(t => t !== '' && !/^[A-Za-z_][A-Za-z0-9_-]*=/.test(t))`，把**任意位置**形如 env 赋值的 token 全部剔除。
- 服务端口径：`backend-ts/src/approval-rule/approval-rule-normalize.ts:38-45` —— `normalizeShellCommand` 只剥离**首部连续** env 赋值前缀。

**问题**：输入 `npm run FOO=bar build`（SHELL_EXACT）时，预览显示「将保存为：`npm run build`」，服务端实际落库 `npm run FOO=bar build`（中间段 env 赋值属于命令本身）。用户看到的值与实际生效的规则值不一致（保存成功的 toast 会显示真实值，但预览已造成误导）。写入 `SHELL_PREFIX` 时同样可能把中段 env 赋值算进/剔出 token 数，导致前两 token 取值偏差。

**验证测试**（新增，随报告保留）

- `backend-ts/src/approval-rule/approval-rule-normalize.spec.ts` → `stripsEnvPrefixOnlyAtTheLeadingPosition`：断言 `normalizeShellCommand('npm run FOO=bar build')` 保持为 `npm run FOO=bar build`、`FOO=1 npm run FOO=2 build` → `npm run FOO=2 build`，即服务端只认首部；与前端正则的差异由本 bug 描述固定。
  - 运行：`npx vitest run src/approval-rule` → 3 files / 49 passed。

**修复方向（未实施）**：前端预览改为与服务端一致的「只剥离首部连续 env 赋值」实现（剥离遇第一个非 env token 即停），或直接移除本地预览、仅展示服务端返回的归一化值。

---

## 已验证无问题的重点项（逐条核验，均通过）

1. **规则匹配优先级**：`approval-rule.service.ts:104-140` 的 scope 双层循环（SESSION 先于 USER）+ 同 scope 内先 EXACT/MCP 全等后 PREFIX 词边界，实测 SESSION PREFIX 胜 USER EXACT、同 scope EXACT 胜 PREFIX、前缀不做非锚定匹配（`echo npm run` 不命中 `npm run`）；跨类型隔离（MCP 规则不放行 shell）。
2. **denylist 双重拦截**：`match()` 生成侧与匹配侧都以 `candidates[0]`（shell 为归一化全命令、MCP 为工具全名）做全量扫描；`git push --force` 即使存在 `git push` 前缀规则仍被拒；`rm-cache`/`--force-with-lease`/`docs/su/` 不误伤；admin 扩展 token（逗号分隔 + trim + 去重）生效；读取失败退化为内置种子且不阻断审批链。
3. **幂等落库**：`takeHint` 恰好一次消费（registry spec `hintRoundTripsThroughTakeHintExactlyOnce`）+ 落库前 `(session_id, rule_type, rule_value)` 查重，断线重发的 `tool_approval` 帧不会建重复规则；deny 帧永不落规则（ws spec `denyFrameNeverCreatesRuleEvenWithAlwaysAllow`）。
4. **hint 生命周期**：`register`（随签存 hint）与两处 `unregister`（ws handler + executor finally）配对清除，`sessionId:requestId` 键隔离多张 pending 卡；900s 超时/断连/重启后 hint 丢失即静默降级为普通执行，无内存泄漏路径。
5. **调用链**：`dispatchFullOutcome` LOCAL 分支在 `shouldRequireApproval` 前插入规则短路；规则命中走 `execute(..., false, null)`（6 参、旧字节级行为）；未命中走原五档链 + `buildHint`；shell 异步路径（`dispatchLocalShellAsync`）两个 `execute` 调用点（起始带 hint、后台 await 不带 hint）参数正确；PROXY 命中短路后不再产生 `proxy_approve` llm_call（spec 断言 `danger_assess` 不运行）；`dispatchInvocation` 的 `approvalMark` 直通位不经 `llmVerdict` 推导。
6. **档位准入**：READ_ONLY/FULL 零查询零徽标；READ_WRITE/SMART/PROXY 仅 shell/MCP 查规则，write_file/edit_file 不查不计数；触发用户为 null 不查。
7. **归一化边界**：env 前缀剥离（首部）、空白折叠、512 截断且两侧对称（超长命令 EXACT 规则仍可命中）、词边界匹配、单 token 命令取该 token。
8. **权限/归属**：`findOwnedUserRule` 对他人规则与 SESSION 规则一律 404（不暴露存在性）；`alwaysAllow` 落库前校验会话 owner 与 WS 认证用户一致；admin 端点 `approval-rule:read` 已按 V121 目录模式注册并授 role 1，普通用户 403。
9. **Electron/桌面透传**：`preload.cjs` 第 8 参 `approvalHint`（缺省 null）、第 3 参 `alwaysAllow`；`useStreamWS` tool_execute 分支并入 hint、`tool_approval` 帧仅布尔位；`useChat.confirmApproval` 对 deny 强制不带 alwaysAllow，发送失败恢复审批项；旧壳缺参 → hint/alwaysAllow 静默丢失，退化为两按钮，方向安全；Web 模式走 WS 帧不受影响。
10. **迁移 SQL**：`V135` 表结构与 `ApprovalRuleRepository` 字段一一对应（snake_case 经 `toSnakeRow`/`toCamelList` 转换）；`system_setting` 种子与 V048 表结构（含 V093 的 `is_secret` 列）兼容、`审批` category 与 V127 一致；`permission`/`role_permission` 插入沿用 V121 的 `WHERE NOT EXISTS` + `INSERT IGNORE` 幂等模式，可重复执行。

---

## 附：本次审查新增/改动的测试文件

| 文件 | 用例 | 对应 |
| --- | --- | --- |
| `backend-ts/src/approval-rule/approval-rule.routes.spec.ts`（新增） | `listIsPagedServerSideAndHasNoRuleTypeFilter`、`createNormalizesAndReturnsRuleValue`、`patchAndDeleteOtherUsersRuleReturns404` | BUG-1（根因契约）+ CRUD/越权回归 |
| `backend-ts/src/approval-rule/approval-rule.service.spec.ts` | `listUserRulesTotalCoversOnlyMainScopeWhenAppendingSessionRules` | BUG-2 |
| `backend-ts/src/approval-rule/approval-rule-normalize.spec.ts` | `stripsEnvPrefixOnlyAtTheLeadingPosition` | BUG-3 |

未改动任何实现代码。
