# 核心功能逻辑 BUG 评审（2026-10-01）

- **日期**：2026-10-01
- **基线**：main @ `3ef96473`（工作区干净），所有行号以当前源码实测核对。
- **范围**：`backend-ts/src`（session/WS、harness 引擎与 delegate、tool impl、schedule、notification、weixin/feishu/dingtalk 通道、permission/user、usage、command）+ `desktop/src`（stores/session 拆分模块、useStreamWS、useChat、拆分组件）+ `agent-cli` 消费链。重点覆盖 `ef4d7b12`（通道下载超时/微信入站可靠性修复）、`8672646f`（spawn_subagent 自定义标题）、`6b76ac8c`（三大文件拆分）及其后续修复提交引入/涉及的新代码。
- **方法**：四路并行分模块通读源码出题（桌面 store 拆分、桌面组件拆分、harness 引擎与 agent-cli、后端平台服务）+ WS 核心与最新修复提交由本人直读；**全部入选条目由本人逐条回读当前源码复核触发链**（含调用方、装配、WS 事件流、簿记生命周期、CSS 级联特异性），非仅采信子代理结论；随后与 `docs/code-review/` 既有 200+ 篇文档逐条 grep 去重。未运行构建与测试（纯静态评审，未改业务代码）。
- **结论**：确认 **8 个可复现的核心功能逻辑 BUG**（正榜 BUG-1 ~ BUG-8，3 中高 / 3 中 / 2 中低），另有 7 条已核实的低severity问题列入附录 A。每条给出 `文件:行号`、触发链、预期 vs 实际、影响与修复方向。
- **明确剔除的候选**（已核实不构成 BUG，或属历史文档已记录的既定取舍）见附录 B。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中高 | desktop（拆分引入的全局 CSS 污染） | `task-index-panel.css` 非 scoped 引入后，`.action-btn{width:22px}` 等通用类名泄漏全局：聊天审批「拒绝/执行」按钮被压成 22px 竖条、微信解绑按钮溢出、三个下拉空态被撑高——核心审批流 UI 必现损坏 |
| BUG-2 | 中高 | harness/delegate + session/ws（子代理重试链路） | SUBAGENT 会话走 WS 重试路径时未做子代理工具裁剪：重试出的子代理可 `spawn_subagent` 派生无人消费的嵌套任务、可 `ask_user_questions` 长时间挂起 |
| BUG-3 | 中高 | permission + user（最后管理员保护） | 「最后管理员」守卫是只读事务，禁用写在其外：并发禁用两名管理员时双双通过，系统进入零管理员状态（09-10 评审已标注残留并给出修复方向，至今未修，本条给出完整触发链升格为 BUG） |
| BUG-4 | 中 | session/ws（插队消费链路） | `handleInsertMessage` 在「删除队列项之后」的异常路径静默吞掉且无补偿：孤儿 USER 消息永不执行、队列项丢失、定时任务绑定被清，与 autoConsume 的 M-3 补偿不对称 |
| BUG-5 | 中 | harness/tool（open_web_page） | 截断全文落盘文件名仅取 URL 路径末段（无 host、无哈希），与自身注释「不同 URL 不互相覆盖」矛盾：同会话内不同网页的完整内容互相覆盖，模型读到张冠李戴的正文 |
| BUG-6 | 中 | dingtalk + feishu（入站文件落盘） | 文件按原始文件名写入按天归档目录、无任何去重：同一天同会话发同名文件，先到的被静默覆盖，历史消息的 `@{路径}@` 引用指向错误内容（图片分支有 messageId 防覆盖，文件分支没有） |
| BUG-7 | 中低 | session/ws（取消与线程池排队竞态） | 取消「排队中」的执行后立即重发：旧执行体 finally 无条件删掉**下一次执行**的 claim/cancelFlag 并释放会话资源（对照边路路径有入口取消检查，主路径缺失） |
| BUG-8 | 中低 | harness/core（工具调用流式合并） | 对「无 id、仅 index」的工具调用增量，数组未长到该位时整段静默丢弃（连第一个调用都丢）；与 2026-08-24 BUG-7 同函数、不同触发面 |

---

## BUG-1【中高】`task-index-panel.css` 非 scoped 引入泄漏通用类名：审批按钮被压扁等全局样式污染

**位置**

