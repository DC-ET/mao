# 第二轮复查报告：会话压缩「请求体体积」触发 + 图片前置压缩

- 复查时间：2026-10-22
- 仓库/分支：`/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`，`main`（改动仍全部未提交）
- 复查对象：第 1 轮报告 `docs/code-review/2026-10-22-payload-budget-review-01.md` 的逐条修复，以及修复本身引入的新问题
- 复查方式：`git diff` 全量 + 逐文件阅读；`tsc`；单测；另用临时脚本（仅 `/tmp`，未改仓库）实测 EXIF 压缩、估算器误差/耗时、远端图压缩后尺寸

## 一、结论摘要

- **严重问题：0 个**
- **中等问题：3 个**（均为本轮修复新引入或未闭环的控制流/内存问题）
- **轻微问题：11 个**（测试有效性、文档一致性、边界近似、残余性能）
- **待确认：3 个**（其中 V167 若已被应用过会成为启动阻塞，见待确认 1）
- **上线建议**：建议先修 R2-M1 / R2-M2 / R2-M3 再上线（都是小改，风险收益比高）；其余轻微项可跟进。S1、S2 两个原阻塞问题已真正修复。

本轮验证：

| 验证项 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` | 通过（0 error） |
| `npx vitest run src/harness/core src/harness/llm src/harness/tool src/model src/settings src/feishu src/weixin src/dingtalk` | 142 files / 1975 tests 全部通过 |
| EXIF 手工验证（3000×2000 JPEG，orientation=6，4.46MB） | `resizeForPrompt` → 1280×1920，实际编码 1280×1920；`compressForStore` → 1280×1920 / 273KB，实际编码与上报一致 |
| `jsonStringBytes` 精度/耗时 | 8.1M 字符 JSON 密集文本：估算 +2.00%，47ms；0.2M 字符：+2.06%，2.5ms |
| 远端图压缩后尺寸 | 3.5MB 随机噪声 JPEG → 307KB（data URI 410KB，与 `REMOTE_IMAGE_BYTES=409728` 基本吻合） |

## 二、第 1 轮问题复核

| 上轮条目 | 状态 | 说明 |
|---|---|---|
| S1 repository 漏字段 | **已修复** | `model.repository.ts:115,144` 已补 `maxRequestBodyBytes: model.maxRequestBodyBytes ?? null`；`createModel/updateModel` 参数改为可选。遗留：新测试仍打在 mock 上（R2-L2） |
| S2 缺 system_setting 行 | **已修复** | V167 追加 `INSERT IGNORE`；遗留 checksum 风险（待确认 1） |
| M1 未配上限时兜底失效 | **基本修复，但引入耦合问题** | 未知上限时按全局阈值剥图，存量 50MB 会话可救；但剥图线被 `triggerPayloadBytes=0` 关掉（R2-M1），且文档仍写「剥后仍超则抛」（R2-L8） |
| M2 URL 图片估算低估 | **已改善** | `urlBytes` 对 http(s) 按 410KB 计；遗留小图高估/非视觉模型误触发（R2-L6、待确认 3） |
| M3 compact 返回 false 也置位 | **已修复，但引入无限重试** | 只有成功才置位；失败后每个工具轮都重试（R2-M2） |
| M4 loopMidwayCompact 关掉仍写库/推事件 | **已修复** | token 计算/快照/事件仅在开关开启时执行；payload 仍每轮估算，`buildRequest` 仍每轮（R2-L11） |
| M5 EXIF 旋转不一致 | **已修复** | `orientedDimensions` + `.rotate()` + 编码后真实宽高；手工验证通过。遗留 `read_file` 尺寸文案（R2-L9）与测试只覆盖 resize 路径（R2-L10） |
| M6 MB/MiB | **已修复** | 后台改十进制 MB、`precision=2`、提示与设计文档同步 |
| L1/L2 字节口径与转义 | **已修复** | 工具 schema 用 `Buffer.byteLength`；文本加转义补偿。但「采样」实现实际是全量扫描（R2-L5） |
| L3/L4/L6/L7/L9 | **已修复** | 注释统一 ≤7；压不小时保留原图；404/410 丢弃缓存；20s 超时；禁用压缩不再展示触发上限 |
| L10 request_start 未置位 | **未达成原意** | 置位判断读的是压缩**后**的估算（R2-L1） |
| L11 IM 串行压缩 | **已改并发，但内存峰值上升** | 三个通道改 `Promise.all`（R2-M3） |
| L5/L8/L13 | 按约定接受 | 动图单帧已写入设计文档；WeakMap/测试日志保持现状 |

## 三、中等问题（本轮新引入 / 未闭环）

### R2-M1. 剥图安全线与 `triggerPayloadBytes` 耦合：设 0「关闭体积触发」会同时关掉 413 兜底

- 文件：`backend-ts/src/harness/core/compaction-service.ts:171-188`
- 证据：

```ts
const stripLimitBytes = providerLimitBytes > 0
  ? Math.max(1, providerLimitBytes - COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES)
  : Math.max(0, config.triggerPayloadBytes);      // ← 未声明上限时直接复用触发阈值
