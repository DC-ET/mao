# 任务运行轨迹透视（feature/run-trace）代码审查报告

- **日期**：2026-10-09
- **分支 / 提交**：`feature/run-trace` @ `34529916`（相对 `main` @ `717e6a86`），工作区干净、无未提交改动。
- **范围**：`git diff main..HEAD` 全部 39 个文件中的功能代码。设计基准：`docs/plan/2026-10-09-run-trace-technical-design.md`。文档 / CHANGELOG / skills 手册按审查要求未纳入 bug 判定（仅核对口径一致性）。
- **方法**：按四部分（后端 instrumentation、RunTraceService + 路由 + VO、桌面端、管理后台）通读源码出题；**3 条候选全部以临时 Vitest 探针实跑复现**（探针只新建临时 spec 文件、跑完即删，未改动任何产品源码与既有 spec，也未提交）。
- **基线健康度**：`cd backend-ts && npm test` → 263 files / 3142 tests 全绿；`cd desktop && npm run test:unit` → vitest 33 files / 341 tests 全绿（`electron/gitOperations.test.cjs` 与 `localShell.test.cjs` 各 1 个环境相关失败为已知存量，与本次改动无关）。
- **结论**：确认 **3 个功能逻辑 BUG**（2 中 / 1 低），全部附可运行探针源码、运行方式与实测失败输出。另有若干「已核查无问题」清单见附录 B。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中 | backend session / run-trace | `markLastMessageFinished` 会把终态时刻写到「最后一条 USER 消息」的 `updated_at`，RunTraceService 把 `updated_at > created_at` 一律当作「编辑重发」，取消长耗时工具 / 空响应耗尽等场景会伪造出「编辑前」段并打「编辑前」徽标 |
| BUG-2 | 中 | admin 前端 ↔ 后端 | 管理后台「运行轨迹」Tab 的「排行维度」切换发的是 `runTraceScope=user`，后端只读 `scope`，维度切换 100% 静默失效（表格列头也仍显示 Agent） |
| BUG-3 | 低 | backend session 路由 | `/trace` 的 `limit` 只钳上限不钳下限，`limit=0` 时把「有用户消息的会话」误判成「没有任何用户消息」，整会话调用被倒进「未归属」且 `hasMore=false` |

---

## BUG-1【中】取消执行后 run 轨迹伪造「编辑前」段

### 位置

- 误判源（新代码）：`backend-ts/src/session/run-trace.service.ts:186`
  ```ts
  const editBoundary = isAfter(anchor.updatedAt, anchor.createdAt) ? anchor.updatedAt ?? null : null;
  ```
  用法：同文件 `:195`（`created_at < editBoundary` 的 agent 调用进 `before_edit`）、`:249-251`（有 before 内容才造段）。
- 触发源（存量行为，本次首次成为其消费者）：`backend-ts/src/session/session.service.ts:1145-1150`
  ```ts
  async markLastMessageFinished(sessionId: number): Promise<void> {
    const last = await this.messageRepo.selectLast(sessionId);
    if (last != null) {
      last.updatedAt = nowSql();          // ← 不看 role，最后一条是什么就写什么
      await this.messageRepo.updateById(last);
    }
  }
  ```
  调用点：`backend-ts/src/session/task-terminal.service.ts:106`（`finishExecution`，即 IDLE / COMPLETED / FAILED / CANCELLED 都会走）。
- 前提成立的原因：`backend-ts/src/harness/core/agent-loop.ts:433-440`——取消命中在工具执行阶段时 `rollbackIncompleteRound` 回滚本轮、`pendingSave*` 全部置空，**助手消息不落库**，此刻 DB 最后一条消息就是锚点 USER 消息。
- 与迁移注释的矛盾：`backend-ts/db/migration/V029__add_message_updated_at.sql:2` 明确「仅用户消息编辑时填充」，但 `markLastMessageFinished` 打破了该约定。

### 代码事实 / 触发链

