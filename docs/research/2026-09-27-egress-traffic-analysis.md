# Mao 服务出流量分析与优化建议

> 日期：2026-09-27。仅分析，不含代码改动。
> 范围：后端出流量两个大头 —— `/api/ws/stream`（WebSocket 流式对话）与 `/api/v1/sessions/*/messages`（会话消息历史）。

## 一、结论摘要

| 优先级 | 措施 | 预估收益 | 代码改动量 | 风险 |
|---|---|---|---|---|
| P0 | Nginx 对 `/api/` JSON 响应开 gzip | messages/列表类接口 5–10× | 0（改 nginx 配置） | 极低 |
| P0 | `/uploads/` 静态图片加长缓存头 | 页面刷新/多端重复加载不回源 | 0（改 nginx 配置） | 极低（已验证文件名不覆盖） |
| P1 | content/thinking delta **合帧**（服务端 30–50ms 缓冲） | WS 流式对话 10–30× | 后端小 | 低（前端语义不变） |
| P1 | `tool_call_args_delta` 降频为全量快照 | 大参数工具调用 O(n²)→O(n) | 后端小 | 低（前端语义不变） |
| P2 | 图片结果去 base64（preview 改 URL） | 图片会话最大单项，base64 体积×2 次下发 | 中 | 中 |
| P2 | `file_change` 事件只带 patch，全文按需拉取 | 单次写文件事件最多省 ~1MB | 中，需前端适配 | 中 |
| P2 | WS 开启 permessage-deflate | 全部 WS 帧 3–8× | 极小 | 中（CPU 需压测） |

**已评估并剔除的项**（收益太小或影响功能/体验，详见 2.6）：

| 剔除项 | 剔除原因 |
|---|---|
| 应用层心跳 ping 5s→15s | 每连接每天仅 ~1MB，相对流式对话占比过小 |
| WS 事件 executionId 首帧化 | 合帧后帧数大减，剩余收益 ~40B/帧，且增加重连时序风险 |
| fan-out 按客户端类型裁剪（安卓不推 thinking/args_delta） | 改变安卓端实时显示，有明确 UX 影响 |
| messages 分页参数调整 | roundLimit 默认 5、上限 50，设计已收敛，无需改 |

下面按通道详细分析。

## 二、`/api/ws/stream`：流量构成与问题

### 2.1 逐 token 单帧发送是最大头（content_delta / thinking_delta）

**现状**：`agent-loop.ts:235` 把 LLM 每个 stream chunk 原样回调 `onContentDelta`，`ws-streaming-event-listener.ts:52-55` 直接 `send('content_delta', { delta })`，一个 token 一帧。

**帧结构**：`ws-event.ts` 的 `{type, sessionId, data:{delta, executionId}}`，其中 `executionId` 是 36 字符 UUID，在 `send()`（`ws-streaming-event-listener.ts:214`）里附加到**每个**事件的 data 中。

**量化**：一帧 JSON 固定开销 ≈ 90–110 字节，而一个 token 的 delta 通常只有 1–4 字节（中文 1 个字）。即 **~97% 是信封开销**。一次 2000 token 的回复 ≈ 2000+ 帧 ≈ 200–300KB 出流量，而正文只有 6–9KB。

**为何现有队列没解决**：`streaming-ws-registry.ts` 的 outbound 队列虽有 50ms 定时 drain（`scheduleDrain`），但 `flushNow()` 是逐条出队、逐条 `session.send(json)`——**只做了发送时机批处理，没有做同类型事件合并**，N 个 delta 还是 N 个 WS 帧。

**建议**：在 listener 或 registry 层对 `content_delta` / `thinking_delta` 做合帧：
- 触发条件：距首个未发 delta 攒批 ≥30ms，或累计字节数 ≥ 某阈值（如 256B），先到者触发 flush；
- 下发格式改为 `{delta: "累积文本"}`，前端 `useStreamWS.ts:535` 本就是字符串追加，**语义完全兼容，前端无需改动**；
- 流结束、工具调用开始、其他类型事件入队前强制 flush，保证不产生额外延迟感（30ms 远低于人眼感知阈值）。

同理，帧信封里的 `executionId` 可只在事件流的**首帧**携带（前端已用 `session_status`/`session_snapshot` 锚定 executionId），每帧再省 ~40 字节。

### 2.2 `tool_call_args_delta` 全量重发，O(n²)

**现状**：`agent-loop.ts:241` 每收到一个 tool call 参数 chunk，就把 `mergeToolCall` **合并后的完整 arguments** 再回调一次；listener 原样下发（`ws-streaming-event-listener.ts:170-173`）。

**量化**：一次 10KB 的 `write_file` 参数流式分 100 个 chunk 到达，总下发量 ≈ Σ(10KB×i/100) ≈ 500KB，是实际参数的 50 倍。参数越大越严重，是纯流量放大器。