if (stripLimitBytes > 0) {
  ...
  if (compactionBytes >= stripLimitBytes) { ...strip... }
}
```

- 影响（两个方向）：
  1. `harness.compaction.triggerPayloadBytes` 的语义是「0 = 关闭体积**触发**」（设置页 hint、设计 §5.1 都这么写）。但 `providerLimit` 未知时，`stripLimitBytes` 也变成 0 → **剥图兜底完全关闭**。此时用户点「立即整理」（force）或 token 触发压缩一个 50MB 会话，压缩请求会带着 50MB 原样发出并 413——正是本方案要消除的场景。未配置供应商上限是默认状态（设计明确「未配置 → 用全局 40MiB」），所以这个组合并不罕见。
  2. agent 级 `configJson.compaction.triggerPayloadBytes` 可以覆盖成一个小值（例如 800KB，用于提前压缩）；`resolveCompactionConfig` 会把它带进 `config`，于是剥图线也变成 800KB → 每次压缩都剥图、都 miss 前缀缓存，直接破坏「压缩请求命中缓存」的核心目标（`harness-service.ts:672-696` 只校验了范围，没有区分触发值与安全线）。
- 修复建议：把「安全线」与「触发开关」解耦。例如新增 `COMPACTION_STRIP_FALLBACK_BYTES = 40 * 1024 * 1024`，未知上限时用 `Math.max(globalTriggerBytes, ...)` 或直接用固定 40MiB；`triggerPayloadBytes=0` 只关闭触发，不能关闭安全线。补两条测试：`trigger=0 + providerLimit=null + 50MB 压缩请求 → 必须剥图`；`agent trigger=800KB + providerLimit=null → 剥图线仍为 40MiB`。

### R2-M2. `compact()` 返回 false 后每个工具轮都重试：语义失败/413 会被无限放大

- 文件：`backend-ts/src/harness/core/agent-loop.ts:549-558`；失败来源见 `session-compaction-orchestrator.ts:62,79,127-130`
- 证据：

```ts
if (trigger != null) {
  const compacted = await this.sessionCompactionOrchestrator.compact(...);
  if (compacted) {
    if (trigger === 'payload' || trigger === 'both') context.payloadCompactionDone = true;
    context.preparedRequest = await this.promptEngine.buildRequest(context);
  }   // ← false 时没有任何失败计数/冷却，下一轮 continue 后再次触发
}
```

- `compact()` 在以下情况会正常返回 false（不抛异常）：`history.persistedMessages.length === 0`、摘要两次都未通过语义校验（每轮会调用 **2 次** LLM）、快照非物理前缀、CAS 未推进。413 则在适配器内抛错，被 `agent-loop.ts:568` 的 catch 吞掉后继续下一轮。
- 影响：请求体积 ≥ 阈值时会形成「每个工具轮 → 一次（或两次）全量历史压缩调用」。以 40MB 历史、20 个工具轮计，最坏是 40 次 40MB 上传 + LLM 调用；如果摘要模型一直不输出合法 `<handoff>`，或上游一直 413，会显著拖慢/烧钱，且没有上限。第 1 轮的实现（成功或失败都置位）虽然不能重试，但不会放大；本轮把「重试」变成了「无限重试」。
- 修复建议：加失败计数与上限（如 `payloadCompactionFailures`，最多 1–2 次/执行），或让 `compact()` 返回原因（`ok` / `no-messages` / `contract` / `cas` / `overflow`），只对 `no-messages`/`cas` 这类可恢复失败重试；语义失败与 413 不应每轮重试。补一条「连续 N 轮失败后不再调用」的测试。

### R2-M3. IM 入站多图 `Promise.all` 无并发上限，压缩内存峰值成倍放大

- 文件：`backend-ts/src/feishu/agent-inbound-handler.ts:899-904`、`backend-ts/src/weixin/agent-inbound-handler.ts:436-442`、`backend-ts/src/dingtalk/agent-inbound-handler.ts:648-651`
- 证据：

```ts
const uris = await Promise.all(media.images
  .filter((uri) => uri != null && uri.trim() !== '')
  .map((uri) => PromptImageResizer.compressDataUriForStore(uri)));
