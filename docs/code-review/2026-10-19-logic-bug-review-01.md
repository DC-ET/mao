# 代码审查：全仓逻辑 BUG 清查（7 个经测试验证的功能 BUG，均已于 0.0.312 修复）

- **日期**：2026-10-19（末次复核）
- **基线**：原评审基于 `main` @ `e3a36f8f`（2026-10-16）产出 9 个候选；本文档已按当前 `main` @ `a5505708`（2026-10-19）**逐条重新复核**——9 个候选中 1 个已被后续提交修复、1 个判定修复价值不高，均移除，剩 7 项。全程未改动任何产品代码，仅更新本文档并删除 2 个对应移除项的孤儿/失败测试文件
- **修复记录**：本文档 7 项 BUG 已于 `0.0.312`（2026-10-19）**全部修复**并通过回归测试；下文各节「问题 / 复现」为**修复前快照**，保留作历史记录，修复口径见各节「修复方向」与 CHANGELOG `0.0.312`
- **范围**：全仓通读——`backend-ts/src/`（harness 引擎与工具、session、file、auth、model、digest、skill、inbox、openapi、schedule、signal、usage、feishu/dingtalk/weixin 等）、`desktop/src/`、`admin/src/`、`agent-cli/`、`shared/contracts/`
- **方法**：逐文件通读 + 同一概念跨文件语义比对（找口径漂移）+ 无 spec 覆盖分支重点排查。每条候选必须满足「合法输入即可触发、输出确定错误、有可运行测试证明」；无法构造确定性失败测试的候选一律不列为 BUG（排除清单见 §4）。断言一律按**正确行为**书写，当前源码下 `failed` 即证明 BUG 真实存在；每条 BUG 均附对照组（证明失败不是测试写法问题）
- **修复状态**：以下 7 项**均已于 `0.0.312`（2026-10-19）修复**，对应存在性证明测试已转绿、作为回归用例保留（`.bugcheck.spec.ts`，沿用本仓既有约定）
- **测试证据**（以下数字为**修复前**快照，`main` @ `a5505708` 完整套件实跑；修复后全部转绿，backend 4250 passed、agent-cli 仅剩 1 条存量 `/copy` 剪贴板环境失败）：
  - `cd backend-ts && npm test` → **Test Files 6 failed | 354 passed | 1 skipped (361)**，**Tests 14 failed | 4236 passed | 13 skipped (4263)**——6 个失败文件全部为本报告保留的 backend bugcheck（BUG-1/2/3/4/6/7），存量用例无一回归
  - `cd desktop && npx vitest run` → **Test Files 74 passed (74)**，**Tests 666 passed (666)**——全绿（原唯一 desktop 条目 BUG-3 已在 0.0.304 修复并移出本报告）
  - `cd agent-cli && npm test` → **Test Files 2 failed | 40 passed (42)**，**Tests 3 failed | 519 passed (522)**——其中 2 条为本报告 BUG-5（glob），另 1 条为存量环境相关失败（`repl-slash.spec.ts > /copy 无剪贴板命令时回落打印`：本机存在 `pbcopy`，代码走剪贴板分支；与该文件单独运行同样失败，与本报告无关）
  - 类型检查：`desktop npx vue-tsc -b` 0 错误；`agent-cli npm run typecheck` 0 错误；`backend-ts npx tsc --noEmit` 有存量报错（非本报告引入），其中**不含任何 bugcheck 文件**（`tsconfig.build.json` 本就排除 `**/*.spec.ts`）

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | `backend-ts/src/session/session-vo.ts:361-386` | 纯文本 JSON 数组消息（`[1,2,3]`、`["a","b"]`、`[]`）经 `toMessageVO` 后 `content` 变成空串：消息历史 / 会话分享 / 管理端会话详情全部丢内容（LLM 侧有守卫、接口侧没有） |
| BUG-2 | 高 | `backend-ts/src/model/model.service.ts:431-476` | `parseWavInfo` 直接采信 WAV 头部声明的 data 长度：4 个真实字节 + `0x7FFFFFFF` 占位长度 → 约 12.4 小时的假时长；负数 chunk size 还会让解析循环原地踏步（事件循环被挂死） |
| BUG-3 | 中 | `backend-ts/src/digest/scheduler.ts:38,50-70` | `DigestScheduler` 无重入保护：`setInterval` 不等待上一轮，慢 tick 重叠时对同一用户重复投递日报，并把已读日报打回未读、Webhook 订阅方收到两份 |
| BUG-4 | 中 | `backend-ts/src/harness/skill/skill-md.ts:20,50` | SKILL.md frontmatter 用裸 `indexOf('---')` 找结束定界符：值里含 `---`（合法 YAML）时 description 被静默截断、body 被污染；加引号的值直接被判「YAML 非法」，合法技能文件被拒 |
| BUG-5 | 低 | `agent-cli/src/local/tools/search.ts:122` | `glob_search` 把「命中数恰好等于 head_limit」误报成 `truncated: true`（云端同源实现只有遇到第 N+1 个匹配才置 true） |
| BUG-6 | 低 | `backend-ts/src/session/admin-message-compact.ts:53-71` | 管理端工具参数压缩的纯文本兜底会作用于「合法 JSON 但无单字段超限」的入参，把 `fn.arguments` 截成非法 JSON，管理后台工具输入面板整段消失 |
| BUG-7 | 低 | `backend-ts/src/session/util/tool-result-summarizer.ts:259-260` | shell 结果摘要把结尾换行也算一行，行数恒多 1（`a\nb\n` 显示「3 行输出」） |