- 引入方式：`desktop/src/components/task/TaskIndexPanel.vue:1133-1134`（`<style src="./task-index-panel.css"></style>`，无 `scoped`；注释自述「拆分子组件后样式须为非 scoped，否则无法作用到子组件 DOM」）
- 污染源：`desktop/src/components/task/task-index-panel.css:405`（`.action-btn { display:flex; align-items:center; justify-content:center; width:22px; height:22px; ... }`）、`:73`（`.panel-loading, .panel-empty { display:flex; align-items:center; justify-content:center; height:80px; ... }`）、`:39`（`.refresh-btn { width:28px; height:28px; background:transparent; ... }`）
- 受害者一（核心）：`desktop/src/components/chat/ApprovalStack.vue:42,47`（命令审批「拒绝/执行」按钮 `class="action-btn reject|approve"`）；其 scoped 规则 `:279-290` 只声明 `height:28px; padding:0 14px; border...`，**未声明 `width`/`display`/`justify-content`**
- 受害者二：`desktop/src/views/settings/WeixinBotView.vue:16`（解绑按钮 `class="action-btn action-btn-danger"`；scoped 规则未声明 `width`，`fd51d807` 补的 `white-space:nowrap` 只防换行不防压扁）
- 受害者三：`desktop/src/components/chat/QuickCommandPanel.vue:3,165`、`desktop/src/components/chat/FileReferencePanel.vue:3-6,157`、`desktop/src/components/ScheduledTaskPanel.vue:103`（`.panel-empty`/`.panel-loading` 空态与加载态）
- 受害者四（轻）：`desktop/src/components/common/TopNav.vue:523`、`desktop/src/components/center/FileViewer.vue:400`（`.refresh-btn`）

**代码事实**

```css
/* task-index-panel.css:405 —— 无任何命名空间，全局生效 */
.action-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; ...
}
/* ApprovalStack.vue:279（scoped → .action-btn[data-v-x]，特异性更高但只覆盖己声明属性） */
.action-btn {
  height: 28px; padding: 0 14px; border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline); ...
  /* 没有 width / display / justify-content —— 全局值全部漏入 */
}
```

`desktop/src/style.css:161` 全局 `box-sizing: border-box`：ApprovalStack 按钮内容宽 = 22 − 28(padding) − 2(border) < 0，两字按钮被压成 22px 竖条、文字逐字竖排/溢出胶囊。scoped 选择器特异性更高，但对**全局声明而 scoped 未声明的属性**（width/display/justify-content/height:80px 等）无从竞争，必然生效。

**触发链**

1. `6b76ac8c` 拆分 TaskIndexPanel/ChatInput 时丢失 style 块，`2ed7977e` 恢复样式时改为共享 CSS **非 scoped** 引入（子组件 DOM 需要命中）；
2. 通用类名 `.action-btn`/`.panel-empty`/`.panel-loading`/`.refresh-btn` 未加前缀，随首页（路由 `/` → TaskView → TaskIndexPanel，CSS 必然注入 document）全局生效；
3. 聊天区 `ChatPanel.vue:124` 渲染 `ApprovalStack` → 命令审批（SMART/READ_ONLY/READ_WRITE 级的核心交互）按钮全部命中 `width:22px` + `display:flex` → 压扁；
4. `fd51d807`（「修复聊天区工具分组标题被全局样式污染」）只修了 ToolCallGroup 一处并误归因于「窄屏 flex 挤压」，同类污染至少还有上述 4 组残留。

**预期 vs 实际**：预期共享 CSS 只作用于任务侧栏家族；实际所有同名类消费者（含聊天审批、微信设置页、聊天下拉）都被注入了任务侧栏的盒模型，核心审批流 UI 必现损坏。

**修复方向**：给 `task-index-panel.css` 内通用类名加命名空间（`task-` 前缀），或改回 scoped + 在子组件上用 `:deep()`/继承方案；并逐一复核 ApprovalStack / WeixinBotView / QuickCommandPanel / FileReferencePanel / ScheduledTaskPanel / TopNav / FileViewer 七处消费端。已核实无碰撞的 `.toolbar/.add-btn/.file-name/.model-name` 等可不改。

**去重说明**：grep `task-index-panel.css / action-btn / 样式污染 / 全局样式` 在历史 200+ 篇评审中零命中；`2026-09-30-oversized-files-split-review.md` 与 `fd51d807` 均未识别此根因。

---

## BUG-2【中高】SUBAGENT 会话走 WS 重试路径时未做子代理工具裁剪：可派生嵌套子代理、可向用户提问

**位置**

