# 长期记忆「系统淘汰」与「用户忽略」语义分离技术方案

- 状态：草案（2026-11-15，待评审）
- 日期：2026-11-15
- 关联方案：
  - [2026-10-02-long-term-memory-technical-design.md](./2026-10-02-long-term-memory-technical-design.md)（记忆系统总设计；本方案 supersede 其 **D13 负面约束集口径**与 **D14 淘汰落点口径**，其余不变）
  - [2026-11-12-admin-memory-manage-technical-design.md](./2026-11-12-admin-memory-manage-technical-design.md)（admin 忽略路径同受影响，本方案一并覆盖）
- 决策编号：本方案用 **E 系列**，避免与上述文档的 D 系列（代码注释已大量引用 D13/D14）混淆。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 用户忽略 | `status=DISMISSED` 且来源为用户/管理员的显式操作（`applyUpdate` 切状态）。语义：**用户已知晓且明确不要**，永久负面约束 |
| 系统淘汰 | `status=DISMISSED` 且来源为 D14 溢出自动降级（`evictStale`）。语义：**仅容量不足、最近不相关**，不代表用户态度 |
| `dismiss_reason` | 本方案新增列，`VARCHAR(16) NOT NULL DEFAULT 'USER'`：`USER`（用户忽略）/ `EVICTED`（系统淘汰）。只在该行最后一次被置为 DISMISSED 时的动作者上有意义；ACTIVE 期间值陈旧、不读 |
| 复活（M2） | dedup 字节级命中 EVICTED 行时，按 insert 同款名额规则将其恢复为 ACTIVE（E5）；USER 忽略行永远不复活（原 D3 不变） |

## 1. 问题与证据

### 1.1 现状链路：两类 DISMISSED 不可区分

1. D14 溢出淘汰把 AUTO 行置 `DISMISSED`（`memory-extraction.service.ts:327-334` `evictStale` → `updateStatus`），**没有任何"系统行为"标记**；
2. D13 负面约束集查询只按 `status='DISMISSED'` 过滤（`memory.repository.ts:161-165` `listDismissedContents`，注释明示「MANUAL/AUTO 均含」）；
3. 抽取 prompt 对模型说 `<ignored_memories>` 是「用户已忽略的内容：禁止抽取与其语义相近的新记忆」（`memory-extraction.service.ts:37`）——对被淘汰的行该前提不成立：用户从未见过、从未忽略过它。

### 1.2 后果

1. **被淘汰的事实被永久语义封禁**：池满 200 后被挤掉的记忆，即使后续对话中用户反复重申同一事实，抽取器也被 prompt 禁止再沉淀；字节级相同还有 dedup 命中跳过硬挡（`applyDedupHit` 对 DISMISSED 直接 return）。D14「软降级、可恢复」实际只剩用户手动恢复一条路，且恢复入口藏在「已忽略」列表里；
2. **淘汰噪音稀释真实用户意图**：`MEMORY_EXTRACT_DISMISSED_HINT_LIMIT=50` 的窗口被"因空间不足被挤掉"的行占据，用户真正主动忽略的内容反而被挤出窗口，负面约束集越用越不准；
3. **用户心智模型错误**：桌面端「已忽略」列表混显两类行，用户看到自己没操作过的条目出现在"我忽略的"里。

### 1.3 原设计文档自身的矛盾

- 2026-10-02 方案给负面约束集的理由是「**已知悉但已忽略**的内容」（§10.1 表格，第 335 行）——只对用户忽略成立；D14 淘汰是纯容量行为，无"知悉"与"忽略"；
- `MEMORY_EXTRACT_DISMISSED_HINT_LIMIT` 的常量注释（「D14 淘汰会持续产生 DISMISSED 行」）说明设计时已知晓淘汰会涌入该集合，处理方式只是把窗口调大到 50 容纳，未分离语义。

## 2. 目标与非目标

**目标（本期全部交付）**

1. 系统淘汰与用户忽略在数据层可区分（新增 `dismiss_reason` 列）；
2. 负面约束集只含用户忽略行；系统淘汰行退出；
3. 一切用户/管理侧的「置为 DISMISSED」显式写 `USER`，杜绝状态迁移残留（E3）；
4. （M2，独立小批次）dedup 字节级命中 EVICTED 行时按名额规则复活，语义改为按复现的 LRU（E5）；
5. 对外 REST 契约、前端 UI、注入链路零改动。

**非目标**：见 §9 不做清单。

## 3. 方案总览

