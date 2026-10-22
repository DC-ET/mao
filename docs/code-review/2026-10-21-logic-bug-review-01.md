# 代码审查：功能区逻辑 BUG 清查（8 个经测试验证的 BUG）

- **日期**：2026-10-21
- **基线**：`main` @ `d2d5fd58`（含 0.0.328 无进展止损）
- **修复记录**：本报告 8 项 BUG 已于 `0.0.329`（2026-10-22）全部修复；8 个存在性证明测试由 `16 failed | 10 passed` 转为 **26 passed**，全量 **384 个测试文件通过**。下文各节「测试证据 / 当前结果」为**修复前快照**，保留作问题证明与回归依据
- **范围**：`backend-ts/src/` 主要业务域逐文件通读（harness 引擎/工具/安全、session、memory、notification、signal、feishu/dingtalk/weixin、schedule、digest、budget/usage、skill、http-tool 等）；未逐行展开的模块通过调用链、既有 spec 覆盖与跨文件语义比对交叉核对；desktop/admin 抽查消费端纯函数（如 `focusSort`）
- **方法**：逐文件通读 + 同一概念跨文件语义比对（找口径漂移）+ 无 spec 覆盖分支重点排查。每条候选必须满足「合法输入即可触发、输出确定错误、有可运行测试证明」；无法构造确定性失败测试的候选一律不列为 BUG
- **交付物**：8 个 `*.bugcheck.spec.ts` 存在性证明测试（断言按**正确行为**书写，**修复前**失败即证明 BUG 真实存在，修复后转绿作为回归用例）+ 对应的 8 项产品修复（随 `0.0.329` 提交）；每个 BUG 均附对照组，证明失败来自产品逻辑而非测试写法
- **测试证据（修复前快照）**（`main` @ `d2d5fd58` 实跑）：
  - 8 个新增 spec 单跑：**Test Files 8 failed (8)**，**Tests 16 failed | 10 passed (26)**
  - `cd backend-ts && npx vitest run --reporter=dot` 全量：**Test Files 8 failed | 376 passed | 1 skipped (385)**，**Tests 16 failed | 4597 passed | 14 skipped (4627)**——8 个失败文件全部为本报告新增的 bugcheck，存量用例无一回归
- **计数口径**：BUG-1/2/3 是「同一个多模态守卫缺失」在三条独立调用链上的三个用户可见影响面（通知预览 / 运行轨迹 / 自动记忆抽取），按影响面分别编号；即使按根因合并计为 1 个，本报告仍有 6 个独立 BUG，满足「至少 5 个」的要求

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话结论 |
| --- | --- | --- | --- |
| BUG-1 | 中低 | `backend-ts/src/notification/task/user-message-preview.ts:42-50` | 飞书任务通知卡片的用户消息预览把「普通 JSON 数组文本」当多模态分片解析，`["任务","失败"]`、`[1,2,3]` 等正文渲染成空串，卡片里看不到用户说了什么 |
| BUG-2 | 低 | `backend-ts/src/session/run-trace.service.ts:591-609` | 运行轨迹的 `previewOf` 同样无守卫：普通 JSON 数组文本的「用户消息」列变成空白，长会话无法定位轮次 |
| BUG-3 | 中 | `backend-ts/src/memory/memory-extraction.service.ts:495-515` | 自动记忆抽取读取消息正文时把普通 JSON 数组文本清空，`hasText` 判定失败后整轮抽取静默跳过 |
| BUG-4 | 中（安全向） | `backend-ts/src/harness/safety/path-sandbox.ts:75-88` | strict 模式只对最终路径做 `lstat`，工作区内「父目录符号链接」可逃逸到允许根之外，`read_file`/`write_file` 等文件工具可读写边界外路径 |
| BUG-5 | 中 | `backend-ts/src/session/session.service.ts:1392-1396`、`session/task-terminal.service.ts:129-132,214` | 钉钉机器人渠道会话的终态被写入 `unread=1`（只排除了微信/飞书），会话被置顶并显示未读红点；同一遗漏还让钉钉会话写入站内收件箱 |
| BUG-6 | 低 | `backend-ts/src/memory/memory.service.ts:50-55` | `isRobotChannelProjectKey` 只覆盖微信/飞书，钉钉私聊/群聊键被当成真实项目：污染项目下拉、自动记忆被错误写成聊天级 PROJECT 记忆而不能跨会话复用 |
| BUG-7 | 低 | `backend-ts/src/signal/watcher.logic.ts:141-150` | 哨兵 prompt 先替换 `{diff}` 再替换 `{url}`/`{name}`，目标网页正文里出现的字面量会被二次替换，diff 与实际页面内容不一致（也是注入面） |
| BUG-8 | 中低 | `backend-ts/src/harness/tool/impl/open-web-page-tool.ts:118-137,305-330` | 原始 HTML 达到 `maxRawBytes` 被静默截断时 `truncated=false`、无 message，模型把半篇文章当完整内容 |

---

## 2. BUG 详述

### 2.1 BUG-1｜飞书任务通知卡片的用户消息预览被清空（中低）