```

- 影响：`compressDataUriForStore` 会先 base64 解码，再让 sharp 解码整张图。钉钉单文件下载上限 20MB（`dingtalk/runtime.ts:572`），一张 8000×6000 JPEG 解码约 144MB 原始像素；9 张并发就是 GB 级 RSS 峰值，且 backend 是单进程多会话共享。改造前串行峰值只有单张，这是本轮新引入的稳定性风险（飞书/微信的图片数量与尺寸上限不同，但同样没有并发上限）。
- 修复建议：加一个固定并发度（2 即可，sharp 本身有线程池）的小工具函数，三个通道共用；或在解码前用 `sharp.metadata()`/`limitInputPixels` 先拒绝超大像素图。补一条「N 张图并发度 ≤2」的单测（用 spy 统计同时进行数）。

## 四、轻微问题

### R2-L1. request_start 的 `payloadCompactionDone` 判断读到了压缩**后**的 `lastRequestBytes`，L10 实际未生效
- 文件：`backend-ts/src/harness/core/harness-service.ts:509-517`；`backend-ts/src/harness/core/session-compaction-orchestrator.ts:122-125`
- `compact()` 成功时（`advanced=true`）内部会 `await promptEngine.buildRequest(context)` 计算 `afterRequestTokens`，该调用会覆盖 `context.lastRequestBytes` 为**压缩后**的估算。回到 harness-service 时再判断 `context.lastRequestBytes >= triggerBytes`：正常压缩成功后体积已降到阈值以下 → 条件为 false → 不会置位；只有「压缩后仍超阈值」才置位。
- 影响：`payloadCompactionDone` 没有实现「本次 request_start 已用掉体积压缩名额」，同一次执行内 mid-loop 仍可能再压一次。实际影响较小（需要 payload 在一轮内重新涨回阈值），但注释「本次请求体积已越线」与事实不符，且设计 §5.4 的「同一执行只做一次」未落实。
- 修复建议：在调用 `compact()` 之前保存 `const bytesBeforeCompact = context.lastRequestBytes;`，用 `compacted && bytesBeforeCompact >= triggerBytes` 置位；或在 orchestrator 里把压缩前后的体积作为返回值带出。

### R2-L2. S1 的新测试仍然打在 mock 上，无法捕获「repository 漏字段」这类回归
- 文件：`backend-ts/src/model/model.service.spec.ts:140-180`
- `expect(modelRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ maxRequestBodyBytes: ... }))` 只能证明 service 把字段传给了 repo；如果 `model.repository.ts` 再次漏写字段，测试仍然全绿（这正是第 1 轮的原始 bug）。项目里没有 `model.repository.spec.ts`。
- 建议：加一个 repository 单测（用假 `Db` 捕获 `insert`/`updateById` 的入参对象，断言包含 `maxRequestBodyBytes`），或至少加一条 `db.insert`/`db.updateById` 调用参数断言。否则这类「service 返回对象正确、DB 没写」的 bug 仍无法被 CI 发现。

### R2-L3. 剥图边界测试仍是单向的，无法验证「未超线不剥图」
- 文件：`backend-ts/src/harness/core/compaction-service.spec.ts:352-388,406-439`
- 两个新用例的估算值（900,000 / 900）都远高于剥图线（734,464 / 800），只断言「剥了」。即使把 `COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES` 改成 200KB（剥图线 600,000）或改成 `>`/`>=`，测试仍会绿。
- 建议：补一条反向用例：`estimate = stripLimit - 1` → 不剥图、请求保持图片；以及 `estimate = stripLimit` → 剥图。用真实量级（如 800KB 上限、734,464 边界）分别断言。

### R2-L4. agent-loop 缺少「压缩成功后不再重复压」的测试
- 文件：`backend-ts/src/harness/core/agent-loop.spec.ts:874-904`
- 新测试只覆盖 `compact()` 返回 false 时的重试；没有覆盖 `mockResolvedValue(true)` + 两个工具轮 → `compact` 只应调用一次（`payloadCompactionDone` 生效）。如果以后有人把置位逻辑删掉，现有测试不会失败。
- 建议：加一条成功路径用例，断言第二次工具轮不再因 payload 调用 compact（token 也低于阈值时）。

### R2-L5. `jsonStringBytes` 号称「采样」，实际是全量扫描；注释/文档与实现不符
- 文件：`backend-ts/src/harness/core/request-size.ts:33-34,52-66`；设计文档 §4.2 `docs/plan/...:134-135`
- 三个 `start` 分别是 `0`、`(len-size)/2`、`len-size`，三段切片是**首/中/尾连续拼接**，合起来覆盖整段文本（只漏 0–2 个字符），实际上是 O(n) 全量扫描 + 3 次 `slice` 拷贝，不存在「转义集中在一处」的采样盲区。实测 8.1M 字符 47ms（估算 +2.00%），精度没问题，但与注释/文档的「96K 字符采样扫」「一次估算 <2ms」不符；超长单行文本每轮会多一次全量扫描和一份 UTF-16 拷贝。
- 建议：二选一——(a) 真要采样就改成固定 32K 窗口并补「转义集中在未采样区」的测试（此时必须接受低估）；(b) 保持全量扫描，把注释/文档改成「全量扫描 + 1.02 系数」，并把 §4.2 的性能数字改成实测值。另：`countEscapes` 对 `\b`/`\f` 按 +5 计（实际 JSON 是 `\b`/`\f` 两字符、+1），属轻微高估。

### R2-L6. `REMOTE_IMAGE_BYTES=410KB` 是近似值，不是严格上界；且对非视觉模型会高估
- 文件：`backend-ts/src/harness/core/request-size.ts:31-32,74-78`；`backend-ts/src/harness/llm/remote-image-cache.ts:133-135`
- 三处残余：
  1. `compressForStore` 在 6 次尝试都未达 300KB 时返回「最小 attempt」，可能略大于 300KB（实测 3.5MB 噪声图 → 307KB，data URI 410KB，比常量 409,728 高约 10KB/张；1.02 系数后仍略低约 2KB/张）；单张影响可忽略，但大量图片会累积。
  2. 解码失败时 `remote-image-cache.ts:133-135` 会把**原始字节**直接转 data URI（无上限），此时估算仍按 410KB/张，可能低估数 MB/张。
  3. 非视觉模型（`supportsVision=false`）在适配器里会把图片替换成占位文本（`openai-llm-adapter.ts:483-486`），实际 body 很小，但估算仍按 410KB/张 → 约 100 张 URL 图就会误触发 40MiB 体积压缩（并可能剥图/重置窗口）。反过来，100KB 级小图被按 410KB 计，会提前 4 倍触发。
- 建议：把 `supportsVision` 传入估算器（非视觉模型按占位符计）；给远端缓存条目设置单张上限（例如压缩失败且原始 >5MB 时不入缓存/回退 URL）；如需精确，可让 cache 暴露 `sizeOf(url)` 供估算器查询。

### R2-L7. 404/410 丢弃缓存后没有负缓存，已删除图片会在每次请求里重新下载
- 文件：`backend-ts/src/harness/llm/remote-image-cache.ts:144-149`
- `drop()` + `throw` 的清理是正确的（`inflight` 由 `.finally` 删除），但下一次 `resolve()` 没有条目，会再次 `fetch`。适配器按消息/图片**串行**下载（`openai-llm-adapter.ts:487-490,539-551`），所以一条含 N 张已删除图片的历史，每次 LLM 请求都要 N 次网络往返；若其中一个域名不可达，每张会等满 20s 超时。
- 建议：加一个短 TTL（如 5 分钟）的「负缓存」（`Map<url, expireAt>`），命中负缓存直接抛错/回退原 URL；或对 404 的 URL 记录 `failedAt`，避免每次请求重试。

### R2-L8. 设计文档/CHANGELOG 与 M1 的实际行为不一致
- 文件：`docs/plan/2026-10-22-session-compaction-payload-budget-technical-design.md:311-327`、`CHANGELOG.md:20`
- 设计 §6.4 仍写着：

```ts
if (estimate(compactionRequest) >= (providerLimit > 0 ? providerLimit : stripLimit)) {
  throw new CompactionPayloadOverflowException(...);
}
```

但代码只在 `providerLimitBytes > 0` 时抛（`compaction-service.ts:182-186`），未知上限时刻意「尽力而为」。CHANGELOG 也仍写「只有压缩请求本身逼近供应商上限（上限−64KB）才兜底剥图，剥后仍超则抛业务异常」——现在未知上限时也会在全局阈值剥图且不抛。设计 §4.2 的「96K 字符采样扫」也与 R2-L5 的实现不符。
- 建议：同步文档：明确「未知上限 → 全局阈值剥图、不抛、继续尝试」「已知上限 → 上限−64KB 剥图、仍超则抛」，以及估算器的真实扫描口径与实测性能。

### R2-L9. `read_file` 的尺寸文案仍用未旋转的原始宽高
- 文件：`backend-ts/src/harness/tool/impl/read-file-tool.ts:104-125`
- `origWidth/origHeight` 取的是 `metadata()` 的原始像素，`resized.width/height` 是摆正后的尺寸；对 orientation=6 的 4000×3000 照片会显示 `4000×3000→1536×2048`，而真实「原图尺寸」是 3000×4000。不影响 `width/height` 字段（用的是 resized），只是 summary 文案容易误导。
- 建议：复用 `PromptImageResizer` 的 `orientedDimensions`（可导出），或在 read-file-tool 里按 orientation 5–8 交换后再拼文案。

### R2-L10. EXIF 测试只覆盖 `resizeForPrompt`，没有覆盖 `compressForStore` 的有损路径
- 文件：`backend-ts/src/harness/tool/prompt-image-resizer.spec.ts:75-84`
- 测试用一张纯色小 JPEG（远低于 500KB），只走 `resizeForPrompt`；`compressForStore` 里 `encodeStore` 的 `.rotate()` + `fit:'inside'` + `resolveWithObject` 真实宽高没有被测试锁住（我手工用 4.46MB orientation=6 图片验证通过：1280×1920，上报与编码一致）。
- 建议：补一条 >500KB 的 orientation=6 用例，断言 `compressForStore` 输出为竖图、`width/height` 与 `sharp(result.bytes).metadata()` 一致。

### R2-L11. `loopMidwayCompact=false` 时仍每轮完整 `buildRequest`，设计「仅一次估算」仍未达成
- 文件：`backend-ts/src/harness/core/agent-loop.ts:528-536`
- 本轮已把 token 计算/快照/事件移入 `if (loopConfig.loopMidwayCompact)`，但 `promptEngine.buildRequest(context)` 仍每轮执行——为了拿 `lastRequestBytes` 这是当前架构下最直接的做法，但 builder 里包含快捷命令展开（可能查 DB）、历史归一化、manifest、工具 schema 序列化、前缀指纹计算。结合 R2-L5 的 8MB 文本 47ms/次，长文本 + 多工具轮时会有可感知开销。设计 §5.5 写的是「成本仅一次估算」，与实现仍有差距。
- 建议：至少在注释/设计里承认「每轮重建请求以获取体积」；若要优化，可让 builder 暴露轻量 `estimateOnly` 路径，或缓存上一轮请求 + 增量工具结果。

## 五、待确认

1. **V167 已被任何环境应用过吗？** `flyway.ts:243-244` 对已应用迁移做 checksum 校验，不一致会直接抛错拒绝启动。本轮把 `INSERT IGNORE system_setting` 追加进了已存在的 V167；如果开发/测试环境在第 1 轮后启动过后端（Flyway 默认启用），这些库的 `flyway_schema_history` 里已记录旧 checksum，部署新版会启动失败。请确认所有环境（含本地 dev 库）的 `flyway_schema_history` 没有 V167 记录；若已应用，应把 INSERT 移到新的 `V168__settings_compaction_payload_threshold.sql`，不要改 V167。
2. **压缩模型 ≠ 会话模型、且压缩模型未声明上限时**：`resolveEffectiveTriggerBytes(sessionModelConfig)` 用会话模型的上限算触发，`stripLimitBytes` 用压缩模型的上限（未知 → 全局 40MiB）。若会话模型上限 32MB、压缩模型实际 10MB，压缩请求可能在 25.6MB 触发且不剥图（<40MiB），打到压缩模型后 413。现在只有一条 warn（`compaction-service.ts:166-170`），无法阻止。设计 §6.3 要求 `compaction.modelId` 留空或与会话模型一致；建议后台加提示/校验，或对「不同模型且压缩模型无上限」时保守地按会话模型上限剥图。
3. **非视觉模型 + URL 图片的误触发**（R2-L6 第 3 点）：`supportsVision=false` 时适配器用占位文本替换图片，估算器却按 410KB/张计。是否需要把 `supportsVision` 传入 `RequestSizeEstimator`，请确认产品上是否存在「非视觉模型会话里积累大量上传图」的场景（切换模型后历史仍保留）。

## 六、上线建议

- **S1、S2 已真正闭环**，可以合并；合并前请先确认待确认 1（V167 checksum），否则可能直接起不来。
- **建议本轮再修 3 个中等项**：
  1. R2-M1：剥图安全线与 `triggerPayloadBytes` 解耦（一行改动 + 两条测试）；
  2. R2-M2：失败重试加上限或失败原因（避免每轮全量压缩）；
  3. R2-M3：IM 多图压缩加并发上限（避免内存峰值）。
- 轻微项中，R2-L2（repository 单测）和 R2-L3（剥图反向用例）建议顺手补上，否则这两个原 bug 的回归仍然无测试保护；R2-L8 的文档同步建议随代码一起提交，避免运维按旧文档理解 M1 行为。
