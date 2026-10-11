# 信号哨兵（Signal Watcher）代码审查（2026-10-11）

审查范围：worktree `/opt/mao-data/workspace/2/projects/mao/.worktrees/signal-watcher`，分支 `feat/signal-watcher` 未提交改动。依据技术方案 `docs/plan/2026-10-11-signal-watcher-technical-design.md` 与其 15 条已确认决策。

已执行：通读 signal 域全部新文件与 spec、既有文件 diff、desktop/admin 前端改动；`npx tsc -p tsconfig.build.json --noEmit` 通过；`npx vitest run --coverage=false src/signal src/common/ssrf.spec.ts` 基线 **8 files / 112 tests 全绿**（本次审查未引入失败）。下列问题均以「失败测试复现 + 复现代码附后」方式验证；探针 spec 写在 `/tmp/review/` 下并以 `--root /tmp/review` 运行，跑完已删除，仓库内无临时文件、未改任何生产代码。

---

## 阻塞项（3）

### BUG-1 `WATCHER_DISABLED` 收件箱通知永远写不进去——连续失败自动停用后用户收不到任何通知

**文件**：`backend-ts/src/inbox/inbox.service.ts:465-495`（`isKindEnabled` 的 switch 缺 `case 'WATCHER_DISABLED'`）

**问题**：`InboxService.record()` 在落库前调用 `isKindEnabled(userId, kind)` 做偏好门控。该 switch 枚举了 `TASK_COMPLETED / TASK_FAILED / QUESTION_PENDING / APPROVAL_PENDING / SUBAGENT_DONE / BUDGET_WARN / TRIGGER_DISABLED / SCHEDULED_TASK_PAUSED / TOKEN_DISABLED / OPEN_API_CALL_FAILED / WEIXIN_REPLY_WINDOW_CLOSED` 共 11 种，**没有 `WATCHER_DISABLED` 分支**，于是落到 `default: return false`。

技术方案 §5.11 明确写「无偏好开关（始终通知——停用是运维级事件，必须让属主知道）」，与 `TRIGGER_DISABLED` 同档。`desktop/src/composables/useInboxSystemNotify.ts` 也确实把它和 `TRIGGER_DISABLED` 放在同一个 `return true` 分支里——三处（`inbox/types.ts` 的 `INBOX_KINDS`、`shared/contracts/src/inbox.ts` 的 `InboxKind`、`desktop` 白名单）都加了，唯独漏了决定「写不写库」的这一处。

**触发场景**：任一哨兵连续失败 5 次 → `recordFailure` 把 `status` 置为 `DISABLED` → `notifyDisabled` 调 `inboxService.recordWatcherDisabled` → `record()` → `isKindEnabled` 返回 false → 直接 return，不 insert、不广播未读数。哨兵静默停用，用户只能自己翻列表看到「已停用」，站内信与系统通知都不出现。

**影响**：决策 8「连续失败 5 次自动停用 + 站内通知」的后半句完全失效。这是本次需求唯一一条面向用户的告警链路，等于没有。`WATCHER_DISABLED` 从此在任何用户收件箱里都不可能存在。

**建议修法**：在 `isKindEnabled` 的 switch 中补一个分支，与 `TRIGGER_DISABLED` / `TOKEN_DISABLED` 并列：

```ts
case 'WATCHER_DISABLED':
  // 无偏好开关：哨兵连续失败自动停用是运维级事件，始终通知属主
  return true;
```

同时在 `inbox.service.spec.ts` 补一条「`recordWatcherDisabled` 会走到 `insertIgnore`」的回归，避免下次加 kind 再漏。

**是否已用测试验证**：是。探针 spec 用假 repo 调 `service.recordWatcherDisabled(...)`，断言 `repo.insertIgnore` **未被调用**（`toHaveBeenCalledTimes(0)`，实际 0）——即整条通知链路在偏好门控处被静默吞掉。同时断言 `isInboxKind('WATCHER_DISABLED') === true`，证明「kind 已知」与「kind 放行」两处已脱节。

复现（`/tmp/review/inbox.spec.ts`，vitest 3.2.7，1 passed）：

