# 核心功能逻辑 BUG 评审（2026-09-30）

- **日期**：2026-09-30
- **基线**：main @ `94cf09ad`（工作区干净），所有行号以当前源码实测核对。
- **范围**：`backend-ts/src`（session/WS、harness 引擎与工具、weixin/dingtalk/feishu 通道、auth/user/model/analytics 等平台服务）+ `desktop/src`（useStreamWS、stores/session）+ `agent-cli` 消费链。
- **方法**：六路并行分模块通读源码出题，**全部入选条目由本人逐条回读源码复核触发链**（含调用方、配置装配、WS 事件流、DB 读写顺序），非仅采信子代理结论；随后与 `docs/code-review/` 既有 200+ 篇文档逐条 grep 去重。未运行构建与测试（纯静态评审，未改业务代码）。
- **结论**：确认 **5 个可复现的核心功能逻辑 BUG**（正榜 BUG-1 ~ BUG-5，2 高 / 1 中高 / 1 中 / 1 中低），另有 7 条已核实的低severity问题列入附录 A。每条给出 `文件:行号`、触发链、预期 vs 实际、影响与修复方向。
- **明确剔除的候选**（已核实不构成 BUG、不可达，或经需求方判定超出正常业务逻辑边界，记录以免重复排查）见附录 B。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | harness/tool（feishu/wechat/dingtalk 发送工具） | `fetchBytes` 无超时、无流式大小上限：对端挂起则 AgentLoop 永久卡死且取消无效，大响应体在超限检查前全量进内存可致 OOM |
| BUG-2 | 高 | weixin 入站 | 同步游标先持久化、消息零认领零去重：处理期任何异常或进程重启即静默丢消息，用户永久无响应 |
| BUG-3 | 中高 | session/ws（重试链路） | 线程池拒绝被 `submitExecution` 内部吞掉，`entryPhase` 回滚不触发：phase 滞留 RESUMING，发送/重试全被拒，随后又被孤儿巡检以崩溃恢复语义自动执行，与「请稍后重试」提示矛盾 |
| BUG-4 | 中 | harness/tool（open_web_page） | 截断落盘不区分执行模式：LOCAL 会话把全文写到服务端磁盘并把该路径指引给模型，桌面端 `read_file` 永远读不到，与自身注释「LOCAL 模式不落盘」直接矛盾 |
| BUG-5 | 中低 | dingtalk 通道 | 文本进度「正在处理」按 sessionId 进程级永久去重：同会话第二次任务起用户再收不到受理回执，且 Set 无界增长 |

---

## BUG-1【高】通道发送工具 `fetchBytes` 无超时、无流式上限：AgentLoop 永久挂死 + 内存无界

**位置**

- `backend-ts/src/harness/tool/impl/feishu-tools.ts:288-299`（`fetchBytes`，`feishu_send_image` / `feishu_send_file` 经 `loadBytes` L277-286 调用）
- `backend-ts/src/harness/tool/impl/wechat-tools.ts:134-145`（`send_wechat_image` / `send_wechat_file`，同构）
- `backend-ts/src/harness/tool/impl/dingtalk-tools.ts:124-138`（`dingtalk_send_file` 等，同构，仅多了 HTTP 状态码检查）
- 执行路由：`tool-dispatcher.ts:48-54`（`SERVER_ONLY_TOOLS` 含 `send_wechat_*`）、`:218-224`（服务端直执分支）、`:256-263`（CLOUD 通道会话的服务端 `callTool`）

**代码事实**

```ts
// feishu-tools.ts:288-299（三处同构）
function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));        // 无累计上限
      res.on('end', () => resolvePromise(Buffer.concat(chunks))); // 结束后才轮到 10/20MB 检查
      res.on('error', reject);
    }).on('error', reject);
  });
}
```

