# 飞书通道会话逻辑评审（2026-08-27）

范围：`backend-ts/src/feishu/**`、`backend-ts/src/harness/tool/impl/feishu-tools.ts`、`create-app.ts` 中飞书装配链路（入站 → 授权 → 会话 → Agent 执行 → 回复 / 媒体 / 群上下文）。
方法：全量通读源码 + 调用链交叉验证（含 DB 迁移 V084~V086）。已排除仅 spec 引用的测试噪音。

结论先行：定位 **7 个实质问题**（1 个功能级缺陷、2 个逻辑漏洞、2 个错误设计、若干死代码簇），与"踩坑后堆兜底"的猜想吻合——多处降级不是修根因，而是把故障转嫁为静默失败或盲重试。

---

## BUG-1 私聊文件消息 100% 无法处理，且被伪装成"接收失败"（高）

**性质**：核心功能缺陷 + 静默失败。

**证据链**：

1. `create-app.ts` 会话工厂：私聊不分配工作区
   ```ts
   const groupWorkspace = isGroup ? resolveFeishuGroupWorkspace(...) : null;
   // createSession(..., groupWorkspace, ...)  → session.workspace = null
   ```
2. `create-app.ts` `downloadMedia` 文件分支强依赖 workspace：
   ```ts
   } else if (context.messageType === 'file' && context.fileKey != null) {
     if (workspace == null || workspace === '') {
       errors.push(context.fileName ?? '文件（接收失败）');   // ← p2p 恒走这里
   ```
3. 懒加载兜底同样失效：`harness/tool/impl/feishu-tools.ts` `FeishuDownloadFileTool.executeWithUser`
   ```ts
   if (!workspace) return errorJson('当前会话没有可用的工作区，无法下载文件');
   ```

**结果**：私聊发文件 → 占位符 `[文件:x msg=..]` 入会话 + 用户消息追加 `[以下文件接收失败：x]`；Agent 无论直读还是调 `feishu_download_file` 都拿不到内容。图片走 dataURI 不受影响，所以问题隐蔽——**只有私聊文件这一条路径全灭**。对照微信通道（`weixin/file-storage.service.ts` 的 `resolveBaseDir` 在 workspace 为空时回退到 `./inbound-files/<日期>/`），飞书侧连这个回退都没有。

**修复方向**：p2p 会话创建时分配工作区（如 `{root}/feishu-chat/{botId}/private-{userId}`）；注意 `isFeishuChannelSession()` 依赖 `/feishu-chat/` 子串判定通道归属，新路径天然兼容。

---

## BUG-2 富文本/语音/视频/表情包消息产生空 USER 消息（中高）

**性质**：逻辑漏洞，且同一职责两套实现已经漂移。

`inbound-processor.ts` `normalizeText()` 的注释声称"媒体消息无文本时生成标注文本，避免空消息进入链路"，但类型枚举只覆盖 `image | file`：

```ts
if (event.messageType === 'image') placeholder = `[图片 msg=...]`;
else if (event.messageType === 'file') placeholder = `[文件:... msg=...]`;
if (placeholder === '') return event;   // post/audio/media/sticker → 原样返回 text=''
```

而 `message-detail.ts` `extractMessageText()` 对同一些类型有完整映射（`audio→[语音]`、`media→[视频]`、`post→递归提取富文本正文`、`interactive→卡片文本`）——**它是给"引用消息预取"写的另一套实现**，入站占位没有复用它。

**结果**：
- 私聊转发一篇飞书文档（post 类型）→ Agent 收到一条**完全空的 USER 消息**，模型只能瞎猜；
- 群聊里这类消息落日志 `content=''`，注入群上下文时变成 `[时间] 张三：` 空行垃圾。

**修复方向**：`normalizeText` 复用 `extractMessageText`（或对 post 至少调用它），占位生成保持单一实现。

---

## BUG-3 媒体发送的 union_id→open_id 盲目双发兜底（错误设计，中）

`media-sender.ts` `sendFeishuMediaMessage`：

```ts
let failure = await sendMessageOnce(client, target, ...);          // union_id 先试
if (failure != null && target.receiveIdType === 'union_id') {
  failure = await sendMessageOnce(client, { ...target, receiveIdType: 'open_id' }, ...);  // 失败就换 open_id 再发一次
}
```

