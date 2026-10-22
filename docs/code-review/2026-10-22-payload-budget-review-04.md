# 第四轮复查报告：会话压缩「请求体体积」触发 + 图片前置压缩

- 复查时间：2026-10-22
- 仓库/分支：`/opt/mao-data/workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/mao`，`main`（改动仍全部未提交）
- 复查对象：第 3 轮 `R3-M1 / L1 / L2 / L3 / L4 / L5 / L6 / L7 / L8 / L9 / L10` 的修复
- 复查方式：逐文件阅读 + 全量单测 + 新测试单跑 3 次 + `/tmp` 脚本实测（工具 schema 缓存命中差异；脚本未落仓库）
- 前置结论沿用：V167 未被任何环境应用，checksum 风险解除。

## 一、结论摘要

- **严重问题：0 个**
- **中等问题：0 个**
- **轻微问题：6 个**（1 个新测试未真正锁住行为、1 个注释/文档声称的缓存实际不命中、2 个测试断言偏松、1 个计数器哨兵语义、1 个文档位置偏差）
- **待确认：0 个**
- **合并结论：可以合并。** 第 3 轮唯一的中等项 R3-M1 已真正闭环（计数前置 + 有效回归测试）；本轮没有再发现功能性缺陷。剩余 6 项都是测试精度/注释/可维护性，不阻塞上线，可随本次或后续提交一并处理。

### 本轮验证

| 验证项 | 结果 |
|---|---|
| `npx tsc -p tsconfig.build.json --noEmit` | 通过（0 error） |
| `npx vitest run`（全量） | 394 passed / 1 skipped（395 files），4699 passed / 14 skipped，与提交说明一致 |
| 新测试稳定性（concurrency / remote-image-cache / harness-service / weixin，连跑 3 次） | 每次 74 passed，无抖动 |
| 工具 schema 缓存（实测） | 40 个工具、168KB schema：每次新建 tools 数组 **0.50ms**；复用同一数组 **0.0014ms**（≈350 倍差距，见 R4-L2） |

## 二、对重点复核问题的答复

### 1. 计数前置是否会让「成功压缩」多消耗名额

**逻辑正确，不影响行为。** 成功时 `payloadCompactionDone = true`（`agent-loop.ts:574-576`），后续每轮的 `payloadBytes` 直接置 0，payload 触发不再发生，计数器此后再不参与任何判断；因此「成功也自增」只是让计数与实际发起次数一致，没有副作用。`both` 触发时把失败计入 payload 名额也可以接受：同一次 `compact()` 的成本与触发原因无关，连续两次失败后不再重试是合理的成本保护；唯一副作用是 `both` 失败 2 次后 token 压缩也被一起停掉（`agent-loop.ts:557-564`），在「连续两次都失败」的前提下这个取舍合理。

### 2. `aborted` 的语义与「部分写入」

**不会出现部分消费或部分写入。** `results` 只在 `await mapWithConcurrency(...)` 正常返回后读取；一旦 reject，调用方不会拿到任何结果。`aborted` 在失败 worker 的 catch 里先置位再 rethrow，另一个 worker 最多跑完**当前正在执行的那一项**，之后在循环入口看到 `aborted` 退出；最多比 `limit` 多 0 项。实测定时下「9 项、limit 2、第 1 项抛错」稳定为 `started=[0,1]`，连跑 3 次无抖动。图片压缩调用点（三个 IM handler）在 reject 时整条消息构建失败/回退，不存在「一半图片写入、一半没写」的路径。

### 3. 传输层负缓存 60s 的影响

- **会掩盖 60s 内的瞬时失败，但不丢图**：命中负缓存时 `resolve` 抛错，适配器回退原始 URL，图片仍然进入请求（由上游自行下载），只是这 60s 内不做下载/压缩。对「只有后端能访问、上游访问不了」的 URL，改造前后都只能回退原 URL，负缓存没有额外损失。
- **对回退路径的副作用**：没有功能副作用；唯一需要注意的是回退期间请求体里只有 URL 字符串，而估算器仍按 438KB/张计（`request-size.ts:36`），属于 R2-L6 的已知高估——100 张以上 URL 图的会话在这 60s 窗口内可能被误判触发一次体积压缩。这是既有近似口径的延伸，不是本轮新引入，也不丢数据。
- 5xx 也进 60s 负缓存：可以接受（60s 很短，且回退原 URL 保底）；如果担心上游抖动，可把 5xx 单独设成 15–30s，但不是必须。

### 4. 新增测试是否真的锁住行为

