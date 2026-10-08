# 核心功能逻辑缺陷审查

- 日期：2026-10-08
- 范围：会话分组、钉钉排队卡片、一次性定时任务、管理员保护、开放触发、上下文压缩、Agent 工具流、桌面收件箱
- 审查方式：读实现后写临时探针，断言正确行为。探针全部失败，且失败点与源码分支一致。探针文件跑完已删除，未改产品代码，也未改原有测试。
- 命令：
  - `cd backend-ts && npx vitest run src/review-probe-20261008-core.spec.ts --coverage.enabled=false`
  - `cd desktop && npx vitest run src/stores/inbox/inbox-loadmore-probe.test.ts`
- 结果：后端探针 9 个失败；其中 7 个是 BUG-1 至 BUG-7，另外 2 个按错误预期失败，见文末「未计入」。桌面探针 1 个失败，即 BUG-8。合计 8 个缺陷。

## 结论

确认 8 个会改变用户可见行为的逻辑缺陷。分组预览、钉钉插队、一次性任务完结、最后管理员判定、开放接口实际执行的 Agent、压缩「节省 token」、流式工具参数拼接、收件箱翻页，各自在现有测试覆盖的路径上没有拦住这些分支。

## BUG-1 飞书/钉钉私聊「无 Agent」分组展开后查不到会话

侧栏分组键在 `agentId` 为空时写成 `FEISHU_PRIVATE:null` / `DINGTALK_PRIVATE:null`。首屏分组来自内存里的 `of(session)`，这类会话能出现在分组预览里。点「展开更多」走 `listSessionsByGroup` → `applyFilter`，条件是 `agent_id = ?`，参数为 `null`。

mysql2 会把 `null` 绑成 SQL `NULL`。`agent_id = NULL` 在三值逻辑下永不成立，分页结果恒为空。同文件的嵌入分组对 `EMBED:null` 已经写成 `agent_id IS NULL`。

```59:65:backend-ts/src/session/util/session-group-key.ts
  if (groupKey.startsWith(FEISHU_PRIVATE_GROUP_PREFIX)) {
    const agentId = groupKey.slice(FEISHU_PRIVATE_GROUP_PREFIX.length);
    return {
      clauses: ['execution_mode = ?', 'agent_id = ?', 'project_key LIKE ?'],
      params: ['CLOUD', agentId === 'null' ? null : Number(agentId), 'feishu-%-private-%'],
    };
  }
```

钉钉私聊是同一写法（`applyDingtalkFilter`，约 42–48 行）。`listSessionsByGroup` 把这些子句用 `AND` 拼进 WHERE，参数原样下传（`session.service.ts` 约 279–280 行）。

复现：`of({ projectKey: 'feishu-1-private-2', agentId: null, executionMode: 'CLOUD' })` 得到 `FEISHU_PRIVATE:null`，再对 `applyFilter` 断言子句含 `agent_id IS NULL` 且参数不含 `null`。钉钉 `dingtalk-1-private-8` 同样。

失败断言：

```text
AssertionError: expected 'execution_mode = ? agent_id = ? proje…' to match /agent_id IS NULL/
Received: "execution_mode = ? agent_id = ? project_key LIKE ?"
```

## BUG-2 钉钉排队卡「立即执行」在插队失败时仍当成功并打断会话

`jumpToFront` 返回 false 表示这一行已经不是 `QUEUED`（并发消费已经把它拿走）。飞书回调在 `!jumped` 时直接回「该消息已开始执行」，不再中断。

钉钉用的是查找时的快照 `row.status`。快照仍是 `QUEUED`、库内更新已经失败时，`!jumped && row.status !== 'QUEUED'` 为假，于是回 `status: started`，并在 `after` 里调用 `interruptAndDrain`。用户点的是一条已经开跑的排队消息，卡片却显示「已开始处理」，当前会话被打断。

```59:64:backend-ts/src/dingtalk/card-action.service.ts
    const jumped = await this.options.queuePort.jumpToFront(row.id);
    if (!jumped && row.status !== 'QUEUED') return { response: cardCallbackResponse(null, '该排队消息已开始或已失效') };
    return {
      response: cardCallbackResponse(queueCardParams({ status: 'started', preview, queueId: row.id, senderUserid: row.senderUserid })),
      after: async () => { this.options.interruptAndDrain(row.sessionId); },
    };
```