---

## 2. BUG 详述

### 2.1 BUG-1｜纯文本 JSON 数组消息在接口层被清空（高）

**文件:行号**：`backend-ts/src/session/session-vo.ts:361-386`（`toMessageVO`，核心缺陷在 `:377` 的 `vo.content = text`）

**问题**：`message.content` trim 后只要以 `[` 开头就无条件按「多模态 content part 数组」解析。解析成功但数组里没有 `type === 'text'` 的元素时 `text` 保持 `''`，且不抛异常——`catch`（`:381-383`）的「按原文返回」兜底永远不生效。

**触发条件**：用户发送一条合法纯文本消息，正文恰好是 JSON 数组字面量：

- `[1,2,3]`、`["怎么配置","端口"]`、`[]`、`[{"foo":1}]` 均触发。

**期望 vs 实际**：

- 期望：非多模态结构的 `content` 原样返回；真正的 content part 数组照旧展开。
- 实际：`vo.content === ''`。消息历史接口（`session.routes.ts` 的 messages 分支）、会话分享（`session-share.service.ts`）与管理端会话详情（`admin-session.routes.ts`）都返回空气泡——用户与管理员看不到这条消息的正文。

**权威口径（同仓已有守卫）**：`backend-ts/src/harness/core/session-history-loader.ts:141-167` 的 `isMultimodalContentParts` 明确处理了同一输入类，注释点名 `[1,2,3]`、`["a","b"]`、`[]`：「用户发送的纯文本 JSON 数组在 DB 中与多模态数组无法区分，若不校验结构会被误当作 content part 数组」。`toMessageVO` 漏了这道守卫，于是 LLM 能读到原文，UI/接口读到空串。

**复现测试**：

- 文件：`backend-ts/src/session/session-vo-plain-json-array.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/session/session-vo-plain-json-array.bugcheck.spec.ts`
- 当前结果：**4 failed | 1 passed**，失败形态如 `expected '' to be '[1,2,3]'`
- 对照组（passed）：真实多模态数组 `[{type:'text'},{type:'image_url'}]` 仍正确展开为文本 + images，证明失败不是测试写法或解析路径问题

**修复方向**：把 `session-history-loader` 的 `isMultimodalContentParts` 提为共用工具（或同款校验）后在 `toMessageVO` 使用；不满足结构时 `content = raw`。同源问题 `run-trace.service.ts` 的 `previewOf`（`:591` 起，同样对 `[...]` 未守卫地 `JSON.parse`）也是同样的未守卫数组解析，建议一并修。

