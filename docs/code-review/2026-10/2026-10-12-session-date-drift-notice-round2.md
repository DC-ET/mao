# 会话日期锚定与跨天提示（feat/session-date-drift-notice）round2 复审报告

- 审查对象：commit `156c0121`（fix: 修复 round1 审查发现的 4 个问题）
- 基线 commit：`c8451579`（feat: 会话日期锚定首条用户消息，跨天由用户消息前 date-change 标签承载）
- 工作区：`/opt/mao-data/workspace/2/projects/mao/.worktrees/session-date-drift-notice`
- 审查日期：2026-10-12
- 审查方式：只读审查 + 临时 vitest 探针验证 + **反向篡改源码验证测试有效性**（验证后已全部还原，`git status` 干净、`git diff HEAD` 为空）

---

## 1. 总体结论

**无功能性 bug，可以合并。**

round1 的 4 项修复全部正确落地：

| 项 | 结论 | 验证方式 |
|---|---|---|
| H-1 `resolvePreviousUserYmdBefore` 容错 | ✅ 已修复，异常路径覆盖完整 | 13 条异常路径逐一探针验证 |
| L-1 `formatChineseWeekday` 去重 | ✅ 已修复，行为与去重前逐字节一致 | 30 个输入用例新旧实现比对 |
| L-2 数组分支 `as unknown` | ✅ 已修复，无字段丢失 | 全字段保留 + 多 part 顺序探针 |
| M-1 边界行为固化 | ✅ 按建议保持现状并补测试 | 反向篡改验证测试有效 |

`npm run build` 通过；`npm test` 全量 **305 files passed / 1 skipped，3811 tests passed / 14 skipped**（比 round1 的 301/3774 多出的部分是本轮新增测试，另有我自己的探针文件已删除）。

仅发现 **1 个低优先级测试覆盖缺口**（不阻塞合并），见 §2 L-1。

---

## 2. 问题列表

### 低（不阻塞合并）

#### L-1 新增测试 `applyHistoryIgnoresUnparseablePreviousUserStamp` 名不副实，未覆盖其声称的场景

- **位置**：`backend-ts/src/harness/core/core-helpers.spec.ts:334-351`（round2 新增）
- **问题描述**：
  该测试名为「IgnoresUnparseablePreviousUserStamp」（忽略不可解析的上一条用户消息时钟戳），但 mock 的输入是 `createdAt: ''`（空字符串）。而 `resolvePreviousUserYmdBefore` 的处理是：

  ```ts
  const ymd = previous?.createdAt ? String(previous.createdAt).slice(0, 10) : '';
  return ymd.length === 10 ? ymd : null;
  ```

  `''` 是 falsy，走 `?: ''` 短路分支——**round1 尚未加长度校验的 `previous?.createdAt ? ... : null` 写法对 `''` 同样返回 null**。也就是说这条测试无法区分「有长度校验」与「无长度校验」两种实现，本轮真正新增的 `ymd.length === 10` 那行保护逻辑**没有被任何测试覆盖**。

  真正需要覆盖的是「`createdAt` 非空但长度不足 10 / 不是日期」的脏数据（如 `'2026-10-1'`、`'2026/10/12'`、`null`、数字型 `1234567890`）。

- **为什么是 bug（业务影响）**：
  测试声称守护的回归点实际处于无保护状态。`created_at` 是 `DATETIME` 列 + `dateStrings: true` 读出，正常恒为 `YYYY-MM-DD HH:mm:ss`；但若将来有人改动 db 配置（关掉 `dateStrings`）、或接入导入/迁移数据带了非标 `created_at`，脏字符串会直接成为 `previousUserYmdBefore`，进而让跨天标签与一条「假日期」比较——标签内容会显示 `2026-10-1（未知）` 这种乱码日期发给模型。有长度校验的代码是对的，只是没有测试守住它。