1. 用户 10:00:00 发消息 → 10:00:30 第一轮 LLM 调用结束（`llm_call` 行 `created_at = 10:00:30`，`success = 1`）→ 助手消息带 `tool_calls` 入上下文但**尚未落库**（要等 `executeToolCalls` 返回后的 `onSaveToolRound`）；
2. 工具执行中用户点「停止」→ `agent-loop.ts:433` 走取消分支：助手消息回滚不落库、`break`；
3. WS handler → `task-terminal.finishExecution(CANCELLED)` → `markLastMessageFinished`：`selectLast` 取到的就是那条 USER 消息，`updated_at` 被写成取消时刻（如 10:01:00）；
4. 轨迹读模型：`anchor.updatedAt (10:01:00) > anchor.createdAt (10:00:00)` → `editBoundary = 10:01:00` → 唯一的 agent 调用（10:00:30 < 10:01:00）被划进 `before_edit` 段；
5. 用户从未编辑过消息，却看到 run 摘要条多一个「编辑前」徽标，展开后「编辑前」段里躺着那一轮、「当前」段是空的。

同样命中的场景：空响应连续 10 次耗尽（`EmptyResponseExhaustedException`，10 条 agent 调用全被划进「编辑前」）、首轮 LLM 调用即失败。反之，只要 run 里落过任何助手消息，`markLastMessageFinished` 写的是 ASSISTANT 行，不触发本 bug。

### 预期 vs 实际

- 预期（技术方案 §2.1-9 / §5.2）：只有 `editMessageAndTruncate`（`session.service.ts:1102` 显式 `message.updatedAt = nowSql()` 的那一处）才应产生「编辑前」切点；取消 / 空响应 / 失败不应造段。
- 实际：任何「终态时最后一条消息恰好是 USER」的执行都会把该 USER 消息的 `updated_at` 刷成终态时刻，被轨迹读模型当成编辑。

### 影响

桌面「运行轨迹」Tab 对取消 / 空响应 / 首轮失败的 run 展示错误分段与误导性「编辑前」徽标（排障场景下恰是最需要看轨迹的一类 run）。不影响数据本身，刷新后依旧复现（`updated_at` 已落库）。修改方向（供参考，未改代码）：编辑切点不要只用 `updated_at > created_at` 推断，例如仅在锚点消息之后存在被逻辑删除的消息、或为编辑路径补一个显式标记列 / metadata；或 `markLastMessageFinished` 跳过 USER 角色。

### 验证测试（探针，跑完即删）

文件：`backend-ts/src/session/zz-review-verify.spec.ts`（与下述 BUG-2、BUG-3 探针同文件，一次性覆盖 4 个用例）。跑法：

```bash
cd backend-ts && npx vitest run src/session/zz-review-verify.spec.ts
```

探针分两半：先证明「存量链路确实会写 USER 消息的 `updated_at`」（驱动真实 `SessionService.markLastMessageFinished`），再证明「该状态被 `RunTraceService` 当成编辑」（驱动真实 `RunTraceService`，mock store 风格与既有 `run-trace.service.spec.ts` 一致）。