```ts
const repo = {
  insertIgnore: vi.fn(async (row) => { inserted.push(row); return false; }),
  countUnread: vi.fn(async () => 0),
  list: vi.fn(async () => []),
  markRead: vi.fn(async () => 1),
  markAllRead: vi.fn(async () => 1),
  findPreference: vi.fn(async () => null),
  savePreference: vi.fn(async () => undefined),
};
const service = new InboxService(repo as never, { emit: vi.fn() } as never, { findById: async () => null } as never);
await service.recordWatcherDisabled({ userId: 7, watcherId: 1, watcherName: 'w', failures: 5 });
console.log('insertIgnore called:', repo.insertIgnore.mock.calls.length); // 0
expect(repo.insertIgnore).not.toHaveBeenCalled();
```

```
insertIgnore called: 0
```

---

### BUG-2 编辑哨兵会丢失已保存的敏感请求头/请求体，甚至直接保存失败——「敏感字段留空不修改」语义在服务端不成立

**文件**：`backend-ts/src/signal/watcher.routes.ts:44-60`（`toInput` 把未传字段映射成 `null`）+ `backend-ts/src/signal/watcher.service.ts:145-160`（`update` 的 `input.x !== undefined` 合并判定）

**问题**：`toInput` 对 `body` / `jsonPath` 一律写 `typeof body.body === 'string' ? body.body : null`——**未提供即 `null`，而非 `undefined`**。`update` 的合并逻辑只认 `!== undefined`（`input.body !== undefined ? input.body : this.decryptBody(...)`），于是 `null` 被当成「显式清空」处理。同时桌面端 `SignalWatchersView.vue:451` 的 `collectHeaders()` 把「掩码行 + 新值为空」的键整个跳过，`submitForm` 拼出的 payload 里 `headers` 就没有那个键，`toInput` 又把它变成 `headers: null`。

三处叠加后，用户在设置页打开编辑框只改一个名称点保存，会依次踩到：

1. **POST 哨兵保存直接失败**：`normalizeInput` 校验 `method === 'POST' && body == null` → 抛「POST 方法必须填写请求体」。用户想改个名字都不行，而且表单 placeholder 明明写着「留空不修改」。
2. **GET 哨兵的敏感请求头被删除**：Authorization 之类的头从库里消失，下次轮询就 401 → 连败 5 次 → 触发 BUG-1 那条失效的通知。用户完全不知道是自己的编辑操作弄丢了凭据。
3. **历史 body 被清空**（GET 方法残留 body 的数据）。

**触发场景**：设置页 → 任一哨兵 → 编辑 → 只改名称/间隔 → 保存。

**影响**：决策 9 的配套语义（§5.8「敏感字段：编辑时请求头敏感值显示 `******`，留空表示不修改；`body` 显示长度占位」）只在前端做了展示约定，服务端没有任何「留空不修改」的承接，实际效果是「留空即删除」。凭据静默丢失 + 保存被拒两条都命中。

**建议修法**：`toInput` 区分类别——标量字段（`name/agentId/url/method/intervalMinutes/compareMode/promptTemplate`）缺省给 `undefined`；`headers` / `body` / `jsonPath` 这类可「留空不修改」的字段改为「仅当请求体里真的带了 key 才给值」。最直接的做法是 `toInput` 返回 `Partial<WatcherInput>` 时用 `'body' in body ? (typeof body.body === 'string' ? body.body : null) : undefined` 判断键存在性，而不是用 `typeof === 'string'` 判值；`update` 的合并逻辑随之只对真正显式下发的字段生效。若要与前端对齐，还应约定「掩码值 `******` 回传即视为未修改」（见 BUG-4）。

**是否已用测试验证**：是。用精确复刻的 `routeToInput` + `desktopPayload`（照抄 `watcher.routes.ts` 的 `toInput` 与 `SignalWatchersView.vue` 的 `collectHeaders`/`submitForm`）跑 4 个场景，3 个失败（`/tmp/review/desktop-edit.spec.ts`）：

