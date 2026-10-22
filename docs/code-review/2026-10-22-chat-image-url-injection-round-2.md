# 2026-10-22 聊天图片 URL 注入代码审查（Round 2）

> 审查对象：修复提交 `ffffbd3d`（fix(backend): 用户消息广播剥离注入行）相对 `df744213` 的改动。
> 关联：Round 1 报告 `docs/code-review/2026-10-22-chat-image-url-injection-round-1.md`（BUG-1）。
> 审查方式：通读改动 + 全局搜索全部消费方 + 逐条构造可复现场景 + 补充验证用例实跑。验证用例跑完后已删除。
> 结论：**确认 1 个新的重要级 BUG（BUG-2）**——BUG-1 的主链路已修复，但同一根因在「`user_message_saved` 事件丢失/迟到」的兜底路径上仍然成立，修复不完整。

---

## 一、结论摘要

| # | 位置 | 严重度 | 一句话描述 | 验证用例 |
|---|------|--------|-----------|---------|
| BUG-2 | `desktop/src/stores/session/messages.ts:221-224`（`applyFetchedMessages` 的 `isReplacedOptimisticUser` 判定） | **重要** | REST 的 `VO.content` 含注入行、乐观消息是纯正文，二者不再逐字相等 → 事件丢失/迟到路径上乐观消息无法被去重，同一条发送出现两条用户消息 | `round2-reachability-bugcheck.test.ts` / `round2-fallback-bugcheck.test.ts` |

BUG-1 主链路（`user_message_saved` 正常到达）**已确认修复**：广播回到原始正文口径后，`isLocalOptimistic` 命中、id 替换、保存确认回调全部恢复（见 §三.1 的对照验证）。

---

## 二、BUG-2：REST 兜底去重口径与注入行不一致

### 2.1 位置

| 文件 | 行 | 作用 |
|------|----|------|
| `backend-ts/src/session/session-vo.ts:349-380` | `toMessageVO` | 拼接落库文本 part 作为 `vo.content`（**含注入行**） |
| `desktop/src/stores/session/messages.ts:221-224` | `applyFetchedMessages` | `isReplacedOptimisticUser` 要求 `fetched.content === message.content` 且 `images` 深相等 |
| `desktop/src/stores/session/messages.ts:206-212` | 同上（earlier 分支） | 同一判定的头部版本 |

### 2.2 触发场景

`user_message_saved` 帧未送达或迟到，之后任一次 `fetchMessages`（`useChat.ts:530` / `:769` phase 终态 watcher、`restoreSession`、手动刷新）走 REST 兜底：

1. 用户发送「正文 + 图片」。前端乐观插入 `content = '转成CAD'`、id = `msg_xxx_user`。
2. 服务端落库文本 part = `'转成CAD\n\n[图片 1] <url>'`（本次需求行为）。
3. `user_message_saved` 未到达（WS 断开重连期间服务端只发给当前连接 / 该帧被陈旧过滤器吞掉 / 边路首发时序竞争）→ 乐观消息 id 停在 `msg_xxx_user`，`waitForMessageSaved` 走 60s 超时。
4. 之后 `fetchMessages` → `GET /sessions/:id/messages` → `toMessageVO` 返回 `content = '转成CAD\n\n[图片 1] <url>'`。
5. `isReplacedOptimisticUser` 判定 `'转成CAD\n\n[图片 1] <url>' === '转成CAD'` → **false** → 乐观消息不被剔除，与 REST 版本并列 → **两条用户消息**。

### 2.3 根因分析

BUG-1 的修复只收口了 WS 广播这一个消费方（`userMessagePayloadOf`），但**同一份「落库文本 vs 乐观正文」的口径分叉还有第二个消费方**：`toMessageVO` 的 `vo.content`。该字段同时承担两个职责——

- 历史回显 / 气泡展示 / 编辑框回填（`MessageBubble.vue:344` `editContent = props.message.content`）：**必须**含注入行，否则编辑往返丢 URL 行；
- `applyFetchedMessages` 的乐观消息去重比对：**必须**是纯正文才能匹配。

这两个职责对 `content` 的要求相反，本次改动前它们天然一致（无注入行），改动后必然有一个不满足。BUG-1 的修复把 WS 广播切到纯正文口径，恰好说明「广播需要纯正文」；而 VO 侧无法同样处理（否则编辑幂等被破坏），所以去重判定必须改为「容忍注入行」而不是要求逐字相等。

### 2.4 验证用例（关键代码与实跑结果）

**测试 1：正常路径不触发（反证 BUG-2 的边界）**
`desktop/src/composables/round2-reachability-bugcheck.test.ts`