```ts
import { describe, expect, it, vi } from 'vitest';
import { RunTraceService } from './run-trace.service.js';
import { SessionService } from './session.service.js';
import { handleError } from '../common/http-error.js';
import { registerAdminAnalyticsRoutes } from '../admin/admin.routes.js';
import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import type { SessionActivityRepository } from './activity.repository.js';
import type { SessionCompactionEventRepository } from './session-compaction.repository.js';
import type { Message, SessionActivity, SessionCompactionEvent } from './types.js';

function makeTraceService(fixture: {
  messages: Array<Message & { id: number }>;
  calls: Array<LlmCallRow & { id: number }>;
  activities: Array<SessionActivity & { id: number }>;
  events: SessionCompactionEvent[];
}) {
  const messageRepo = {
    selectUserStarts: vi.fn(async (_sid: number, beforeId: number | null, limit: number) =>
      fixture.messages
        .filter((m) => m.role === 'USER' && (beforeId == null || m.id < beforeId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)),
    selectRange: vi.fn(async (_sid: number, startId: number, beforeId: number | null) =>
      fixture.messages.filter((m) => m.id >= startId && (beforeId == null || m.id < beforeId)).sort((a, b) => a.id - b.id)),
    selectUserStamps: vi.fn(async () =>
      fixture.messages
        .filter((m) => m.role === 'USER')
        .map((m) => ({ id: m.id, createdAt: m.createdAt ?? null, updatedAt: m.updatedAt ?? null }))
        .sort((a, b) => a.id - b.id)),
  } as unknown as MessageRepository;
  const llmCallRepo = {
    selectBySessionWindow: vi.fn(async (_sid: number, startAt: string | null, endAt: string | null) =>
      fixture.calls
        .filter((c) => (startAt == null || (c.createdAt ?? '') >= startAt) && (endAt == null || (c.createdAt ?? '') < endAt))
        .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : a.id - b.id)),
    ),
  } as unknown as LlmCallRepository;
  const activityRepo = {
    selectBySessionAll: vi.fn(async () => [...fixture.activities].sort((a, b) => a.id - b.id)),
  } as unknown as SessionActivityRepository;
  const compactionEventRepo = {
    selectBySessionId: vi.fn(async () => fixture.events),
  } as unknown as SessionCompactionEventRepository;
  return new RunTraceService(messageRepo, llmCallRepo, activityRepo, compactionEventRepo);
}

const QUERY = { beforeRunId: null, limit: 5, slowMs: 60_000, expensiveTokens: 50_000 };

describe('review-1: markLastMessageFinished 会把终态时刻写到 USER 消息的 updated_at', () => {
  it('writes updated_at on the trailing USER message (run produced no assistant message)', async () => {
    const last: Message = {
      id: 5, sessionId: 1, role: 'USER', content: '跑个长命令',
      createdAt: '2026-10-09 10:00:00', updatedAt: '2026-10-09 10:00:00',
    };
    const messageRepo = {
      selectLast: vi.fn(async () => last),
      updateById: vi.fn(async () => {}),
    } as unknown as MessageRepository;
    const service = new SessionService(
      {} as never, messageRepo, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    await service.markLastMessageFinished(1);
    expect(messageRepo.updateById).toHaveBeenCalledTimes(1);
    const written = vi.mocked(messageRepo.updateById).mock.calls[0][0] as Message;
    expect(written.id).toBe(5);
    // 关键前提：未编辑的 USER 消息也被写了 updated_at，且大于 created_at
    expect(written.updatedAt).not.toBeNull();
    expect(written.updatedAt! > last.createdAt!).toBe(true);
  });
});

describe('review-1: 取消长耗时工具后 run 轨迹伪造「编辑前」段', () => {
  it('fabricates a before_edit segment for a cancelled run (user never edited)', async () => {
    // 场景：USER 10:00:00 发消息 → 10:00:30 LLM 轮结束 → 工具执行中被用户取消（10:01:00）。
    // 助手消息未落库（rollbackIncompleteRound），finishExecution→markLastMessageFinished
    // 把最后一条消息（就是这条 USER）的 updated_at 刷成 10:01:00。
    const service = makeTraceService({
      messages: [
        { id: 1, sessionId: 1, role: 'USER', content: '跑个长命令', createdAt: '2026-10-09 10:00:00', updatedAt: '2026-10-09 10:01:00' },
      ],
      calls: [{
        id: 1, sessionId: 1, scene: 'agent', modelName: 'gpt', promptTokens: 100, completionTokens: 50,
        cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 150, costMicros: 1000, success: 1,
        durationMs: 5000, retryCount: 0, firstTokenMs: 100, createdAt: '2026-10-09 10:00:30',
      } as LlmCallRow & { id: number }],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    // 期望行为：没有编辑过 → 只有一个 current 段，轮在当前段里
    expect(run.segments.map((s) => s.kind)).toEqual(['current']);
    expect(run.segments[0].rounds).toHaveLength(1);
  });
});
```