```
场景1：只改名称，POST 哨兵 → 保存被拒（"POST 方法必须填写请求体"）      ✓ 复现
场景2：只改名称，GET 哨兵带敏感头 → 敏感头被删除 + 基线被重置            ✗
        stored headers = {"Accept":"application/json"}
        （期望 {"Authorization":"Bearer SECRET","Accept":"application/json"}）
场景3：只改名称，GET 哨兵无请求头 → 基线被无谓重置                       ✗  lastValueHash = null
场景4：只改名称，GET 哨兵带 body → body 被清空 + 基线重置                ✗  stored body = null
```

```ts
function routeToInput(body: Record<string, unknown>) {
  const headersRaw = body.headers;
  let headers: Record<string, string> | null = null;
  if (headersRaw != null) { headers = {}; /* ...逐项 String()... */ }
  return { /* ... */, body: typeof body.body === 'string' ? body.body : null, /* ... */ };
}
// 桌面端 payload：掩码行留空 → 键被 collectHeaders 跳过；POST 且输入为空 → body: null
const payload = desktopPayload({ name: '新名字', /* ... */, method: 'GET', body: '',
  headers: [ { key: 'Authorization', value: '', masked: true }, { key: 'Accept', value: 'application/json', masked: false } ] });
await h.service.update(7, 1, routeToInput(payload) as never);
expect(stored).toBe(JSON.stringify({ Authorization: 'Bearer SECRET', Accept: 'application/json' })); // 实际只剩 Accept
```

---

### BUG-3 任何一次编辑都会重置轮询基线——决策 9「其余编辑不重置」被违反

**文件**：`backend-ts/src/signal/watcher.service.ts:162-166`（`resetBaseline` 的 `AFFECTS_BASELINE.some(...)` 判定）

**问题**：`resetBaseline` 对 `AFFECTS_BASELINE = ['url','method','headers','body','compareMode','jsonPath']` 逐项比对「入参」与「库内原文」。由于 BUG-2 的 `toInput` 把 `headers` 缺省成 `null`、`jsonPath` 缺省成 `null`，一次只改名称的 PUT 会让：

- `headers`：入参 `null` vs 库内 `{}`（无请求头时 `decryptHeaders` 返回 `{}`）→ `JSON.stringify` 不同 → 判定为「变化」；
- `jsonPath`：入参 `null` vs 库内 `'data.price'`（JSON_FIELD 模式）→ 判定为「变化」。

于是 `patch.lastValueHash = null; patch.lastChangedAt = null` 被执行，基线被清空。技术方案 §5.6 步骤 6 写「首轮只建基线」、决策 9 写「只改名称/prompt/间隔/启停不重置」——用户只是重命名一下，哨兵就要多跑一轮空轮询重建基线，`last_changed_at` 历史也被抹掉，详情页「上次变化」显示成「从未」。

更糟的是 JSON_FIELD 模式还会先撞上 BUG-1 同源的 `jsonPath: null` → `normalizeInput` 抛「JSON_FIELD 模式必须填写提取路径」，连改名都改不了（`/tmp/review/update-bugs.spec.ts` 已验证该异常）。

**触发场景**：PUT `/v1/signal-watchers/:id` 且请求体未携带 `headers` / `jsonPath` 键——桌面端编辑框对任何字段的保存都会走到这里。

**影响**：决策 9 的名存实亡。轻则每次编辑多一次空轮询、抹掉变化历史；重则 JSON_FIELD 哨兵根本无法编辑。同时它还是 BUG-2 中「凭据丢失」的放大器：凭据丢了 + 基线也重置了，用户看到的是「刚编辑过，然后一直未变」。

**建议修法**：与 BUG-2 同源，修 `toInput` 让「未下发的字段为 `undefined`」后本条自动消解。若想再加一层保险，可把 `resetBaseline` 的比对改为只比对「本次真的下发了的字段」，并把 `existingRaw` 的 `headers` 口径统一成 `null`（无请求头时返回 `null` 而非 `{}`），避免空对象/`null` 的假差异。

**是否已用测试验证**：是。`/tmp/review/update-bugs.spec.ts` 与 `/tmp/review/desktop-edit.spec.ts` 场景 3/4：

