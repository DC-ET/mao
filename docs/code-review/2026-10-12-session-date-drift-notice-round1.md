# 会话日期锚定与跨天提示（feat/session-date-drift-notice）代码审查报告

- 审查对象：commit `c8451579`（feat: 会话日期锚定首条用户消息，跨天由用户消息前 date-change 标签承载）
- 工作区：`/opt/mao-data/workspace/2/projects/mao/.worktrees/session-date-drift-notice`
- 技术方案：`docs/plan/2026-10-12-session-date-drift-notice-technical-design.md`
- 审查日期：2026-10-12
- 审查方式：只读审查 + 临时 vitest 探针验证（验证后已删除，`git status` 干净）

---

## 1. 总体结论

**可以合并，但建议先修复 1 个高优先级问题（阻塞项 1 个）。**

本次改动整体实现质量高：纯函数 `applyDateChangeNotices` 的浅拷贝陷阱、`senderYmd` 不外泄到三个协议适配器、`replaceQuickCommandMarkers` 保字段、锚点兜底路径等核心设计点均正确落地，且全量 `backend-ts` 测试（3774 passed / 14 skipped）全绿。

但发现 1 个会实质影响业务可用性的缺陷：`SessionHistoryLoader.applyHistory` 在解析「压缩边界前日期参照」时**未对该可选查询做 try-catch 容错**，而同一 commit 的锚点解析 `resolveSessionBaseYmd` 是做了容错的。一个纯提示增强功能的 DB 抖动，会把整个会话启动 / 压缩流程打挂。

---

## 2. 问题列表

### 高（阻塞）

#### H-1 `resolvePreviousUserYmdBefore` 查询失败未容错，DB 抖动会打挂会话启动与压缩流程

- **位置**：`backend-ts/src/harness/core/session-history-loader.ts:84-93`（`resolvePreviousUserYmdBefore`），调用点 `:51`
- **问题描述**：
  `applyHistory` 在重建上下文时调用 `resolvePreviousUserYmdBefore`，后者直接 `await this.sessionService.getPreviousUserStamp(...)`，没有 try-catch。而同一 commit 中 `harness-service.ts:494-500` 的 `resolveSessionBaseYmd`（同样是 DB 查询）是包了 try-catch 并 warn 降级的——说明作者已识别「日期相关查询不能阻断会话」这一约束，但只对锚点做了，漏了边界参照这条。

  该调用在 `applyHistory` 内处于关键路径上：`buildContext`（`harness-service.ts:328`）与压缩重载（`session-compaction-orchestrator.ts:103`）都会执行。查询抛错时异常直接向上传播：
  - `buildContext` 路径：`buildContext` 是 `try { ... } catch { closeBoundCloudMcp; throw e }`，最终 `execute` 抛出 → WS handler 报错，用户这一轮完全无法发起对话。
  - 压缩路径：异常发生在 `applyHistory`（`contextApplied` 仍为 `false`），被 `catch` 包装成 `CompactionStateReloadException`（`session-compaction-orchestrator.ts:141`）抛出。即便压缩 LLM 调用与 CAS 持久化**已成功**，用户侧看到的是「会话压缩状态已发生变化但无法重新加载，请稍后重试」。

- **为什么是 bug（业务影响）**：
  该功能是「零副作用」设计的提示增强，方案 §8 风险表也明确写了「依赖未挂载 → 降级且不报错」。查询失败时的预期行为应是 `previousUserYmdBefore = null`（回落 `sessionBaseYmd` 比较，只是少一次跨边界判日期），而不是让整个会话不可用。真实场景：MySQL 主从切换、连接池耗尽、慢查询超时——这些抖动期间，**所有走 `buildContext` 的会话都会启动失败**，影响面远大于「跨天提示偶尔不准」。

  更讽刺的是：失败时连「日期锚定」本身也会失效，因为 `resolveSessionBaseYmd` 的结果还没用上，会话就已经起不来了。