对照飞书（`feishu/card-action.service.ts` 约 309–310 行）：`if (!jumped) return { toast: { type: 'info', content: '该消息已开始执行' } }`。

复现：队列行快照 `status: 'QUEUED'`，`jumpToFront` 固定返回 `false`。断言回包含「已开始或已失效」，且没有 `after`。

失败断言：

```text
AssertionError: expected '{"cardUpdateOptions":{"updateCardData…' to contain '已开始或已失效'
Received: "...\"title\":\"已开始处理\"...\"status\":\"started\"..."
```

断言在回包处停下，后面的 `after` 断言没有执行。上面的 return 与回包是同一分支，`after` 会调用 `interruptAndDrain(sessionId)`。

## BUG-3 一次性定时任务在排队阶段被取消后永远不再执行

会话正忙时，一次性任务只入队、不执行，但立刻把 `finished` 写成 1，并清空 `nextFireTime`。调度扫描只取 `finished = 0 AND next_fire_time <= ?`（`scheduled-task.store.ts` 的 `listDue`）。

队列稍后被用户停止，终态是 `CANCELLED`。`create-app.ts` 的回写只改 `lastExecutionStatus`，不把 `finished` 放回 0，也不恢复下一触发时间。任务列表上是「已完结 / 已取消」，这次提示词从未跑过，也不会再跑。

```441:448:backend-ts/src/schedule/scheduled-task.service.ts
                if (latest.once === 1) {
                  patch.finished = 1;
                  patch.finishedAt = enqueuedAt;
                  patch.nextFireTime = null;
                  task.finished = 1;
                  task.finishedAt = enqueuedAt;
                  task.nextFireTime = null;
                }
```

```1327:1329:backend-ts/src/create-app.ts
    onScheduledTaskQueueConsumed: async (taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await scheduledStore.updateById({ id: taskId, lastExecutionStatus: status });
    },
```

复现：`once: 1`、会话 `phase: 'RUNNING'`（忙则入队）。`executeTask` 之后内存行已是 `finished === 1`、`lastExecutionStatus === 'QUEUED'`（这两条断言通过）。再按生产回写调用 `updateById({ id: 1, lastExecutionStatus: 'CANCELLED' })`，断言 `finished === 0`。

失败断言：

```text
AssertionError: expected 1 to be +0 // Object.is equality
Expected: 0
Received: 1
```

`nextFireTime` 的断言没有执行到。入队补丁里已经把它写成 `null`，`NULL <= ?` 同样不会被 `listDue` 扫到。

## BUG-4 可登录的 `status=null` 管理员不计入「其他活跃管理员」

登录只把 `status === 0` 当成停用；`status == null` 可以登录（`auth.service.ts` 的 `buildLoginResult`）。同文件注释写明 SSO / 外部账号默认就是 `status=null`，并且允许管理员把自己的状态清空成 `null`。

降级角色、禁用管理员时，「其他活跃管理员」只数 `status === 1`。系统里还有一名 `status=null` 且绑着 ADMIN 的账号时，降级那名 `status=1` 的管理员会被拒绝，错误是「不能移除最后一个管理员」。那名 `status=null` 的管理员此时仍能登录并行使管理权限。

```274:286:backend-ts/src/permission/permission.service.ts
  private async countOtherActiveAdmins(adminRoleId: number, excludeUserId: number): Promise<number> {
    const bindings = await this.userRoleRepo.findByRoleId(adminRoleId);
    let count = 0;
    for (const b of bindings) {
      if (b.userId === excludeUserId) {
        continue;
      }
      const user = await this.userRepo.findById(b.userId);
      if (user && user.status === 1) {
        count += 1;
      }
    }
    return count;
  }
```

同一比较还出现在 `updateUserStatusWithAdminGuard`（约 218 行）和 `assertNotLastAdmin`（约 246 行）。

复现：ADMIN 绑定用户 10 与 20。用户 20 的 `status` 为 `null`。对用户 10 调用 `assertCanChangeRoles(10, [2])`（去掉 ADMIN）。断言应成功返回。

失败断言：

```text
AssertionError: promise rejected "BusinessException: 不能移除最后一个管理员" instead of resolving
Serialized Error: { code: 3017 }
```

## BUG-5 开放触发按路径上的 Agent 做准入，按会话上的 Agent 执行

