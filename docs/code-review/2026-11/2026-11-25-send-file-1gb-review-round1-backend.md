# send_file 1GB 后端代码审查（round 1）

- 日期：2026-11-25
- 审查对象：`mao` 工作区未提交改动中**后端**部分（见下方范围）
- 正确性基准：`docs/plan/2026-11/2026-11-25-send-file-1gb-technical-design.md`（已定稿）
- 审查方式：逐行静态审查 + `tsc -p tsconfig.build.json --noEmit`（通过）+ 相关单测
  （`vitest run src/file src/auth src/harness/tool src/harness/streaming src/harness/local src/harness/container`，1479 passed）
  + 针对「来源流未销毁」写了一次最小复现实验（见 P1-1）
- 不覆盖：桌面端 / agent-cli / 容器协议（另一子代理负责）；`shared/contracts`、`agent/types.ts`、
  `skill-sync-service.ts`、`V209` 迁移与 skill 重构方案（明确的并行会话改动）

## 一、总体结论

- **可以合并（无 P0）。**
- **P1：1 条**（来源流在 `save()` 提前返回的路径上未销毁 → fd 泄漏，有复现实验）。
- **P2：6 条**（5 条功能/健壮性：磁盘余量公式偏严、并发闸计数在设置读失败时永久泄漏、云 Range 未做单段收口、
  chat 会话不进大文件并发闸、取消信号在持久化后不再生效；1 条维护性：`fetch-bytes.ts` 注释与实际调用方断链）。

## 二、问题列表

### P1（应修）

#### P1-1 来源流在 `save()` 提前返回时既未被消费、也未被销毁

- 位置：
  - `backend-ts/src/harness/tool/impl/send-media-tool.ts:877-905`（`save` 调用与 `{ok:false}` 分支）
  - `backend-ts/src/file/send-file.service.ts:203-219`（三处「写临时文件之前」的提前 `return`）
- 问题：`splitStreamHead()`（同文件 854 行）已经真正读取了 `opened.stream` 的第一个块——宿主机来源
  此时 `fs.createReadStream` 的 fd 已分配；`rest` 是惰性的 `Readable.from(generator)`，不读不销毁。
  而 `sendFileStore.save()` 在下列路径上**直接返回 `{ok:false}`**、完全不碰 `input.body`：
  - `send-file.service.ts:207-211` 大文件并发闸拒绝（`当前有大文件正在发送，请稍后`）
  - `send-file.service.ts:218-219` 磁盘余量不足（`磁盘空间不足，暂时无法保存附件`）
  - `send-file.service.ts:203-205` 声明大小超限（正常链路不可达，防御用）
  工具侧只在 `catch` 里 `rest.destroy()`（899 行），拿到 `{ok:false}` 返回值时没有销毁；
  外层 `finally` 的 `opened.close?.()`（943 行）只覆盖容器 / LOCAL 执行端，宿主机与 http 来源没有 close。
- 影响：每次被拒绝的发送泄漏一个宿主机 fd（本机文件来源）或一段未关闭的 http 响应
  （http 来源由 guard 的空闲 30s 定时器兜底回收，宿主机 fd 不会回收）。
  Agent 重试或用户连点会把进程 fd 打满，随后**全进程**文件操作失败（EMFILE）。
- 复现（已实测）：用与 `splitStreamHead` 相同的「读一块 → 惰性 `Readable.from` 续接 → 不消费」写法跑 5 轮，
  丢掉引用并 `--expose-gc` 强制 GC 后 `/proc/self/fd` 仍比基线多 5 个；把 `rest` destroy 掉则归零。
- 修复建议（任选其一，推荐都做）：
  1. 工具侧：`save()` 返回后若 `!snapshot.ok` 立即 `rest.destroy()`（放在 903 行的两处早退之前，统一处理）；
  2. 服务侧：在 `SendFileService.save()` 的 `finally`（277-284 行）里 `input.body.destroy?.()`。
     destroy 对已结束的流是幂等的，不会影响正常路径，也符合「失败一律不留下游资源」的契约
     （当前注释写「调用方负责在失败时销毁」，但调用方只在抛异常时履行）。

