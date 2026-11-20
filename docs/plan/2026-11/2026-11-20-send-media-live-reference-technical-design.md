# 发送媒体活引用技术方案（send_image / send_file 去副本化）

- 日期：2026-11-20
- 状态：已确认方向（评审结论：做活引用，不做 GC）；2026-11-20 可行性评审通过，评审补充见各节标注（sdk/embed 第四端、分享页降级、错误信封、引用侧上限语义、结果合并修正）
- 前置方案：[统一发送图片 / 文件技术方案](2026-11-18-unified-send-media-technical-design.md)（下称「统一发送方案」，其 D6/D7/D8/D10、§4、§5 编号继续沿用）
- 关联代码：`backend-ts/src/harness/tool/impl/send-media-tool.ts`、`backend-ts/src/file/`、`desktop/src/composables/workspace-file-provider.ts`、`desktop/src/components/chat/ChatDeliveryBar.vue`

## 0. 名词约定

- **会话副本**：统一发送方案 §5.1 定义的 `uploads/{userId}/send-{uuid}{ext}` 快照文件，delivery.url 指向它。
- **活引用（本方案新增）**：delivery 不携带 uploads 副本地址，而是携带「来源定位信息」（工作区相对路径或既有 uploads URL），由消费端在渲染 / 下载时实时取数。
- **资格判定**：发送时判断本次发送能否走活引用的一系列检查；不通过则原路回落会话副本。

## 1. 需求背景

### 1.1 现状

统一发送方案规定每次 `send_image` / `send_file` 都**无条件**写会话副本：读出全量字节 → `uploads/{userId}/send-{uuid}{ext}` 落盘 → delivery.url 指向副本。即使源文件就在会话工作区内、甚至就在本人 uploads 目录（如 `generate_image` 产物 `generated-*.png`），也照样再拷一份。

### 1.2 问题

- **纯冗余拷贝**：同一内容重复发送、发送既有 uploads 产物、发送工作区文件，都会产生与源文件内容完全相同的第二份磁盘占用（单文件上限 image 20MB / file 30MB）。
- **无谓的内存与 IO**：纯对话会话（未绑定通道）发送工作区文件时，全量字节读进内存只为落一份副本，之后没有任何消费方需要这份内存态。
- **只增不减**：副本无任何清理机制（现状即如此，本方案不改变这一点，但引用化后新增副本的速率显著下降）。

### 1.3 已确认的方向（拍板记录）

- **做活引用**：工作区文件与本人 uploads 既有产物不再拷贝，delivery 携带引用，消费端实时取数。
- **不做 GC**：不引入 blob 存储、引用计数、TTL / 定时清理；存量副本不迁移不清理。
- **初版不考虑存量兼容**（AGENTS.md 约定）：旧消息里的 url 形态 delivery 仍能渲染即可，不做数据迁移。

## 2. 需求描述

### 2.1 要做的

| # | 内容 |
|---|---|
| P1-1 | CLOUD 会话发送**会话工作区内文件**时走工作区活引用：不读全量字节、不写副本，delivery 携带 `ref` |
| P1-2 | 发送**本人 uploads/{userId} 既有产物**（http(s) URL 形态或路径形态，含 `generated-*`、上传件）时原地引用：delivery.url 原样指向既有文件，不下载不重写 |
| P1-3 | 前端投递卡片 / 文件预览 / 下载支持 ref 形态：按 ref 实时拼 `workspace-download` URL（渲染期追加 token） |
| P1-4 | 绑定通道时行为不变：仍读全量字节推送通道，但 delivery 走引用、**不写副本**，两侧独立成败（D8 沿用） |
| P1-5 | 工具提示词补活引用语义（附件跟随源文件变化、源删则失效） |

### 2.2 不做的

- **不做 GC / TTL / 清理**：无 blob、无引用计数、无定时任务、无 DB 表；`send-*` 存量副本保持现状。
- **LOCAL 会话不做活引用**（D1，见 §3）：维持统一发送方案 §6.1 的执行端拉取 + 服务端副本链路。
- **外部 http(s) 来源不做引用**：外链会过期 / 有 CORS 与混合内容问题，且通道推送本来就要下载字节；维持副本。
- **经验目录（experienceDir）来源不做引用**：`send` 工具今天也读不到经验挂载，不新增能力。
- 不改 workspace-download 端点族、不改鉴权模型、不改 `send_file` / `send_image` 参数契约。
- 不为分享页 / 嵌入浮窗做 ref 代取或服务端 URL 改写：形态 A 在分享页降级为占位（评审补充，见 §2.3 / §6）；嵌入浮窗随 sdk/embed 自行支持 ref（§5.2 评审补充）。

