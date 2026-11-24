# 发送附件快照技术方案（send_image / send_file 不再随工作区失效）

- 日期：2026-11-24
- 状态：待实现（方向已定：发送时由工具自己落快照；本地目录与云存储共用带鉴权的下载接口；不挂进工具容器）。**2026-11-24 二轮评审：整体可行，补入 §9；§9.3 第 7 条（群聊属主口径）待决策后再动手。**
- 前置方案：[发送媒体活引用](2026-11-20-send-media-live-reference-technical-design.md)、[统一发送图片 / 文件](2026-11-18-unified-send-media-technical-design.md)、[多云对象存储](2026-11-21-object-storage-multi-cloud-technical-design.md)
- 关联代码：`backend-ts/src/harness/tool/impl/send-media-tool.ts`、`backend-ts/src/harness/tool/tool-dispatcher.ts`、`backend-ts/src/file/file.routes.ts`、`backend-ts/src/file/file.service.ts`、`backend-ts/src/agent/agent-avatar.ts`、`backend-ts/src/upload/storage-signer.ts`、`shared/contracts/src/delivery.ts`、`desktop/src/utils/deliveryUrl.ts`、`desktop/src/components/chat/ChatDeliveryBar.vue`

## 0. 名词

- **工作区活引用（形态 A）**：2026-11-20 方案。CLOUD 会话发送工作区文件时，delivery 只记 `ref = { type: 'workspace', sessionId, path }`，打开时再去工作区取。源文件删除后卡片失效。
- **uploads 原地引用（形态 B）**：本人 `uploads/{userId}/` 或本站同路径公开 URL，delivery.url 指向原文件，不另存。
- **公开副本（形态 C，存量）**：`uploads/{userId}/send-{uuid}{ext}`，经 Nginx `/uploads/` 公开访问。新发送不再写这种副本。
- **发送快照（本方案）**：发送当时把字节另存一份。消息只记快照 id。对话页经鉴权接口取字节。工作区之后怎么删、怎么改，都不影响这份附件。

## 1. 问题

`send_image` / `send_file` 在 CLOUD 会话里对工作区文件走形态 A。浏览器技能的截图落在工作区（常见是 `.playwright-cli/` 或临时 png），工具发出去之后 Agent 按收尾习惯把临时文件删掉，回看只剩灰色占位和文件名。

工具提示词已经写了「要留定稿就先复制再发」。这次失效就是模型没有这么做。把附件是否还在，放在模型自觉上，挡不住。

管理后台的 `upload.storageMode`（`local | oss | cos | obs`）只覆盖用户在输入框上传的图片和头像。发送工具不读它。没命中活引用时，`saveSendCopy` 一律写本地公开目录 `uploads/{userId}/send-*`。

## 2. 目标与非目标

### 2.1 要做的

| # | 内容 |
|---|---|
| P1 | 工作区、LOCAL 本机、外部 http(s)、经验目录、runtime / HOME / `/tmp` 等来源，发送时由宿主机落快照。delivery 记快照 id，不记工作区路径，也不记公开 URL |
| P2 | 本地存储：快照写到 `/opt/mao-data/send-files/{userId}/`，与 `uploads/` 平级。新增 `GET /v1/files/send-download`，登录用户只能下自己的快照 |
| P3 | 对象存储：同一条写路径按 `upload.storageMode` 把字节 PUT 到私有前缀 `send-files/`。下载仍走 P2 的接口，由服务端代读，不把云地址交给浏览器 |
| P4 | 本人 `uploads/{userId}/` 既有产物（含生成图）继续形态 B，不再复制一份 |
| P5 | 桌面 / Web / 安卓 / 嵌入浮窗按新 ref 拼鉴权 URL。存量形态 A / B / C 的渲染保持不动 |
| P6 | 本地存储模式下，新的输入框图片与头像写入 `uploads/{userId}/`。已在根目录的旧文件不搬迁，旧 URL 继续可访问 |

### 2.2 不做的

- **不把 `send-files/{userId}` 挂进工具容器**。`send_image` / `send_file` 继续留在 `SERVER_ONLY_TOOLS`，在宿主机执行。容器只在 Docker 用户读源文件字节时参与（现有 `read_bytes`），不参与落盘。挂载清单一变，存量容器会按指纹重建；可写挂载还会让 Agent 用 `shell` 删掉刚发出的快照。
- **不迁移存量消息**。已发出的形态 A 该失效还是失效；已写出的 `uploads/.../send-*` 公开副本继续能打开。
- **不做 GC / TTL**。快照只增不减，与今天的 `send-*` 副本一样。清理另立项。
- **不改通道推送**。微信 / 飞书 / 钉钉仍是发送那一刻的字节，和对话页快照两侧独立成败。
- **不改跨用户读取边界**。源路径仍走现有 `StrictPathResolver` / 容器沙箱。本方案不扩大 Agent 能读的根。
- **不为分享页做代取**。快照下载要属主 JWT。公开分享、非属主查看保持占位，与形态 A 在分享页的现状同一口径。
- **不改对象存储直传**。`oss | cos | obs` 的图片 key 已经是 `uploads/{userId}/...`。P6 只改本地存储模式的落盘目录。
- **不把输入框图片放进 `send-files/`**。那条目录只给发送快照，并且要鉴权。用户自己传的图片仍走公开的 `/uploads/`。