```
HASH/no-headers: lastValueHash = null  lastChangedAt = null   （期望保持 'abc' / '2026-10-11 10:00:00'）
JSON_FIELD:      lastValueHash = null                          （期望保持 'abc'）
PUT {name} only on a JSON_FIELD watcher throws "JSON_FIELD 模式必须填写提取路径"  ✓
```

```ts
const h = harness(watcher({ lastValueHash: 'abc', lastChangedAt: '2026-10-11 10:00:00' }));
await h.service.update(7, 1, routeToInput({ name: 'renamed' }) as never);
console.log('lastValueHash =', h.watchers.get(1)!.lastValueHash); // null，期望 'abc'
```

---

## 重要（4）

### BUG-4 掩码值 `******` 会被当普通值原样落库并真的发给目标服务器

**文件**：`backend-ts/src/signal/watcher.service.ts:345-352`（`encryptHeaders` 无掩码过滤）

**问题**：`toView` 用 `maskProbeHeaders` 把敏感头打码成 `******`（`probe-validate.ts:17` 的 `SECRET_MASK`）。前端 `SignalWatchersView.vue` 的 `isMaskedValue` 只在前端把输入框清空，但服务端 `update` 对 `headers` 里出现的 `******` **没有任何过滤**——`encryptHeaders(normalized.headers)` 直接 `JSON.stringify` 后加密落库。任何非前端来源的调用（API 直调、旧版本前端、curl 调试）把回显值原样回传，`******` 就成了真实凭据，之后每次轮询都发出 `Authorization: ******`，对端恒 401，而用户在界面上看到的值和「已保存」的值一模一样，无从察觉。

**触发场景**：把 `GET /v1/signal-watchers` 的返回体改个名字再 `PUT` 回去（很自然的「改个名」操作）；或直接用回显值构造请求。

**影响**：凭据被静默替换成掩码占位符，哨兵进入慢性失败，且失败原因（401）与「凭据错误」在错误串里看不出来。

**建议修法**：`normalizeInput` 之后、`encryptHeaders` 之前过滤一层——若某键 `isSensitiveProbeHeader(key)` 且值等于 `SECRET_MASK`，则用库内解密后的原值替换（而不是删键，删键就是 BUG-2 的效果）。可与 BUG-2 的「留空不修改」合并成同一套「敏感值保留语义」。

**是否已用测试验证**：是。`/tmp/review/update.spec.ts`：库内 `Authorization: Bearer T`，`update({ headers: { Authorization: '******' } })` 后解密得到的正是 `{"Authorization":"******"}`——掩码被当成明文存了。

```
STORED-HEADERS-DECRYPTED: {"Authorization":"******"}
```

---

### BUG-5 管理后台「判定模式」筛选是死的——后端 `listForAdmin` 没有对应参数

**文件**：`admin/src/views/signal/SignalWatcherListView.vue:22-23,151` vs `backend-ts/src/signal/signal-admin.routes.ts:38-40` + `backend-ts/src/signal/signal.repository.ts:60-86`

**问题**：管理后台筛选表单有「判定模式」下拉（`filters.compareMode`），`buildParams` 也确实把它放进 query（`compareMode: filters.compareMode || undefined`）。但 `signal-admin.routes.ts` 只读了 `status` 与 `userId`，`queryOptStr(request, 'compareMode')` 从未被调用；`listForAdmin` 的 filter 类型也只有 `{ status, userId }`，SQL 不会拼 `compare_mode = ?`。

**触发场景**：管理后台「信号哨兵」页选择「判定模式 = 状态码」→ 点查询 → 返回全量列表（该筛选条件下应有 0 条或少量）。界面无任何提示，用户会以为「没有状态码模式的哨兵」。

**影响**：筛选结果错误且无提示，属误导性 UI。CHANGELOG 已宣传「支持按状态、属主、判定模式筛选」，实际只生效两个。

**建议修法**：二选一——(a) 后端 `signal-admin.routes.ts` 读 `compareMode` 并用 `isSignalCompareMode` 校验后传入 `listForAdmin`，`listForAdmin` 加 `compare_mode = ?` 分支；(b) 删掉前端那个下拉。考虑到 CHANGELOG 已对外承诺，选 (a)。

