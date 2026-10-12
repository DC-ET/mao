# 提示词前缀缓存加固 —— 第 2 轮代码复审

- 分支：`feat/prompt-prefix-cache`（基于 `main 9d2c9966`）
- 审查 commit：`66cf6d7f` + `b7d16e72`（`git diff main..HEAD`，工作区 clean）
- 审查范围：仅功能逻辑代码，不含文档 / CHANGELOG / mao-cli
- 复审对象：第 1 轮报告的 3 重要 + 3 建议（`docs/code-review/2026-10-12-prompt-prefix-cache-round1.md`）

---

## 1. 总体结论

**不建议合并（阻塞项 1 个）。**

第 1 轮的 3 个「重要」与 3 个「建议」均已正确修复且均有回归测试覆盖；第 2 轮顺带发现的
「整体排序」也是正确的修复。但本次复审新发现 **1 个阻塞级功能缺陷**：

> **快照的清理时机与「会话快照」语义自相矛盾 —— 每次执行结束即清空，导致「某 server
> 第二轮连接失败时沿用上次工具集」这一核心收益在主路径上完全落空。**

该缺陷使技术方案 §4.5 的目标形态与 §9 验收口径 5 无法达成，而 `connectForCloud` 中
本轮新增的 staleRefs / notice / 整体排序逻辑在主路径上成为不可达代码。

---

## 2. 问题列表

### 阻塞

#### B-1 CLOUD MCP 快照每次执行结束即被清空，「连接抖动时 tools 逐字节稳定」在主路径上不可达

- **文件:行**
  - `backend-ts/src/harness/core/harness-service.ts:98-103`（`clearCloudMcpSnapshot`）
  - `backend-ts/src/harness/core/harness-service.ts:85-97`（`execute` 的 finally）
  - `backend-ts/src/harness/core/harness-service.ts:264-273`（`executePrepared` 的 finally）
  - `backend-ts/src/harness/core/harness-service.ts:619-651`（`executeSideFirstMessage` 的 finally）
  - `backend-ts/src/harness/mcp/local/mcp-sync-service.ts:113-127`（依赖快照的 staleRefs 逻辑）
- **问题描述**

  `connectForCloud` 只在 `buildContext`（`harness-service.ts:362`）内调用一次，而
  `buildContext` 每次执行入口都调用一次，因此「跨轮」实际等价于「跨执行」。

  三个 execute 出口的 finally 都调用 `clearCloudMcpSnapshot(sessionId)` →
  `mcpSyncService.clearSession` → `McpToolsRegistry.clear()`，把 `cloudSnapshot` 删除。
  于是**每一次执行结束时快照必被清空**，下一次执行的 `connectForCloud` 里
  `getCloudSnapshot()` 必然返回 `[]`，`staleRefs` 恒为空数组。

  这与技术方案 `docs/plan/2026-10-12-prompt-prefix-cache-optimization-technical-design.md`
  §4.5 第 3 点明确写定的清理时机直接冲突：

  > **清理时机：会话执行结束（`agent-loop.ts` finally 已有 `mcpClientManager.closeSession(sessionId)`）
  > + 会话删除路径**（对齐 `streaming-ws-handler.ts:2003` 一带既有 `clearSession` 调用）。

  方案要求的是「连接关闭 + 会话删除」两级清理，而不是「每次执行结束清空」。

- **触发场景 / 影响**

  用户在同一 CLOUD 会话里连续发两条消息：
  1. 第 1 次执行：`github` / `baidu_map` 均连接成功，`tools = [baidu.geocode, github.read, github.write]`；
     执行结束 finally 清空快照。
  2. 第 2 次执行：`github` 连接失败（网络抖动 / server 重启）。此时快照为空，
     `staleRefs` 为空 → `github` 的两个工具**直接从 tools 数组消失**，且**没有**
     「github 当前不可用」的 notice。

  后果正是本方案要消除的 miss：`tools` 位于请求体缓存层级最前，该轮 + 恢复轮全部 miss。
  方案 §9 验收口径 5「人为让某 MCP server 在第二轮连接失败，`tools` 数组与失败前逐字节一致」
  **无法达成**。

  同时 `mcp-sync-service.ts:113-127` 本轮新增的 `succeeded` / `succeededByName` /
  `configured` / `staleRefs` / notice 派生逻辑在主路径上均为不可达代码（仅在同一次执行内
  `buildContext` 被调用两次以上的非主流路径才可能触发）。

  另外 `mcpClientManager.closeSession(sessionId)` 在 `agent-loop.ts:522` 的 finally 也会
  每次执行结束断开全部 MCP 连接，所以「沿用快照工具」的取舍是有意的：notice 告知模型 +
  工具调用自身报错。这一点与方案 §4.5 的「取舍」段落一致，不是新问题。

- **修复建议**

  把快照生命周期改为「会话级」而非「执行级」，与方案 §4.5 第 3 点对齐：

  1. `harness-service.ts` 三个 execute 出口的 finally **移除** `clearCloudMcpSnapshot(sessionId)`，
     或改为只在会话终态（会话删除 / 会话 FAILED-CANCELLED 且不再续跑）时清理。
  2. 在 `streaming-ws-handler.ts` 的会话删除路径补一次 `mcpSyncService.clearSession(sessionId)`
     （对齐 `:2003` 一带既有调用），避免内存 Map 无限增长。
  3. `agent-loop.ts:522` 的 `mcpClientManager.closeSession(sessionId)` 保持不变：
     它断的是「连接」，不是「工具集记忆」，与快照语义不冲突。
  4. 同步修正 `mcp-tools-registry.ts` / `mcp-sync-service.ts` 上注释里
     「会话内最近一次成功连接」的口径描述，使其与「会话级」一致。

  若团队判断「每次执行结束必须清」有别的理由（例如担心 MCP 配置变更后沿用陈旧工具），
  那么应当改的是方案与验收口径，而不是让实现与方案互相矛盾——当前状态下
  §9-5 是一条不可能通过的验收项。