### 2.3 用户看到的结果

- 新发出的工作区截图、导出文件：卡片照常出现。Agent 随后删除源文件，回看仍能打开发送时的那一份。源文件后来被改写，卡片内容不变。
- 生成图、本人上传目录里的文件：仍指向原文件。原文件被删，卡片仍会失效。这条和今天一样。
- 绑了微信 / 飞书 / 钉钉：通道收到的仍是发送当时的字节。对话页多了一份不会跟着工作区消失的快照。
- 分享页：新快照打不开（无属主令牌）。形态 B / 存量公开副本不受影响。

## 3. 决策

### D1 发送工具自己落快照，不依赖模型先复制

「发送」表示把这一份交给用户。工作区活引用把附件生命周期绑在源文件上，和这个语义相反。提示词保留「源文件删了会失效」挡不住收尾清理。

新发送不再产生形态 A。读字节的资格、大小上限（图片 20MB / 文件 30MB）、空文件、图片魔数校验保持今天的失败口径：不合格就不落盘、不返回 delivery。

### D2 快照目录与 `uploads/` 平级，不进公开静态目录

Nginx 对 `/uploads/`、`/api/uploads/` 是整树别名，`jwt-hook` 把 `/api/uploads/` 列为公开路径。快照若写进 `uploads/`，鉴权接口没有意义。

本地根目录默认 `{FILE_UPLOAD_DIR 的父目录}/send-files`，生产即 `/opt/mao-data/send-files`。环境变量 `FILE_SEND_DIR` 可覆盖。启动时 `mkdir -p`，与 `uploadDir` 同一处兜底。文件名 `{uuid}{ext}`，`ext` 沿用 `deriveSendCopyExtension`：可执行后缀（html / js / svg 等）落成 `.bin`。

### D3 对话页只认快照 id，本地和云共用一个下载接口

消息里不写磁盘路径，不写云厂商 URL，不写 token。

```ts
export interface DeliverySendFileRef {
  type: 'send-file';
  /** 快照 id（UUID）。下载端用它查表，不接受客户端传入的路径。 */
  id: string;
}
export type DeliveryRef = DeliveryWorkspaceRef | DeliverySendFileRef;
```

`DeliveryWorkspaceRef` 只服务存量消息。新代码不再写出 `type: 'workspace'`。

另建表 `send_file`（Flyway），避免下载时扫描目录，也避免云端 key 只能靠消息反查：

| 列 | 说明 |
|---|---|
| `id` | CHAR(36)，主键 |
| `user_id` | 属主。下载时与 JWT 用户比对 |
| `filename` | 展示名，来自工具参数或源文件名 |
| `mime` | 与今天 `mimeForSendCopy` 同口径；`.bin` 固定 `application/octet-stream` |
| `bytes` | 长度 |
| `storage` | `local \| oss \| cos \| obs`，写入时的 `upload.storageMode` |
| `object_key` | 相对 key：`{userId}/{uuid}{ext}`。本地拼 `FILE_SEND_DIR`，云拼对象前缀 `send-files/` |
| `created_at` | 写入时间 |

不设 `session_id`。鉴权看属主，不看会话是否还在。会话删除后，附件仍属于该用户。

### D4 工具继续在宿主机执行

`tool-dispatcher.ts` 里 `send_image` / `send_file` 已在 `SERVER_ONLY_TOOLS`。通道密钥、会话查询、存储配置都在宿主机；容器执行器不允许引用这些模块。

Docker 用户读工作区源文件，仍经 `DockerSendBytesBridge.readBytes` 向容器要字节，沙箱口径不变。字节回到宿主机后再写快照。LOCAL 会话仍由执行端把字节拉回宿主机（现有 `deliveryFetch`），然后进同一条快照写入。

### D5 对象存储只做服务端读写，对象不公开

`upload.storageMode !== local` 时，宿主机用现有 HMAC 签名器对 key `send-files/{object_key}` 签一个短时 PUT，自己把字节 PUT 上去。签名器今天只有 `PUT | DELETE`，本方案补 `GET`，且 GET 的预签名 URL 只在下载请求内使用，不返回给浏览器。

