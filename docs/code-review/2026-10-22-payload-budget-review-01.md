# 代码审查报告：会话压缩「请求体体积」触发 + 图片前置压缩

- 审查时间：2026-10-22
- 仓库/分支：`/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`，`main`
- 审查对象：`git status --short` 中全部未提交改动（已修改 41 个文件 + 未跟踪 9 个文件）
- 审查方式：`git diff` 全量 + 逐文件阅读；`tsc` 构建；新增/相关单测；对估算器与图片压缩做了独立测量脚本（脚本只放在 `/tmp`，未改仓库代码）
- 设计依据：`docs/plan/2026-10-22-session-compaction-payload-budget-technical-design.md`

## 一、审查范围（文件清单）

**新增**
- `backend-ts/src/harness/core/request-size.ts` / `request-size.spec.ts`
- `backend-ts/src/harness/core/compaction-image-stripper.ts` / `compaction-image-stripper.spec.ts`
- `backend-ts/src/harness/core/compaction-config.spec.ts`
- `backend-ts/src/harness/llm/remote-image-cache.ts` / `remote-image-cache.spec.ts`
- `backend-ts/src/harness/tool/prompt-image-resizer.spec.ts`
- `backend-ts/db/migration/V167__llm_model_max_request_body_bytes.sql`

**修改（后端）**
- harness/core：`compaction-config.ts`、`compaction-service.ts`、`compaction-service.spec.ts`、`agent-loop.ts`、`agent-execution-context.ts`、`context-manager.ts`、`context-manifest.ts`、`harness-service.ts`、`prompt-engine.ts`、`session-compaction-orchestrator.ts`
- harness/tool：`prompt-image-resizer.ts`、`impl/read-file-tool.ts`、`impl/page-tools.ts`
- harness/llm：`openai-llm-adapter.ts`、`responses-llm-adapter.ts`、`anthropic-llm-adapter.ts`、`chat-request.ts`、`json.ts`
- 入站：`feishu/agent-inbound-handler.ts`、`weixin/agent-inbound-handler.ts`、`weixin/agent-inbound-handler.spec.ts`、`dingtalk/agent-inbound-handler.ts`
- 配置/模型：`settings/settings.service.ts`、`settings/types.ts`、`settings/settings.service.spec.ts`、`model/model.service.ts`、`model/model.routes.ts`、`model/types.ts`、`model/model.service.spec.ts`、`app-llm-engine.ts`、`harness/deps.ts`、`domain/types.ts`

**修改（前端/契约/文档）**
- `admin/src/views/settings/components/IntegrationConfigPanel.vue`、`admin/src/views/settings/SystemSettingsView.vue`、`admin/src/views/model/ModelFormDialog.vue`
- `desktop/src/types/chat.ts`、`desktop/src/components/task/TaskInspector.vue`
- `shared/contracts/src/model.ts`、`CHANGELOG.md`、`skills/mao-cli/reference/config.md`、设计文档

## 二、验证结果