`lib.get` 未设 `timeout`/`signal`，也没有 `setTimeout` 兜底；大小检查（如 `feishu-tools.ts:219` 的 `bytes.length > MAX_FEISHU_IMAGE_BYTES`）发生在**全量下载完成之后**。服务端工具执行全链路（`AgentLoop.executeToolCalls` → `dispatchFullOutcome` → `callTool` → `execute`）没有任何 `Promise.race` 超时（agent-loop.ts 全文无超时竞速，L144 仅是轮询 sleep）；取消标志只能在工具 Promise settle 之后才被检查。

**触发链**

1. 飞书/钉钉/微信通道会话（CLOUD，服务端执行）中，模型调用 `feishu_send_image` 等工具并传入 http(s) URL（模型自主生成或被网页内容诱导）；
2. 目标服务器长连接挂起或无限慢速 drip → `fetchBytes` 的 Promise 永不 settle → `AgentLoop` 卡在 `executeToolCalls` 的 `await` 上；
3. 用户点停止：`abortRunningExecution` 置位 cancel flag，但循环要等工具返回后才检查 → **取消无效**；
4. 该会话执行永久悬挂（崩溃恢复巡检排除本地有 cancel flag 登记的在途会话），只能重启进程恢复；
5. 另一路：对端返回 GB 级响应体 → 在 10/20MB 上限检查之前全部进 `chunks` → 后端进程 OOM。

**预期 vs 实际**：预期下载有 connect/read 超时并在流式累计超限即中止——同仓库 `open-web-page-tool.ts:238,274,292-296,315` 就有 connectTimer/readTimer + `maxRawBytes` 流式截断，`image-api-client.ts` 用 `AbortSignal.timeout`，唯独这三个发送工具的 URL 下载裸奔。

**修复方向**：三个 `fetchBytes` 统一改为带 `AbortSignal.timeout(连接+读取双超时)` 的实现，`data` 事件内累计字节数、超过各自 MAX 立即 `req.destroy()` 报错；保持与同仓库 `fetchHtml` 相同的防护口径。

**去重说明**：`2026-09-22-logic-bug-review-01.md:243` / `-02.md:315` 记录的是「微信 fetchBytes 不看 HTTP 状态码」（内容正确性角度，作者主动未计入正榜）；本条是**无超时挂死 + 无流式上限 OOM** 的可用性角度，且覆盖 feishu/dingtalk 两个同构实现，根因与后果均不同。

---

## BUG-2【高】微信入站：游标先持久化、消息零认领零去重，处理期异常即静默丢消息

**位置**

- `backend-ts/src/weixin/monitor.service.ts:96-109`（monitorLoop 主循环）
- `backend-ts/src/weixin/inbound-processor.ts:27-81`（processInboundMessage 全文无任何幂等键/重试标记）

**代码事实**

```ts
// monitor.service.ts:96-109
const result = await this.getUpdates(payload.baseUrl, payload.token, account.getUpdatesBuf ?? null, signal);
if (result.newBuf != null && account.id != null) {
  await this.accountRepository.updateGetUpdatesBuf(account.id, result.newBuf);  // ① 先推进游标
}
if (result.messages.length > 0) {
  for (const message of result.messages) {
    void this.inboundProcessor.processInboundMessage(accountId, message)         // ② fire-and-forget
      .catch((e) => console.error(`处理单条消息异常, accountId=${accountId}`, e)); // ③ 仅日志兜底
  }
}
```

**触发链**

1. `getUpdates` 拉到一批消息 → `get_updates_buf` 立刻落库（①）→ 这批消息**之后永远不会再被拉到**；
2. 消息逐条 fire-and-forget 处理（②）。`processInboundMessage` 入口的 `contextTokenRepository.saveOrUpdate`、媒体下载、`handler.onMessage` 落库任何一步抛错，只走 ③ 的 `console.error`——没有 FAILED 标记、没有重投、没有任何 message_id 级幂等键；
3. 进程在 ① 之后、Agent 执行完成之前重启（或恰好 DB 抖动/媒体服务超时）：这批消息对用户**永久无响应、无重试、无告警**。

