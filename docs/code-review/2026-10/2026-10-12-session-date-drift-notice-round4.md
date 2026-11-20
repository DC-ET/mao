# 会话日期锚定与跨天提示（feat/session-date-drift-notice）round4 复审报告

- 审查对象：commit `bfd49328`（test: 修复 round3 审查发现的浅拷贝陷阱测试未触及数组分支的问题）
- 完整需求改动：`git log 9d2c9966..HEAD` 共 4 个 commit（`c8451579` 功能 / `156c0121` 修复 / `2eddae13` 测试修复 / `bfd49328` 测试修复）
- 工作区：`/opt/mao-data/workspace/2/projects/mao/.worktrees/session-date-drift-notice`
- 审查日期：2026-10-12
- 审查方式：只读审查 + 独立复现反向篡改验证 + 用例约束性分析（验证后已全部还原）

---

## 1. 总体结论

**无 bug，可以合并。**

round3 指出的覆盖缺口已正确修复，且修复方式比我建议的更进一步：用例改用真正的多模态数组 content，并对「原数组 length / 元素引用 / 原对象字段 / 副本 length / 标签位置 / 副本保留原 part 引用与顺序」六个维度做了断言。

我按与 round1 一致的标准，把 4 个 commit 的累计 diff 通读了一遍，并独立复现了篡改验证、分析了新用例的约束性。**未发现任何未修复的功能性问题，也未发现未守住的测试。**

`npm run build` 通过；`npm test` 全量 **301 files passed / 1 skipped，3777 tests passed / 14 skipped**，与你的验证状态一致。

---

## 2. 逐项复核结论

### 2.1 篡改验证独立复现（复审要求 1）

未采信你的描述，完整复现四步闭环：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 0 | 记录 `session-date-notice.ts` md5 = `ebd852c2…`，与 `git show HEAD:` 一致 | 基线一致 |
| 1 | 未篡改先跑 `session-date-notice.spec.ts` | ✅ 18 passed |
| 2 | 篡改：数组分支 `{ ...msg, content: [tag, ...content] }` → 原地 `(msg.content as unknown[]).unshift(...)` | — |
| 3 | 跑 `session-date-notice.spec.ts` | ❌ **1 failed**：`does not mutate the original nested content array (shallow-copy trap)` → `expected [ { type: 'text', …(1) }, …(2) ] to have a length of 2 but got 3` |
| 4 | 从备份恢复，`current` / `gitHEAD` / `backup` 三方 md5 全部 = `ebd852c2…` | ✅ ALL MATCH |
| 5 | 重跑 | ✅ 18 passed |

**结论：你的篡改验证成立。** 该用例现在能精确捕获「数组分支被改回原地 unshift」这一回归，且失败信息直指 `originalContent` 长度，定位清晰。

### 2.2 新用例是否「为过而过」（复审要求 2）

用探针逐条分析其断言绑定的约束，结论：**绑定的是真实业务约束，不是实现细节。**

| 断言 | 绑定的业务约束 |
|---|---|
| `expect(originalContent).toHaveLength(2)` | 原嵌套数组不被原地追加（本需求核心安全属性：标签只写副本，不污染 `context.messages`） |
| `expect(originalContent[0]).toBe(imageA)` / `[1]).toBe(imageB)` | 原数组顺序与元素不被替换 |
| `expect(original[0].senderYmd).toBe('2026-10-13')` | 原对象其余字段不丢（与 L-2 修复同源） |
| `expect(copied).toHaveLength(3)` | 标签确实被注入请求副本（功能本身生效，非空跑） |
| `expect(copied[0].type).toBe('text')` + `toContain('<date-change>')` | 标签位于正文最前（方案 §5.3 要求的注入位置） |
| `expect(copied[1]).toBe(imageA)` / `[2]).toBe(imageB)` | 副本保留原 part 引用与顺序（既防止浅拷贝共享导致的污染，也防止深拷贝丢引用） |

补充验证：构造了一个**不等价但同样正确**的替代实现（新建 content 数组而非展开运算符），该用例同样通过——说明它约束的是行为契约而非某一种写法。

唯一需要说明的边界：`toBe(imageA)` 引用断言会排除「深拷贝 content」的实现。但深拷贝同样满足「不污染原数组」这一核心业务约束，属可接受替代方案。当前实现未采用深拷贝，此断言固化了现状；由于深拷贝对本场景（content part 是小对象、无循环引用）没有额外收益，且会改变 `TokenEstimator` 等下游对 part 的身份假设，**不视为过严**。

### 2.3 四 commit 整体通读确认（复审要求 3）

生产代码累计改动（已通读，非抽样）：