- 重试入口：`backend-ts/src/session/ws/streaming-ws-handler.ts:1019-1033`（`handleRetryExecution` 对 `sessionType === 'SUBAGENT'` 专门做了 beginRetry/completeRetry 簿记）、`:1101-1120`（`runRetryExecution` → `harnessService.executeFromEvent`）
- 上下文构建：`backend-ts/src/harness/core/harness-service.ts:261-438`（`buildContext` 只有通道过滤 `filterToolsForSession` 与 page_* 过滤，**无任何 `sessionType === 'SUBAGENT'` 分支**；`:325` 起全量注入 `getAllTools()`）
- 对照正确实现：`backend-ts/src/harness/delegate/background-subagent-manager.ts:850-868`（`buildSubContext` 的 `excluded` 裁剪）、`:18-27`（`BACKGROUND_SUBAGENT_TOOLS` + `SUBAGENT_EXCLUDED_TOOLS = ['ask_user_questions', 'dingtalk_send_image', 'dingtalk_send_file']`）；恢复路径 `backend-ts/src/harness/delegate/subagent-execution-recovery.service.ts:74` 同样用 `buildSubContext`
- 放行闸门：`backend-ts/src/harness/core/agent-loop.ts:627-630`（`isToolAllowed` 只查 `context.tools`，buildContext 给了什么就放行什么）

**代码事实**

```ts
// background-subagent-manager.ts:850-863 —— 正常后台执行/恢复路径都有裁剪
const excluded = new Set(['delegate', 'delegate_followup',
  ...BACKGROUND_SUBAGENT_TOOLS, ...SUBAGENT_EXCLUDED_TOOLS, ...]);
ctx.tools = ctx.tools.filter((t) => !excluded.has(t.getName()) && ...);

// streaming-ws-handler.ts:1120 —— 唯独重试路径直连标准 buildContext
await this.deps.harnessService.executeFromEvent(sessionId, executionId, listener, cancelFlag);
```

**触发链**

1. 后台子代理执行失败（子代理会话 phase=FAILED）→ 用户在子代理会话面板点「重试」；
2. `handleRetryExecution` → beginRetry（execution 置回 RUNNING）→ `runRetryExecution` → `executeFromEvent` → `buildContext` 装载**全量工具**（含 `spawn_subagent`、`subagent_followup`、`check_subagent`、`delegate`、`ask_user_questions`、`dingtalk_send_image` 等被 SUBAGENT 排除集合裁掉的工具）；
3. 重试出的子代理模型可以：
   - 调 `spawn_subagent` 派生以**子代理会话为父**的嵌套后台任务——其结果无任何消费方（主代理只按顶层父会话 `consumeResults`，嵌套结果最终被 AgentLoop finally 的 `clearResults` 清掉），产生无人消费的执行记录与前端面板条目；
   - 调 `ask_user_questions`（无通道/提问豁免）挂起等待——而后台子代理的设计前提是「无法与用户交互」（spawn_subagent 工具提示词原文）；桌面不在线时最挂满 15 分钟超时（`ask-user-questions-registry.ts:4`），期间重试执行一直占着会话。

**预期 vs 实际**：预期重试与正常后台执行/崩溃恢复走同一能力面（`buildSubContext` 裁剪后执行）；实际唯独重试路径绕过裁剪，重试出的子代理比原执行多出一批不该有的工具。

**影响**：子代理重试后权限面/能力面与设计不变量不一致；嵌套 spawn 产生孤儿执行记录与 UI 噪音；`ask_user_questions` 可让「重试」长时间挂起。

**修复方向**：`runRetryExecution` 检测 `session.sessionType === 'SUBAGENT'` 时改走 `backgroundSubagentManager.buildSubContext + executePrepared`（与恢复协调器同构），或在 `buildContext` 内对 SUBAGENT 会话统一应用 SUBAGENT_EXCLUDED_TOOLS 裁剪。

**去重说明**：grep `runRetryExecution / SUBAGENT_EXCLUDED / 子代理重试` 历史零命中；子代理重试功能本身（beginRetry/completeRetry）此前未被评审过。

---

## BUG-3【中高】「最后管理员」守卫与禁用写不原子：并发禁用两名管理员双双通过，系统进入零管理员

**位置**

- 守卫：`backend-ts/src/permission/permission.service.ts:187-211`（`assertNotLastAdmin`：`userRoleRepo.transaction` 内 `findByRoleIdForUpdate` 锁 ADMIN 绑定、计数「其他活跃管理员」后**提交空事务**；注意 `:204` 对用户行的读取 `this.userRepo.findById` 走的是**非事务连接**）
- 写入：`backend-ts/src/user/user.service.ts:94-101`（`updateUserStatus`：先守卫，后 `user.status = status; await this.userRepo.updateById(user)` 在守卫事务之外落库）；`:75-80`（`updateUser` 的 status 分支同构）
- 对照同文件正确写法：`user.service.ts:87-88` 注释自述「changeRolesWithAdminGuard 在同一事务内锁 ADMIN 绑定并做最后管理员检查 + 写入」——角色变更路径检查+写入同事务，禁用路径只有检查在事务里。

**代码事实**