**是否已用测试验证**：是。`/tmp/review/admin-filter.spec.ts` 直接调 `registerSignalAdminRoutes` 注册的 handler，请求带 `compareMode=STATUS_CODE`，断言 `listForAdmin` 收到的 filter 里 `compareMode` 为 `undefined`：

```
listForAdmin called with: [1,20,{"status":"ACTIVE","userId":7}]
expect(filter.compareMode).toBeUndefined()  ✓
```

---

### BUG-6 `listForAdmin` 的 `OFFSET` 与 `LIMIT` 用了不同的 size 口径，深页会漏数据

**文件**：`backend-ts/src/signal/signal.repository.ts:82`

**问题**：`LIMIT ${Math.max(1, Math.min(200, size))} OFFSET ${Math.max(0, (page - 1) * size)}`——`LIMIT` 对 `size` 做了 1..200 钳制，`OFFSET` 用的是**未钳制的原始 `size`**。当 `size > 200` 时两者不一致：`size=300, page=3` → `LIMIT 200 OFFSET 600`，而按 `LIMIT 200` 的口径第 3 页的 offset 应为 `400`，中间 200 行被跳过。当前管理后台路由把 size 压到 `Math.min(100, ...)`（`signal-admin.routes.ts:22-24`），所以这条只在绕过路由直连 repo 时复现；但仓库自身钳制口径不一致，是明显的隐患（`listByWatcher` 用的是先钳 `safeSize` 再算 offset 的正确写法，同文件两种风格）。

**触发场景**：`size > 200` 的请求（当前路由不可达；若后续放宽 page-size 上限或新增调用方即触发）。

**影响**：深页数据静默缺失。

**建议修法**：与 `listByWatcher` 对齐——先算 `const safeSize = Math.max(1, Math.min(200, size))`，再 `OFFSET ${Math.max(0, (page - 1) * safeSize)}`。

**是否已用测试验证**：是。`/tmp/review/pagination.spec.ts`：

```
listForAdmin(3, 300) → SELECT * FROM signal_watcher ORDER BY id DESC LIMIT 200 OFFSET 600
listForAdmin(1000, 100) → ... LIMIT 100 OFFSET 99900
```

---

### BUG-7 探针在途期间用户暂停哨兵，仍会照常触发一次 Agent 运行

**文件**：`backend-ts/src/signal/watcher.service.ts:279-281`（`runCheck` 只在入口读一次 `status`）

**问题**：`runCheck` 入口判定 `watcher.status !== 'ACTIVE'` 就返回，但随后 `await probe.execute(...)` 可能挂 10~15 秒（连接超时/读取超时上限）。这期间用户点「暂停」，`status` 变 `PAUSED`；探针回来后代码**不再复读状态**，直接走判定 → 渲染 prompt → `openRun.run({ source:'SIGNAL' })`，一次完整的 Agent 运行被发起并计入用量。

技术方案 §9.7 只承诺了 DISABLED 场景（「探针已在途时被并发置 DISABLED……不会触发（触发前复读状态）」），但实现里既没有对 DISABLED 的复读，也没有对 PAUSED 的复读——文档承诺的行为其实也没做到。PAUSED 是用户主动「先别跑了」的表达，被绕过更不可接受。

**触发场景**：哨兵间隔设 1 分钟 + 目标端响应慢（接近超时）→ 用户在看到「运行中」的点暂停 → 暂停后仍有一次 Agent 会话被创建。

**影响**：用户暂停操作不可靠；可能产生用户未预期的 Agent 运行与用量。量级小但属确定性的行为偏差。

**建议修法**：在 `openRun.run` 之前复读一次状态（`const fresh = await this.deps.watcherRepo.findById(watcher.id)`，`fresh == null || fresh.status !== 'ACTIVE'` 则只写 check 行不触发），与 §9.7 的承诺对齐。注意这条复读要放在 `markChanged`/频次统计之后、`openRun` 之前，避免无谓的 check 写入被回滚。

**是否已用测试验证**：是。`/tmp/review/concurrency.spec.ts` 第二条：probe 执行期间把行改成 `PAUSED`，`runCheck` 跑完后 `openRun.run` 被调用了 1 次（期望 0）：