- **验证用测试用例**（已通过临时探针验证）：
  ```ts
  // backend-ts/src/harness/core/zz-probe.spec.ts（临时验证用，已删除）
  import { describe, expect, it, vi } from 'vitest';
  import { SessionHistoryLoader } from './session-history-loader.js';
  import { CompactionArchiveService } from './compaction-archive.service.js';
  import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
  import { AgentExecutionContext } from './agent-execution-context.js';
  import { PersistedChatMessage } from './persisted-chat-message.js';
  import type { ContextManager } from './context-manager.js';
  import type { SessionService } from '../deps.js';

  const archiveService = new CompactionArchiveService(
    RuntimeDataResolver.forTest('/nonexistent', '/nonexistent'));

  it('getPreviousUserStamp 抛错时 applyHistory 应降级为 null 而非抛出', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((_s: string | null, inc: never[]) => [...inc]),
    } as unknown as ContextManager;
    const sessionService = {
      getPreviousUserStamp: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    context.sessionId = 42;

    await loader.applyHistory(context, null, {
      snapshotMessageIds: [9],
      normalizedEntities: [{ id: 9, role: 'USER', content: 'hi', createdAt: '2026-10-13 08:00:00' }],
      persistedMessages: [PersistedChatMessage.from(9, { role: 'user', content: 'hi', senderYmd: '2026-10-13' })],
    });

    // 期望：降级后正常装载，previousUserYmdBefore 回落 null
    expect(context.previousUserYmdBefore).toBeNull();
    expect(context.messages).toHaveLength(1);
  });
  ```
  **实际结果**：该测试在当前代码下 `await expect(loader.applyHistory(...)).rejects.toThrow('db down')` 成立——即异常确实传播。修复后上述断言才应通过。

  另外可验证压缩路径的放大效应（也已验证）：`SessionCompactionOrchestrator.compact` 成功后 `applyHistory` 内抛错 → 整个 compact 以 `CompactionStateReloadException` 拒绝，而非正常返回 `true`。

- **修复建议**（交给后续 worker，本次不改）：
  在 `resolvePreviousUserYmdBefore` 内包 try-catch，与 `harness-service.resolveSessionBaseYmd` 同构：查询失败仅 `harnessLog('warn', ...)` 并返回 `null`，让功能降级为「只锚定不提示」。同时在 `core-helpers.spec.ts` 的 `SessionHistoryLoader` describe 块补一条「查询抛错降级」用例（与已有的 `applyHistoryToleratesMissingPreviousUserStampDependency` 并列）。

---

### 中

#### M-1 `previousUserYmdBefore` 与「回注的窗口外用户消息」组合时，日期参照语义不完整

- **位置**：`backend-ts/src/harness/core/session-history-loader.ts:51` 与 `:84-93`
- **问题描述**：
  `resolveLatestUserMessage`（`:66-77`）会在「窗口内无真实用户消息 + 有 summary」时，从 DB 取**窗口外**的最后一条真实用户消息，经 `prependSessionSummary` 回注到 `context.messages` **尾部**（`compaction-service.ts:289-296`）。这条回注消息同样带 `senderYmd`（由 `toChatMessage` 生成）。

  但 `resolvePreviousUserYmdBefore` 只看 `history.normalizedEntities`（即窗口内消息），不看回注消息。于是出现：
  - 窗口内无 USER → `previousUserYmdBefore = null` → `applyDateChangeNotices` 的 `previousYmd` 初值 = `sessionBaseYmd`（首条用户消息日期，可能很早）
  - 回注的窗口外用户消息排在 `context.messages` 里**唯一的 user 位置**，它的 `senderYmd` 与 `sessionBaseYmd` 比较

  已通过探针确认：窗口内仅 ASSISTANT（10-13 / 10-14），回注消息是 id=2、日期 10-11，则 `context.messages = [assistant(10-13), assistant(10-14), user(10-11)]`，`previousUserYmdBefore = null`。`applyDateChangeNotices` 会拿 `10-11` 与 `sessionBaseYmd`（假设 10-11）比较 → 同日 → 不打标签。这个场景下行为其实是对的（回注消息日期通常与锚点同源）。

  真正的问题在于**顺序倒挂**：回注消息在 `context.messages` 尾部，而它的 id 远小于窗口内消息。若某次编辑/截断后，回注消息日期（如 10-12）晚于锚点日期（10-11，锚点来自被截断前的更早首条），`applyDateChangeNotices` 会在这条「旧消息」上打一个 `<date-change>2026-10-12</date-change>` 标签——而它并不是「新日期的第一条消息」，只是被回注到尾部。标签语义上没错（确实跨天了），但触发点与方案设计的「跨天只由下一条用户消息承载」不完全一致，属于边界噪音，不会造成功能错误。

- **为什么是 bug**：不造成功能错误或崩溃，但会让「跨天标签出现的位置」在压缩回注场景下不完全符合方案 §5.3 的预期，增加调试时的心智负担。方案 §7 测试要点也未覆盖此组合。

