# send_file 上限放宽到 1GB 技术方案

- 日期：2026-11-25
- 状态：已定稿（2026-11-25）。对话页快照放到 1GB，改为流式落盘与流式下载；§9 R1–R10 全部采纳，不保留旧执行端兼容。§4 与 §9 冲突处以 §9 为准
- 前置方案：[发送附件快照](2026-11-24-send-file-snapshot-technical-design.md)、[统一发送图片 / 文件](2026-11-18-unified-send-media-technical-design.md)、[多云对象存储](2026-11-21-object-storage-multi-cloud-technical-design.md)
- 关联代码：`backend-ts/src/harness/tool/impl/send-media-tool.ts`、`backend-ts/src/harness/tool/impl/send-file-bytes.ts`、`backend-ts/src/harness/tool/impl/fetch-bytes.ts`、`backend-ts/src/file/send-file.service.ts`、`backend-ts/src/file/file.routes.ts`、`backend-ts/src/harness/local/delivery-fetch.service.ts`、`backend-ts/src/harness/container/runtime-channel-protocol.ts`、`backend-ts/src/harness/container/container-tool-executor.ts`、`desktop/src/composables/workspace-file-provider.ts`、`desktop/src/utils/delivery-fetch.ts`、`desktop/electron/localWorkspaceRead.cjs`、`agent-cli/src/local/file-fetch.ts`

## 0. 结论

`send_file` 今天的上限是 30MB（`SEND_FILE_MAX_BYTES`）。这条上限不只是一个常量：读源、容器回传、LOCAL 分片拼装、http 下载、云 PUT、云代读、浏览器下载，全部按「整份字节进内存、并且在几十秒内完成」来写。

把常量改成 1GB 之后：

- 宿主机一次发送峰值约 2GB（`readFile` 的 Buffer，再 `new Uint8Array` 拷一份去 PUT），本地 `writeFileSync` 会堵住事件循环。
- Docker 用户在 96MB 的运行时帧上限处直接失败。
- LOCAL 执行端在 20 秒总超时和 60 片上限处失败，而且服务端仍会把片拼成一整块 Buffer。
- 外部 URL 的读超时是 30 秒且不随数据到达重置，1GB 下不完。
- 云 PUT / 代读 GET 也是 30 秒整包超时。
- 桌面 / Web 下载先 `resp.blob()`，1GB 进页面内存。

所以 1GB 是一条新的写入 / 下载路径，不是把 30 改成 1024。通道上限（微信 / 钉钉 20MB、飞书 30MB）维持不变。`send_image` 维持 20MB。

## 1. 问题

快照方案把「发给用户的那一份」从工作区活引用改成了发送时另存。另存时整份读进进程，再整份写入本地或 OSS。30MB 下这是可接受的：单请求几十 MB，30 秒内能传完，通道也能用同一份字节再推一次。

放到 1GB 后，同一份缓冲会变成进程内存、事件循环、帧协议和超时的问题。流量仍然经 Mao 代读（私有前缀 `send-files/` 不把云地址交给浏览器），带宽成本放大约 33 倍，但 OOM 风险来自缓冲方式，不来自「多走一跳」本身。今天的下载转发已经是流（本地 `createReadStream`，云 `reply.send(stream)`）。

## 2. 目标与非目标

### 2.1 要做的

| # | 内容 |
|---|---|
| P1 | 对话页 `send_file` 快照上限改为 1GB。超限在打开流之前用 `stat` 拒绝，文案仍是「文件过大」 |
| P2 | 快照写入改为流：宿主机管道落盘或分片上传；Docker / LOCAL / http 都边读边写，进程内不同时持有整份文件 |
| P3 | 云代读与浏览器下载改为可撑住 1GB 的流，不再 30 秒整包超时，也不再先收成 Blob |
| P4 | 超过通道上限的文件跳过通道推送，不为此再读一份字节。对话页快照照常写 |
| P5 | 写入前看磁盘剩余空间，不足则拒绝。快照仍无 GC，但上线必须有目录 / 桶用量监控 |

### 2.2 不做的

- **不抬 `send_image` 的 20MB。** 图片走字节嗅探和灯箱，1GB 图片没有对应产品。
- **不抬微信 20MB、钉钉 20MB、飞书 30MB。** 这是对端限制。1GB 文件的结果是「对话里有，通道收不到」。
- **不把 OSS / COS / OBS 地址交给浏览器。** `send-files/` 继续私有，下载仍走 `GET /v1/files/send-download`。
- **不改形态 B。** 本人 `uploads/{userId}/` 的原地引用仍不落快照。该形态今天的路径形态用 `stat` 套上限，超过 30MB 会掉进快照；上限抬高后，1GB 以内的本人 uploads 文件继续原地引用，不复制。
- **不做快照 GC / TTL。** 与 2026-11-24 方案一致。1GB 使「只增不减」从运维建议变成上线门槛，见 §6，本轮不实现清扫。
- **不改分享页。** 快照下载仍要属主 JWT。
- **不改 `file_fetch`（正文图片 10MB）和 `localFileBytes` 的 64MB 预览默认值。** 那两条不是发送快照。

