# 会话压缩历史消息归档（Compaction Archive）技术方案

## 1. 文档信息

- 状态：已确认方案
- 日期：2026-09-03
- 适用范围：Mao 后端会话上下文压缩链路（仅 CLOUD 模式）
- 目标版本：实施时写入项目 `CHANGELOG.md` 顶部当前版本
- 核心代码：`backend-ts/src/harness/core/`、`backend-ts/src/harness/runtime/`、`backend-ts/src/create-app.ts`

## 2. 需求背景

当前会话压缩采用「全量上下文交接」机制（见 `docs/plan/session-handoff-compaction-technical-design.md`）：请求开始（`harness-service.ts`）与 Agent Loop 每轮结束（`agent-loop.ts:403-425`）两条触发路径，最终都汇聚到 `SessionCompactionOrchestrator.compact()`，由 `CompactionService` 让主模型生成 `<handoff>` 交接摘要，CAS 写入 `session_compaction` 表，随后把摘要作为首条 user 消息注入上下文。

该机制存在一个结构性问题：

1. **有损压缩必然丢信息**：交接摘要受 `maxSummaryTokens`（默认 12000）约束，长会话中的文件路径、命令输出、错误信息、用户原话等细节不可能全部保留。
2. **丢失后无法回读**：被压缩的消息仍完整保留在 `message` 表中，但压缩后上下文不再携带它们，Agent 手里没有任何工具能触达这些内容——信息一旦被摘要丢弃，等于永久丢失。
3. **Agent 只能靠记忆猜**：交接摘要要求「保留关键事实」，但接续执行的 Agent 在需要细节时只能凭摘要复述，无法验证，容易臆造。

本方案在压缩发生时，将被压缩的原始消息以 JSONL 文件形式归档到当前会话的 runtime 目录，并把归档路径确定性注入交接消息，使 Agent 可随时通过现有 `read_file` / `grep_search` / `shell` 工具回读原始细节。

## 3. 需求描述

### 3.1 目标

1. 每次压缩成功推进边界后，将本次被压缩区间 `(上一边界, 新边界]` 的全部消息全字段写入会话 runtime 目录下的 JSONL 增量文件。
2. 交接消息中由**代码确定性**附带归档目录路径与回查指引（非 LLM 生成），提示 Agent 在需要细节时检索归档。
3. 覆盖两条压缩触发路径（新消息触发 + Loop 中途触发），Agent 无需感知差异。

### 3.2 已确认决策汇总

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 文件组织 | **每次压缩一个增量文件**，目录 `runtime/<uid>/<sid>/compaction/` |
| 2 | 命名与写入时机 | 文件名 `compaction-NNN.jsonl`（NNN = DB `compact_count`，零填充 3 位）；**CAS 持久化成功且边界确认推进后**写入；CAS 冲突/压缩失败不产生文件 |
| 3 | 路径注入方式 | **动态注入**：`summaryText` 保持纯 LLM 产物存库，注入发生在构建交接消息时（`prependSessionSummary` 链路），由代码实时拼接 |
| 4 | 行内容保真度 | **全字段 dump**（id/role/content/toolCallId/toolCalls/thinkingContent/metadata/tokenCount/modelId/createdAt）；content 与 metadata 中的图片 base64 data URI 替换为占位符，保留附件磁盘路径 |
| 5 | 执行模式范围 | **仅 CLOUD 启用**：LOCAL 会话不写文件、不注入指引（LOCAL 下工具在用户桌面执行，服务端 runtime 路径不可达，注入会误导 Agent） |
| 6 | 压缩指令 | 在 `buildHandoffInstruction` 末尾**微调一句说明**：告知系统会自动附加归档目录，正文无需提及归档机制、不得编造归档路径 |
| 7 | 范围边界 | UI/admin 展示、DB schema 变更、归档定期清理、加密脱敏、专用回读工具、存量会话补录——**全部不做**（详见第 8 节） |

### 3.3 明确不做（边界）

见第 8 节「明确不做清单」。

## 4. 技术方案设计

### 4.1 现有基础设施的复用（零额外建设）

本方案不新建任何基础设施，全部复用现有机制：

