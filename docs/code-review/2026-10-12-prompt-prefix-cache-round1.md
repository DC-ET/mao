# 代码审查报告：提示词前缀缓存加固（feat/prompt-prefix-cache，round1）

- 审查范围：`git diff main..HEAD`（backend-ts）
- 基准文档：`docs/plan/2026-10-12-prompt-prefix-cache-optimization-technical-design.md`
- 日期：2026-10-12
- 结论：**未发现会导致功能错误 / 缓存失效 / 请求失败 / 数据不一致的阻塞性 bug**；发现 3 个「重要」问题（均为边界条件下的功能正确性或可运维性，不会造成数据错误）与 3 个「建议」项。

---

## 1. 总体结论

- 是否可以合并：**可以合并**（下述重要项建议在合并后一个迭代内处理，不阻塞本次上线）。
- 阻塞项数量：**0**
- 已执行的验证：
  - 全部相关单测通过：`prompt-cache-key-support.spec.ts`、`json.spec.ts`、`openai-llm-adapter.spec.ts`、`anthropic-llm-adapter.spec.ts`、`prompt-prefix-monitor.spec.ts`、`prompt-engine.spec.ts`、`mcp-sync-service.spec.ts`、`mcp-tools-registry.spec.ts`、`harness-service.spec.ts`、`settings.service.spec.ts`、`memory/*`（合计 260+ 用例全绿）。
  - `npx tsc -p tsconfig.build.json --noEmit` 通过。
  - 针对每条怀疑点编写了独立探针测试（见各问题条目），探针文件运行后已从 worktree 删除，未残留。

---

## 2. 问题列表

### 重要

#### I-1 `executePrepared` / `executeSideFirstMessage` 未清理 CLOUD MCP 快照，跨执行残留陈旧工具集

- 位置：`backend-ts/src/harness/core/harness-service.ts:264`（`executePrepared`）、`backend-ts/src/harness/core/harness-service.ts:615`（`executeSideFirstMessage`）；清理点只在 `:97` 的 `execute()` finally。
- 问题描述：本次只在 `HarnessService.execute()` 的 finally 里加了 `this.mcpSyncService?.clearSession(sessionId)`。但仓库里共三处 `agentLoop.execute(...)` 调用：
  1. `execute()`（:93）——已加清理；
  2. `executePrepared()`（:266）——未清理；
  3. `executeSideFirstMessage()`（:638）——未清理。
- 触发场景 / 影响：
  - `executePrepared` 的调用方包括子代理重试（`streaming-ws-handler.ts:1350`）与 `subagent-visibility-service.ts:174`（后台子代理执行）。这些路径下 `buildContext()` 会走 `connectForCloud()` 写快照，执行结束后快照不被清除。WS 侧 `releaseSessionExecutionResources()` 会调 `mcpSyncService.clearSession()`（`streaming-ws-handler.ts:2034`），因此主会话场景最终仍被兜底清掉；但**后台子代理（BackgroundSubagentManager → visibilityService → executePrepared）没有 WS finally 兜底**，其 childSessionId 的 cloud 快照会一直驻留。
  - 影响不是「错误工具被调用」——快照的读取方是 `getCloudSnapshot(sessionId)`，仅 `connectForCloud` 自己读；childSessionId 不会复用，所以后果是 **`McpToolsRegistry.cloudSnapshot` Map 里长期驻留已结束会话的条目**（内存残留 + 日志噪声），而非功能错误。`sessionTools`（LOCAL 维度）在同路径同样残留，属既有行为。
  - 严格说这是「方案 §4.5 第 3 条清理时机只落实了 1/3 处」，与方案表述不完全一致。
- 修复建议：把清理下沉到三处 execute 共用的出口，或在 `AgentLoop.execute()` 的 finally（`agent-loop.ts:522` 已有 `mcpClientManager.closeSession(sessionId)`）里一并调用 `mcpSyncService.clearSession(sessionId)`（AgentLoop 需注入 McpSyncService 或经回调）。若判断后台子代理的 childSessionId 不复用、残留可接受，也应在代码注释或方案中显式记录该取舍。
- 验证用例（文本覆盖分析，运行通过）：
  ```ts
  // /tmp/probe/probe-cleanup-coverage.spec.ts
  it('execute() clears cloud snapshot in finally', ...)          // 通过
  it('executePrepared() does NOT clear cloud snapshot', ...)     // 通过（证实缺口）
  it('executeSideFirstMessage() does NOT clear cloud snapshot', ...) // 通过（证实缺口）
  it('requestCompaction() clears MCP clients but not the cloud snapshot', ...) // 通过
  ```