**文件:行号**：`backend-ts/src/notification/task/user-message-preview.ts:20-27`（入口）、`:42-50`（`parsePartsJson`）、`:52-66`（`partsToText`）

**代码事实**：`userMessagePreviewOf` 对字符串先走 `parsePartsJson`。该函数只校验「以 `[` 开头、以 `]` 结尾 + `JSON.parse` 成功 + `Array.isArray`」，就把结果当 content part 数组交给 `partsToText`：

```ts
function parsePartsJson(content: string): unknown[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```

`partsToText` 对非对象元素直接 `continue`，只收集 `type === 'text'` 的分片，因此 `["任务","失败"]`、`[1,2,3]`、`[]`、`[{"foo":1}]` 全部得到 `texts = []` → 返回 `''`；`catch` 的「按原文返回」兜底不会生效。函数注释写的是「仅当字符串确实是 ContentPart 数组的 JSON 时才解析，普通文本（含以 `[` 开头的提问文本）原样保留」，实现与注释相反。仓库已有权威守卫 `common/multimodal-content.ts:9-16` 的 `isMultimodalContentParts`（非空数组且每项 `type` 为 `text`/`image_url`），`session-vo.ts:371` 与 `harness/core/session-history-loader.ts:158` 都在用。

**触发条件**：用户消息正文是合法 JSON 数组字面量，但不是多模态分片。例如用户直接发 `["任务","失败"]`、`[1,2,3]`。

**期望 vs 实际**：

- 期望：`userMessagePreviewOf('["任务","失败"]') === '["任务","失败"]'`。
- 实际：`''`（实测断言输出 `expected '' to be '["任务","失败"]'`）。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/notification/task/user-message-preview.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/notification/task/user-message-preview.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**2 failed | 1 passed**；对照组（真正的多模态数组）返回 `看看这张图\n[图片]×1`，通过

**影响**：`app-lifecycle.ts:57-60` 把该函数注册为任务通知调度器的 `latestUserMessage` provider，`notification/task/delivery.scheduler.ts:286` 用它组装通知内容；飞书卡片在 `notification/task/feishu-notification-card.ts:61-64` 渲染「用户消息」段（纯文本通知不含该段，钉钉渠道走 text）。预览变成空串后，飞书任务完成/失败卡片缺少用户诉求上下文，接收方无法判断这条通知对应哪次提问。

**修复方向**：`parsePartsJson` 在 `Array.isArray` 之后再调 `isMultimodalContentParts(parsed)`，不满足则返回 `null`（回退原文）；`userMessagePreviewOf` 的 `Array.isArray(content)` 分支同样加守卫。可把 `isMultimodalContentParts` 作为统一入口复用，避免第三条路径再次漏判。

**查重说明**：`docs/code-review/` 既有文档没有 `userMessagePreviewOf` 的记录。`2026-10-19-logic-bug-review-01.md` 的 BUG-1 是同一个守卫缺失在 `session-vo.ts`（消息历史/会话分享接口）上的表现，已于 0.0.312 修复；本次是通知预览路径，修复未覆盖，属独立影响面。

---

### 2.2 BUG-2｜运行轨迹的用户消息预览同样被清空（低）

**文件:行号**：`backend-ts/src/session/run-trace.service.ts:591-609`（`previewOf`），调用点 `:345`

**代码事实**：`previewOf` 对任何 `trim().startsWith('[')` 的 content 无条件 `JSON.parse`，随后只拼接 `type === 'text'` 的分片：

```ts
if (text.trim().startsWith('[')) {
  try {
    const parts = JSON.parse(text) as unknown[];
    text = parts
      .map((part) => {
        if (part != null && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
          return String((part as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .join('');
  } catch { /* 非 JSON 数组时按原文 */ }
}
```

`catch` 只兜住解析失败，不兜「解析成功但不是多模态数组」；普通数组没有任何 `type === 'text'` 分片，`join('')` 得到空串。

**触发条件**：构造运行轨迹时，该轮的起始 USER 消息正文是 `["第一轮","第二轮"]` 或 `[1,2,3]`。

**期望 vs 实际**：