**建议**：降频为每 50ms 发送一次当时的全量参数快照——与 2.1 合帧共用同一缓冲节奏，前端 `updateToolCallArgs`（`useStreamWS.ts:550`）按"全量替换"消费，**零适配**。不做"真增量"方案：那需要前端拼接逻辑配合与断流重置处理，复杂度不值。100 chunk 的 10KB 参数按 50ms 降频后通常仅发 5–15 帧全量，总量从 ~500KB 降到 ~150KB 以内。

### 2.3 `file_change` 事件携带前后双全文（SNAPSHOT 模式）

**现状**：`file-change-diff-util.ts:3-5` 定义 SNAPSHOT 上限 512KB/侧：文件不超 512KB 时 `buildDiff` 直接存 `before_content + after_content` 双全文。`pushFileChange`（`ws-streaming-event-listener.ts:222-244`）把 `before_content/after_content/patch_content` 整个塞进 `file_change` WS 事件。

**问题**：
1. 单次 `write_file`（如写一个 100KB 文件）→ WS 事件 ≈ 200KB+（前后两份全文，且内容与刚刚 `tool_call_result` 里用户刚看着写完的文件高度重复）；
2. 这些 diff 落库后，`GET /messages` 的 `toFileChangeVO`（`session-vo.ts:374-387`）**再次全量下发同一份内容**——同一数据最多走两次网络。

**建议**：WS 事件与消息 VO 默认只带 `patch_content`（PATCH 模式上限 256KB 且通常远小）；完整快照改为前端展开 diff 视图时按需单独拉取（新增一个轻量接口）。前端 `stores/session.ts:1586-1604` 的 diff 合并逻辑需适配。

### 2.4 图片结果 base64 双通道重复下发

**现状**：`tool-image-result-processor.ts:55-70` 对图片类工具结果：
- `preview = { media_type, mime, data_uri }` —— 完整 base64；
- `metadataJson` 里也存一份 `data_uri`。

`onToolCallResult`（`ws-streaming-event-listener.ts:100-118`）把带 `preview.data_uri` 的结果推给前端，前端用它在聊天流里直接渲染图片；落库后 `GET /messages` 又随 `metadata` 下发同一份 base64（`utils/chatMessage.ts:35-42` 消费）。

**量化**：一张 500KB 截图 → base64 ≈ 667KB，走 WS 一次 + 历史 API 一次 ≈ 1.3MB 出流量/次。

**建议**：图片落 `/uploads/`（已有静态服务与命名机制），WS/API 只传 URL，前端 `<img src>` 按需加载并吃浏览器缓存。这是图片密集会话的最大单项收益。注意 read-image 读的是工作区文件，需要一次"复制到 uploads + 生成 URL"的机制，属中等改动。

### 2.5 未启用 WebSocket 压缩（permessage-deflate）

**现状**：`attach-websocket.ts:17-21` 注册 `@fastify/websocket` 只配了 `maxPayload`。`ws` 库服务端 `perMessageDeflate` 默认关闭，因此所有 WS 帧都是明文 JSON 出网。Nginx 的 gzip 对升级后的 WS 连接**无效**，帮不上忙。

**建议**：开启 `perMessageDeflate` 并配保守阈值（如 `threshold: 1024`，即小帧不压缩——避免给 2.1 合帧后的小帧白付 CPU；内存/窗口参数用默认安全值）。JSON 流式内容压缩比通常 3–8×。桌面/浏览器/CLI 的 ws 客户端均默认支持协商。需压测 CPU 影响。

### 2.6 已评估并剔除的项

| 项 | 现状 | 剔除原因 |
|---|---|---|
| 应用层心跳 | `useStreamWS.ts:233` 每 5s ping，服务端回 pong 帧（`streaming-ws-handler.ts:260`） | 每帧 ~60B，单连接每天 ~1MB，相对流式对话流量占比过小，不值得引入改动风险 |
| executionId 首帧化 | 每个事件 data 都带 36 字符 executionId（`ws-streaming-event-listener.ts:214`） | 合帧（2.1）后帧数已大减，剩余收益 ~40B/帧；且省略后重连时序匹配需额外保障，收益/风险比不划算 |
| fan-out 按客户端类型裁剪 | `registry.deliver` 把每条事件发给该用户**所有**在线连接（桌面+安卓+CLI+多标签页） | 若安卓/CLI 不推 `thinking_delta`、`tool_call_args_delta`，对应端会失去实时思考/参数展示，有明确 UX 影响；不做 |
| messages 分页参数 | `roundLimit` 默认 5、上限 50（`session.service.ts:875`） | 设计已收敛，前端翻页按需拉取，无放大问题，无需改 |
| `todo_updated`/`session_list_update` 全量推送 | 任务工具调用后全量推送 todo 列表 | 单次载荷通常 <2KB，流量影响不大，不动 |