### P2（建议）

#### P2-1 磁盘余量检查把本次请求自己也算进「已预留」，1GB 文件实际要求 2×文件 + 1GB 余量

- 位置：`backend-ts/src/file/send-file.service.ts:213`（`this.reservedBytes += reserved`）→ `218`（`checkDiskSpace(declared)`）
  → `392-406`（判定式 `available - reserved < need + this.reserveMarginBytes`）
- 问题：先把自己 +S 加进 `reservedBytes`，再用包含自己的 `reservedBytes` 和 `need = S` 比较，等价于要求
  `剩余 ≥ 他人预留 + 2S + 1GB`；设计 R5 的口径是 `剩余 − 已预留 ≥ 文件大小 + 1GB`，即 `剩余 ≥ 他人预留 + S + 1GB`。
- 影响：1GB 文件需要约 3GB 空闲才放行；磁盘在 2~3GB 空闲区间时会误报「磁盘空间不足，暂时无法保存附件」。
  只是偏严、不会写出半截文件，但属于对定稿口径的偏离。
- 修复建议：先 `checkDiskSpace(declared)` 再 `this.reservedBytes += reserved`（两步之间没有 await，Node 单线程下无竞态），
  或在 `checkDiskSpace` 内部排除自身预留（如 `reserved -= needBytes`）。

#### P2-2 `getUploadConfig()` 抛错会让预留字节与并发闸计数永久泄漏

- 位置：`backend-ts/src/file/send-file.service.ts:213-217`（`reservedBytes += `、`await this.getUploadConfig()` 都在
  `try`（217 行开始）之外，`finally` 在 277-284 行）
- 问题：`settingService.getUploadConfig()` 走 DB/缓存读取，抖动时会 reject；此时 `save()` 直接抛出，
  `finally` 不执行 → `reservedBytes` 永久 +S、`largeSendsTotal` / `largeSendsByUser` 永久 +1，且 `gate` 不释放。
- 影响（进程级、不可自愈）：累计 4 次后**所有**大文件发送恒返回「当前有大文件正在发送，请稍后」；
  `reservedBytes` 虚高还会让**所有**发送（含小文件）在 `checkDiskSpace` 处恒报磁盘不足，只能重启恢复。
- 修复建议：把 `getUploadConfig()`（以及 `randomUUID()`/`tmpPath` 计算）移入 `try`，或在 `try` 之前
  不写自增状态、改为在 `try` 内的第一行完成「预留 + 闸」并保证 `finally` 一定覆盖。

#### P2-3 云分支 Range 未做单段收口：416 被映射成 404，多段 Range 会返回损坏内容

- 位置：
  - `backend-ts/src/file/send-file.service.ts:531-540`（`status === 404` → `附件不存在`；`status !== 200 && status !== 206` → `附件读取失败`）
  - `backend-ts/src/file/file.routes.ts:928`（Range 原样传入）、`963-966`（云分支直接回 206 / Content-Range）
- 问题：
  1. 越界 Range（或对象被替换后浏览器残留的续传请求）上游回 **416 + `Content-Range: bytes */size`**，
     这里落到 `附件读取失败`，路由再转成 **404 信封**；本地分支同一场景是规范的 416。
     浏览器/下载器按协议会重开整份下载，收到 404 只能判定文件不存在，续传失败即整体失败。
  2. `bytes=0-99,200-299` 这类多段 Range 也被原样透传，上游回 `206 multipart/byteranges`，
     但路由用 `.type(row.mime)`（938 行）把 `Content-Type` 覆写成文件 mime、且不带 boundary，
     客户端拿到的是 multipart 原始报文（保存下来就是坏文件）。本地分支对多段是「忽略 Range 回 200 整份」，两边不一致。
- 修复建议：云分支也先走 `parseByteRange`（`null` → 不透传 Range 拿整份；`'invalid'` → 直接回 416 + `Content-Range: bytes */size`；
  单段 → 透传规范化的 `bytes=start-end`），或至少在透传前拒绝含 `,` 的多段头。