- 期望：`page.runs[0].userMessagePreview` 等于原文（超过 80 字才截断）。
- 实际：`''`（实测 `expected '' to be '["第一轮","第二轮"]'`）。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/session/run-trace-plain-json-array.bugcheck.spec.ts`
- 构造方式：fake `messageRepo` 返回单条 USER 消息，`llmCallRepo`/`activityRepo`/`compactionEventRepo` 返回空，调用真实的 `RunTraceService.buildTrace(1, QUERY)`
- 当前结果：**2 failed | 1 passed**；对照组（多模态数组）正确得到文本分片
- 命令：`cd backend-ts && npx vitest run src/session/run-trace-plain-json-array.bugcheck.spec.ts --reporter=verbose`

**影响**：桌面端「运行轨迹」面板每轮的「用户消息」列为空白。长会话多轮执行时，轨迹靠该字段区分轮次；空白后只能靠时间与工具调用猜，排障效率下降。

**修复方向**：与 BUG-1 相同，先 `isMultimodalContentParts` 判定再展开；`catch` 中已有「按原文」语义保持不变。

**查重说明**：`2026-10-19-logic-bug-review-01.md` 在 BUG-1 的「修复方向」里点名 `run-trace.service.ts` 的 `previewOf` 是「同源问题，建议一并修」，但未列为条目、未修复、无测试；本次补存在性证明，确认当前 HEAD 仍复现。

---

### 2.3 BUG-3｜自动记忆抽取把普通 JSON 数组文本清空，整轮抽取被跳过（中）

**文件:行号**：`backend-ts/src/memory/memory-extraction.service.ts:495-515`（`extractStoredText`），调用点 `:128-131`

**代码事实**：抽取入口取最后一条 USER 消息与最后一条 ASSISTANT 答复，用 `extractStoredText` 还原正文：

```ts
export function extractStoredText(content: string | null | undefined): string {
  if (content == null) return '';
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((part): part is Record<string, unknown> => part != null && typeof part === 'object')
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n')
          .trim();
      }
    } catch {
      // 非 JSON 数组，按原文处理
    }
  }
  return trimmed;
}
```

只要 `JSON.parse` 成功且结果是数组就直接返回，不再校验元素结构；普通数组被全部过滤后返回 `''`。随后 `:131` 的 `if (!hasText(userText) || !hasText(assistantText)) return;` 判定失败，本轮记忆抽取提前结束，且没有任何日志。

**触发条件**：会话最后一轮 USER（或 ASSISTANT）消息正文是 JSON 数组文本，如 `["报销","流程"]`、`[1,2,3]`。

**期望 vs 实际**：

- 期望：`extractStoredText('["报销","流程"]') === '["报销","流程"]'`。
- 实际：`''`（实测 `expected '' to be '["报销","流程"]'`），进而 `hasText` 为 false。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/memory/memory-extraction-plain-json-array.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/memory/memory-extraction-plain-json-array.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**2 failed | 1 passed**；对照组（真正的多模态数组）正确抽取 `text` 分片

**影响**：用户发送 JSON 数组文本的会话不会产生自动记忆（`MEMORY_EXTRACT_*` 整条链路静默 return），跨会话偏好/事实沉淀缺失；用户与管理员均无感知，也无法通过日志定位。

**修复方向**：同 BUG-1，`Array.isArray` 后加 `isMultimodalContentParts` 校验；非多模态数组回退 `trimmed`。

**查重说明**：既有文档中 `2026-10-12-answer-citations-review-round3.md` 提到的 `extractStoredText` 是 `feedback.service` 里的 `truncateStoredText` 调用链（局部变量名），不是本函数；`2026-10-19-logic-bug-review-01.md` 未覆盖记忆抽取。无重复。

---

### 2.4 BUG-4｜PathSandbox strict 模式可被「父目录符号链接」逃逸（中，安全向）

**文件:行号**：`backend-ts/src/harness/safety/path-sandbox.ts:66-71`（strict 分支）、`:75-88`（`assertNoSymlinkEscape`）

**代码事实**：容器内用 `strict: true` 构造沙箱（`harness/container/container-tool-executor.ts:57`，允许根为每用户 workspace/runtime/userHome/userSkills/uploads + shareDir + /tmp）。`resolveLenient` 先做词法 `resolve`（绝对路径只放行允许根内），再校验符号链接：

```ts
const st = lstatSync(resolved);
if (!st.isSymbolicLink()) return;
const real = realpathSync(resolved);
if (isUnder(real, this.workspaceRoot) || this.isUnderAllowedRoot(real)) return;
throw new SecurityException('Path escape attempt (symlink): ' + resolved);
```

`lstatSync` 只看最终路径本身。当符号链接出现在**中间目录**时（`workspace/link -> /outside`，访问 `link/secret.txt`），最终节点 `secret.txt` 是普通文件，`st.isSymbolicLink()` 为 false 直接放行；词法路径又以 workspace 开头，`resolve` 也不会拦。`realpathSync` 只在最终节点本身是链接时才执行。

**触发条件**：strict 沙箱下，工作区内存在指向工作区/允许根之外的目录符号链接（Agent 可用 shell 在工作区创建，或用户上传的压缩包/仓库自带），随后通过 `read_file`、`write_file`、`edit_file`、`glob_search`、`grep_search`、`shell` 的 `workdir` 访问该链接下的路径。

**期望 vs 实际**：

- 期望：`sandbox.resolveLenient('link/secret.txt', workspace)` 抛 `SecurityException`。
- 实际：返回 `<workspace>/link/secret.txt`，后续 fs 操作读到 `/outside/secret.txt`（实测 `expected function to throw an error, but it didn't`）。
- 对照：`resolveLenient('link')`（最终节点本身是链接）抛错；普通相对路径正常解析——证明漏的是「父目录」这一层。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/harness/safety/path-sandbox-parent-symlink.bugcheck.spec.ts`（`mkdtemp` 建 workspace/outside，`link -> outside`，写 `secret.txt`）
- 命令：`cd backend-ts && npx vitest run src/harness/safety/path-sandbox-parent-symlink.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**1 failed | 2 passed**