```ts
it('正常路径：id 已替换，REST 重拉无重复', async () => {
  // ... connect / subscribe / 乐观插入 content='转成CAD', images=['https://a/b.png']
  // 正常投递 user_message_saved（content='转成CAD'，修复后的广播口径）
  sockets[0].onmessage?.({ target: sockets[0], data: JSON.stringify({
    type: 'user_message_saved', sessionId: 9,
    data: { content: '转成CAD', messageId: 88, images: ['https://a/b.png'] },
  })})
  // 执行结束 fetchMessages：REST 的 VO.content 含注入行
  sessionStore.applyFetchedMessages('9', [{
    id: '88', role: 'user',
    content: '转成CAD\n\n[图片 1] https://a/b.png',
    createdAt: '2026-10-22 19:21:12', images: ['https://a/b.png'],
  }] as never, {})
  const users = (sessionStore.getMessages('9') ?? []).filter(m => m.role === 'user')
  expect(users).toHaveLength(1)   // ✓ 通过：id 已替换为 88，无 msg_* 残留
})

it('事件丢失路径：乐观 id 未替换，REST 重拉出现两条用户消息', async () => {
  // 同上，但不投递 user_message_saved（模拟 WS 断连期间帧丢失）
  const users = (sessionStore.getMessages('9') ?? []).filter(m => m.role === 'user')
  expect(users).toHaveLength(1)   // ✗ 失败：实得 2
  expect(users[0]!.id).toBe('88')
})

it('无注入行基线：事件丢失时 REST 重拉正确去重', async () => {
  // 对照组：REST content 也是纯正文（改造前形态）
  expect(users).toHaveLength(1)   // ✓ 通过 → 证明是本次改动引入的回归
})
```

实跑结果：

```
 ❯ round2-reachability-bugcheck.test.ts (3 tests | 1 failed | 2 passed)
     × 事件丢失路径：乐观 id 未替换，REST 重拉出现两条用户消息
        AssertionError: expected [ …(2) ] to have a length of 1 but got 2
     ✓ 正常路径：id 已替换，REST 重拉无重复
     ✓ 无注入线基线：事件丢失时 REST 重拉正确去重
```

**测试 2：附带影响面**
`desktop/src/composables/round2-fallback-bugcheck.test.ts`

```ts
it('WS 事件丢失后重拉历史：乐观消息与 REST 版本重复上屏', ...)      // ✗ 2 条
it('对照组：无注入线时 REST 重拉正确去重', ...)                    // ✓ 1 条
it('正文恰为 [图片 N] <词> 时广播被剥成空串，前端仍判定失配', ...)  // ✗ 2 条
```

实跑结果：`2 failed | 1 passed (3)`。

**测试 3：后端口径核对（证明两侧口径有意分叉、且分叉点只有 VO）**
`backend-ts/src/session/util/round2-broadcast-bugcheck.spec.ts`（5 例全通过）

```ts
it('带图：广播是原始正文，落库/VO 保留注入行', () => {
  const parts = buildUserContentParts('转成CAD', ['https://a/b.png']);
  expect(userMessagePayloadOf(parts).content).toBe('转成CAD');                       // 广播口径
  expect(toMessageVO({ ... content: JSON.stringify(parts) } as never).content)
    .toBe('转成CAD\n\n[图片 1] https://a/b.png');                                    // VO 口径
})
it('无图路径恒等：纯文本 / 渠道自建内容', ...)   // 微信/飞书 data URI + 落盘提示、定时任务字符串 → 全部恒等
```

### 2.5 修复建议（交由后续 worker 执行）

在 `desktop/src/stores/session/messages.ts` 的 `isReplacedOptimisticUser` 判定（`:221-224` 与 `:206-212` 两处）把「逐字相等」放宽为「剥离注入行后相等」，例如把判定提成一个共用 helper：

```ts
function sameUserText(a: string, b: string): boolean {
  return a === b || stripImageUrlLines(a) === stripImageUrlLines(b);
}
```

`stripImageUrlLines` 是纯函数、无副作用，对无图内容是恒等操作，不影响纯文本与渠道消息。前端需要引入该函数（跨端共享可放 `shared/contracts` 或前端 util 复刻一份行首锚定正则；前端已有 `citationMarkers.ts` 等同型纯文本工具的先例）。

同时建议补两条回归用例并入 `desktop/src/stores/session.test.ts`：① 事件丢失 + 带图 → REST 重拉只剩一条；② 无图 → 行为不变。

---

## 三、已核对场景（含 Round 1 结论的复核）

### 3.1 BUG-1 主链路已修复（实跑验证）