### 2.3 用户看到的结果

- 1GB 以内的工作区文件、LOCAL 本机文件、外部 http(s) 可以发到对话里，卡片可下载。源文件随后删除不影响这份快照。
- 超过 1GB 仍失败，不落盘。
- 绑了微信 / 飞书 / 钉钉时，大于该通道上限的文件只出现在对话里，通道侧 `channelStatus = failed`，文案说明超限。
- 大文件卡片只下载，不在文件预览里把整份载入内存。小文件预览行为不变。

## 3. 影响点

下列每一条都是「只改 `SEND_FILE_MAX_BYTES`」会踩中的现状。行号会漂移，以符号为准。

### 3.1 对话页上限与提示词

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `send-media-tool.ts` `SEND_FILE_MAX_BYTES` | `30 * 1024 * 1024`，`SendFileTool.maxBytes()` 用它卡住 `loadBytes` 和形态 B 的 `stat` | 改常量本身不够，下面各段会先失败 |
| `SendFileTool.getToolPrompt()` | 「文件大小不超过 30MB」 | 提示词改成 1GB，并写明通道更严 |
| `readLocalBytes` / `readLocalBytesSync` | 先 `stat`，超限抛「文件过大（nMB），上限 mMB」，再 `readFile` 整份 | 超限判断可留；通过后不能再整份读入 |

`send_file.bytes` 是 `BIGINT`（`V208__send_file.sql`），1GB 放得下，表结构不用动。工具结果只记 `delivery.ref` 和 `bytes` 长度，不把文件内容塞进消息 JSON。

### 3.2 宿主机读与本地落盘

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `loadSendFileBytesDetailed` → `readLocalBytes` | `fs/promises.readFile` 得到一整块 Buffer，交给 `sendFileStore.save` | 一次发送至少 1GB 堆内存 |
| `SendFileService.save` 本地分支 | `writeFileSync` 整块写入 `FILE_SEND_DIR/{userId}/{id}{ext}`。半截文件会 `rmSync` | 同步写 1GB 期间事件循环停住，健康检查和其它请求一起卡住 |
| 同一 Buffer 再交给通道 | `pushFile` 使用内存里的同一份字节 | 大于通道上限时这次推送必然失败，却仍然把 1GB 留在堆上 |

### 3.3 云写入与云代读

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `putCloudObject` | 预签名 PUT，`body: new Uint8Array(bytes)`（对 Buffer 是拷贝），`AbortSignal.timeout(30_000)` | 峰值再加约 1GB。30 秒传完 1GB 需要持续约 34MB/s，跨地域或小带宽会写到一半被掐掉。签名器没有分片上传 |
| `getCloudObject` | 预签名 GET，把响应体流转给路由。同一 30 秒超时套在整个 `fetch` 上，读 body 期间也算 | 代读超过 30 秒被中断，1GB 几乎必然下不完 |
| 阿里云普通 PUT | 单次 PUT 上限 5GB，接口形态够用 | 不需要为了 1GB 改厂商，但必须换成分片，才能摆脱整包内存和整包超时 |
| 流量 | OSS → Mao → 浏览器，两跳。快照只增不减 | 每下载一次，Mao 出口出 1GB。存储费用按对象大小累积 |

本地模式的下载已经是 `createReadStream`，内存不是问题。超时在 Nginx，见 §3.7。

### 3.4 Docker 容器读字节

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `container-tool-executor.ts` `handleReadBytes` | `readFileSync` 后 `toString('base64')`，一帧返回 | 容器进程内同时有原始字节和约 1.37GB 的 base64 字符串 |
| `runtime-channel-protocol.ts` `MAX_FRAME_BYTES` | 96MB。注释写明是为 30MB 文件的 base64（约 40MB）留余量 | 1GB 的 base64 帧在 `encodeFrame` / `FrameDecoder` 直接拒绝。把帧上限抬到 1GB 会让任意运行时帧都能撑爆进程，不能这么改 |
| 宿主机收帧 | `read_bytes_result.base64` 解成一个 Buffer 再进快照 | 即便帧能通过，宿主机仍持有整份 |
| `docker-tool-router.ts` `readBytes` | `connection.request(..., 120_000)`，120 秒墙钟 | 1GB 分片回传超过 120 秒即被 pending 表判超时，必须改成空闲超时 |
| V8 字符串上限 | `toString('base64')` / `JSON.stringify` 的结果是单个字符串 | Node 22 单字符串上限约 5.4 亿字符，原始字节约 400MB 时 base64 就抛 `ERR_STRING_TOO_LONG`。这是硬天花板，与内存多少无关 |