`POST /v1/open/agents/:agentId/run` 和 Webhook 触发器都带 `agentId`。指定 `sessionId` 时，只校验归属、主会话、CLOUD，不要求 `session.agentId === input.agentId`。预算闸门用的是请求里的 `agentId`。真正建上下文时，Harness 按库里的 `session.agentId` 加载 Agent（系统提示词、技能、默认模型）。

把触发器改到 Agent B、会话仍是 Agent A 的对话时：B 的预算可能误拦或误放行，跑起来的是 A。

```99:113:backend-ts/src/openapi/open-run.service.ts
    if (input.sessionId != null) {
      const loaded = await this.deps.sessionService.getSession(input.sessionId);
      if (loaded == null || loaded.userId !== input.userId) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      if (loaded.sessionType === 'SUBAGENT' || loaded.sessionType === 'SIDE_TASK') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持主会话');
      }
      if (loaded.executionMode === 'LOCAL') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持云端执行会话');
      }
      session = loaded;
    }
```

预算检查在同文件约 92–96 行，参数是 `input.agentId`。执行侧：

```267:269:backend-ts/src/harness/core/harness-service.ts
    const session = await this.sessionMapper.selectById(sessionId);
    if (session == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    const agent = await this.agentMapper.selectById(session.agentId!);
```

`liveExecution(session, ...)` 传入的是上面加载到的会话对象（`open-run.service.ts` 约 151 行），不是按路径 `agentId` 新建的会话。触发器绑定会话的 `assertBindableSession` 同样不比对 Agent。

复现：会话 `agentId: 1`，请求 `agentId: 2`，Agent 2 存在且启用。断言应抛 `BusinessException`，且不调用 `liveExecution`。

失败断言：

```text
AssertionError: promise resolved "{ sessionId: 11, messageId: 101, queued: false, terminalPhase: 'COMPLETED' }" instead of rejecting
```

## BUG-6 压缩「节省 token」用低估的估算值，不用触发时的真实用量

触发阈值会在估算值低于 `activeTokensHint` 时改用 hint（注释写明中文和工具结果会被估算器低估）。落库和事件里的 `beforeRequestTokens` 仍传估算值。编排层用 `beforeRequestTokens - afterRequestTokens` 计算 `savedTokens`（`session-compaction-orchestrator.ts` 约 117 行）。压缩开始事件 `onCompactionStart` 的第三个参数也是这个估算值（约 128 行）。

结果是：真实用量 900、估算 100、阈值 800 时压缩会触发，但记录下来的压缩前用量是 100，节省量接近 0。

```108:112:backend-ts/src/harness/core/compaction-service.ts
    const normalRequestTokens = this.tokenEstimator.estimateRequestTokens(normalRequest);
    const effectiveWindow = CompactionConfig.resolveEffectiveContextWindow(modelConfig, config);
    const measuredTokens = activeTokensHint != null && activeTokensHint > normalRequestTokens
      ? activeTokensHint
      : normalRequestTokens;
```

```146:146:backend-ts/src/harness/core/compaction-service.ts
      const result = this.buildSafeResult(expectedOldBoundary, messages, snapshotMessageIds, handoff, normalRequestTokens, started);
```

现有用例 `hintAboveThresholdTriggersDespiteUnderestimating` 只断言「会触发」，不断言 `beforeRequestTokens`。

复现：`estimateRequestTokens` 固定返回 100，`activeTokensHint` 传 900，窗口 1000、阈值 0.8。断言 `result.beforeRequestTokens === 900`。

失败断言：

```text
AssertionError: expected 100 to be 900 // Object.is equality
Expected: 900
Received: 100
```

## BUG-7 流式工具调用晚到的真实 id 没有写回，后续参数被截断

部分网关第一片只有 `index`、没有 `id`。循环会合成 `call-<uuid>`，后续带 `index` 的分片按 index 合并。合并时只拼接 `name` / `arguments`，不把真实 `id` 写回目标。

再来一片只有真实 `id`、没有 `index` 的参数时，`findMergeTarget` 按 id 找不到合成 id，按 index 也找不到，于是再 push 一条。真正派发出去的是截断参数；后半段挂在一条没有工具名的调用上，被当成「不在允许的工具集内」。