---

### 2.2 BUG-2｜WAV 时长按声明长度放大（4 字节 → 约 12.4 小时），负 size 可致死循环（高）

**文件:行号**：`backend-ts/src/model/model.service.ts:431-476`（`parseWavInfo`；缺陷在 `:462-464` 采信 `chunkSize`、`:465-468` 推进 offset）

**问题 1（已写成测试）**：解析 `data` chunk 时直接 `dataSize = chunkSize`，既不与 `bytes.length - bodyStart` 取小，也不校验 chunk 是否超出实际文件。时长按声明值换算：

```ts
const bytesPerSecond = sampleRate * Math.max(channels, 1) * (bitsPerSample / 8);
const durationMs = bytesPerSecond > 0 ? Math.floor((dataSize * 1000) / bytesPerSecond) : 0;
```

**触发条件**：流式 / 不可回填长度的 WAV 编码器把 `data` 长度写成占位值（`0x7FFFFFFF` 是最常见的「未知长度」写法），或文件在传输中被截断。24kHz / 单声道 / 16bit 下，**4 个真实字节**被换算成 `44,739,242ms`（约 12.4 小时）；声明 1000 字节但只有 4 字节时得到 20ms 的假时长。`parseWavInfo` 被管理后台模型连通性 / 语音测试调用（`model.service.ts:357` 一带），展示的就是这个错误时长。

**问题 2（未写成测试，避免挂死用例）**：`chunkSize` 用 `bytes[offset+7] << 24` 按**有符号** 32 位读出，且没有 `offset` 严格递增的收口。当某个非 `fmt `/`data` chunk（如 `JUNK`）声明 `0xFFFFFFF8`（-8）时：`offset = (offset + 8) + (-8) = offset`，`while (offset + 8 <= bytes.length)` 永远成立 → `parseWavInfo` 同步死循环，阻塞 Node 事件循环（后端整体失去响应）。期望：chunk size 必须为非负且 `offset` 每轮严格递增。

**复现测试**：

- 文件：`backend-ts/src/model/parse-wav-info.bugcheck.spec.ts`（自建最小合法 WAV 夹具）
- 命令：`cd backend-ts && npx vitest run src/model/parse-wav-info.bugcheck.spec.ts`
- 当前结果：**2 failed | 1 passed**——`expected 44739242 to be less than or equal to 1`、`expected 20 to be less than or equal to 1`
- 对照组（passed）：正常文件（4800 字节 @ 24kHz 16bit）返回精确 `{ sampleRate: 24000, durationMs: 100 }`

**修复方向**：`dataSize = Math.min(chunkSize, Math.max(0, bytes.length - bodyStart))`（或超界判不可用）；`chunkSize` 用 `>>> 0` 读为无符号并拒绝超界；记录上一轮 offset，若未严格递增立即退出。

---

### 2.3 BUG-3｜日报调度器无重入保护，重叠 tick 重复投递（中）

**文件:行号**：`backend-ts/src/digest/scheduler.ts:38`（`setInterval(() => { void this.tick(); }, TICK_INTERVAL_MS)`）、`:50-70`（`tick` 只有 `stopped` 判定，无 inFlight 标志）

**问题**：`setInterval` 不等待上一轮 `tick()` 的 Promise。文件头注释声称「单 tick 内逐用户串行处理，天然单飞（无 CAS / 无 Map 标记的需要）」，但当一轮 tick 超过 60s（用户多 + 每用户约 9 条聚合查询）时，下一轮会带着**启动时刻的 rows 快照**并发进入。此时第一轮尚未对后续用户写回 `last_digest_date`，第二轮重新 `listEnabledUsers()` 仍看到 `lastDigestDate !== 昨天`，于是对同一用户第二次调用 `processUser`：

