# 代码审查报告：信号哨兵增强（取消上限 / 复用会话 / 复制继承 / 独立分组）

- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/signal-enhancement`（分支 `feat/signal-watcher-enhancement`，commit `f153867b`）本次需求全部代码变更（`git diff ba2481f3..HEAD`，已排除 CHANGELOG/README/DEPLOY/docs/skills 等文档改动；main 上两个 Mermaid 提交与本次无关，未审查）
- 技术方案对照：`docs/plan/2026-10-27-signal-watcher-enhancement-technical-design.md`
- 审查日期：2026-10-27
- 审查方式：全量 diff 走读 + 关键链路源码追踪（WatcherService CRUD/runCheck、OpenRunService、SessionService.createSession/getSession、仓储层、分组 key 前后端三处排序、桌面表单纯函数）+ 每个确认 bug 均以可运行测试复现（临时 spec，验证后已按约定删除，完整代码见附录）
- 基线状态：`backend-ts` 受影响 spec 33 文件 472 用例全绿；`desktop` 130 文件 1255 用例全绿；`desktop`/`admin` `npm run build`、`backend-ts npm run build` 均通过——**既有单测全绿恰恰是 Bug 1 漏网的原因（mock 与生产 wiring 不一致）**
- 结论：**确认 1 个重大 bug（REUSE_SESSION 复用指针的核心失效路径完全走反）+ 1 个低severity 遗留（归档会话不清指针）**。取消上限、copyFrom 继承、分组 key 一致性、未读排除、前端 payload 组装经核查未发现问题（明细见文末清单）。
---

## 确认的 Bug

### Bug 1（重大）：复用指针预检依赖的 `getSession` 生产实现是「抛异常」而非「返回 null」——复用的会话被删后哨兵既不触发、烧连败、指针永不清，最终自动停用

**位置**

- 装配 wiring：`backend-ts/src/app-openapi-services.ts:127`
  ```ts
  getSession: (id) => sessionService.getSession(id),
  ```
- 依赖声明（承诺「读不到返回 null」）：`backend-ts/src/signal/watcher.service.ts:59`
  ```ts
  getSession: (id: number) => Promise<WatcherSessionLookup | null>;
  ```
- 消费方（把「返回 null」当既定契约）：`backend-ts/src/signal/watcher.service.ts:672-679`（`isReusableSession`，`session == null` 判失效）
- 调用点在 runCheck 的 try 内：`backend-ts/src/signal/watcher.service.ts:450-455` → 异常被 `:464-466` 的 `catch (e) { failure = e; }` 吞掉 → 走 `:495-502` 的「触发失败」分支（`markCheckError` + `markChecked` + `recordFailure`）

**生产实际行为**：`SessionService.getSession`（`backend-ts/src/session/session.service.ts:565-571`）在行不存在时**抛** `BusinessException(SESSION_NOT_FOUND, '会话不存在')`，且 `session` 仓库 `findById` 带 `deleted = 0` 过滤（`session.repository.ts:122`）——软删的会话同样走抛异常路径。装配层没有 try/catch 包装，异常原样穿进 `isReusableSession`。

**触发条件**：哨兵 `triggerMode = REUSE_SESSION` 且 `reuse_session_id` 指向的会话被用户删除（删除会话是高频常规操作：会话列表右键删除 / 清理）。此后每当被监控的值发生变化：

1. `isReusableSession` 抛 `SESSION_NOT_FOUND` → 被 runCheck 的 try 吞掉 → **`openRun.run` 根本不会被调用**（Agent 一次都不跑，用户的变化通知静默丢失，只在轮询记录里留一条 `changed=1, error='会话不存在'` 的自相矛盾记录）；
2. 走「触发失败」分支 → `recordFailure` → `consecutive_failures + 1`（设计明确要求「指针失效不计连败」）；
3. 指针清库代码（`:453` 的 `update({ reuseSessionId: null })`）在异常点之后，**永不可达** → 指针一直是已删会话 id，每次变化重复 1-2 步；
4. 连续 5 次变化后 `recordFailure` 把哨兵置 `DISABLED` 并发「哨兵已停用」站内通知——用户看到的是「哨兵因连续失败被停用」，真正原因（复用的会话被删）完全不体现。

**为什么是 bug**：技术方案 §3.2.3 与需求背景都把「会话被删」列为指针失效的第一种情形，要求「清指针并本次新建，下次触发重建，不计 consecutive_failures」；`isReusableSession` 的函数注释也写着「deleted 会话 findById 不返回，等同已删」。但唯一的生产实现（`sessionService.getSession`）语义是抛异常，依赖类型 `Promise<WatcherSessionLookup | null>` 的 `null` 分支在生产永不可达。`watcher.service.spec.ts` 的 `getSession: vi.fn(async (id) => sessions.get(id) ?? null)` mock 与生产 wiring 不一致，所以 6 个「指针失效」用例（含 it.each 全矩阵）全绿也发现不了。

**验证测试结论**（临时 spec `backend-ts/src/signal/zz-temp-review-reuse.spec.ts`，用**真实 `SessionService`**（stub 掉 `sessionRepo.findById` 返回 null）按生产 wiring 驱动，非自造 mock）：

```
✓ 事实 1：SessionService.getSession 行不存在时抛异常，不返回 null
    （rejects BusinessException，code=3002，message='会话不存在'）