| 能力 | 现有实现 | 本方案如何利用 |
|------|----------|----------------|
| Agent 工具可达 runtime 目录 | `create-app.ts:434-435` 将 `runtimeDir` 整体加入 `PathSandbox` 白名单（read_file/grep/glob/shell 均可访问） | 归档文件放在 `<runtimeRoot>/<uid>/<sid>/compaction/` 下，天然在沙箱白名单内，**无需任何权限改造** |
| 生命周期管理 | 会话删除时整体清理该会话 runtime 目录（`create-app.ts:1688` 的 cleanRuntimeDir 回调） | 归档随会话删除自动消失，**无需新增清理逻辑** |
| 路径解析 | `RuntimeDataResolver`（`harness/runtime/runtime-data-resolver.ts`）已提供 `resolveSessionRuntimeDir` 等系列方法 | 新增 `resolveCompactionDir(userId, sessionId)`，风格与现有方法一致 |
| 触发收敛 | 两条触发路径（请求开始 / mid-loop）都调用 `SessionCompactionOrchestrator.compact()` | 只在 Orchestrator 一处写入归档，两条路径同时覆盖 |
| 回读工具 | 现有 `read_file`（支持 offset/limit 分页）、`grep_search`（可直接搜目录）、`shell` | Agent 回查完全复用现有工具，**不新建专用工具** |

### 4.2 总体流程（时序）

在现有 `SessionCompactionOrchestrator.compact()` 流程中插入一步（位置：`persist()` 成功 → `loadValidated()` 重读 → `advanced` 判定为 true 之后、`record()` 压缩事件之前）：

```
LLM 生成 handoff 摘要（现有，不变）
  ↓
persist() CAS 写 session_compaction 表（现有，不变）
  ↓
loadValidated() 重读最新记录（现有，不变）
  ↓
advanced == true（本线程成功推进边界）？
  ├─ 否（CAS 冲突/他人推进）→ 不写归档文件（责任在成功推进的那个线程）（现有逻辑不变）
  └─ 是 → 【新增】写归档文件 compaction-<compactCount>.jsonl
            （仅 CLOUD；数据源 = 本线程压缩开始时已加载的 normalizedEntities
              过滤 id ∈ (oldBoundary, newLastCompactedMessageId]）
        ↓
record() 压缩事件 + onCompactionEnd / onCompactionPersisted（现有，不变）
```

归档写入失败（磁盘错误等）仅 `harnessLog('warn', ...)`，**不阻断压缩成功流程**——压缩记录已在 DB 落盘，归档缺失只损失回读能力，不损失会话状态。

### 4.3 归档文件规格

- **目录**：`{MAO_RUNTIME_DIR|默认 /opt/mao-data/runtime}/<userId>/<sessionId>/compaction/`
- **文件名**：`compaction-NNN.jsonl`，NNN 取压缩成功后 DB 记录的 `compact_count` 值（即本次压缩的累计序号），零填充 3 位（`String(seq).padStart(3, '0')`，超过 999 自然增长为 4 位）。
  - 首次压缩（insert，`compact_count=1`）→ `compaction-001.jsonl`；
  - 后续压缩（CAS update，`compact_count` 自增）→ `compaction-002.jsonl`、`compaction-003.jsonl`…
  - 序号与 DB 记录严格一致：CAS 失败的压缩不产生文件，文件名升序即压缩时间顺序。
- **行内容**：每行一个 JSON 对象（UTF-8，行尾 `\n`），字段取自 `session/types.ts` 的 `Message` 实体，**dump 字段全集**：

| 字段 | 来源 | 说明 |
|------|------|------|
| `id` | `message.id` | 行定位 / 边界区间核对 |
| `role` | `message.role` | USER / ASSISTANT / SYSTEM / TOOL |
| `content` | `message.content` | 消息内容（含占位符替换，见 4.4） |
| `toolCallId` | `message.toolCallId` | TOOL 消息的关联调用 ID |
| `toolCalls` | `message.toolCalls` | 原始 JSON 字符串（assistant 工具调用列表） |
| `thinkingContent` | `message.thinkingContent` | 推理过程原文 |
| `metadata` | `message.metadata` | 原始 JSON 字符串（含占位符替换，见 4.4） |
| `tokenCount` | `message.tokenCount` | 消息 token 数 |
| `modelId` | `message.modelId` | 使用的模型 |
| `createdAt` | `message.createdAt` | 消息时间（行排序依据，与 `id` 升序一致） |