`file_fetch` 与 pty 共用这条帧协议。分片必须是 `read_bytes` 的新帧，不能放大 `MAX_FRAME_BYTES`。

### 3.5 LOCAL 执行端

服务端 `LocalDeliveryFetchService` 把执行端的片拼成一个 Buffer 再交给工具。执行端先把整份读进内存再切片。

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `delivery-fetch.service.ts` | 片大小 512KB；总超时 **20 秒**（`DELIVERY_FETCH_TIMEOUT_SECONDS`）；拼装 `Buffer.concat`；每用户最多 4 路在途。注释按「60 片 × 512KB ≈ 30MB」估内存 | 1GB = 2048 片。20 秒回不来。拼装时服务端持有 1GB。4 路就是 4GB |
| 同文件 `sweepExpired` | `FETCH_ENTRY_TTL_MS = 30_000`，按 `createdAt` 计；每次新的 `fetch()` 先清扫 | 只改 20 秒超时不够：传输超过 30 秒后，同进程任何一次新的 delivery fetch 都会把它当过期条目杀掉。TTL 必须改成按最后一片到达时间计 |
| 完成回填 | `completeToolRequest(JSON.stringify({ base64 }))`，整份 base64 进一个 JSON 字符串 | 撞 V8 字符串上限（见 §3.4），约 400MB 起必然失败 |
| 桌面主进程 IPC | 渲染层 `deps.readBytes` 经 `local-delivery-read-bytes` 一次拿回整份 `Uint8Array` | 流式读必须新增按区间读的 IPC（打开 / 读 offset+length / 关闭），不能只改渲染层切片逻辑 |
| `desktop/src/utils/delivery-fetch.ts` | `DELIVERY_FETCH_MAX_BYTES = 30MB`，`DELIVERY_FETCH_MAX_CHUNKS = 60`，超出片数直接不回 | 服务端即使加长超时，桌面执行端也会拒 |
| `desktop/electron/localWorkspaceRead.cjs` | `readDeliveryWorkspaceBytes` 把上限传给 `readFileBytes`，后者 `readFileSync` 整份 | 执行端先占 1GB，再 base64 逐片发送 |
| `agent-cli/src/local/file-fetch.ts` | 同表 30MB / 60 片。`readDeliveryFileBytes` 用 `Math.min(maxBytes, 30MB)` 再 `fs.readFile` | 与桌面同一处天花板。`mao-agent` 不改则 LOCAL CLI 会话仍是 30MB |
| WebSocket | 单片 base64 后约 683KB，为了卡在 1MB `maxPayload` 内 | 片大小可以保持 512KB。要改的是片数、超时和「先读完再切」 |

三端常量必须同值：`backend-ts` 的 `SEND_FILE_MAX_BYTES`、桌面 `DELIVERY_FETCH_MAX_BYTES`、`agent-cli` 的同名常量。漏一端，LOCAL 会话仍按 30MB 失败，而且失败是执行端静默不回包、服务端超时，文案对不上。

### 3.6 外部 http(s)

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `fetch-bytes.ts` `fetchBytesWithContentType` | 连接超时 10 秒；读超时 30 秒，在收到响应头时设一次，**数据到达不重置**。`data` 事件把块推进数组，结束时 `Buffer.concat`。超过 `maxBytes` 会立刻销毁连接 | 整段下载必须落在 30 秒内。通过后仍是一整块 Buffer |

### 3.7 浏览器下载、预览、网关

| 位置 | 现状 | 放到 1GB |
|---|---|---|
| `workspace-file-provider.ts` `downloadDeliveryUrl` | 桌面 / Web：`fetch` 后 `resp.blob()`，再 `URL.createObjectURL`。这是用户看到 `blob:https://mao.acg.team/...` 的原因。安卓壳 / 微信内置浏览器改为外跳 `send-download` | Blob 把 1GB 放进页面。外跳不双倍占用页面内存，但仍受代读超时和 Nginx 超时约束 |
| `createDeliveryFileProvider` | 预览 `resp.arrayBuffer()`，文本再按 UTF-8 解码，图片再编 data URI | 点开大文件卡片会把整份拉进渲染进程 |
| Nginx `/api/` | `skills/mao-cli/reference/deploy.md` 中 `proxy_read_timeout 300s`（`/api/ws/` 是 86400s，不覆盖这条 HTTP）；未显式配置 `proxy_buffering`，即默认开启 | **评审更正**：`proxy_read_timeout` / `send_timeout` 是两次相邻读写之间的间隔，不是整次传输的总时长，持续有数据的慢速下载不会因为 300 秒而 504。真正的问题是默认缓冲：Nginx 会把上游响应落到临时文件，默认最多 1024MB（`proxy_max_temp_file_size`），1GB 下载会在网关盘上再占一份。`client_max_body_size` 不管这条，发送不走浏览器上传 body |
| 形态 B | 本人 uploads 的公开 URL 由浏览器直连，不经代读 | 1GB 以内继续直连。不受本节超时影响，也不占 Mao 出口 |