× BUG：生产 wiring 下指针会话已删 → 计入连败且指针不清空
    实测 vs 期望（toEqual 失败，逐项列出）：
      pointerAfterRun:   42   （期望 null —— 指针没清）
      recordFailureCalls: 1   （期望 0   —— 计了连败）
      openRunCalls:       0   （期望 1   —— 根本没触发）
      checkError:  '会话不存在'（期望 null）
      triggeredSessionId: null（期望 99）
      checkChanged:       1   （记录了「变化」却没有触发）
✓ BUG 后果：连续 5 次「复用的会话被删」后哨兵被自动停用并发通知
    （5 轮 runCheck 后：reuseSessionId 仍为 42、recordFailure 被调 5 次、
      notify（停用通知）被调 1 次）
✓ 对照：spec 里的 null 返回 mock 下行为符合预期
    （同一 harness 仅把 getSession 换成返回 null：不记失败、照常触发、
      指针先清后回写为 99 —— 证明服务层逻辑本身没错，错在 wiring 契约）
```

**修复方向（仅建议，未改代码）**：二选一或同时做——
1. 装配层兜底：`getSession: async (id) => { try { return await sessionService.getSession(id); } catch (e) { if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND) return null; throw e; } }`；
2. 服务层自卫：`isReusableSession` 内 catch `SESSION_NOT_FOUND` 返回 false（更稳，防其它装配路径重蹈）；
3. 补一条用真实 `SessionService`（或抛异常 mock）的回归用例，钉死「会话已删 → 清指针 + 照常触发 + 不计连败」，避免再次出现 mock 与生产不一致。

**严重程度**：**重大**。新功能 REUSE_SESSION 的最常见退化路径（用户删掉复用的会话）整体走反：触发静默丢失 + 连败 + 必然走向自动停用；仅「轮询记录里有 error 行」这一间接可见性略降损失，故不定「致命」。

---

### Bug 2（低）：`isReusableSession` 不校验 `status = 'ARCHIVED'`，归档后的复用会话继续被触发（与代码注释/设计文档措辞不一致）

**位置**：`backend-ts/src/signal/watcher.service.ts:672-679`。函数注释与设计文档 §3.2.3  prose 均写「会话被用户删/**归档**导致失效时清指针走新建」，但实现只查了 `sessionType`/`executionMode`/`agentId`，没有 `status` 判定；`session.repository.ts:122` 的 `findById` 只过滤 `deleted = 0`，归档行会正常返回。

**触发条件**：用户把哨兵复用的会话归档（`session.service.ts:1009` 的归档是真实用户入口，桌面端有「已归档」专区）。之后每次变化仍会向该归档会话触发，会话藏在归档区里，用户侧看不到任何活动，却持续消耗 Agent 执行。

**为什么是 bug（低severity）**：需求背景给的失效清单（删/归属不符/SUBAGENT|SIDE_TASK/LOCAL/Agent 变更）确实**不含**归档，严格说不构成功能违背；但代码注释和设计文档明确承诺了归档失效，属于「实现与自身契约不符」。触发仍成功、数据无损，仅可见性错位，故定低。

**验证测试结论**（同一临时 spec 的最后一条）：

```
✓ 备注：ARCHIVED 会话仍通过预检被复用
    （sessions 里放 status='ARCHIVED' 的会话 42：openRun.run 被调用且
      sessionId=42，指针不清空 —— 预检放行归档会话）
