# 长文本用户消息「文件化」（粘贴转附件 + `dump_user_messages`）· 第 1 轮代码审查报告

- 日期：2026-10-29
- 审查对象：仓库根 `mao/` 下 **未提交改动**（23 个修改 + 5 个新增文件，见 `git status`）；只审功能逻辑，文档/技能说明变更不在范围内
- 需求依据：`docs/plan/2026-10-29-long-user-message-file-export-technical-design.md`（R1–R11；§2.2 的 N1–N6 为明确不做）
- 验证方式：新增 2 个复现脚本（1 个 `node --test`、1 组 `vitest + jsdom` 用例，存 `docs/code-review/repro/2026-10-29-long-user-message-file-export/`，附运行说明）+ 跑通本轮涉及的既有测试；**未修改仓库任何源码/测试**
- 已排除的既有环境问题（不重复报告）：容器内 Node 22.14 缺 `zlib.createZstdDecompress` 导致 20 个 jsdom 用例起不来、`gitOperations.test.cjs` 的提交身份用例依赖干净全局 git config

## 结论

**阻塞项 0 个。** 后端 `dump_user_messages`（工具本体、注册、SERVER_ONLY 归属、结果摘要、无进展归一化）与 `SessionService.getRecentUserMessages` 未发现功能缺陷；CLOUD 侧粘贴转附件链路正常。
发现 2 个功能缺陷，均在 **LOCAL（本机）模式的前端落盘链路**，其中问题 1 建议在合并前修掉（会造成静默的错误数据）。

| # | 严重度 | 问题 | 位置 | 关联需求 |
|---|---|---|---|---|
| 1 | 重要 | 同一会话内第二次粘长文本仍叫 `pasted-text-1.txt`，LOCAL 落盘无重名规避 → 覆盖第一次的文件，历史消息里的 `@{...}@` 引用指向被改写后的内容 | `desktop/src/components/chat/ChatInput.vue:279`（+625）、`desktop/electron/chatAttachment.cjs:307-327`、`desktop/src/utils/chatLocalAttach.ts:46` | R1 / R3 / R11（R11 明确要求复用 `uniqueName` 重名规避） |
| 2 | 建议（低） | LOCAL 模式 + 非 Electron 客户端（浏览器）粘贴超长文本：附件没加、编辑器也没插入 → 粘贴内容丢失 | `desktop/src/components/chat/ChatInput.vue:619-627` + `:1023-1027` | R1（该模式本身不可发送，影响面小） |

---

## 问题 1（重要）：LOCAL 模式粘贴附件同名覆盖，历史消息引用读到被改写的内容

### 位置与机制

1. `desktop/src/components/chat/ChatInput.vue:279`：`let pasteTextSeq = 0` —— 序号是**组件实例内**的自增变量（`planPastedText` 用它生成 `pasted-text-N.txt`，`pasted-text-file.ts:41`）。设计文档写的是「本次会话内自增序号」（§5 / 状态场景 A），实现退化为「本次实例内自增」。
2. 组件实例会重建，且在日常流程里就会发生：`desktop/src/components/chat/ChatPanel.vue:338` 的 `showCenterComposer = isNewTaskMode && !historyLoading` 决定 `v-if`（`layout="centered"`，`:24`）与 `template v-else`（`layout="docked"`，`:175`）两个互斥分支——**新建任务首条消息发出、会话创建后**，输入框就从 centered 实例切到 docked 实例，序号回到 0。（页面刷新、关闭再打开 chat 页签同理。）
3. `desktop/src/utils/chatLocalAttach.ts:46` → `:81` `writeInlineTextAttachment` 把粘贴附件交给 `localWriteTextFile`；`desktop/electron/chatAttachment.cjs:307` 的 `writeLocalTextFileAsync` **刻意不做重名规避**（`:292` 注释：与 `user-message-{id}.txt` 的幂等覆盖共用一套语义），`:319` 直接 `resolveAttachmentTarget(...)` 后 `:322` `writeFile` 覆盖已存在文件。

于是同一会话目录 `~/.mao/attachments/{host}/{sessionId}/` 下，两段长文本先后写成**同一个** `pasted-text-1.txt`：第 1 条消息里的 `@{.../pasted-text-1.txt}@` 现在指向第 2 段内容。CLOUD 侧不受影响——`backend-ts/src/file/file.service.ts:105-127`（`uploadIncomingFile` 内 `uniqueIncomingName`）会改名避重，LOCAL 侧的普通附件拷贝也有 `uniqueName`（`chatAttachment.cjs:223`），只有新增的这条内联文本落盘没有。