- **验证用测试用例**（已通过反向篡改确认缺口真实存在）：
  第一步，把源码的 `ymd.length === 10 ? ymd : null` 篡改回 round1 写法，现有测试**全绿**（假通过）：
  ```bash
  # 篡改：删除长度校验
  sed -i "s|    const ymd = previous?.createdAt ? String(previous.createdAt).slice(0, 10) : '';\n    return ymd.length === 10 ? ymd : null;|    return previous?.createdAt ? String(previous.createdAt).slice(0, 10) : null;|" \
    backend-ts/src/harness/core/session-history-loader.ts
  npx vitest run src/harness/core/core-helpers.spec.ts -t "applyHistoryIgnoresUnparseablePreviousUserStamp"
  # 实际结果：1 passed  ← 应该失败才对
  ```

  第二步，补上真正有效的用例后，同样篡改下应当失败：
  ```ts
  it('applyHistoryIgnoresMalformedPreviousUserStamp', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((_s: string | null, inc: ChatMessage[]) => [...inc]),
    } as unknown as ContextManager;
    // 非空但长度不足 10 的脏 created_at：必须降级为 null，不能当日期用
    const sessionService = {
      getPreviousUserStamp: vi.fn().mockResolvedValue({ id: 4, createdAt: '2026-10-1' }),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    context.sessionId = 42;

    await loader.applyHistory(context, null, {
      snapshotMessageIds: [9],
      normalizedEntities: [{ id: 9, role: 'USER', content: 'hi', createdAt: '2026-10-13 08:00:00' }],
      persistedMessages: [PersistedChatMessage.from(9, { role: 'user', content: 'hi', senderYmd: '2026-10-13' })],
    });

    expect(context.previousUserYmdBefore).toBeNull();
  });
  ```
  已实测：该用例在当前（正确）代码下通过；在删除长度校验的篡改版本下失败并报 `expected '2026-10-1' to be null`。

- **修复建议**（交给后续 worker）：
  把现有 `applyHistoryIgnoresUnparseablePreviousUserStamp` 的 mock 输入从 `createdAt: ''` 改为长度不足 10 的脏值（或在其后追加上述新用例），让长度校验逻辑真正被测试守住。仅此一处，无需改产品代码。

---

## 3. 逐项复核结论

### 3.1 H-1 try-catch 异常路径覆盖（复审要求 1）

`session-history-loader.ts:84-103` 现实现：

```ts
private async resolvePreviousUserYmdBefore(context, history): Promise<string | null> {
  if (context.sessionId == null || this.sessionService.getPreviousUserStamp == null) return null;
  const firstUser = history.normalizedEntities.find((m) => m.role?.toUpperCase() === 'USER' && m.id != null);
  if (firstUser?.id == null) return null;
  let previous: Pick<Message, 'id' | 'createdAt'> | null = null;
  try {
    previous = await this.sessionService.getPreviousUserStamp(context.sessionId, firstUser.id);
  } catch (e) {
    harnessLog('warn', `Failed to resolve previous user stamp for session ${context.sessionId}: ${(e as Error).message}`);
    return null;
  }
  const ymd = previous?.createdAt ? String(previous.createdAt).slice(0, 10) : '';
  return ymd.length === 10 ? ymd : null;
}
```

13 条路径逐一探针验证，全部正确降级且 `applyHistory` 不抛错、消息正常装载：

| # | 场景 | 结果 |
|---|---|---|
| 1 | `getPreviousUserStamp` 未挂载（`{}`） | null，messages 正常 |
| 2 | `getPreviousUserStamp === undefined` | null，messages 正常 |
| 3 | `getPreviousUserStamp === null` | null，messages 正常 |
| 4 | `context.sessionId === null` | null，且查询未被调用 |
| 5 | 窗口内无 USER（`firstUser.id == null`） | null，查询未被调用 |
| 6 | 查询 reject | null + warn 日志，messages 正常 |
| 7 | 查询同步 throw（非 Promise） | null + warn 日志，messages 正常 |
| 8 | 返回 `null`（边界前无用户消息） | null |
| 9 | `createdAt: ''` | null |
| 10 | `createdAt: null` | null |
| 11 | `createdAt: '2026-10-1'`（长度不足 10） | null |
| 12 | `createdAt: 1234567890`（数字） | `'1234567890'`（长度 10，被当日期）— 见下方说明 |
| 13 | `createdAt: Date` 对象 | `'Mon Oct 12'`（`String(date)` 前 10 位）— 见下方说明 |
| 正常 | `createdAt: '2026-10-12 23:59:00'` | `'2026-10-12'` |

