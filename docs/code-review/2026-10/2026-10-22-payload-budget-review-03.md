# 第三轮复查报告：会话压缩「请求体体积」触发 + 图片前置压缩

- 复查时间：2026-10-22
- 仓库/分支：`/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`，`main`（改动仍全部未提交）
- 复查对象：第 2 轮 `R2-M1 / M2 / M3 / L1 / L2 / L3 / L5 / L6 / L7 / L8 / L9 / L10 / L11` 的修复
- 复查方式：`git diff` 全量 + 逐文件阅读 + 全量单测 + 若干 `/tmp` 临时脚本实测（并发助手错误语义、估算器性能/精度；脚本未落仓库）
- 待确认 1 已由用户确认：`workbench_mao` 的 `flyway_schema_history` 只有 165/166，**V167 未被任何环境应用**，继续在 V167 内追加 `INSERT IGNORE` 安全，checksum 风险解除。

## 一、结论摘要

- **严重问题：0 个**
- **中等问题：1 个**（R3-M1，R2-M2 的抛异常分支未闭环）
- **轻微问题：10 个**（实现/注释不符 1、测试缺口 3、文档/日志/边界 6）
- **待确认：0 个**
- **上线建议**：可以合并；建议合并前顺手修 R3-M1（把自增移到 `await` 之前 + 1 条 `mockRejectedValue` 测试，约 5 行），其余轻微项可跟进。第 2 轮的 R2-M1、R2-M3 已闭环，R2-M2 只闭环了 `compact()` 返回 `false` 的分支。

### 本轮验证