```ts
// user.service.ts:94-101
const user = await this.getUser(id);
if (status != null && status === 0) {
  await this.permissionService.assertCanDisableUser(id, currentUserId); // 只读事务，锁完即提交
}
user.status = status ?? null;
await this.userRepo.updateById(user);                                    // 另一条连接单独写

// permission.service.ts:198-210 —— 守卫事务内不写任何数据
await this.userRoleRepo.transaction(async (tx) => {
  const bindings = await tx.findByRoleIdForUpdate(adminRole.id!);        // FOR UPDATE 串行化守卫
  ...
  if (otherActive === 0) throw new BusinessException(ErrorCode.CANNOT_REMOVE_LAST_ADMIN);
});                                                                       // 事务提交，无数据变更
```

**触发链**

1. 系统仅剩两名活跃管理员 A、B。操作者 1 发 `PUT /v1/users/A/status {status:0}`，操作者 2 并发发 `PUT /v1/users/B/status {status:0}`；
2. 请求 1 的守卫事务锁 ADMIN 绑定行 → 统计「其他活跃管理员」= B（status=1）→ 通过，事务提交（无数据变更）；其 `updateById(A.status=0)` 尚未执行/未提交；
3. 请求 2 的守卫事务在绑定行锁上排队，拿到锁后通过非事务连接读 A 的 status——此刻请求 1 的 status 写尚未落库 → 读到 1 → 「其他活跃管理员」= A → 通过；
4. 两个请求各自落库 → **A、B 同时被禁用，系统零管理员**。`user:write` 仅管理员持有，此后无人能启用账号/改角色，只能改库修复。

**预期 vs 实际**：预期守卫与禁用写原子，并发双禁用至少一个被拒；实际 FOR UPDATE 串行化的只是「守卫读」本身，被保护的状态变更（status 写）游离在锁事务之外，串行化形同虚设。

**影响**：零管理员锁死；触发条件是两次管理员禁用操作的并发（管理台双开/双人操作即可），窗口为数毫秒的读写交错，但守卫机制的设立初衷正是消除此类窗口。

**修复方向**：把 `status` 写入并入 `assertNotLastAdmin` 的锁事务（守卫事务内对目标用户行条件更新并返回结果），或对目标用户行一并 `FOR UPDATE` 后在同一事务内条件更新——`2026-09-10-code-review-03.md:88` 已给出同方向建议。

**去重说明**：`2026-09-10-code-review-02.md`（P3「有残留」）与 `-03.md`（R4b 验收 + `:88` 修复方向）已把「角色路径闭环、status 写在事务外」标注为已知残留；本条将其升格为可复现 BUG 条目——给出并发双禁用 → 零管理员的完整触发链与影响量化，该残留至今未修。同源附带：`updateUser` 的 `status` 分支同样不校验取值（可写入任意整数，同 `2026-09-30-logic-bug-review-01.md` A-1 的第二入口）。

---

## BUG-4【中】插队消费在「删除队列项之后」异常静默无补偿：孤儿消息 + 队列项丢失

**位置**

- `backend-ts/src/session/ws/streaming-ws-handler.ts:1305-1311`（`saveMessage` → `delete(queueId)` → `sendQueueUpdated` → `scheduleForFirstUserMessage` → `registry.send(queue_message_consumed)`，中间任何一步抛出即进 catch）、`:1322-1326`（catch：删三个簿记集合，**无日志、无事件、无补偿**）
- 对照同文件已修复的同类窗口：`:1416-1438`（`autoConsumeQueue` 的 M-3 补偿：删孤儿 USER 消息 + `enqueueHead` 回补队首 + 推送 + 全程 `console.error`）

**代码事实**

```ts
// :1305-1307 —— 删队列行之后、交给 handleSendMessage 自愈之前没有补偿伞
const savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', messageContent, ...);
await this.deps.messageQueueService.delete(queueId);
await this.sendQueueUpdated(sessionId, userId);   // 内部 listPending，DB 抖动即抛
...
} catch {                                          // :1322
  this.autoConsumingSessionIds.delete(sessionId);
  this.executionClaims.delete(sessionId);
  this.queueScheduledTaskIds.delete(sessionId);    // 静默吞掉
}
```

**触发链**

1. 用户对队列消息点「插队」→ 旧执行取消、占位成功、`saveMessage` 落库、`delete(queueId)` 删除队列行；
2. `sendQueueUpdated`（内部 `messageQueueService.listPending` 查库）因 DB 抖动抛异常 → 进入 1322 行 catch；
3. 结果：USER 消息已在会话历史中但**永不执行**（下次执行时模型看到一条从未被回答的旧提问）；队列项已删、不回补——消息事实性丢失；若该项绑定 `scheduledTaskId`，绑定被清，定时任务永久停留 QUEUED（`onScheduledTaskQueueConsumed` 永不回调）；
4. 全程无日志、无前端提示，不可观测。

