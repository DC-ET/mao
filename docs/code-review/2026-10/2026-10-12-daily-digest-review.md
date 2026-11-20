# 每日运营摘要（Daily Digest）代码审查报告

> 本文件保留两轮审查记录。第 1 轮见文末「附：第 1 轮记录」。第 2 轮结论在下方。

---

# 第 2 轮复审（2026-10-12）

- 审查对象：`git diff 2e85554d a903dde7`（含初版 `c60657fc` + 修复 `a903dde7`）
- 复审焦点：Bug 1（浓缩行空串）与观察 1（默认开不生效）两处修复是否正确、完整、有无新问题；顺带复查全量。
- 基线：后端全量 294 文件 / 3648 用例绿（未改动任何被审查功能代码与既有 spec；仅新增第 2 轮探针）。

## 结论摘要

| 项 | 结论 |
|---|---|
| Bug 1 修复（`renderDigestLine`） | **基本正确，但不完整**：tasks / scheduled / watchers / approvals / openApi 五板块已与 `aggregate` 非空判定对称；**cost 板块仍不对称**，残留同类空串缺陷 → 新 Bug 2。 |
| 观察 1 修复（`listEnabledUsers` LEFT JOIN + `markProcessed` upsert） | **正确**：默认开落地、显式关排除、删除用户排除、TS filter 与旧 SQL WHERE 等价、懒建行列默认值正确、单调不回退保持。 |
| 新发现 | **Bug 2（中低）**：成本板块全 0 价（免费模型）时浓缩一行为空（已用失败探针证明）。 |

---

## Bug 2（中低）：成本板块全 0 价（免费模型）时收件箱浓缩一行为空——Bug 1 修复的残留

- **位置**：`backend-ts/src/digest/service.ts:251-254`（`renderDigestLine` 的 cost 分支）
- **问题描述**：Bug 1 的修复把 tasks/scheduled/watchers 的门控改得与 `aggregate` 对称，但 cost 分支仍是：
  ```ts
  if (data.cost != null) {
    if (data.cost.totalMicros > 0) parts.push(`成本 ${formatCostMicros(data.cost.totalMicros)}`);
    else if (data.cost.unpricedCalls > 0) parts.push(`未配价 ${data.cost.unpricedCalls} 次`);
  }
  ```
  而 `aggregate` 判定 cost 板块非空的条件是 `costCalls > 0`（`costCalls` = 所有 agent 分组 `calls` 之和，**含 micros=0 的调用**）。二者不对称：
  - 一次 0 价调用：`computeCostMicros`（`usage/cost-micros.ts:81`）对免费模型（价格配 0）返回 `Math.round(0) = 0`；`llm-call.service.ts:270` 的 `costMicros ?? null` 保留 `0`（不转 NULL）。故该行 `cost_micros = 0`。
  - `sumCostByAgent` 该行 `micros = 0`（非 null）；`aggregate` 的 `pricedRows = filter(micros != null && micros > 0)` 把它排除 → 不计入 `totalMicros`；又因非 NULL → 不计入 `unpricedCalls`。
  - 结果：`costCalls > 0`（板块非空、会投递），但 `totalMicros = 0` 且 `unpricedCalls = 0` → cost 分支两个 `if` 都不命中 → 无片段。若 cost 是昨天唯一非空板块，整行 `renderDigestLine` 返回空串。
- **逐板块对称性核对**（aggregate 非空条件 vs renderDigestLine 产出片段条件）：

  | 板块 | aggregate 非空 | renderDigestLine 产片段 | 对称？ |
  |---|---|---|---|
  | tasks | completed>0 ∨ failed>0 | completed>0 ∨ failed>0 | ✅ |
  | scheduled | total>0 ∨ paused>0 | total>0 ∨ (total=0∧paused>0) | ✅ |
  | watchers | triggered>0 ∨ disabled>0 | triggered>0 ∨ (triggered=0∧disabled>0) | ✅ |
  | approvals | pending>0 | pending>0 | ✅ |
  | **cost** | **costCalls>0（含 0 价）** | **totalMicros>0 ∨ unpricedCalls>0** | **❌（0 价调用落入两者之外）** |
  | openApi | total>0 | total>0 | ✅ |