**关于路径 12/13 的说明**：`createdAt` 非字符串时 `String()` 后的前 10 位会被当作日期。但这两种情况在当前配置下不可达——`db.ts:104` `dateStrings: true` 保证 `DATETIME` 列恒读出字符串，且 `Message.createdAt` 类型声明就是 `string | null`。与 `harness-service.resolveSessionBaseYmd`（同样用 `String(...).slice(0,10)` + 长度校验）口径一致，属既有约定而非本轮引入。**不计为 bug**。

**压缩路径放大效应已消除**（round1 报告的核心论点）：
- 修复后：`compact` 在 `getPreviousUserStamp` reject 时正常返回 `true`，压缩结果与事件正常落账，仅 `previousUserYmdBefore` 降级为 null。
- 对照组（复刻 round1 无 try-catch 的实现）：同样条件下抛 `CompactionStateReloadException`。
两者均已实测验证，H-1 修复到位。

### 3.2 L-1 去重后的行为一致性（复审要求 2）

旧实现（round1 的 prompt-engine 本地副本）与新实现（session-date-notice）差异点：

| 维度 | 旧实现 | 新实现 | 是否构成行为回退 |
|---|---|---|---|
| 空值短路 | `!hasText(isoDate)` → `value != null && value.trim().length > 0` | `ymd == null \|\| ymd === ''` | **否**。已用 30 个输入（含 `''`/`' '`/`'\t'`/`'\n'`/`null`/`undefined`）逐一比对，输出完全一致：纯空白串两者都返回 null（`' '` → `split('-')` 得 `[NaN]` → `!y` → null），无需 trim 也能得到同样结果。 |
| try-catch + harnessLog | 有 | 无 | **否**。函数体内 `split`/`map(Number)`/`Date.UTC` 对任意字符串输入都不会抛（`Number('abc')` 得 `NaN`，`!NaN` 为 true 走 return null；`Date.UTC` 对越界值返回 Invalid Date，`getUTCDay()` 返回 `NaN`，`WEEKDAYS[NaN]` 为 `undefined`，不会抛）。30 个用例（含 `'not-a-date'`、`'2026-13-45'`、`'0000-01-01'`、`'9999-12-31'`、`'--'`、`'1-1-1'`、`'2026-02-30'`）无一触发异常路径，因此去掉 try-catch 不改变任何可观测行为，只是少了一条永不执行的 warn 日志。 |
| 参数名 | `isoDate` | `ymd` | 否，纯命名 |

残留引用检查：
- `prompt-engine.ts` 已无本地 `WEEKDAYS` 常量与本地 `formatChineseWeekday` 定义，唯一使用点 `:429` 走 import。
- `harnessLog`、`hasText` 在 `prompt-engine.ts` 中仍被其他代码使用（`:201/:222/:616` 与 `:254/:262/:269/:273`），import 未失效，无 unused import。
- 全仓 `formatChineseWeekday` 定义仅剩 `session-date-notice.ts` 一份（`session-date-notice.spec.ts` 的用例同时守护两边语义）。

系统提示日期节的实际渲染（精确到该节首行）：
- `sessionBaseYmd: '2026-10-12'` → `当前日期：\`2026-10-12\`（星期一）`
- `sessionBaseYmd: 'not-a-date'` → `当前日期：\`not-a-date\``（不带星期）
- `sessionBaseYmd: '   '` → `当前日期：\`   \``（不带星期）
- 跨天标签遇脏 `senderYmd: 'garbage'` → `garbage（未知）`（`buildDateChangeTag` 的 `?? '未知'` 兜底生效）