```
openRun called after PAUSE: 1
```

---

## 建议（3）

### SUG-1 `markChecked` 无条件覆盖 `consecutive_failures`，会清掉并发累加的失败计数

**文件**：`backend-ts/src/signal/signal.repository.ts:133-152`

`markChecked` 的 SQL 是 `SET ... consecutive_failures = ?, last_checked_at = ?`，值来自 `runCheck` 开始时读到的那份快照（`consecutiveFailures: 0` 或 `watcher.consecutiveFailures`）。探针在途的 10~15 秒内若有并发失败（多实例部署、或前一次遗留的退避写入），成功那次会把计数覆盖回 0，使「连续 5 次失败自动停用」更难达成。单实例 + 单飞语义下概率很低，但 SQL 用 `consecutive_failures = 0` 的绝对值而非条件更新，与 `recordFailure` 的 `consecutive_failures + 1` 风格不一致。

**建议**：`markChecked` 的成功路径改为 `consecutive_failures = 0` 仍可接受，但加 `WHERE id = ? AND status = 'ACTIVE'`，并在文档注明「成功即清零」的口径；或改为 `GREATEST(consecutive_failures - 1, 0)` 之类的缓和策略。属一致性改进，不阻塞。

**是否已用测试验证**：是（现象复现，`/tmp/review/concurrency.spec.ts` 第一条）：探针在途期间把 `consecutiveFailures` 改成 4，成功后变为 0。

### SUG-2 空白字符作为请求头键名会通过校验，变成空 header 名

**文件**：`backend-ts/src/signal/probe-validate.ts:60`

`rawKey === ''` 只挡真空串；`'   '` /`' \t '` 不含 `:` 也不含 `\r\n`，通过校验后 `rawKey.trim()` 得到 `''`，落库成一个空键名的请求头。`node:http` 随后抛 `ERR_INVALID_HTTP_TOKEN`，`executeProbe` 的 try/catch 捕获后返回 `ok=false, error='连接失败: ERR_INVALID_HTTP_TOKEN'`——不会崩溃，但这条哨兵会永久连败到自动停用，而错误信息完全指不到真正原因（用户看到的是「连接失败」而不是「请求头名不合法」）。

**建议**：把空键判定改成 trim 后判断——`if (rawKey.trim() === '' || rawKey.includes(':') || /[\r\n]/.test(rawKey))`。注意顺序：仍要先按原样做 `\r\n`/`:` 检查（现有注释已说明理由），只是把 `rawKey === ''` 换成 `rawKey.trim() === ''`。

**是否已用测试验证**：是。`/tmp/review/headers.spec.ts` + `/tmp/review/empty-header.spec.ts`：

```
assertProbeHeaders({ "   ": "v" }) → { "": "v" }
executeProbe → {"ok":false,"error":"连接失败: ERR_INVALID_HTTP_TOKEN"}
```

### SUG-3 `update()` 重置基线时不清 `last_value_snippet`，与 `setStatus()` 口径不一致

**文件**：`backend-ts/src/signal/watcher.service.ts:177-180` vs `203-206`

`update` 的 `resetBaseline` 分支只清 `lastValueHash` / `lastChangedAt`；`setStatus`（DISABLED→ACTIVE）清的是 `lastValueHash` / `lastValueSnippet` / `lastChangedAt` 三项。实际影响很小（下一次成功轮询建基线时会覆盖 `lastValueSnippet`），但两处口径不一致，读代码时会误判。顺带：若「重置基线后第一次轮询恰好失败」，残留的旧 snippet 会短暂留在库里。

**建议**：`update` 的 `resetBaseline` 分支补 `patch.lastValueSnippet = null;`。

**是否已用测试验证**：是（现象记录，`/tmp/review/misc.spec.ts`）：`update({url})` 后 `lastValueHash = null` 而 `lastValueSnippet = 'OLD-SNIPPET'`。

---

## 已检查未发现问题的要点