注释自述根因："历史会话可能回退存过 open_id，两者同为 ou_ 前缀无法从形态区分"。这是典型的**用运行时试错掩盖存储层缺陷**：

1. 身份形态（union_id 还是 open_id）在写库那一刻明明已知（`getOrCreateP2p` 存的就是 `senderUnionId ?? senderId`），却不在 `feishu_chat` 里记录 `receiveIdType`，逼得每次发送都赌一把再重试。
2. 重试条件是"任何失败"：机器人权限不足、频控（code 99991400）、应用被停用等不可恢复错误也会白打一次 API，再把底层真实错误码丢掉只保留第二次的。
3. 同一系统内"回复用户"存在两套身份通道：文本回复（`create-app.ts` sendReply）直接用事件里的 `senderId` 以 `open_id` 发送，从不需要重试；媒体发送却绕道 `conversation.chatId` 反解 union_id。两套并存正是形态混乱长期不被发现的原因。

**修复方向**：建表/写入时确定 `receiveIdType`（一次性数据迁移可比对现有行），删除盲目重试。

---

## BUG-4 "群成员白名单"是名不副实的死逻辑（中）

三段互为犄角的无效代码：

1. `message.service.ts` `ensureGroupMember()` —— 全仓库零调用（grep 证实），纯死方法。
2. `message.repository.ts` `isGroupMember()` —— 唯一消费点在 `create-app.ts authorizeSender`：
   ```ts
   if (!(await isGroupMember(...))) {
     await addGroupMember(...);     // 不在表里就插进去
   }
   return true;                     // 然后无条件放行
   ```
   即查询结果**从不参与授权决策**，只是决定要不要 INSERT——逻辑等价于直接调 `addGroupMember`（其本身就是 upsert，连前置查询都多余）。
3. 迁移 V084 把 `feishu_chat_member` 注释为"飞书群成员白名单"，但实际语义是"任何绑定过的用户在任意群发言即自动登记放行"——没有任何白名单校验发生。

**修复方向**：若产品语义就是自动放行，删掉 `isGroupMember` 前置查询与 `ensureGroupMember`，给表和字段正名；若真要做白名单，authorizeSender 缺一个 `return isGroupMember(...)` 判断——二选一，当前状态最差。

---

## BUG-5 旧自研传输栈未删净：4 个死模块 + 一串死导出（清理项）

Lark SDK（`@larksuiteoapi/node-sdk`）接管长连接与 HTTP 后，以下文件在生产代码中零引用（仅 `index.ts` 桶导出，而桶本身也无引用）：

| 文件 | 遗留物 |
|---|---|
| `send.service.ts` | 整个 `FeishuSendService`（自带 token 获取 + fetch 发消息，功能已被 SDK client 取代） |
| `http-client.ts` | 仅为 `send.service.ts` 存在 |
| `websocket-client.ts` / `long-connection.ts` | 自研 WS 重连运行时（注释还写着构造 endpoint，与 SDK 模式矛盾） |
| `types.ts` | 死字段 `FeishuBotConfig.websocketEndpoint/reconnectDelayMs/requestTimeoutMs`（app-config 实际配置结构是 `longConnection.{reconcileIntervalMs,reconnectBaseMs,...}`，字段名都对不上）、死常量 `DEFAULT_FEISHU_BOT_CONFIG`、死类型 `FeishuInboundEventHandler` |
| `index.ts` | `export * from './monitor.service.js'` **重复出现两次**；整个文件无人 import，可删 |
| `monitor.service.ts` 构造器 | `(processorOrFactory?: Processor \| Factory, handleFactory?: Factory)` 双位兼容签名：生产只传 processor，第二参恒 undefined，`handleFactory ?? fallback` 后半永假；`typeof === 'function'` 分支也没有调用方 |

**危害**：死字段最误导——读者会以为支持自定义 WS endpoint/超时参数去排查问题，实际那些配置从未生效。

---

## BUG-6 `feishu_binding.open_id` / `user_id_fs` 是从不写入的死列（低，与 BUG-3 同根）

迁移 V084 定义了 `open_id VARCHAR(128) NULL` 与 `user_id_fs VARCHAR(128) NULL`，但全仓库对 `feishu_binding` 的唯一 INSERT 是：

```sql
INSERT INTO feishu_binding (user_id, union_id, deleted) VALUES (?, ?, 0)
```