**实测输出**（4 个用例中 2 失败即 BUG 复现；`review-1` 前提用例通过、后果用例失败）：

```
 ✓ review-1: markLastMessageFinished 会把终态时刻写到 USER 消息的 updated_at > writes updated_at ... 1ms
 × review-1: 取消长耗时工具后 run 轨迹伪造「编辑前」段 > fabricates a before_edit segment ... 6ms
AssertionError: expected [ 'before_edit', 'current' ] to deeply equal [ 'current' ]
- Expected + Received
  [
+   "before_edit",
    "current",
  ]
 ❯ src/session/zz-review-verify.spec.ts:105:45
```

---

## BUG-2【中】管理后台「排行维度」切换发的参数名与后端读取的不一致，切换静默失效

### 位置

- 前端发送（新代码）：`admin/src/views/analytics/AnalyticsView.vue:305`
  ```ts
  if (activeTab.value === 'run-trace') {
    query.scene = 'agent'
    query.runTraceScope = runTraceDimension.value   // ← 参数名 runTraceScope
  }
  ```
  类型定义：`admin/src/views/analytics/types.ts:289`（`runTraceScope?: RunTraceDimension`）；`useScopeQuery` 把该对象原样作为 axios `params` 发出，即 `GET /admin/analytics/run-trace?...&runTraceScope=user`。
- 后端读取（新代码）：`backend-ts/src/admin/admin.routes.ts:127`
  ```ts
  const scope = q.scope === 'user' ? 'user' : 'agent';   // ← 参数名 scope
  ```
- 反证：同一功能 mao-cli 走的是 `scope`（`skills/mao-cli/lib/commands/analytics.js`：`if (scope != null) query.scope = scope;`），说明后端口径就是 `scope`，前端名字写错了。

### 触发链

1. 管理员在「用量分析 → 运行轨迹」Tab 点「排行维度：用户」；
2. `currentQuery()` 带 `runTraceScope=user` 重拉（缓存键 `periodKey` 已含该字段，不会命中旧缓存，确实发了请求）；
3. 后端 `q.scope` 为 `undefined` → `scope = 'agent'`，`runTraceScope(days, endOffset, { scene: 'agent', scope: 'agent', limit })`；
4. 返回 payload 的 `scope` 仍是 `'agent'` → `RunTraceTab.vue:142` 的 `dimensionLabel` 仍是「Agent」、数据仍是 Agent 维度。界面呈现：分段控件显示「用户」，表格列头与数据却是 Agent——控件完全无作用且自相矛盾。

### 预期 vs 实际

- 预期（技术方案 §5.4）：`scope=agent|user` 切换排行维度；后端 `AdminAnalyticsService.runTraceScope` 的 `scope` 入参应按前端选择生效。
- 实际：参数名不一致（`runTraceScope` vs `scope`），用户维度永远取不到。

### 影响

管理后台运行轨迹 Tab 的「排行维度」控件 100% 失效（点「用户」毫无变化），且界面自相矛盾。修复为一处改名（前端改发 `scope`，或后端兼容读 `runTraceScope`），无数据影响。

### 验证测试（探针，跑完即删）

与 BUG-1 同一文件 `backend-ts/src/session/zz-review-verify.spec.ts`，驱动真实 `registerAdminAnalyticsRoutes`（fastify inject，风格仿 `backend-ts/src/agent/agent.routes.spec.ts` 的 admin 路由装配）：