- **验证用测试用例**（已验证组合行为）：
  ```ts
  it('窗口外回注用户消息 + previousUserYmdBefore=null 时的日期链', async () => {
    const contextManager = {
      prependSessionSummary: vi.fn((_s, inc, _h, latestUser) => [...inc, ...(latestUser ? [latestUser] : [])]),
    } as unknown as ContextManager;
    const sessionService = {
      getLastUserMessage: vi.fn().mockResolvedValue({ id: 2, role: 'USER', content: '旧问题', createdAt: '2026-10-11 10:00:00' }),
      getPreviousUserStamp: vi.fn().mockResolvedValue(null),
    } as unknown as SessionService;
    const loader = new SessionHistoryLoader(sessionService, contextManager, archiveService);
    const context = new AgentExecutionContext();
    context.sessionId = 42;
    await loader.applyHistory(context, '压缩摘要', {
      snapshotMessageIds: [11, 13],
      normalizedEntities: [
        { id: 11, role: 'ASSISTANT', content: 'a', createdAt: '2026-10-13 08:00:05' },
        { id: 13, role: 'ASSISTANT', content: 'b', createdAt: '2026-10-14 09:00:05' },
      ],
      persistedMessages: [
        PersistedChatMessage.from(11, { role: 'assistant', content: 'a', senderYmd: '2026-10-13' }),
        PersistedChatMessage.from(13, { role: 'assistant', content: 'b', senderYmd: '2026-10-14' }),
      ],
    });
    // 当前实际：messages = [assistant(10-13), assistant(10-14), user(10-11)]，previousUserYmdBefore = null
    expect(context.previousUserYmdBefore).toBeNull();
    expect(context.messages.map((m) => m.role)).toEqual(['assistant', 'assistant', 'user']);
    expect(context.messages[2].senderYmd).toBe('2026-10-11');
  });
  ```

- **修复建议**：可不改（行为无害）；若要严格对齐方案语义，可在 `resolveLatestUserMessage` 回注成功时，把该消息的 `senderYmd` 也纳入 `previousUserYmdBefore` 的判定（即回注消息存在时以其日期为初值）。鉴于影响仅为「标签出现位置的边界噪音」，**建议保持现状并在方案 §7 补一条测试固化当前行为**，避免后续误改。

---

### 低

#### L-1 `session-date-notice.ts` 与 `prompt-engine.ts` 各自重复实现 `formatChineseWeekday` / `WEEKDAYS`

- **位置**：`backend-ts/src/harness/core/session-date-notice.ts:57-66` vs `backend-ts/src/harness/core/prompt-engine.ts:634-645`
- **问题描述**：两份实现逻辑完全一致（同样的 `WEEKDAYS` 数组、同样的 `Date.UTC(y, m-1, d)` + `getUTCDay()`）。方案 §5.4 写「`formatChineseWeekday` 复用不变」，实际是新文件里复制了一份。
- **为什么是 bug**：不是功能性 bug，是维护性债务。将来若修星期计算（如口径改为本地时区），两处必须同步改，漏一处会让「系统提示里的星期」与「标签里的星期」不一致——而那正是本需求最核心的「模型感知日期」文案，不一致会直接误导模型。
- **验证用测试用例**：构造一个两份实现口径不同的输入无法验证（当前完全相同）；该问题靠代码比对即可确认：
  ```bash
  diff <(sed -n '57,66p' backend-ts/src/harness/core/session-date-notice.ts) \
       <(sed -n '634,645p' backend-ts/src/harness/core/prompt-engine.ts)
  ```
  仅函数名与参数名不同，`WEEKDAYS` 数组与解析逻辑逐字节一致。
- **修复建议**：`prompt-engine.ts` 改为 `import { formatChineseWeekday } from './session-date-notice.js'`，删掉本地 `WEEKDAYS` 与函数定义（或反向：纯函数文件不导出，prompt-engine 传 weekday 进去）。同时把 `session-date-notice.spec.ts` 里的 `formatChineseWeekday` 用例与 prompt-engine 的既有日期节测试合并为一处，避免「两边都绿但语义漂移」。

#### L-2 `applyDateChangeNotices` 的数组 content 分支丢 `senderYmd` 的镜像风险