```

**修复方向（仅建议，未改代码）**：`isReusableSession` 增加 `if (session.status === 'ARCHIVED') return false;`（若产品判断「归档也要继续复用」则改注释与设计文档，取消「归档」措辞）。

---

## 已核查未发现问题的重点项

按任务「重点关注」清单逐项核对（均有现有单测或本次新增单测覆盖，且我另做了交叉验证）：

1. **`openRun` → `createSession` 第 16 参位置**：`open-run.service.ts:149-166` 的 16 个位置参数与 `SessionService.createSession`（`session.service.ts:97-114`，`source` 为第 16 参）逐位一致；`session.source` 列为 `VARCHAR(16) DEFAULT 'web'`（V109），`'signal'` 可落库。`open-run.service.spec.ts` 新增的 16 参钉死用例与真实签名一致（我已人工比对，非只信测试）。
2. **V174 迁移与存量数据**：`trigger_mode VARCHAR(16) NOT NULL DEFAULT 'NEW_SESSION'`（老行零迁移兼容）、`reuse_session_id BIGINT NULL`；编号为当前最大（V173 之后）。读取路径全部 `SELECT *` + camelCase 映射；仓储层 `update({reuseSessionId:null})` 确实生成 `reuse_session_id = ?` 且参数为 `null`（临时 spec 验证：SQL 含 `reuse_session_id = ?`、params 含 `null`；insert 带齐 `triggerMode`/`reuseSessionId`；存量行读出 `triggerMode='NEW_SESSION'`、`reuseSessionId=null`）。
3. **copyFrom 继承**：越权面（`requireOwned(userId, copyFrom)`，非本人/不存在均抛「哨兵不存在」不落库）、掩码还原（`restoreMaskedHeaders` 键名小写归一匹配、源行无此键抛「需要填写新的值」）、空值语义（`headers:{}`→无请求头；body 键未下发+POST→继承源体；源行也无 body→被 POST 必填拦住；GET 不继承 body）、`reuseSessionId` 不继承（create 恒置空）、路由层不解析 `reuseSessionId`——均与需求一致，路由/service 两层单测齐。
4. **分组 key 前后端一致性**：后端 `of()`（embed → signal → feishu/dingtalk → ofMode 优先序）、`compareKeys`（CLOUD_TEMP → embed → CLOUD/非 CLOUD → **SIGNAL 排最后** → 字典序）、`applyFilter('SIGNAL')`（`source = 'signal'`）与四个模式/工作区桶的 `NOT IN ('embed','signal')` 排除；桌面 `cloudGroupKey`/`groupedSessions`/`sortGroups` 三处排序同规则（含 `CLOUD:临时工作区` 优先），前端单测锁死。`listSessionGroups`/`listSessionsByGroup` 用同一 `of()`/`applyFilter`，预览与展开条数不会错位。
5. **未读排除**：唯一 `unread=1` 写入点 `updatePhase`（`session.service.ts:1449`）与 WS 终态广播 `task-terminal.service.ts:133` 都加了 `source !== 'signal'`，且只收窄不放宽；`null/web/embed` 仍置未读（有对照用例）。signal 会话的收件箱通知（`recordInbox` 带 `source: 'SIGNAL'`）与出站订阅不受影响，桌面 `InboxDrawer` 角标透传正常。
6. **用户不可伪造 signal 来源**：`POST /v1/sessions` 与 `PUT /v1/sessions/:id/source` 均改用 `isUserSettableSessionSource`（显式 `['web','embed']` 白名单，不读 `SESSION_SOURCE_VALUES`），有路由层回归用例。
7. **前端 payload 组装**：`buildWatcherPayload` 三敏感字段「键存在性」语义（undefined 键被 JSON 丢弃）、复制态 `bodyInherited` 留空不下发 body、删光头行=不要请求头（复制态不触发编辑态的显式清空 `null`）、`triggerMode` 权威下发、`reuseSessionId` 永不下发——纯函数单测覆盖；`canSubmit`/`bodyPlaceholder` 复制态分支正确。desktop/admin 构建与全部单测通过。
8. **runCheck 不抛异常与调度器单飞**：`WatcherScheduler.checkWatcher` 有 try/catch/finally 单飞清理；指针回写失败仅 `console.warn`（`watcher.service.ts:474-480`）。除 Bug 1 的语义错误外，异常面本身没有穿出风险。
9. **指针维护规则**：REUSE→NEW 清指针、NEW→REUSE 不复活旧指针、改 agentId 清指针、改无关字段不清、编辑未下发 triggerMode 沿用原值——均与需求一致（有单测）。`update` 先读后写的竞态（runCheck 在途回写新指针被旧快照覆盖）理论存在但后果仅「提前重建会话」，可接受，未计为 bug。

---

## 附录：验证用临时测试（已验证，按审查约定已删除，此处留存全文供复跑）

两个临时 spec 均放在 `backend-ts/src/signal/` 下、`zz-temp-review-` 前缀，跑法：

```bash
cd backend-ts && ./node_modules/.bin/vitest run src/signal/zz-temp-review-reuse.spec.ts src/signal/zz-temp-review-repo.spec.ts
# zz-temp-review-reuse.spec.ts：5 用例，1 failed（Bug 1 的「断言期望行为」用例，失败即缺陷存在）+ 4 passed
# zz-temp-review-repo.spec.ts：3 passed（V174 列读写/存量行形状）
```

### A. `zz-temp-review-reuse.spec.ts`（核心：harness 与既有 spec 同构，唯一差别是 `getSession` 接真实 `SessionService`）

```ts
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import type { Session } from '../session/types.js';
import { SessionService } from '../session/session.service.js';
import type { SignalWatcher, SignalWatcherCheck } from './types.js';
import type { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal.repository.js';
import { SignalSecretCipher } from './signal-cipher.js';
import type { ProbeResult } from './probe-client.js';
import { WATCHER_DISABLE_AFTER_FAILURES, WatcherService, type WatcherDisableNotifier } from './watcher.service.js';

const SECRET = 'test-signal-secret';

function watcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id: 1, userId: 7, agentId: 3, name: 'w', url: 'https://example.com/api', method: 'GET',
    headersJson: null, body: null, intervalMinutes: 15, compareMode: 'HASH', jsonPath: null,
    promptTemplate: 'changed {url} {name} {diff}', status: 'ACTIVE',
    lastValueHash: 'different', lastValueSnippet: 'old',
    lastCheckedAt: null, lastChangedAt: null, consecutiveFailures: 0,
    triggerMode: 'REUSE_SESSION', reuseSessionId: 42, createdAt: null, updatedAt: null,
    ...overrides,
  };
}

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return { ok: true, httpStatus: 200, body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8'), error: null, durationMs: 5, ...overrides };
}