### 2.3 用户看到的结果

- 发送工作区文件：投递卡片照常出现；**附件内容跟随源文件**（之后源被修改，再看附件是新内容；源被删除，图片显示既有占位、文件下载报「文件不存在」）。
- 发送生成图 / 已上传文件：与今天无视觉差异，只是服务端不再多一份 `send-*`。
- 通道推送（微信 / 飞书 / 钉钉）：与今天完全一致。
- 分享页（ShareView 复用 ChatRoundList → ChatDeliveryBar）：形态 B / C 的公开 uploads URL 照常可见；**形态 A 的 ref 在分享页取不到数**——公开分享（`/share/public/:token`）无 Authorization、非公开分享的查看者非属主会被 `requireOwnedSession` 拒绝，图片显占位、文件下载失败（评审补充，显式接受，见 §6）。

## 3. 技术选型与决策点

### D1 活引用只覆盖 CLOUD 会话的工作区来源；LOCAL 维持副本

理由：

1. LOCAL 的三端可见性**依赖服务端副本**：服务端拿不到设备文件，不落副本则 Web / 安卓打开同一会话看不到附件，直接回退统一发送方案 §6.1 已经解决的旧问题。
2. 前端投递渲染链路是 URL 制（`el-image :src`、`createDeliveryFileProvider` 全部消费 URL），LOCAL 桌面没有可信的本地 HTTP 服务，改造成本与收益不成比例。
3. LOCAL 会话在部署里是少数派，冗余占比低。

### D2 活引用语义 = 快照改活照

统一发送方案 D7 选择副本是为了「附件与工作区生命周期解耦」；本方案拍板反转该默认：**工作区来源的附件改为跟随源文件**。失效是显式接受的语义，通过工具提示词（§7）告知 Agent，由 Agent 在提示用户时自行斟酌。存量副本消息不受影响。

### D3 通道推送仍走字节快照，两侧独立成败

通道侧本来就是发送时刻的字节快照（微信 / 飞书 / 钉钉收到的内容不随工作区变化），与活引用互不影响。绑通道时读全量字节的成本本来就要付（推送需要），省掉的是**副本落盘**。D8 的两侧独立成败语义沿用，ref 侧只会在发送时就失败（文件不存在等），不存在「事后引用失效」影响当日发送结果的情况。

### D4 uploads 原地引用必须过扩展名白名单

uploads 静态服务是公开的（`GET /uploads/` 免鉴权，jwt-hook `isPublicPath`）。若源是 `uploads/{userId}/xxx.html` 这类可执行内容，直接引用会绕过统一发送方案 §5.1 的「可执行后缀回落 `.bin` + octet-stream」净化语义，产生内联渲染 XSS 面。因此原地引用仅当 `deriveSendCopyExtension(source)` 返回可用扩展名时允许，否则回落副本链路（照旧净化为 `.bin`）。

### D5 资格判定单一 oracle：复用 `workspaceBrowseService.downloadFile`

发送时对候选工作区来源调用 `downloadFile(session.workspace, source, experienceDir)` 做预检——它与稍后 `GET /v1/files/workspace-download` 用**同一个 `resolvePath`**（StrictPathResolver，工作区唯一根 + 经验挂载例外）、同一套存在性 / 普通文件 / 符号链接检查，且不读字节只返回 `{path, size, fileName}`。发送时可解析 ⇒ 之后可下载（除文件事后被删改），两端解析器永不漂移。仅当解析结果严格落在 `session.workspace` 内（排除经验挂载命中）才进 ref，并把绝对路径归一化为工作区相对路径存储。

## 4. delivery 契约

### 4.1 三种形态