`uploads/` 前缀维持现在的公开读（用户聊天图片直传）。`send-files/` 前缀必须不可公开读。桶策略若是整桶 public-read，私有前缀名存实亡，上线检查要单独确认这一条。消息和接口响应里都不出现 `publicUrl`。

### D6 形态 B 保持原地引用

本人 uploads 里的生成图、已上传图片已经不在工作区，清理工作区碰不到。再复制一份只增加占用。扩展名白名单、他人 uploads 拒绝、外域 URL 不原地引用，沿用 2026-11-20 的判定。没命中形态 B 的一律进快照，不再回落到公开的 `saveSendCopy`。

可执行内容即使落在本人 uploads，今天也会拒绝形态 B、改走副本并净化为 `.bin`。本方案改走快照，净化规则保留。

### D7 本地存储的新上传进 `uploads/{userId}/`，旧文件留在根目录

生成图、改图已经写在 `{uploadDir}/{userId}/`，对象存储的 key 也是 `uploads/{userId}/...`。本地模式的 `POST /v1/files/upload`（输入框图片、个人头像、Agent 头像）仍写在 `uploads/` 根上，URL 为 `/uploads/{uuid}.ext`。容器只挂 `uploads/{userId}`，根上的新文件按磁盘路径读不到。

新文件改为 `{uploadDir}/{userId}/{uuid}{ext}`。`storedName` 仍是单个文件名，不把用户 id 写进这一列。对外 URL 按 `filePath` 相对 `uploadDir` 拼出：新文件是 `/uploads/{userId}/{uuid}.ext`，库里已有的根目录记录仍是 `/uploads/{uuid}.ext`。`file.routes.ts` 的 `toVO` 和 `agent-avatar.ts` 里手写的 `` `/uploads/${storedName}` `` 都要改成这一口径，否则新文件的地址会指到根目录而 404。

同步清单（二轮评审补全，漏一处即 404 或撞车）：

| 位置 | 现状 | 处理 |
|---|---|---|
| `file/file.routes.ts:158-176` `toVO` | `` `/uploads/${storedName}` `` 或 `` `${baseUrl}/uploads/${storedName}` `` | 改按 `filePath` 相对 `uploadDir` 拼路径段；**保留 `baseUrl` 前缀分支**（`upload.baseUrl` 与 storageMode 无关，本地模式也可能配了它） |
| `agent/agent-avatar.ts:84` | `` `/uploads/${file.storedName}` `` | 同上 |
| `harness/tool/impl/send-media-tool.ts:708-714` | `` `${origin}/uploads/${userId}/${relPath}` `` | 已带用户 id 段，**不改**，但须加回归锁死，防止改 `toVO` 的人顺手把它也改成 basename 口径 |

`toVO` 的 `baseUrl` 分支要单独补一条 §7 用例（今天只断言了相对路径形态）。

这样对存量是兼容的，不做搬迁、不改已落库的 URL：

- Nginx 对 `/uploads/` 是整树别名，`/uploads/{uuid}.ext` 与 `/uploads/{userId}/{uuid}.ext` 都能访问，配置不用动。
- 消息、`user.avatar_url`、`agent.avatar_url` 存的是上传当时的地址字符串。旧地址继续指向留在根目录的文件。
- 按文件 id 下载、删除走表里的 `file_path`，不依赖 URL 只有一段路径。
- `isOwnUploadsUrl` 要求 `uploads` 后至少还有「用户 id + 文件名」两段。根目录上的旧地址只有一段，仍然不会被当成形态 B，行为与今天一致。新地址满足两段，发送时按形态 B 原地引用。
- `uploads/releases/` 以及根目录上其它非数字开头的平台文件不动。

同一改动里放开头像校验。`validateAgentAvatarUrl` 今天只接受 `/uploads/{uuid}.png`。新头像地址多一段用户 id，不放宽就存不上。旧正则保留，同时接受 `/uploads/{数字用户 id}/{uuid}.png`。个人头像走 `uploadImages`，桌面 `resolveAvatarUrl` 只判断 `/uploads/` 前缀，多一段路径不用改。

新文件落在已挂载的子目录里，容器内可以按绝对路径读取，也可以被 `shell` 改写或删除。这是新上传的可见性变化，不是旧文件的行为变化。旧的根目录文件仍然不在挂载里。文件名继续用 UUID。`/uploads/` 整树依旧公开，子目录不表示只有本人能打开。

## 4. 写入流程

`decideLiveRef` 收缩为只判定形态 B。命中则与今天一样返回 uploads URL，不写 `send_file`。

其余来源：