### 3.8 通道推送

| 通道 | 上限 | 放到 1GB 后 |
|---|---|---|
| 微信 `pushFile` | 20MB | 快照可以成功，通道失败 |
| 钉钉 `pushFile` | 20MB，另有扩展名白名单 | 同上。白名单不随大小变化 |
| 飞书 `pushFile` | 30MB | 同上 |
| `combineSendResult` | 快照成功且通道失败：`success = true`，error 为「已放入当前对话，某通道发送失败」 | 语义保持。不要为了推送去读 1GB |

## 4. 改造方案

### D1 上限只抬快照，不抬图片和通道

`SEND_FILE_MAX_BYTES = 1024 * 1024 * 1024`。`SEND_IMAGE_MAX_BYTES`、`WECHAT_MAX_BYTES`、`DINGTALK_MAX_BYTES`、`FEISHU_FILE_MAX_BYTES` 不动。

工具在决定读流之前先拿到 `stat` 的大小（http 用来源的 `Content-Length`，没有长度就边下边计，超过即断）。大于 1GB 按今天的「文件过大」失败，不创建快照对象。

大于通道上限时不调用 `pushFile`。`channelStatus = failed`，error 使用现有的「文件超过 NMB 上限」。对话页快照照常写。这样通道分支不再接触那 1GB。

### D2 快照写入改成流，save 不再接收整块 Buffer

`SendFileStore.save` 的入参从 `bytes: Buffer` 改为可读流加已知长度：

```ts
save(input: {
  userId: number;
  sessionId: number | null;
  filename: string;
  mime: string;
  ext: string;
  size: number;
  body: Readable;
}): Promise<SendFileSaveOutcome>
```

本地：`pipeline(body, createWriteStream(localPath))`。失败仍删除半截文件，再插表；插表失败仍删对象。禁止 `writeFileSync`。

> 评审：写入路径以 §9 R1（先落本地临时文件）和 R3（云上先用单次流式 PUT）为准，下面的分片设计降为后续项。

云：小于 32MB 可以继续单次 PUT（避免小文件多一次 Initiate/Complete）。大于等于 32MB 走分片上传，单片 8MB，每片单独超时（建议 60 秒），整次上传用空闲超时而不是 30 秒墙钟。OSS、COS、OBS 都有分片上传；现有 `storage-signer.ts` 只有单次 PUT/GET/DELETE，要补 Initiate、UploadPart、Complete、Abort。失败必须 Abort，避免未完成的分片永久占桶。

mime 与扩展名仍在写之前确定。图片嗅探只看文件头（现有 `sniffImageMime` 本来就只看魔数），读头之后再把「头 + 剩余流」接成一个流写入，不要把剩余部分缓冲下来。`.bin` 仍固定 `application/octet-stream`。

`bytes` 列记 `size`（流的字节数），与今天「库里记发送时的长度」一致。下载响应的 `Content-Length` 继续以磁盘 `stat` 或云响应的 `content-length` 为准。

### D3 Docker 的 read_bytes 分片，帧上限不动

新增成对的分片帧，例如 `read_bytes_chunk`（seq / total / 原始字节的 base64）。单片 512KB，base64 后远小于 `MAX_FRAME_BYTES`（96MB）。容器侧 `createReadStream`，禁止 `readFileSync` 整文件。

宿主机按片写入 D2 的快照流，不 `Buffer.concat`。任一片失败或连接断开：删半截快照，工具返回读取失败，不插表。

`MAX_FRAME_BYTES` 保持 96MB。pty、`tool_result`、脚本探针继续受这道保护。

### D4 LOCAL 分片改为边读边传，服务端边收边写

> 评审：D3 / D4 的推送模型改为 §9 R2 的服务端窗口拉取；下文的乱序重排窗口随之不再需要。超时、片数、版本文案等约定仍然适用。另须把 `sweepExpired` 的 30 秒 TTL 改为按最后一片计（§3.5）。

