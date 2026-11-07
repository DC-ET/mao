# 人+Agent 维度容器隔离 round-2 复审报告

> 日期：2026-11-07
> 复审对象：worktree `.worktrees/ua-container`，修复提交 `ba80b030`（`git diff HEAD~1`），对照 round-1 报告 `2026-11-07-user-agent-container-round1.md`。
> 验证方式：每个结论均以临时 spec 在真实 `ToolDispatcher` → 真实 `SendFeishuImageTool` → 真实 `loadSendFileBytes` → 真实 `DockerSendBytesBridge` 全链路上实际复现（验证后已删除，未留在提交内）；全量 `npm test` 排除临时 spec 后 5703 passed 全绿、`npm run build` 通过。
> 结论：**共 1 个 bug**——Bug 1 的修复机制正确但不完整，轮快照路由分裂在飞书/钉钉 4 个发送工具上仍存在；Bug 2 修复完整，可收敛。

---

## Round-2 Bug（中低）：ALS 轮快照只覆盖 SERVER_ONLY 分支，feishu/dingtalk 4 个发送工具的 read_bytes 路由分裂仍在（round-1 Bug 1 修复不完整）

- **位置**：`backend-ts/src/harness/tool/tool-dispatcher.ts:310-318`（ALS 仅在 `SERVER_ONLY_TOOLS` 分支注入）与 `tool-dispatcher.ts:447-453`（最终 registry/sessionTools 执行分支未包裹 ALS）；`SERVER_ONLY_TOOLS` 清单见 `tool-dispatcher.ts:67-85`（发送类只含 `send_wechat_image`/`send_wechat_file`）。
- **问题描述**：`SendFeishuImageTool`/`SendFeishuFileTool`/`SendDingtalkImageTool`/`SendDingtalkFileTool` 注册在全局 ToolRegistry（`tool-registry.ts:182-185`）、**不在 `SERVER_ONLY_TOOLS` 内**，CLOUD docker 用户调用时走 `dispatchFullOutcome` 末尾的 `callTool(tool, …)` 兜底分支执行——该分支没有 `sendToolRoundContext.run` 包裹，ALS 快照对这 4 个工具不可达。桥侧（`read-bytes-bridge.ts:104`）`getStore()` 为空即回落 `sessionAgentIdOf(sessionId)` 现查 DB——round-1 Bug 1 的「轮中切 Agent 后 read_bytes 路由新容器、同轮 docker-only 工具路由旧容器」分裂在这 4 个工具上原样存在。受影响的正是 feishu/dingtalk 通道会话（工作区为通道工作区、最常走容器发送图片/文件的场景）；已修复的只有 `send_wechat_*` 与 `edit_image`（SERVER_ONLY 分支）。
- **复现路径/验证方式**（临时 spec，已验证后删除）：真实 `ToolDispatcher`（dockerRouter.enabledFor=true）+ 真实 `SendFeishuImageTool`（support 桩 + 真实 `DockerSendBytesBridge`，`sessionAgentIdOf` 桩返回 9 模拟「轮中已切到 agent 9、本轮快照为 5」），`dispatchInvocation` 携带 `agentId: 5` 调 `feishu_send_image` → 断言 `router.readBytes` 收到 `agentId: 5` 失败，实际收到 **9**（`expected 9 to be 5`），即快照未穿透该链路。对照组：同一 ALS 机制在 `sendToolRoundContext.run` 包裹的链路下工作正常（见下）。
- **已验证为可靠的部分**（无需改动）：① ALS 经 `run → callTool → tool.execute → loadSendFileBytes → bridge.readBytes` 全 await 链传播可靠，机制本身无问题；② 并发隔离无串号——两轮并发（快照 5 与 6）各自拿到本轮快照；③ round-1 验证场景对 `send_wechat_*`/`edit_image` 已消除（提交内回归 spec「轮快照存在时优先于按会话查库兜底」与并发对照均通过）。
- **建议修复方向**（二选一，均不动 `Tool.execute` arity）：把 4 个 feishu/dingtalk 发送工具并入 `SERVER_ONLY_TOOLS`（它们本就在 `RUNTIME_SCOPED_TOOLS`，SERVER_ONLY 分支的 `runtimeToolUserId` 口径不变、CLOUD 无审批语义差异）；或在 `dispatchFullOutcome` 末尾兜底分支对这批 send 工具复用 SERVER_ONLY 分支同款 docker 门 + `sendToolRoundContext.run` 包裹 `callTool`。

## Bug 2 修复复核：完整，可收敛

- `shell-session-tool.ts:321/:376/:390/:522` 四处全部更新为「已失效（可能因切换 Agent 或容器回收）…请重新创建/重新提交」引导文案；全仓 grep 无旧文案残留；`exec` 动作走 `getOrCreate`（陈旧 session_id 透明重建），无遗漏报错面。回归 spec「stale shell / async task errors carry recreate guidance」覆盖到位。

## Round-1「已排查无问题」清单复核

修复提交仅触碰 `read-bytes-bridge.ts`、`send-file-bytes.ts`、`tool-dispatcher.ts`、`shell-session-tool.ts`（+spec+报告文档），其余文件与 round-1 完全一致，round-1 排查结论维持有效。对修复代码本身的增量排查：

- ALS `run()` 只在 SERVER_ONLY 分支一处调用，无嵌套 run/泄漏面；`tool-dispatcher → impl/send-file-bytes` 无循环依赖（build 通过）。
- docker 门 `enabledFor` 有 5s TTL 缓存，SERVER_ONLY 每次派发多一次缓存读，无行为影响；host 用户走原路径零变化。
- `routeAgentId ?? 查库` 的兜底与 docker-only 分支同口径；`fromRound != null ? fromRound : (sessionId != null ? 查库 : null)` 三元解析正确。
- 发送工具均同步 await `loadSendFileBytes`（feishu×2/dingtalk×2/wechat×2/edit_image），无脱离 ALS 窗口的延迟读取。
- `app-shutdown.ts` 的 `Map<number>` 旧类型标注维持 round-1 结论：无运行时影响，不计 bug。
