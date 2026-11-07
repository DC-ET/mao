# 人+Agent 维度容器隔离（feat/user-agent-container-isolation）round-1 代码审查报告

> 日期：2026-11-07
> 审查对象：worktree `.worktrees/ua-container`，`git diff main...HEAD`（commit 7f5af784），仅 backend-ts/src、admin/src、scripts/ 功能代码（docs 不在审查范围）。
> 对照方案：`docs/plan/2026-11-07-user-agent-container-isolation-technical-design.md`。
> 验证方式：全量 `cd backend-ts && npm test`（5700 passed）+ `npm run build` 通过；每个 bug 均以临时 spec 实际复现验证（验证后已删除，未留在提交内）。
> 结论：**共 2 个 bug**（1 中低、1 低），未发现会导致数据串容器/权限越界的隔离性缺陷。

---

## Bug 1（中低）：send 工具 read_bytes 在工具调用点现读 session.agentId，破坏「按轮快照」路由，轮中切 Agent 后与同轮其余工具调用路由分裂

- **位置**：`backend-ts/src/harness/container/read-bytes-bridge.ts:99-110`（`DockerSendBytesBridge.readBytes` 内 `const agentId = input.sessionId != null ? await this.deps.sessionAgentIdOf(input.sessionId) : null`）；依赖注入点 `backend-ts/src/app-container-runtime.ts:176-180`；调用链 `backend-ts/src/harness/tool/impl/send-file-bytes.ts:70`（`loadSendFileBytes` → `support.readBytes({...ctx, ...})`，消费方 `feishu-tools.ts` / `dingtalk-tools.ts` / `wechat-tools.ts` / `edit-image-tool.ts`）。
- **问题描述**：技术方案 §5.6 明确要求「发送类工具上下文（send_wechat_* / feishu_send_file / dingtalk_send_file 的 ctx，SERVER_ONLY 分支构造）增加 agentId 字段，**与 runtimeUserId 同点填充**，供 read-bytes-bridge.readBytes 透传」；§5.9 明确规定「轮中切换：本轮剩余工具调用仍在旧容器执行。**禁止在工具调用点现读 session.agentId**」。实现没有给发送工具 ctx 增加 agentId，而是在 bridge 的 `readBytes` 里每次用 `sessionAgentIdOf(sessionId)` 现查 DB 取会话**当前** agentId。
- **后果**：
  1. 轮中切 Agent 后，同一轮内 docker-only 工具（shell/read_file 等，`ToolInvocation.agentId` 快照）仍路由旧容器，而 send 工具的 read_bytes 却路由到**新**容器——同轮路由分裂，违背「切 Agent 不打断当前轮」的已拍板决策；
  2. 对新容器的 `ensureRunning` 会在本轮中途触发（可能冷启动、甚至为挂载通道工作区而重建容器），即用户感知的「当前轮被打断」；
  3. agent 维度挂载收窄后，旧 Agent 的 `<shareDir>/agent-experience/{旧agentId}` 与技能视图目录在新容器**不存在**：本轮读取这类路径（如经工作区符号链接 `团队经验/` 读旧 Agent 经验文档再发送）会失败，而按快照在旧容器执行本可成功（workspace/tmp/uploads/runtime 等用户级共享挂载不受影响）。
- **复现路径/验证方式**（临时 spec，已验证通过后删除）：构造 `DockerSendBytesBridge`，`sessionAgentIdOf` 桩返回 9（模拟轮中 PATCH 后会话行已变为 agent 9，本轮快照实为 5），调用 `bridge.readBytes({userId:7, sessionId:11, ...})`，断言 `router.readBytes` 收到 `agentId: 9` —— 证明 bridge 完全按调用点现查值路由、快照无法到达该链路；对照既有 `tool-dispatcher.spec.ts` 断言（dispatch 按 `invocation.agentId=5` 快照路由），同轮两者分裂成立。
- **建议修复方向**：按设计 §5.6 补齐穿线——SERVER_ONLY 分支构造发送工具 ctx 时（`tool-dispatcher.ts` 的 `callTool` 调用点 / 工具构造参数）增加 `agentId` 字段并从 `routeAgentId`（轮快照）填充；`read-bytes-bridge.readBytes` 优先透传 ctx 携带的 agentId，仅在缺省时保留 `sessionAgentIdOf` 查库兜底（与 docker-only 工具的兜底策略同口径）。

## Bug 2（低）：切 Agent 后旧 keep_session shell / async 后台任务失效报错缺少设计承诺的「引导重建」文案（决策 8 / §5.9 验收点未落地）