执行端（桌面 `localWorkspaceRead.cjs` / `delivery-fetch.ts`，以及 `agent-cli` `readDeliveryFileBytes`）按 512KB 从文件流里读出一片、发出一片，不再 `readFile` 整份后 `chunkBuffer`。

服务端 `LocalDeliveryFetchService`：

- 片大小仍是 512KB（保住 WebSocket `maxPayload`）。
- 去掉「拼完再 `completeToolRequest(Buffer)`」。片按序写入 D2 的临时文件。乱序只允许很小的重排窗口（例如 4 片），超出窗口的片不堆在内存里。
- 总超时改为空闲超时：60 秒没有新片即失败并删临时文件。1GB 的总时长由空闲超时自然拉长，不再使用 20 秒墙钟。
- `DELIVERY_FETCH_MAX_CHUNKS` 改为 `ceil(SEND_FILE_MAX_BYTES / 512KB)` = 2048，三端同值。
- 每用户 4 路在途可以保留。每路内存是重排窗口而不是整份文件。

执行端静默不回包的约定不变：校验失败仍不回包，服务端靠空闲超时收敛。超限必须在执行端 `stat` 时就失败，避免传了一半才发现。

桌面与 `mao-agent` 都要发版。改为 §9 R2 的拉取协议后，旧执行端不认识新帧，任何大小都不回包，服务端 10 秒首片超时。工具错误文案要能区分「执行端版本过旧」和「文件过大」——现有 delivery fetch 对过旧客户端已有「执行端不在线或版本过旧」一类文案，沿用这条，不要报成「文件过大」。

### D5 http(s) 改为流式，读超时改成空闲超时

`fetchBytesWithContentType` 为发送快照增加流式入口：响应体不进数组。`Content-Length` 或累计大小超过 1GB 立即销毁连接。读超时改为「连续 30 秒没有数据」而不是「从头到尾 30 秒」。连接超时 10 秒保留。

没有 `Content-Length` 的响应允许边下边计，超过 1GB 按今天的「下载内容超过 NMB 上限」失败，并删除已写的半截快照。

### D6 下载不把 1GB 收进页面

服务端代读保持流。`getCloudObject` 的 30 秒 `AbortSignal.timeout` 改为：连接 10 秒，之后以响应流的空闲（建议 60 秒无数据）为准。本地 `createReadStream` 不变。

桌面 / Web 的 `downloadDeliveryUrl` 不再 `resp.blob()`。`send-download` 已经带 `Content-Disposition` 文件名，直接打开这个 URL（与安卓壳外跳同一条），让浏览器原生下载。这样地址栏和下载来源是 `/api/v1/files/send-download?id=...`，不再是 `blob:`。token 仍然只在请求时附加，不写入消息 JSON。

预览：`createDeliveryFileProvider` 在 `bytes`（delivery 上已有长度）大于 20MB 时不 `arrayBuffer()`，返回明确的「文件过大，请下载后查看」。20MB 以下的文本 / PDF / 音视频预览不变。图片发送不走这条，仍是 20MB 的 `send_image`。

### D7 网关与磁盘

`/api/v1/files/send-download` 在 Nginx 上单独一个 `location`：`proxy_buffering off`（或 `proxy_max_temp_file_size 0`），让 1GB 响应直通、不在网关盘落临时文件。超时不需要拉到 3600s（见 §3.7 更正），保持 300s 即可覆盖「上游 60 秒空闲」。不要动整个 `/api/`。配置写进 `skills/mao-cli/reference/deploy.md` 的 Nginx 段与 `DEPLOY.md`。

本地写入前用 `statfs` 看 `FILE_SEND_DIR` 所在分区。剩余空间小于 `文件大小 + 1GB` 余量则拒绝，文案「磁盘空间不足」，不写半截文件。云模式没有本地配额，依靠桶用量告警；文档里写明 1GB 对象会永久留下，纳入现有 `df` / 桶监控。

不在本轮做 GC。若磁盘或桶没有告警，不允许只上线 D1。

### D8 常量与文案同步

必须同时改，漏一处就会出现「服务端允许、执行端拒绝」或提示词仍写 30MB：

| 位置 | 改成 |
|---|---|
| `backend-ts` `SEND_FILE_MAX_BYTES` | 1GB |
| `SendFileTool.getToolPrompt()` | 1GB；通道更严的那句保留 |
| `desktop/electron/localWorkspaceRead.cjs` `DELIVERY_FETCH_MAX_BYTES` | 与上面同值，且改为流式读 |
| `desktop/src/utils/delivery-fetch.ts` 的 MAX_BYTES / MAX_CHUNKS | 1GB / 2048 |
| `agent-cli/src/local/file-fetch.ts` 同名常量 | 同上，并去掉 `Math.min(..., 30MB)` |
| `skills/mao-cli` 里写了 30MB 发送上限的段落 | 改成 1GB，并写明代读与通道差异 |