| 层 | 改动 |
|---|---|
| DB | 一条迁移 `V196__memory_dismiss_reason.sql`：`memory_item` 加列 `dismiss_reason VARCHAR(16) NOT NULL DEFAULT 'USER'`（存量行全部落 `USER`，零 backfill 语句） |
| Repository | `listDismissedContents` 加 `AND dismiss_reason = 'USER'`；`updateStatus` 增加可选 reason 参数；`evictStale` 调用处写 `EVICTED`；`insert` 不加字段（走列默认值） |
| Extraction | 负面约束集自然变纯（查询过滤）；M2：`applyDedupHit` 对 EVICTED 行走复活分支（名额规则复用 `evictStale`）；常量注释更新 |
| Service | `applyUpdate` 在切换为 DISMISSED 时显式写 `dismiss_reason='USER'`（用户域与 admin 方法族共用，一处改） |
| 契约 | **零改动**：`dismiss_reason` 是审计维度不是生命周期状态，`MemoryStatus` 联合保持 `ACTIVE/DISMISSED`，前端 `Record` 穷尽汉化表不动 |
| 前端 | **零改动**（desktop/admin） |
| 文档 | mao-cli `reference/memory.md` 同步（§10）；changelog 碎片随实施任务新增 |
| 测试 | 见 §6 |

不改动：注入链路（`prompt-engine.ts` / `listForInjection`）、注入上限（8+12）、抽取 prompt 结构与文案、`listStaleAuto` 淘汰源查询、桌面/安卓/agent-cli、部署脚本。

## 4. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| E1 | 加 `dismiss_reason` 列而非新增 `EVICTED` 状态枚举 | 淘汰原因属于审计维度，不是生命周期状态（两类行的后续行为差异只在「负面约束」与「复活」两点，用谓词表达即可）。走状态枚举会触发跨端枚举连锁改动：contracts `MemoryStatus` 联合、前端 `Record<MemoryStatus,…>` 穷尽汉化表、路由过滤枚举、`MEMORY_STATUSES`——全为下游不需要感知的维度付代价 |
| E2 | 负面约束集只取 `dismiss_reason='USER'`，淘汰行退出 | 本方案核心。语义对齐：prompt 文案「用户已忽略」从此为真；淘汰噪音不再挤占 50 条窗口 |
| E3 | 列 `DEFAULT 'USER'`，零 backfill；且一切用户/管理侧 →DISMISSED 的写操作**显式**写 `USER`，不依赖默认值 | 存量行无法可靠区分来源，一律视为用户忽略是保守方向（宁可负面约束多留存量行，不放行可能被用户否过的内容）。显式写是为堵边角：行被系统淘汰（EVICTED）→ 用户恢复 → 用户再忽略，若依赖默认值则 `updateStatus` 不动该列，残留 `EVICTED` 导致这条用户明确忽略的内容漏出负面约束 |
| E4 | `evictStale` 显式写 `EVICTED`；`listStaleAuto` 不改 | 淘汰源查询条件 `status='ACTIVE' AND source='AUTO'` 天然排除已淘汰行，无需感知新列 |
| E5 | （M2）dedup 字节级命中 EVICTED 行时复活：按 insert 同款名额规则，组内淘汰最旧 AUTO 行腾名额 → 该行置 ACTIVE 并 touch；组内无可淘汰则放弃（停留原状）；USER 忽略行维持不复活 | 不复活则字节级同文的事实被永久封禁，与 E2 修复后的语义（淘汰=最近不相关，非用户否决）矛盾。复活即「事实复现就该回来」的 LRU。仅走字节级廉价路径，**不让 EVICTED 行进 D13 比较集**（见 §9.2）。收敛性见 §8.1 |
| E6 | `MEMORY_EXTRACT_DISMISSED_HINT_LIMIT=50` 维持不变 | 噪音源消除后 50 条只装真实用户忽略，容量绰绰有余；调小反而提高真实意图被挤出的风险（用户忽略行为是低频事件） |

## 5. 详细设计

### 5.1 迁移 V196

```sql
-- V196: 系统淘汰与用户忽略语义分离——dismiss_reason 标记 DISMISSED 行来源。
-- USER=用户/管理员显式忽略（进负面约束，永不自动复活）；
-- EVICTED=D14 溢出自动淘汰（不进负面约束；M2 起字节级复现可复活）。
-- 存量行无法区分来源，一律 DEFAULT 'USER'（保守口径，见 E3）。

ALTER TABLE `memory_item`
    ADD COLUMN `dismiss_reason` VARCHAR(16) NOT NULL DEFAULT 'USER'
    COMMENT 'DISMISSED 来源：USER=用户/管理员显式忽略；EVICTED=溢出自动淘汰；ACTIVE 期间值陈旧不读';
```