#### I-2 降级键在 `baseUrl` 或 `modelId` 为空时会把不同模型误判为同一个键

- 位置：`backend-ts/src/harness/llm/prompt-cache-key-support.ts:24`（`supportKey`）。
- 问题描述：`supportKey` 用 `` `${config.baseUrl ?? ''}|${config.modelId ?? ''}` ``。当两个不同模型的 `baseUrl` 与 `modelId` 同时为空/undefined 时，键都是 `'|'`，`markUnsupported` 会把它们视为同一个模型，导致其中一个被 400 降级后，另一个（本可正常发送）也永久不再发送缓存字段。
- 触发场景 / 影响：
  - `LlmModelConfig.baseUrl` / `modelId` 是可选字段（`chat-request.ts:135-146`），`llmModelToConfig`（`deps.ts:291`）对 NULL 列产出 `undefined`。虽然正常模型配置两列都有值，但测试/兜底路径（`harness-service.spec.ts` 的 `model()`、部分子代理 mock）完全可能出现空值。
  - 实际业务影响有限（空 modelId 的请求本就不能正常路由到上游），但键碰撞会让「不同模型互不干扰」这一方案要求（§4.2 键隔离）在空值退化为「全部互相干扰」。
- 修复建议：键中追加可区分的占位或对空值做显式处理，例如 `` `${config.baseUrl ?? '<none>'}|${config.modelId ?? '<none>'}|${config.id ?? ''}` ``；或在 `supportKey` 返回 null（任一为空）时跳过降级登记（保守策略：无法定位模型就不降级）。
- 验证用例（运行通过，证实碰撞真实存在）：
  ```ts
  // /tmp/probe/probe-empty-key.spec.ts
  it('empty baseUrl + empty modelId collide across different models', () => {
    resetPromptCacheSupportForTest();
    const a = { baseUrl: '', apiKey: 'k', modelId: '' };
    const b = { baseUrl: '', apiKey: 'k', modelId: '' };
    markUnsupported(a, 'prompt_cache_key', 'unknown field prompt_cache_key');
    expect(isSupported(b, 'prompt_cache_key')).toBe(false); // 误判为同键
  });
  it('empty baseUrl but distinct modelIds stay isolated', ...)   // 通过：modelId 非空时仍隔离
  it('empty modelId but distinct baseUrls stay isolated', ...)   // 通过：baseUrl 非空时仍隔离
  ```
  结论：只有「两个维度同时为空」才碰撞，属边界但真实。

#### I-3 `connectForCloud` 的 `succeeded` 用 `server.name` 匹配，同名 server 会把失败者误判为成功

- 位置：`backend-ts/src/harness/mcp/local/mcp-sync-service.ts:95`（`succeeded.add(server.name ?? '')`）、`:104-110`（`previous.filter((ref) => !succeeded.has(ref.serverName) && ...)`）。
- 问题描述：`succeeded` 是 `Set<string>`（server 名称）。同一轮里若存在两个同名 server（`mcp_server.name` 无唯一约束，管理后台允许重名），其中一个连接成功、另一个失败，则 `succeeded` 含该名字 → 失败者不会被识别为 stale，既不会沿用快照兜底，也不会产生「当前不可用」notice。
- 触发场景 / 影响：两个同名 MCP server（例如用户建了两个都叫 `github` 的配置），一个挂了一个通。此时：
  - 挂掉的那个 server 的工具本轮直接消失（而非沿用快照）→ **tools 数组变化 → 该轮 + 恢复轮缓存 miss**，正是本方案要消除的抖动；
  - 且没有 notice 告知模型该 server 不可用。
  这是功能正确性问题（缓存失效），但触发前提是重名配置，概率低。
- 修复建议：`succeeded` 改用 server 主键（`server.id`），同时快照的 `McpToolRef.serverId` 已存在，按 `serverId` 做 stale 判定；`serverName` 仅用于 notice 文案与排序。
- 验证用例（运行通过，证实 notice 缺失、工具丢失）：
  ```ts
  // /tmp/probe/probe-mcp-snapshot.spec.ts
  it('same-name servers collapse into one set (succeeded matched by name)', async () => {
    // 首轮 github(id=2) 成功 → 快照登记
    // 第二轮 [github(id=2) 成功, github(id=4) 失败]
    // 期望看到 'github 当前不可用'，实际 warnings 只有 ['github: refused']
    // 且 tools 只剩成功者那份（快照里 github 的工具并未以 stale 形式补回）
  });
  ```