## 三、`/api/v1/sessions/*/messages`：流量构成与问题

### 3.1 该接口响应形态

`session.routes.ts:313-339`：按轮次分页（`roundLimit` 默认 5，上限 50），返回 `MessageVO[]` + `fileChanges` + 首次请求附带全部 `compactionEvents`。消息内容中：

- ASSISTANT 消息含全文 `content`、`thinkingContent`、`toolCalls`、`metadata`；
- `metadata` 里可能带完整 base64 图片 `data_uri`（2.4 已述）；
- `fileChanges` 带完整 `beforeContent/afterContent/patchContent`（2.3 已述）。

无上游 LLM 的重复场景下，该接口是**打开会话、翻页、多端打开同一会话**时反复命中的，单次响应可达数百 KB～数 MB。

### 3.2 Nginx 层 gzip（P0，零代码改动）

**现状**：`backend-ts` 未注册任何 `@fastify/compress`（全仓 grep 无 compress/gzip 配置），响应为明文 JSON 出网。部署文档 `skills/mao-cli/reference/deploy.md:183-190` 的 `location /api/` 段也没有 gzip 指令——**现网 `location /api/` 的 JSON 很可能是未压缩传输的**。

**建议**：在 `/api/`（及 `/uploads/`）location 加：

```nginx
gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types application/json text/plain text/css application/javascript;
gzip_vary on;
```

JSON 文本压缩比通常 5–10×。前提是 Nginx 做了 HTTPS 终结（现网是）。注意 `gzip_types` 需与实际 Content-Type 匹配，验收时用 `curl -H 'Accept-Encoding: gzip' -sI` 确认 `Content-Encoding: gzip`。

**为什么不动应用层压缩**：加了 Nginx gzip 后再叠 `@fastify/compress` 属于重复压缩，只耗 CPU 不省流量；保持压缩在边缘层（Nginx）更简单。若未来直连后端绕过 Nginx 的场景变多，再考虑应用层。

### 3.3 messages 分页参数的放大风险

`roundLimit` 默认 5、上限 50 轮，设计上已收敛。但注意前端打开会话、切会话、重连（`session_snapshot` 后校准）都会触发拉取；配合 3.2 的 gzip 后即可，无需再改分页逻辑。

### 3.4 `/uploads/` 静态资源缓存（P0）

`create-app.ts:337` 后端直接静态托管 uploads；头像、附件、AI 生成图都走这里。部署文档中的桌面静态段有缓存头，但 `/uploads/` 未提及，页面刷新/多端重复加载均回源。重复访问同一头像/图片应吃浏览器缓存：

```nginx
location /uploads/ {
    proxy_pass http://mao_backend;
    expires 7d;
    add_header Cache-Control "public";
}
```

**覆盖风险已核实**：通用 uploads 的 storedName 用 `randomUUID() + ext`（`file.service.ts:160`），incoming 临时目录重名自动追加 `-2/-3` 序号（`file.service.ts:273-280`），同名文件不会被覆盖，URL 内容不可变，长缓存安全。

## 四、落地顺序建议

1. **第一批（零代码，改 Nginx 即可）**：3.2 gzip、3.4 uploads 缓存头。`curl -H 'Accept-Encoding: gzip' -sI` 验收 Content-Encoding，`curl -sI .../uploads/<file>` 验收 Cache-Control。
2. **第二批（后端小改，前端零适配）**：2.1 delta 合帧（前端本就是字符串追加，语义不变）、2.2 args_delta 降频为全量快照（保持"全量替换"消费语义）。
3. **第三批（中等改动，需前端配合与回归）**：2.3 file_change 只带 patch（前端 stores/session.ts 的 diff 合并逻辑适配）、2.4 图片 URL 化（preview 改传 URL，新增工作区文件复制到 uploads 的机制）、2.5 permessage-deflate（压测 CPU）。

## 五、验证方式建议

- 基线测量：对一次典型"含图片读取+两次写文件+2000 token 回复"的会话，抓包或用云厂商流量监控统计改动前后出流量，按通道拆分。
- WS 帧：服务端在 registry `deliver` 处临时加计数字段（或本地 wireshark）对比合帧前后帧数/字节数。
- HTTP：`curl -H 'Accept-Encoding: gzip' -sI https://<host>/api/v1/sessions` 确认 gzip；`curl -sI .../uploads/<file>` 确认缓存头。
- 体验回归：重点验证合帧后打字机效果无感知延迟（30ms 阈值）、断线重连快照仍正确、图片显示与 diff 视图正常。