| 文件 | 内容 | 状态 |
|---|---|---|
| `session.repository.ts` | 新增 `selectFirstUserStamp` / `selectPreviousUserStamp`，SQL 口径与既有 `selectUserStamps`/`selectLastUserMessage` 一致（`role='USER'` + `notDeleted()` + `LIMIT 1`，一 ASC 一 DESC） | ✅ |
| `session.service.ts` | 两个薄委托方法 | ✅ |
| `deps.ts` | `getFirstUserStamp?` / `getPreviousUserStamp?` 可选声明，与 `getLastUserMessage?` 同形态 | ✅ |
| `session-history-loader.ts` | `toChatMessage` 下发 `senderYmd`；`resolvePreviousUserYmdBefore` 带 try-catch + 长度校验；`applyHistory` 装载不受其影响 | ✅ |
| `agent-execution-context.ts` | `currentTimestamp` → `sessionBaseYmd`，新增 `previousUserYmdBefore` | ✅ |
| `harness-service.ts` | `resolveSessionBaseYmd` 锚点解析 + 五重兜底 | ✅ |
| `prompt-engine.ts` | 接入点顺序（marker 展开 → 跨天标签 → 媒体注入 → 归一化）；marker 展开保字段；`currentDateHint` 文案；`formatChineseWeekday` 改为 import | ✅ |
| `session-date-notice.ts` | 纯函数 + 标签文案 + 数组分支显式 `ContentPart[]` 类型 | ✅ |
| `chat-request.ts` | `senderYmd` 内部字段声明 | ✅ |

最终整体检查项：

- **无 `currentTimestamp` 残留**：全仓（backend-ts / agent-cli / desktop / admin / shared）grep 无匹配，字段改名彻底
- **三个新字段的引用点收敛**：`sessionBaseYmd` / `previousUserYmdBefore` / `senderYmd` 仅出现在预期的 6 个 harness 文件内，无越界扩散
- **零副作用达成**：`git diff 9d2c9966..HEAD` 对 `desktop/src` / `admin/src` / `android` / `shared` / `backend-ts/db/migration` 均无改动（与方案 §6「不改」清单一致）
- **CHANGELOG 与版本号一致**：`CHANGELOG.md` 顶部 `## 0.0.285 (2026-10-12)` 与 `desktop/package.json` 的 `0.0.285` 匹配
- **全仓 `formatChineseWeekday` 仅一份定义**（`session-date-notice.ts`），`prompt-engine.ts` 走 import，无重复实现
- **`npm run build`（tsc）通过**，类型收窄未引发编译错误
- **全量测试**：301 files passed / 1 skipped，3777 tests passed / 14 skipped

按 round1 标准的最终判断：H-1（容错缺失）、L-1（重复实现）、L-2（类型断言）、M-1（回注边界）四类问题均已在对应轮次修复；round2 发现的测试假有效、round3 发现的用例名不副实，均已在后续轮次修复并经我独立篡改验证确认。**无遗留。**

### 2.4 工作区清洁度（复审要求 4）

- `git status`：**nothing to commit, working tree clean**
- `git diff HEAD --stat`：**为空**
- 我的临时探针 `zz-r4-probe.spec.ts` 已删除；`find backend-ts/src -name "zz-*"` 仅剩 4 个 `zz-logicbug-probe.spec.ts`（`model`/`weixin`/`analytics`/`schedule`），经 `git ls-tree 9d2c9966` 确认**基线前就已存在**、且 `git diff 9d2c9966..HEAD -- '*zz-logicbug*'` 为空——属更早需求的历史回归测试，**不是我的探针，与本次需求无关**
- 被篡改的 `session-date-notice.ts` 已还原，与 `git show HEAD:` md5 一致
- `/tmp` 下的备份文件已清理

---

## 3. 结论

**无 bug，可以合并。**

本次需求（会话日期锚定首条用户消息 + 跨天 `<date-change>` 标签）经四轮审查，功能实现正确、容错完备、零副作用达成、测试有效。累计发现并修复 6 个问题（1 高 / 1 中 / 4 低），最后一轮无新问题。

---

## 4. 变更历史

- 2026-10-12 round1：1 高（H-1 `resolvePreviousUserYmdBefore` 无容错，DB 抖动打挂会话）/ 1 中（M-1 回注边界）/ 2 低（L-1 `formatChineseWeekday` 重复实现、L-2 `as unknown` 断言）
- 2026-10-12 round2：H-1 / L-1 / L-2 已修复；M-1 固化现状；新发现 1 低（`applyHistoryIgnoresUnparseablePreviousUserStamp` 假有效）
- 2026-10-12 round3：round2 问题已修复；新发现 1 低（`does not mutate the original nested content array` 用例 content 实为字符串，未触及数组分支）
- 2026-10-12 round4：round3 问题已修复并经独立篡改验证；四 commit 整体通读无遗留问题