- **探针执行器（决策 2/4）**：连接超时、读取超时、1MB 流式上限、3xx 不跟随（301/302/304 均 `ok=false` + `重定向未跟随`）、错误脱敏（只回 `err.code`，不拼 URL/响应体）全部按预期工作。双 timer 在收到响应头时正确切换，超限/超时后 `finish` 幂等（`settled` 标记）不会二次 resolve。
- **SSRF 校验（决策 3）**：`assertProbeUrl` 拒 http/https 以外协议、内嵌凭据、`127.0.0.1` / `10.x` / `192.168.x` / `169.254.x` / `0.x` / IPv6 字面量 / `.local` / `.internal`。短形式 IP（`127.1`、`2130706433`、`0x7f000001`、`017700000001`、`0`）因 `new URL().hostname` 已规范化为点分四段而**全部被正确拒绝**（已实测，非绕过）。DNS Rebinding 时间窗为方案 §9.1 已记录的开放问题，不在本次审查范围。
- **请求头注入防护**：`Host`/`Content-Length`/`Transfer-Encoding`/`Connection` 任意大小写均拒；键含 `:` 或 `\r\n` 拒；值含 `\r\n` 拒；>20 个拒。校验先按原样做再 trim，没有 trim-then-check 的绕过。唯一缺口是 SUG-2 的空白键名。
- **调度器（决策 5/10）**：`inFlight` 单飞、`dispatching` 防重入、`stop()` 后不再扫描、重启后 due 状态完全落在 `last_checked_at` 列上——均符合设计。`agentExecutor.submit` 抛 `AgentExecutorRejectedError` 时异常会向上穿出 `dispatchDueWatchers`（被 `scheduleNext` 的 `.catch` 记录），不会静默卡死调度链；但要注意该轮已 `inFlight.add` 的 watcher 会被永久卡在在途标记里不再轮询（线程池饱和时的边缘场景，本次未列为阻塞——饱和本身是更严重的系统级问题，且 `OutboundDeliveryScheduler` 有同样特征）。
- **退避与自动停用（决策 8/10）**：`interval * min(2^failures, 32)` 正确；`recordFailure` 的 `WHERE id = ? AND status = 'ACTIVE'` 保证 PAUSED 不被误改；阈值 5 到达时通知一次（受 BUG-1 影响实际不落库）。
- **清理器（决策 11）**：`cutoff` 计算、分批 5000×20 上限、保留天数非法回落 90、`stop()` 后不再清理，与 `OpenApiCallLogCleanup` 完全一致。
- **source 五处扩展（决策 1）**：`TaskNotifySource` / `MessageQueueSource` / `QueuedSource` / `OpenRunInput.source` / `liveExecution` 第 7 参加 `'SIGNAL'` 后，`queueSettlementOf` 对 SIGNAL 行返回 `{taskId:null, triggerId:null, callLogId:null}`，`settleQueuedBinding` 的三个 `!= null` 分支全部跳过——与 §5.6「无排队回写绑定」的决策一致，不会误回写。
- **装配与关闭（§5.10）**：cipher/service/scheduler/cleanup 均实例化并 `start()`，`onClose` 里 `watcherScheduler.stop()` 与 `signalCheckCleanup.stop()` 成对出现；`agentExecutor` 定义在信号哨兵装配之前（`create-app.ts:1049` vs `1515`），无 TDZ 问题。
- **加密（决策 4）**：`SignalSecretCipher` 与 `ApiTokenCipher` 同模式，`APP_SIGNAL_SECRET` 未配置时抛 `INTERNAL_ERROR` 并给出可操作提示；落库为 `nonceB64:cipherB64`；回显只给 `hasBody`/`bodyLength`/打码 headers，`JSON.stringify(view)` 不含明文（spec 已断言）。
- **迁移 V148**：两表列与 `types.ts` 对应，`idx_watcher_due(status, last_checked_at)` 覆盖 `listDue`，`idx_check_checked_at` 覆盖清理器；权限与设置项的 `WHERE NOT EXISTS` / `INSERT IGNORE` 写法与 V145 一致，可重复执行。
- **既有单测**：`src/signal` + `src/common/ssrf.spec.ts` 共 112 条全绿，`tsc --noEmit` 通过。微信侧 `validateCallbackBaseUrl` 改为 import 复用后行为不变（`isPrivateOrReservedHostname` 原样迁移）。
