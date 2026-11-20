# 自定义 HTTP 工具（懒加载集成）Round 02 代码审查

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/custom-http-tools`（分支 `custom-http-tools`）未提交代码，含 untracked 文件
- 审查范围：Round 01 五个 bug 的修复落地 + 全量功能逻辑复核（不含文档变更）
- 基线：backend `npm test` 4424 passed / 1 failed（`harness/container/runtime-agent.spec.ts` unix socket EADDRINUSE，worktree 绝对路径超 macOS 104 字符限制所致，与本特性无关）；desktop `npm run build` exit 0 + vitest 671 passed；admin `npm run build` exit 0 + `npm test` 53 passed

## 修复验证结论（Round 01 五个 bug 均已修复且未引入回归）

| # | Round 01 bug | 修复落地 | 验证方式 | 结论 |
|---|---|---|---|---|
| 1 | SSRF 任一 IP 命中即放行 | `common/ssrf.ts` `areIpsInCidrAllowlist`（全命中才放行）、`http-api-executor.ts` `guardUrl` 逐 IP 硬拒 + 全量名单判定 | Round-01 复现测试现失败（旧行为不再复现）+ 新增 CIDR 位运算边界测试 4/4 通过 | 已修复 |
| 2 | PUT 省略 enabled 静默重新启用 | `user-tool.service.ts` `validateDraft(draft, defaultEnabled)`：新建=1、编辑=existing.enabled、试运行=1 | Round-01 复现测试现失败 + 新增回归 `keeps the stored enabled state when the draft omits enabled`（spec L198-210） | 已修复 |
| 3 | 超上限隐藏工具仍可调用 | `findCallableEnabled`（listEnabledByUserId + 名次 < maxEnabled），`resolveForExecution`/`findEnabledWithParams` 同源 | 新增回归 `hides tools beyond the enabled cap...`（spec L282-296）；**但发现名次口径与目录装配不一致的新 bug，见下** | 部分修复 |
| 4 | 列表入口试运行对敏感头工具必失败 | `UserToolsView.vue` 卡片按钮 `:disabled="hasSensitiveHeader(item)"` + `.action-btn-slot` 包裹层 + 抽屉「发起调用」`:disabled="testing \|\| hasMaskedHeader"` | 代码核对 + Round-01 桌面掩码测试仍通过 | 已修复 |
| 5 | 放行清单校验不拦截环回/元数据 | `settings.service.ts` 保存前 `cidrOverlapsHardDeniedNet` 硬拒校验；`admin/src/views/settings/cidrAllowlist.ts` 同款前置校验 | Round-01 复现测试现失败 + 新增边界测试（127.0.0.1、169.254.0.0/16、0.0.0.0/0、126.0.0.0/7、169.254.169.253 等 20+ 用例） | 已修复 |

位运算专项复核（`prefixMask` / `cidrIntersects` / `HARD_DENY_NETS`）：prefix 0→0、32→0xFFFFFFFF、1-31 掩码正确；对齐 CIDR 块「嵌套或不相交」的双向包含判定正确；`0.0.0.0/0` 正确判与一切相交；`169.254.169.253`（元数据紧邻地址）正确判为可放行（设计仅永拒 169.254.169.254 精确地址）。无边界错误。

`validateDraft` 三路径自洽性：新建（L63 传 1）、编辑（L100 传 `existing.enabled`）、试运行（L195 传 1），L330 `draft.enabled == null ? (defaultEnabled === 1 ? 1 : 0) : (draft.enabled ? 1 : 0)` 逻辑正确；显式传 `enabled` 时三路径一致。

既有调用方影响：`harness-service.ts:424`（`listEnabled` 签名未变）、`http-api-tools.ts:72/157`（`findEnabledWithParams`/`resolveForExecution` 签名未变，内部改走 `findCallableEnabled`）、`findEnabledByUserIdAndName` 全库零引用（移除彻底）、admin 统计链路未触及。无破坏。

---

## Bug 1（新）：可调用名次按 MySQL collation、目录截断按 JS code-unit，上限边界两集合分歧

- **文件:行号**：
  - `backend-ts/src/user-tool/user-tool.service.ts:223-230`（`findCallableEnabled`，名次取 `listEnabledByUserId` 的 SQL 序）
  - `backend-ts/src/user-tool/user-tool.repository.ts:21-23`（`ORDER BY name ASC`，MySQL `utf8mb4_0900_ai_ci`）
  - `backend-ts/src/harness/core/custom-http-tools-catalog.ts:27`（`[...tools].sort((a, b) => a.name < b.name ? -1 : 1)`，JS code-unit 序）
  - `backend-ts/src/harness/core/harness-service.ts:424-432`（装配：listEnabled → buildCustomHttpToolCatalog）
- **问题描述**：修复3 在 `user-tool.service.ts:219-222` 注释声称「排序与截断口径与 harness 目录装配完全一致（同一 listEnabled 结果 + 同一 name ASC 比较）」，但两侧比较器实际不同：
  - 可调用名次：`listEnabledByUserId` 返回 MySQL `ORDER BY name ASC` 结果，列 collation 为 `utf8mb4_0900_ai_ci`（表 DDL `DEFAULT CHARSET=utf8mb4` 无显式 COLLATE，取服务端默认）。本机 MySQL 8.0.46 实测：**`_` 排在数字之前**（`a_b < a0b`）。
  - 目录截断：`buildCustomHttpToolCatalog` 用 JS `<` 按 code-unit 重排，**数字（0x30-0x39）排在 `_`（0x5F）之前**（`a0b < a_b`）。
  - 两种排序在「`_` vs 数字」位置分歧，导致启用数超过上限时：目录展示的是 JS 序前 N 个，可调用的是 SQL 序前 N 个，两集合不同。
- **为什么是 bug（触发场景）**：
  1. 用户启用工具数 > `tools.http.maxEnabledPerUser`（默认 20，需 21+ 个启用工具；或管理员把上限下调到 1~100 之间某值——settings 钳制 1..100，属文档化场景）；
  2. 且边界附近存在「同位置一为 `_` 一为数字」的名字对（如 `weather_v1` vs `weather2`、`order_1` vs `order2`，均符合 slug 正则 `^[a-z][a-z0-9_]{0,63}$`）。
  - 症状 A：模型在目录分节看到工具 X，`http_call`/`http_describe` 调用 X 返回 `工具不存在或未启用：X`（`http-api-tools.ts:73/162`），模型困惑重试或放弃；
  - 症状 B：目录未展示的工具 Y 仍可被调用——Round 01 bug 3 的变体以反方向复现（模型看不到但调得通），违反设计 §5.4「可调用集合与目录一致」。
  - 无单用户工具总数上限（仅启用上限），21+ 启用工具可达；无安全影响（Y 是用户自己的工具）。
- **实际运行的验证测试/命令与输出摘要**：
  - MySQL 排序实证（本机 MySQL 8.0.46，与生产表同 DDL 模式 `DEFAULT CHARSET=utf8mb4`）：
    ```
    CREATE TABLE t (...) DEFAULT CHARSET=utf8mb4;  -- 列 collation = utf8mb4_0900_ai_ci
    INSERT ... ('a1b'),('a_b'),('a0b'),('azb'),('a_b2'),('a2b');
    SELECT name FROM t ORDER BY name ASC;
    → a_b, a_b2, a0b, a1b, a2b, azb        （'_' 先于数字）
    SELECT 'a_b' < 'a1b';  → 1
    ```
  - 分歧实证（`/tmp/code-review-verify/callable-rank-consistency.spec.ts`，fake repo 按 MySQL 实测序返回，模拟真实 SQL）：
    ```ts
    // 启用 aqi / weather_v1 / weather2 三个工具，上限 2
    const catalog = buildCustomHttpToolCatalog(await service.listEnabled(9), 2);
    catalog.tools.map(t => t.name)  → ['aqi', 'weather2']     // JS 序前 2
    resolveForExecution(9, 'weather2')   → null               // 目录可见却不可调用
    resolveForExecution(9, 'weather_v1') → 非 null            // 目录隐藏却可调用
    ```
    命令：`npx vitest run /tmp/code-review-verify/callable-rank-consistency.spec.ts --config /tmp/code-review-verify/vitest.verify.config.ts`
    输出：`Tests 4 passed (4)`（含「未超上限时两集合一致」「max<=0/非有限值口径一致」「同名不越界」三个对照用例均通过，证明分歧仅在 collation 序 ≠ JS 序且越界时出现）。
  - 附带发现：修复3 的仓库内回归用例（`user-tool.service.spec.ts:282-296`）fake repo 用 JS 排序、名字 `alerts`/`orders` 两种排序恰好一致，**覆盖不到本 bug**。
- **严重程度**：低。需同时满足「启用数超上限」+「边界名字 `_`/数字分歧」两个条件；无安全影响；但属设计 §5.4 明确要求的一致性被破坏，且修复注释自证的口径并不成立。
- **修复方向建议**（不在本轮修改范围）：`findCallableEnabled` 改为与目录同一比较器——在 `listEnabledByUserId` 结果上按 JS code-unit 重排后再取名次（或让目录改用与 SQL 一致的比较器，但 JS 侧复刻 MySQL collation 不可行，前者更直接）；并补一条名字含 `_`/数字分歧的回归用例。

---

## 复核覆盖说明（无其他 bug）

- 懒加载宪法：per-tool schema 不进 LLM `tools` 数组，仅 `http_describe`/`http_call` 外壳 + 提示词目录分节——成立
- 属主隔离：执行链 userId 仅从 sessionId 解析，`resolveForExecution(10, ...)` 返回 null——成立
- SSRF：协议白名单、IPv6 拒绝、环回/元数据硬拒先行、DNS 解析后逐 IP 判定、全 IP 命中名单才放行、重定向逐跳重判、5s TTL 缓存失败即拒——成立
- 敏感头：AES-GCM `enc:` 前缀、掩码语义（掩码=沿用、空=删除、新值=加密）、解密失败抛错不静默——成立
- 桌面修复4：卡片按钮禁用态 + `.action-btn-slot` 包裹层（禁用按钮不派发鼠标事件，包裹 span 保证 tooltip 可达）+ `cursor:not-allowed/opacity` 视觉反馈 + 抽屉提交禁用 + 警告 alert——成立，编辑/启用/删除入口未受影响
- admin 放行清单：保存前格式 + 硬拒段双重校验，前后端口径一致——成立
- 迁移规范：V161 表结构 snake_case、BIGINT 自增、created_at/updated_at、唯一键 `(user_id, name)`——成立