1. `loadBytes`（含 Docker `read_bytes`、LOCAL `deliveryFetch`、http 下载）。失败则整次失败，无 delivery。空文件、超限、图片魔数不合格，与今天相同，不落盘。
2. 生成 uuid，按 D2 得到扩展名与 mime，写入本地文件或按 D5 PUT 云对象。
3. 插入 `send_file`。写文件成功但插表失败时删除刚写的对象，对外按「对话页保存失败」。
4. 有通道则用内存中的同一份字节推送。推送失败不影响已写下的快照：`success = true`，`channelStatus = failed`，delivery 仍在。文案只保留通道侧原因。
5. 返回的 delivery：`{ kind, filename, mime, bytes, ref: { type: 'send-file', id } }`，无 `url`。

纯对话会话（无通道）在快照写完后即为成功。不再出现「工作区引用已记下，但源文件马上会被删掉」。

必须一并写清的边界口径（二轮评审新增，今天各有既有行为，漏定义会让通道机器人行为漂移）：

- **`ctx.userId == null`**（`executionUserId` 与 `session.userId` 均为空）：今天 `saveSendCopy` 会退到平坦 `uploads/` 写一份并给出公开 URL（2026-11-18 D7）。新方案没有属主可写、也没有属主可授权，**按「对话页没有可打开的附件地址，保存失败」整次失败、不落盘**，与今天 origin 解析失败同口径。不要静默写到一个谁都打不开的位置。
- **快照写失败但通道推送成功**：今天 `combineSendResult`（`send-media-tool.ts:376-411`）的取值是 `success = true` + error「对话页保存失败」。新方案保持一致，**不要因为「快照是主路径」就改成 `success = false`**，否则已绑定通道的会话结果语义会变。
- **顺带消失的失败分支**：今天 `saveSendCopy` 在 upload origin 为空时以「对话页没有可打开的附件地址，保存失败」失败（:201-204）。新方案下载端点是同源相对地址，该分支不再存在——实现时删掉它，不要留死代码。

工具提示词删掉「要交付定稿快照就先复制一份再发」。改为：发给用户的工作区文件会在发送时另存一份，之后修改或删除源文件不影响已经发出的附件；本人 uploads 里的已有文件仍直接引用，删除原文件后附件失效。

## 5. 下载接口

`GET /v1/files/send-download?id={uuid}`

- 鉴权复用现有 JWT：请求头 `Authorization`，或 query `token`（`<img>` 带不了请求头，与 `workspace-download` 相同）。query 通道继续拒绝 `mao_` 前缀的 API Token。
- 用 JWT 的 `userId` 与 `id` 查 `send_file`。没有行，或 `user_id` 不一致，都返回 404，不区分「不存在」和「不是你的」。
- 本地：`FILE_SEND_DIR/{object_key}` 经 `StrictPathResolver` 限制在该用户子目录内，拒绝符号链接逃出。云：服务端签 GET 并流转发，浏览器不接触云地址。
- 响应头：`X-Content-Type-Options: nosniff`。图片（PNG / JPEG / GIF / WebP / BMP，且与落盘时的嗅探一致）`Content-Disposition: inline`，供卡片和灯箱直接显示。其余一律 `attachment`，文件名用表里的 `filename`。`.bin` 不做 inline。
- 不把该路径加入 `isPublicPath`，Nginx 不为 `send-files/` 增加 `alias`。

前端 `resolveDeliveryUrl`：`ref.type === 'send-file'` 时拼上述 URL，渲染期再追加 token，token 不进消息 JSON。`ref.type === 'workspace'` 与带 `url` 的存量 delivery 走今天的分支。

前端同步清单（二轮评审补全；桌面与嵌入浮窗各有一份手写副本，**改 resolver 不够，parser 和 key 也要改**，漏一处新快照直接不渲染）：

| 位置 | 现状 | 处理 |
|---|---|---|
| `desktop/src/composables/useMessageRounds.ts:125-132` `parseDeliveryRef` | 只认 `type === 'workspace'`，其余返回 `null`；`extractDelivery` 在 `url == null && ref == null` 时 `return null`（:143） | 按 `ref.type` 分派，接受 `send-file`。**不改这里，新 delivery 会被静默整条丢弃，卡片根本不出现** |
| `sdk/embed/src/ui/useRounds.ts:80-83` `parseDeliveryRef` | 同上，另一份副本 | 同口径 |
| `desktop/src/utils/deliveryUrl.ts:11-28` `deliveryKey` / `resolveDeliveryUrl` | key 为 `` `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}` `` | key 按 type 分派，`send-file` 用 `ref.id`。**不改这里，同一轮发的 N 个快照会共用一个 key**（`ref:undefined:send-file:undefined`），`downloadingKeys` 与图片网格 key 全撞 |
| `sdk/embed/src/ui/deliveryUrl.ts:11-23` | 同上，另一份副本 | 同口径 |
| `desktop/src/types/chat.ts` / `sdk/embed/src/types.ts` 的 `SendDelivery` | 两份手写副本，`kind: 'image' \| 'file'` 内联 | `ref` 字段类型来自 `@mao/contracts` 的 `DeliveryRef`，扩联合后自动收口；若要根治这份重复，可乘机把 `SendDelivery` 下沉到 contracts（可选，不作本轮必做） |