`MysqlFeishuBindingRepository.bind()`（binding.repository.ts:36）。两列永 NULL，却在 OAuth 登录时手里现成有 open_id/user_id 可存。它们显然就是为解决 BUG-3 的身份形态问题预留的——列建了，写入漏了，于是发送侧只剩"赌 + 双发"。

**修复方向**：OAuth 回调拿到 open_id 时补写该列；`feishuSendTargetOf` 按 `open_id` 是否非空决定 `receiveIdType`，随后即可删掉 BUG-3 的重试兜底。

---

## BUG-7 wiki token 转换失败"降级"必然引发二跳报错（低）

`doc-reader.ts` `wikiTokenToObjToken`：

```ts
// 转换失败（权限/节点不存在等）降级返回原 token，由后续内容接口给出明确错误。
if (Number(response.code ?? 0) !== 0) return wikiToken;
```

wiki token（`wikxxx` 形态）拿着去请求 `/docs/v1/content?doc_type=docx` 必然失败，用户最终看到的是"读取云文档失败 > token: wikxxx"这种不知所云的二跳错误，真正的失败原因（无权限/节点不存在，都在第一次响应的 `msg` 里）被丢弃。"降级到必败路径再让下游报错"不是降级，是把明确的错误模糊化。

**修复方向**：转换失败时直接抛出携带第一次 `msg` 的业务异常；`obj_token` 缺失同理。

---

## 其他观察（不计入 BUG 计数）

- `inbound-processor.ts` 中 `handler.authorizeDirectMessage(...)` 作为 else-if 条件：接口要求每个 handler 实现该方法，`AgentFeishuInboundHandler.authorizeDirectMessage(): boolean { return true; }` 恒真占位（对齐微信版但微信版至少形参命名 `_` 化）——pure 无用抽象分支。
- `defaultSenderLabel()` 从 `raw.event.sender.sender_id.name` 取姓名，但 `im.message.receive_v1` 的 sender 结构不含 name 字段，实际几乎永远落到 `senderId` 兜底，属于无效兜底。
- `card-progress-listener.ts` `toolsList()` 是 `toolValues()` 的纯别名方法，两处调用可合一。
- `buildGroupContext` 注入 prompt 未做总长度截断（30 条 × TEXT 单条上限 64KB，极端群聊可拼出 MB 级 USER 消息直接冲击 LLM 上下文）；对比 `truncateQuoted(1500)` 有截断意识，这里漏了。
- `monitor.service.ts` 自研指数退避重建与 Lark SDK WSClient 内建自动重连双轨叠加。当前依赖 `onReconnected` 清计数才能不出岔子，若 SDK 升级改变事件语义（如重连成功不再回调），会出现双活跃连接。建议信任 SDK 重连，仅保留告警。
- `resolveQuotedMessage` 群日志未命中时的 detail API 兜底与 `findMediaByMessageId` 的 detailFetcher 兜底形态一致、实现重复（前者在 create-app、后者在 feishu-tools 各写一遍"查日志失败转 API"）——可下沉成单一支撑服务。
- 进度卡片限流节流（250ms 窗口）在 `complete()/fail()/cancel()` 终态更新时同样生效：终态 patch 若恰逢节流等待，最多延迟 250ms 且 `await wait` 后才执行——行为正确但失败恢复点应跳过节流，避免终态更新排在积压 RUNNING 更新之后（当前 safeUpdate 吞错返回 false 会触发文本双发兜底，故无用户可见问题，属脆弱点而非缺陷）。

## 已核实无须修改的点

- `agent-inbound-handler.ts` 的锁/generation/cancelFlag 三元组时序：与 `HarnessService.execute` 尾部 `removeCancelFlag(sessionId)` 的交互经推演无竞态（remove 必然先于下一代 register 发生），换代取消后 `cleanupIncompleteTail` 在 release 前执行，顺序正确。
- `claimInboundMessage` 的 `ON DUPLICATE KEY UPDATE` 幂等 SQL：结合 V084 表定义（`updated_at ON UPDATE CURRENT_TIMESTAMP`）推演各状态分支的 affectedRows 行为均符合预期（DONE 不可重领、FAILED/stale CLAIMED 可重领）。
- 群上下文水位线增量注入：配合 `runInChatOrder` 保序队列后，构造的各种并发交错下均无消息丢失窗口。