对照同仓库：钉钉 `dingtalk/message.repository.ts` 与飞书 `feishu/message.repository.ts` 均有 `claimInboundMessage`（CLAIMED 超 10 分钟可重认领 + FAILED 可重试 + DONE 拦截）。微信整条链路没有任何等效物。

**预期 vs 实际**：游标应在消息落库/入队后推进（或至少有失败可重放的认领表）；实际任一处理期异常即丢消息且无补偿。

**修复方向**：引入与钉钉/飞书同款的入站认领表（message_id 幂等键 + CLAIMED/FAILED/DONE 状态机），游标推进延后到「全批至少落库/入队成功」之后；或最低限度在 `processInboundMessage` 失败时把该消息 id 记入失败表供重放。

**去重说明**：`2026-08-30-logic-bug-review-01.md` 涉及微信的条目是扫码登录 SSRF（L-4）与 `qrcodeSessionMap` 泄漏（L-5），`2026-08-24` 涉及 abort 信号与 `tokens[0]` 发错人；本条（游标/认领缺口导致丢消息）未被报告。

---

## BUG-3【中高】重试路径线程池拒绝被 `submitExecution` 内部吞掉：phase 滞留 RESUMING，随后被孤儿巡检自动执行

**位置**

- `backend-ts/src/session/ws/streaming-ws-handler.ts:1051-1064`（`handleRetryExecution`：先 `updatePhase(RESUMING)`，再 `submitExecution`）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:489-516`（`submitExecution`：catch 就地消化，不 rethrow、不回滚 phase）
- `backend-ts/src/session/ws/streaming-ws-handler.ts:1065-1085`（外层 catch 的 `entryPhase` 回滚——被拒路径走不到这里）
- `backend-ts/src/harness/core/agent-executor.ts:54`（池满同步 `throw new AgentExecutorRejectedError`）
- 兜底行为：`crash-recovery-runner.ts:75`（RESUMING 孤儿静默阈值 45s）、`:122-128`（30s 周期巡检，`create-app.ts:2318` 已接线）、`:158`（`recoverSession` 重跑会话）

**代码事实**

```ts
// handleRetryExecution L1050-1064
await this.deps.sessionService.updatePhase(sessionId, 'RESUMING');   // 相位先推
phaseAdvanced = true;
...
this.submitExecution(sessionId, userId, executionId, (futureRef) =>
  this.runRetryExecution(...));                                      // 拒绝时内部吞掉

