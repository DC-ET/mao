# 2026-11-13 逻辑 BUG 审查 01

- 方法：1 个子代理对五端核心域做全域扫描产出候选，随后人工逐条对照源码验证；每个候选按「正确契约」编写存在性验证用例，先以普通 `it` 运行捕获真实失败输出，确认为真实缺陷后再以 `it.fails` 固化（保持 CI 绿，修复后转正为普通回归，惯例同 `logic-bug-review-2026-11-04/11`）。
- 二次复核：随后由 1 个独立子代理对全部 6 项逐条重查源码、独立复现、并核查触发路径与调用链（含 git 历史与全局兜底）。复核结论：**6 项在代码层面均真实存在（无一误报），但其中 3 项修复价值不足，从确认清单移除**；同时修正初稿 2 处机制性错误（BUG-1 触发条件、BUG-4 基线对照）。
- 结论：**确认 3 个**（均中，BUG-1 由高降级），**已于 2026-11-13 当日修复落地**（BUG-1/2/5 用例转正为回归，见「后续」）；**移除 3 个**（存在但低价值，见文末复核移除记录）。

## 确认清单（二次复核后保留）

| # | 位置 | 严重度 | 修复价值 | 一句话 |
|---|------|--------|----------|--------|
| 1 | `backend-ts/src/openapi/openapi.repository.ts:306` | 中 | 中 | outbound_delivery 卡死恢复用 `created_at` 判超时 + 终态回写无 CAS，在途投递可被复位重发 → 同一 webhook 事件重复投递 |
| 2 | `backend-ts/src/weixin/send.service.ts:39` | 中 | 中 | 微信长文本分片按 UTF-16 码元硬切，切断代理对产生非法 UTF-8 分片（默认 6000 字节预算下真实可触发） |
| 5 | `backend-ts/src/harness/tool/impl/glob-search-tool.ts:87` | 中 | 中 | 单个不可读子目录让整次 glob 搜索丢弃全部结果（rg/JS 基线均为跳过续扫；仅 CLOUD 路径受影响） |

编号保持初稿（与验证用例 `backend-ts/src/logic-bug-review-2026-11-13.spec.ts` 的测试名对齐，被移除项的 `it.fails` 用例继续作为已知缺陷留档）。

---

## BUG-1 outbound_delivery 卡死恢复用 created_at 判超时 + 终态无 CAS → 重复投递（中）

- **位置**：`backend-ts/src/openapi/openapi.repository.ts:306-311`（`recoverInterrupted`）；关联 `backend-ts/src/openapi/outbound-delivery.scheduler.ts:13`（恢复周期 60s 节流）、`:77-81`（cutoff = now-5min）、`:83-89`（claim CAS 后 `execute(() => deliver(id))`）；`markSucceeded`/`markFailed`（`:313-325`）均 `WHERE id = ?` 无 status CAS；`deliver()` 重查行（`:99-105`）不校验 status。
- **触发条件**（二次复核改写）：sender 自身有 10s 硬超时（`backend-ts/src/openapi/generic-webhook-sender.ts:4` `REQUEST_TIMEOUT_MS = 10_000`，`:51` `signal: AbortSignal.timeout(...)`，实测 10001ms 返回 `TimeoutError`），初稿「HTTP 发送挂起超过 5 分钟」**不可达**。真实可达路径有两条：
  1. **在途窗口与恢复 tick 相撞**：重试梯（1/5/25 分钟）下 attempt 3（行龄 ~6min）及以后的行龄已超过 5min cutoff，而其 SENDING 在途窗口最长约 10s；恢复 tick 每 60s 一次，相撞概率 ≈ 10/60。相撞后在途行被复位 PENDING，5s 调度间隔内被 re-claim 二次投递（与首发并发），且终态回写无 CAS 可互相覆盖。
  2. **执行池积压**：`execute` = `agentExecutor.submit`（`app-lifecycle.ts:95`，与 agent 循环同池：core 20 / max 100 / queue 200，`settings.service.ts:175-177`），池饱和时 deliver 闭包排队可超过 5 分钟——SENDING 行（行龄 > cutoff）必然被恢复 tick 误复位并重发。
