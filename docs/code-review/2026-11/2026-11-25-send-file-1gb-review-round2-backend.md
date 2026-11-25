# send_file 1GB 后端代码审查（round 2，复核修复）

- 日期：2026-11-25
- 复核对象：round 1 报告 `2026-11-25-send-file-1gb-review-round1-backend.md` 的 7 条修复，以及
  `send-file.service.ts` / `file.routes.ts` / `send-media-tool.ts` / `delivery-fetch.service.ts` 的当前全文
- 复核方式：逐行静态审查 + 类型检查 + 单测 + 两处针对性运行时验证
  - `npx tsc -p tsconfig.build.json --noEmit` → **exit 2，3 条类型错误**（见 P0-1）
  - `npx vitest run src/file src/harness/local src/harness/tool/impl/send-media-tool.spec.ts src/harness/tool/impl/send-file-bytes.spec.ts src/harness/streaming` → 393 passed（vitest 走 esbuild，不查类型，所以全绿不能说明可构建）
  - 用 `tsx` 直跑 `SendFileService` 复现并发闸被误释放（见 P1-1）
- 不覆盖：桌面端 / agent-cli / 容器与运行时通道协议实现（`container-tool-executor`、`docker-tool-router`、
  `runtime-channel-protocol`、`streaming-ws-registry` 的新增方法）；本次只核对了它们与
  `SendFileService` / `LocalDeliveryFetchService` / `windowed-pull-stream` 的契约面

## 一、总体结论

**不可合并：P0 1 条、P1 1 条**（均为本轮修复新引入），另有 P2 4 条（其中 1 条为既有缺陷，1 条为可接受残留）。

- P0：`delivery-fetch.service.ts` 缺一个类型导入 → `tsc` 失败 → `npm run build` 失败，后端无法构建/部署。
- P1：`save()` 里 `gateAcquired` 无条件置位 → 任何一次「非闸」发送都会释放别人正在占用的大文件并发闸（R5 形同失效）。
- 上一轮 7 条：P1-1 / P2-1 / P2-2 / P2-3 / P2-4 / P2-6 已修且修法正确；P2-5 的残余窗口缩到「一条 INSERT」，
  属可接受的最佳努力（本轮未新增风险）。

## 二、P0（阻断）

### P0-1 `delivery-fetch.service.ts` 引用未导入的类型，构建直接失败

- 位置：`backend-ts/src/harness/local/delivery-fetch.service.ts:253`
  （`private sendFrame(...): Promise<PendingLocalToolRequest>`）
- 实测：`npx tsc -p tsconfig.build.json --noEmit` 退出码 2，三条错误：
  - `delivery-fetch.service.ts(253,14): error TS2304: Cannot find name 'PendingLocalToolRequest'.`
  - `delivery-fetch.service.ts(211,40): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.`
  - `delivery-fetch.service.ts(234,38): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.`
  后两条是连带错误：`sendFrame` 的返回类型解析失败后 `readPending` 变成 error 类型 →
  `raceTimeout(...)` 推成 `unknown` → `parseResultFrame(raw)` 收不了。
- 影响：`npm run build` 是 `tsc -p tsconfig.build.json && node ...`，第一步即非零退出，
  `deploy-mao.sh` 的后端构建会中止——**当前工作区不可构建、不可部署**。
  单测全绿（393 passed）是因为 vitest 走 esbuild 只剥类型，掩盖了这个问题。
- 修复：在该文件补一行
  `import type { LocalToolSessionRegistry, PendingLocalToolRequest } from './local-tool-session-registry.js';`
  （`PendingLocalToolRequest` 已在 `local-tool-session-registry.ts:17` 导出）。
  建议 CI/提交前把 `tsc --noEmit` 加进门禁，避免「测试绿但构建红」。

## 三、P1（应修）

### P1-1 `gateAcquired` 无条件置位：任何非闸发送都会释放别人的大文件并发闸

- 位置：`backend-ts/src/file/send-file.service.ts:216-219`（`if (gate && !this.acquireLargeSend(...)) return ...`
  之后紧接着 `gateAcquired = true;` 在 `if` 之外）、释放点在 `295`。
- 机制：`gateLargeFile: false` 的发送（聊天里发图、<20MB 的小文件、任何 ≤ 通道上限的发送）也会把
  `gateAcquired` 置 true，`finally` 里就调用 `releaseLargeSend(userId)`；该函数对「本用户没有记录」的情况
  仍会 `largeSendsTotal -= 1`。因此：
  1. 同一用户正在发 1GB 时，只要再发一张图片，**该用户的大文件闸就被清空**，可以立刻并发第二路 1GB；
  2. `largeSendsTotal` 被跨用户持续压低（`Math.max(0, …)` 只是不让它变负，不回补），全局 4 路事实上不成立。