#### P2-4 chat 会话完全不进大文件并发闸（R5 的「每用户 1 路」对对话页大文件无效）

- 位置：`backend-ts/src/harness/tool/impl/send-media-tool.ts:888`
  （`gateLargeFile: channel !== 'chat' && (opened.size == null || opened.size > channelMax)`）
- 问题：`channelMaxBytes('file', 'chat')` 返回 0，按「超过通道上限」的定义 chat 里任何文件都算超限，
  但实现把 chat 显式排除在闸之外。1GB 的主战场正是对话页（不绑通道），同一用户可以并发发起多个 1GB 落盘/上云。
- 影响：R5 想挡的「两路 1GB 并发同时通过 statfs」在 chat 下仍然只剩 `reservedBytes` 兜底；
  而 http 无 `Content-Length` 来源 `reserved = 0`，此时没有任何限制。
- 修复建议：chat 会话按「文件大小 > 某个阈值（如 30MB/通道上限量级）」也置 `gateLargeFile = true`，
  与设计 R5「对超过通道上限的大文件加并发闸」对齐；具体阈值按产品口径定，但不应整类跳过。

#### P2-5 取消信号只在写盘阶段生效；持久化之后才判取消，会留下无引用的 1GB 快照

- 位置：
  - `backend-ts/src/file/send-file.service.ts:240-276`（`writeTemp` 结束后到 `persist` 之间不再看 `cancel`）
  - `backend-ts/src/harness/tool/impl/send-media-tool.ts:909-911`（`persist` 成功后才发现取消并 `return errorJson('发送已取消')`）
- 问题：`writeTemp` 的取消检查挂在 `Transform` 上（369-373 行），只在**下一个数据块到达**时生效。
  写完之后还有三个耗时步骤：LOCAL 的 `digest()` 往返（上限 60s）、云模式单次 PUT（最长可到分钟级）、`capture` 读盘；
  这期间用户点停止不会被感知。若取消落在 `persist` 之后，行已经插入、对象已经在盘/桶上，
  随后工具返回「发送已取消」，或 `AgentLoop` 因 `cancelFlag.get()` 直接丢弃工具结果
  （`agent-loop.ts:738/743/755`），这份快照就变成没有任何消息引用的永久孤儿（快照无 GC，设计 R4 明确要避免）。
- 修复建议：在 `save()` 调 `persist`（265/274 行）之前再判一次 `input.cancel?.get()`，命中就按 `SendCancelledError` 收口
  （`finally` 会删临时文件），把孤儿窗口缩到「insert 语句本身」；云模式还可把取消检查插到 PUT 之前。
  彻底方案需要删除接口（本轮无 GC，可留作后续）。

#### P2-6（维护性）`fetchBytesWithContentType` / `fetchBytesWithLimits` 已无生产调用方，注释与事实不符

- 位置：`backend-ts/src/harness/tool/impl/fetch-bytes.ts:37-50`
- 问题：注释写「保留给仍需要整份字节的调用方（如 edit_image 的入参读取、小文件场景）」，
  但全仓 grep 只有 spec 引用这两个函数；`edit_image` 走的是 `loadSendFileBytes → openSendBytesStream → fetchBytesStreamWithContentType`。
- 影响：下一个人会误以为还存在一条「整份读」的生产入口（1GB 下最危险的那条），排查/改造时走弯路。
- 修复建议：删除这两个函数（或至少改注释说明「仅供测试 / 无生产调用方」）。

## 三、已核对通过的关键点（避免重复排查）

- 三条硬失败路径的收口正确：
  - 超通道上限：`captureBytes = 0` / `willCapture = false`，`save()` 不读推送字节，工具用 `overloadError()` 组
    「文件超过 NMB 上限」并不调用 `pushFile`；对话页快照照常写（D1 / R1 第 4 步）。
  - 取消：`SendCancelledError` → `pipeline` 销毁来源 → tmp 由 `finally` 删除 → 不插表 → 工具直接返回「发送已取消」。
  - digest 不一致：`verifyDigest` 在 `persist` 之前抛错 → 删 tmp、不插表、工具硬失败不回源重推。
