# 2026-10-22 聊天图片 URL 注入代码审查（Round 1）

> 审查范围：HEAD 提交 `df744213`（feat(backend): 聊天图片 URL 注入用户消息）相对 `HEAD~1` 的全部代码变更。
> 技术方案：`docs/plan/2026-10-22-chat-image-url-injection-technical-design.md`
> 审查方式：通读改动 + 逐条构造可复现场景 + 补充验证用例实跑。验证用例跑完后已删除（本次只出报告，不改产品代码）。
> 结论：**确认 1 个阻塞级 BUG**（前端用户消息重复上屏 + 输入框不清空），另有 1 个低风险已知项（正文碰撞）已在方案内登记、不列为 BUG。

---

## 一、结论摘要

| # | 位置 | 严重度 | 一句话描述 | 验证用例 |
|---|------|--------|-----------|---------|
| BUG-1 | `desktop/src/composables/useStreamWS.ts:873-875` + `desktop/src/stores/session/messages.ts:206-212` | **阻塞** | 注入行让服务端广播的 `content` 与前端乐观消息 `content` 不再相等，`isLocalOptimistic` 判定失配 → 用户消息重复上屏、乐观消息 id 永不替换、`messageSavedCallbacks` 不触发导致输入框不清空 / 边路面板干等 60s | `image-url-injection-bugcheck.test.ts`（5 例，4 失败 1 通过） |

> BUG-1 的根因全在后端本次改动（注入行进入 `userMessagePayloadOf` 的 `content`），但修复点在 desktop 前端或后端广播口径。虽然技术方案 §2.2 N3 声明「前端零改动」，该条指的是气泡/编辑框 UI 零改动；此处的失配属于功能性回归，不属于 UI 美化，因此判定为阻塞项。

---

## 二、BUG-1：注入行进广播 content → 乐观消息判定失配

### 2.1 位置