`handleSendMessage` 内部（`:447-457`、`submitExecution` 的 `requeueIfClaimed`）只自愈**它自己**的失败路径；`prepareMessage` 抛出、`requireOwnedSession` 失败等直接落进插队 catch 的场景同样命中此缺口。

**预期 vs 实际**：预期与 autoConsume 的 M-3 修复对齐——删孤儿消息或回补队首并告知用户；实际三无（无补偿/无日志/无事件）。同一窗口在自动消费路径已被认定为必修 BUG（M-3），插队路径是同源漏改点。

**修复方向**：把 1305-1311 包进带 stage 的补偿（对照 `:1419-1438` 的 `compensate`）：`savedMessageId` 非空时 `deleteMessageById`，队列行已删时 `enqueueHead(content, images, scheduledTaskId)` 回补，catch 至少 `console.error` + `sendQueueUpdated`。

**去重说明**：`2026-09-10-logic-bug-review-01.md` 的插队条目是「已消费队列项 status 校验缺失导致重复执行」（已修）；`2026-09-21-logic-bug-review-01.md` B05/B06 是 autoConsume 路径的补偿窗口（已修 M-3）。本条（insert 路径 delete 之后无补偿）未被报告。

---

## BUG-5【中】`open_web_page` 截断全文落盘文件名碰撞：不同网页互相覆盖，模型读到张冠李戴的正文

**位置**

- `backend-ts/src/harness/tool/impl/open-web-page-tool.ts:219-238`（`urlSlug` 及其注释）、`:166-173`（`finalPath = join(dir, ${stem}.md)`，dir 为按用户+会话隔离的 `webPages` 目录）
- 消费链：`:121-135`（截断分支返回 `full_content_file` 并指引模型「用 read_file 读取该文件，不要重新抓取」）

**代码事实**

```ts
// :219-221 注释承诺：「保证同一 URL 反复抓取覆盖同一文件，不同 URL 不互相覆盖」
function urlSlug(url: string): string {
  ...
  const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
  const base = (seg.replace(/\.[a-z0-9]{1,8}$/i, '') || u.hostname.replace(/^www\./, ''))
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (base !== '') return base;          // ← 只取路径末段，不含 host、不含任何哈希
  const digest = Buffer.from(u.toString(), 'utf8');   // 兜底分支也仅取 URL 尾 12 字节 hex
  return 'page-' + (digest.length > 12 ? digest.subarray(digest.length - 12).toString('hex') : ...);
}
```

**触发链**

1. 同一会话中，模型先 `open_web_page` 打开 `https://docs.a.com/guide/intro`，正文超限被截断，全文落盘 `<dir>/intro.md`，工具结果把该绝对路径交给模型并要求「不要重新抓取」；
2. 随后模型抓取 `https://wiki.b.com/manual/intro`（或同站 `https://docs.a.com/api/intro`）——两者 `urlSlug` 均为 `intro` → **覆盖写同一文件**；
3. 模型按第一步结果 `read_file(intro.md)` → 成功读到，但内容是第二个网页的——文件读取成功，模型无从发现错配，把 B 页内容当作 A 页的「被截断部分」继续推理。

文档站末段高度雷同（`index`/`README`/`intro`/`api`），命中是日常事件而非边缘构造。

**预期 vs 实际**：预期（自身注释 + 该机制的全部意义）「不同 URL 不互相覆盖」；实际同名末段互相覆盖且无任何告警。

**影响**：被截断内容不可信——模型基于错误网页内容继续任务，属于静默的数据正确性破坏。

**修复方向**：`urlSlug` 并入 host（如 `docs.a.com-guide-intro`）与 URL 短哈希（`createHash('sha1').update(url).digest('hex').slice(0, 8)`）即可满足注释承诺；兜底分支同理用真哈希而非尾字节。

**去重说明**：`2026-09-30-logic-bug-review-01.md` BUG-4 报的是「LOCAL 模式不该落盘」（已修）；本条是落盘文件名碰撞，grep `urlSlug / 覆盖` 历史零命中。

---

## BUG-6【中】钉钉/飞书入站文件按原文件名落盘：同日同名文件互相覆盖，历史引用被静默篡改

**位置**

- 钉钉：`backend-ts/src/dingtalk/runtime.ts:567-574`（文件分支 `name = sanitizeName(context.fileName, ...)` → `writeFile(target, ...)` 直接覆盖；对照同函数图片分支 `:582` 用 `dingtalk-image-${context.messageId}` 唯一命名）
- 飞书 p2p：`backend-ts/src/create-app.ts:1640-1644`（`sanitizeFeishuFileName(context.fileName, ...)` 原名落盘；对照图片分支 `:1617` 用 `feishu-image-${messageId}`，注释明言「防覆盖」）
- 飞书群：`backend-ts/src/create-app.ts:1788-1789`（同构，原名落盘）
- 目录口径：`backend-ts/src/feishu/chat-files.ts:10-13`（`{workspace}/chat-files/{yyyy-MM-dd}/`，按天归档——同一天内必然同目录）