- **位置**：`backend-ts/src/harness/core/session-date-notice.ts:46-47`
- **问题描述**：数组 content 分支写作 `{ ...msg, content: [...] as unknown }`，`as unknown` 后赋给 `content?: unknown`。类型上是安全的，但这个 `as unknown` 是为了绕过 `content` 联合类型的显式断言，与字符串分支的 `{ ...msg, content: string }` 不对称。若将来 `ChatMessage.content` 收窄为 `string | ContentPart[]`，此处的 `as unknown` 会静默放过非 `ContentPart[]` 的数组。
- **为什么是 bug**：当前无功能影响（`msg.content` 走到该分支必为 `Array.isArray`）。属于类型健壮性隐患，不影响本次合并。
- **修复建议**：改为 `content: [{ type: 'text', text: tag }, ...(msg.content as ContentPart[])]`，`ContentPart` 从 `../llm/chat-request.js` 以 type-only 方式引入，去掉 `as unknown`。

---

## 3. 已检查未发现问题的范围

以下均经过代码走查 + 探针验证，未发现可触发功能 bug 的问题：

| 检查项 | 结论 |
|---|---|
| `applyDateChangeNotices` 浅拷贝陷阱 | 正确。字符串分支与数组分支都只替换 `messages[i]`（新对象），未原地改 `msg.content`。`session-date-notice.spec.ts:93-110` 两条回归用例（原数组 length、原 content 引用）有效。 |
| `senderYmd` 协议外泄 | 三个适配器均按显式白名单序列化：`json.ts:52-68`（`serializeChatMessage` 只取 role/content/name/toolCallId/toolCalls/audio/reasoning_content）、`anthropic-llm-adapter.ts:797-855`（`convertMessages` 只读 role/content/toolCallId/toolCalls）、`responses-llm-adapter.ts:880-945`（同）。`ChatMessage.senderYmd` 不会进入任何请求体。三个 spec 新增断言有效。 |
| `replaceQuickCommandMarkers` 改 `{ ...msg, content: replaced }` | 行为等价且更完整。原实现 `{ role:'user', content: replaced }` 丢 `name`/`toolCallId`/`toolCalls`/`audio`/`reasoningContent`/`senderYmd`；新版全保留。`prompt-engine.spec.ts:722-746` 用例覆盖 marker + 跨天。 |
| `previousUserYmdBefore` 取窗口内第一条 USER 的 id | 正确。`normalizeEntities` 丢孤儿 TOOL 但不改 USER 的相对顺序（已用探针验证 `normalized ids: [1,2,3,5]`），取首条 USER 作上界稳妥。查询参数为 `(sessionId, firstUserId)`，已探针确认。 |
| 锚点兜底路径 | `resolveSessionBaseYmd` 对「无用户消息 / created_at 空 / 长度不足 10 / 查询抛错 / deps 未挂载」五种情形全部正确回落 `shanghaiYmd()`，且有对应测试。 |
| 压缩严格前缀不变量 | `deriveRequest` 是 `[...source.messages]` + 追加尾指令，标签在主请求副本里，派生请求自动继承，前缀性质不受影响。探针确认派生请求首条消息含 `date-change`。 |
| `isRealUserMessage` 判定 | 标签以 `<date-change>` 开头，不匹配 `<system-notice>` / `## 会话任务交接` 前缀，真实用户消息判定不受影响。`prompt-engine.spec.ts:777-786` 有效。 |
| 多模态标签顺序 | chat-completions：`[text(tag), image, text(原文)]`；anthropic：`[image, text(tag)]`（其 user 分支先 push image blocks）；responses：`[input_image, input_text(tag)]`。均不破坏协议结构（标签只是多一个 text part）。 |
| `sessionBaseYmd` 缺失 | `currentDateHint` 返回 `''`（不渲染日期节），`applyDateChangeNotices` 因 `!baseYmd` 直接 return。与改造前一致，测试有效。 |
| manifest token 统计 | manifest 读 `normalized`（最终请求），标签 token 计入「会话消息」节，符合「所见即所发」。 |
| 测试假通过 | 逐条核对了新增断言的字节级含义（含 `\n\n` 转义、`endsWith`、`toContain` 目标串），未发现「断言与实际行为不符」或「mock 签名与真实签名不一致」的情况。 |
| 全量回归 | `cd backend-ts && npx vitest run` → 301 passed / 1 skipped，3774 passed / 14 skipped。 |

---

## 4. 变更历史

- 2026-10-12 round1：首次审查，发现 1 高 / 1 中 / 2 低。