```jsonc
// 形态 A：工作区活引用（新增）。无 url，有 ref。
{
  "success": true, "channel": "chat", "channelStatus": "skipped",
  "filename": "a.png",
  "delivery": {
    "kind": "image", "filename": "a.png",
    "mime": "image/png", "bytes": 12345,
    "ref": { "type": "workspace", "sessionId": 42, "path": "reports/a.png" }
  }
}

// 形态 B：uploads 原地引用（url 即源文件既有公开地址，与今天副本形态同构）
{ "delivery": { "kind": "image", "url": "https://…/uploads/7/generated-ab12.png", "mime": "image/png", "bytes": 9, "filename": "…" } }

// 形态 C：会话副本（回落路径，与今天完全一致）
{ "delivery": { "kind": "file", "url": "https://…/uploads/7/send-….pdf", "mime": "application/pdf", "bytes": 9, "filename": "…" } }
```

- `ref.type` 收敛进 `@mao/contracts` 新文件 `delivery.ts`（后端组装与前端 resolver 共用类型；`'workspace'` 是唯一成员，为未来其他引用类型留位）。
- `ref.path` 一律是**工作区相对路径**（入参为绝对路径时归一化）；`ref.sessionId` 是发送会话 id，使 URL 自包含且下载端 `requireOwnedSession` 校验的就是正确会话。
- `mime`：发送时按 `mimeLookup(ext)`（与 workspace-download 响应头同口径）；`bytes`：发送时 `statSync().size`（展示用，源文件后来变化不追改）。**评审补充**：形态 B 的 URL 形态不 stat，`bytes` 省略（前端 `d.bytes != null` 判断已兼容；路径形态 stat 得到）——原示例中的 `"bytes": 9` 仅示意路径形态，与「连 stat 都省」不能同时成立。
- token **绝不入消息 JSON**：由前端渲染期追加（§5.2），与 markdown 工作区图片的既有口径一致。

### 4.2 结果合并（combineSendResult 适配）

- ref / 原地引用侧恒为 ok（资格判定失败会在更早的 errorJson 阶段暴露，与今天「读字节失败」同路径）。
- chat-only + 引用：`success = true`，无 error。
- 绑通道 + 引用：`success = true`，`channelStatus` 随 push；push 失败时 error 只含通道侧原因（「微信发送失败：…」，不再有「对话页保存失败」分支）。**评审补充**：原拟「`success = push.ok`」与 D8「至少一侧成功即 true」相悖——ref 侧资格已过、附件实际可见，`success = false` 会让模型误判为整体失败而重发。沿用今天「副本成功 + 推送失败」的形状（success=true + 通道侧 error + `channelStatus: 'failed'`），仅文案去掉「已放入当前对话」前缀。
- **评审补充**：绑通道 + 引用时 `loadBytes`（推送读字节）失败只算通道侧失败——delivery（ref 形态）照常返回，`success = true`，error 为「{通道}发送失败：{读取失败原因}」；不再沿用今天「读字节失败 → 只有 error、无 delivery」的整体失败路径（该路径只服务回落副本形态，那里读字节同时服务两个消费方）。
- 副本回落路径的结果合并逻辑一字不改。

## 5. 各端改动

### 5.1 后端 `send-media-tool.ts`

`executeWithUser` 在读字节之前插入资格判定（顺序执行，命中即走引用分支）：

1. **工作区活引用判定**：`session.executionMode !== 'LOCAL'` 且 workspace 非空且 source 非 http(s) →
   `downloadFile(workspace, source, experienceDirOf(session))` 成功，且 `path.relative(workspace, resolved)` 不以 `..` 开头（排除经验挂载）→
   得到 `{resolved, size, fileName}`；归一化相对路径；`send_image` 追加读前 16 字节嗅探（沿用 `sniffImageMime` + `COPY_IMAGE_MIMES`，不合格按现状文案报错，不读全量）；命中 → 形态 A。
2. **uploads 原地引用判定**：source 为 http(s) 且 URL 路径匹配 `uploads/{发送者 userId}/`，或 source 经 extraRoots 解析后落在本人 uploads 目录内 →
   `deriveSendCopyExtension` 返回可用扩展名 → 命中，形态 B（URL 由 `toStaticUploadBase` 口径拼出）；扩展名不可用 → 不命中（走副本被净化为 `.bin`）。
   **评审补充（第二轮）**：URL 形态还要比对 host 与本站上传 origin（`toStaticUploadBase` 解出的静态 origin）一致才命中——路径段「长得像」不等于就是本站文件，不看 host 会让 `https://evil.com/uploads/{uid}/x.png` 被原地引用，等于指使浏览器打向任意外域 / localhost（且 URL 形态不做大小校验）。外链一律回落副本链路（与 §2.2「外部 http(s) 来源不做引用」的非目标一致）；origin 解析失败同样回落。