**影响**：`PathSandbox` 的 strict 承诺（代码注释自述「容器内 root + DAC_OVERRIDE 使权限位失效，符号链接是主要逃逸面」）失效：文件工具可读写 workspace 与允许根之外的容器路径（如 `/etc`、`/opt/mao/dist`、全局 `/opt/mao-data/skills`）。需要客观说明的是：容器内同时提供 `shell` 工具，shell 本身不受此沙箱约束，因此该缺陷不是容器隔离的唯一防线；它的实际意义是「文件工具层的路径边界失效」，故定为中而非高。若某部署通过工具白名单禁用了 shell，则该缺陷就是可用的越界面。

**修复方向**：沿路径逐级检查已存在的父目录，或对 `realpathSync` 的最近存在祖先做 realpath 后校验其是否仍在允许根内（推荐后者，兼容目标文件尚不存在的新建场景）：

```ts
// 伪代码：取最近存在的祖先做 realpath，再校验 real 是否在允许根内
let probe = resolved;
while (!existsSync(probe)) probe = path.dirname(probe);
const real = realpathSync(probe);
if (!isUnder(real, this.workspaceRoot) && !this.isUnderAllowedRoot(real)) throw new SecurityException(...);
```

同时保留最终节点 `lstat` 的快速路径，避免对每次访问做全量 realpath 的开销。

**查重说明**：`2026-10-14-container-isolation-round-01.md` 的 BUG-11 是「允许根登记为全局父目录」，与父目录 symlink 漏检是不同根因；`round-03` 验证的是 `container-mount-planner.assertSafe` 在生成挂载清单时对 workspace 根做 realpath（拒绝的是最终节点为 symlink 的挂载项），未覆盖 `PathSandbox` 对工具读写路径的中间目录校验。两者层次不同，不重复。

---

### 2.5 BUG-5｜钉钉机器人渠道会话终态被标记未读（中）

**文件:行号**：

- `backend-ts/src/session/session.service.ts:1378-1399`（`updatePhase`，缺陷条件在 `:1392-1396`）
- `backend-ts/src/session/task-terminal.service.ts:129-132`（`statusData.unread`，WS `session_status` 事件）
- `backend-ts/src/session/task-terminal.service.ts:201-214`（`recordInbox` 的渠道排除，决定是否写站内收件箱）

**代码事实**：三处都按同一口径排除机器人渠道会话，但只写了微信与飞书：

```ts
// updatePhase
if (!isTerminalPhase(oldPhase) && isTerminalPhase(phase)
  && session.projectKey !== WEIXIN_PROJECT_KEY
  && !isFeishuChannelSession(session.projectKey, session.workspace)) {
  fields.unread = 1;
}

// task-terminal
const statusData: Record<string, unknown> = {
  phase,
  unread: session.projectKey !== WEIXIN_PROJECT_KEY && !isFeishuChannelSession(session.projectKey, session.workspace),
};

// recordInbox（同一文件，决定钉钉会话是否写入站内收件箱）
if (session.projectKey === WEIXIN_PROJECT_KEY) return;
if (isFeishuChannelSession(session.projectKey, session.workspace)) return;
```

三处注释都写明「微信/飞书通道会话由机器人等外部触发，没有用户等着看」的语义，但都只列了微信与飞书。

钉钉渠道键由 `dingtalk/workspace.ts:27,31` 生成：私聊 `dingtalk-{botId}-private-{userId}`、群聊 `dingtalk-chat-{botId}-{conversationId}`；工作区形如 `{workspaceRoot}/dingtalk-chat/{botId}/{leaf}`。仓库已经有现成的 `isDingtalkChannelSession`（`harness/tool/dingtalk-channel-tool.ts:10-13`，私有键正则 + workspace 含 `/dingtalk-chat/`），`dingtalk/runtime.ts:542` 与 `harness/core/harness-service.ts:632` 都在用，唯独这些渠道判定漏了它。

**触发条件**：钉钉机器人触发的会话（私聊或群聊）进入终态 `COMPLETED`/`FAILED`/`CANCELLED`/`IDLE`。

**期望 vs 实际**：

- 期望：`updateFields` 的字段里没有 `unread`；WS `session_status` 的 `unread` 为 false；`recordInbox` 不产生记录（与飞书/微信一致）。
- 实际：`updatePhase` 写入 `unread = 1`；WS 事件 `unread = true`；钉钉群聊会话写入 1 条站内收件箱记录（实测 `expected 1 to be undefined`、`expected true to be false`、`expected [ … ] to have a length of +0 but got 1`）。
- 对照：普通手动会话仍写 `unread=1`（符合设计），飞书渠道会话既不置未读也不写收件箱（符合设计）。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/session/session-dingtalk-channel-unread.bugcheck.spec.ts`
- 覆盖：`SessionService.updatePhase` 的 DB 字段（私聊/群聊）、`TaskTerminalService.finishExecution` 的 WS `session_status`（私聊）与站内收件箱（群聊），外加普通会话/飞书会话对照组
- 命令：`cd backend-ts && npx vitest run src/session/session-dingtalk-channel-unread.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**4 failed | 3 passed**