不加新索引：负面约束查询形态与现状相同（`user_id = ? AND status = 'DISMISSED' [+ dismiss_reason]`，LIMIT 50），现有 `idx_memory_user (user_id, scope, status)` 的 `user_id` 前缀已覆盖，`dismiss_reason` 仅为残过滤；该查询频率为每任务收尾一次，无性能压力。

### 5.2 仓储层（memory.repository.ts）

| 方法 | 改动 |
|---|---|
| `listDismissedContents` | SQL 加 `AND dismiss_reason = 'USER'`；注释改写（原「MANUAL/AUTO 均含」口径终止） |
| `updateStatus(id, status, db?)` | 签名加可选 `reason?: 'USER' \| 'EVICTED'`：传了才写 `dismiss_reason = ?`，不传不动该列（复活路径与既有调用零感知） |
| 其余 | `insert`/`touch`/`updateContent`/`listStaleAuto`/注入查询全部不动（新列走 DB 默认值；`MemoryItemRow` 加可选字段 `dismissReason?` 仅用于复活分支读判断） |

### 5.3 服务层（memory.service.ts）

`applyUpdate`（用户域 `update` 与 admin `updateForAdmin` 共用）：

- `statusChanged === 'DISMISSED'` 时，`updateStatus(row.id!, 'DISMISSED', 'USER', tx)`——显式写 USER（E3 边角）；
- 恢复（→ACTIVE）不写 reason（ACTIVE 期间值陈旧不读，下次置 DISMISSED 时会被正确覆盖）。

### 5.4 抽取层（memory-extraction.service.ts）

**M1（负面约束变纯）**：仅因 `listDismissedContents` 过滤而生效，抽取代码零改动；`evictStale` 内 `updateStatus(row.id, 'DISMISSED')` → `updateStatus(row.id, 'DISMISSED', 'EVICTED')`；`MEMORY_EXTRACT_DISMISSED_HINT_LIMIT` 常量注释更新（噪音源已消除）。

**M2（复活，E5）**：`persistCandidates` 的命中分支 `applyDedupHit` 改造：

```
applyDedupHit(userId, dedupHash, activeCount):
  row = findByHash(...)
  row == null                → return
  row.status == ACTIVE       → touch（现状不变）
  row.dismissReason == USER  → return（D3 不变：用户忽略永不复活）
  row.dismissReason == EVICTED:
    activeCount >= LIMIT:
      evicted >= 一轮淘汰上限(3) → return（与 insert 路径同款熔断）
      slotFreed = evictStale(row.scope, row.projectKey)   # 组内最旧 AUTO 行
      !slotFreed → return
      activeCount -= 1
    updateStatus(row.id, 'ACTIVE'); touch(row.id)
    return（activeCount += 1 由调用方记账）
```

- activeCount 记账口径与 insert 路径一致（进程内估算，硬约束仍由手工路径 `assertActiveLimit` 现查兜底）；
- insert 路径的并发撞键分支（`isDuplicateKeyError` → `applyDedupHit`）自动获得同样行为，无需单独处理；
- 抽取 prompt（`EXTRACTION_SYSTEM_PROMPT` / `buildExtractionUserPrompt`）**零改动**：`<ignored_memories>` 文案「用户已忽略」在 M1 后即为事实。

### 5.5 不改动清单

| 层 | 说明 |
|---|---|
| REST | `/v1/memory`、`/v1/admin/memory` 无新参数、无新端点；`MemoryItemVO` 不暴露 `dismissReason` |
| 注入 | `listForInjection` / `prompt-engine.ts` 注入排序与 8+12 上限零改动；前缀缓存无影响（§8.3） |
| 契约/前端 | `shared/contracts`、desktop `MemoryView.vue`、admin `MemoryManageView.vue` 零改动（「已忽略」列表继续混显两类行，见 §9.1） |
| 手工路径语义 | 200 上限显式报错（D14 边界）、dedup 冲突报错、编辑重算哈希均不变 |

## 6. 测试计划

| 文件 | 用例 |
|---|---|
| `memory.repository.spec.ts` | `listDismissedContents` SQL 含 reason 过滤；`updateStatus` 传/不传 reason 的 SQL 断言；不传 reason 不写该列 |
| `memory-extraction.service.spec.ts` | ① evictStale 写 `EVICTED`；② 负面约束集不含 EVICTED 行（repo 返回口径由 ①/仓储用例保证，此处断言 prompt 只含 USER 忽略行）；③ M2 复活四态：EVICTED+有名额 → ACTIVE+touch；EVICTED+满额+可淘汰 → 先淘汰组内最旧再复活；EVICTED+满额+组内无可淘汰 → 放弃；USER 忽略 → 不复活；④ 一轮淘汰上限 3 对复活路径同样生效；⑤ 复活后 activeCount 记账正确 |
| `memory.service.spec.ts` | applyUpdate 切 DISMISSED 显式写 `USER`；「淘汰→恢复→再忽略」序列后 reason 为 `USER`（E3 边角回归） |
| 回归 | 既有 spec 全量通过；涉及 `<ignored_memories>` 组装的用例语义不变（prompt 未改） |