- `digest/service.ts:155-165` 再次 `writeDigestEntry` → `inbox/inbox.repository.ts:84-91` 的 `ON DUPLICATE KEY UPDATE ... is_read = 0, read_at = NULL` 把用户**已读的日报打回未读**；
- `:163` 再次 `dispatchDigest` → `openapi/outbound-subscription.service.ts:194-204` 为每个订阅再插一条 `outbound_delivery`（表无唯一键），Webhook 订阅方**收到两份日报**。

**期望 vs 实际**：期望同一时刻只允许一轮 tick（重叠 tick 直接跳过）；实际第二轮重复处理尚未写回标记的用户。同仓其它调度器（`schedule/scheduled-task.service.ts`、`signal/watcher-scheduler.ts`、`openapi/outbound-delivery.scheduler.ts`）都有显式在途标志。

**复现测试**：

- 文件：`backend-ts/src/digest/scheduler-reentrancy.bugcheck.spec.ts`（deferred 卡住 `processUser`，并发调两次 `tick()`）
- 命令：`cd backend-ts && npx vitest run src/digest/scheduler-reentrancy.bugcheck.spec.ts`
- 当前结果：**1 failed**——`expected "spy" to be called 1 times, but got 2 times`

**误报排除**：触发依赖「单轮 tick > 60s」，但守卫缺失本身确定（`tick()` 是公开方法，`setInterval` 不 await 是事实）；修复只需加在途标志，与既有 `scheduler.spec.ts` 的 7 条用例语义兼容。

**修复方向**：加 `private dispatching = false`，`tick()` 开头判定并 `finally` 复位（或用 `setTimeout` 自链）。

---

### 2.4 BUG-4｜SKILL.md frontmatter 定界符按裸子串搜索，值里的 `---` 导致静默损坏 / 误拒（中）

**文件:行号**：`backend-ts/src/harness/skill/skill-md.ts:20`（`parseSkillMdContent`）与 `:50`（`validateSkillMd`），两处均为：

```ts
const secondDelimiter = content.indexOf('---', 3);
```

**问题**：结束定界符用裸子串搜索，不按行锚定、不理会 YAML 引号与标量。frontmatter 值里出现 `---`（YAML 合法——`---` 只在行首才是文档分隔符）时：

- 非引号值：frontmatter 被提前截断，`description` 只剩 `---` 之前的部分，后半段连同真正的定界符被塞进 body。已实测 `yaml` 解析 `description: 处理步骤 --- 详细说明` 返回完整字符串，说明输入本身合法。
- 引号值：引号被切在中间，frontmatter 变成非法 YAML → `parseSkillMdContent` 返回 null、`validateSkillMd` 报「invalid YAML frontmatter」，**合法技能文件被拒**。

`validateSkillMd` 用同一段 `indexOf` 逻辑，非引号值形态下损坏内容仍能通过上传 / 同步校验，用户没有任何报错可循。

**复现测试**：

- 文件：`backend-ts/src/harness/skill/skill-md-frontmatter.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/harness/skill/skill-md-frontmatter.bugcheck.spec.ts`
- 当前结果：**3 failed | 1 passed**
  - `expected '处理步骤' to be '处理步骤 --- 详细说明'`（description 被截断）
  - `expected undefined to be 'a --- b'`（引号值解析失败）
  - `expected 'SKILL.md ... has invalid YAML frontmatter' to be null`（合法文件被拒）
- 对照组（passed）：普通描述（无 `---`）的 parse / validate 行为不变

**修复方向**：按行扫描，找到「trim 后恰为 `---`（或 `---` 后仅空白）」的第二行作为定界符；两处提取共用同一实现，避免再次漂移。

---

### 2.5 BUG-5｜`glob_search` 把「恰好用满配额」误报为截断（低）

**文件:行号**：`agent-cli/src/local/tools/search.ts:122`

```ts
return { files, search_root: scope.cwd, truncated: files.length >= headLimit, total_matched: files.length };
```

**问题**：`truncated` 的语义是「结果被截断、还有更多匹配未返回」，但 `>=` 把「命中数恰好等于 head_limit」也算成截断。rg 分支（`:91` 的 `slice(0, headLimit)`）与 Node 分支（`:56/:64` 一到上限就停）都无法区分「恰好 N 条」与「还有更多」。

