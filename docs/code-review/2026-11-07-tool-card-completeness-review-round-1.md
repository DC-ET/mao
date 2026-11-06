# 工具卡片完整化代码复审报告 · Round 1

- 日期：2026-11-07
- 复审对象：commit `451b7ead`（diff 范围 `8ce67ee8..HEAD`），工作区无未提交改动
- 需求：工具卡片完整化——后端 tool-result-summarizer 15 个函数失败摘要补原因；前端 3 个新富视图（图片网格 / 问答回放 / 子代理进度）+ ToolCallCard 接线 + toolDisplay 输入预览补 7 个 case + ApprovalStack MCP 审批标题
- 技术方案：docs/plan/2026-11-07-tool-card-completeness-technical-design.md（提案实为 docs/proposals/2026-11-06-tool-card-completeness.md，本次按 worktree 内提案逐项核对）

## 结论：发现 2 个 bug

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| 1 | 高（功能未生效） | `desktop/src/components/chat/ToolCallCard.vue:629-633` | `richSummary` 链中 `imageGenSummary.value` 在视图为 null 时返回**空字符串**而非 undefined，`??` 不跳过空串导致链在此短路——`askUserSummary`（N 组问答）与 `subagentSummary`（N 个任务 / 完成 N 个 · 已超时）**永远不会渲染**，两个新视图的底栏摘要是死代码 |
| 2 | 低（边缘场景显示垃圾文本） | `backend-ts/src/session/util/tool-result-summarizer.ts:89-92`（`failureSuffix`）、调用点 `:633-642`（`summarizeMcpCall`） | `mcp_call` 结果顶层 `error` 为**对象**时摘要显示 `(失败: [object Object])`——MCP 成功调用会透传服务器 `structuredContent`（`mcp-client-manager.ts:290-293`），其顶层 `error` 可以是任意形状；改造前此处只显示裸 `(失败)`，不取 error 文本 |

---

## Bug 1：`richSummary` 空串短路，askUser / subagent 两个新视图的底栏摘要永不显示

**位置**：`desktop/src/components/chat/ToolCallCard.vue`

```ts
// :629-633
const richSummary = computed(() =>
  editDiffView.value?.summary ?? shellView.value?.summary ?? fileView.value?.summary
  ?? writeView.value?.summary ?? globView.value?.summary ?? grepView.value?.summary
  ?? webSearchView.value?.summary ?? webPageView.value?.summary
  ?? imageGenSummary.value ?? askUserSummary.value ?? subagentSummary.value ?? '')
```

**根因**：链上既有 8 个视图用的是 `xxxView.value?.summary`——视图为 null 时是 `null?.summary` → `undefined`，`??` 会继续向后走。而链尾三个新成员直接取 computed 的值，这三个 computed 在视图为 null 时 `return ''`（空字符串）：

- `imageGenSummary`（:637-644）：`if (!view) return ''`
- `askUserSummary`（:646-649）：`return view ? ... : ''`
- `subagentSummary`（:651-661）：`if (!view) return ''`

空字符串不是 nullish，`'' ?? x` 结果是 `''`——所以对任何非图片工具，链在 `imageGenSummary.value` 处就终止为 `''`，`askUserSummary` / `subagentSummary` 永远不会被求值。模板 `<span v-if="richSummary" class="edit-summary">` 因此不渲染。

**用户可见影响**：
- `ask_user_questions` 卡片：问答回放视图正常渲染，但底栏摘要「N 组问答」永远不出现；
- `check_subagent` / `wait_subagents`（超时分支）卡片：进度行正常渲染，但底栏摘要「N 个任务」「完成 N 个 · 全部完成/已超时」永远不出现；
- 图片生成（对照组）正常：`imageGenSummary` 是链尾第一个成员且视图非 null 时必非空。

**验证**（临时组件测试，已按仓库要求验证后删除）：按 `ToolCallCard.test.ts` 既有挂载模式 mount 四种 toolCall，读取 `.edit-summary` 文本：

```
[verify] ask summary = ""                          ← 期望 "1 组问答"
[verify] check summary = ""                        ← 期望 "1 个任务"
[verify] wait summary = ""                         ← 期望 "完成 1 个 · 已超时"
[verify] image summary = "1 张图 · cogview-4 · 1024x1024"   ← 对照组正常
```

**修复方向**（供修复参考）：链尾改为 `imageGenView.value ? imageGenSummary.value : undefined ?? ...` 同款写法，或让三个 summary computed 在视图为 null 时返回 `undefined` 而非 `''`（与既有 `xxxView.value?.summary` 语义对齐）。

---

## Bug 2：`mcp_call` 结果顶层 `error` 为对象时摘要显示 `[object Object]`

**位置**：`backend-ts/src/session/util/tool-result-summarizer.ts`

```ts
// :89-92
function failureSuffix(node: Record<string, unknown> | null): string {
  if (!has(node, 'error')) return '';
  return ` (失败: ${truncate(String(node!.error), 40)})`;
}
```