**代码事实**

```ts
// dingtalk/runtime.ts:567-574 —— 文件分支：无任何去重
if (isFile) {
  const dir = chatFilesDirOf(workspace);            // {workspace}/chat-files/{yyyy-MM-dd}/
  mkdirSync(dir, { recursive: true });
  const name = sanitizeName(context.fileName, `dingtalk-file-${context.messageId}`);
  const target = resolve(dir, name);                // message id 只用作兜底名，原名存在时不参与
  await writeFile(target, downloaded.buffer);       // 直接覆盖
  filePaths.push(target);
} else {
  ...
  const name = `dingtalk-image-${context.messageId}${ext}`;   // 图片分支有防覆盖
```

**触发链**

1. 同一钉钉 p2p 会话（或飞书会话）同一天内，用户先发送 `报价.docx`（v1），消息以 `@{.../chat-files/2026-10-01/报价.docx}@` 持久化，Agent 基于它作答；
2. 随后用户发送内容不同的同名 `报价.docx`（v2）→ `writeFile` 直接覆盖 v1；
3. 历史消息里的 `@{path}@` 引用不变，但文件内容已是 v2——Agent 按旧引用读到新文件，产出错误答案且无任何告警；旧版本不可恢复。

**预期 vs 实际**：预期历史引用的内容不可变；实际被静默覆盖。同一套代码内图片分支都以 messageId 唯一命名并注释「防覆盖」，文件分支没有——是遗漏而非约定。

**影响**：对话文件引用指向错误内容（数据正确性破坏 + 旧版本丢失）；日常场景（用户反复发送同名报表/合同的不同版本）即可触发。

**修复方向**：文件分支与图片分支对齐，原名冲突时改用 `${messageId}-${原名}` 或并入内容短哈希；或落盘前 `existsSync` 追加序号（同仓微信 `file-storage.service.ts:83-96` 已有该模式的选名实现可参照）。

**去重说明**：`2026-08-06-code-review-05.md` #2 报过「同名文件选名与写入非原子、并发互相覆盖」，但对象是另一条存储路径的**并发**窗口（uniquePath 存在性检查竞态）；本条是 dingtalk/feishu chat-files 路径**串行场景下完全没有防覆盖机制**，路径与成因均不同。

---

## BUG-7【中低】取消「排队中」执行后立即重发：旧执行体 finally 误删下一次执行的簿记并提前释放会话资源

**位置**

- 主路径无入口取消检查：`backend-ts/src/session/ws/streaming-ws-handler.ts:526-532`（`runExecution` 拿锁后直接 `updatePhase('RUNNING')` 并广播）；对照边路路径 `:898-905` **有** `if (flag.get())` 入口检查——同一文件内自相矛盾
- finally 无条件回收：`:570-597`（`executionClaims.delete` / `cancelFlags.delete` / `removeCancelFlag` / `pendingCancels.delete` / `releaseSessionExecutionResources` 全部按 sessionId 无身份守卫）
- 制造窗口的取消路径：`:1223-1229`（`handleCancel` 对已注册 flag 的执行：置位 + 落 CANCELLED + `releaseExecutionBookkeeping`）；`:1636-1649`（`releaseExecutionBookkeeping` 仅 `future` 有同一性判断，claim/flag 无）

**触发链**

1. 线程池饱和，发送 A 的 `runExecution#1` 在池队列中排队（flag 已注册、claim 已占）；
2. 用户点停止 → `handleCancel`：cancelFlags.has 为 true → 落 CANCELLED + `releaseExecutionBookkeeping`（claim/flag/runningTasks 全清）→ 簿记归零；
3. 用户立即重发 B：phase=CANCELLED 非活跃、claim 已空 → 新 claim/flag2 注册、future#2 入队（排在 #1 之后）；
4. 池先跑 #1：入口不查取消标志，直接 `updatePhase(RUNNING)` 并广播 RUNNING、白做 skillSync/MCP 连接，AgentLoop 靠 DB 相位（`isTerminalPhaseInDb`）在首轮才退出；
5. **#1 的 finally 无条件删掉 #2 的 executionClaim、cancelFlags、AgentLoop cancelFlag，并执行 `releaseSessionExecutionResources`（关 shell、failAllForSession、清技能/MCP 注册表）→ #2 才开始真正执行。**