### 建议

#### S-1 `observePrefix` 的 `messageCount` 含 system 消息，与「消息条数」直觉不一致

- 位置：`backend-ts/src/harness/core/prompt-engine.ts:181`（`normalized.length`）、`backend-ts/src/harness/core/prompt-prefix-monitor.ts:26`（`messageCount` 注释「消息条数」）。
- 说明：`normalized` 是 `[system, ...history]`，因此 `normalized.length` 比真实历史条数恒大 1。该值仅用于日志上下文，不影响任何功能与判定。方案 §4.3 也只说「仅计数」。
- 影响：日志 `messages=N` 与用户感知的对话轮数差 1，排查时可能造成微小困惑。
- 修复建议：改传 `normalized.length - 1`，或在 monitor 注释里明确「含 system」。
- 验证（运行通过）：探针 `probe-message-count.spec.ts` 证实 1 条 user 历史时 `normalized.length === 2` 且 `messages[0].role === 'system'`；日志实际输出 `messages=2`。

#### S-2 Anthropic `system` 为字符串时顶层 `cache_control` 的官方语义依赖

- 位置：`backend-ts/src/harness/llm/anthropic-llm-adapter.ts:599-600`。
- 说明：本实现把 `cache_control` 放在请求体顶层（自动缓存模式）。经核对 Anthropic 官方文档，「Automatic caching: Add a single `cache_control` field at the top level of your request」是受支持的形态，且「不认该字段的网关退化为现状（无缓存）」这一风险论证成立[^1^]。文档同时指出：若最后一个块已有不同 TTL 的显式 `cache_control`、或 4 个显式断点已占满，API 返回 400——这两种情况本实现都不会产生（全仓无块级 `cache_control`，代码已核对确认）。
- 影响：**不是 bug**，无实际风险；仅提示后续若引入块级断点需重新评估。
- 修复建议：无需改动。后续若做「显式逐块断点」增强（方案 §3.1 留的后续项），需注意与顶层自动断点共用 4 个 slot 的约束。
- 验证：`grep -r "cache_control" backend-ts/src` 仅命中本次新增的顶层字段与降级逻辑，无块级使用；官方文档口径见引用。

#### S-3 `optBool` 对大小写敏感，与 update 校验的大小写不敏感不对称

- 位置：`backend-ts/src/settings/settings.service.ts:755-758`（`optBool`）与 `:715`（校验用 `toLowerCase()`）。
- 说明：update 校验 `value.toLowerCase() === 'true' | 'false'`（接受 `True`/`FALSE`），但读取侧 `optBool` 只认小写 `'true'`/`'1'`。若有人绕过 update 接口直接写库（或历史数据）写入 `True`，读取会得到 `false`，与用户预期相反。
- 影响：`harness.llm.anthropicAutoCache` 默认启用，误写 `True` 会静默关闭缓存。属既有 `optBool` 的通用问题，非本次引入，但本次新键复用了它。
- 修复建议：`optBool` 改为 `raw.toLowerCase() === 'true' || raw === '1'`，与校验口径对齐。
- 验证（运行通过，复刻实现证实不对称）：
  ```ts
  // /tmp/probe/probe-settings.spec.ts
  expect(optBool('TRUE', false)).toBe(false);   // 校验层接受、读取层按 false
  expect(optBool('False', true)).toBe(false);   // 恰好与语义一致（巧合）
  ```

---

## 3. 已逐条排查但确认「无问题」的怀疑方向