```724:753:backend-ts/src/harness/core/agent-loop.ts
  private findMergeTarget(existing: ToolCall[], delta: ToolCall): ToolCall | undefined {
    if (delta.id) {
      const byId = existing.find((tc) => tc.id === delta.id);
      if (byId) return byId;
      // 首片无 id 的调用已被合成 id 占位：后续分片带回真实 id 时按 index 归并，
      // 否则同一调用会被拆成两条 tool call 重复派发
      if (delta.index != null) {
        return existing.find((tc) => tc.index === delta.index);
      }
      return undefined;
    }
    // ...
  }
  private applyToolCallDelta(target: ToolCall, delta: ToolCall): void {
    if (!target.function) target.function = { name: '', arguments: '' };
    if (!delta.function) return;
    // 只改 name/arguments，target.id 保持合成值
```

现有用例 `merges a late id-bearing delta...` 的第二片同时带 `index` 和 `id`，并断言 id 仍匹配 `/^call-/`。它覆盖了「带 index 时不拆成两次派发」，没有覆盖「真实 id 写回之后，只带 id 的分片」。

复现：同一轮依次喂入

1. `{ index: 0, function: { name: 'shell', arguments: '{"command":' } }`
2. `{ index: 0, id: 'call-real', function: { arguments: '"pw' } }`
3. `{ id: 'call-real', function: { arguments: 'd"}' } }`

断言只派发一次，且 `argumentsJson` 为 `{"command":"pwd"}`，助手消息里只有一条 `id === 'call-real'` 的 tool call。

失败断言（`toHaveBeenCalledTimes(1)` 已通过，失败在参数）：

```text
AssertionError: expected "spy" to be called with arguments: [ ObjectContaining{ "argumentsJson": "{\"command\":\"pwd\"}", "toolName": "shell" } ]

Received 1st spy call:
  argumentsJson: "{\"command\":\"pw"
  callId: "call-bc15f1b5-c6b5-47e2-bfd9-16abbf39f8d2"
  toolName: "shell"

Number of calls: 1
```

`callId` 是合成 uuid，不是 `call-real`。第三条分片的 `d"}` 没有拼进这次派发。长度断言没有执行到。

## BUG-8 收件箱「加载更多」用整页替换，第一页消失

抽屉按钮文案是「加载更多」。`loadMore` 把下一页交给 `applyPage`，`applyPage` 执行 `this.items = result.records`。翻到第二页后，第一页条目从列表里消失。`hasMore` 仍按 `page * size < total` 计算，所以还能继续点，但每次只剩当前页。

```123:142:desktop/src/stores/inbox/index.ts
    async loadMore(): Promise<void> {
      if (this.loadingMore || !this.hasMore) return
      const next = this.page + 1
      this.loadingMore = true
      try {
        const result = await fetchInboxList({ page: next, size: this.size, unreadOnly: this.unreadOnly })
        this.applyPage(result, next)
      } catch {
        // toast 已由拦截器处理
      } finally {
        this.loadingMore = false
      }
    },

    applyPage(result: InboxListResult, page: number): void {
      this.items = result.records
```

`desktop/src/stores/inbox/inbox.test.ts` 约 99–112 行的用例名叫「loadMore 追加下一页」，断言却是 `toEqual([3])`。这条回归把替换行为锁成了期望值。

复现：第一页记录 id 为 1、2，`total: 42`；第二页记录 id 为 3。断言 `items` 的 id 为 `[1, 2, 3]`。

失败断言：

```text
AssertionError: expected [ 3 ] to deeply equal [ 1, 2, 3 ]

- Expected
+ Received

  [
-   1,
-   2,
    3,
  ]
```

命令：`cd desktop && npx vitest run src/stores/inbox/inbox-loadmore-probe.test.ts`（该文件 1 个用例失败，exit=1）。

## 未计入

- 边路任务完成后仍会 `prepare` 出 webhook 投递。探针按「应返回 null」失败，插入了一条 `SIDE_TASK` / `WAITING_WS` 记录。`docs/plan/2026-07-13-task-completion-webhook-notification-design.md` 写明普通任务和 Side Task 都要做完成通知。站内收件箱和出站订阅排除边路，是另一条通道的口径。不记为缺陷。
- Webhook 触发器 `secret_cipher` 损坏时，`handleFire` 在统一 `not_found` 判断之前解密，抛 `BusinessException` code `5001`（「Webhook 解密失败」）。设计里的统一 404 覆盖的是不存在、验签失败、停用。密文损坏是密钥或数据损坏，不作为本轮核心功能缺陷。