**权威口径（云端同源实现）**：`backend-ts/src/harness/tool/impl/glob-search-tool.ts:69-77` 只有真的遇到第 `head_limit + 1` 个匹配文件时才置 `truncated = true`；恰好命中 N 个时是 false。CLI 与云端工具同名同 schema，模型据此判断是否要继续搜索，口径必须一致。

**复现测试**：

- 文件：`agent-cli/test/glob-truncated.bugcheck.spec.ts`（Node 回退分支 + rg 分支各一条，rg 不可用时自动跳过）
- 命令：`cd agent-cli && npx vitest run test/glob-truncated.bugcheck.spec.ts`
- 当前结果：**2 failed | 1 passed**——workspace 只有 1 个 `*.ts`、`head_limit: 1` 时 `expected true to be false`（两条路径都复现）
- 对照组（passed）：2 个匹配、`head_limit: 1` 时 `truncated: true`（真的有结果被丢弃）

**修复方向**：遍历时多探一个候选再决定（或让遍历器返回 `hasMore`），不要在「装满即停」的路径上直接推 `>=`。

---

### 2.6 BUG-6｜工具参数压缩的纯文本兜底把合法 JSON 截成非法 JSON（低）

**文件:行号**：`backend-ts/src/session/admin-message-compact.ts:53-71`（兜底在 `:70`）

```ts
} catch {
  // 参数不是 JSON 时下面按纯文本截断
}
return raw.slice(0, ARG_KEEP) + noteFor(raw.length);
```

**问题**：注释声明纯文本兜底只服务「参数不是 JSON」的情况，但它在「JSON 解析成功、却没有**顶层字符串字段**超过 `ARG_FIELD_LIMIT`（8000）」时同样被触达（`changed` 保持 false，函数落到末尾）。典型合法输入：两个各 5000 字的字段（总长超 8000、单字段未超）、或长内容藏在嵌套对象 / 数组里。结果 `fn.arguments` 被替换为 1500 字截断 + 含未转义换行的中文提示——`JSON.parse` 必然抛错。

**影响**：管理后台会话详情用 `parseToolArguments`（`admin/src/views/session/utils/chatMessage.ts:8-24,53`）解析工具入参，解析失败返回 `undefined`，该工具卡片的「输入」面板整段消失（后端原文本身是合法 JSON）。

**复现测试**：

- 文件：`backend-ts/src/session/admin-message-compact-json.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/session/admin-message-compact-json.bugcheck.spec.ts`
- 当前结果：**2 failed | 1 passed**——`SyntaxError: Bad control character in string literal`
- 对照组（passed）：单个顶层字段超 8000 时仍产出合法 JSON 且含「参数过长已省略」提示（既有的正常压缩路径）

**修复方向**：JSON 解析成功后不要走纯文本兜底——无字段可压时原样返回；嵌套长内容可做递归裁剪，但必须保持 JSON 合法。

---

### 2.7 BUG-7｜shell 结果摘要把结尾换行数成一行（低，展示）

**文件:行号**：`backend-ts/src/session/util/tool-result-summarizer.ts:259-260`

```ts
const lineCount = output.length === 0 ? 0 : output.split('\n').length;
if (lineCount > 1) return `${label} (${lineCount} 行输出)`;
```

**问题**：`split('\n')` 会把结尾换行产生出的空段计入长度。终端命令输出几乎总以换行结尾，于是行数系统性多 1：`a\nb\n` 被显示成「3 行输出」。同仓权威口径是 `read-file-tool.ts:160-166` 的 `splitLines`——注释明确「按行终止符切分，末尾换行不产生空行（与 Java Files.lines 一致）」，函数体在末尾空段处 `pop()`。

**复现测试**：