分享页没有属主令牌，保持占位，不改分享令牌的权限。注意这不是新增退化：形态 A 在分享页今天也打不开（`workspace-download` 走 `requireOwnedSession`，分享令牌不被接受，`jwt-hook.ts:6` 只对 `/v1/share/public/` 免鉴权）。相对今天的公开 `send-*` 副本才是收窄，见 §9。

## 6. 部署与安全

- 生产目录：`/opt/mao-data/send-files/`。部署文档与 `mkdir -p /opt/mao-data/{...,send-files}` 的初始化命令补上这一项。不要配进 Nginx（`skills/mao-cli/reference/deploy.md` 的 Nginx 段要显式写一句「不要为 `send-files/` 增加 `alias`」，与现有 `^~ /uploads/` 的说明并列，避免运维照抄）。
- 后端进程的运行用户需要对该目录可写。工具容器的挂载计划、`standardMountsFingerprint` 都不改（已核对：`container-mount-planner.ts:97-134` 的 `uploads` 条目是 `{uploadDir}/{userId}` 按用户挂 rw，`send-files` 不进清单，指纹即不变）。
- **`FILE_SEND_DIR` 启动断言（二轮评审新增）**：`sendDir` 不得位于 `uploadDir` 之内，也不得落在任何已登记数据根之下。理由：`registerUploadStatic`（`app-utils.ts:96-112`）把 `uploadDir` 同时挂在 `/uploads/` 与 `/api/uploads/`，`jwt-hook.ts:23-25` 对 `GET/HEAD /uploads/` 全树免鉴权。若 `FILE_SEND_DIR` 被配成 `/opt/mao-data/uploads/send-files`，快照会同时变成「免鉴权公开 + 可被容器 rw 改写」，D2/D5 的鉴权意义归零，且不报错。
- 快照属主是执行时的运行身份（与今天 `RUNTIME_SCOPED_TOOLS` 里 send 工具的 `userId` 一致）。下载只认这个属主。**该口径在群聊下的收窄面见 §9 第 3 条，需产品决策。**
- 源文件的读取范围不变：其他用户的工作区仍然越界；符号链接仍在 realpath 之后再验。本方案只是把已经允许读到的字节再存一份给属主本人。
- 响应头（二轮评审新增）：
  - `X-Content-Type-Options: nosniff` —— 全站当前没有任何地方设它（也没 helmet），仅此端点新增，不要让人误以为 `sendFile` 已有。
  - `Cache-Control: private, max-age=604800, immutable` —— 快照不可变；必须 `private` 不能 `public`（内容是属主鉴权数据）。对照：Nginx 对 `/uploads/` 是 `expires 7d; Cache-Control "public, immutable"`，新端点没有缓存头会让会话回看时每张图都重走鉴权。
  - `Content-Disposition` 复用 `file/file.routes.ts:886-890` 的 `contentDisposition()`，它已做 RFC 5987（`filename*=UTF-8''` + ASCII fallback + 引号转义）。`send_file.filename` 来自工具参数，可含引号 / 换行 / 非 ASCII，手拼 header 有注入风险。
- 云上线前确认桶策略：`uploads/*` 的公开读不要覆盖 `send-files/*`。未确认之前，存储模式即使配了云，发送快照也应拒绝写入并返回明确错误，而不是退回公开 URL。本地模式不依赖这条。
  - 二轮评审补充（可行性风险）：2026-11-21 方案与 `DEPLOY.md` 记录的生产桶策略是**整桶 public-read** + 仅 `uploads/*` 可写的子账号。因此这条不是「检查项」而是**改造项**：必须把桶策略改成前缀级（OSS/COS/OBS 的 `GetObject` 放行 `uploads/*`、拒绝 `send-files/*`），并写入部署必做步骤。在此之前云模式实例的发送会整体失败（不是降级）。建议配一个「私有前缀已确认」开关，或至少让错误文案直接指向该运维动作。
  - 三个厂商签名器对 Content-Type 的口径不一致：`signOssRequest(cfg, method, key, expires, now, contentType)` 的 contentType 参与签名，PUT 时必须送一致的 `Content-Type`，否则 OSS 403；`signCosRequest` 不收 contentType；`signObsRequest` 的 contentType 必填。补 GET 时给 `signObsRequest` 明确传空串。详见 §9 第 7 条。