| 文件 | 行 | 作用 |
|------|----|------|
| `backend-ts/src/session/ws/ws-streaming-event-listener.ts:384-386` | `contentParts` 委托 `buildUserContentParts` | 落库文本 part 追加注入行 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts:14-31` | `userMessagePayloadOf` | 从 `messageContent` 提取 `content`（= 注入后的文本）+ `images` |
| `backend-ts/src/session/ws/streaming-ws-handler.ts:594-604` | `send_message` 落库后广播 | `content: payload.content`（含注入行） |
| `backend-ts/src/session/ws/streaming-ws-handler.ts:1095-1103` | 边路会话首问广播 | 同上 |
| `desktop/src/composables/useStreamWS.ts:862-875` | `user_message_saved` 处理 | `isLocalOptimistic` 判定用 `lastUser.content === content` |
| `desktop/src/composables/useStreamWS.ts:879-892` | 远端回显分支 | `isLocalOptimistic` 为 false 时 `addUserMessage` 追加 |
| `desktop/src/stores/session/messages.ts:206-212` | `applyFetchedMessages` 去重 | 同样按 `content` + `images` 相等剔除乐观消息 |
| `desktop/src/composables/useChat.ts:456-461` | 乐观插入 | `content: resolvedText`（纯正文，无注入行） |

### 2.2 触发场景

主会话（或边路任务）发送「正文 + 图片」，或「纯图片无正文」：

1. `useChat.prepareAndSendMessage`（`useChat.ts:456`）/ `SideChatPanel.vue:869-872`（首发）或 `:900-906`（非首发）先乐观插入用户消息，`content = resolvedText`——**只有正文，不含注入行**（前端零改动，本来就不该有）。
2. 服务端 `contentParts(content, images)` 现在返回 `[{type:'text', text: 正文 + '\n\n[图片 1] <url>'}, ...imageParts]`。
3. `saveMessage` 落库后，`userMessagePayloadOf(messageContent)` 的 `content` = **含注入行的文本**，随 `user_message_saved` 广播。
4. 前端 `isLocalOptimistic` 要求 `lastUser.content === content`：`'转成CAD' !== '转成CAD\n\n[图片 1] https://a/b.png'` → false。
5. 走到 `else if (hasRemoteEcho)`：`addUserMessage` 追加一条 id 为真实 messageId 的新消息 → **同一张图 / 同一条发送，用户消息在对话区出现两条**。
6. 附带后果 A：`updateLastMessageId` 未执行，乐观消息停在 `msg_xxx_user` 临时 id，后续 `fetchMessages` 的去重（`applyFetchedMessages` 也按 content 相等）同样失效 → **重拉历史后重复消息依然在**（不是一闪而过）。
7. 附带后果 B：`messageSavedCallbacks` 只在 `isLocalOptimistic` 分支触发（`useStreamWS.ts:879-882`）：
   - 主会话 `useChat.ts:562` `waitForMessageSaved(sid)` 永不 resolve → 60s 超时返回 false → `ChatPanel.vue:692` 判定发送失败、**输入框不清空**（用户视角：图发出去了但输入框还在，还报失败）；
   - 边路面板 `SideChatPanel.vue:934` `waitForMessageSaved` 同样 60s 超时 → 面板 busy 状态干等、草稿不清空。

纯图片消息更严重：乐观消息 `content === ''`，而广播 `content === '[图片 1] <url>'`（R5 新生成的文本 part），判定里的兜底条件 `lastUser.content.trim() === '' && remoteText === ''` 也不成立。

### 2.3 根因分析

注入是「存储态」变更（技术方案 §4「注入位置：消息文本 part 尾部，存储即注入」），但广播通道 `user_message_saved` 的 `content` 直接取自存储态，而前端乐观消息取自「发送时的输入态」。二者在纯文本时代永远相等，注入后产生了一个设计时未考虑的分叉。

方案 §5.6 边界表只登记了「发送端与远端显示不一致……纯展示差异，刷新/重进会话即一致」，**漏判了 `isLocalOptimistic` 的严格相等判定**——它不是展示差异，而是把本端发送当成了远端回显，进而破坏 id 替换、去重与保存确认回调三条链路。

### 2.4 验证用例（关键代码与运行结果）

测试文件：`desktop/src/composables/image-url-injection-bugcheck.test.ts`（已删除，仅用于验证）
运行：`cd desktop && npx vitest run src/composables/image-url-injection-bugcheck.test.ts`

```ts
describe('BUGCHECK: image url injection vs user_message_saved echo', () => {
  it('带图发送时乐观消息与广播内容不一致，会重复上屏一条用户消息', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect(); sockets[0].open(); await pending; await subscribe('9')
    const sessionStore = useSessionStore()
    // useChat 乐观插入：只有正文，没有注入行
    sessionStore.addUserMessage('9', {
      id: 'msg_1786850982000_user', role: 'user',
      content: '这个图片能帮我转成CAD格式的文件？',
      createdAt: '2026-09-20 19:21:12', images: ['https://a/b.png'],
    })
    sessionStore.ensureStreamingAssistantMessage('9')
    // 服务端 userMessagePayloadOf(messageContent) 现在返回注入后的文本
    sockets[0].onmessage?.({ target: sockets[0], data: JSON.stringify({
      type: 'user_message_saved', sessionId: 9,
      data: { content: '这个图片能帮我转成CAD格式的文件？\n\n[图片 1] https://a/b.png',
              messageId: 88, images: ['https://a/b.png'] },
    })})
    const users = (sessionStore.getMessages('9') ?? []).filter(m => m.role === 'user')
    expect(users).toHaveLength(1)              // ← 失败：实得 2
    expect(users[0]!.id).toBe('88')
  })
  // 同构：纯图片消息（content='' vs '[图片 1] <url>'）同样重复上屏
  // 同构：applyFetchedMessages 重拉后重复消息仍在（去重条件 content 相等失效）
  // 同构：messageSavedCallbacks 未触发 → waitForMessageSaved 超时
  // 对照：纯文本消息（content 两边一致）仍只替换 ID，1 条 —— 证明不是测试写法问题
})
```

运行结果：

```
 ❯ src/composables/image-url-injection-bugcheck.test.ts (5 tests | 4 failed | 1 passed)
     × 带图发送时乐观消息与广播内容不一致，会重复上屏一条用户消息   → expected [...] to have a length of 1 but got 2
     × 纯图片发送时广播带注入行文本，也会重复上屏一条用户消息       → expected [...] to have a length of 1 but got 2
     × 重复上屏在执行结束重拉历史后依然存在（去重条件失效）        → expected [...] to have a length of 1 but got 2
     × 带图发送不会触发消息保存确认回调（输入框无法清空）          → expected [] to deeply equal [ '9' ]
     ✓ 纯文本消息仍然只替换 ID，不重复上屏
