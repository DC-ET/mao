# 逻辑 bug 审查 · 全域扫描（2026-11-11）

- 方法：单会话顺序深读（本轮约定不使用子代理）：既往审计已覆盖区（backend-ts common/signal/session/harness 核心、desktop 纯逻辑 utils、cloud 工具 `.bugcheck.spec.ts` 系列）先行排除，重点落在**近期新码与低审频区**（schedule cron 语义、agent-cli 本地回退路径、富文本粘贴转换、渠道回复出口）。候选逐条写成编码「正确契约」的存在性用例，**在当前代码上真实失败才确认**。
- 结论：**确认 4 个逻辑 bug**（1 后端 + 2 agent-cli + 1 desktop），全部有失败输出实证；同根因两面（BUG-2/BUG-3 共享 `globToRegExp`）按 `glob_search` / `grep_search` 两条出口分列。另有 3 条候选经核查否决，以及 1 条原确认项经复核回退（见文末）。**4 条已于 2026-11-11 全部修复**，存在性用例已转正为常规回归断言。
- 存在性用例已随修复**转正为常规回归用例**（不再使用 `it.fails`）：
  - `backend-ts/src/logic-bug-review-2026-11-11.spec.ts`（BUG-1，2 例）
  - `agent-cli/test/logic-bug-review-2026-11-11.spec.ts`（BUG-2、BUG-3，4 例）
  - `desktop/src/utils/logic-bug-review-2026-11-11.test.ts`（BUG-4，1 例）
- 回归基线：三套 spec 共 7 例全部通过（backend 2 / agent-cli 4 / desktop 1）；其所在套件既有用例无一改动。三端完整套件与构建见文末「修复记录」。

## 确认清单

修复价值按「影响面 × 触发频率 ÷ 修复成本」粗评；中/高表示建议修，低表示留档不修。本轮复核后保留 4 条，原 BUG-5 回退见文末。**4 条均已修复，状态见文末「修复记录」。**

| # | 位置 | 严重度 | 修复价值 | 一句话 |
|---|---|---|---|---|
| 1 | `backend-ts/src/schedule/scheduled-task.service.ts` 的 5 处 Cron 构造（buildCronPreview / calculateNextFireTime / cronFiresAt / parseCron / compensateMissed） | 高 | 高 | DOM+DOW 同时受限的 Spring cron 按 croner 默认 OR 语义触发，「1 月 1 日且周一」变成「1 月 1 日 + 每个周一」 |
| 2 | `agent-cli/src/local/tools/search.ts` `globWithNode` 的目录遍历 | 中 | 中 | glob node 回退把带目录前缀 pattern 退化成全仓 basename 匹配，越界文件全命中 |
| 3 | `agent-cli/src/local/tools/search.ts:12` `globToRegExp` + `grepWithNode` 的 globRe 过滤 | 中 | 高 | `**/` 不实现零目录语义，grep 的 node 回退漏配 `src/` 直下与根目录文件；glob 回退当前被 reBase 退化掩盖，修 BUG-2 后同样受影响 |
| 4 | `desktop/src/utils/html-to-markdown.ts`（turndown gfm tables 出口） | 中 | 中 | 表格单元格内容含竖线未转义，GFM 表格列结构被撑破、整表串列 |

---