不 dump 的字段：`sessionId`（目录已表达）、`deleted`、`updatedAt`、`sourceSessionId`（无回读价值）。

- **数据源**：`SessionHistoryLoader.loadHistoryAfterBoundary()` 返回的 `history.normalizedEntities`（完整 `Message[]` 字段，`MessageHistoryNormalizer` 原样保留实体字段仅重排顺序），按 `id > oldBoundary && id <= newLastCompactedMessageId` 过滤。这是**压缩时点的内存快照**，不从 DB 二次读取，避免与压缩期间的并发编辑/删除竞争，归档语义即「压缩发生时所见的消息」。
- **原子写入**：先写同目录临时文件（`compaction-NNN.jsonl.tmp`），`writeFileSync` 全量写完后 `renameSync` 原子替换。保证 Agent 并发读时要么看不到文件、要么看到完整文件，永不读到半截 JSONL。

### 4.4 图片 data URI 占位符替换

`content` 与 `metadata` 中的内联 base64 图片（`data:image/png;base64,...`，单条可达 1-2MB）必须替换为短占位符，否则归档文件体积失控、不可 grep、Agent 误整读时会二次撑爆上下文。

替换规则（仅 CLOUD 会话写文件时执行，纯同步字符串操作）：

1. **content 字段**（字符串或多模态 JSON 数组字符串，均按原文正则处理）：
   - 正则：`/data:(image\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+/g`
   - 替换为：`[image data URI omitted: <mime>]`（如 `[image data URI omitted: image/png]`）
2. **metadata 字段**：
   - `JSON.parse` 成功且 `attachments` 为数组时：对每个 attachment，若 `data_uri` 匹配 image data URI 则替换为同一占位符，**保留 `mime` 与 `path` 字段**（Agent 可凭 `path` 用 read_file 重读原图原件），然后重新 `JSON.stringify`；
   - `JSON.parse` 失败：退回与 content 相同的正则替换。
3. 非 image 的 data URI（如 `data:application/...`）与 http URL（`/uploads/...`）**原样保留**：URL 本身短且是可达信息源。
4. 替换不设阈值，**所有 image base64 data URI 一律替换**：base64 对 grep 检索无意义，回读价值由 `metadata.path` 承载。

### 4.5 归档指引注入（动态拼接）

**注入位置**：`CompactionService.buildHandoffUserMessage()` 构造交接消息处——现有链路 `SessionHistoryLoader.applyHistory()` → `ContextManager.prependSessionSummary()` → `CompactionService.prependSessionSummary()` → `buildHandoffUserMessage()`。`prependSessionSummary` / `buildHandoffUserMessage` 增加可选参数 `archiveHint?: string | null`，由调用方传入，非空时拼接到交接正文之后。

`summaryText` 存库内容**保持纯 LLM 产物不变**；`session_compaction` 表、DB schema 零改动。

**注入条件**（在 `SessionHistoryLoader.applyHistory()` 内判断，注入新依赖 `CompactionArchiveService`）：

1. `context.executionMode` 非 LOCAL（即 CLOUD，含安卓壳）；
2. `context.userId` 与 `context.sessionId` 均非空；
3. 归档目录存在且至少含一个 `*.jsonl` 文件（防止存量会话无归档时指引 Agent 读空目录）。

三个条件任一不满足则不注入，交接消息与现状完全一致。

**注入文案**（代码常量，路径部分按当前会话实时解析，附于交接正文末尾）：

```text
## 已压缩历史消息归档

此前被压缩的全部会话消息已按压缩批次归档为 JSONL 文件，目录：`<归档目录绝对路径>`。
- 文件命名：compaction-NNN.jsonl（NNN 为压缩序号，升序即时间顺序）；每个文件包含该次压缩区间内的全部原始消息。
- 每行一个 JSON 对象，字段：id、role、content、toolCallId、toolCalls、thinkingContent、metadata、tokenCount、modelId、createdAt；内联图片 base64 已替换为占位符，原图路径见 metadata 内 attachments 的 path 字段。

当本交接内容缺少你需要的细节（历史用户原话、文件路径、命令输出、错误信息、已确认决策依据等）时，用 read_file（支持 offset/limit 分页）、grep_search 或 shell 工具检索上述目录回读原始消息，不要凭摘要猜测或臆造细节。
```