```

### 2.5 修复建议（交由后续 worker 执行，二选一）

**方案 A（推荐，改后端广播口径，前端零改动）**：`user_message_saved` 的 `content` 保持「用户原始正文」，注入行不进广播。

- `streaming-ws-handler.ts` 的 `send_message` / 边路首问两处：广播前对 `messageContent` 过 `stripImageUrlLines` 再交给 `userMessagePayloadOf`（或给 `userMessagePayloadOf` 增加一个「广播用」的剥离选项）。
- 影响面核对：`feishu/agent-inbound-handler.ts:870`、`dingtalk/agent-inbound-handler.ts:569`、`weixin/agent-inbound-handler.ts:359`、`executePersistedUserPrompt`（`streaming-ws-handler.ts:812`）也走 `userMessagePayloadOf`，但它们的内容是本渠道自建（无注入行），剥离是恒等操作，无回归。
- 优点：与「前端零改动」的方案约束一致；历史/导出仍保留注入行（落库不变），仅广播通道回到输入态。

**方案 B（改前端判定）**：`useStreamWS.ts:873-875` 的 `isLocalOptimistic` 增加「广播 content 是乐观 content 的注入超集」判定（剥离注入行后相等），`messages.ts` 的两处去重条件同步。需要前端发版，且 `waitForMessageSaved` / id 替换链路要一起改，回归面更大。

无论选哪条，都需要补三条回归用例：带图发送只上屏一条、`waitForMessageSaved` 正常 resolve、执行结束重拉后无重复。

---

## 三、已核对无问题的场景

以下场景均已通读源码 / 实跑验证，未发现问题：

| 场景 | 核对结论 |
|------|---------|
| 6 个消息组装点全部生效 | `contentParts` 委托后，`send_message`(:590)、`edit_and_resend`(:909)、边路首问(:1092)、队列插队(:1662)、队列自动消费(:1870) 零改动即获得注入；`buildEditContent`(:1602) 单独委托。5 处 `images.length === 0 ? content : contentParts(...)` 短路保证纯文本零变化 |
| 幂等（编辑往返） | `strip-then-append` 实测：`buildEditContent('转成CAD',[url])` → 回填 → 再编辑，两次落库 JSON 逐字节相同；删一张图后旧的高序号行不残留 |
| 纯文本消息零变化 | `appendImageUrlLines(text, [])` 原样返回；`contentParts('hello', [])` 返回 `[{type:'text',text:'hello'}]`，与改动前一致 |
| 纯图片消息生成文本 part | `contentParts('', [url])` → `[{type:'text',text:'[图片 1] url'},{image_url}]`；`isMultimodalContentParts` 判定不受影响（text part 合法） |
| 队列不重复注入 | 队列行存原始正文（`handleEnqueueMessage` 只 `JSON.stringify(data.images)`），消费时注入一次；`autoSavedMessageId` 让 `handleSendMessage` 跳过二次落库 |
| 标题剥离彻底 | `extractText` 对每个 text part 先 `stripImageUrlLines` 再 join；实测「正文+注入行」→ 只剩正文；纯图片 → 空串 → 走 `IMAGE_TITLE` 分支；注入行出现在非末尾 part 时其余 part 保留 |
| LLM 上下文装配 | `session-history-loader.parseContent` 只做 `isMultimodalContentParts` 结构校验后原样下发，注入行作为正文进入 messages，图片 part 仍由适配器转 base64；`replaceImagesWithPlaceholder`（非视觉模型）保留注入行文本，不破坏结构 |
| 通知预览 / webhook | `userMessagePreviewOf` 把注入行当正文带进预览（`'转成CAD\n\n[图片 1] https://a/b.png\n[图片]×1'`）——URL 会出现在收件箱与外发 webhook 的 `userMessage` 字段。属方案 §7「URL 行露出到 UI/导出」已登记风险，信息正向、非功能性缺陷，**不列为 BUG** |
| 消息 VO / 编辑回显一致 | `toMessageVO` 拼接注入行进 `vo.content`，与 `MessageBubble.vue:344` 的回填源一致，编辑往返幂等（见上） |
| 队列 `queue_message_consumed` | 广播用 `content`（队列行原始正文）+ `images`，未注入，前端 `addUserMessage` 上屏的是原始正文；服务端随后 `handleSendMessage` 不再二次落库，无重复 |
| 正文碰撞（`[图片 N] <单个无空格词>`） | 用户正文恰好该形态时编辑会被剥离——方案 §7 已登记为残余风险，且 `stripImageUrlLines` 已用「行首锚定 + 序号 + 无空格」三重约束收窄；实测 `'[图片 1] 见图'` 会被剥掉。属已知取舍，**不列为 BUG**，但建议后续把正则收紧为「要求 URL 形态（`https?://` 或以 `/` 开头的路径）」以进一步降险 |
| 测试与构建 | `src/session` 全量 598 例中仅本次审查自造的失败用例失败，其余 597 通过；`npx tsc --noEmit` 对本次改动文件无新增错误（存量 spec 类型告警与本次无关） |

---

## 四、遗留风险（非本次引入，登记备查）

1. **local 模式未配 `upload.baseUrl`**：注入的是 `/uploads/xxx.png` 相对路径，模型 curl 不到。方案 §7 / §6 已要求上线前核验 `GET /api/v1/upload/config`，此处仅提醒勿漏。
2. **CRLF 输入**：`stripImageUrlLines` 的行尾收敛用 `/\n+$/`，不吞 `\r`。若某客户端提交 `\r\n` 结尾的正文，剥离后会残留尾随 `\r` 进标题输入（实测 `'上文\r\n[图片 1] url'` → `'上文\r'`）。当前桌面端发送走 `resolvedText`（textarea 值，不含 `\r\n`），无现实触发路径，仅登记。

---

## 五、给后续 worker 的修复清单

1. 修 BUG-1：按 §2.5 方案 A（改后端广播口径）或方案 B（改前端判定）执行；若选 A，需同步 `feishu` / `dingtalk` / `weixin` / `executePersistedUserPrompt` 四处广播调用点的口径核对（预期为恒等，无行为变化）。
2. 补回归用例：带图发送后 `user_message_saved` 只替换 id 不追加；`waitForMessageSaved` resolve；执行结束 `fetchMessages` 后无重复用户消息。建议并入 `desktop/src/composables/useStreamWS.test.ts` 现有 `user_message_saved` describe。
3. `CHANGELOG.md` 0.0.336 条目无需因本修复改写（前端可见行为回到预期），但若选方案 B（前端发版）需确认是否要单独记一条。