**影响**：钉钉机器人会话结束后被桌面端显示为未读红点，并被 `desktop/src/utils/focusSort.ts` 的「未读」优先级排到空闲/已完成会话之前（`focusSort.test.ts:24-27` 固化了该权重），把无人工关注的机器人会话顶到列表前部；`session_status` 事件还会把红点实时推给前端。同时钉钉会话的完成/失败会写入站内收件箱，而收件箱的设计语义是「用户等着看结果」——机器人会话（尤其群聊）会持续制造无意义的收件箱条目。

**修复方向**：三处条件各补 `isDingtalkChannelSession(session.projectKey, session.workspace)` 判定（`updatePhase` 的 `unread` 写入、`statusData.unread`、`recordInbox` 的提前 return）；`isDingtalkChannelSession` 已导出，无需新写判定。建议顺手把「机器人渠道会话」收敛成一个 helper（`isRobotChannelSession`），避免微信/飞书/钉钉以后再次各写一遍。

**查重说明**：`2026-10-08-core-logic-bug-review-01.md` 提到钉钉 `dingtalk-1-private-8` 是在「会话过滤 agent_id」上下文，与本条无关；`2026-10-09`/`2026-10-19` 报告未涉及钉钉未读。无重复。

---

### 2.6 BUG-6｜记忆域未把钉钉渠道 projectKey 识别为「非真实项目」（低）

**文件:行号**：`backend-ts/src/memory/memory.service.ts:50-55`（`isRobotChannelProjectKey`）

**代码事实**：

```ts
export function isRobotChannelProjectKey(projectKey: string | null | undefined, workspace: string | null | undefined): boolean {
  if (projectKey == null || projectKey === '') return false;
  return projectKey === WEIXIN_PROJECT_KEY
    || /^feishu-chat-\d+-/.test(projectKey)
    || isFeishuChannelSession(projectKey, workspace);
}
```

函数注释明确「机器人渠道会话的项目键不是真实项目」，但只覆盖微信与飞书。钉钉私聊键 `dingtalk-{botId}-private-{userId}` 不匹配任何分支；群聊键 `dingtalk-chat-{botId}-{cid}` 既不匹配 `^feishu-chat-`，也不被 `isFeishuChannelSession` 识别，因此两者都返回 false。该函数有 5 个调用点：

- `memory.service.ts:204` `listProjectKeys`：钉钉键进入记忆页「项目」下拉；
- `memory.service.ts:226` `listForInjection`：钉钉会话被当作有效项目注入 PROJECT 记忆；
- `memory.service.ts:267` `parseProjectKey`：手工创建 PROJECT 记忆时允许绑定钉钉键；
- `memory.service.ts:59` `isValidMemoryProjectKey`：同上；
- `memory-extraction.service.ts:179,240`：自动抽取不降级为 USER 级，而是把候选写成绑定钉钉聊天键的 PROJECT 记忆。

**触发条件**：用户在钉钉机器人会话里触发自动记忆抽取；或在记忆管理页查看项目下拉；或经 API 创建 PROJECT 记忆时传钉钉键。

**期望 vs 实际**：

- 期望：`isRobotChannelProjectKey('dingtalk-2-private-42', null) === true`、`isRobotChannelProjectKey('dingtalk-chat-2-cid-abc', null) === true`（与飞书私聊/群聊键同口径）。
- 实际：均为 false（实测 `expected false to be true`）。
- 对照：普通项目键 `my-project` 返回 false，符合预期。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/memory/memory-robot-channel-dingtalk.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/memory/memory-robot-channel-dingtalk.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**2 failed | 1 passed**

**影响**：

1. 记忆页项目下拉出现 `dingtalk-2-private-42` 这类会话键，用户会误以为它们是可复用的项目；
2. 钉钉会话抽出的记忆被写成绑定「某个私聊/群聊」的 PROJECT 记忆，换一个钉钉会话（或换到桌面端）就注入不到，跨会话记忆沉淀实际失效；正确行为应是降级为 USER 级（`memory-extraction.service.ts:239-245` 已有该降级分支，只是判定没命中）；
3. 手工创建接口放行钉钉键，产生聊天级死配置（该键随机器人/群变化后不再对应任何会话）。

**修复方向**：补两条前缀判定 `^dingtalk-\d+-private-`、`^dingtalk-chat-\d+-`，或直接复用 `isDingtalkChannelSession(projectKey, workspace)`（注意该函数群聊仅靠 workspace 识别，手工创建路径 workspace 为 null，因此仍需前缀兜底，参考飞书 `^feishu-chat-\d+-` 的处理）。