## 7. 测试

- CLOUD 工作区文件：写出 `send-files/{userId}/{uuid}.ext` 与表行；delivery 只有 `send-file` ref。删掉源文件后，下载接口仍返回原字节。
- 同一路径随后被改写：下载内容仍是发送时的字节。
- 他人工作区绝对路径、符号链接逃逸：仍拒绝，不落盘。
- 他人 JWT、无令牌、错误 id：404。属主带 query token 可下。
- html / svg / js：落盘 `.bin`，响应 `attachment` + `nosniff`，mime 为 `application/octet-stream`。
- 本人 uploads 生成图：仍是形态 B，`send-files` 无新文件。
- 外部 URL、LOCAL 执行端回传：都进快照。LOCAL 不写工作区 ref。
- 有通道且推送失败：表里有快照，结果 `success=true` 且 `channelStatus=failed`。
- `storageMode=oss|cos|obs`：断言 PUT 的 key 以 `send-files/` 开头，消息 JSON 不含 `publicUrl`；下载走服务端 GET。桶策略不符合时整次失败、无半截对象。
- 容器挂载清单与指纹相对改动前不变。
- 存量形态 A / 公开 `send-*` URL 的前端用例保持通过。
- 本地模式新上传：文件在 `uploads/{userId}/` 下，返回的 URL 带用户 id 段；根目录上的旧 `file_path` 经 `toVO` 仍得到 `/uploads/{uuid}.ext`，且该 URL 还能读到字节。
- 旧头像地址 `/uploads/{uuid}.png` 仍能通过 `validateAgentAvatarUrl` 并正常显示；新头像地址 `/uploads/{userId}/{uuid}.png` 同样能保存和显示。
- 用新的 `/uploads/{userId}/{uuid}.ext` 调用 `send_image`：命中形态 B，不写 `send-files`。用根目录上的旧 URL 调用：不命中形态 B，走快照。
  - 机制修正（二轮评审）：这两条走的是**两条不同的门**，必须分开用例，否则会假通过。`isOwnUploadsUrl`（`send-media-tool.ts:500-509`）**只认绝对 http(s) URL**，裸路径 `/uploads/7/x.png` 直接返回 false；裸路径 / 绝对磁盘路径能不能命中形态 B，取决于 `decideLiveRef` 的**路径形态**分支（`send-media-tool.ts:682-688`：`StrictPathResolver` + `isUnder(resolved, {uploadDir}/{userId})` + `statSync`）。用例拆为：(a) 绝对 URL `https://<域>/uploads/7/x.png` → `isOwnUploadsUrl` 命中；(b) 宿主机绝对路径 `/opt/mao-data/uploads/7/x.png` → 路径形态命中；(c) 裸 `/uploads/7/x.png` → 两者都不命中，走快照（与今天一致，今天也不命中）。
- `ctx.userId == null`：整次失败、`send-files/` 与表都无新行、错误文案为「对话页没有可打开的附件地址，保存失败」。
- 快照写失败但通道推送成功：`success=true`、`channelStatus=sent`、error 含「对话页保存失败」；`send-files/` 无残留对象（插表失败的补偿删除要覆盖这条）。
- 无进展签名：连续两次同参数 `send_image`（内容相同），`no-progress-notice` 的签名一致——锁死 `delivery.ref.id` 不进签名（`SEND_MEDIA_SEMANTIC_KEYS` 白名单排除 `delivery`）。
- 前端：同一轮两个快照附件的 `deliveryKey` 不相同（`send-file` 用 `ref.id`），图片网格与 `downloadingKeys` 不串。
- 前端：`parseDeliveryRef` 接受 `send-file` ref（桌面 `useMessageRounds` 与嵌入 `useRounds` 两份都要用例）。
- `toVO` 配了 `upload.baseUrl` 时：新文件 URL 为 `${baseUrl}/uploads/{userId}/{uuid}.ext`，旧根目录记录仍为 `${baseUrl}/uploads/{uuid}.ext`。
- 响应头：`X-Content-Type-Options: nosniff` 与 `Cache-Control: private, ...`（不得为 `public`）；`filename` 含引号 / 非 ASCII 时 `Content-Disposition` 不破头（复用 `contentDisposition()`）。
- `FILE_SEND_DIR` 配成 `uploadDir` 子目录时启动即失败。

## 8. 实施时同步的文档