- 文件：`backend-ts/src/session/util/tool-result-summarizer-line-count.bugcheck.spec.ts`
- 命令：`cd backend-ts && npx vitest run src/session/util/tool-result-summarizer-line-count.bugcheck.spec.ts`
- 当前结果：**2 failed | 1 passed**——`expected '执行 ls (3 行输出)' to be '执行 ls (2 行输出)'`；`a\n` 落成 `'执行 ls (2 行输出)'` 而应为单行无后缀
- 对照组（passed）：无结尾换行的 `a\nb` → 2 行（既有断言不变）

**修复方向**：按 `splitLines` 口径计数（去掉末尾空段），或复用 `read-file-tool.ts` 的 `splitLines`。

---

## 3. 验证与复现方式

仅运行本报告的存在性证明（会自动跳过 rg 不可用的分支）：

```bash
# backend（6 个文件、14 条失败断言）
cd backend-ts && npx vitest run \
  src/session/session-vo-plain-json-array.bugcheck.spec.ts \
  src/model/parse-wav-info.bugcheck.spec.ts \
  src/digest/scheduler-reentrancy.bugcheck.spec.ts \
  src/harness/skill/skill-md-frontmatter.bugcheck.spec.ts \
  src/session/admin-message-compact-json.bugcheck.spec.ts \
  src/session/util/tool-result-summarizer-line-count.bugcheck.spec.ts

# agent-cli（1 个文件、2 条失败断言；另 1 条存量 /copy 剪贴板环境失败与本报告无关）
cd agent-cli && npx vitest run test/glob-truncated.bugcheck.spec.ts
```

| 套件 | 基线（新增前） | 现状（含存在性证明） | 差异 |
| --- | --- | --- | --- |
| backend-ts | 存量全绿 | Tests **14 failed** / 4236 passed / 13 skipped | 14 条失败全部为本报告 BUG-1/2/3/4/6/7 |
| desktop | 存量全绿 | 全绿（666 passed） | 原唯一 desktop 条目 BUG-3 已在 0.0.304 修复并移出本报告 |
| agent-cli | 1 条存量 `/copy` 环境失败 | Tests **3 failed** / 519 passed | 其中 2 条为 BUG-5，另 1 条存量不变 |

修复后把这些 `*.bugcheck.*` 文件转为常规回归用例即可（存在性证明的断言方向就是正确行为）。

---

## 4. 已排查、未列为 BUG 的候选（排除说明）