`file_fetch` 的 10MB、`FILE_FETCH_MAX_CHUNKS = 20`、图片 20MB 不在此表。

## 5. 写入流程（改造后）

1. 解析参数、查会话、识别通道。与今天相同。
2. 形态 B（本人 uploads，扩展名可用，大小 ≤ 1GB）：仍返回公开 URL，不写 `send_file`。大于通道上限则不推送。
3. 其它来源：`stat` 或 `Content-Length`。无用户 id、空文件、大于 1GB：失败，不创建对象。
4. 生成 uuid 和扩展名。打开快照写入流（本地文件或云分片）。
5. 按来源把字节灌进该流：宿主机管道、Docker 分片帧、LOCAL 分片、http 响应流。任一环节失败：删除半截对象，不插表。
6. 写完再插 `send_file`。插表失败删除对象，与今天相同。
7. 文件大小不超过该通道上限时，才用**另一条**有界读取把字节推给通道（通道上限 ≤ 30MB，这份额外缓冲是可接受的）。超过通道上限则跳过，按 D1 报通道失败。
8. `combineSendResult` 的成功位不改：快照成功即 `success = true`。

纯对话会话在第 6 步完成后即为成功。

## 6. 上线门槛

- Nginx 为 `send-download` 单独关闭响应缓冲，并更新部署文档。
- 云模式桶对 `send-files/` 配置「未完成分片 N 天后清理」生命周期规则（若采用分片上传，见 §9 R3）。
- `FILE_SEND_DIR` 所在分区和 OSS 桶有用量告警。1GB 对象没有 TTL。
- 桶策略仍须拒绝 `send-files/*` 的公开读（2026-11-24 D5）。本方案不放宽。
- 桌面客户端与 `mao-agent` 需要新版本才能发 LOCAL 的大文件。旧版本失败文案走「执行端版本过旧」，CLOUD 宿主机路径不依赖执行端。

## 7. 测试

- 宿主机 40MB 文件（大于今天的 30MB、小于分片阈值则再加一条大于 32MB 的）：快照字节与源文件一致，进程不出现同等大小的长期 Buffer。源文件删除后下载仍返回原字节。
- 大于 1GB：`stat` 阶段失败，磁盘 / 桶上没有新对象。
- 本地写入中途失败：没有半截文件留下，没有表行。
- 云分片在中途失败：对应 upload 被 Abort，桶上没有未完成分片，没有表行。
- Docker：分片帧单片小于 96MB；容器内大文件不经过 `readFileSync`；帧上限常量仍是 96MB。
- LOCAL：2048 片的上限能通过校验；空闲超过 60 秒失败并删临时文件；旧执行端（不认识区间请求帧）10 秒内得到「执行端版本过旧」，而不是「文件过大」或等满 60 秒。
- http：慢速但持续有数据的响应能下完；30 秒完全无数据则超时；超过 1GB 的响应体被销毁且不留对象。
- 通道：40MB 文件在微信 / 钉钉 / 飞书会话里 `success = true`、`channelStatus = failed`，且推送函数未被调用。
- 下载：桌面 / Web 不再调用 `createObjectURL`；`send-download` 在超过 30 秒的传输中不被 `AbortSignal` 掐断。
- 预览：大于 20MB 的快照不进入 `arrayBuffer`，提示下载。
- 回归：30MB 以内的现有用例（空文件、`.bin` 净化、形态 B、插表失败回滚）保持原口径。

## 8. 风险

- **分片上传中断留下的碎片**要靠 Abort 和桶生命周期规则兜底。只靠插表失败时的 DELETE 删不掉未 Complete 的分片。
- **空闲超时设太短**会误杀低速但正常的下载。60 秒无数据是建议值，实现时与 Nginx 的 300 秒读写间隔分开测。
- **直接打开带 token 的 URL** 会让 token 出现在浏览器下载记录和服务端访问日志里。**评审更正**：这与 `<img>` 不是同一口径——`<img>` 子资源请求不进历史记录，下载和顶层导航会进历史记录与下载列表，并长期留存。而且桌面 Electron 的 `setWindowOpenHandler` 会把新窗口交给 `shell.openExternal`，JWT 会落进系统浏览器。改为短时下载票据，纳入本方案，见 §9 R6。
- **形态 B 的 1GB 公开 URL** 不占 Mao 内存，但会占 OSS 公网下行，且文件在本人 uploads 里被删后卡片失效。这是现有语义，上限放宽后单文件更大。
- **长传输占住同一条连接**：LOCAL 的 2048 片与该用户的流式事件、审批帧共用一条 WebSocket；Docker 的分片与 pty、`tool_result` 共用一条运行时通道。拉取窗口（§9 R2）限制了在途量，但传输期间其它帧的延迟仍会上升，需在压测中观察终端回显。