- **验证用例与结果**

  探针 `/tmp/probe/r2-snapshot-e2e.spec.ts`（把真实 `McpSyncService` + `McpToolsRegistry`
  装进 `HarnessService`，模拟同一 CLOUD 会话 `sessionId=10` 的两次执行）：

  ```ts
  // 用例 1：第 1 次执行两 server 全成功；走完 execute（触发 finally 清快照）；
  //         第 2 次执行 github 连接失败。断言第 2 次 tools 与第 1 次逐字节一致。
  const first  = await service.buildContext(10, null, new AtomicBoolean(false));
  await service.execute(10, 'first turn', listener, new AtomicBoolean(false));
  const second = await service.buildContext(10, null, new AtomicBoolean(false));
  expect(toolNamesOf(second)).toEqual(toolNamesOf(first));
  ```

  实际输出：

  ```
  [probe] 第1次执行 tools: ["mcp__baidu_map__geocode","mcp__github__read","mcp__github__write"]
  [probe] 第2次执行 tools: ["mcp__baidu_map__geocode"]
  × 第 2 次执行 github 连接失败时，tools 数组应与第 1 次逐字节一致（方案 §9 口径 5）
      AssertionError: expected [ 'mcp__baidu_map__geocode' ] to deeply equal
                      [ 'mcp__baidu_map__geocode', …(2) ]
  ```

  对照组（同一份 stub，但第 1 次只调 `buildContext`、不调 `execute`，即不让快照被清）：

  ```
  [probe][不清快照对照] 第2次执行 tools: ["mcp__baidu_map__geocode","mcp__github__read","mcp__github__write"]
  ✓ 对照：若不在执行结束时清快照，第二轮失败可由快照补回
  ```

  对照组通过、实验组失败，证明「执行结束即清快照」是收益落空的唯一原因。

  补充探针 `/tmp/probe/r2-snapshot-lifecycle.spec.ts`（纯 `McpSyncService` 层，不经 harness）：

  ```
  ✓ 同一 sessionId 连续两次 connectForCloud（不清快照）：失败轮与全成功轮逐字节一致
  ✓ 两次 connectForCloud 之间按执行结束语义 clear：失败轮与全成功轮不一致（(f) 收益落空）
  ✓ 静态核对：三个 execute 出口 finally 均清快照；WS handler 每次执行 finally 也清
  ```

  三个用例全部通过，即「事实链」三句均成立：connectForCloud 每次执行只调一次 /
  三处 finally 都清 / WS handler 每次执行 finally 也清。

### 重要

（本轮未发现「重要」级问题。）

### 建议

（本轮未发现需要提交的「建议」级问题。以下为已核对确认无问题的点，供合入时参考。）

---

## 3. 第 1 轮问题修复情况核对

| 项 | 修复内容 | 核对结果 |
|---|---|---|
| I-1 | 抽出 `clearCloudMcpSnapshot`，三处 execute 外包 try/finally | ✅ 异常路径同样清理；6 条回归测试覆盖成功 + 抛错。**但清理时机本身见 B-1** |
| I-2 | `supportKey` 改 `${baseUrl}\|${modelId}\|${id}` 三元键，空串/缺失归一为 `<none>` | ✅ 正确。`deps.ts:291 llmModelToConfig` 与 `model.service.ts:288 testConnectivity` 均填 `id`，生产路径有主键；测试桩缺 `id` 时归一到 `<none>`，最坏退化为「按 baseUrl+modelId 隔离」，不会比修复前更差 |
| I-3 | `succeeded: Set<number>(server.id)` + `succeededByName`；`configured` 为 id 集合；`serverId===0` 退化按名比较；notice 由 staleRefs 派生 | ✅ 逻辑正确。`mcp-client-manager.ts:204 toToolRefs` 填 `serverId: server.id!`，生产快照 ref.serverId 非 0，走 id 精确匹配；`serverId===0` 分支只对历史/桌面数据生效 |
| 顺带 | `sortMcpToolRefs([...tools, ...staleRefs])` 整体排序 | ✅ 正确，消除了部分失败轮与全成功轮的字节差 |
| S-1 | `prompt-engine.ts` 改传 `Math.max(0, normalized.length - 1)` | ✅ 口径正确（排除 system）；`normalized[0]` 恒为 system 消息 |
| S-3 | `optBool` 大小写不敏感，`'0'`/`'1'` 同口径 | ✅ 与 update 校验一致；`''` 分支实际不可达（`getOpt` 已用 `hasText` 归一），但保留无害 |

---

## 4. 测试与构建验证

- `npx vitest run src/harness src/settings src/memory src/session` → **Test Files 116 passed / Tests 1732 passed**
- `npx tsc -p tsconfig.build.json --noEmit` → **exit 0**
- 4 个探针共 10 条用例：**1 failed / 9 passed**（唯一失败即 B-1 的实验组；`r2-snapshot-lifecycle`
  的静态核对用例初版断言计数写错，已修正后通过）
- 探针目录 `backend-ts/src/zz-probe/` 已删除，`git status --short` 干净（除本报告）

---

## 5. 结论

- **阻塞项 1 个（B-1）**：快照清理时机与方案 §4.5 矛盾，导致核心收益在主路径上不可达。
- 第 1 轮全部 6 项已正确修复。
- 建议：先修 B-1 再合入；修好后 §9 验收口径 5 即可真正通过。