- 快照 `try/finally`：`opened.close?.()` 覆盖所有返回路径；`head.length === 0`、图片格式不符、`save` 抛错三处都显式销毁了流。
- 云写入（R3）：显式 `Content-Length`、连接 10s + 空闲 60s、失败整份重试 1 次且每次重建读流（无二次读取/整份入内存）；
  `req.on('close')` 销毁读流的时机在请求结束/中断之后，不会提前截断正常上传。
- `openDownload`：本地 `StrictPathResolver` + `realpathSync` + `isUnder(realpath(userDir))` + `lstatSync().isFile()`
  两道校验齐全（跨用户软链、目录/设备文件都拒）；云 404 → 「附件不存在」。
- `parseByteRange` 边界：空文件 416、`start >= size` 416、`end < start` 416、`bytes=-N` 收敛到 `0..size-1`、
  多段头不匹配 → 忽略 Range 返回整份（本地分支符合 RFC 允许的行为）。
- 票据：HMAC-SHA256 + `timingSafeEqual`（先比长度）、绑定 `fileId + userId + expiresAt`、过期即拒、
  `fileId` 必须与 query `id` 一致；jwt-hook 仅放行 `GET` + 精确路径 `/v1/files/send-download` + 带 `ticket` 参数，
  不会放行其它路径 / 方法；票据在 Fastify 访问日志（`serializers.req.url`）与审计 `queryString` 均已脱敏。
- `windowed-pull-stream`：窗口内最多 `windowSize` 片、短读即失败、销毁与 `onClose` 幂等（`closeOnce` + `closed`），
  正常读完不 close 且两个调用方（`delivery-fetch`、`docker-tool-router`）返回的 `close` 都由工具的 `finally` 显式调用；
  LOCAL 侧 `releaseStream` 对重复 close 幂等。
- `ToolCancelContext.run` 的包裹范围：包住了整个 `dispatchTool` 调用链（含其异步延续），
  与 `ToolCallContext.run` 嵌套顺序正确；并行工具调用各自独立 store，不会串台。
- 依赖注入：`SendDownloadTicketService` 在 `create-app.ts` 构造并透传到 `app-routes.ts` / `registerFileRoutes`；
  `SendFileTool` / `SendImageTool` 都拿到了 `sendBytesSupport` 与 `localDeliveryFetchService`。

## 四、未覆盖与仍存风险

- 容器 / LOCAL 的区间读取协议实现（`runtime-channel-protocol`、`container-tool-executor`、`docker-tool-router`、
  `delivery-fetch.service`、`localToolSessionRegistry`）按分工由另一子代理审查；本次只核对了它们与
  `windowed-pull-stream` / `SendBytesSupport.openStream` 的契约面（close 配对、size/digest 返回值）。
- 蓝绿双进程共用 `FILE_SEND_DIR/.tmp` 时，启动清理按 6 小时 mtime 保护在途文件；这是设计选择，
  但若一次发送/上云真的超过 6 小时（或新进程启动时对方进程正好卡在 6 小时以上的半成品上），残片会被对端清掉，
  目前只会在写入侧报一个 ENOENT 级错误、不会误插表。
- Nginx `proxy_buffering off`、桶用量/磁盘告警等上线门槛属于部署配置，不在本次代码审查范围。

## 五、结论

**没有 P0**；**P1 一条**（P1-1，来源流在 `save()` 提前返回时未销毁，宿主机 fd 泄漏，已实测可复现），
建议本次一并修掉（工具侧 `!snapshot.ok` 时 `rest.destroy()`，或服务侧 `finally` 里 `input.body.destroy()`）。
其余 5 条功能类 P2 均不影响 1GB 主链路的正确性，可按优先级在合入前或紧随其后处理：
P2-1 / P2-2 是磁盘与并发闸的边界与状态泄漏，P2-3 是云分支 Range 的协议正确性，
P2-4 / P2-5 与设计 R5 / R4 的口径有偏差，P2-6 是注释与死代码。