```ts
describe('review-2: 管理后台运行轨迹「排行维度」参数名前后端不一致', () => {
  it('backend ignores runTraceScope (what AnalyticsView sends) and only honors scope', async () => {
    const runTraceScope = vi.fn(async () => ({
      period: {}, scene: 'agent', scope: 'agent', slowestRounds: [], mostExpensiveRounds: [], toolFailureRates: [],
    }));
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(app, {
      analytics: { runTraceScope } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    } as never);

    // 管理后台 AnalyticsView.vue currentQuery() 实际发送：scene + runTraceScope
    const uiRes = await app.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?days=7&scene=agent&runTraceScope=user' });
    expect(uiRes.statusCode).toBe(200);
    expect(runTraceScope).toHaveBeenCalledWith(7, 0, { scene: 'agent', scope: 'agent', limit: 20 });

    // 后端读取的参数名是 scope（mao-cli 也是发 scope）
    runTraceScope.mockClear();
    await app.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?days=7&scene=agent&scope=user' });
    expect(runTraceScope).toHaveBeenCalledWith(7, 0, { scene: 'agent', scope: 'user', limit: 20 });

    await app.close();
  });
});
```

**实测输出**（该用例**通过**——即前后端契约不一致被实跑证实：UI 发的 `runTraceScope` 被后端忽略，只有 `scope` 生效）：

```
 ✓ review-2: 管理后台运行轨迹「排行维度」参数名前后端不一致 > backend ignores runTraceScope ... 77ms
```

> 说明：BUG-1 / BUG-3 的探针以「期望行为」断言，现状下失败即复现；BUG-2 的探针以「现状契约」断言，通过即证明前端发的参数后端不读。

---

## BUG-3【低】`limit=0` 时把有用户消息的会话误判成「没有任何用户消息」，整会话倒进「未归属」

### 位置

- `backend-ts/src/session/session.routes.ts:516`（只钳上限，无下限）
  ```ts
  const limit = Math.min(queryOptInt(request, 'limit') ?? 5, 50);
  ```
- `backend-ts/src/session/run-trace.service.ts:83-104`：`limit=0` 时 `selectUserStarts(sid, null, 1)` 取回 1 条锚点 → `hasMore=true` → `pageAnchors = anchors.slice(0, 0) = []` → 因 `beforeRunId == null` 不进早退分支 → 落入 `if (pageAnchors.length === 0)` 的「会话没有任何用户消息」分支，把**全部** `llm_call` / `session_activity` 当作未归属返回，且 `hasMore: false`。

### 触发链

1. 调用方请求 `GET /v1/sessions/1/trace?limit=0`（或负值）；
2. 路由不做下限钳制，`limit=0` 进入 service；
3. service 的「空页」分支把「limit 裁空」与「会话无用户消息」混为一谈；
4. 响应：`{ runs: [], hasMore: false, unattributed: { 全部调用与活动 } }`——客户端会认为没有更多数据，同时整个会话被标成未归属。

### 预期 vs 实际

- 预期：非法 / 越界 `limit` 回落到默认 5（或至少钳到 ≥1），分页语义保持「不重不漏」。
- 实际：`limit=0` 返回错误的「无用户消息」结构。

### 影响

仅经手工构造的请求可达（桌面固定发 5 / 50，mao-cli 不调用 `/trace`），属于接口健壮性问题而非产品路径故障；但一旦被触发表面错误明显（整会话未归属 + 翻页终止）。修复：路由改 `Math.max(1, Math.min(...))`，或在 service 空页分支区分 `query.limit <= 0`。

### 验证测试（探针，跑完即删）

同一探针文件追加：

```ts
describe('review-3: limit=0 时把整个会话误判成「没有用户消息」', () => {
  it('returns everything as unattributed when limit=0 on a session with user messages', async () => {
    const service = makeTraceService({
      messages: [
        { id: 1, sessionId: 1, role: 'USER', content: '你好', createdAt: '2026-10-09 10:00:00', updatedAt: '2026-10-09 10:00:00' },
      ],
      calls: [{
        id: 1, sessionId: 1, scene: 'agent', modelName: 'gpt', promptTokens: 100, completionTokens: 50,
        cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 150, costMicros: 1000, success: 1,
        durationMs: 5000, retryCount: 0, firstTokenMs: 100, createdAt: '2026-10-09 10:00:30',
      } as LlmCallRow & { id: number }],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, { ...QUERY, limit: 0 });
    // 期望：空 run 列表 + hasMore=true（还有数据），unattributed 为 null
    expect(page.runs).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.unattributed).toBeNull();
  });
});
```