**预期 vs 实际**：预期旧执行体只回收自己的簿记（`runningTasks`/`runningExecutionIds` 有 identity 判断，claim/flag 没有）；实际 #2 运行期间该会话从 `listActiveExecutionSessionIds` / `agentLoop.listActiveSessionIds` 消失（停机排空与孤儿巡检误判其不活跃），用户在 #2 执行中点停止走 `pendingCancels` 慢路径、依赖 DB 相位兜底才收敛。

**影响**：要求「池排队 + 取消 + 立即重发」的时序，概率低但链路完整成立；后果是簿记失真与已取消执行的白做开销，不丢数据。

**修复方向**：`runExecution` 入口补 `if (flag.get()) { await this.finishCancelledSession(...); return; }`（与边路路径 `:901-905` 对齐）；finally 的 claim/cancelFlags 回收改为只回收属于自己的对象（保存 flag/claim 引用做同一性判断）。

**去重说明**：`2026-09-28-logic-bug-review-02.md` B11 附带条目是**定时任务**路径「提交后无启动前取消复查」（CANCELLED→RUNNING 翻转）；本条是 WS 主路径的同源缺口 + finally 跨执行误删簿记，未被报告。

---

## BUG-8【中低】工具调用流式合并对「无 id、仅 index」的分片整段静默丢弃

**位置**

- `backend-ts/src/harness/core/agent-loop.ts:653-661`（`findMergeTarget`）、`:641-650`（`mergeToolCall` 的 push 分支要求 `delta.id`）
- id 归一化：`backend-ts/src/harness/llm/json.ts:113-115`（`parseToolCalls` 把空 id 归一为 `undefined`）；流式路径确认走此解析：`json.ts:209,225`（`parseStreamChunk` → `toolCalls: parseToolCalls(delta.tool_calls)`），openai 适配器 `:306` 消费

**代码事实**

```ts
private findMergeTarget(existing, delta) {
  if (delta.id) return existing.find((tc) => tc.id === delta.id);
  if (delta.index != null) return existing.find((tc) => tc.index === delta.index) ?? existing[delta.index];
  return existing.length > 0 ? existing[existing.length - 1] : undefined;
}
...
} else if (delta.id) { existing.push(delta); merged = delta; }   // 只有带 id 才新建
```

上游网关若只按 `index` 分片、从不发 `id`（部分 OpenAI 兼容网关/vLLM 行为）：第一个分片（index=0）到达时 `existing=[]`，按 index find 未命中、`existing[0]` 为 undefined → merged 为空；又因 `delta.id` 为空，push 分支不走 → **该工具调用整体丢失**（后续同 index 分片同样命不中）。并行多调用时从第二个起全部丢失。

**预期 vs 实际**：预期 `?? existing[delta.index]` 的按位兜底在数组未长到该位时应按「新 tool call」追加；实际静默丢调用，模型侧已「发起」而循环侧根本没有这个调用。

**影响**：特定网关下工具调用随机丢失/参数缺失；OpenAI 官方与主流网关首片带 id、Anthropic 适配器自造 id，均不受影响，故置中低。该分支的存在本身说明要兼容无 id 流，而它对无 id 流是错的。

**修复方向**：`merged` 为空且 `delta.index != null` 时按 `existing[delta.index]` 位置就地创建占位（或先 `existing.push(delta)` 再按 index 归位），并允许后续分片补 id。

**去重说明**：`2026-08-24-logic-bug-review-01.md` BUG-7 报的是同一函数「无 id **无 index** 时错误合并到最后一个调用」；本条是「有 index 无 id 且数组未长到该位时整段丢弃」，触发条件与后果（丢弃 vs 错并）均不同，属同函数第二触发面。

---

## 附录 A：已核实的低severity问题（从简）