| 怀疑点 | 结论 | 依据 |
|---|---|---|
| 降级重试循环安全性（attempt 与 rateLimitMaxRetries） | 安全。400 走 `isRetryableStatus()===false` 分支，不进入限流重试计数；`shouldDegrade` 命中后 `markUnsupported` 置位，`payload` 去掉字段后 `shouldDegrade` 不会再命中，最多一次额外请求。 | 探针 `probe-degrade-loop.spec.ts`：400→降级→500，最终正确抛出 `LLM API returned 500`，`rateLimitMaxRetries=1` 下未吞错也未死循环；既有 `chatRetriesWithoutPromptCacheKeyAfterGatewayRejectsItWith400`（`rateLimitMaxRetries=0`）通过 |
| stream 路径 payload reassignment 后 `continue` 位置 | 正确。`payload = degraded; continue;` 位于非 2xx 分支内、`for` 循环体尾部语义位置，下一次迭代以新 payload 重新请求。 | 既有 `streamRetriesWithoutPromptCacheKeyAfterGatewayRejectsItWith400` / `streamRetriesWithoutCacheControlAfterGatewayRejectsItWith400` 通过（requestCount=2，第二份 body 无该字段） |
| `stripPromptCacheKey` / `stripCacheControl` JSON 往返改变字段顺序 | 不改变其余内容字节。`prompt_cache_key` 是 `serializeChatRequest` 追加的最后一个键，删除后其余键顺序与原序列化一致；`cache_control` 同样是 body 最后一个追加的键。 | 探针 `probe-strip.spec.ts`：`JSON.parse→delete→stringify` 结果与 `sendPromptCacheKey=false` 重新序列化逐字节相等（两个用例均通过） |
| prefix-monitor LRU 512 淘汰把在用的会话误淘汰 | 无功能影响。淘汰后该会话下次观察按「首次登记」处理，只多打一条 info，不会误报 warn。 | 既有 `超过 512 会话按插入序淘汰最旧，不泄漏` 通过；`touch()` 用 delete+set 实现 LRU，重复观察会续期 |
| 记忆 SQL 在 MySQL8 合法性 | 合法。派生表起了别名 `t`，`LIMIT` 在内层子查询，外层 `ORDER BY t.id ASC` 引用别名——符合 MySQL 对派生表的要求。 | 既有 `memory.repository.spec.ts` 断言内层截断 + 外层 id ASC 两个片段都在（通过）；SQL 结构逐字核对 |
| `reportCloudSnapshot` 空数组不删，配置移除的 server 工具残留 | 不残留。`connectForCloud` 的 `snapshot` 只保留本轮 `servers` 列表里的 server（`configured.has(ref.serverName)`），被移除的 server 不会从旧快照带回；空数组不删只影响「本轮全部失败」时沿用上次好快照，这是方案明确要求的语义。 | 探针 `probe-mcp-snapshot.spec.ts` / `probe-mcp-edge.spec.ts`：`server removed from config`、`all servers fail in later round`、`reportCloudSnapshot ignores empty array` 均通过；既有 `removedServerToolsDisappearOnceItStopsSucceeding` 通过 |
| `cancelFlag` break 后快照语义 | 合理。break 前已成功的 server 的工具保留在 snapshot 中并作为本轮结果返回；break 后未连接的 server 不出现（等同首轮失败）。 | 探针 `probe-mcp-snapshot.spec.ts`（`cancelFlag break after success keeps earlier tools in snapshot`）与 `probe-mcp-edge.spec.ts`（`cancelFlag set after first server success`）通过 |
| `getOpt` 返回 null 回落 5m / `anthropicCacheTtl` | 正确。`getOpt` 对 NULL/空串返回 null，`anthropicCacheTtlRaw === '1h' ? '1h' : '5m'` 对 null 与非 '1h' 一律回落 5m；`anthropicAutoCache` 回落 true。 | 既有 `getHarnessTuningConfigFallsBackForInvalidAnthropicCacheTtl`（DB 写 '2h' → 得 '5m' + autoCache=true）通过 |
| V152 迁移 | 正确。`INSERT IGNORE` + value 为 NULL 表示「从未设置」，与 V097 先例一致；`editable=1` 允许后台改。 | 文件逐行核对 |
| `serializeChatRequest` 第 4 参默认值 | 兼容。`sendPromptCacheKey = true` 默认保持既有行为（Responses 侧调用不传该参），仅 openai adapter 显式传 `isSupported(...)`。 | `json.spec.ts` 全部通过（含默认不带第 4 参的用例） |
| prompt-engine 接入点 messageCount | 仅日志口径问题，见 S-1，不影响指纹判定（指纹只用 sections/tools）。 | 探针 `probe-message-count.spec.ts` |

---

## 4. 引用

[^1^]: Anthropic 官方文档《Prompt caching》——「Automatic caching: Add a single `cache_control` field at the top level of your request. The system automatically applies the cache breakpoint to the last cacheable block.」并说明与块级断点共用 4 个 slot、`ephemeral` 为唯一受支持类型、默认 5 分钟 TTL、可指定 1 小时。（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）