### 影响（用户可见）

- LOCAL 模式一个会话里两次「粘贴长文本 → 发送」（例如先给第一批 ID、随后再给第二批），第二次会静默改写第一份附件文件。
- 之后对第 1 条消息做**编辑重发**、或让 Agent 在后续轮次**再次读取该路径**（追问「用刚才那批 ID 再跑一次」），拿到的是第二批数据 → 结果错但无任何报错。
- 同类触发面：页面刷新/重启后在同一会话再粘贴；草稿里已恢复的 `pasted-text-1.txt` 与新建的 `pasted-text-1.txt` 同名共存（LOCAL 只有一份文件、消息里出现两个相同路径）。

### 复现/验证（实际运行，均通过 = 复现成功）

```bash
# ① 落盘机理 + 与服务端工具的契约（读 backend-ts/dist，需先 npm run build）
cd <仓库根>/mao
node --test docs/code-review/repro/2026-10-29-long-user-message-file-export/overwrite-and-local-chain.test.cjs
# ok 1 - 契约：dump_user_messages(LOCAL) 委托 write_local_text_file，返回桌面端本机绝对路径
# ok 2 - 同名粘贴附件第二次落盘覆盖第一次：历史消息引用的文件内容被改写
#         （second.absolutePath === first.absolutePath；目录内只有 pasted-text-1.txt；旧路径读到「第二批 ID: …」）

# ② UI 侧前提：新建态粘贴 → 切到会话态再粘贴，两次都得到 pasted-text-1.txt（ChatPanel 双分支结构复刻）
cp docs/code-review/repro/2026-10-29-long-user-message-file-export/chatinput-paste.*.test.ts \
   docs/code-review/repro/2026-10-29-long-user-message-file-export/vitest.config.ts <仓库根>/mao/desktop/.tmp-test/
cd <仓库根>/mao/desktop
NODE_OPTIONS="--require <仓库根>/mao/docs/code-review/repro/2026-10-29-long-user-message-file-export/zstd-stub.cjs" \
  npx vitest run --config .tmp-test/vitest.config.ts
# ✓ chatinput-paste.behavior.test.ts (4 tests) —— 其中 A 例打印：[新建态] chips = ['pasted-text-1.txt'] / [切换后] [] / [会话态] chips = ['pasted-text-1.txt']
```

### 建议修复方向（交后续 worker 执行）

在「幂等覆盖」与「重名规避」两种语义间显式区分，任选其一或叠加：

- `chatAttachment.writeLocalTextFileAsync` 增加 `dedupe`（或 `unique: true`）开关：命中时走既有 `uniqueName(dir, name)`；渲染层粘贴附件（`chatLocalAttach.ts` → IPC → `local-write-text-file`）传 `dedupe: true`，`dump_user_messages`（`main.cjs:2660` `handleLocalWriteTextFile` 的服务端委托路径）保持覆盖，以满足 R6 的按消息 id 幂等；`dump-user-messages-tool.spec.ts` / `chatAttachment.test.cjs` 的既有断言不受影响。
- 或把粘贴序号从「实例内变量」提升为「会话级」（按 `sessionId` 维护，或落盘前扫目录内已有 `pasted-text-*` 取最大序号 +1），使 `pasted-text-N.txt` 在会话内唯一。

## 问题 2（建议/低）：LOCAL + 非 Electron（浏览器）粘贴超长文本被吞掉

### 位置与机制

`ChatInput.vue:619-627`：`planPastedText` 判为 `convert` 后先 `event.preventDefault()`、`pasteTextSeq += 1`，再 `void addPendingFile(...)`；而 `addPendingFile` 的第一道守卫（`:1024-1027`）在 `executionMode === 'LOCAL' && !isElectronClient` 时只弹一条 `ElMessage.warning('本地模式不支持文件上传，请使用桌面客户端')` 就 return。默认粘贴已被阻止、附件也没进列表 → **粘贴的 2500 字符在输入框里凭空消失**（同类守卫还有超限分支，但那条走的是 `limit-reached` 回落，行为正确）。

### 影响

只在「浏览器端打开一个 LOCAL 会话」时出现；该模式 `handleSend`（`:1127-1130`）与 `prepareAndSendMessage`（`useChat.ts:343`）本身就会拦下发送，所以不是主流程阻塞，但用户粘贴的长文本会当场丢失（且重粘仍丢）。同源的 `limit-reached` 分支做了「回落到插入编辑器」处理，这里没有。

### 复现/验证