| 测试 | 是否锁住 | 说明 |
|---|---|---|
| `midLoopPayloadCompactionCountsFailedAttemptsThatThrow` | **是** | 旧实现（返回后自增）在 `mockRejectedValue` 下会调用 4 次，测试断言 2 次，会失败 |
| `propagates the first error and stops dispatching new items` | **是** | 旧实现会把 2–8 全部领走（9 次），断言 `<=2` 会失败；实测稳定 |
| `negative-caches transport failures ...` | **是** | 无负缓存时 fetch 会被调用 2 次 |
| `buildMessageContent_compressesLargeInboundImages` | **部分是** | 输出 ≤300KB 能锁住压缩接线；但「原值未被改写」的断言恒真（R4-L4） |
| `keeps images when ... just below the provider strip line` | **部分是** | 能挡住 64KB→200KB 这种大改，但挡不住 64KB→16KB 这种小改（R4-L3） |
| `buildContextMarksPayloadCompactionDoneWhenPreCompactionRequestWasOverThreshold` | **否** | mock 的 `compact` 不重建请求，旧实现读到的仍是 2000，同样会通过（R4-L1） |

### 5. 合并结论

**无严重/中等问题，可以合并。** 建议合并前顺手把 R4-L1（让 L1 测试真正锁住行为）改掉，其余轻微项可跟进。

## 三、轻微问题

### R4-L1. harness-service 的 L1 回归测试没有真正锁住「读压缩前体积」
- 文件：`backend-ts/src/harness/core/harness-service.spec.ts:577-608`（被测代码 `harness-service.ts:508-520`）
- 现状：`const orchestrator = { compact: vi.fn(async () => true) };` —— mock 不会像真实 orchestrator 那样在压缩成功后重建请求、覆盖 `context.lastRequestBytes`。执行到 `if (compacted && triggerBytes > 0 && bytesBeforeCompact >= triggerBytes)` 时，`context.lastRequestBytes` 仍是第一次 `buildRequest` 写入的 2000；即使把实现改回旧的 `context.lastRequestBytes`，条件同样成立，测试仍会绿。
- 影响：R2-L1 这个「读压缩后体积」的 bug 仍无回归保护；未来有人改回去，CI 不会报。
- 修复建议：让 mock 模拟真实行为，并补一个反向用例：

```ts
const orchestrator = {
  compact: vi.fn(async (_id: number, c: AgentExecutionContext) => {
    c.lastRequestBytes = 100;   // 模拟 orchestrator 压缩成功后的 buildRequest
    return true;
  }),
};
// 反向：buildRequest 第一次给 500（< 阈值 1000）→ compact 返回 true → payloadCompactionDone 必须为 false
```

### R4-L2. 工具 schema 的 WeakMap 缓存实际永远不命中
- 文件：`backend-ts/src/harness/core/request-size.ts:99-101,165-186`；调用方 `backend-ts/src/harness/core/prompt-engine.ts:641-650`；设计 §4.2 `docs/plan/...:132`
- 现状：缓存键是 `request.tools` 数组引用，但 `buildToolDefinitions()` 每次 `buildRequest` 都用 `.map()` 新建数组，引用永不相等 → 每轮都会重新 `JSON.stringify` 全部工具参数。实测 40 个工具 / 168KB schema：新建数组 **0.50ms/次**，复用数组 **0.0014ms/次**。
- 影响：每个工具轮多 0.5ms 级开销（真实 schema 更大时 1–3ms），对 LLM 延迟可忽略；但注释「工具定义在一次执行内不变，按数组引用缓存」与设计 §4.2 的「WeakMap 缓存」在现有调用路径下不成立，容易让后续维护者误判成本。
- 修复建议：二选一——把稳定引用（`context.tools`）作为缓存键传给 estimator（例如 `estimate(request, modelId, toolsKey)`），或把注释/设计改成「按数组引用缓存；当前 buildRequest 每次重建数组，实际不命中」。

### R4-L3. provider 分支的边界测试仍偏松，且注释的 736KB 与实际剥图线不符
- 文件：`backend-ts/src/harness/core/compaction-service.spec.ts:390-419`
- 现状：用例用 `estimate = 700_000`、上限 800,000，实际剥图线是 `800,000 - 64×1024 = 734,464`（注释写「800KB-64KB = 736KB」，把 1024 和 1000 混用了）。700,000 距边界还有 34KB，64KB 余量改成 16KB（线 784,000）或 30KB（线 770,000）时两条用例仍会全绿。
- 影响：剥图安全线的小幅漂移无法被发现；注释数字会误导后续调参。
- 修复建议：补精确边界 `734_463`（不剥）与 `734_464`（剥），并把注释改成「800,000 − 65,536 = 734,464」。