实现同一任务更新：`skills/mao-cli/reference/desktop.md`（发送附件改为快照、分享页仍打不开新快照）、部署说明里的数据目录与「不要给 send-files 配 Nginx alias」。发版说明走 `changelog/unreleased/`。本方案不改历史设计文档的结论。

## 9. 二轮评审（2026-11-24）

结论：**需求与方案整体可行，方向成立**；以下为不完善处，按「会直接做错」→「需产品决策」→「建议补」排列。第 1、2 条若不补，实现后新快照**根本不渲染或渲染错乱**；第 3 条需先定口径再动手。

### 9.1 已核对无误的关键前提（供实现时直接引用，不必再查）

| 方案论断 | 核对结果 |
|---|---|
| §1 `send_image`/`send_file` 不读 `upload.storageMode`，一律写本地 `uploads/{userId}/send-*` | 属实。`send-media-tool.ts` 全文无 `storageMode`；`saveSendCopy` 在 :213 无条件 `writeFileSync` 本地 |
| §1 大小上限 20MB / 30MB、空文件、图片魔数、`.bin` 净化 | 属实。:39-40 常量；`COPY_IMAGE_MIMES` :43；`ACTIVE_CONTENT_EXTENSIONS` :90-93（含 xml/xsl/svg） |
| D4 两工具在 `SERVER_ONLY_TOOLS`，宿主机执行 | 属实。`tool-dispatcher.ts:68-83`（:77）；`RUNTIME_SCOPED_TOOLS` :101-104 |
| D5 签名器今天只有 `PUT \| DELETE`，需补 `GET` | 属实。`storage-signer.ts:19` `PresignMethod = 'PUT' \| 'DELETE'`，无 GET |
| D2 `/uploads/`、`/api/uploads/` 是整树别名且免鉴权 | 属实。`jwt-hook.ts:23-25` 对 `GET/HEAD /uploads/` 公开；Nginx 见 `skills/mao-cli/reference/deploy.md:236-264` |
| §2.2 / §7 容器挂载清单与指纹不变 | 属实。`container-mount-planner.ts:97-134` 的 uploads 条目是 `{uploadDir}/{userId}` 按用户 rw；不把 `send-files` 进清单，`standardMountsFingerprint`（:335-337）即不变 |
| §5 本地经 `StrictPathResolver` 限制在用户子目录、拒符号链接 | 可行。`harness/safety/strict-path.ts:15-63` 已有 realpath 校验；现成范本 `send-media-tool.ts:682-688` |
| §3 无既有 `send_file` 表 | 属实。下一个迁移编号为 **`V208`**（最新 `V207__role_soft_delete_releases_unique.sql`） |
| §5 query token 通道、拒绝 `mao_` | 属实。`jwt-hook.ts:107-108`（Bearer 仅 `/v1/open/`）、:127-129（query 通道对 `mao_` 直接 anonymous） |
| §2.3 分享页打不开新快照 | 与形态 A 现状一致，非新增退化：`workspace-download` 走 `requireOwnedSession`（`file.routes.ts:275-276`），分享令牌不被接受 |
| `upload.storageMode` 是运行时管理后台设置（env 已废弃） | 属实。`settings.service.ts:383-395`；`.env.example:35-40` 标注 `UPLOAD_STORAGE_MODE` 已迁移。故 `send_file.storage` 记写入时模式是对的 |

### 9.2 会直接做错的（实现必做）

**1. 前端 ref 解析门会把新 delivery 整条静默丢弃。**
`desktop/src/composables/useMessageRounds.ts:125-132` 的 `parseDeliveryRef` 只认 `type === 'workspace'`，其余返回 `null`；`extractDelivery` 在 `url == null && ref == null` 时 `return null`（:143）。§5 只提了改 resolver，漏了这道门——不改，`{kind, filename, mime, bytes, ref:{type:'send-file', id}}` 根本进不到渲染层，卡片不出现且无任何报错。嵌入浮窗 `sdk/embed/src/ui/useRounds.ts:80-83` 是另一份同样只认 workspace 的副本。清单见 §5 表格。

**2. `deliveryKey` 对 send-file ref 会全部撞同一个 key。**
`desktop/src/utils/deliveryUrl.ts:12` 与 `sdk/embed/src/ui/deliveryUrl.ts:12` 都是 `` `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}` ``。send-file ref 没有 `sessionId`/`path`，得到 `ref:undefined:send-file:undefined`——同一轮发 N 个附件即共用一个 key，`downloadingKeys`（`ChatDeliveryBar.vue:161-162`）与图片网格 key 全撞。必须按 `ref.type` 分派，send-file 用 `ref.id`。

**3. `FILE_SEND_DIR` 缺「不得位于 `uploadDir` 之内」的启动断言。** 见 §6。这是唯一一处「配错即静默失效」的配置。