**查重说明**：`2026-10-02-long-term-memory-review-round1.md` 问题 3 报告的是「飞书群聊 key 在手工创建路径穿透校验」，并建议补 `feishu-chat-` 前缀——该建议已落地（当前 `:53`），本次是钉钉渠道的同类遗漏，不是同一问题重复报告。

---

### 2.7 BUG-7｜哨兵 prompt 渲染对 diff 内容做二次占位符替换（低）

**文件:行号**：`backend-ts/src/signal/watcher.logic.ts:141-150`（`renderWatcherPrompt`），调用点 `signal/watcher.service.ts:396-405`

**代码事实**：

```ts
export function renderWatcherPrompt(template: string, vars: RenderVars): string {
  const base = template ?? '';
  let out = base.split('{diff}').join(vars.diff ?? '');
  out = out.split('{url}').join(vars.url ?? '');
  out = out.split('{name}').join(vars.name ?? '');
  ...
}
```

先把 `{diff}` 的值拼进结果，再对整段结果替换 `{url}`、`{name}`。`diff` 的值来自被监控网页的正文/字段（`buildDiff`），属于外部不可信内容；其中原样出现的 `{url}`/`{name}` 会被二次替换。正确做法是单遍替换模板自身的占位符，替换值不再被扫描。

**触发条件**：被监控页面的正文（或 JSON 字段值）里出现字面量 `{url}` 或 `{name}`，且用户模板同时使用了 `{diff}` 与对应占位符。

**期望 vs 实际**：

- 期望：`renderWatcherPrompt('地址：{url}\n变化：{diff}', { url: 'https://example.com/probe', name: '价格监控', diff: '页面正文写了 {url} 这个占位符' })` 中 diff 部分保持 `{url}` 字面量。
- 实际：diff 里的 `{url}` 被替换成 `https://example.com/probe`；`{name}` 同理被替换成「价格监控」（实测 `expected '...地址...' to contain '页面正文写了 {url} 这个占位符'`）。
- 对照：模板自身的 `{name}@{url}: {diff}` 正常替换，证明问题只出在「替换值被二次扫描」。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/signal/watcher-prompt-placeholder.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/signal/watcher-prompt-placeholder.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**2 failed | 1 passed**

**影响**：`watcher.service.ts:396` 把渲染结果作为 `openRun` 的用户消息发给 Agent。页面正文里的 `{url}`/`{name}` 被替换后，Agent 看到的 diff 与被监控页面的真实变化不一致：可能把「页面里出现了探针 URL」当成事实（虚假归因），也可能因文案差异反复误报。反向看，页面作者可以通过写入 `{url}` 让正文出现探针地址，属于受限的内容注入面（只能替换成已知变量，不能注入任意文本）。

**修复方向**：单遍正则替换原模板中的 `{diff}`/`{url}`/`{name}`（如 `template.replace(/\{(diff|url|name)\}/g, (_, k) => vars[k] ?? '')`），替换值不参与后续扫描；保留长度截断逻辑。

**查重说明**：`2026-10-14-logic-bug-review-01.md` 附录 A.12 曾把该顺序问题列为「提示词注入小瑕疵，无确定性错误行为」而排除。本次用确定性用例证明「输出内容确定错误、且用户可见（Agent 收到的 diff 与真实页面不一致）」，按本报告「合法输入 + 确定错误输出」的入选标准重新计入；不是重复报告已修问题（该函数最后一次改动为 2026-10-14 的 `f12ae97e`，当前仍是同一实现）。

---

### 2.8 BUG-8｜open_web_page 原始 HTML 被 maxRawBytes 截断时未标记 truncated（中低）

**文件:行号**：`backend-ts/src/harness/tool/impl/open-web-page-tool.ts:118-137`（`fetchAndExtract` 的截断判定）、`:305-330`（`fetchHtml` 的流式读取）

**代码事实**：结果里的 `truncated` 只由「抽取后的正文长度 vs `maxOutputLength`」决定：

```ts
const { html, contentType } = await fetchHtml(url, this.webPage);
...
const truncated = fullContent.length > this.webPage.maxOutputLength;
```

而 `fetchHtml` 在累计原始字节达到 `maxRawBytes` 时是这样处理的：

```ts
res.on('data', (chunk: Buffer) => {
  const room = cfg.maxRawBytes - size;
  if (room <= 0) return;
  if (chunk.length >= room) {
    chunks.push(chunk.subarray(0, room));
    size = cfg.maxRawBytes;
    res.destroy();
    complete();   // 按成功返回已读部分
    return;
  }
  ...
});
```

`complete()` 只回传 `{ html, contentType }`，没有「原始响应被截断」的标志；`res.on('error')` 里还有 `if (size >= cfg.maxRawBytes) { complete(); return; }` 把 destroy 引发的错误也吞成功。上层于是拿到一段被砍断的 HTML，抽取出的正文只要没超过 `maxOutputLength` 就报 `truncated=false`、无 `message`、无 `full_content_file`。

**触发条件**：目标页面原始 HTML 超过 `maxRawBytes`（默认 1 MiB，`settings/settings.service.ts:520`），且截断后能抽取出的正文长度未超过 `maxOutputLength`（默认 50000 字符，`:521`）——大段内联脚本/样式/JSON 的页面很常见。