## 7. 交付顺序

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | V196 迁移 + E1–E4（语义分离）+ 测试 + mao-cli 文档同步 | 无 |
| M2 | E5 复活 + 测试 | M1 |

- 两批均为纯 backend-ts，无前端发版；部署 = 合并后 `/opt/mao` pull + backend 重启（Flyway 随 TS 启动执行）；
- M1 独立成立：即使 M2 缓做，淘汰行也已退出负面约束、新措辞可重新进入（2026-10-02 方案 §10.1 已确认负面约束是 prompt 软约束，不构成硬拦截）；
- changelog 碎片随 M1 实施任务新增（backend-ts 小节；用户可见变化：淘汰条目不再被当作「已忽略」，复现事实可重新沉淀）。

## 8. 风险与边界分析

### 8.1 M2 复活的抖动与收敛

担心形态：「淘汰 A → A 复现复活 → 挤掉 B → B 复现复活 → …」无限循环。分析：

- 复活仅由**真实对话复现**触发（每任务收尾至多一轮抽取、至多 3 条候选），ACTIVE 总量恒 ≤ 200；
- 行复活后即进入 D13 比较集，后续复现走 `touch`（仅刷 `updated_at`），无写放大；再次被淘汰需再次出现"满额 + 新候选插入"；
- 故系统收敛于「近期被复现的事实占据名额」——正是期望的 LRU 语义。最坏情形是两个高频事实在满额边界交替进出的有限翻转，两者均真实复现，属正确行为而非失控。

### 8.2 E3 backfill 的保守代价

存量"实际是系统淘汰"的行继续留在负面约束窗口（最多 50 条），直到用户手动清理或物理删除。不做数据修正——无法可靠区分存量行来源，且影响随池子滚动自然衰减，可接受。

### 8.3 前缀缓存

注入排序（`updated_at DESC` 内层截断 + `id ASC` 外层稳定输出）、prompt 段落结构与顺序、`<ignored_memories>` 文案均零改动；抽取 prompt 变化的仅是用户相关的集合内容（本来就会变），无新增不稳定源。

### 8.4 并发窗口

复活与手工恢复并发：`updateStatus` 幂等，重复置 ACTIVE 无害；复活与淘汰并发挤压名额：AUTO 路径本就允许进程内计数瞬时误差（现状 insert 路径同款），硬限额由手工路径现查兜底，不变量不破。

## 9. 不做清单

1. **UI 区分「已忽略/已淘汰」**：`MemoryItemVO` 不暴露 `dismiss_reason`，desktop/admin 列表继续混显。待 M2 落地、复活机制消化掉大部分淘汰行后再评估是否值得展示（届时需走 contracts 下沉 + `Record` 穷尽汉化，本方案不预付该成本）；
2. **EVICTED 行进 D13 比较集**：让模型引用其 id 做 touch/update 复活——prompt 膨胀、口径复杂化，收益仅剩"语义同文但措辞不同的复活合并"；新措辞本就经 E2 放开、以新行插入，功能等价；
3. **DISMISSED 堆积清理 / 过期任务**：已忽略行无限增长是独立问题，另立项；本方案仅止血语义污染；
4. **D15 定期合并整理**（2026-10-02 方案遗留，未实施）：未来实施时若整理动作会降级行，写 `USER` 还是 `EVICTED` 由 D15 方案自行决策，本方案不约束；
5. **embedding / 向量检索**：2026-10-02 方案需求方已决策不做，不再重开。

## 10. 文档同步（随 M1 实施任务同批）

| 文档 | 改动 |
|---|---|
| `skills/mao-cli/reference/memory.md` | 第 17-18 行「忽略…不复活」补口径：系统淘汰条目不进忽略约束、（M2 后）字节级复现可自动恢复；第 24 行淘汰语义补一句来源标记说明 |
| changelog | `changelog/unreleased/2026-MM-DD-memory-dismiss-reason.md`，backend-ts 小节 |
| `README.md` / `DEPLOY.md` | 无涉及，不改 |
| 历史方案 | 2026-10-02 / 2026-11-12 文档不改（历史设计豁免）；superseded 口径已在本文件头部标注 |