## 9. 评审补充（2026-11-25）

结论：需求可行，方向正确（流式落盘 + 流式下载，通道与图片上限不动）。但以下几处如果不补，按 §4 实现后仍会在 1GB 下失败或留下隐患。

**决策（2026-11-25）：R1–R10 全部采纳，均在本方案内实现；不考虑历史兼容。** 唯一明确留作后续的是云分片上传（R3）和工具进度事件（R4）。

### R1 写入统一先落本地临时文件，再决定去向

D2 让每种来源直接灌进「本地文件或云分片」，会把来源速度和云写入速度耦合在一起：云 PUT 慢时，LOCAL / Docker 的片无处可去，只能堆在内存里。改为：

1. 所有来源都流式写入 `FILE_SEND_DIR/.tmp/{uuid}.part`（与正式目录同分区）。
2. 本地模式：写完后 `rename` 到 `{userId}/{id}{ext}`。rename 是原子的，下载端永远看不到半截文件。
3. 云模式：从临时文件上传（文件可 seek，分片失败可以单片重试），上传成功后删除临时文件。
4. 通道推送（§5 第 7 步）从这份临时 / 正式文件读取 ≤ 通道上限的字节，**不回源重读**。回源对 http 会多下一次，而且两次内容可能不同，对话里那份和通道收到的那份就对不上了。

代价是云模式也需要本地临时空间，所以 D7 的 `statfs` 检查对两种模式都要做。进程启动时清空 `.tmp/` 下的残留。

### R2 LOCAL 与 Docker 改为服务端拉取（带窗口），不要让执行端推送

D3 / D4 仍然是执行端一口气推完 2048 片、服务端被动接收。Node 的 `ws` 和运行时通道 socket 都不会自动反压：落盘或上云一慢，片就堆在服务端内存里（Docker 侧堆在 `FrameDecoder.buffer`）。暂停 socket 又会把同通道的 pty 和 `tool_result` 一起卡住。

改为拉取：服务端发 `{ requestId, offset, length }`，执行端按区间读并回一片；服务端最多保持 W 片在途（建议 8 片，即 4MB）。在途窗口天然有序，D4 的「乱序重排窗口」不再需要。50ms RTT 下吞吐约 80MB/s，够用。

- 执行端按 `requestId` 持有打开的文件句柄，空闲 60 秒自动关闭。
- 首帧回 `size` 和 `mtimeMs`，最后一片之后再 `fstat` 一次。大小或 mtime 变了就失败，提示「文件在发送期间被修改」，避免 Agent 一边写一边发时得到撕裂的快照。
- 协议是新帧（如 `delivery_read` / `delivery_read_result`、`read_bytes_range` / `read_bytes_range_result`）。**已定：不做兼容分支。** 旧的 `delivery_fetch` / `delivery_fetch_result` 推送协议和 `read_bytes` / `read_bytes_result` 整帧协议连同两端代码一起删除，`send_image` 也走新协议。旧桌面和旧 `mao-agent` 发任何大小的文件都会失败，统一报「执行端版本过旧，请升级桌面客户端 / mao-agent」。服务端发出首个区间请求后，10 秒内没有收到首片就按这条文案失败，不必等 60 秒空闲超时。
- Docker 的 runtime-agent 跟随宿主 dist 的 buildId 重建，不需要单独发版；但切换瞬间已在运行的旧容器要能报版本错误，而不是 120 秒后超时。

### R3 云上传先用「单次流式 PUT」，分片上传降为后续项

三家单次 PUT 都支持到 5GB，1GB 用不着分片。D2 的分片方案需要对签名器做较大改动：`PresignMethod` 没有 POST；OSS V4 的规范查询串、COS 的 `q-url-param-list`、OBS 的 CanonicalizedResource 都要签入 `uploads` / `uploadId` / `partNumber` 子资源；Complete 是 POST 加 XML body，还要收集每片的 ETag；三家各自都要补官方 SDK 对拍向量。

有了 R1 的临时文件（大小已知），单次 PUT 就够了：

- 用 `node:https.request` 显式带 `Content-Length`，把临时文件流 pipe 进去。不要用 `fetch` 的流式 body，它会走 `Transfer-Encoding: chunked`，三家对 PutObject 的 chunked 支持不一致。
- 超时用空闲超时（60 秒无进度），不用 30 秒墙钟。预签名 120 秒有效期只在请求开始时校验，长传输不受影响。签名器不用改。
- 失败整份重试最多 1 次。