| 验证项 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` | 通过（0 error） |
| `npx vitest run`（全量） | 394 passed / 1 skipped（395 files），4694 passed / 14 skipped，与你的说明一致 |
| `mapWithConcurrency` 首错行为（实测） | 9 项、limit=2、第 1 项抛错：拒绝后不到 1ms 内只执行了 `[1,2]`，**200ms 后 `[1..9]` 全部执行完**（见 R3-L1） |
| 估算器性能（实测，warm） | 229 条消息 + 45 张 400KB data URI：**1.09ms**；4MB 文本 + 50 图：**0.45ms** —— 设计 §4.2 的「<2ms」口径成立 |
| 估算器采样精度（实测） | 1MB 文本中间夹 95KB JSON、分别放在 40KB/150KB/300KB 偏移处：误差均 **+0.29%**，1.02 系数足以吸收采样遗漏 |

## 二、对重点复核问题的答复

### 1. `40MiB` 常量是否引入新的误剥图 / 是否回归

**结论：对默认配置不构成回归，常量选择合理；不建议改回跟随 trigger。**

- 默认 `triggerPayloadBytes` 也是 40MiB，第 2 轮的 `stripLimitBytes = triggerPayloadBytes` 在默认配置下等价于现在的 40MiB。默认配置行为完全一致。
- 「32MB 上限模型但没有填上限」的场景：触发线仍是 40MiB，**主请求在 32MB 就会先 413**，压缩请求不是瓶颈；只有 token 先触发（如 200k tokens 时请求还不到 32MB）或运维把 trigger 调小到 32MB 以下，才会走到「压缩请求超 32MB 但不剥图」。这不是新常量造成的，而是「未声明上限」的固有限制，且与第 2 轮默认配置表现相同。
- 真正的行为变化只有一种：运维为了匹配未声明的小上限，把**全局 trigger** 调到 <40MiB，第 2 轮剥图线会跟着降，现在固定 40MiB。这是本次解耦的**预期效果**（避免「每次压缩都剥图」）；代价是该场景失去一层隐性兜底。建议在后台 hint 补一句「留空=未知；未填上限时压缩兜底剥图线固定 40MiB」，并在模型表单提示「已知供应商上限请务必填写」。
- 误剥图方向：只有体积 ≥40MiB 触发压缩时才剥图，符合「接近上限才牺牲缓存」的语义；token 触发的中等体积会话不会剥图，前缀缓存目标达成。

### 2. R2-M2 的计数语义

- `payloadCompactionAttempts` 只对 `payload` / `both` 计数：token-only 失败仍每轮重试（这是改造前就有的行为，不是本次回归，但成本模型相同：每轮 1–2 次全量历史 LLM 调用）。
- `both` 场景下压缩失败**会计入 payload 名额**；达到 2 次后，`agent-loop.ts:557` 的 cap 分支会把整次 `compact()`（包含 token 那部分）一起跳过，直到本次执行结束。考虑到「连续失败两次后重试大概率仍失败」，这个取舍可以接受，但建议把注释/日志写清「both 也会停 token 压缩」。
- 建议统一为 `midLoopCompactionAttempts`，对所有 trigger 计数（同一次 `compact()` 的成本与触发原因无关），并**在调用前自增**——这样顺带修掉 R3-M1。

### 3. `mapWithConcurrency` 的异常语义

- 保序、峰值 ≤ limit、空输入、异常传播四个测试都真实锁住了行为，实现正确。
- 但**注释与实现不符**：注释（`common/concurrency.ts:4-5`）写「其余 worker 仍会把**已开始的任务**跑完」，实测是**把剩余队列全部跑完**（9 项中第 1 项抛错，另一 worker 继续执行 2–9，结果全部丢弃）。当前调用点 `compressDataUriForStore` 几乎不抛（内部 `tryCompressForStore` 全捕获），所以没有「写入顺序 / 部分失败」问题；万一抛错，最多多做 N-1 次 sharp 解码+编码（9 张 8000×6000 图约多烧 7 次百 MB 级解码），且发生在调用方已经失败之后。
- 建议：加 `let aborted = false;`，worker 每轮开头检查并 return；或 `Promise.allSettled` 后统一抛第一个错误。
- 另外：limit 是 **per-call** 而非进程级信号量，多会话同时收图仍会叠加 2×N 个并发解码；本次修复已把单消息峰值从 9 降到 2，进程级上限可作为后续 hardening。

### 4. 负缓存的淘汰策略与时长

- **合理**：条目只有「url + status + until」，512 上限 + 插入序淘汰足够（命中即抛，没有 recency 语义，不需要 LRU）；5 分钟对 404/410 这种基本永久的状态足够短，URL 被重新上传后最多 5 分钟恢复压缩，期间适配器回退原 URL，不会返回旧图。
- **缺口**：只覆盖 404/410。超时 / DNS / 连接失败仍然每轮重试，而三个适配器都是**串行**下载图片（`openai-llm-adapter.ts:539-554`，另两个适配器同构），一个卡住的域名会让每张图等满 20s（`REMOTE_IMAGE_FETCH_TIMEOUT_MS`）。这正是 R2-L7 里「域名不可达时每张等满超时」的那一半。建议对 transport 类错误加一个更短的负缓存（如 60s），或把图片下载改成有界并发。
- 附带：404 命中负缓存时，适配器仍会对每张图打一条 `Failed to prepare image ... keeping original URL` warn（`openai-llm-adapter.ts:553`），含已删除图片的会话每轮 N 条，建议降为 debug 或每个 URL 只打一次。

### 5. 新增测试是否真的锁住行为

- **已锁住**：R2-M1 双向（50MB 剥图 / 5MB 保持）、R2-M3 助手本身（保序、峰值、空输入、异常）、R2-L2 repository 落库字段、R2-L7 404 只 fetch 一次、R2-L10 EXIF 有损路径宽高与编码一致。
- **未锁住**：R2-M2 的**抛异常**分支（只测了 `mockResolvedValue(false)`，见 R3-M1）、L1 修复（没有 request_start 越线 → `payloadCompactionDone` 的测试）、provider 上限分支的剥图边界（R3-L4）、IM 通道是否真的调用了压缩（R3-L10）。

## 三、中等问题

### R3-M1. `payloadCompactionAttempts` 在 `compact()` 抛异常时不自增：413 / 5xx / 超时仍会每轮无限重试

- 文件：`backend-ts/src/harness/core/agent-loop.ts:563-566`（调用与自增）、`:574-583`（catch 吞掉后继续循环）；字段注释见 `agent-execution-context.ts:71`
- 证据：

```ts
} else if (trigger != null) {
  const compacted = await this.sessionCompactionOrchestrator.compact(...);   // ← 抛异常时直接跳到 catch
  if (payloadAttempt) context.payloadCompactionAttempts += 1;                // ← 只有正常返回才计数
  ...
}
} catch (e) {
  if (e instanceof CompactionContextOverflowException || e instanceof CompactionPayloadOverflowException
    || e instanceof CompactionStateReloadException) throw e;
  ...
  harnessLog('warn', 'Mid-loop compaction failed, continuing with the original next request', e);  // 吞掉，下一轮继续
}
```

- 影响：R2-M2 想消除的就是「413 被 catch 后下一轮重试」。现在只有 `compact()` 正常返回 `false` 会消耗名额；一旦抛异常（上游 413、网络错误、适配器重试 10 次后的 5xx/429，见 `openai-llm-adapter.ts:88-111` 与 `isRetryableStatus`），计数永远是 0，cap 永不触发。以 40MB 历史、20 个工具轮为例，最坏是 20 次全量历史压缩请求；5xx/429 还会先在适配器内重试 10 次，放大到 200 次调用。字段注释「本次执行已发起的体积压缩次数（含失败）」与实际行为不符。
- 修复建议：把自增移到 `await` 之前（或写在 `finally` 里），例如：

```ts
if (payloadAttempt) context.payloadCompactionAttempts += 1;
const compacted = await this.sessionCompactionOrchestrator.compact(...);
```

  补一条测试：`sessionCompactionOrchestrator.compact.mockRejectedValue(new Error('LLM API returned 413'))` + 4 个工具轮 → 断言只调用 2 次、第 3 轮起不再调用。

## 四、轻微问题

### R3-L1. `mapWithConcurrency` 首错后会把剩余队列全部跑完，注释与实现不符
- 文件：`backend-ts/src/common/concurrency.ts:1-6`（注释）、`:18-24`（worker 循环）
- 实测（`/tmp` 脚本，未落仓库）：9 项、limit=2、第 1 项抛错，拒绝时已执行 `[1,2]`，200ms 后 `[1..9]` 全部执行。剩余结果无人消费。
- 影响：图片压缩场景一旦单张抛错，剩余图片仍会继续解码/编码（最多 N-1 次），在调用方已经失败之后继续占用 CPU/内存；不影响正确性（结果被丢弃）。
- 建议：加 `aborted` 标志，worker 每次取任务前检查；并把注释改成「失败后其他 worker 会停止领取新任务 / 或跑完队列」的真实语义。补一条「首错后 fn 调用次数 ≤ 已开始 + 1」的测试。

### R3-L2. token-only 压缩失败仍每轮重试；`both` 失败会把 token 压缩一起停掉
- 文件：`backend-ts/src/harness/core/agent-loop.ts:556-566`
- 现状：`payloadAttempt = trigger === 'payload' || trigger === 'both'`；token-only 不计入 cap。`both` 失败 2 次后整次 `compact()` 被跳过。
- 影响：token-only 的失败成本与 payload 相同（每轮 1–2 次全量历史调用），但没有上限；`both` 场景下 token 压缩被连带停掉，请求可能继续超上下文窗口，最终由上游报错。前者是改造前就有的行为，非回归。
- 建议：统一成一个 `midLoopCompactionAttempts`，对所有 trigger 计数；至少把 `both` 的连带行为写进注释/设计。

### R3-L3. 负缓存未覆盖超时/DNS/连接失败
- 文件：`backend-ts/src/harness/llm/remote-image-cache.ts:154-167`（只对 `RemoteImageHttpError` 404/410 记负缓存）、`:27`
- 影响：域名挂起/DNS 故障时，每轮每张图仍会等满 20s（适配器串行下载），10 张图就是 200s 的请求构建时间。
- 建议：对 transport 错误（`AbortError` / `TypeError` 网络类）加 60s 左右的负缓存，或把下载改为有界并发（与 R2-M3 同一套 `mapWithConcurrency`）。

### R3-L4. provider 上限分支的剥图边界仍缺反向用例
- 文件：`backend-ts/src/harness/core/compaction-service.spec.ts:352-388`（正向：900,000 > 734,464）、`:442-477`（反向只覆盖「未声明上限 + 5MB < 40MiB」）
- 影响：如果 `COMPACTION_PAYLOAD_SAFETY_MARGIN_BYTES` 从 64KB 改成 200KB（剥图线 600,000），或把 `>=` 改成 `>`，现有测试仍全绿。R2-L3 只补了 unknown-limit 分支。
- 建议：补 `estimate = 734_463` → 不剥图、`734_464` → 剥图（声明上限 800,000）两条边界用例。

### R3-L5. L1 修复没有测试
- 文件：`backend-ts/src/harness/core/harness-service.ts:508-519`
- 现状：`bytesBeforeCompact` 取自压缩前、`payloadCompactionDone` 用压缩前体积判断，代码正确；但没有测试覆盖「request_start 越线压缩成功后，mid-loop 不再因体积重复压缩」。
- 建议：补一条 harness-service/agent-loop 联动用例（或抽出纯函数单测）：request_start 压缩成功 + `bytesBeforeCompact >= trigger` → `context.payloadCompactionDone === true`，随后两个工具轮的 `compact` 不再因 payload 被调用。

### R3-L6. `REMOTE_IMAGE_BYTES` 仍未覆盖「6 次编码都没到 300KB」的兜底
- 文件：`backend-ts/src/request-size.ts:36`（常量）、`backend-ts/src/harness/tool/prompt-image-resizer.ts:193-216`（兜底返回最小 attempt）、`backend-ts/src/harness/llm/remote-image-cache.ts:132-142`
- 现状：常量按「目标 320KB + base64 + 前缀」取 ~438KB；`compressForStore` 在所有尝试都超目标时返回**最小的 attempt**，对极端噪声图（如 8000×6000）按 6 档编码推算可能到 ~1MB data URI（未单独实测）；解码失败回退原始字节更无上限。注释只写了「解码失败回退原字节」这一种低估。
- 影响：大量极端图时按 438KB/张估算会低估，靠近供应商上限时仍可能 413；普通照片不受影响。
- 建议：在缓存层加单张上限（超过 ~1MB 的压缩结果不入缓存、回退原 URL 或截断），或在注释/文档里补第二种低估边界。

### R3-L7. 40MiB 常量与「全局 trigger 调小」的行为变化需要提示
- 文件：`backend-ts/src/harness/core/compaction-service.ts:14,19,177-179`；后台 hint `admin/src/views/settings/components/IntegrationConfigPanel.vue:331`
- 现状：未声明上限时剥图线固定 40MiB，不再跟随 `triggerPayloadBytes`。这是预期修复，但运维若把全局 trigger 调到 8MiB（以为剥图线也跟着降），实际兜底线仍是 40MiB。
- 建议：设置页 hint 或模型表单提示补一句「未填请求体上限时，压缩兜底剥图线固定 40MiB；已知供应商上限请填写」。

### R3-L8. CHANGELOG 的「同一次执行最多 2 次」与实现不完全一致
- 文件：`CHANGELOG.md:20`（`同一次执行内体积压缩最多尝试 2 次`）；设计 §6.4 `:339` 写的是「mid-loop 最多 2 次」（准确）
- 现状：request_start 若失败会调用 1 次（不重试），mid-loop 再最多 2 次，单次执行理论最多 3 次。
- 建议：CHANGELOG 改成「mid-loop 最多尝试 2 次」，与设计文档一致。

### R3-L9. 达到 cap 后每个工具轮都打一条 warn
- 文件：`backend-ts/src/harness/core/agent-loop.ts:557-562`
- 现状：`attempts >= MAX` 后，每个工具轮都会进这个分支并打一条 warn；20 个工具轮就是 20 条同样的日志（R3-M1 的 catch 路径还会额外每轮一条）。
- 建议：只在 `attempts === MAX` 的那一次打（或在 context 上记一个 `payloadCompactionCapLogged`）。

### R3-L10. IM 通道没有「确实调用了压缩」的测试
- 文件：`backend-ts/src/weixin/agent-inbound-handler.spec.ts:14-24`（用无效 base64 `abc`，走原样返回）
- 现状：`concurrency.spec.ts` 锁住了助手本身，但没有测试证明三个 handler 真的把 `media.images` 交给 `compressDataUriForStore` 并回填压缩后的 URI。
- 建议：在 weixin（或 feishu）handler spec 里用一张真实的 >500KB PNG data URI，断言持久化 content 里的 `image_url.url` 长度显著小于输入。

## 五、第 2 轮问题复核

| 上轮条目 | 状态 | 说明 |
|---|---|---|
| R2-M1 剥图线与 trigger 耦合 | **已修复** | 独立 40MiB 常量；两条测试覆盖「trigger=800 + 50MB → 剥图」「trigger=800 + 5MB → 不剥图」。默认配置无回归（见问答 1） |
| R2-M2 失败后无限重试 | **部分修复** | 返回 `false` 的分支已封顶 2 次并有测试；**抛异常分支仍未计数**（R3-M1） |
| R2-M3 IM 多图无并发上限 | **已修复** | `mapWithConcurrency` + limit=2，三通道接入；助手有保序/峰值/异常测试。残余：per-call 而非进程级、失败后继续跑完队列（R3-L1） |
| R2-L1 request_start 判断读压缩后体积 | **已修复** | `bytesBeforeCompact` 在 `compact()` 前取值，逻辑正确；缺测试（R3-L5） |
| R2-L2 S1 测试打在 mock 上 | **已修复** | 新增 `model.repository.spec.ts`，覆盖 insert / undefined→null / update / 清空 |
| R2-L3 剥图边界测试单向 | **部分修复** | unknown-limit 分支已双向；provider-limit 分支仍单向（R3-L4） |
| R2-L5「采样」实为全量扫描 | **已修复** | 改为首/中/尾各 32K 采样，`\b`/`\f` 改 +1；实测 1MB 异构文本（中间夹 95KB JSON）误差 +0.29%；性能见验证表 |
| R2-L6 410KB 非严格上界 | **已修，残余** | 常量提到 ~438KB；解码失败回退与「6 次都没到 300KB」两种低估仍存在（R3-L6，后者未写入注释） |
| R2-L7 404/410 无负缓存 | **已修，残余** | 404/410 有 5min 负缓存且有测试；超时/DNS 未覆盖（R3-L3） |
| R2-L8 文档与行为不一致 | **基本修复** | §6.4 已改为独立安全线 + 只在已知上限时抛 + 重试上限；§4.2 采样口径已改。剩 CHANGELOG 的「最多 2 次」措辞（R3-L8） |
| R2-L9 read_file 尺寸文案 | **已修复** | 改用 `PromptImageResizer.orientedSize()`，EXIF 摆正后展示 |
| R2-L10 EXIF 只覆盖 resize | **已修复** | 新增 1600×900 + orientation=6 的有损路径用例，断言上报宽高 == 编码后真实宽高 |
| R2-L11 每轮 buildRequest | **按约定接受** | 文档 §5.5 已写明「每个工具轮仍会 buildRequest 一次」，不再作为问题 |

## 六、上线建议

1. **建议合并前修 R3-M1**：自增移到 `await` 前（或 `finally`），补一条 `mockRejectedValue` 的 cap 测试。这是 R2-M2 的原始目标，改动 5 行以内。
2. **建议顺手补**：R3-L4（provider 分支边界用例）、R3-L5（L1 测试）——否则这两个刚修的 bug 仍无回归保护。
3. **可选**：R3-L7 的后台 hint、R3-L3 的 transport 负缓存、R3-L1 的 stop flag。
4. V167 已确认未被应用，checksum 风险解除；本报告无待确认项。