注入块的 token 开销约 120 tokens（相对 `maxSummaryTokens=12000` 的摘要可忽略），仅在会话已发生压缩后随交接消息常驻上下文。

**动态注入而非写库的原因**（决策 3）：滚动压缩时旧摘要（含注入块）会作为下次压缩输入，若路径块存库会被 LLM 复读、改写或丢失；动态注入保证路径永远按当前 runtime 实时解析、文案升级对历史会话即时生效。

### 4.6 压缩指令微调（决策 6）

`CompactionService.buildHandoffInstruction()` 现有指令末尾追加一句：

```text
系统会在交接消息后自动附上被压缩原始消息的归档目录说明；交接正文无需提及归档机制，也不要编造归档路径；仍需完整保留继续执行任务所需的关键事实。
```

目的：LLM 知道归档存在，既不为「保险」过度堆砌细节（归档已兜底），也不在正文里自创「历史已存档于 xxx」之类的虚假路径。其余指令（保留要求、`maxSummaryTokens` 限制、`<handoff>` 格式契约）**零改动**。

### 4.7 执行模式范围（决策 5）

| 模式 | 写归档文件 | 注入指引 | 理由 |
|------|-----------|---------|------|
| CLOUD（含安卓壳远程加载） | 是 | 是 | 工具在服务端执行，runtime 路径可达 |
| LOCAL | 否 | 否 | 工具委托给用户桌面客户端执行，服务端 runtime 路径对 Agent 不可达；注入会指引 Agent 读取桌面端不存在的路径，浪费轮次甚至产生错误行为。与现有 `incomingFileHint`（prompt-engine.ts，LOCAL 返回空）的处理先例一致 |

判定方式：`context.executionMode?.toUpperCase() !== 'LOCAL'`（与代码库现有判定风格统一）。LOCAL 会话压缩行为与现状完全一致，不产生任何文件。

### 4.8 失败语义

| 失败场景 | 行为 |
|---------|------|
| 归档目录创建失败 / 临时文件写入失败 / rename 失败 | `harnessLog('warn', ...)` 后继续，压缩主流程（DB 记录、上下文重建、事件记录）不受影响 |
| CAS 冲突（`persist()` 返回 false 或 `advanced == false`） | 不写归档文件；写文件责任归属成功推进边界的那个线程 |
| 归档目录为空 / 不存在（存量会话、写失败遗留） | 注入条件 3 拦截，不注入指引，Agent 上下文与现状一致 |
| 压缩整体失败 / 取消 | 现有行为不变，无归档文件产生 |

## 5. 实现步骤（逐文件改动清单）

以下为实施顺序，均为 backend-ts 内改动，其余端零改动。

### 步骤 1：`harness/runtime/runtime-data-resolver.ts`

新增方法（与现有 `resolveSkillsDir` 等风格一致）：

```ts
resolveCompactionDir(userId: number, sessionId: number): string {
  return path.join(this.resolveSessionRuntimeDir(userId, sessionId), 'compaction');
}
```

### 步骤 2：新建 `harness/core/compaction-archive.service.ts`

新组件 `CompactionArchiveService`，构造函数注入 `RuntimeDataResolver`：

- `resolveDir(userId, sessionId): string` — 委托 resolver；
- `writeArchive(executionMode, userId, sessionId, seq, messages: Message[]): void` —
  1. `executionMode` 为 LOCAL 时直接 return；
  2. mkdir recursive 归档目录；
  3. 对每条消息执行 4.4 占位符替换后 `JSON.stringify`（每字段独立 `?? null` 归一，避免 undefined 丢失字段位置）；
  4. 逐行拼接（行尾 `\n`）→ 临时文件 `compaction-NNN.jsonl.tmp` → `writeFileSync` → `renameSync` 原子替换；整个写过程 try/catch，失败仅 `harnessLog('warn', ...)`；
- `listArchiveFiles(userId, sessionId): string[]` — 目录内 `*.jsonl`（含 `compaction-` 前缀过滤），不存在返回 `[]`；
- `buildArchiveHint(executionMode, userId, sessionId): string | null` — 按 4.5 注入条件三重判断，不满足返回 null，满足返回 4.5 文案（路径实时解析）；
- 私有 `replaceImageDataUris(content: string): string` 与 `sanitizeMetadata(metadata: string | null): string | null` — 实现 4.4 规则。

### 步骤 3：`harness/core/compaction-service.ts`