### R4-L4. weixin 新测试的「原值未被改写」断言恒真
- 文件：`backend-ts/src/weixin/agent-inbound-handler.spec.ts:63-64`
- 现状：`expect(ctx.imageDataUris![0].length).toBeGreaterThan(source.length)` —— base64 编码后长度必然大于原始字节数，这个断言在任何实现下都成立，无法证明 handler 没有改写传入的 data URI。
- 影响：如果以后 `compressDataUriForStore` 被改成原地回填 `ctx.imageDataUris`，测试不会失败。
- 修复建议：先保存 `const original = ctx.imageDataUris![0];`，最后断言 `expect(ctx.imageDataUris![0]).toBe(original)`。

### R4-L5. 用 `MAX+1` 哨兵实现「只打一条日志」，计数器语义偏 1
- 文件：`backend-ts/src/harness/core/agent-loop.ts:557-564`；字段注释 `agent-execution-context.ts:71`
- 现状：达到上限后把 `payloadCompactionAttempts` 从 2 自增到 3 来保证只打一次日志；字段注释仍是「本次执行已发起的体积压缩次数（含失败）」，此时实际只发起了 2 次，读出来却是 3。
- 影响：当前只有 cap 判断在读这个字段，行为正确；但若后续用它做指标、日志或动态上限，会得到偏大的值，且注释与事实不符。
- 修复建议：加一个独立布尔 `payloadCompactionCapLogged`，或把字段注释改成「尝试次数；达到上限后会 +1 作为已告警哨兵」。

### R4-L6. 「建议填写供应商上限」不在设计 §6.4
- 文件：`docs/plan/2026-10-22-session-compaction-payload-budget-technical-design.md:312-339`（§6.4）、`:630`（§10）
- 现状：§6.4 已写「未声明上限时用独立常量 40MiB」，但没有「建议填写供应商上限」这句；该建议在 §10 第 630 行。代码注释同样没有。
- 影响：只读 §6.4 的运维/开发不会得到「未填上限时兜底线固定 40MiB，已知上限请填写」的行动指引；本轮选择不加后台 hint 后，文档是唯一提示位。
- 修复建议：在 §6.4 末尾补半句「未声明上限时剥图线固定 40MiB，已知供应商上限请在模型配置中填写 `maxRequestBodyBytes`」。

## 四、第 3 轮问题复核

| 上轮条目 | 状态 | 说明 |
|---|---|---|
| R3-M1 抛异常不计数 | **已修复** | 自增移到 `await` 前（`agent-loop.ts:566-571`）；`mockRejectedValue` 测试断言 2 次，旧实现会 4 次，能锁住 |
| R3-L1 首错后继续跑完队列 | **已修复** | `aborted` 标志 + 收紧的测试；实测稳定 |
| R3-L2 token-only 不封顶 | **按约定接受** | 改造前既有行为；`both` 连带停 token 的取舍已在代码注释说明 |
| R3-L3 传输层失败不缓存 | **已修复** | 404/410 → 5min，其余冷启动失败 → 60s；测试有效 |
| R3-L4 provider 分支边界测试 | **部分修复** | 新增 700,000 反向用例，但非精确边界（R4-L3） |
| R3-L5 L1 修复缺测试 | **未真正闭环** | 新增了测试，但 mock 不重建请求，旧实现同样通过（R4-L1） |
| R3-L6 `REMOTE_IMAGE_BYTES` 低估边界 | **已修复** | 注释补齐「6 次未达标 ~1MB」「解码失败回退原字节」两种边界 |
| R3-L7 40MiB 提示 | **按约定接受** | 不加后台 hint；文档口径在 §6.4/§10（位置见 R4-L6） |
| R3-L8 CHANGELOG 措辞 | **已修复** | 改为「mid-loop 的体积压缩最多尝试 2 次（含异常）」 |
| R3-L9 cap 日志刷屏 | **已修复** | `attempts === MAX` 时自增到 MAX+1 并只打一次（哨兵语义见 R4-L5） |
| R3-L10 IM 压缩无测试 | **已修复** | 真实 1200×1200 噪声 PNG → 输出 ≤300KB；「原值未改写」断言偏弱（R4-L4） |

## 五、合并建议

1. **可以合并**：无严重/中等问题，R3-M1 已闭环，功能路径（计数、并发、负缓存）逻辑正确。
2. 建议合并前顺手改 R4-L1（约 5 行测试改动），让 R2-L1 真正有回归保护；R4-L3/R4-L4 两条断言也建议一起收紧。
3. R4-L2、R4-L5、R4-L6 可跟进，不影响本次上线。