- **错误行为 vs 契约**：`outbound_delivery` 表（`db/migration/V133__open_api.sql`）**没有 `updated_at` 列**，`recoverInterrupted` 用 `created_at < cutoff` 判「SENDING 卡死」——`created_at` 是行创建时间、不随投递推进，任何行龄超过 5 分钟的在途行都满足条件。同仓库正确基线见 `notification/task/delivery.scheduler.ts:30,185`：「updated_at 带 ON UPDATE CURRENT_TIMESTAMP，5 分钟 cutoff 不会误伤在途发送」——恢复判据必须是「SENDING 且最后推进时间 < cutoff」。
- **修复价值**：对外 webhook 重复推送（对端可能据事件重复执行副作用）；路径 2 在投递高峰（与 agent 任务共用执行池）下并不罕见。
- **验证**：内存 repo 忠实镜像 SQL 语义 + fake timers，第一次 send 未完成（建模「首发仍在途/未出队」）时推进 61s 触发恢复 tick。真实失败输出：
  ```
  AssertionError: 同一事件被投递 2 次（在途重试行被误判卡死并复位重发）: expected [ {}, {} ] to have a length of 1 but got 2
  ```
  （注：spec 用永久挂起的 send 建模在途窗口，与执行池积压路径同构；独立复核已实测 sender 10s 硬超时并据此改写触发条件。）
- **为什么既有测试没抓住**：既有单测覆盖正常 PENDING→SENDING→SUCCEEDED 流程与进程重启恢复（重启时确实全部卡死），没有「在途投递 + 运行期恢复 tick」的组合场景。
- **修复建议**：迁移给 `outbound_delivery` 加 `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`（或 claim 时写 `sending_at`），`recoverInterrupted` 改用该列判 cutoff；给 `markSucceeded`/`markFailed` 补 `AND status='SENDING'` CAS，`deliver()` 重查行时对非 SENDING 直接放弃。与 `notification/task` 侧恢复语义对齐。

## BUG-2 weixin 分片字节硬切切断代理对（中）

- **位置**：`backend-ts/src/weixin/send.service.ts:39-48`（`prefixLenWithinBytes`）。
- **触发条件**：分片字节预算恰好落在代理对中间。`text[i]` 是 UTF-16 码元而非字符：星形平面字符（emoji 等）由高低代理两个码元组成，Node 将孤立高位代理 `\uD83D` 按 3 字节计长，预算恰好在高代理之后耗尽时切分。**默认预算（`WEIXIN_MAX_TEXT_BYTES = 6000`）下真实可触发**：同一文本仅加 1 字节前缀错位对齐，复核实测 6 个分片中 4 个含孤立代理（硬切路径 = `findCut`（`:52-65`）窗口内无 `\n\n`/`\n`/空格时返回 `limit`）。
- **错误行为 vs 契约**：分片以孤立高位代理结尾，`JSON.stringify`/HTTP 发送产生非法 UTF-8，对端解析乱码或拒收该分片（`sendText` 返回 false 中断后续分片）。违反函数自身注释契约「逐字符累积保证不切出半个多字节字符」——逐「UTF-16 码元」≠ 逐「字符」。
- **验证**：`splitTextForWeixin('a😀b', 4)`。真实失败输出：
  ```
  AssertionError: 分片含孤立代理: "a\ud83d": expected true to be false
  ```
  （分片同时通过 UTF-8 往返无损断言失败；二次复核以 tsx 独立复现一致。）
- **为什么既有测试没抓住**：既有用例以中文（BMP 内 3 字节字符）测边界，未覆盖代理对字符。
- **修复建议**：`prefixLenWithinBytes` 按 code point 迭代（`codePointAt` 识别高位代理时整对处理），或按字节截断后回退到合法字符边界。

## BUG-5 glob_search 单个不可读子目录丢弃全部结果（中）

- **位置**：`backend-ts/src/harness/tool/impl/glob-search-tool.ts:87`（`walk()` 内 `opendir` 错误直接冒泡）→ `:79-83`（外层 catch 整体返回 `{files:[], error}`）。
- **触发条件**：搜索树中存在任一不可读子目录（chmod 000 / 属主不符——用户工作区内他人创建的目录是常见形态）。
- **错误行为 vs 契约**：整次搜索失败、已遍历到的全部候选丢弃，模型拿到空结果 + error。基线对照（二次复核均实测）：ripgrep 对权限拒绝跳过该目录继续扫描（返回其余结果、无 error）；JS 回退路径 `collectGrepFiles`（`grep-search-tool.ts:243-255`）本身就是 try/catch 跳过容错。
- **影响面**：仅 CLOUD 服务端执行路径；LOCAL 桌面走 `desktop/electron/main.cjs` 的 `handleLocalGlobSearch`（rg --files / readdirSync try/catch skip），**桌面 LOCAL 不受影响**。
- **验证**：`a.txt` + `locked/`（chmod 000）+ `**/*.txt`。真实失败输出：
  ```
  AssertionError: expected 'EACCES: permission denied, opendir \'…' to be undefined
  ```
  （且 `files` 不含 `a.txt`。）
- **为什么既有测试没抓住**：既有测试的目录树全部可读。
- **修复建议**：`walk()` 内对 `opendir`/遍历错误 try-catch，记 warn 日志后跳过该子目录继续（对齐 `collectGrepFiles`；可选在结果里带 `warnings`）。

---