1. `prependSessionSummary(summary, incrementalMessages, archiveHint?: string | null)` — 增加第三参数，透传给 `buildHandoffUserMessage`；
2. `buildHandoffUserMessage(summary, archiveHint?: string | null)` — 交接正文之后拼接 `archiveHint`（非空时，前面空一行）；
3. `buildHandoffInstruction()` — 末尾追加 4.6 的说明句。

新参数均为可选，`compaction-service.spec.ts:183` 等现有调用不受影响（不传 hint 行为不变）。

### 步骤 4：`harness/core/context-manager.ts`

`prependSessionSummary` 增加同名可选第三参数，透传给 `compactionService.prependSessionSummary`（纯转发，无逻辑）。

### 步骤 5：`harness/core/session-history-loader.ts`

1. 构造函数增加第三依赖 `private readonly compactionArchiveService: CompactionArchiveService`；
2. `applyHistory()` 内计算 `const hint = this.compactionArchiveService.buildArchiveHint(context.executionMode, context.userId!, context.sessionId!)`，传入 `prependSessionSummary(summary, incremental, hint)`。

注入覆盖面：`applyHistory` 是摘要进入上下文的唯一入口（`harness-service.ts:308` 的会话构建路径、orchestrator 压缩后重建路径 `session-compaction-orchestrator.ts:67` 都经过它），一处改动同时覆盖「新请求接续压缩后的会话」与「mid-loop 压缩后立即重建上下文」两个场景。

### 步骤 6：`harness/core/session-compaction-orchestrator.ts`

1. 构造函数增加依赖 `compactionArchiveService`；
2. `compact()` 内，在 `advanced` 判定为 true 之后（`if (!advanced)` 块之后、`record()` 事件之前）插入：

```ts
await this.compactionArchiveService.writeArchive(
  context.executionMode, context.userId!, context.sessionId!,
  latest?.compactCount ?? 1,
  history.normalizedEntities.filter((m) => m.id! > boundary && m.id! <= result.newLastCompactedMessageId),
);
```

序号取 CAS 成功后重读的 `latest.compactCount`（DB 真值），区间过滤基于压缩开始时加载的 `history.normalizedEntities`（4.3 快照语义）。

### 步骤 7：`src/create-app.ts` 装配

在现有组件构造处（`historyLoader` 与 `orchestrator` 创建点附近，`create-app.ts:560-580` 区域）：

1. `const compactionArchiveService = new CompactionArchiveService(runtimeResolver);`
2. `new SessionHistoryLoader(sessionSvc, contextManager, compactionArchiveService)` — 增加实参；
3. `new SessionCompactionOrchestrator(..., promptEngine, compactionArchiveService)` — 追加实参。

### 实现步骤汇总

| 步骤 | 文件 | 类型 |
|------|------|------|
| 1 | `harness/runtime/runtime-data-resolver.ts` | 修改：+1 方法 |
| 2 | `harness/core/compaction-archive.service.ts` | 新建 |
| 3 | `harness/core/compaction-service.ts` | 修改：签名扩展 + 指令微调 |
| 4 | `harness/core/context-manager.ts` | 修改：参数透传 |
| 5 | `harness/core/session-history-loader.ts` | 修改：注入依赖与 hint 计算 |
| 6 | `harness/core/session-compaction-orchestrator.ts` | 修改：写入归档调用 |
| 7 | `src/create-app.ts` | 修改：装配 |

无 DB migration、无新配置项、无 admin/desktop/android/agent-cli 任何改动。

## 6. 测试方案（Vitest，`cd backend-ts && npm test`）

### 6.1 新建 `compaction-archive.service.spec.ts`

- **占位符替换**：content 字符串内 data URI 被替换且保留 mime；多模态 JSON 数组 content 中的 data URI 同样被替换；metadata 含 `attachments` 时 data_uri 替换、mime/path 保留、仍为合法 JSON；metadata 非法 JSON 时退回正则替换；非 image data URI 与 `/uploads/` URL 原样保留。
- **写文件行为**：LOCAL 模式不产生文件；CLOUD 模式按序号命名写文件、行数与输入一致、每行可 `JSON.parse` 且字段全集齐备（`?? null` 归一后无 undefined 字段）、不存在 `.tmp` 残留。
- **hint 构建**：LOCAL / userId 为空 / 目录不存在 / 目录为空（仅有非 jsonl 文件）时返回 null；目录含 jsonl 时返回含真实路径的文案。