只有在实测跨地域单 PUT 失败率不可接受时才上分片。届时 §6 的「未完成分片生命周期规则」才成为上线门槛。

### R4 取消与进度

工具执行今天不接收 `AbortSignal`（`ToolDispatcher` / `send-media-tool.ts` 都没有），30MB 时无所谓，1GB 会持续数分钟：

- 用户点停止后，传输仍在后台跑完，并插一行没有消息引用的 `send_file`，变成永久孤儿（快照无 GC）。至少要把本轮的取消信号传进 `send_file`，取消时中断来源、删除临时文件、不插表。
- 卡片在整个过程中只有「执行中」。后端目前没有工具进度事件，本轮不新增。本轮只在 `SendFileTool.getToolPrompt()` 里写明「大文件可能需要数分钟，等待结果，不要重复调用」，避免模型以为卡住而重发。按字节数推进度条作为后续项。

### R5 并发与磁盘预留

`statfs` 是检查时刻的快照，两路 1GB 并发会同时通过。补充：

- 进程内维护「已预留字节」，检查条件改为 `剩余 − 已预留 ≥ 文件大小 + 1GB 余量`，结束时释放。
- 对超过通道上限的大文件加并发闸：每用户 1 路、全局 N 路（建议 4），超出直接报「当前有大文件正在发送，请稍后」，不排队。LOCAL 原有的每用户 4 路在途不变。

### R6 下载用短时票据，不把 JWT 放进 URL

D6 要直接打开 `send-download?token=...`。§8 已更正：这会让 JWT 进入历史记录、下载列表和 Nginx 访问日志；Electron 下还会被 `shell.openExternal` 交给系统浏览器。改为：

- `POST /v1/files/send-download-ticket { id }`：属主鉴权后返回绑定 `id + userId` 的 HMAC 票据（无状态，不入库），有效期 24 小时。之所以不用 60 秒：R7 的断点续传会重用同一个 URL，60 秒的票据续传必然失败；而无状态票据又分不清首次请求和续传请求。票据泄露的影响面只有这一个文件、最长 24 小时，不能换取其它资源，也不是登录凭证。
- `GET /v1/files/send-download?id=...&ticket=...`：票据有效即可下载，不需要 JWT。
- 桌面 / Web / 安卓走同一条：先换票据，再导航到该 URL（同窗口 `location.assign` 或 `<a>` 点击，不用 `window.open`，避免 Electron 交给外部浏览器）。Electron 同窗口导航到 attachment 会走默认下载（弹保存框），需实测；不满足时由主进程 `webContents.downloadURL(ticketUrl)` 接管。
- 现有带 JWT 的 `send-download` 保留给卡片内联图片，不受影响。

### R7 下载支持 Range

1GB 原生下载中途断线后，没有 `Accept-Ranges` 只能从头再来。本地分支：`createReadStream({ start, end })` 返回 206；云分支：把 `Range` 透传给预签名 GET，原样转发 206 和 `Content-Range`。与 R6 同一批做。浏览器续传会原样重用同一个 URL，所以票据有效期按 R6 定为 24 小时，不区分首次请求和续传请求。

### R8 完整性校验

拉取过程中边收边算 sha256，执行端在最后一片之后回报自己算出的 sha256，两边不一致即失败。http 来源不校验。`send_file` 表不新增列，摘要只用于这次比对。

### R9 测试补充

§7 只测到 40MB，覆盖不到 V8 字符串上限（约 400MB）和长时间传输下的超时 / TTL 问题。补充：

- 单测：LOCAL 条目在传输超过 30 秒时不会被另一次 `fetch()` 的 `sweepExpired` 清掉；Docker `readBytes` 超过 120 秒但持续有片时不超时。
- 单测：拉取窗口内在途片数不超过 W；执行端回报的 size / mtime 变化导致失败；sha256 不一致导致失败；取消时删除临时文件且不插表。
- 手工压测（不进 CI）：宿主机、Docker、LOCAL（桌面与 `mao-agent`）、http 四种来源各发一个 1GB 文件，`process.memoryUsage().rss` 的增量小于 128MB；下载经 Nginx 走通，网关临时目录不增长；传输期间 Docker 终端回显不卡顿。
- 回归：旧执行端发任意大小，报「执行端版本过旧」。

### R10 文档与碎片

同任务新增 `changelog/unreleased/` 碎片（后端、前端、桌面 Electron、终端 CLI（mao-agent）、终端 CLI（mao-cli）各一节）。同步更新 `DEPLOY.md` 和 `skills/mao-cli/reference/deploy.md` 的 Nginx `send-download` location，以及 mao-cli 中关于发送上限、通道上限、执行端最低版本的说明。