### 3.3 L-2 类型改动（复审要求 3）

`session-date-notice.ts:46` 改为：

```ts
messages[i] = Array.isArray(msg.content)
  ? { ...msg, content: [{ type: 'text', text: tag }, ...(msg.content as ContentPart[])] }
  : { ...msg, content: `${tag}\n\n${stringifyContent(msg.content)}` };
```

探针验证：
- 数组分支保留 `senderYmd` / `name` / `role` / `audio` / `reasoningContent` 全部字段。
- 多 part 场景顺序正确：`[text(tag), text(原文1), image, text(原文2)]`，原 part 对象引用不变（`parts[1]` 仍是原对象）。
- 原 `content` 数组长度不变（浅拷贝陷阱回归仍成立）。
- 字符串分支字段同样完整保留（`name` / `toolCallId` / `senderYmd`）。
- `npm run build`（tsc）通过，类型收窄未引发编译错误。

### 3.4 新增 3 条测试的有效性（复审要求 4）

采用**反向篡改源码**的方式验证（而非仅看绿）：

| 测试 | 篡改方式 | 结果 | 判定 |
|---|---|---|---|
| `applyHistoryDegradesToNullWhenPreviousUserStampQueryFails` | 删掉 try-catch（回到 round1） | ❌ 失败 | ✅ 真实有效 |
| `applyHistoryIgnoresUnparseablePreviousUserStamp` | 删掉 `ymd.length === 10` 校验 | ✅ **仍通过** | ⚠️ 假有效（见 §2 L-1） |
| `回注的窗口外用户消息排在尾部…（边界行为固化）` | 让 `previousUserYmdBefore` 改为参照回注消息 | ❌ 失败 | ✅ 真实有效 |

三条测试的 mock 均与真实签名一致（`getPreviousUserStamp(sessionId, beforeId)`、`getLastUserMessage(sessionId)`），断言与实际行为相符（已核对 `context.messages` 的 role 序列与 `senderYmd` 值）。

### 3.5 round1「已核实无问题」清单回归（复审要求 5）

全部重新探针验证，无回归：

- 浅拷贝陷阱：`context.messages` 与嵌套 content 数组均不被污染，副本与原数组非同一引用
- `senderYmd` 不外泄：chat-completions（`serializeChatRequest`）/ anthropic（`convertMessages`）/ responses（`convertMessages`）三个请求体均不含 `senderYmd`
- `replaceQuickCommandMarkers` 保字段：marker 展开后 `senderYmd` 保留，跨天标签正常，`context.messages` 原文未被污染（M-13）
- `previousUserYmdBefore` 取窗口内第一条 USER 的 id：查询参数为 `(sessionId, firstUserId)`，孤儿 TOOL 丢弃不影响 USER id 选取
- 压缩严格前缀不变量：`deriveRequest` 派生请求前缀与主请求一致，标签随副本进入
- `isRealUserMessage`：带标签消息判真实，`<system-notice>` 前缀仍判非真实
- 锚点兜底五路径（无用户消息 / `createdAt` 空 / 长度不足 / 查询抛错 / deps 未挂载）→ 全部回落 `shanghaiYmd()`
- `buildRequest` 幂等：连续两次逐字节相同
- 同日多轮无标签、前缀逐字节不变
- `sessionBaseYmd` 缺失：不渲染日期节、不打标签
- manifest token 统计读 `normalized`，标签计入「会话消息」节
- 全量回归：305 files passed / 1 skipped，3811 tests passed / 14 skipped

---

## 4. 变更历史

- 2026-10-12 round1：发现 1 高（H-1 容错缺失）/ 1 中（M-1 回注边界）/ 2 低（L-1 重复实现、L-2 类型断言）
- 2026-10-12 round2：H-1 / L-1 / L-2 已修复并验证；M-1 按建议固化现状；新发现 1 低（L-1 测试覆盖缺口，不阻塞合并）