**期望 vs 实际**：

- 期望：结果 `truncated === true`，且 `message` 含「截断」提示（告知模型正文可能不完整）。
- 实际：`truncated === false`、无 `message`（实测 `expected false to be true`）。

**测试证据（修复前快照）**：

- 文件：`backend-ts/src/harness/tool/impl/open-web-page-raw-truncation.bugcheck.spec.ts`
- 构造：本地 `http.createServer` 返回约 30 KB 的 HTML，正文尾部带 `TAIL-MARKER-SHOULD-BE-MISSING`；工具配置 `maxRawBytes: 1024`、`maxOutputLength: 100_000`，确保只触发原始响应截断
- 命令：`cd backend-ts && npx vitest run src/harness/tool/impl/open-web-page-raw-truncation.bugcheck.spec.ts --reporter=verbose`
- 当前结果：**1 failed**

**影响**：模型收到半篇文章却以为内容完整，可能基于缺失的后半段做总结/判断；用户也无法从返回值判断需要换方式（如直接下载或用其他工具）补齐。工具文档（`:59`、schema `:78-80`）承诺「超过上限会 truncated=true 并给出落盘路径」，实际未兑现。

**修复方向**：`fetchHtml` 返回值增加 `rawTruncated: boolean`（`size >= maxRawBytes` 时置 true），`fetchAndExtract` 用 `const truncated = rawTruncated || fullContent.length > this.webPage.maxOutputLength` 统一判定；`rawTruncated` 时 message 明确说明「原始响应超过 maxRawBytes，正文可能不完整」，此时没有完整内容可落盘，不要伪造 `full_content_file`。

**查重说明**：`2026-09-30-logic-bug-review-01.md` 引用 `open-web-page-tool.ts` 的 `maxRawBytes` 流式截断是作为「同仓库已有的正确防护范例」，未报告其缺少截断标志；本次是该防护的「返回值语义」缺口，无重复。

---

## 3. 验证方式与结果

### 3.1 存在性证明测试

所有新增测试都按**正确行为**书写（而不是按当前实现书写）：

- 当前源码下失败 → 证明 BUG 真实存在；
- 修复后应转绿，可作为回归用例长期保留；
- 每个 BUG 至少配一条**对照组**（真正的多模态数组、普通项目键、普通会话、最终节点 symlink、模板自身占位符等），证明失败不是测试写法、环境或解析路径导致的误报。

8 个文件合计 **26 条用例**：修复前 **16 failed | 10 passed**，失败用例与 8 个 BUG 一一对应；`0.0.329` 修复后 **26 passed**。

### 3.2 全量回归

```bash
cd mao/backend-ts && npx vitest run --reporter=dot
```

结果（`0.0.329` 修复后）：

```text
Test Files  384 passed | 1 skipped (385)
     Tests  4613 passed | 14 skipped (4627)
```

- 修复前为 **8 failed | 376 passed**、**16 failed | 4597 passed**，8 个失败文件全部是本报告新增的 `*.bugcheck.spec.ts`；
- 修复后 384 个测试文件全部通过，存量与新增用例均无回归；
- 这也证明修复前的问题不是测试环境或全局配置导致，而是本报告列出的 8 条产品逻辑缺陷（BUG-1/2/3 同根因、不同影响面）。

### 3.3 类型检查

- 产品构建：`cd mao/backend-ts && npx tsc -p tsconfig.build.json --noEmit` → **0 错误**；
- 全量 spec 类型检查：`npx tsc --noEmit -p tsconfig.json` 仍存在仓库既有的 spec 报错（集中在 admin-analytics、agent-bundle 等历史文件），对输出做 `grep bugcheck` 无命中，即本次新增/修改的测试文件没有类型错误。产品构建走 `tsconfig.build.json`，本就排除 `**/*.spec.ts`。

### 3.4 改动范围

`0.0.329` 的改动：**10 个产品/文档文件修改 + 8 个测试文件与评审报告新增**，未部署、未提交（提交动作由后续指令触发）：

```text
 M CHANGELOG.md
 M backend-ts/src/harness/safety/path-sandbox.ts
 M backend-ts/src/harness/tool/impl/open-web-page-tool.ts
 M backend-ts/src/memory/memory-extraction.service.ts
 M backend-ts/src/memory/memory.service.ts
 M backend-ts/src/notification/task/user-message-preview.ts
 M backend-ts/src/session/run-trace.service.ts
 M backend-ts/src/session/session.service.ts
 M backend-ts/src/session/task-terminal.service.ts
 M backend-ts/src/signal/watcher.logic.ts
?? backend-ts/src/harness/safety/path-sandbox-parent-symlink.bugcheck.spec.ts
?? backend-ts/src/harness/tool/impl/open-web-page-raw-truncation.bugcheck.spec.ts
?? backend-ts/src/memory/memory-extraction-plain-json-array.bugcheck.spec.ts
?? backend-ts/src/memory/memory-robot-channel-dingtalk.bugcheck.spec.ts
?? backend-ts/src/notification/task/user-message-preview.bugcheck.spec.ts
?? backend-ts/src/session/run-trace-plain-json-array.bugcheck.spec.ts
?? backend-ts/src/session/session-dingtalk-channel-unread.bugcheck.spec.ts
?? backend-ts/src/signal/watcher-prompt-placeholder.bugcheck.spec.ts
?? docs/code-review/2026-10-21-logic-bug-review-01.md
```