3. **回落**：两步都不命中 → 现有链路原样（跨成员预检 → 容器 / 宿主机读字节 → `saveSendCopy` → 通道推送），形态 C。

引用分支的字节策略：

- chat-only：**完全不读全量字节**（工作区 ref 仅 stat + 图片嗅探 16 字节；uploads 原地引用路径形态 stat、URL 形态不 stat，`bytes` / 上限口径见 §4.1 评审补充）。
- 绑通道：`loadBytes` 全量读（推送需要，上限与今天一致），推送后**不调用 `saveSendCopy`**，delivery 用引用形态；loadBytes 失败只算通道侧失败（§4.2 评审补充）。

**评审补充——引用侧保留既有上限与校验语义**（引用化不得静默放宽今天 `send_image` / `send_file` 的行为约束）：

- **大小上限**：形态 A 用 stat size 套用既有上限（image 20MB / file 30MB），超限**回落副本链路**——loadBytes 会报与今天一致的「文件过大」文案，不新造文案；形态 B 路径形态同样 stat 校验，URL 形态不校验（显式接受：其下载带宽暴露面与 `/uploads` 静态服务本身相同）。不补这条则 chat-only 引用绕过单文件上限（§1.2 所述 20MB / 30MB 形同虚设）。
- **空文件**：形态 A stat size 为 0 → 按现状文案报错（「图片内容为空」/「文件内容为空」），与今天 `bytes.length === 0` 分支对齐；形态 B 不校验。
- **send_image + 形态 B 追加扩展名检查**：今天 http 来源要过 `COPY_IMAGE_MIMES` 字节嗅探，引用化后不读字节——改为仅当 URL / 路径扩展名映射到图片 mime（png/jpeg/gif/webp/bmp）才命中形态 B，否则回落副本链路（照旧字节嗅探报「不支持的图片格式」）。防止把 `uploads/{uid}/notes.txt` 以 `kind: image` 成功发出。
- **origin 解析失败**：形态 B 路径形态拼不出静态 URL（`getUploadBaseUrl` 失败 / origin 空）→ 回落副本链路（与今天 origin 空 → 副本失败同路径）。
- **子目录 URL（评审补充，第二轮）**：形态 B 路径形态按相对 uploads 根（而非 basename）拼 URL 并逐段 `encodeURIComponent`——`{uploadDir}/{userId}` 按用户挂进容器，Agent 能在里面建子目录，取 basename 会拼出 404 甚至让不同文件撞同一个地址。

`loadSendFileBytesDetailed`、`saveSendCopy`、三个通道策略、`detectSendChannel`：**均不改动**。

### 5.2 前端（desktop 共用 UI = Web / Electron / 安卓）