**4. D7 漏了第三处 uploads URL 拼装点，且漏了 `baseUrl` 分支。** 见 §3 D7 同步清单表。另 §7 最后一条用例的机制写错了（把两种不同的门混成一条），已在该条下修正。

**5. 云模式的「未确认桶策略就拒绝写入」是改造项，不是检查项。** 见 §6。现有云实例在桶策略改造完成前发送会整体失败。

**6. `ctx.userId == null` 与「快照失败但通道成功」的 `success` 口径未定义。** 见 §4 边界口径。

### 9.3 需产品决策（建议动手前先定）

**7. 群聊 / 运行身份 ≠ 会话归属时，会话归属人自己打不开新快照。**

- `harness-service.ts:113-117`：`MAO_RUNTIME_IDENTITY` 默认 `execution`，`runtimeUserId = executionUserId ?? session.userId`，即**本次发言者**。
- `tool-dispatcher.ts:309-310, 449`：send 工具的 `ctx.userId` 取的就是这个运行身份。
- 今天 `uploads/{userId}/send-*` 是**公开 URL**（`jwt-hook.ts:23-25` 放行 `/uploads/`），所以跨成员、分享页、匿名都能打开。`generate_image` 产物同样是公开 URL——2026-11-04 方案 D4「产物归运行身份」的跨成员限制面之所以可接受，前提正是 URL 公开、限制面不生效。
- 新方案改为属主 JWT 才能下载后：群聊里「非归属成员发言触发 send」，**会话归属人**（最常见的回看视角）会拿到 404。形态 A 的 `requireOwnedSession` 按「浏览者拥有会话」判定，归属人本来能开；快照按运行身份判定，归属人开不了。这是相对今天的真实回退。
- 规模参考：2026-11-04 调研记录全站 21 个群会存在非归属成员执行历史（近 7 天 5 个）。
- §2.2 写的「不改跨用户读取边界」指的是 **Agent 读源路径的沙箱**，不是下载侧；§6 的「下载只认这个属主」没有提示这一收窄。建议在这里显式写明，避免读者误判两侧一致。

可选口径（按推荐排序）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A（推荐） | `send_file` 加可空 `session_id`，授权口径为「属主 **或** 该会话归属人」 | 每次下载多一次会话查询；会话删除后自动退回「仅属主」，不影响「会话删了附件还在」的保证 |
| B | 维持仅属主，显式接受并在本文档 + `skills/mao-cli/reference/desktop.md` 写明该限制 | 群聊归属人回看失效，需向用户解释 |
| C | 快照下载改按会话授权（完全对齐形态 A） | 违背 D3「不设 session_id」的初衷，会话删除即附件不可达 |

### 9.4 建议补（不影响正确性，但漏了会留下坑）

**8. 工具结果归一化两处，AGENTS.md 明确要求，方案未提。**
`harness/core/no-progress-notice.ts:71,102-103`：`SEND_MEDIA_SEMANTIC_KEYS = ['success','channel','channelStatus','filename']`，`delivery` 整体被排除，所以 `ref.id`（随机 UUID）不会进签名——**不需要改**，但要显式确认并补一条回归（连续两次同参数发送，无进展签名一致），否则以后有人把 `id` 或 `url` 提到顶层就会漏报。`session/util/tool-result-summarizer.ts:510-529` 的 `summarizeSendMedia` 只读 `success`/`filename`/`error`，不受影响；但注意今天**副本路径的 delivery 没有 `filename`**（:385 只有 `{kind,url,mime,bytes}`），新方案统一带 `filename` 后 `extractDelivery`（`useMessageRounds.ts:145-150`）的回落链少走一级——是改善，但 `deliveryUrl.test.ts` 等既有用例期望值可能变，§7 应点名。

**9. 运维可见性：管理后台磁盘占用会漏掉这块。**
`statistics/host-status.service.ts:86` 的磁盘行只统计 `uploadDir`。快照只增不减地落在平级 `send-files/`，磁盘监控看不出来。建议在该处补一行或在部署文档说明。

**10. 推翻前方案边界要显式写。**
2026-11-21 方案 L21/L28 明确「`storageMode` 只在图片附件上传链路生效，其余上传链路均不读该配置，本次不动」。本方案推翻这条，应在 §1 或 §3 点明，否则后人读历史会困惑。

**11. 顺手修一处错注释。**
`send-media-tool.ts:424` 声称 `SendRefDelivery` 「与 @mao/contracts 的 SendDelivery 对齐」，但 contracts 里没有 `SendDelivery` 类型。本轮要动 `delivery.ts`，顺手修正（或按 §5 表格把 `SendDelivery` 下沉到 contracts，可选）。