- 实测（`tsx` 直跑 `SendFileService`，`maxLargeSendsPerUser: 1`）：
  - 第一路 `gateLargeFile: true` 挂住后 `largeSendsTotal = 1`；
  - 再发一个 `gateLargeFile: false` 的 2 字节文件 → `largeSendsTotal = 0`、`largeSendsByUser.get(7) = undefined`；
  - 随后第二路 `gateLargeFile: true` 直接返回 `ok: true`（应被「当前有大文件正在发送，请稍后」拒绝）。
- 影响：R5 新增的并发闸（本次需求的明确交付项之一）被日常的小文件发送打穿。磁盘预留 `reservedBytes`
  只对 `declaredSize != null` 生效，http 无 `Content-Length` 的来源 `reserved = 0`，此时 1GB 并发**没有任何兜底**。
  不损坏数据，但属于安全/容量保护机制的回归。
- 修复：`gateAcquired = gate;`（或把赋值放进 acquire 成功的那一支）。
- 建议补单测：一路 `gateLargeFile: true` 在途时，插一次 `gateLargeFile: false` 的小文件发送，
  第二路 `gateLargeFile: true` 仍必须被拒。（现有 spec 只覆盖「两路都带闸」，这个 bug 因此没被测出来。）

## 四、P2（建议）

### P2-1 `LocalDeliveryFetchService.openStream` 在 open 帧下发抛错时不释放 per-user 在途名额（既有缺陷，非本轮引入）

- 位置：`backend-ts/src/harness/local/delivery-fetch.service.ts:133-136`
  （`trackStream` 成功后直接 `await this.registry.sendDeliveryReadRequest(...)`，没有 try/catch；
  只有 `pending.requestId == null` 分支（143-145）会 `releaseStream`）
- 触发：`dispatchRequest` → `resolveTarget` → `sessionMapper.selectById`（缓存未命中时）DB 抖动 → 抛异常。
- 影响：`streams` / `activeByUser` 各泄漏 1；累计 4 次后该用户的 LOCAL 发送恒返回
  「当前有多个文件正在发送，请稍后重试」，只能重启恢复。
- 修复：`let pending; try { pending = await ... } catch (e) { this.releaseStream(streamId); throw e; }`。

### P2-2 云分支把「畸形单段 Range」原样透传，与本地分支「忽略」不一致，且可能被报成 404

- 位置：`backend-ts/src/file/file.routes.ts:1010-1015`（`normalizeRangeHeader` 只挡多段与空值）、
  `backend-ts/src/file/send-file.service.ts:563-566`（非 200/206/404/416 → 「附件读取失败」→ 路由 404）
- 问题：`bytes=abc`、`bytes=0-10-20` 这类头本地分支由 `parseByteRange` 返回 null → 忽略 Range 回整份 200；
  云分支会原样发给上游，若上游回 400（部分实现会这样），最终对客户端是 **404 + 「附件读取失败」**，
  语义从「Range 不合法」变成「文件不存在」。
- 建议：`normalizeRangeHeader` 顺带校验 `^bytes=\d*-\d*$`（且不能是 `bytes=-`），不匹配一律返回 null。
  这样两端「不合法即忽略」完全一致，也顺手把「404 误判」这一类彻底关掉。

### P2-3 云 PUT 后取消的删除是 best-effort，`sign()` 抛错时会把异常抛出去

- 位置：`send-file.service.ts:286-289` → `deleteCloudObject`（`487-495`）
- 现状：网络失败被吞掉并记日志（对象残留 = 孤儿，与插表失败回滚同等级，可接受）；
  但 `deleteCloudObject` 里 `this.sign(...)` → `getStorageConfigs()` 抛错时异常会穿出 `save`，
  工具拿到的是原始错误而不是「发送已取消」，且对象残留。
- 建议：`try { await this.deleteCloudObject(...) } catch { /* 仅日志 */ }` 后统一返回
  `{ ok: false, error: '发送已取消' }`。

### P2-4 取消窗口仍剩「一条 INSERT」（可接受）

- 位置：`send-file.service.ts:261`（capture 前）、`286`（云 PUT 后）、`290/276`（`persist`）
- 现状：digest 往返、云 PUT、读盘三个长耗时点都已在提交前判取消，残余窗口只有 `persist` 里的 insert 本身；
  insert 期间取消仍会留下一行（工具随后返回「发送已取消」或被 AgentLoop 丢弃结果）。
- 结论：属可接受的最佳努力，本轮不必处理；彻底解决需要删除接口（本轮无 GC）。

### P2-5（文档漂移，顺手改）

- `send-file.service.ts:70`（`SendFileSaveInput.body` 注释）仍写「调用方负责在失败时销毁」，
  但 `save` 现在**无条件** destroy（298 行），契约已变。