- **触发场景**：用户昨天只对「免费/0 价模型」（管理员把价格配成 0）发起了 LLM 调用，没有任何任务成败、定时任务、哨兵、审批、开放接口活动。摘要非安静日照常投递，但收件箱条目 `content` 为空串、试发 toast 回退通用文案——「有调用但零成本」这一事实在列表层被隐藏。（若当天还有任一正价调用，`totalMicros>0`，会显示「成本 X」，不触发；故需全部调用都 0 价，场景比 Bug 1 更窄。）
- **探针测试**：`backend-ts/src/digest/zz-review-probe.spec.ts`（2 个用例均失败）
  - 失败输出摘要：
    ```
    AssertionError: expected '' not to be '' // Object.is equality
    ```
    其中 `aggregate` 用例先断言 `data.cost` 等于 `{ totalMicros: 0, unpricedCalls: 0, top: [] }` 且 `isEmpty=false`（证实板块确实非空、会投递），再断言写入条目 `content` 非空——实际为空串。
- **建议修复方向**（不动手）：让 cost 分支与 `costCalls > 0` 对称——当 `cost != null` 但 `totalMicros=0 && unpricedCalls=0` 时也产出片段，例如 `else parts.push('成本 0')` 或 `调用 ${calls} 次（0 价）`（需在 `DigestCost` 带上调用数或在分支内用 `top.length`/另行字段）。修复后应补一条既有 spec 断言「全 0 价 → content 非空」。彻底方案是给 `DigestCost` 增加 `calls` 字段，使「有调用」可直接渲染，不再依赖 totalMicros/unpriced 反推。

---

## 两处修复的复核结论（ reviewer 关注点逐条 ）

### 观察 1 修复：正确
- **LEFT JOIN 语义**：`FROM user u LEFT JOIN user_digest_preference p ON p.user_id = u.id WHERE u.deleted = 0`（`repository.ts`）。`user_digest_preference` 以 `user_id` 为主键，LEFT JOIN 每用户恰好一行（命中或全 NULL）。`notDeleted('u')` → `u.deleted = 0`（`db.ts:122`），`user` 表确有 `deleted` 列（V052），`u.id` 为主键（V001）。`FROM user u` 不加反引号与既有代码一致（`feedback.repository.ts:147`、`statistics.service.ts:96`）。✅
- **映射默认值**：`enabled: row.enabled ?? 1`、`pushTime: row.pushTime ?? DEFAULT.pushTime`、`outboundEnabled: row.outboundEnabled ?? 1`。`??` 只在 null/undefined 时回落，故显式 `enabled=0` 保持 0（不被误抬成 1）。列 DDL 默认（enabled=1 / '09:30' / 1）与 `DEFAULT_DIGEST_PREFERENCE` 一致。✅
- **TS filter 与旧 SQL WHERE 等价性**：旧 `WHERE enabled = 1` = 「有行且 enabled=1」；新 = 「有行且 enabled=1」∪「无行（默认 1）」−「有行且 enabled=0」。正确补上了无行默认开用户，且保留显式开关语义。✅
- **TINYINT 类型**：`row.enabled === 1` 未做 `Number()` 强转，但 mysql2 配置 `bigNumberStrings:false` 且 TINYINT 默认以 JS number 返回；既有代码亦依赖 `agent.enabled === 0` 不做强转（`open-run.service.ts:90` 等），无 string/number 回归。✅
- **`markProcessed` upsert**：`INSERT (user_id, last_digest_date) ... ON DUPLICATE KEY UPDATE last_digest_date = IF(原为 NULL 或更早, 新值, 原值)`。无行用户首次处理落一行（其余列走 DDL 默认 = 默认开/09:30/1），避免每分钟重复聚合；有行用户只推进日期、单调不回退；不触碰 enabled/push_time/outbound_enabled。试发（force）不调 markProcessed，故不会给显式关停用户误建行。✅
- **规模提示（非 bug）**：LEFT JOIN 现返回全部未删除用户（而非仅有偏好行者），每分钟全量载入。在设计声明的「百人」量级可接受；若用户量级上升到很大，需评估（如只查「无行用户 ∪ 有待处理行用户」）。此为设计取舍，不计 bug。