| # | 位置 | 问题 | 影响 |
| --- | --- | --- | --- |
| A-1 | `backend-ts/src/harness/core/agent-loop.ts:393-407` + `:494`；`background-subagent-manager.ts` `onCompleted` | 父循环 break 判定「无运行且无待收结果」与 finally `clearResults` 之间存在 await 窗口：后台子代理恰在此刻完成则结果被 `clearResults` 销毁，且状态已写 DELIVERED，恢复链路（只扫 PENDING）不再投 | 模型收不到该子代理的结构化结果注入（`persistCompletionNotice` 的纯文本通知仍在）；窗口极窄，命中即不可逆 |
| A-2 | `backend-ts/src/harness/delegate/background-subagent-manager.ts:308-347`（completeRetry 传 `null` refs）+ `:378-400`（snapshot） | 子代理重试路径没有 context/collector：重试结束后投递给主代理的结果 payload 恒为 `rounds:0, tool_calls:0` 无 usage；重试期间 `check_subagent` 读到上一轮遗留统计（beginRetry 未清空） | 统计口径失真，不影响状态收敛 |
| A-3 | `desktop/src/composables/useChat.ts:777-785` × `streaming-ws-handler.ts:1067-1077` | 编辑重发后提交被线程池拒绝：服务端已完成 `editMessageAndTruncate`（编辑已持久化、后续已截断）并回滚相位，客户端却把消息列表整体回滚为编辑前快照 | 服务端与客户端消息树分歧（旧内容+已删尾巴），下次 `fetchMessages` 后自愈；仅 UI 短暂失真 |
| A-4 | `backend-ts/src/auth/ecp-session.repository.ts:72-90` | ECP session 先 `findByUserId` 再 `insert`，唯一键 `uk_user_ecp_session_user` 下并发首次登录第二条 insert 抛 `ER_DUP_ENTRY` → 登录 500（应 upsert 或捕获重试） | 低概率登录失败 |
| A-5 | `backend-ts/src/dingtalk/pending-binding.repository.ts:54-59`、`oauth.repository.ts:28-55` | TTL 比较混用两种时钟：用 DB `CURRENT_TIMESTAMP` 比较应用侧按 Asia/Shanghai 墙钟写入的 `expires_at`（feishu/ecp 同型比较用应用侧 `formatNow()`）；MySQL 会话时区非上海时 3 分钟 TTL 膨胀/收缩 8 小时 | 依赖部署时区配置；代码内口径不一致是事实 |
| A-6 | `backend-ts/src/dingtalk/monitor.service.ts:147-160` | `reconnect` 删除 active 条目后 `void this.reconcile()`：若此刻恰有 reconcile 在跑（`reconciling` 守卫直接 return），该 bot 要等下一周期才重连 | 管理端「重连」显示已调度但延迟生效 |
| A-7 | `backend-ts/src/dingtalk/agent-inbound-handler.ts:405-410`（abandoned 分支）× `:488-493`（写入） | `---` 切换会话后 abandoned 分支只丢弃队列，不清理 `pendingAttachments` 中已 stash 的附件条目 | 按 sessionId 的 Map 项永久驻留内存（量小） |

## 附录 B：已核实但剔除的候选（记录以免重复排查）

| 候选 | 剔除原因 |
| --- | --- |
| 微信入站认领表以内容指纹做幂等键：同用户 24h 内逐字重发同一内容（「继续」「嗯」）第二条被静默吞掉 | 机制属实，但为 `ef4d7b12` 的既定取舍且已被作者自己的评审记录：`docs/code-review/2026-09-30-fix-review-01.md:55-59` 报告、`2026-09-30-fix-review-02.md` P2-1 以「DONE 24h 去重窗口 + reclaimForResend」收口，明确接受窗口内的语义重叠。ilink 协议确无消息 id，彻底解法需协议层配合 |
| `fetchBytesWithLimits` 的 readTimer 是「首字节后总时长」而非字节间空闲超时，慢速 drip 30s 即被掐 | 语义收紧（比无限等待更安全），属设计取舍非 bug |
| `submitExecution` 返回值改造后 `handleSendMessage`/`handleEditAndResend` 忽略返回值 | 两处在提交前未推进相位，`submitExecution` 内部自回滚足够，行为自洽（`2026-09-30-fix-review-01.md` 已核） |
| 插队校验后、abort 等待前队列项被 autoConsume 消费的竞态 | `streaming-ws-handler.ts:1284-1292` 已有二次 status 校验兜底 |
| spawn_subagent 自定义标题（`8672646f`）的 `cleanTitle` 截断可劈开 emoji 代理对 | 仅影响超 40 字标题末字符显示为替换符，纯装饰性 |

## 覆盖度与限制声明

- `streaming-ws-handler.ts`（1800+ 行）本轮覆盖了发送/取消/重试/插队/队列消费/边路创建/子代理重试主链路及最新修复点，未逐行覆盖 skill/mcp 同步细节分支；`background-subagent-manager.ts`（900+ 行）覆盖了 spawn/重试/收尾/投递主链路。
- 桌面端覆盖了 store 拆分五模块（与 `03e35910` 旧版逐函数比对，list/messages/sideTask/subagent 均忠实）、useStreamWS、useChat、两大组件拆分（含样式级联复核）；admin 前端、android 壳、electron main/preload 本轮未覆盖。
- 后端平台服务（file/oss/auth/user/settings/preference/feedback/permission/agent/statistics/analytics、dingtalk 除上述条目）已由并行路覆盖并逐条复核，未发现其他核心逻辑缺陷（详见附录 A-4 ~ A-7 与正文 BUG-3/BUG-6）。
- 所有结论基于静态代码推演，未运行构建与测试；行号对应 main @ `3ef96473`。