- **位置**：`backend-ts/src/harness/tool/impl/shell-session-tool.ts:321`、`:390`（`会话不存在或已关闭：{id}`）、`:376`（`后台任务不存在或已被消费：{taskId}`）、`:522`。本次 diff 未在任何位置新增切换引导文案（仓库全局 grep「已切换 Agent」「重新创建 shell」均无命中，backend-ts/desktop/admin 三端皆无）。
- **问题描述**：技术方案 §5.9 行为链明确规定：轮中切 Agent 后，「旧 keep_session shell：旧 session_id 在新容器报『shell 会话不存在』，**报错文案含『该会话已切换 Agent，请重新创建 shell 会话』**」；任务背景亦把「旧 shell/async 失效**引导重建**」列为交付点。实际实现里，切 Agent 后下一轮在新容器对旧 session_id 调 `write_stdin` / `await_async` 得到的报错与普通的会话过期/关闭文案完全相同，无法与「切 Agent 导致的失效」区分，缺少引导重建的提示。
- **后果**：功能上 Agent 收到报错后仍可自行重建 shell 会话（业务不中断），但设计承诺的引导语义缺失，模型可能把旧 shell 失效误判为偶发故障而重试旧 session_id，多耗一轮才恢复。
- **复现路径/验证方式**（临时 spec，已验证通过后删除）：按 `shell-session-tool.spec.ts` 同样方式构造 `ShellSessionTool`（`sessionManager.getSession` 返回 null，模拟新容器内不存在旧 shell 会话），执行 `write_stdin`/`await_async`，断言返回 error 含「会话不存在或已关闭」且**不含**「重新创建」「已切换 Agent」——证明设计承诺的文案未实现。
- **建议修复方向**：容器内 ShellSessionManager 无法感知「切换」语义（容器内存独立），宜在宿主侧收口：docker 路由分支（`docker-tool-router.dispatch` 或 dispatcher 对 shell 工具结果的后处理）识别「会话不存在或已关闭 / 后台任务不存在」类错误并按会话维度的「已切换 Agent」标记追加引导文案；或退一步在错误归一化层统一追加。具体落点需结合设计再定。

---

## 已排查、确认无问题的关键面（供 round-2 复核省时）

- **容器注册表**：复合键 `containerKey`/`containerName`/`entries`/`userLocks`/`lastAgentBuild`/`lockContext` 全部一致替换；`cleanupFailedStart`/`dropFailedEntry`/`isLive`/`reapExpired`/`stopAllForShutdown` 的世代与身份校验均按复合键运作；`recycleUser` 单容器/整用户聚合、busy 跳过语义与既有 spec 相符；`markConnectionDead`/`reportRuntimeStatus`/`reportAgentHello` 穿线完整（app-container-runtime 回调已同步双参）。
- **挂载计划**：skillViews/share/channel 三条恰为 `{根}/{userId}/{agentId}` 且有 assertSafe 精确校验；sessionWorkspace 豁免与私聊归属校验保留；`assertShareDirIndependent` 新增 distDir 反向校验合理；指纹含两条新 agent 维度条目，skillNames 增删不进指纹（零重建）成立。
- **通道层**：连接表/socket 目录/token/踢旧逻辑均按复合键隔离；`connectedKeys` 更名后无遗留调用方。
- **skill 视图**：`ensureView` 锁键/视图/meta/tmp 均按 (user, agent) 三级；`cleanupStaleSkillViewTmp` 新布局下钻一层、旧布局平铺残留兼容；`skill-sync-service` 对 `agent.id == null` 的降级与 D7 语义一致。
- **经验库**：容器内 `ExperienceIndexService` root 仍为 `{MAO_SHARE_DIR}/agent-experience`，`refreshIfUnderRoot` 首段数字校验在新挂载面下照常命中；沙箱允许根收窄为 `MAO_EXPERIENCE_AGENT_DIR`，宿主机注入与 planner 挂载源同源；`createAndStart` 预创建两处挂载源目录消除 docker 隐式建目录。
- **派发链路**：`ToolInvocation.agentId` 唯一填充点在 `agent-loop.ts`（buildContext 每轮 `context.agentId = agent.id`，子代理/边路/恢复复用同径）；dispatcher 查库兜底 + 仍缺明确报错符合设计；`RoutingMcpClientManager` 的 `agentIdOf` 与 `userIdOf` 同口径。
- **终端/PTY**：`terminal.routes` 唯一创建点传 `session.agentId`；pty hub 键改复合串后 `startedAtMs` 世代判定在 `dockerStart`（重置 startedAtMs）与重建路径下均正确；旧 `app-shutdown.ts:52-53` 的 `Map<number,…>` 类型标注未同步，但该处仅遍历 values/clear 且经 any 通路传入，无运行时影响（不计为 bug）。
- **admin/脚本**：`ContainerRebuildPanel` 每行回收携带 agentId、批量遍历行为与旧「整用户回收」等价；`user.routes` recycle body 兼容缺省；`container-gc.sh` 旧命名孤儿清理正则 `^mao-user-[0-9]+$` 不会误伤新命名，socket 清理双 glob 兼容新旧布局。