### Bug 1 修复：tasks/scheduled/watchers 正确，cost 残留（见 Bug 2）
- tasks：`completed>0` 才出「完成 N」、`failed>0` 才出「失败 N」，与 `completed===0 && failed===0 → null` 对称；修复了旧的「完成 0」噪声。✅
- scheduled：`total>0` 出「定时任务 N 次」，否则 `paused>0` 出「定时任务暂停 N 个」，与 `total===0 && paused空 → null` 对称。✅
- watchers：`triggered>0` 出「哨兵触发 N」，否则 `disabled>0` 出「哨兵停用 N 个」，与 Bug 1 场景对称（原探针两场景已转正为 service.spec 回归）。✅
- cost：**未完全对称**，残留 Bug 2（见上）。❌

---

## 审查探针文件清单（第 2 轮）

- `backend-ts/src/digest/zz-review-probe.spec.ts`（证明 Bug 2；修复后可删）

## 第 2 轮复查覆盖面

- 两处修复的 diff 全量（`repository.ts` / `service.ts` / `scheduler.ts` 注释 / 两个 spec）。
- `renderDigestLine` 六板块与 `aggregate` 非空规则的逐板块对称性（见表）。
- `listEnabledUsers` LEFT JOIN / notDeleted / user 表结构与保留字 / TINYINT 读型 / filter 等价性。
- `markProcessed` upsert 列默认值路径、单调性、与 force 的交互。
- `cost_micros=0` 的可达性（`computeCostMicros` 返回 0、`llm-call.service.ts:270` 保留 0）。
- 既有 digest 4 个 spec 复跑（54 用例绿），确认修复未破坏基线。
- 第 1 轮已覆盖面（窗口/时区、六板块聚合 SQL、调度器、试发、出站双格式、路由校验、桌面）本次改动未触及，仅复查与修复相关部分，未发现新问题。

---
---

# 附：第 1 轮记录（2026-10-12，审查 `git diff 2e85554d c60657fc`）

> 以下两问题已在 `a903dde7` 修复（Bug 1 修复见上「cost 残留」说明；观察 1 已修复确认无误）。保留备查。

## Bug 1（中，已修复）：哨兵 disabled-only 时收件箱浓缩一行为空
- 位置：`backend-ts/src/digest/service.ts`（原 `renderDigestLine` 对 watchers 门控 `triggered > 0`，与 `aggregate` 的 `triggered>0 || disabled>0` 不对称）。
- 场景：昨天唯一事实是哨兵被连续失败自动停用（`WATCHER_DISABLED`，triggered=0、disabled 非空）→ 摘要投递但浓缩行空串，运维信号在列表层被隐藏。
- 修复：`a903dde7` 增加 `else if (disabled.length>0) 哨兵停用 N 个`；已转正为 service.spec 三条回归。
- 现状：该分支已对称；但同类残留见第 2 轮 Bug 2（cost）。

## 观察 1（已修复确认无误）：决策 11「默认开」对无偏好行用户不生效
- 位置：`repository.ts` 的 `listEnabledUsers`（原 `WHERE enabled=1`）+ V150 无回填。
- 场景：从未改过摘要设置的新/存量用户无偏好行 → 永不进调度 → 永远收不到日报，尽管 UI 显示默认已开启。
- 修复：`a903dde7` 改 LEFT JOIN 全部未删除用户 + 无行套默认 + 映射后 filter；`markProcessed` 改 upsert 懒建行。已确认正确（见上「观察 1 修复：正确」）。