- `types/chat.ts`：`SendDelivery.url` 改为可选，新增 `ref?: DeliveryWorkspaceRef`（类型自 `@mao/contracts`）。
- 新 util `resolveDeliveryUrl(delivery, token)`：有 `ref` → `${API_BASE}/files/workspace-download?sessionId=&path=&token=`；否则返回 `url`。token 取自 `getToken()`，只在渲染期拼接。
- `useMessageRounds.extractDelivery`：接受 ref 形态（`url` 或 `ref` 二者有其一即收），存量消息的 url 分支保留。
- `ChatDeliveryBar.vue`：`el-image :src`、`preview-src-list`、下载按钮、`:key` 全部经 `resolveDeliveryUrl`；图片错误占位（既有）覆盖「源已删除」；文件下载失败文案走既有 `extractDownloadError` + 下方评审补充的 JSON 信封检查。
- `TaskView` / 中心 Tab `openDeliveryFile` 注入：先 resolve 再交给 `createDeliveryFileProvider({ url: resolvedUrl, … })`，FileViewer 全链路（代码 / PDF / 表格 / 音视频）无需感知 ref。
- `downloadDeliveryUrl`：无需改（收 resolved URL；安卓壳 / 微信浏览器走 `openExternalUrl`，token 在 query 中可带走）。
- **`:key` 与下载中集合不用 resolved URL**（评审补充）：resolved URL 含渲染期 token，token 轮换会导致整列重挂载、图片重载。form A 以 `ref.sessionId + ref.path`、form B/C 以 `url` 作稳定 key；`ChatDeliveryBar` 的 `downloadingUrls` 按 delivery 身份（同 key 口径）。
- **`extractDelivery` 的 filename 回落链补 ref 分支**（评审补充）：今天回落 `delivery.url` 尾段（`useMessageRounds.ts:135`）；form A 无 url，需回落 `ref.path` basename。
- **`downloadDeliveryUrl` / `createDeliveryFileProvider` 补 JSON 信封检查**（评审补充）：CLOUD workspace-download 的业务错误（如「文件不存在」）经 `handleError` 映射为 **HTTP 200 + code 信封**（`http-error.ts:69-79`；LOCAL 分支专门用 `rejectLocalBinaryBrowse` 强制 400，CLOUD 分支没有），只查 `resp.ok` 会把信封 JSON 当文件保存（下载）或当文本渲染（FileViewer）。§2.3 / §5.2 原拟的「400 JSON 文案」对 CLOUD 分支不成立。与 `downloadWorkspaceResource` 既有口径对齐（`workspace-file-provider.ts:641-646`）：无 Content-Disposition 且 content-type 为 JSON → 按 `body.code` / `body.message` 报错。不改端点族，纯前端小改。
- **sdk/embed 同步改造**（评审补充，原方案遗漏）：`sdk/embed/src/ui/useRounds.ts` 有独立的 `extractDelivery`（现要求 `delivery.url`）、`ChatPanel.vue` 有独立的投递渲染（`:key="d.url"`、img `:src`、文件卡），`SendDelivery` 类型也是 embed 自己的一份。embed 会话属主即访问者（SSO 换取本人 JWT，rest-client 每请求带 Authorization），ref 解析可行：embed 侧同样收 ref + 渲染期拼 token（token-provider 为异步 `getToken()`，embed 版 `resolveDeliveryUrl` 需异步化或渲染前预取）。不改则嵌入浮窗里 CLOUD 会话发工作区文件不渲染。发版：sdk/embed `npm run build` 产物复制进 `desktop/public/embed/` 提交（CI 校验 sha256），随 deploy-desktop 上线。
- `toolDisplay.ts`（参数预览）、`summarizeSendMedia`（摘要）、`no-progress-notice.ts`（签名只取 `success/channel/channelStatus/filename` 四键，delivery 本就不参与）：**均无需改**，补回归用例确认 ref 形态不误判。

### 5.3 明确不动的

`file.routes.ts` / `workspace-browse.service.ts`（downloadFile 直接复用为 oracle）、`send-file-bytes.ts`、LOCAL 交付链路（`localFileFetchService`、`deliveryFetch`）、三通道策略、鉴权（jwt-hook query token 既有；注意 API Token `mao_` 前缀在 query 通道被拒是既有正确行为，ref URL 只会用用户 JWT）。

## 6. 安全边界

- ref 只写「发送时经 downloadFile 同一解析器验证」的相对路径；下载时端点再验一次（属主 + 解析 + 存在性 + 拒绝符号链接），不新增越权面。
- 活引用不扩大可见范围：消费端就是能打开该会话的会话属主本人，与 workspace-download 既有权限模型一致。
- 可执行内容净化（D4）：uploads 原地引用过白名单，不通过的照旧落 `.bin` + octet-stream；ref 形态的 path 不参与静态服务，无内联渲染面。
- 无新公开路径、无新 DB、无 token 落盘。
- **分享页降级（评审补充）**：公开分享无 Authorization、非公开分享仅属主 token 能过 `requireOwnedSession`，形态 A 在分享页必然取不到数（图片占位 / 下载报错）；这是 D2 失效语义的延伸，显式接受，不做服务端代取或 URL 改写（§2.2）。
- **失效语义全集（评审补充）**：ref 失效不止「源文件删除」——源文件被改写（跟随新内容，by design）、会话被删除（`requireOwnedSession` 404）、工作区目录被删（downloadFile 报工作区不存在）同样失效；§2.3 与 §7 提示词按此口径理解。

## 7. 提示词（工具描述 / tool prompt 增补）

在 `SEND_TOOL_BASE_PROMPT` 追加一段（两个工具共用）：

> 发送会话工作区内的文件时不做副本，附件直接引用工作区里的这份文件：之后修改或删除源文件，会话里看到的附件会跟着变化或失效；要交付「定稿快照」就先复制一份再发。发送你自己 uploads 目录里已有的文件（如生成图）同样直接引用。