## BUG 1（高）：DOM+DOW 受限的 Spring cron 按 OR 语义触发（应为 AND）

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts` 全部 5 处 Cron 构造——`buildCronPreview`（预览）、`calculateNextFireTime`（下次档期计算）、`cronFiresAt`（排队结算校验）、`parseCron`（创建/更新校验）、`compensateMissed`（补跑）——修复前均为 `new Cron(normalizeSpringCron(...), { timezone: 'Asia/Shanghai' })`，缺 `legacyMode: false`。
- **触发条件**：用户创建 **DOM 与 DOW 同时受限** 的 Spring cron 任务，如 `0 0 12 1 1 1`（产品口径：每年 1 月 1 日且为周一才触发）。`normalizeSpringCron` 把 Spring 的 `?` 归一成 `*`，只有「DOM、DOW 双方都受限」的表达式才落入 croner `legacyMode`（默认 true = POSIX OR：任一命中即触发）与 Spring/Quartz（AND：两者都要满足）的语义分叉。
- **错误行为 vs 声明契约**：产品接受的方言是 Spring/Quartz（`normalizeSpringCron` 专门做 Spring→croner 归一，`docs/plan/2026-07-27-scheduled-task-system-design.md:195` 明写「使用 Spring `CronExpression`」，UI 提示也写明「6 位 Spring 表达式」，`buildCronPreview` 的 `message` 按 Spring 语义描述）。Spring 的 `CronExpression` 把 DOM、DOW 两个字段依次收敛（两者都受限时取交集）；当前实现按 OR 触发——**1 月 1 日之外，1 月的每个周一都会跑**（实测 nextRuns 从 2027-01-01 周五开始并把 2027 年 1 月每个周一排进触发列表）。用户配置「四年一次的年度巡检」实际变成「每年一月每周一次」，任务量从四年一次变成每年 4-5 次（约 20 倍）且触发日大半不符合约定。
- **修复价值**：高。错误的触发档期会带来真实的任务执行、通知与模型调用成本；修复只是 5 处构造统一加一个 croner 选项（`legacyMode` 只改 DOM/DOW 的 OR/AND 组合，其余字段语义不变），行为面之外无改动。触发表达式较窄（必须两个字段同时受限），但产品没有拒绝这种写法，预览也会直接把错误档期展示给用户。
- **验证**（`backend-ts/src/logic-bug-review-2026-11-11.spec.ts`，驱动 `buildCronPreview('0 0 12 1 1 1', 5)`，断言每次触发同时满足「01-01」与「周一」）：

  ```ts
  for (const fireTime of preview.nextFireTimes) {
    expect(fireTime.slice(5, 10)).toBe('01-01');
    const [y, m, d] = fireTime.split(' ')[0]!.split('-').map(Number);
    expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(1);
  }
  ```

  实际失败输出：`AssertionError: 触发点 2027-01-01 12:00:00 不是周一（POSIX OR 语义把每个周一都排进来了）: expected 5 to be 1`。
- **为什么既有测试没抓住**：`scheduled-task.service.spec.ts` 的 cron 用例全部是「至多一方受限」形态（`0 0 9 * * ?` 两方都通配、`0 0 10 ? * MON-FRI` 仅 DOW 受限等）——这些在 OR/AND 下行为相同；从未构造双方同时受限的表达式。`isOneShotCron` 的 `0 0 8 15 8 ?` 用例只测一次性判定、不测触发点（DOW 的 `?` 归一后是通配，本身也不是双方受限形态）。
- **修复（已落地）**：新增 `CRON_OPTIONS = { timezone: 'Asia/Shanghai', legacyMode: false }`，5 处 Cron 构造统一使用；`normalizeSpringCron` 注释补「配合 legacyMode: false 才是 Spring 语义」。`legacyMode` 只改 DOM/DOW 的 OR/AND 组合，其余字段语义不变。注意：`?` 必须先归一成 `*` 再交给 croner；`normalizeSpringCron` 已保证这一点。回归用例转为常规断言，并新增 `0 0 10 ? * MON-FRI` 不被 AND 误伤的用例。

## BUG 2（中）：glob node 回退把带目录前缀的 pattern 退化成全仓 basename 匹配

- **位置**：`agent-cli/src/local/tools/search.ts` `globWithNode` 的目录遍历：修复前 `re = globToRegExp(pattern)` 与 `reBase = globToRegExp(path.basename(pattern))` 三连 test（目录文件 `re.test(relative) || re.test(entry.name) || reBase.test(entry.name)`，单文件分支 `re.test(name) || reBase.test(name)`）——`reBase` 让带目录前缀的 pattern 退化成全仓 basename 匹配。
- **触发条件**：机器上 **rg 不可用**（`isRgAvailable()` false → `glob_search` 走 node 回退），glob pattern **带目录前缀**，如 `src/**/*.ts`。
- **错误行为 vs 声明契约**：契约是 rg `--glob` 同语义——`src/**/*.ts` 的匹配域是 `src/` 之下的 `.ts` 文件。实际 `reBase = globToRegExp(path.basename('src/**/*.ts')) = globToRegExp('*.ts') = ^[^/]*\.ts$` 对任意目录下的 `.ts` basename 恒真，目录前缀被静默丢弃：`docs/b.ts`、仓库根下任何 `.ts` 全部命中。**同一仓库、同一 pattern，有 rg 的机器（云端）与无 rg 的机器（本地回退）返回不同文件集**，且是「多给」方向——模型基于「pattern 已限定 src/」的前提拿到越界文件后继续推理，越界文件内容被读进上下文。
- **修复价值**：中。只在 rg 缺失的回退路径触发（设计文档明确「缺失时降级到 Node 实现」，所以不是死代码），但结果是「多给」：越界文件会被模型当成 pattern 内的结果读取；修复只需收窄 basename 兜底，成本低。
- **验证**（`agent-cli/test/logic-bug-review-2026-11-11.spec.ts`，`vi.mock('node:child_process')` 强制 rg 不可用 → node 回退；临时目录 `src/a.ts` + `docs/b.ts`，pattern `src/**/*.ts`）：

  ```ts
  expect(out.files).toEqual(expect.arrayContaining([join('src', 'a.ts')]));
  expect(out.files.some((f) => f.includes('docs'))).toBe(false);
  ```

  实际失败输出：`AssertionError: expected true to be false`（第二条断言——`docs/b.ts` 被命中）。
- **为什么既有测试没抓住**：`local-search.spec.ts` 的 node 回退用例只有 `**/*.ts` + `src/a.ts`（`src/a.ts` 有目录段，`re` 本身就能命中），fixture 没有根级 `.ts`，也没有前缀之外的同类文件；`glob-truncated.bugcheck.spec.ts` 只用纯文件名 `*.ts`，reBase 退化无害。「带目录前缀 + 无 rg」组合无覆盖。
- **修复（已落地）**：目录遍历去掉 `reBase` 兜底，路径模式只按相对路径匹配；纯 basename pattern 由 `re.test(entry.name)` 覆盖。显式单文件作用域保留 basename 兜底（rg 对显式文件目标不做 glob 过滤，带目录前缀 pattern 仍应能命中该文件）。匹配前用 `toPosixPath` 把相对路径统一成 `/`，Windows 上 `path.relative` 的反斜杠不再导致失配；结果输出仍保留平台路径形态。注意与 BUG-3 同修——只删 reBase 会让 `src/a.ts` 因 `**/` 缺陷反而漏配。

## BUG 3（中）：globToRegExp 缺 `**/` 零目录语义——grep node 回退漏配（glob 被 reBase 掩盖）

- **位置**：`agent-cli/src/local/tools/search.ts:12` `globToRegExp`（`**`→`.*`、`*`→`[^/]*` 直译），消费方 `grepWithNode` 的 globRe 过滤（编译后 `!globRe.test(matchRel) && !globRe.test(path.posix.basename(matchRel))` 跳过文件）。rg 路径（`grepWithRg` 把 glob 透传 `--glob`）语义正确，仅 node 回退分叉。
- **触发条件**：rg 不可用 + `grep_search` 的 glob 带 `**/` 且目标文件**恰好落在 `**/` 应匹配「零个目录」的位置**——`src/**/*.ts` 命不中 `src/a.ts`；`**/*.ts` 连根目录 `.ts` 文件都命不中。`glob_search` 当前因 reBase 退化而「看似命中」这些文件（见 BUG-2），但根因同一处，修 BUG-2 去掉 reBase 后会同样漏配。
- **错误行为 vs 声明契约**：globset / gitignore / rg 的 `**/` 语义是「零个或多个目录」，`src/**/*.ts` 覆盖 `src/a.ts`。`globToRegExp('src/**/*.ts') = ^src/.*/[^/]*\.ts$` 在 `src/` 之后**强制要求还有一个目录段**：`src/a.ts`（rel 与 basename 都）不匹配 → 整文件跳过，`grep` 返回 0 命中。**与 BUG-2 相反的「少给」方向**——rg 机器命中、回退机器零命中；模型在本地设备上「搜不到」实际存在的文件，可能误判代码不存在后新建重复文件。
- **修复价值**：高。grep 是模型定位代码的主要入口，「少给」比「多给」更危险——静默零命中会让模型得出错误结论；修复与 BUG-2 共用同一组匹配用例，边际成本低。
- **验证**（同 spec 两个用例，mock 强制回退；两例都驱动 `grep_search`）：

  ```ts
  // src/a.ts 内容 'export const a = 1;'，pattern 'export'，glob 'src/**/*.ts'
  expect(matches.map((m) => m.file)).toEqual(expect.arrayContaining([join('src', 'a.ts')]));
  // 根目录 c.ts，glob '**/*.ts'
  expect(matches.map((m) => m.file)).toEqual(expect.arrayContaining(['c.ts']));
  ```

  实际失败输出（两例同形）：`AssertionError: …被整文件漏掉: expected [] to deeply equal ArrayContaining ["src\a.ts"]`（matches 为空数组）。
- **为什么既有测试没抓住**：`local-search.spec.ts` 的 node 回退用例只有 `**/*.ts` + `src/a.ts`（有目录段，`re` 能命中），没有根级 `c.ts`，也没有带目录前缀的 `src/**/*.ts`；grep 的 glob 用例只用了 `*.ts`（无 `/`），`**/` 的零目录语义从未被断言。
- **修复（已落地）**：`globToRegExp` 把 `**/` 先替换为占位符、再编译为 `(?:.*/)?`（整段 `**` 编译为 `.*`），`?` 在展开占位符前替换，避免误伤 `(?:.*/)?` 里的 `?`；与 BUG-2 的 reBase 收窄同批修复。新增 `glob_search` 的 `**/*.ts` 根目录 + 嵌套文件回归用例，锁死删除 reBase 后的零目录匹配。

## BUG 4（中）：富文本粘贴转 Markdown 的表格单元格 `|` 未转义

- **位置**：`desktop/src/utils/html-to-markdown.ts`（`convertHtmlToMarkdown` → turndown + turndown-plugin-gfm 的 tables 规则出口；`expandTableCells` 只做 colspan/rowspan 展开与首行 thead 化，不涉单元格文本转义）。
- **触发条件**：从 Excel / Word / 网页复制**含竖线的表格**（如「A|B 测试组」「key|value」列）粘贴进输入框，富文本转 Markdown 生效（0.0.513 输入效率包新路径）。
- **错误行为 vs 声明契约**：GFM 表格（CommonMark GFM spec）里 `|` 是单元格分隔符，单元格文本内的 `|` 必须转义为 `\|`，否则解析器按分隔符拆列。turndown-plugin-gfm 的 cell replacement **原样输出 cell 文本、不做管道转义**——`a|b` 落进单元格后渲染时被解析成两列，**表头 2 列变 3 列、后续行整体串列**，表格信息结构被静默破坏。粘贴转换的契约是「结构保真」（表头/行列数与原表格一致），列结构撑破即违约。
- **修复价值**：中。输入较窄（表格单元格里出现竖线），但一旦命中就是静默的结构损坏，且修复集中在 gfm tables 出口。不属于「高频但可忍」的显示瑕疵。
- **验证**（`desktop/src/utils/logic-bug-review-2026-11-11.test.ts`，真实 turndown + gfm，输入 `<th>a|b</th><th>c</th>` 的两列表）：

  ```ts
  expect(md).toContain('a\\|b');          // 转义后的管道符
  expect(md).not.toMatch(/a\|b/);         // 裸管道不允许存在
  ```

  实际失败输出：`AssertionError: …: expected '| a|b | c |\n| --- | --- |\n| 1 | 2 |' to contain 'a\|b'`——产出的表头行 `| a|b | c |` 按 GFM 解析恰成 3 列。
- **为什么既有测试没抓住**：`html-to-markdown.test.ts` 的表格用例（含 `expandTableCells` 系列）单元格内容都是普通中文/数字，无 `|` 样本；管道转义是 gfm tables 规则的已知盲区，首测即中。
- **修复（已落地）**：在 gfm tables 规则之后注册同名 `tableCell` 覆盖规则，保留原 cell 前缀逻辑，输出前把单元格文本里的 `|` 转成 `\|`；表头与表体同规则。回归用例覆盖表头 + 表体，断言两列结构不变。

---

## 已核查并排除（否决候选 + 回退项）

1. **`isOneShotCron('0 0 8 15 8 ?')` 把年度任务判成一次性**——误报。固定日期（秒/分/时/日/月全固定、周通配）= 一次性任务是 2026-11-03 审查定下的产品契约（`logic-bug-review-2026-11-03.spec.ts` BUG-3 与 `scheduled-task.service.spec.ts:281` 双重固化）：这类 cron 的语义就是「到了这个日期跑一次然后完结」，不是「每年重复」。判 true 是正确行为。
2. **`docker ps --filter name=^/...$` 锚定语义存疑（容器孤儿复核过滤）**——无法实证。Windows 开发机 docker daemon 需提权不可用，`name` filter 的正则锚定行为拿不到一手证据；按「避免误报」原则弃。Linux 线上可用 `docker ps -a --filter 'name=^/mao-user-1-agent-2$'` 对照无锚点 filter 实测一轮再决定是否补。
3. **csv-parse `sniffDelimiter` 首行引号内换行截断嗅探**——边缘且契约内。`findFirstLineEnd` 取第一个物理换行，首条记录跨行（引号内换行）时嗅探只看到半行；但分隔符取 `,` `\t` `;` 频次最大者，半行零候选时回落逗号，仅「TSV + 首记录跨行」组合会错判。量级不足以立 bug，留档备查。
4. **`channelAssistantReply` 空正文不回落兜底文案（原 BUG-5）**——复核回退，不是 logic bug，是既有契约 + 产品取舍：
   - `citation-markers.spec.ts:125` 已明确固化「`content` 为 null 时按空串处理（剥标记后返回空串）」，不是「空正文样本缺位」；函数 docstring 的「无回复」指消息列表中没有 ASSISTANT 行，而不是最后一条 ASSISTANT 正文为空。
   - 下游 `scheduled-task.service.ts:1232/:1312` 的 `if (!reply || reply.trim() === '') return;` 与 `feishu/agent-inbound-handler.ts:362` 的 `reply.text !== ''` 守卫，都是对空回复的显式处理；飞书 `cardListener.complete('')` 的空白终态卡是同一契约的结果。
   - 是否把空回复改成「抱歉，暂时无法生成回复。」（静默 vs 歉意、空卡 vs 占位）属于产品决策，需同时改既有单测与三处下游；按 bug 修复会与 `citation-markers.spec.ts` 的既有断言直接冲突。原存在性用例已随本条从 `backend-ts/src/logic-bug-review-2026-11-11.spec.ts` 移除。

## 备注与修复记录

- BUG-2 / BUG-3 在同一条匹配链上（`globToRegExp` + `globWithNode` 的 reBase 退化），必须同批修：只删 reBase → `src/a.ts` 因 `**/` 缺零目录语义漏配；只修 `**/` → `docs/b.ts` 仍越界命中。两处已一起改，并用「src/ 直下 + docs 越界 + 根目录 + 嵌套目录」样本双向锁死。修复时已把 `path.relative` 的结果用 `toPosixPath` 统一成 `/` 分隔，Windows 回退路径不再因反斜杠失配（本轮未单独构造 Windows 用例）。
- BUG-1 修复是 5 处构造统一切到 `CRON_OPTIONS`（`{ ...CRON_OPTIONS }` 展开传入，避免 croner 改写共享对象；`legacyMode: false`），其余字段语义不变；回归用例已转正并补单方受限表达式。
- 4 条均已修复；存在性用例已转正，原 BUG-5 的回退用例已移除。用户可见改动已记入 `CHANGELOG.md` 0.0.518。

### 修复记录（2026-11-11）

| BUG | 改动 | 验证 |
|---|---|---|
| BUG-1 | `scheduled-task.service.ts` 新增 `CRON_OPTIONS` 并替换 5 处 Cron 构造；`normalizeSpringCron` 注释补 Spring/legacyMode 关系 | `logic-bug-review-2026-11-11.spec.ts` 2 passed；`scheduled-task.service.spec.ts` + `scheduled-task-reliability.spec.ts` 91 passed；后端全量 476 files / 5901 tests passed；`npm run build` passed |
| BUG-2 / BUG-3 | `globToRegExp` 支持 `**/` 零目录语义；`globWithNode` 目录遍历去掉 reBase；新增 `toPosixPath` 统一匹配路径分隔符；`grepWithNode` 使用归一后路径匹配 | `logic-bug-review-2026-11-11.spec.ts` 4 passed（含新增 glob 根目录用例）；agent-cli 全量 65 files / 713 tests passed；`npm run build` + `npm run typecheck` passed |
| BUG-4 | `html-to-markdown.ts` 在 gfm 规则后覆盖 `tableCell`，单元格文本 `\|` 转义 | `logic-bug-review-2026-11-11.test.ts` 1 passed；`html-to-markdown.test.ts` 21 passed；desktop `test:unit` 195 files / 1979 tests passed；`npm run build` passed |