## 复核移除记录（代码层面存在，但修复价值不足，从确认清单移除）

以下 3 项经独立复核确认缺陷真实（均有独立复现），但触发面/影响面不足以列入修复清单；其 `it.fails` 用例继续留在 spec 中作为已知缺陷留档，若后续顺手修复再转正。

- **BUG-3 analytics custom 区间不校验日历日（低）**：`backend-ts/src/admin/analytics-range.ts:90-96` 确实只过正则，`2026-02-30` 经 `Date.UTC` 溢出为 03-02（复现：`expected { days: 1, endOffset: 8 } to be null`），违反 `common/json.ts` `isValidYmd` 契约。但入参实际只有 admin 前端一处来源，`customRangeFromQuery`（`admin/src/views/analytics/chart-options.ts`）已用 `isValidYmd && start <= end` 守住，el-date-picker `value-format="YYYY-MM-DD"` 恒出合法日——非法日历日仅手写 API/CLI 可达；且下游有 days≤90、endOffset≤365 clamp，后果仅为只读统计窗口漂移。一行修复可顺手做，暂不列入。
- **BUG-4 glob_search total_matched 截断口径（低，初稿论据有误）**：glob 截断时 `total_matched = files.length`（= head_limit）属实。但初稿「与 grep_search 口径相反」经复核**不成立**：grep 的 `total_matches` 截断时同样只报返回条数（实测 100 文件 × 50 行 = 5000 真实命中，`max_output_chars` 截断后报 12；rg 路径 `grep-search-tool.ts:138-144` 与 JS 路径同构，均 break 后停止累计）。两工具 output schema 对该字段均无 description。实为**两工具共有的命名/语义问题**，单独修 glob 反而制造新的不一致；若修应两工具同改 + 补 schema description，价值低。
- **BUG-6 zipSkillsForLocal archiver 无 error 监听（低——死代码，已删除）**：缺陷复现属实（`skill-sync-service.ts` 仅挂 `'data'`，无 `'error'` 监听：条目 EACCES → 进程级 `uncaughtException` + Promise 永不 settle；且 backend-ts 无任何全局 `uncaughtException` 处理器，若可达则后果是进程崩溃）。但全仓 grep + `git log -S --all` 确认 `zipSkillsForLocal` **自引入（a5b966d4）即无任何生产调用方**；真实 zip 端点 `/v1/skills/sync-package`（`skill.routes.ts:226`）走 `writeSyncZip`（已 `pipeline` 收口，reject → Fastify 500）。**处置：2026-11-13 经确认直接删除该死代码**（功能已被 `writeSyncZip` 覆盖），原 `it.fails` 用例随删除一并移除。

## 否决候选（未计入确认清单）

1. **quick-command-parser 嵌套/重叠标记**（`desktop/src/utils/quick-command-parser.ts:43-53`）——子代理报告「收集阶段不排斥重叠 match、`lastIndex = m.end` 可回退」。**实证否决**：三个标记模式的匹配区间各含且仅含一个 `}`（值部分 `[^}]+` 不允许 `}`），任意两匹配区间若相交必有一方包含对方的 `}`，构造上矛盾；初稿 30 万随机串 fuzz + 二次复核独立实现区间相交检测器 fuzz 330 万串均**零重叠**，定向嵌套用例（`@{${cmd}$}@`、`#{${c}$}#`、`${@{x}@}$` 等）行为均唯一确定。`@{${cmd}$}@` 实际只产出内层 skill `cmd`（外层 file 因值含 `}` 根本无法匹配），非缺陷。
2. **desktop focusSort `new Date('yyyy-MM-dd HH:mm:ss')`**——该格式仅在旧 Safari 下解析为 NaN，本项目验证环境（jsdom/Chromium）均能解析，无法按「测试证实真实存在」的标准固化为用例；且 `timeOf`（`focusSort.ts:37-38`）已兜底 NaN→0，最坏是排序退化不崩溃。列为待观察。

## 后续

- **2026-11-13 已落地**：BUG-1（`V195__outbound_delivery_updated_at.sql` + `recoverInterrupted` 判据切换 + 终态/重试回写 CAS + `deliver()` 执行前状态重查）、BUG-2（`prefixLenWithinBytes` 按 code point 累积）、BUG-5（`openDirEntries` 子目录跳过续扫/根目录仍报错）；对应 `bugIt` 已转正为普通 `it` 回归，并新增根目录不可读用例。
- 遗留加固项（复核建议，不阻塞）：glob 目录流迭代中途出错（扫描期间目录被删）仍会整体失败，仅守住了打开动作；BUG-4 的 `total_matched`/`total_matches` 语义如修需两工具同改 + 补 output schema description。
- BUG-3/4 若后续修复，同样将 `it.fails` 转正为普通 `it`。