### 6.2 新建 `session-compaction-orchestrator.spec.ts`

- `persist` 成功且边界推进（advanced）后调用 `writeArchive`，参数含正确序号与 `(oldBoundary, newBoundary]` 过滤后的消息集；
- CAS 失败（`persisted=false`）或他人推进边界（`advanced=false`）时不调用 `writeArchive`；
- `writeArchive` 抛异常时 compact 流程仍返回 true 且事件正常记录（失败不阻断）。

### 6.3 扩展 `compaction-service.spec.ts`

- `prependSessionSummary` / `buildHandoffUserMessage`：无 hint 时输出与现状一致（快照断言防回归）；有 hint 时正文末尾完整拼接 hint 文案；
- `buildHandoffInstruction` 含归档说明句。

### 6.4 既有测试回归

`context-manager` 透传、`core-helpers.spec.ts` 的 `applyHistory` mock（`prependSessionSummary` 被替换为 vi.fn，不受签名扩展影响）、`harness-service.spec.ts`、`agent-loop.spec.ts` 全量跑绿。

## 7. 落地清单

实施完成（代码 + 测试全绿）后，同一任务内完成：

1. **CHANGELOG.md**：顶部新建 `## x.y.z (日期)` 小节，backend-ts→后端条目记录：「会话压缩（仅 CLOUD）成功后将被压缩消息全字段归档为 runtime 目录下 JSONL 增量文件（`compaction-NNN.jsonl`，图片 base64 占位化），并在交接消息中由代码注入归档目录与回查指引，Agent 可用 read_file/grep_search/shell 回读被压缩细节」。
2. **mao-cli 技能同步**：`skills/mao-cli/reference/troubleshooting.md` 「上下文压缩」小节补充一句：CLOUD 会话被压缩的原始消息已归档在会话 runtime 目录，Agent 可自行检索回读，用户无需重申全部背景。
3. **README.md / DEPLOY.md**：无部署形态、配置项、目录职责变化，**不更新**。
4. **验证方式**：`cd backend-ts && npm run build && npm test`；线上验证部署后在任一 CLOUD 长会话触发一次压缩，确认 `runtime/<uid>/<sid>/compaction/compaction-001.jsonl` 生成、交接消息含归档指引、Agent 能 grep 命中历史关键词。

## 8. 明确不做清单（已确认）

| # | 不做项 | 理由 |
|---|--------|------|
| 1 | 桌面端 / 管理后台的归档展示 UI | 无用户可见诉求；压缩事件在现有 UI 的展示不变 |
| 2 | DB schema 变更 | 归档路径由 `userId/sessionId` 确定性推导，无需存储 |
| 3 | 归档文件定期清理调度 | 归档随会话删除整体清理（runtime 目录级）；会话存活期内永久保留，保证长周期任务回查不落空。`RuntimeCleanupScheduler` 明确**不**纳入 compaction 目录 |
| 4 | 归档加密 / 脱敏 | 与 DB 消息同敏级，同受 runtime 沙箱与部署边界保护 |
| 5 | 专用回读工具（如 archive_search） | 完全复用 read_file / grep_search / shell，零新工具面 |
| 6 | 存量会话归档补录 | 初版不考虑存量数据；目录非空的注入守卫保证存量会话行为与现状一致 |
| — | 附带确认：不新增配置开关 | 该行为随压缩默认生效，无运维分支价值 |

## 9. 风险与备注

- **注入块常驻开销**：约 120 tokens/请求（压缩后），相对 12000 tokens 摘要可忽略；换取的是摘要有损场景下的无损回读能力。
- **磁盘占用**：单会话归档量级 MB~几十 MB（图片已占位化），与 incoming 上传同级；随会话删除回收，无累积风险。
- **Agent 大文件误读**：read_file 具备 offset/limit 分页且单行 JSON 可 grep 定位，无需额外截断机制；注入文案已明确引导用 grep 先检索再分页读。
- **快照语义**：归档内容为「压缩时点所见消息」，压缩执行期间被编辑/删除的消息仍按当时内容归档——这是特性（审计价值）而非缺陷。
- **token 估算**：占位符替换后归档文件不再影响任何 token 估算路径（归档内容不进入上下文）。