## 8. 实现步骤

1. `shared/contracts/src/delivery.ts`：`DeliveryRef` 判别联合（`{ type: 'workspace'; sessionId: number; path: string }`），后端 / 前端共用。
2. 后端 `send-media-tool.ts`：资格判定函数（§5.1 三步）+ ref 分支 + `combineSendResult` ref 变体 + 提示词；`send_image` 前 16 字节嗅探复用 `sniffImageMime`。
3. 前端：contracts 类型接入 → `resolveDeliveryUrl` util → `extractDelivery` / `SendDelivery` → `ChatDeliveryBar` / `TaskView` 接线 → `downloadDeliveryUrl` / `createDeliveryFileProvider` 补 JSON 信封检查（评审补充）。
4. sdk/embed（评审补充）：`useRounds.extractDelivery` / `ChatPanel` 投递渲染 / types 收 ref，`npm run build` 产物复制进 `desktop/public/embed/` 提交。
5. 文档与碎片：`changelog/unreleased/2026-11-20-send-live-reference.md`（后端 + 前端共用 UI 两节）；README / `skills/mao-cli` 中发送工具说明同步一句活引用语义。
6. 发布：后端重启 + `bash scripts/deploy-desktop.sh`（embed 产物随 desktop dist 一起上线；纯前端发版，无原生壳变更、无迁移）。

## 9. 测试

- 后端 `send-media-tool.spec.ts` 增补：
  - CLOUD + 工作区文件 + chat-only：不读全量字节（可断言未触发容器 / 宿主读取）、未写 `send-*`、delivery 为形态 A、`path` 为归一化相对路径；
  - 绑定通道：推送成功且仍无副本、结果 `channelStatus: 'sent'`；推送失败时 `success=true` 且文案只有通道侧（§4.2 评审补充口径）；
  - 资格回落：路径逃逸（`../`）、符号链接、文件不存在、经验挂载命中 → 全部回落副本或按现状报错；
  - `send_image` 工作区来源嗅探拒绝非图片（文案与现状一致）；
  - uploads 原地引用：URL 形态与绝对路径形态命中（无下载、delivery.url 即源）、他人 uploads URL 不命中（照旧被跨成员预检拦截）、`.html` 来源回落副本成 `.bin`；
  - 外部 http(s) 来源仍走副本（回归）。
  - 引用侧上限与校验（评审补充）：形态 A stat size 超上限 → 回落副本链路并报「文件过大」；空文件按现状文案报错；send_image + 形态 B 非图片扩展名（如 `.txt`）回落副本；形态 B 路径形态 origin 解析失败回落。
  - 绑通道 + 引用 + `loadBytes` 失败（评审补充）：delivery 仍为 ref 形态、`success=true`、error 只含通道侧原因。
- 后端 `no-progress-notice.spec.ts`：ref 形态结果重复出现仍按四键签名判「无进展」。
- 前端：`resolveDeliveryUrl` 单测（ref / url / 无 token）、`extractDelivery` 双形态单测、`ChatDeliveryBar` ref 渲染与下载接线单测。
- 前端（评审补充）：`downloadDeliveryUrl` / `createDeliveryFileProvider` 对 HTTP 200 + code 信封响应报错而非存成文件 / 当文本渲染；`:key` 稳定性（token 变化不重挂载）；`extractDelivery` filename 回落取 `ref.path` basename。
- sdk/embed（评审补充）：`useRounds.extractDelivery` ref 形态用例、`ChatPanel` ref 渲染用例（产物 sha256 由既有 embed-sdk CI job 把关）。
- Playwright：既有 desktop 交付卡用例保持绿；如现有用例断言 `send-*` URL 形态，改为不敏感断言（卡片可见 + 文件名正确）。

## 10. 发布与回滚

- 纯代码变更：无迁移、无新配置；后端重启 + 前端 deploy-desktop（embed 产物随 desktop dist 一起上线）。后端先发、前端后发之间会出现「后端产出 ref、旧前端（desktop / embed 产物）不识别」的窗口（表现为该轮附件不显示，不报错），可接受；回滚只需回退两端代码。
- 观测：上线后对比 `uploads/*/send-*` 新增速率（引用化前基线 → 之后），验证 P1-1 / P1-2 生效。