1. **原 BUG-3（`useInboxSystemNotify.ts` 系统通知门控漏 `WEIXIN_REPLY_WINDOW_CLOSED` / `DAILY_DIGEST`）**——原评审基线 `e3a36f8f` 时确实存在，但已被 `0.0.304`（提交 `8f4ce184`，2026-10-17）修复：两个 kind 已加入 `return true` 分组，原存在性证明测试 3 条现全绿。与已提交回归测试 `desktop/src/composables/inbox-notify-kind.bugcheck.test.ts`（同覆盖这两个 kind）重复，故移出本报告并删除重复的未跟踪测试文件。
2. **原 BUG-7（`agent-cli/src/tui/markdown-parse.ts` 围栏长度）**——问题真实存在（bugcheck 仍失败），但仅影响终端 CLI 代码块渲染观感，触发场景窄（模型用 4 反引号包裹含 3 反引号的示例），且修复需改 `classifyMdLine` 签名以穿透「开启围栏长度」、涉及流式渲染调用方，性价比低。判定**修复价值不高**，移出本报告并删除其测试文件；如后续要求 CommonMark 严格合规可另行排期。
3. **`agent-cli/src/tui/keydecode.ts:174-177` F1–F8 / F17–F20 被前缀匹配成 Home/Delete**——真实存在（有测试证明），但已在 `docs/code-review/2026-10-02-logic-bug-review-01.md` 附录 B 记录且仍未修复，属重复报告，不重复计入；建议随下轮修复一并处理。
4. **`run-trace.service.ts` `previewOf`（`:591` 起）与 `session.service` 的疑似同类数组解析**——与 BUG-1 同根因（未守卫的 `JSON.parse(content)`），并入 BUG-1 的修复范围，不单独计数。
5. **`openapi/webhook-trigger.service.ts:190-226` 验签失败与合法触发共用同一限流桶**——坏签名请求可挤掉合法触发的窗口配额；但「失败请求是否应计入触发器配额」是产品/防刷意图问题（历史评审只要求失败计入以防刷流水），未取得确定性「错误输出」结论，不列为 BUG。
6. **`desktop/src/composables/useScheduledTasks.ts:133` `runBadge` 把 DB 墙钟字符串按客户端本地时区解析**——仅在客户端 TZ ≠ Asia/Shanghai 时偏差；与桌面端既有 `formatRelativeTime` 的部署假设（TZ=+08）一致，属口径选择，未列为 BUG。
7. **`admin/src/views/session/SessionDetailView.vue:356-377` `loadMoreMessages` 跨会话竞态**——同组件参数跳转时旧响应会并入新会话（`fetchDetail` 已有 `latestFetchSeq` 守卫，此处没有）；需要组件级 / Playwright 验证，未附确定性单测，列为风险而非 BUG。
8. **`desktop/src/composables/workspace-file-provider.ts:254-272` 预览接口的 200+JSON 业务错误被当作 PDF blob**——同一文件下载路径已有守卫，此处只影响错误文案质量，未列为 BUG。
9. **inbox「只看未读」在本地标记已读后不裁剪列表**——产品口径歧义（服务端筛选 + 本地乐观状态），未列为 BUG。
10. **`agent-cli/src/main.ts:27` stdin idle 计时器在首字节后被卸载 / `ws/ws-client.ts:190` close 与 connect 竞态 / `ui/width.ts` 星平面 emoji 宽度 / `repl/repl.ts:335` 单选多值静默丢值**——触发依赖特殊环境或属产品决策，无法在合法输入下确定性判错，未列为 BUG。
11. **`prompt-engine.ts:688-694` AGENTS.md 恰好 200 行 + 结尾换行时仍提示「仅展示前 200 行」**——提示噪声、无执行语义变化，与 2026-10-16 报告把同类边界问题降级的口径一致，未列为 BUG。
12. 历史文档已覆盖/已修复的项（git numstat 改名、SSO 三态、技能上传穿越、CANCELLING 排序、`MAO_AGENT_OUTPUT_FORMAT`、admin 文件 URL base、预览 reactive 等）均未重复。

---

## 附录 A：本报告存在性证明测试文件（仅测试，无产品代码改动）

| # | 文件 | 对应 BUG |
| --- | --- | --- |
| 1 | `backend-ts/src/session/session-vo-plain-json-array.bugcheck.spec.ts` | BUG-1 |
| 2 | `backend-ts/src/model/parse-wav-info.bugcheck.spec.ts` | BUG-2 |
| 3 | `backend-ts/src/digest/scheduler-reentrancy.bugcheck.spec.ts` | BUG-3 |
| 4 | `backend-ts/src/harness/skill/skill-md-frontmatter.bugcheck.spec.ts` | BUG-4 |
| 5 | `agent-cli/test/glob-truncated.bugcheck.spec.ts` | BUG-5 |
| 6 | `backend-ts/src/session/admin-message-compact-json.bugcheck.spec.ts` | BUG-6 |
| 7 | `backend-ts/src/session/util/tool-result-summarizer-line-count.bugcheck.spec.ts` | BUG-7 |

命名沿用仓库既有约定（`*.bugcheck.spec.ts` / `*.bugcheck.test.ts`）：断言按正确行为书写、当前失败即存在性证明，修复后转绿即回归用例。原 BUG-3 / BUG-7 对应的两个测试文件已随条目移除而删除。

---

*审查人：OpenCode（DeepSeek V4.1）原稿；末次复核按当前 `main` @ `a5505708` 逐条重跑存在性证明 + 全仓套件 + 类型检查完成，并于 `0.0.312`（2026-10-19）全部修复。修复后 backend 全绿（4250 passed）、agent-cli 仅剩 1 条存量 `/copy` 剪贴板环境失败、desktop 全绿；2 个移除条目理由见 §4。*