/**
 * 生产 wiring 的忠实复刻：app-openapi-services.ts:127 是
 * `getSession: (id) => sessionService.getSession(id)`，
 * 而 SessionService.getSession 在行不存在（含软删）时抛 BusinessException(SESSION_NOT_FOUND)。
 */
function realSessionServiceGetSession(rows: Map<number, Session>): (id: number) => Promise<Session> {
  const sessionRepo = { findById: vi.fn(async (id: number) => rows.get(id) ?? null) };
  const service = new SessionService(
    sessionRepo as never, null as never, null as never, null as never, null as never,
    null as never, null as never, null as never, null as never, null as never,
  );
  return (id: number) => service.getSession(id);
}

// harness()：与 watcher.service.spec.ts 同构的 watcherRepo/checkRepo/probe/openRun（openRun 返回 sessionId=99），
// markChecked/recordFailure 复刻真实 SQL 语义；service 的 getSession 由入参注入。
// ……（完整 harness 见提交前工作区，结构逐行复刻既有 spec，仅 getSession 一行不同）

describe('临时审查：复用指针预检与生产 wiring 的一致性', () => {
  it('事实 1：SessionService.getSession 行不存在时抛异常，不返回 null', async () => {
    const get = realSessionServiceGetSession(new Map());
    await expect(get(42)).rejects.toBeInstanceOf(BusinessException);
    const err = await get(42).catch((e: unknown) => e as BusinessException);
    expect(err.code).toBe(3002);
    expect(err.message).toBe('会话不存在');
  });

  it('BUG：生产 wiring 下指针会话已删 → 计入连败且指针不清空', async () => {
    const h = harness({ getSession: realSessionServiceGetSession(new Map()) });
    await h.service.runCheck(1);
    const observed: Record<string, unknown> = {
      pointerAfterRun: h.watchers.get(1)!.reuseSessionId,
      recordFailureCalls: h.recordFailure.mock.calls.length,
      openRunCalls: h.openRun.run.mock.calls.length,
      checkError: h.checks[0]?.error ?? null,
      checkChanged: h.checks[0]?.changed ?? null,
      triggeredSessionId: h.checks[0]?.triggeredSessionId ?? null,
    };
    expect(observed).toEqual({
      pointerAfterRun: null, recordFailureCalls: 0, openRunCalls: 1,
      checkError: null, checkChanged: 1, triggeredSessionId: 99,
    });
  });

  it('BUG 后果：连续 5 次「复用的会话被删」后哨兵被自动停用并发通知', async () => {
    const h = harness({ getSession: realSessionServiceGetSession(new Map()) });
    for (let i = 0; i < WATCHER_DISABLE_AFTER_FAILURES; i += 1) {
      h.watchers.get(1)!.lastValueHash = `different-${i}`;
      await h.service.runCheck(1);
    }
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
    expect(h.recordFailure).toHaveBeenCalledTimes(WATCHER_DISABLE_AFTER_FAILURES);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('对照：spec 里的 null 返回 mock 下行为符合预期（说明是 wiring 差异而非逻辑写错）', async () => {
    const sessions = new Map<number, Session>();
    const h = harness({ getSession: (async (id: number) => sessions.get(id) ?? null) as never });
    await h.service.runCheck(1);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(h.watchers.get(1)!.reuseSessionId).toBe(99);
  });

  it('备注：ARCHIVED 会话仍通过预检被复用（设计文档措辞含「归档失效」，实现未覆盖）', async () => {
    const archived = new Map<number, Session>([[42, {
      id: 42, userId: 7, agentId: 3, executionMode: 'CLOUD', sessionType: null, status: 'ARCHIVED',
    } as Session]]);
    const h = harness({ getSession: realSessionServiceGetSession(archived) });
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBe(42);
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });
});
```

### B. `zz-temp-review-repo.spec.ts`（V174 列在仓储层的读写）

```ts
import { describe, expect, it, vi } from 'vitest';
import { toCamelList } from '../common/case.js';
import { MysqlSignalWatcherRepository } from './signal.repository.js';
import type { SignalWatcher } from './types.js';

// ……watcher() fixture（triggerMode:'REUSE_SESSION', reuseSessionId:42）同既有 spec

describe('临时审查：V174 新列在仓储层的读写', () => {
  it('update({reuseSessionId:null}) 真的写出 reuse_session_id = NULL（清指针落库）', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 1 }) as never);
    const repo = new MysqlSignalWatcherRepository({ execute } as never);
    await repo.update(1, 7, { reuseSessionId: null });
    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('reuse_session_id = ?');
    expect(params).toContain(null);
  });

  it('update({reuseSessionId:99}) 写出新指针；insert 带齐 trigger_mode/reuse_session_id', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 1, insertId: 5 }) as never);
    const insert = vi.fn(async () => 5);
    const repo = new MysqlSignalWatcherRepository({ execute, insert } as never);
    await repo.update(1, 7, { reuseSessionId: 99 });
    expect(execute.mock.calls[0]![1]).toContain(99);
    insert.mockClear();
    await repo.insert(watcher({ id: undefined }));
    const [table, data] = insert.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(table).toBe('signal_watcher');
    expect(data).toMatchObject({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42 });
  });

  it('存量行（trigger_mode=NEW_SESSION、reuse_session_id=NULL）读出的形状', async () => {
    const row = { /* V174 后老行的 snake_case 全列，trigger_mode:'NEW_SESSION', reuse_session_id:null */ };
    const queryOne = vi.fn(async () => toCamelList<SignalWatcher>([row])[0] ?? null);
    const repo = new MysqlSignalWatcherRepository({ queryOne } as never);
    const found = await repo.findById(9);
    expect(found?.triggerMode).toBe('NEW_SESSION');
    expect(found?.reuseSessionId).toBeNull();
  });
});
```

> 备注：`runtime-agent.spec.ts` 的 3 个 macOS 路径长度相关失败与本次需求无关（已知环境问题），未纳入本报告结论。