- `send-file.service.ts:79-80`（`gateLargeFile` 注释）仍写「超过通道上限的发送才置 true」，
  chat 现在按 `LARGE_SEND_GATE_BYTES`（20MB）判定。
- `file.routes.ts:999-1009` 两段 JSDoc 叠在 `normalizeRangeHeader` 上（旧的 `parseByteRange` 注释留在了上面），
  建议删掉前一段。

## 五、针对本轮四个重点问题的结论

1. **新增资源/状态泄漏**：`reservedRegistered`（226 置位 / 294 撤销）配对正确，`getUploadConfig` 抛错时
   预留与闸都会释放（P2-2 已修）；`gateAcquired` **配对错误**（P1-1）；云 PUT 后取消会先删对象再收口（正确），
   仅剩 best-effort 残留（P2-3）。`delivery-fetch` 的 `streamSockets` 在 `closeStream` 里统一清理，
   正常/失败路径都覆盖到了；唯一遗留是 P2-1 的 open 下发抛错。
2. **Range / 416 一致性**：「文件不存在」不会变成 416（云 404 与本地 `附件不存在` 都不带 `status`，
   路由回 404）；416 只来自上游 416 或本地 `parseByteRange === 'invalid'`。合法单段、越界、多段三种情况
   本地与云一致（多段两端都回整份 200）。差异只剩 P2-2 的畸形单段头；另外 416 的 `Content-Range` 兜底
   一边用磁盘 size、一边用库里的 `row.bytes`，上游正常会带该头，影响可忽略。
3. **chat 进闸对既有通道会话**：非 chat 时 `gateThreshold === channelMax`，与 round 1 完全等价，
   **通道会话行为没有变化**；但 P1-1 的误释放对所有会话都生效（小文件/图片都会清闸）。
4. **上一轮未修项**：P2-6 只改注释（两个整份变体仍无生产调用方），可接受；P2-5 的窗口已缩到一条 INSERT，
   可接受；其余 5 条均已修，修法正确。

## 六、已复核通过（本轮改动）

- `save()` 的 try/finally 现在覆盖「声明超限 / 并发闸拒绝 / 磁盘不足」三条提前返回，`finally` 里
  `(input.body).destroy?.()` 无条件销毁来源；工具侧 `!snapshot.ok` 也 `rest.destroy()`（`send-media-tool.ts:911-918`）。
  两条都幂等，正常路径不受影响；回源重推通道走 `loadBytes` 重新开流，不受 destroy 影响。
- 磁盘余量：先 `checkDiskSpace(declared)` 再 `reservedBytes += reserved`，两步之间无 await；
  判定式回到「剩余 − 他人预留 ≥ 文件 + 1GB」，新增单测覆盖 2.5MB/1MB/1MB 边界。
- `acquireLargeSend` 与 `getUploadConfig()` 都在 try 内；「连续 5 次抛错后仍可发送」的单测有效。
- 取消检查：capture 前（261）、云 PUT 后（286，先删对象）两处；新增「digest 往返期间取消」单测覆盖。
- `openCloudGet` 的 416 分支（`send-file.service.ts:556-562`）与路由 416 透传（`file.routes.ts:932-938`）
  类型与流程都对；`SendFileDownloadTarget` 的失败分支新增 `status?/contentRange?`，本地失败不带 status → 404。
- `normalizeRangeHeader` 挡多段 → 两端都回整份 200，与设计 R7 的「多段没有浏览器场景」一致。
- chat 进闸阈值 `LARGE_SEND_GATE_BYTES = WECHAT_MAX_BYTES`（302 行，定义在 `WECHAT_MAX_BYTES` 之后）；
  工具侧 `gateLargeFile: opened.size == null || opened.size > gateThreshold`，spec 覆盖 wechat / chat / 20MB 以下三种。
- `fetch-bytes.ts` 注释已改为「当前没有生产调用方」，与 grep 结果一致。
- `delivery-fetch` 的多执行端认领（`streamSockets` + `sendToLocalSocket` + `handleResult(..., socket.id)`）
  契约闭合：open 成功记 socket、read/digest/close 定向、`closeStream` 统一摘除；`DELIVERY_DIGEST_TIMEOUT_MS`
  单独放宽到 300s 合理；`INFLIGHT_LIMIT_ERROR` 与离线文案分开，符合 R2 的文案要求。

## 七、结论

**本轮不能直接合并**：P0-1（缺类型导入导致 `tsc`/`npm run build` 失败）必须修，否则发布流程第一步就断；
P1-1（`gateAcquired` 无条件置位）会让 R5 的每用户 1 路 / 全局 4 路并发闸被任意小文件发送清掉，已实测复现，
也应在合入前修掉（一行改动 + 一条单测）。两者修完后，round 1 的 7 条修复即可视为闭环；
其余 4 条 P2 均为「既有缺陷 / 一致性 / 可接受残留」，可在本轮或紧随其后处理。