**触发链**：CLOUD 模式 `mcp_call` 成功调用时，`McpClientManager.callTool` → `formatResult`（`backend-ts/src/harness/mcp/mcp-client-manager.ts:280-301`）：MCP 服务器返回 `structuredContent != null` 时**原样透传** `JSON.stringify(result.structuredContent)`。这是外部 MCP 服务器的任意 JSON——顶层 `error` 键完全可能是对象（典型如 HTTP 代理类 MCP server 返回 `{ error: { code: 404, message: 'Not Found' } }`）。此时：

- 改造前：`summarizeMcpCall` 只判 `has(node, 'error')` → 显示 `调用 MCP 工具 github.search (失败)`（分类是否恰当是既有问题，不在本次范围）；
- 改造后：`failureSuffix` 取 `String(node.error)` → 显示 `调用 MCP 工具 github.search (失败: [object Object])`——本次改动把垃圾文本带进了用户可见摘要。

15 个接入 `failureSuffix` 的函数里，其余 14 个的失败结果都出自各工具的 `errorJson(...)`（顶层 `error` 恒为字符串，已逐一核对 shell-session / web-search / open-web-page / generate-image / edit-image / wechat / dingtalk / feishu / scheduled-task 各实现），只有 `mcp_call` 的成功结果是外部任意 JSON，能出现对象形 error。同文件对 `{error:{message}}` 形状早有正确范本（`summarizePageTool` :211-215 先取 `error.message`）。

**验证**（临时 spec，已删除）：

```
[verify] object error -> 调用 MCP 工具 github.search (失败: [object Object])
[verify] string error -> 调用 MCP 工具 github.search (失败: server 未连接)   ← 正常
[verify] describe object error -> 查询 MCP 工具 github.search (失败: [object Object])
```

注：`mcp_describe` 成功结果是服务端自组 `{server, tool, description, inputSchema}`，实际不会出现对象 error；风险集中在 `mcp_call`。修复方向：`failureSuffix` 对非 string 的 `error` 取 `.message`（对齐 `summarizePageTool` 口径），取不到再回退裸 `(失败)`。

---

## 已核对无问题的部分（收敛依据）

1. **后端 15 处失败摘要的 error 形状**：逐一核对 15 个工具实现（含 LOCAL 分支），失败结果均为顶层字符串 `{error}`（`errorJson` / 显式 `toJson({error: message})`），与 `failureSuffix` 匹配；成功结果均不含非空 `error` 键，成功路径输出逐字节不变（A 类插入点均在 `async` / `completed` / `exit_code` / `message` / `total_results` / `title` 判定之前，且这些键与 `error` 键在真实返回中互斥）。
2. **`summarizeShell` 特例**：`errorJson` 失败不含 `exit_code`，error 优先消掉 `(exit -1)` 误报；`{completed:false}` 与 `{exit_code≠0}` 既有口径不变，均有用例覆盖。
3. **三个新富视图的数据契约**：`parseImageGenItems`（`materializeImageApiResult` 产出 `images[].{image_url,image_path,size_bytes,mime}` + 顶层 `model/size/prompt`，`model/size ?? null` 已处理）、`parseAskUserPairs`（`QuestionPanel.handleSubmit` 产出 `{question, selectedLabels, customInput}`，与 `streaming-ws-handler.ts:1275` 落库形状一致，`customInput: null` 已处理）、`parseSubagentProgressRows`（`BackgroundProgress` 为 camelCase `taskId/agentType/status/...`，单对象形态 `'taskId' in node` 判断与 `snapshot()` 恒带 `taskId` 一致；`wait_subagents` 非超时结果无 `taskId/status/background_subagents` 键，正确回落原始 JSON，符合提案 D3 决策）。空数组 / 非法项 / `error` 结果均返回 null 回落原始 JSON。
4. **`waitForAll` 返回 `{completed: boolean, timedOut: boolean}`**，前端 `node.timed_out === true` / `node.all_completed === true` 的布尔判断成立；`completed: list.length` 为数字，`subagentSummary` 的取数逻辑（虽因 Bug 1 未显示，逻辑本身）正确。
5. **toolDisplay 7 个 case**：`getToolInputPreview` 开头有 `if (!input) return ''` 守卫；`task_id` 类型闸（整数 > 0）与 `check_subagent`（无 task_id = 列全部）、`cancel_subagent`（schema required）语义一致；`subagent_followup` 走通用回落（`task`/`agent_type` 键）已被既有通用分支覆盖，测试断言与实现一致。
6. **ApprovalStack**：`resolveApprovalTitle` 纯增量——LOCAL MCP 审批 toolName 确为 `mcp:${serverName}`（`electron/main.cjs:2513`，经 `requestToolApproval` 原样透传 renderer）；`mcp:` 空后缀与未知工具回落原文案，旧行为无变化；`item.toolName` 两条链路（IPC / WS）均保证为 string。
7. **回归基线**：后端全量 `npm test` 通过（含新增 summarizer spec 83 用例相关 5 文件全绿）；desktop 全量 `npx vitest run` 180 文件 1722 用例通过；`npm run build`（vue-tsc -b + vite build）通过。验证用的临时 spec（backend-ts 1 个、desktop 1 个）已删除，`git status` 干净。