| 验证点 | 结果 |
|--------|------|
| 带图发送：广播 content = 原始正文 → `isLocalOptimistic` 命中、只替换 id 不追加 | ✓ 通过 |
| 纯图发送：广播 content = `''` → 命中前端空串兜底 `lastUser.content.trim() === '' && remoteText === ''`（`useStreamWS.ts:875`），只替换 id | ✓ 通过 |
| 保存确认回调触发 → `waitForMessageSaved` resolve、输入框可清空、边路面板不干等 | ✓ 通过 |
| 纯文本广播不变（`keepsThePlainTextBroadcastUnchanged` 新增用例） | ✓ 通过 |
| 边路会话首问广播也剥离（`stripsInjectedUrlLinesFromTheSideSessionFirstMessageBroadcast` 新增用例） | ✓ 通过 |

### 3.2 无图路径恒等性（后端 5 例实跑）

- 纯文本字符串：`userMessagePayloadOf('hello')` → `'hello'`，走 `typeof === 'string'` 分支，不进剥离逻辑。
- 微信入站（`weixin/agent-inbound-handler.ts:394-414`）：正文 + 落盘路径提示 + data URI 图片 → 无注入行，剥离是恒等操作。
- 飞书入站（`feishu/agent-inbound-handler.ts:892-900`）：正文 + `@{path}@` 引用 + data URI 图片 → 恒等。
- 钉钉入站（`dingtalk/agent-inbound-handler.ts:632-650`）：同上形态 → 恒等。
- 定时任务 / 开放接口（`streaming-ws-handler.ts:817` → `savedMessage.content`）：`scheduled-task.service.ts:678` 存的是 `buildScheduledPrompt(...)` 纯文本字符串，走 string 分支 → 恒等。
- **注意一个既有（非本次引入）的小口径差**：若 `savedMessage.content` 是 JSON 字符串（多模态），`userMessagePayloadOf` 走 string 分支直接返回原 JSON，`images` 为空、`content` 是 JSON 原文。定时任务与开放接口均不带图，现实不可达；且该行为在 `ffffbd3d` 前后完全一致，不是本次回归。

### 3.3 其他 `user_message_saved` 消费方（全局搜索结果）

后端仅 4 个生产调用点（`streaming-ws-handler.ts:600` send_message、`:817` scheduled、`:1100` 边路首问，以及 dingtalk/feishu/weixin 三渠道的 `echoUserMessageSaved`），全部只做「广播给前端展示 / 乐观 id 替换」，无落库、无二次分发，改出口径不影响服务端状态。前端仅 `useStreamWS.ts:855` 一处 `case 'user_message_saved'`，下游是 `updateLastMessageId` / `addUserMessage` / `messageSavedCallbacks`，均已在 §3.1 验证。

### 3.4 Round 1「已核对无问题」场景复核

| 场景 | 复核结论 |
|------|---------|
| 6 个组装点注入且不重复 | 未受影响（`ffffbd3d` 只改广播，未触及 `contentParts` / `buildEditContent`） |
| 编辑往返幂等 / 删图后旧序号不残留 | 未受影响（`session-extra.spec.ts` 用例仍通过） |
| 标题剥离彻底 | 未受影响（`session-title.service.spec.ts` 用例仍通过） |
| LLM 上下文装配 / 占位符 | 未受影响 |
| 队列不重复注入 | 未受影响；`queue_message_consumed` 广播用的是队列行原始 `content`（`:1682` / `:1880`），前端 `addUserMessage` 上屏纯正文——与落库文本 part 有口径差，但该事件用真实 `messageId` 且不参与乐观消息比对，无重复风险。**该口径差为既有行为，非本次引入** |
| 测试基线 | `backend-ts/src/session` 594 例全通过；`desktop` 全量 738 例中仅本次自造失败用例失败，其余 736 通过 |

### 3.5 已登记风险（不重复报告）

Round 1 报告的「正文碰撞 `[图片 N] <单个无空格词>`」与「local 模式相对 URL」「URL 露出到通知/webhook」均维持原结论。其中正文碰撞在 `ffffbd3d` 后多一个次级表现（广播被二次剥离成空串 → 前端空串兜底不成立 → 同样重复上屏），但根因仍是 Round 1 已登记的同一正则取舍，且修复 BUG-2 的「剥离后相等」判定会一并覆盖该场景，故不单列。

---

## 四、给后续 worker 的修复清单

1. 修 BUG-2：`desktop/src/stores/session/messages.ts` 两处 `isReplacedOptimisticUser` 判定改为「剥离注入行后相等」（§2.5）。
2. 补回归用例并入默认测试套件：事件丢失 + 带图 → REST 重拉只剩一条用户消息；无图 → 行为不变。
3. `CHANGELOG.md` 0.0.336 条目无需改写（该修复恢复的是预期行为，非新功能）。