| 验证项 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` | 通过（0 error） |
| 新增/相关单测（9 个文件） | 161 passed |
| `src/harness src/model src/settings src/weixin src/feishu src/dingtalk` 全量单测 | 199 files / 2428 tests passed |
| 估算器实测（JSON 密集文本） | 估算比真实 body 低 **35.08%** |
| 估算器实测（中文工具 schema） | 估算比真实 body 低 **34.44%** |
| `compressForStore` 编码开销实测（1600×1000 → JPEG q80） | 单次约 **70ms**；6 次尝试约 0.4s（未计 resize 分支） |

> 说明：未执行 admin/desktop 构建（避免生成产物），未连数据库验证迁移，未做真实上游 413/缓存命中验证。

## 三、问题清单

### 严重（阻塞上线的功能缺陷）

#### S1. 模型「请求体上限」根本没有落库：repository 的 insert/update 漏了新列

- 文件：`backend-ts/src/model/model.repository.ts:103-126`（insert）、`:128-150`（updateById）
- 证据：`db.insert('llm_model', { ... })` / `db.updateById('llm_model', id, { ... })` 的字段清单里**没有** `maxRequestBodyBytes`（`db` 层只按传入对象的 key 生成 SQL，见 `backend-ts/src/db/db.ts:40-58`）：

```ts
// model.repository.ts:103
async insert(model: LlmModel): Promise<number> {
  const id = await this.db.insert('llm_model', {
    name: model.name,
    ...
    contextWindowTokens: model.contextWindowTokens,
    // ← 没有 maxRequestBodyBytes
    priceInput: model.priceInput ?? null,
```

- 影响：
  1. 管理后台保存「请求体上限」后，接口返回的 VO 里能看到值（`createModel` 返回的是内存对象），**刷新页面/下次读取立即变回 null**；用户以为配置成功。
  2. `LlmModelConfig.maxRequestBodyBytes` 永远是 undefined，导致：
     - `CompactionConfig.resolveEffectiveTriggerBytes()` 的 `min(全局, 上限×0.8)` 永远退化为全局 40 MiB；
     - `CompactionService` 的「压缩请求超供应商上限则剥图」兜底**永远不会执行**（`compaction-service.ts:163-164` 的 `providerLimitBytes > 0` 恒 false）。
  3. 这两个能力正是本方案解决 413 的核心（设计 §5.1、§6.4），因此属于功能未交付。
- 修复建议：在 `insert()` 与 `updateById()` 的字段对象里补 `maxRequestBodyBytes: model.maxRequestBodyBytes ?? null`；并补一条断言 `modelRepo.insert`/`updateById` 入参包含该字段的单测（现有测试只断言返回值，见 L12）。

#### S2. 新增配置项缺少 `system_setting` 初始化行：后台「上下文压缩」整组无法保存

- 文件：`backend-ts/db/migration/V167__llm_model_max_request_body_bytes.sql:1-5`、`backend-ts/src/settings/settings.service.ts:95`、`admin/src/views/settings/components/IntegrationConfigPanel.vue:326,331`
- 证据：V167 只做了 `ALTER TABLE llm_model`，**没有** `INSERT IGNORE INTO system_setting`。而项目里每个新增配置键都有对应迁移（如 `V097__settings_harness_tuning.sql:15-19` 为 `harness.compaction.*` 建行）；`SystemSettingService` 没有任何「缺行自动补」逻辑：

```ts
// settings.service.ts:249-256（updateBatch）
const setting = await this.settingRepo.findByKey(item.key);
if (!setting) {
  throw new BusinessException(ErrorCode.PARAM_INVALID, `系统配置不存在: ${item.key}`);
}
```

- 影响：
  1. 后台「系统设置 → 集成配置 → 上下文压缩」点击保存时，`saveGroup()` 会把这组的 6 个 key 一起提交（`IntegrationConfigPanel.vue:453-462`），其中新 key 不存在 → 整个组保存失败，**连 `enabled` / `triggerRatio` / `maxSummaryTokens` / `loopMidwayCompact` 都改不了**。
  2. 设计要求的「`triggerPayloadBytes=0` 可关闭体积触发」在 UI 上无法设置（只能改 DB）。
  3. 新配置项在后台显示为空白且保存报错，属于上线即坏的可见回归。
- 修复建议：在 V167（若尚未在任何环境应用）或新增 `V168__settings_compaction_payload_threshold.sql` 中加入：

```sql
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('harness.compaction.triggerPayloadBytes', NULL, '运行参数', '请求体体积触发阈值（字节，0=关闭，重启后端后生效，默认 40MiB）', 1);
```

并补一条集成/迁移级检查（至少人工在测试环境验证该组可保存）。

### 中等（明确的功能/性能/正确性风险）

#### M1. 未配置供应商上限时，压缩请求的剥图兜底完全失效（存量 50MB 会话仍会 413）

- 文件：`backend-ts/src/harness/core/compaction-service.ts:161-175`
- 证据：

```ts
const providerLimitBytes = modelConfig.maxRequestBodyBytes ?? 0;
if (providerLimitBytes > 0) {          // ← 未配置上限时整段跳过
  const compactionBytes = this.requestSizeEstimator.estimate(compactionRequest, modelConfig.modelId);
  if (compactionBytes >= providerLimitBytes - COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES) { ...strip... }
}
```

- 影响：设计 §11 声称「存量会话（如 1396 的 47.6MB 图片）下次请求 ≥ 阈值 → 触发一次压缩 → 窗口重置后回落」。但存量会话的**第一次** `normalRequest` 本身就是 50MB：压缩请求 = 50MB + 指令，而默认所有模型 `maxRequestBodyBytes = NULL`（叠加 S1/S2，管理员暂时也无法配置），兜底不生效 → 压缩请求 413 → 主请求继续 413，会话仍然卡死。单轮体积突增（一次工具返回 >10MB）同样绕过兜底。
- 修复建议：在未声明上限时使用一个保守的兜底上限（例如 `globalTriggerBytes / 0.8`，对应 50 MiB），或对「压缩请求估算 > 全局触发阈值 × 1.1」直接剥图并 warn；至少要在发布说明里要求先把 50MB 通道模型的 `maxRequestBodyBytes` 配好（并先修 S1/S2）。

#### M2. 请求体估算把「远程 URL 图片」按 URL 长度计，而适配器发送时会展开成 data URI

- 文件：`backend-ts/src/harness/core/request-size.ts:33-37,100-113`、`backend-ts/src/harness/llm/openai-llm-adapter.ts:480-491,539-551`（responses/anthropic 同）
- 证据：估算器只计 `url.length`：

```ts
function urlBytes(url: string | null | undefined): number {
  return url.length;          // https://.../uploads/x.png ≈ 60B
}
```

而适配器在发送前把 URL 下载并替换为 data URI（现在经 LRU 压缩后单张仍可达 300KB）：

```ts
// openai-llm-adapter.ts:539
const base64Uri = url.startsWith('data:') ? await this.resizeDataUri(url) : await this.downloadAndEncode(url);
if (base64Uri) setImageUrl(part, base64Uri);
```

- 影响：桌面/Web 上传的图片（`desktop/src/composables/useChat.ts:341` → 服务端 `session.service.ts:1606` 存的是 URL）在估算里几乎为 0，但真实 body 每张可达 300KB（压缩失败时更大）。举例：一次会话 150 张上传截图 ≈ 45MB 实际 body，估算只有 ~10KB → 体积触发不触发；压缩请求的 `providerLimit` 兜底也按 URL 估算 → **仍然会发出 40MB+ 的压缩请求导致 413**。这直接破坏「估算口径 = 最终请求体」和「压缩请求必然 < 上限」两个设计前提。
- 修复建议（二选一）：
  1. 在 `PromptEngine.buildRequest` 阶段就把可解析的 URL 图片替换为 `remoteImageCache` 的 data URI（缓存命中时无网络/编码成本，且天然前缀稳定），估算即准确；
  2. 若坚持发送期展开，则给 `RequestSizeEstimator` 传入「URL → 已缓存字节数」的解析器，或用 `HEAD/Content-Length` + 压缩目标上界估算（最坏 300KB/张）。
  并补一条「URL 图片 100 张」的估算/触发测试。

#### M3. `payloadCompactionDone` 在压缩实际未发生时也会置位，导致后续轮次不再尝试

- 文件：`backend-ts/src/harness/core/agent-loop.ts:545-551`
- 证据：

```ts
await this.sessionCompactionOrchestrator.compact(...);
if (trigger === 'payload' || trigger === 'both') context.payloadCompactionDone = true;
```

`SessionCompactionOrchestrator.compact()` 在 `history.persistedMessages.length === 0`、`contextManager.compactSession()` 返回 `null`（如摘要未通过语义校验）、CAS 未推进时都会**正常返回 false**（`session-compaction-orchestrator.ts:62,79,127-130`），并不会抛异常。
- 影响：一次失败的 payload 压缩会把「本次执行只做一次」的名额用掉；请求体积仍在阈值之上，后续工具轮不再尝试，最终仍可能 413。另外压缩失败后 `context.preparedRequest` 被重建为同样的超大请求（`agent-loop.ts:550`）。
- 修复建议：只在 `compact()` 返回 true 时置位；返回 false 时保留重试机会（或至少不要在同一轮立刻重试，可延后一轮）。补一条「compact 返回 false 后下一轮仍会评估 payload」的单测。

#### M4. `loopMidwayCompact=false` 不再跳过每轮 `buildRequest` / 快照落库 / `context_window` 事件

- 文件：`backend-ts/src/harness/core/agent-loop.ts:521-532`
- 证据：`midLoopAllowed` 去掉了 `loopConfig.loopMidwayCompact`（原条件包含它），但块内的 `persistContextSnapshot()`（DB 写）和 `listener.onContextWindow?.(...)`（WS 事件）没有跟着拆开：

```ts
const midLoopAllowed = loopConfig != null && loopConfig.enabled && persistenceCallback != null && context.sessionId != null;
...
const nextRequest = await this.promptEngine.buildRequest(context);   // 每轮完整重建请求
this.persistContextSnapshot(context, nextRequestTokens);             // 每轮 DB 写
listener.onContextWindow?.(nextRequestTokens, ...);                  // 每轮 WS 事件
```

- 影响：管理员显式关闭「循环中途压缩」这一性能/频率开关后，每个工具轮仍会做一次完整 `buildRequest`（快捷命令展开可能查 DB、历史归一化、manifest、工具 schema 序列化、前缀指纹计算）+ 一次 `session.update_context_tokens` 写库 + 一次 `context_window` 推送。设计 §5.5 说「体积检查在每个工具轮边界无条件执行（成本仅一次估算）」，与实现不符；对多工具轮会话是明显回归。
- 修复建议：把 payload 检查与 token 检查拆开。`loopMidwayCompact===false` 时只做 `estimate`（可复用上次 build 的请求或轻量估算），不要 `persistContextSnapshot` 和 `onContextWindow`；或至少把这两行移回 `loopMidwayCompact===true` 分支。

#### M5. EXIF 旋转处理不一致：压缩后尺寸可能被过度缩小，且上报的 width/height 与实际不符

- 文件：`backend-ts/src/harness/tool/prompt-image-resizer.ts:253-256`（`encodeStore` 有 `.rotate()`） vs `:78-117`（`resizeForPrompt` 无 `.rotate()`），目标尺寸取自原始 `metadata()`（`:162-164`）
- 说明：`meta.width/height` 是未应用 EXIF 的原始像素尺寸；`encodeStore` 先 `.rotate()` 摆正（宽高互换），再用「按未旋转尺寸算出的 target」做 `fit:'inside'`。例如 4000×3000、orientation=6 的手机照片：
  - `target = 2048×1536`；
  - rotate 后实际是 3000×4000，`fit:'inside'` 到 2048×1536 → 实际输出约 1152×1536；
  - 返回给工具的 `width/height` 仍是 2048×1536（`PromptImageResult(..., attempt.width, attempt.height)`），模型拿到的尺寸信息错误；
  - 同一张图走「≤500KB 原样/仅 resize」分支时是未旋转的横图，走「>500KB 压缩」分支时是竖图，行为不一致。
- 影响：带 EXIF 方向的大照片被多缩了一档（文字/细节损失），且 `read_file`/`page_screenshot` 返回的 `width/height` 与真实输出不一致。
- 修复建议：统一在某一个入口调用 `.rotate()`（推荐 `metadata({ autoOrient: true })` 或先 `sharp(input).rotate().toBuffer()` 再取尺寸），用旋转后的宽高计算 target；并用 `encodeStore` 返回的真实 `info.width/height` 填充结果。

#### M6. MB/MiB 单位混用 + 管理后台精度不一致，供应商上限的边界判断偏大

- 文件：`admin/src/views/model/ModelFormDialog.vue:55-65,320-322,354-360`、`backend-ts/src/model/model.service.ts:60-79`、`backend-ts/src/harness/core/compaction-service.ts:163-166`
- 证据：
  - 后台标签写「MB」，提交时 `Math.round(maxRequestBodyMb * 1024 * 1024)`，落库是 **MiB**；
  - 事故中的真实上游边界是 **50,000,000 字节（50 MB 十进制）**，管理员按提示填 `50` 会存成 `52,428,800` 字节；
  - 兜底判断用的是这个偏大的值：`compactionBytes >= providerLimitBytes - 64KB` = `52,363,264`，因此 50.0–52.3MB 的压缩请求不会被剥图，直接 413；
  - 另外 `el-input-number :precision="0"` 会把回填的 47.68 显示成 48，用户一交互就可能把值改成 50,331,648（而非 50,000,000）。
- 影响：设计 §5.1 的「相对真实上限留 16% 余量」只在触发阈值上成立，**兜底阈值被放大 4.86%**；对「阈值配置错误」这一兜底场景的保护变弱。
- 修复建议：明确单位并在 UI/后端统一（推荐存字节、UI 标注 MiB；若想按十进制 MB，则 `×1_000_000`）；`precision` 至少允许 2 位或改用字节输入；文档/提示写清「50MB 通道请填 47.68」或改成直接填字节。

### 轻微（可维护性/边界/测试有效性）

#### L1. 工具 schema 用 `JSON.stringify(...).length` 计字符而非 UTF-8 字节
- 文件：`backend-ts/src/harness/core/request-size.ts:128`
- 实测：包含中文 property description 的 schema，估算比真实 body 低 34.44%。大 payload 下影响被 1.02 系数与 base64 摊薄，但口径与文档「字节」不一致。
- 建议：改为 `Buffer.byteLength(JSON.stringify(...), 'utf8')`。

#### L2. `SAFETY_FACTOR = 1.02` 覆盖不了 JSON 转义膨胀
- 文件：`backend-ts/src/harness/core/request-size.ts:26,58-65`
- 实测：引号/反斜杠密集的工具输出（JSON 被当字符串回放，`"` 会再转义一次），估算比真实 body 低 **35.08%**。目标场景（base64 占 90%）误差接近 0，因此不阻塞；但「压缩请求必然 < 上限」的保证在纯文本/JSON 密集会话里不成立。
- 建议：在估算值接近阈值（如 ≥80%）时用 `serializeChatRequest` 真算一次（一次 40MB 序列化的开销只在临界轮次发生），或把安全系数改为按「文本占比」动态计算。

#### L3. `compressForStore` 实际最多 7 次编码，与注释/设计的「≤6 次」不符
- 文件：`backend-ts/src/harness/tool/prompt-image-resizer.ts:134-140`（注释写「最多 5 次」）、`:170`（先 `resizeForPrompt` 一次）、`:178`（最多 6 次 attempt）
- 影响：仅是成本估算偏差；单次 1600×1000 JPEG q80 编码实测约 70ms，6 次尝试约 0.4s（测试环境），复杂图「压不到 300KB」时会明显拖慢工具调用；一次 1200×1200 噪声图用例在 vitest 中耗时 2.6s（含生成噪声 PNG）。
- 建议：统一注释与设计口径（≤6 或 ≤7），并考虑在第一次未达标时直接跳到 0.85 缩尺寸（质量档位收益通常不如缩尺寸）。

#### L4. `read_file` / `page_screenshot` 没有「压缩后未变小则保留原图」的保护
- 文件：`backend-ts/src/harness/tool/impl/read-file-tool.ts:110-118`、`backend-ts/src/harness/tool/impl/page-tools.ts:146,170-172`
- `compressDataUriForStore` 有 `result.bytes.length >= input.length` 的保护（`prompt-image-resizer.ts:227`），但这两个写入侧入口直接使用 `compressForStore` 的返回值；而 `compressForStore` 在 6 次尝试都超目标时返回「最小 attempt」，并不保证小于输入。
- 影响：极端图片可能被「压大」；不影响正确性，但与「只压 >500KB、压到更小」的意图不一致。
- 建议：在这两处（或 `compressForStore` 内部）加 `if (result.bytes.length >= input.length) return 原图`。

#### L5. 动图（GIF/动画 WebP）>500KB 会被静默压成单帧
- 文件：`backend-ts/src/harness/tool/prompt-image-resizer.ts:175-181,253-262`
- `sharp(input)` 默认只取第一帧，`webp/jpeg` 输出单帧。IM 入站与 read_file 的大动图会丢动画（视觉模型通常也只取首帧，影响有限，但应确认可接受并写进文档）。
- 建议：`metadata().pages > 1` 时跳过有损压缩（保留原 data URI）或显式记录 `warn`。

#### L6. 远程图片缓存把 404/410 也当「校验失败，复用旧值」并续期 TTL
- 文件：`backend-ts/src/harness/llm/remote-image-cache.ts:129-136`
- 任意错误（含 `HTTP 404`）都会 `put(stale...)` 把 `storedAt` 刷新为 now，于是同一 URL 被删除/替换后，进程内会**一直**返回旧图（每小时重试一次 404），直到重启。
- 建议：404/410 视为「内容已删除」，丢弃缓存条目；只在 5xx/网络错误时回退旧值。

#### L7. 远程图片下载没有超时/中断，挂起的 inflight 不会释放
- 文件：`backend-ts/src/harness/llm/remote-image-cache.ts:96-98`
- `fetch(imageUrl)` 没有 `AbortSignal.timeout`；若上游 hang 住，`inflight` 里的 Promise 永不 settle，该 URL 的后续请求全部挂起（也占住 LLM 调用）。改造前也有 hang 风险，但改造前没有常驻的 in-flight 映射。
- 建议：加 10–30s 超时（`AbortSignal.timeout`），失败按「无缓存」路径抛错由适配器回退原始 URL。

#### L8. 工具定义的 WeakMap 缓存实际永远 miss
- 文件：`backend-ts/src/harness/core/request-size.ts:116-135`、`backend-ts/src/harness/core/prompt-engine.ts:640-649`
- `buildToolDefinitions()` 每次 `buildRequest` 都 `.map()` 出新数组，`WeakMap` 按数组引用缓存因此每轮都 miss，`JSON.stringify(所有工具 parameters)` 仍会每轮执行。48 张图/40MB 场景影响可忽略，但与注释「一次执行内按引用缓存」不符。
- 建议：把工具定义缓存挂到 `context`（`context.tools` 不变即可复用），或按工具名+描述指纹缓存。

#### L9. 压缩被禁用时 manifest 仍展示「触发上限」
- 文件：`backend-ts/src/harness/core/prompt-engine.ts:495-498`
- `resolveEffectiveTriggerBytes` 不检查 `compaction.enabled`，`enabled=false` 时桌面仍显示「触发上限 40 MB」，与「已关闭自动压缩」矛盾。
- 建议：`enabled===false` 时返回 0 或不下发 `payloadLimitBytes`。

#### L10. request_start 的 payload 压缩没有设置 `payloadCompactionDone`
- 文件：`backend-ts/src/harness/core/harness-service.ts:508-512`
- 设计 §5.4 要求「同一执行内体积压缩只做一次」，但 request_start 压缩后标志仍为 false，同一次执行内 mid-loop 还可能再压一次（多一次 LLM 摘要调用）。
- 建议：`compact()` 返回 true 且触发原因是 payload 时，在 `harness-service` 也置位；或让编排器统一维护该标志。

#### L11. IM 入站多图串行压缩，且微信侧存在「resize 一次 + 压缩一次」的重复解码
- 文件：`backend-ts/src/feishu/agent-inbound-handler.ts:896-903`、`backend-ts/src/dingtalk/agent-inbound-handler.ts:645-652`、`backend-ts/src/weixin/agent-inbound-handler.ts:436-441`、`backend-ts/src/weixin/media.service.ts:78-88`
- 每张图 `await` 串行；微信 `media.service` 已 `tryResizeForPrompt` 生成 data URI，handler 再 `compressDataUriForStore` 重新解码；多张 2MP 图最坏每张 6 次编码，会推迟消息入库与回复。
- 建议：微信在 `media.service` 生成 data URI 时直接 `compressForStore`（避免二次解码）；多图可 `Promise.all` 并发（sharp 有线程池）。

#### L12. 新增测试覆盖不足，且部分断言无法捕获本次的严重缺陷
- `backend-ts/src/model/model.service.spec.ts:141-151`：只断言 `created.maxRequestBodyBytes`（内存对象），没有断言 `modelRepo.insert` 的入参 —— 因此 S1（不落库）测试全绿。
- `backend-ts/src/harness/core/compaction-service.spec.ts:352-387`：剥图测试把供应商上限设为 1000 字节，而安全余量是 64KB，`limit - 64KB` 恒为负 → 任何体积都会剥图，无法验证真正的边界（也无法发现 margin 写错/单位错）。
- 没有任何测试覆盖：`harness-service`/`agent-loop` 把 `lastRequestBytes` 传入 `compact`、`payloadCompactionDone` 的重试语义、`loopMidwayCompact=false` 时不做快照/事件、URL 图片的估算。
- `request-size.spec.ts` 只测了一个「图片 + 少量工具」的 5% 误差场景，缺少 URL 图片、中文工具 schema、JSON 转义密集三类（即实测误差 34%–35% 的场景）。
- `model.service.spec.ts` 现有的 `createModel`/`updateModel` 调用没有补第 17/18 个参数，`tsc -p tsconfig.json` 会报 `Expected 17/18 arguments`（`tsconfig.build.json` 排除了 spec，所以 CI 构建不报）。建议打开 spec 的类型检查或补齐调用。
- 建议：至少补 S1 的 repository 断言、M2 的 URL 图片估算用例、M3/M4 的 agent-loop 用例。

#### L13. 入站/工具路径的压缩失败日志会污染测试输出
- `compressDataUriForStore` 对 `data:image/jpeg;base64,AAA` 这类假数据会走 sharp 解码并打 `warn`；feishu/weixin 单测因此出现多条 `Prompt image store-compress failed` 日志。功能无影响，但会掩盖真实告警。
- 建议：入站压缩前先看 `input.length`（例如 < 1KB 直接返回），或把 warn 降为 debug。

## 四、待确认（不影响本次结论，但建议评审时明确）

1. **压缩模型与主模型不一致时的上限/缓存口径**：`resolveEffectiveTriggerBytes(sessionModelConfig)` 用会话模型，`providerLimitBytes` 用压缩模型（`compaction-service.ts:133,163`）。设计 §6.3 要求 `compaction.modelId` 留空或与会话模型一致，但后台没有任何提示/校验；若配成另一个模型且未填上限，压缩请求可能 413 且不吃前缀缓存。建议在后台加提示或在 `CompactionModelResolver` 命中不同模型时 warn。
2. **Agent 级 `configJson.compaction.triggerRatio=0`**：`resolveCompactionConfig` 不做范围校验（`harness-service.ts:679-684`），配合 `loopMidwayCompact=false` 时 `tokens: 0 >= floor(window*0)` 恒成立 → 每个工具轮都会触发 token 压缩。系统设置侧校验了 `ratio > 0`，但 agent 级没有。
3. **微信「落盘原图不动」与现状不符**：`weixin/media.service.ts:78-88` 写盘的是 resize 后的副本（既有行为），设计 §7.7 的「落盘原图不动、Agent 仍可读原图」对微信通道不成立；本次改动只是在此基础上再加一次压缩。
4. **远程图片缓存的跨用户/鉴权风险**：缓存键是 URL、`fetch` 不带 Cookie/Authorization。若某 URL 的内容随请求者身份变化（或需要鉴权才能看到），进程内 LRU 会把第一个用户的内容给后续引用同一 URL 的用户。当前 URL 主要来自用户自己的上传/消息，风险低，但建议确认 URL 的不可变性假设。

## 五、结论

- **不建议直接上线**：S1、S2 都是「功能未交付/后台回归」级别的缺陷，且会互相掩盖（S1 让上限配置无效，S2 让管理员无法配置阈值/关闭开关），必须修复后再上。
- S1/S2 修复后，M1（未配上限时兜底失效）仍会让 1396 这类存量 50MB 会话的第一次压缩 413，建议与发布说明/运维动作一起处理。
- M2 是估算口径与真实请求体不一致的核心缺口（URL 图片），建议至少加测试与文档标注；若短期不改代码，请在上线说明中明确「上传图较多的会话仍可能 413」。
- 其余 M/L 项可按优先级排期，不阻塞本次主功能。