// submitExecution L501-515（catch 内）
} catch (e) {
  ...
  this.executionClaims.delete(sessionId);   // 簿记清了
  this.cancelFlags.delete(sessionId);       // flag 也清了
  ...
  this.deps.registry.send(userId, wsEvent('error', sessionId, {
    message: '服务器繁忙，请稍后重试', executionId,
  }));                                      // 但 phase 没回滚，异常不抛出
}
```

`submitExecution` 的 catch **不 rethrow** → `handleRetryExecution` 外层 catch（L1065-1085，内含 L1068-1074 的 `entryPhase` 回滚）**不触发** → DB phase 停留 RESUMING。

**触发链**

1. 高负载时刻线程池饱和（active≥max 且队列满），用户对某个 FAILED 会话点「重试」；
2. phase 被推到 RESUMING → 提交被拒 → 用户收到「服务器繁忙，请稍后重试」；
3. 此后 `send_message` 被 `isSessionActive(RESUMING)=true` 拒绝（session_already_running，`streaming-ws-handler.ts:391-394`），`retry_execution` 被 `isTerminalPhase(RESUMING)=false` 拒绝（「任务尚未结束，无法重试」）——与刚收到的提示直接矛盾；
4. 由于拒绝路径把 claim/flag 全清了，会话在本地无任何活跃簿记 → 约 45~75s 后被孤儿巡检判定为崩溃遗留会话，**以崩溃恢复语义自动重跑**（`recoverSession` → 清尾 + 续跑）。用户刚被告知「重试失败请稍后再试」，任务却自行跑起来烧 token；
5. 若用户在此期间点「停止」可正常收敛为 CANCELLED（`handleCancel` 的 inFlight 判定命中 `isSessionActive(RESUMING)`）；蓝绿部署窗口或本实例非 active 时巡检暂停，卡死期相应延长。

**预期 vs 实际**：预期提交被拒后相位收敛回进入时的终态（entryPhase）；实际 `entryPhase` 回滚只覆盖「`submitExecution` 之前的异常」，对 `submitExecution` 内部消化的拒绝无效。

**修复方向**：`submitExecution` 增加返回值（或接收 `onRejected` 回调）告知调用方提交失败，`handleRetryExecution` 在该分支回写 `entryPhase`；或让 `submitExecution` 在 catch 里 rethrow，由外层 catch 统一回滚。

**与历史评审的关系**：`2026-09-01-code-review-03.md` L-3 报告过同一「phase 停留 RESUMING」症状，但其列举的触发点（`registerCancelFlag`/`clearActiveToolCalls`/`registry.send` 抛异常）被作者自己标注为「实际均几乎不可能抛出」，且该文档断言「运行期不会自动收敛」。当前代码的 `entryPhase` 回滚正是修 L-3 的产物，而**线程池拒绝这条真实可达的触发路径**（提交动作本身的异常被 `submitExecution` 内部吞掉、绕开外层回滚）未被识别；且 `startPeriodicSweep`（30s）已在运行，「不收敛」结论也已过时——真实后果是「假死窗口 + 被巡检自动执行」，二者均为新事实。

---

## BUG-4【中】`open_web_page` 截断落盘不区分执行模式：LOCAL 会话拿到永远读不到的服务端路径

**位置**

- `backend-ts/src/harness/tool/impl/open-web-page-tool.ts:113-133`（截断分支返回 `full_content_file` + 指引文案）
- `backend-ts/src/harness/tool/impl/open-web-page-tool.ts:140-162`（`writeFullContent`：注释声称「LOCAL 模式不落盘」，代码无任何模式判断）
- `backend-ts/src/harness/runtime/runtime-data-resolver.ts:36-38`（`resolveWebPageCacheDir` = 服务端 `runtimeRoot/userId/sessionId/webPages`）
- `backend-ts/src/harness/tool/tool-dispatcher.ts:218`（`open_web_page` 在 `SERVER_ONLY_TOOLS`，服务端执行）、`:225-253`（LOCAL 模式 `read_file` 经 `localToolExecutor` 下发桌面端执行）

**代码事实**

```ts
// open-web-page-tool.ts:140-150
/** LOCAL 模式不落盘（内容在用户本机更合适）；写盘失败只告警，不阻断主流程。 */
private writeFullContent(userId, sessionId, url, title, fullContent) {
  if (this.cacheLocator == null || userId == null || sessionId == null) return null;
  const dir = this.cacheLocator.resolveWebPageCacheDir(userId, sessionId);  // ← 服务端目录，无 executionMode 判断
```

**触发链**

1. LOCAL（桌面）会话中模型 `open_web_page` 打开长网页（该工具是 SERVER_ONLY，抓取发生在服务端）；
2. 正文超 `maxOutputLength` → 截断，`writeFullContent` 把全文写到**服务器**磁盘，返回 `full_content_file`（服务端绝对路径）；
3. 返回文案明确指引模型：「如需被截断部分，请用 read_file…读取该文件，不要重新抓取」；
4. 模型照做调 `read_file(服务端路径)` → LOCAL 模式下该工具在**桌面端**执行 → 桌面文件系统无此路径 → 返回「文件不存在」；
5. 模型陷入「读不到 → 被禁止重新抓取」的死路，被截断内容对该会话实际不可达。CLOUD 模式不受影响（`read_file` 在服务端，`resolveLenient` 放行绝对路径）。

**预期 vs 实际**：预期（自身注释 + SERVER_ONLY 语义）LOCAL 模式不落盘、不返回 `full_content_file`；实际落盘到服务端并把不可达路径写进给模型的指引。

**修复方向**：`writeFullContent` 增加执行模式入参（调用点已知），LOCAL 时返回 null 走「落盘失败」文案分支；或把截断全文写入 LOCAL 会话的本地 runtime（`~/.mao/runtime/...` 镜像目录），与技能同步同通道。

**去重说明**：`grep open_web_page / full_content_file / 落盘 docs/code-review/` 零命中。

---

## BUG-5【中低】钉钉文本进度「正在处理」按 sessionId 进程级永久去重

**位置**

- `backend-ts/src/dingtalk/runtime.ts:165-174`（`noted` Set 与 `textProgress`）
- `backend-ts/src/dingtalk/runtime.ts:199`（无卡片模板的机器人走 `textProgress`）
- `backend-ts/src/create-app.ts:1991`（`createDingtalkRuntime` 进程启动时调用一次，`noted` 随进程生命周期存活）

**代码事实**

```ts
const noted = new Set<string>();                       // runtime 级，进程生命周期
const textProgress = (botId, event, sessionId): FeishuCardProgress => ({
  update: async (status) => {
    if (status !== 'RUNNING') return;
    const key = `${sessionId}`;
    if (noted.has(key)) return;                        // 只按 sessionId 记
    noted.add(key);                                    // 终态后无人 delete
    await sendText(botId, event, '正在处理')...
  },
});
```

**触发链**：去重的本意是压住一次执行内 `FeishuCardProgressListener` 的多次 RUNNING 推送，但键仅含 sessionId、终态（COMPLETED/FAILED/CANCELLED）时无人清理 → 同一会话第一个任务收到「正在处理」，**之后所有任务（直到进程重启）都没有任何受理回执**，用户只能干等最终回复；同时 Set 随会话数单调增长（无界泄漏）。

**预期 vs 实际**：去重粒度应为「每次执行一次」（键带 executionId，或终态时清理）；实际为「每会话每进程一次」。

**修复方向**：键改为 `${sessionId}:${executionId}`（`FeishuCardProgress.update` 链路需透传 executionId），或在 `complete/fail/cancel` 回调中 `noted.delete(key)`。

**去重说明**：`2026-09-24-dingtalk-channel-review-01.md` 涉及进度卡重试与终态正文，未涉及文本进度去重粒度；`grep textProgress/正在处理` 无对应条目。

---

## 附录 A：已核实的低severity问题（从简）

| # | 位置 | 问题 | 影响 |
| --- | --- | --- | --- |
| A-1 | `backend-ts/src/user/user.service.ts:94-101` + 路由 `user.routes.ts:107-113` | `updateUserStatus` 不校验取值，`status` 任意整数/缺省 NULL 原样落库 | 语义矛盾：本地登录只认 `status===0` 禁用（`auth.service.ts:34`），ECP 侧要求 `status===1`（`ecp-identity.repository.ts:72`）——写 5 的「半禁用」用户一边能登录一边被拒；管理端按 0/1 分组筛选时该行同时消失。对照 `model.service.ts:218-221` 有显式取值校验 |
| A-2 | `backend-ts/src/model/model.service.ts:145-147,197-203`；`agent/agent.service.ts:66-68,128-136` | 「设默认」`clearDefaultFlag()` + `updateById()` 两条独立 UPDATE，无事务 | 并发管理操作产生双默认；`findDefault()`（`model.repository.ts:76-80`、`agent.repository.ts:51-55`）`LIMIT 1` 无 ORDER BY，默认模型/Agent 不确定漂移。同文件 Agent 的 prompt 版本更新已用事务+FOR UPDATE，默认标记裸奔 |
| A-3 | `backend-ts/src/analytics/analytics.routes.ts:16-17` + `analytics.service.ts:85-97` | `/v1/analytics/trends` 的 `days` 无上限钳制 | 持 `analytics:read` 的调用方传 `days=1e8` 即发起亿次级顺序 COUNT 循环拖垮 DB；`days<=0` 静默返回空图。同类接口（llm-call、audit）均有 size 上限 |
| A-4 | `desktop/src/stores/session.ts:1081`（对照 `:1031-1035`） | `purgeSessionRuntime` 用会话 id 删 `delegateToolCallBindings`，但该 Map 以 `toolCallId` 为键 | 删除永不命中：删除会话后绑定残留（内存驻留）；toolCallId 跨会话复用（模型常生成 `call_0` 类确定性 id）时 `findSubagentByToolCallId` 可能解析到已删除子会话。08-30 报告要求补清理，本 bug 是该修复落地时删错键 |
| A-5 | `backend-ts/src/harness/skill/skill-loader.ts:76-81,97-99` | `refreshCache` 扫描目录瞬时失败（`readdirSync` 抛错）时用空集覆盖健康缓存并刷新时间戳 | 最长 `cacheSeconds`(300s) 内全部技能静默消失：`hasSkill` 全 false、Agent 配置技能被过滤、系统提示技能目录消失；目录恢复也要等缓存过期。应失败时保留旧缓存（stale 优于空） |
| A-6 | `backend-ts/src/harness/core/crash-recovery-runner.ts:158,284` + `agent-executor.ts:54` | 恢复批量 `submit` 未隔离 `AgentExecutorRejectedError`：单个拒绝同步抛出让整批循环中断 | 崩溃风暴 + 池饱和时，被拒候选之后的会话本轮全部丢恢复；靠 30s 巡检自愈（延迟 1~2.5 分钟）。应 per-candidate try/catch |
| A-7 | `backend-ts/src/auth/auth.service.ts:84`、`ecp-auth.service.ts:158`、`ldap-auth.service.ts:71`、`feishu-auth.service.ts:307` | `LoginVO.expiresIn` 硬编码 86400，与可配置的 `jwt.expiration`（`app-config.ts:151`，默认 86400000ms）脱节 | 运维收紧 token 寿命后声明值失真；仓内消费者（agent-cli `token.ts:33-39` 优先解 JWT exp、desktop 仅声明未消费）不受影响，主要误导外部 API 使用方。取 `jwt.expiration/1000` 回填即可 |

## 附录 B：已核实但剔除的候选（记录以免重复排查）

| 候选 | 剔除原因 |
| --- | --- |
| 视觉能力判定解析链缺 `agent.defaultModelId` 一级（`streaming-ws-handler.ts:1722-1725` → 图片门禁 :403-407 与监听器 :552/:920/:1104；`crash-recovery-runner.ts:470-476` 同款） | 机制经源码核实成立（解析链对照 `harness-service.ts:271-276` 缺一级）；应需求方判定「超出正常业务逻辑边界」，2026-09-30 从正榜剔除，留档以免重复排查 |
| 前端 `session_status` 不进 stale 执行过滤（`useStreamWS.ts:528,599-668` + `session.ts:1456-1476`） | 机制经源码核实成立（「停止后秒发」交错下旧执行 CANCELLED 误伤新一轮气泡登记/phase）；应需求方判定「超出正常业务逻辑边界」，2026-09-30 从正榜剔除 |
| 飞书溢出摘要缓存群/话题共用（`feishu/message.service.ts:304-307,316`，缓存读写均为群级行，查询按 threadId 分维度） | 机制经源码核实成立（同群混用话题时跨上下文错注摘要）；应需求方判定「超出正常业务逻辑边界」，2026-09-30 从正榜剔除 |
| `handleCancelSideTask` 不登记 `pendingCancels`（streaming-ws-handler.ts:966-976） | 代码缺陷属实（对照 `handleCancel:1190-1208` 有 pendingCancels + inFlight 守卫），但 `cancel_side_task` 消息类型在全仓库（desktop/agent-cli/admin/android/sdk/skills）**无任何发送方**，属死代码路径；桌面端边路停止实际走 `cancel`（`SideChatPanel.vue:900` → `useStreamWS.ts:454-456` → `handleCancel`，窗口期有 pendingCancels 保护）。若未来接入该消息类型，需补齐 pendingCancels 登记与 inFlight 守卫 |
| 消息分页游标 `nextBeforeMessageId` 取 `messages[0].id`（session.service.ts:904） | 机制成立（`selectRange` 按 `(created_at,id)` 排序而游标语义是 id 边界），但 `message.created_at` 由 DB `DEFAULT CURRENT_TIMESTAMP` 赋值（`session.repository.ts:279-295` 不显式写），单库单时钟下同秒冲突由 `id ASC` 次关键字保底，乱序需 DB 时钟回拨，实际不可触发 |
| `dispatchAskUserQuestions` 飞书进度卡表单挂载成死代码（tool-dispatcher.ts:279-289） | 死代码是事实（:279 拦截先于 :288 的 `feishuChannel` 计算），但 `harness-service.ts:463` 注释表明「飞书屏蔽提问」是既定设计，`feishuAsk` 设施属下线残留还是误杀需需求方确认 |
| `summarizeShell` 无 error 分支显示假 `(exit -1)`（tool-result-summarizer.ts:234-246） | 属实但纯展示层误导，不影响执行语义 |
| REST `PATCH /sessions/:id/messages/:messageId` 无运行中守卫（session.routes.ts:430-439） | 属实（WS 对等入口 `handleEditAndResend` 有 `isSessionActive` 拒绝），但仓内无前端消费者（desktop 走 WS、admin 只读），需直接调 API 触发 |
| `GET /v1/sessions/:id/activities` 的 limit 无上限（session.routes.ts:445-446） | 属实，但仅限会话拥有者放大自己的数据，无越权面 |
| `message-history-normalizer` 重复 toolCallId 被 Map 覆盖 → 错挂结果 + 压缩永久被拒 | 机制成立（`message-history-normalizer.ts:99` + `compaction-service.ts:250-256` 物理前缀校验），但触发依赖模型跨轮生成相同 toolCall id，当前代码路径自身不产生，置信用度不足 |
| `useChat` phase watcher 先于 `activeSessionId` watcher 触发（useChat.ts:736-777 × ChatPanel.vue:262,389） | watcher 创建顺序属实，但方向二（误注册 pendingCallbacks）的外界触发条件苛刻，且 `restoreSession` 覆盖大部分中间态，置信用度不足 |
| `sessionPhases` 只由 WS 写入、REST 永不纠正（session.ts:780-811） | 遮蔽逻辑属实，但触发需「终态 WS 事件丢失」小概率前提，且 L789 注释表明偏信 WS 是有意取舍 |
| 钉钉排队卡「立即发送」用旧快照 `row.status` 兜底（card-action.service.ts:59-64） | 属实但竞态窗口毫秒级，且被误杀的执行有终态事件兜底，影响有限 |
| `expiresIn` 硬编码（见 A-7）之外，agent-cli/desktop 均未按 expiresIn 做刷新决策 | 已并入 A-7 的影响说明 |

## 覆盖度与限制声明

- `streaming-ws-handler.ts`（1800+ 行）本轮重点覆盖了取消/重试/边路创建链路，未逐行覆盖全部分支；`dingtalk/`（27 文件）、`weixin/`（24 文件）覆盖了入站/运行时/卡片主链路，未覆盖全部媒体与绑定边角。
- android 端（Capacitor 壳 + OTA）与 admin 大部分页面本轮未覆盖（admin 由同日 `2026-09-30-frontend-review-01.md` 覆盖）。
- 所有结论基于静态代码推演，未运行构建与测试；行号对应 main @ `94cf09ad`。