**实测输出**：

```
 × review-3: limit=0 时把整个会话误判成「没有用户消息」 > returns everything as unattributed ... 1ms
AssertionError: expected false to be true // Object.is equality
 ❯ src/session/zz-review-verify.spec.ts:157:26
    155|     // 期望：空 run 列表 + hasMore=true（还有数据），unattributed 为 null
    156|     expect(page.runs).toEqual([]);
    157|     expect(page.hasMore).toBe(true);
```

（`hasMore` 实得 `false`，且同响应里 `unattributed` 非 null——整会话调用被倒进未归属。）

---

## 附录 A：探针汇总与复跑方式

| 探针 | 文件 | 用例 | 结果 |
| --- | --- | --- | --- |
| BUG-1 前提 | `backend-ts/src/session/zz-review-verify.spec.ts` | `markLastMessageFinished` 写 USER `updated_at` | 通过（前提成立） |
| BUG-1 后果 | 同上 | 取消后不造 `before_edit` | 失败（复现） |
| BUG-2 | 同上 | admin 路由 `runTraceScope` vs `scope` | 通过（契约不一致证实） |
| BUG-3 | 同上 | `limit=0` 分页语义 | 失败（复现） |
| 轨迹 tab 刷新还原（无 bug） | `desktop/src/composables/zz-trace-tabs-review.test.ts` | `openTraceTab` 单例 / 不先建 tab 则留在主会话 / `restoreTraceTab` 回到轨迹 / `closeOtherTabs` 保留轨迹 | 4/4 通过 |

复跑：

```bash
cd backend-ts && npx vitest run src/session/zz-review-verify.spec.ts   # 预期 2 失败 / 2 通过
cd desktop && npx vitest run src/composables/zz-trace-tabs-review.test.ts  # 预期 4/4 通过
```

两个探针文件均为临时文件，验证后已删除，未提交、未改动任何产品源码与既有 spec。

## 附录 B：已核查无问题的点（节选）

- run 归属主干：`selectUserStarts` + `selectRange` 的 id 区间、`limit+1` 判 `hasMore` 后丢弃、`beforeRunId` 翻页不重不漏（既有 spec 覆盖）。
- 工具归属：`tool_call_id → 消息 → run`、异步晚插入按消息归（既有 spec 覆盖）、同秒多候选进 `unplacedTools` 不猜、`toolSuccess/toolError` 不重复计数。
- 墙钟：`max(end) − min(start)`、无 duration 不参与、负值归零；旁路调用进合计、任一行未配价则 run 成本为 null。
- 阈值：`>=` 判定、四类 token 求和、路由 clamp（1000–3600000 / 1000–10000000）、桌面 localStorage 读写容错。
- 导出：CSV 六位小数成本 / BOM / CRLF / 双引号转义 / 已中断写「已中断」/ 未归属 `runId` 空串，与 admin `LlmCallView` 导出口径一致；JSON 结构与接口一致。
- WS：`round_start`/`round_end` 经 `STREAM_EVENT_TYPES` 走陈旧执行过滤、`send()` 统一带 `executionId`、终态 `clearLiveState`；`activity` 事件新增 `duration_ms` 不影响旧前端。
- admin 聚合 SQL：`ROW_NUMBER() OVER (PARTITION BY …)`、`scene` 过滤、贵榜 `cost_micros IS NOT NULL`、失败率按比例排序与截断、占位名（既有 spec 覆盖）。
- 桌面 tab：`openTraceTab` 每会话单例、`restoreTraceTab` 先建 tab 再还原（探针 4/4 通过）、`closeOtherTabs` 保留轨迹 tab、KeepAlive `:max="20"` 逐出后重挂载重拉。
- 权限：`/trace` 走 `requireSessionOwner`（越权返回非 0，既有 spec 覆盖）、admin 新路由走 `analytics:read`；`/trace` 未挂进分享快照组装。