---

## 4. 修复顺序与落地

以下为修复前评估的优先级，`0.0.329` 已按此顺序全部修复完成；修复方式与各节「修复方向」一致。

| 优先级 | BUG | 理由 |
| --- | --- | --- |
| P1 | BUG-4 | 安全边界失效；虽被 shell 工具削弱，但仍是文件工具层的越界面，修复成本低（逐级 realpath） |
| P1 | BUG-3 | 静默丢失记忆沉淀，无日志，用户完全无感知 |
| P1 | BUG-5 | 钉钉是主力 IM 渠道之一，每个机器人会话结束都产生假未读并置顶 |
| P2 | BUG-1 | 飞书通知卡片缺少用户上下文；改动小、影响明确 |
| P2 | BUG-8 | 大页面内容不完整却标记完整，直接误导模型 |
| P3 | BUG-2 / BUG-6 / BUG-7 | 影响面较窄或仅特定输入；修复简单，可随同批次清理 |

**收敛建议（已落地）**：

1. 把 `common/multimodal-content.ts` 的 `isMultimodalContentParts` 作为唯一的「content 是否多模态」判定入口，替换 BUG-1/2/3 三处裸 `Array.isArray`（`session-vo.ts` 与 `session-history-loader.ts` 已示范）；
2. 新增 `isRobotChannelSession(projectKey, workspace)` 统一封装微信/飞书/钉钉，供未读判定（BUG-5）与记忆域（BUG-6）共用，避免渠道增加时再次漏判；
3. 哨兵渲染改为单遍正则替换（BUG-7），并在工具返回值中区分「原始响应截断」与「输出正文截断」（BUG-8）。

---

## 5. 附录

### 5.1 新增测试文件清单

| # | 文件 | 用例 | 修复前结果 |
| --- | --- | --- | --- |
| 1 | `backend-ts/src/notification/task/user-message-preview.bugcheck.spec.ts` | 3 | 2 failed / 1 passed |
| 2 | `backend-ts/src/session/run-trace-plain-json-array.bugcheck.spec.ts` | 3 | 2 failed / 1 passed |
| 3 | `backend-ts/src/memory/memory-extraction-plain-json-array.bugcheck.spec.ts` | 3 | 2 failed / 1 passed |
| 4 | `backend-ts/src/harness/safety/path-sandbox-parent-symlink.bugcheck.spec.ts` | 3 | 1 failed / 2 passed |
| 5 | `backend-ts/src/session/session-dingtalk-channel-unread.bugcheck.spec.ts` | 7 | 4 failed / 3 passed |
| 6 | `backend-ts/src/memory/memory-robot-channel-dingtalk.bugcheck.spec.ts` | 3 | 2 failed / 1 passed |
| 7 | `backend-ts/src/signal/watcher-prompt-placeholder.bugcheck.spec.ts` | 3 | 2 failed / 1 passed |
| 8 | `backend-ts/src/harness/tool/impl/open-web-page-raw-truncation.bugcheck.spec.ts` | 1 | 1 failed |
|  | **合计** | **26** | **16 failed / 10 passed；修复后 26 passed** |

### 5.2 复跑命令

```bash
# 只看本报告的 8 个 BUG（约 1.2s）
cd mao/backend-ts
npx vitest run \
  src/notification/task/user-message-preview.bugcheck.spec.ts \
  src/session/run-trace-plain-json-array.bugcheck.spec.ts \
  src/memory/memory-extraction-plain-json-array.bugcheck.spec.ts \
  src/harness/safety/path-sandbox-parent-symlink.bugcheck.spec.ts \
  src/session/session-dingtalk-channel-unread.bugcheck.spec.ts \
  src/memory/memory-robot-channel-dingtalk.bugcheck.spec.ts \
  src/signal/watcher-prompt-placeholder.bugcheck.spec.ts \
  src/harness/tool/impl/open-web-page-raw-truncation.bugcheck.spec.ts \
  --reporter=dot

# 全量回归（约 1 分钟）
npx vitest run --reporter=dot
```

### 5.3 与既有评审文档的关系

- 本报告文件名 `2026-10-21-logic-bug-review-01.md` 在 `docs/code-review/` 下唯一，未覆盖既有文档；
- 8 条 BUG 均已在各节「查重说明」中与历史报告逐条比对：其中 BUG-2 曾被 `2026-10-19` 报告作为「同源建议」提及但未修复，BUG-7 曾被 `2026-10-14` 报告以「无确定性错误行为」排除；本次均以可复现测试重新定性，其余 6 条为首次报告。