```bash
# 与 ② 同目录、同命令（该文件必须独立进程跑：isElectronClient 是 ChatInput 模块级常量）
# ✓ chatinput-paste.local-web.test.ts (1 test)
#   无 electronAPI + executionMode='LOCAL'，粘贴 2500 字符后：
#   chips = []（未进待发附件）、.ProseMirror textContent = ''（未进编辑器）、event.defaultPrevented = true
```

### 建议修复方向

`handlePaste` 的 convert 分支改为「先确认能收下再 preventDefault」：例如把 `addPendingFile` 的准入判断（LOCAL 非 Electron / 名额已满 / 大小超限）前置成一个同步判定，判定不通过时与 `limit-reached` 一样回落到普通粘贴（或至少把文本插入编辑器），不要让 `preventDefault` 与 `addPendingFile` 的拒收分叉。

---

## 非阻塞观察（不计入 bug）

- `dump_user_messages` 新增了 `getToolPrompt()`（`backend-ts/src/harness/tool/impl/dump-user-messages-tool.ts:53`），但全仓没有任何生产者消费 `getToolPrompt()`（`grep -rn getToolPrompt` 只命中各工具实现、`tool.ts` 与单测断言）——技术方案 §4/§6.2 里的「工具提示通道」实际不会进入模型上下文。功能不受影响：工具 description / input schema 会随 `context.tools` 一起发（`prompt-engine.ts:664` `buildToolDefinitions`）。这是**既有平台模式**（`web_search`、`open_web_page` 等同样如此），本轮只是沿用，故不计为本次引入的 bug。

## 已核对且未发现功能问题的部分

- 后端工具本体：`recentCount` 取值/夹取（`asIntStrict` + 1..10）、`sessionId==null`、空消息、逐条错误隔离、CLOUD `mkdirSync`+`writeFileSync` 路径 `runtime/{uid}/{sid}/userMessages/user-message-{id}.txt`（R6/R7）、LOCAL 逐条 WS 委托与回包解析（`main.cjs:2405/2660` 回 `{success,path}`，工具读 `path`）、`buildResult` 成功/失败计数
- `SessionService.getRecentUserMessages`：`ROLE='USER'` + `notDeleted()` 倒序分页、`isRealUserMessage` 口径（含多模态数组判定与 `<system-notice>`/压缩摘要排除）、批内提前收敛、`reverse()` 后正序返回、`limit` 下限收敛
- 注册与派发：`tool-registry.ts:161` 注册 + `deps.localToolExecutor` 由 `app-harness-engine.ts:275` 注入、`tool-dispatcher.ts:73` 的 `SERVER_ONLY_TOOLS` 归属（LOCAL 会话也在服务端执行入口，避免整工具被下发给桌面端）
- 三处同步（R10）：`tool-result-summarizer.ts` 新 case 成功/部分失败/失败三态、`desktop/src/utils/toolDisplay.ts` 中文名与 `recentCount` 预览、`no-progress-notice.spec.ts` 路径非易变字段用例
- 桌面端：`chatAttachment.resolveAttachmentTarget` 的 sanitize / hostKey / sessionId 校验与 home 相对断言（新函数沿用了全部校验）、`preload.cjs` 桥与 IPC 命名、`chatLocalAttach.writeInlineTextAttachment` 的「无本机路径 + text/* → 内联写入」分支与失败提示、CLOUD `uploadPendingFiles` 走 FormData（不依赖 `File.path`）
- 沙箱/可达性：`runtime` 允许根已在 `create-app.ts:457-463` 放行，CLOUD 产物在 Agent `read_file`/`grep_search` 可达；LOCAL 产物为绝对路径，桌面端 `resolveWorkspacePath` 对绝对路径直通（`main.cjs:1043`），`grep_search` 亦支持按文件路径检索（`:2801`）

## 验证产物与命令汇总

- 复现脚本与运行说明：`docs/code-review/repro/2026-10-29-long-user-message-file-export/README.md`（含本次实测输出节选；临时目录 `desktop/.tmp-test/` 用完已清理）
- 既有测试抽查：`backend-ts` `npx vitest run src/harness/tool/impl/dump-user-messages-tool.spec.ts src/session/util/tool-result-summarizer-dump-user-messages.spec.ts src/session/session.service.spec.ts` → 82 用例通过；`desktop` `node --test electron/chatAttachment.test.cjs` → 31 用例通过；`backend-ts` `npx vitest run src/file/file.service.spec.ts -t uploadIncomingFileKeepsOriginalNameAndResolvesConflicts` → 通过（CLOUD 侧避重对照）
