# 逻辑 bug 审查 · 全域扫描（2026-11-11）

- 方法：单会话顺序深读（本轮约定不使用子代理）：既往审计已覆盖区（backend-ts common/signal/session/harness 核心、desktop 纯逻辑 utils、cloud 工具 `.bugcheck.spec.ts` 系列）先行排除，重点落在**近期新码与低审频区**（schedule cron 语义、agent-cli 本地回退路径、富文本粘贴转换、渠道回复出口）。候选逐条写成编码「正确契约」的存在性用例，**在当前代码上真实失败才确认**。
- 结论：**确认 5 个逻辑 bug**（2 后端 + 2 agent-cli + 1 desktop），全部有失败输出实证；同根因两面（BUG-2/BUG-3 共享 `globToRegExp`）按两个工具的两个独立缺陷分列。另有 3 条候选经核查否决（见文末）。
- 存在性用例**保留在仓库**（本轮任务要求「补充测试用例验证真实存在」），以 `bugIt = it.fails` 固化（expected-failure 通过、CI 保持绿色）；把 `bugIt` 改回 `it` 即复现失败，对应 BUG 修复后转正为常规断言（与 `logic-bug-review-2026-11-07.spec.ts` 生命周期同款）：
  - `backend-ts/src/logic-bug-review-2026-11-11.spec.ts`（BUG-1、BUG-5）
  - `agent-cli/test/logic-bug-review-2026-11-11.spec.ts`（BUG-2、BUG-3）
  - `desktop/src/utils/logic-bug-review-2026-11-11.test.ts`（BUG-4）
- 回归基线：三套 spec 在 `bugIt = it` 形态下共 7 例全部真实失败、`it.fails` 形态下全绿（backend 3 passed / agent-cli 3 passed / desktop 1 expected fail）；其所在套件既有用例无一改动。

## 确认清单

| # | 位置 | 严重度 | 一句话 |
|---|---|---|---|
| 1 | `backend-ts/src/schedule/scheduled-task.service.ts:275,1094,1109,1136,1342` | 高 | DOM+DOW 同时受限的 Spring cron 按 croner 默认 OR 语义触发，「1 月 1 日且周一」变成「1 月 1 日 + 每个周一」 |
| 2 | `agent-cli/src/local/tools/search.ts:56-85`（globWithNode 的 reBase） | 中 | glob node 回退把带目录前缀 pattern 退化成全仓 basename 匹配，越界文件全命中 |
| 3 | `agent-cli/src/local/tools/search.ts:7,173`（globToRegExp） | 中 | `**/` 不实现零目录语义，grep/glob 的 node 回退漏配 `src/` 直下与根目录文件 |
| 4 | `desktop/src/utils/html-to-markdown.ts`（turndown gfm tables 出口） | 中 | 表格单元格内容含 `\|` 未转义，GFM 表格列结构被撑破、整表串列 |
| 5 | `backend-ts/src/session/util/citation-markers.ts:75-85` | 中 | channelAssistantReply 空正文不回落兜底文案，渠道静默不发 / 发空卡 / 发空白消息三分叉 |

---

## BUG 1（高）：DOM+DOW 受限的 Spring cron 按 OR 语义触发（应为 AND）

- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts` 全部 5 处 Cron 构造——`:275`（buildCronPreview 预览）、`:1094`（下次档期计算）、`:1109`（校验）、`:1136`（预览）、`:1342`（调度器装载）——均为 `new Cron(normalizeSpringCron(...), { timezone: 'Asia/Shanghai' })`，缺 `legacyMode: false`。
- **触发条件**：用户创建 **DOM 与 DOW 同时受限** 的 Spring cron 任务，如 `0 0 12 1 1 1`（产品口径：每年 1 月 1 日且为周一才触发）。`normalizeSpringCron` 把 Spring 的 `?` 归一成 `*`，只有「DOM、DOW 双方都受限」的表达式才落入 croner `legacyMode`（默认 true = POSIX OR：任一命中即触发）与 Spring/Quartz（AND：两者都要满足）的语义分叉。
- **错误行为 vs 声明契约**：产品接受的方言是 Spring/Quartz（`normalizeSpringCron` 专门做 Spring→croner 归一，`buildCronPreview` 的 `message` 也按 Spring 语义描述）。Spring 下 `0 0 12 1 1 1` 上次触发是 2024-01-01、下次是 2029-01-01（约四年一遇）；当前实现按 OR 触发——**1 月 1 日之外，1 月的每个周一都会跑**（实测 nextRuns 从 2027-01-01 周五开始并把 2027 年 1 月每个周一排进触发列表）。用户配置「四年一次的年度巡检」实际变成「每年一月每周一次」，任务量放大约 4-5 倍且触发日大半不符合约定。
- **验证**（`backend-ts/src/logic-bug-review-2026-11-11.spec.ts`，驱动 `buildCronPreview('0 0 12 1 1 1', 5)`，断言每次触发同时满足「01-01」与「周一」）：

  ```ts
  for (const fireTime of preview.nextFireTimes) {
    expect(fireTime.slice(5, 10)).toBe('01-01');
    const [y, m, d] = fireTime.split(' ')[0]!.split('-').map(Number);
    expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(1);
  }
  ```

  实际失败输出：`AssertionError: 触发点 2027-01-01 12:00:00 不是周一（POSIX OR 语义把每个周一都排进来了）: expected 5 to be 1`。
- **为什么既有测试没抓住**：`scheduled-task.service.spec.ts` 的 cron 用例全部是「DOM 或 DOW 单方受限」形态（`0 0 9 * * ?`、`0 0 10 ? * MON-FRI` 等）——这些在 OR/AND 下行为相同；从未构造双方同时受限的表达式。`isOneShotCron` 的 `0 0 8 15 8 ?` 用例虽是双方受限形态，但它只测一次性判定、不测触发点。
- **修复方向**：5 处 Cron 构造统一加 `legacyMode: false`（croner 的 Quartz/AND 语义开关）。`normalizeSpringCron` 注释同步补一句「配合 legacyMode: false 才是 Spring 语义」，防回归时被当作多余参数删掉。

## BUG 2（中）：glob node 回退把带目录前缀的 pattern 退化成全仓 basename 匹配

- **位置**：`agent-cli/src/local/tools/search.ts` `globWithNode`（:56-85）：`re = globToRegExp(pattern)` 与 `reBase = globToRegExp(path.basename(pattern))` 三连 test（:75 目录文件 `re.test(relative) || re.test(entry.name) || reBase.test(entry.name)`，:81 根级文件同构）。
- **触发条件**：机器上 **rg 不可用**（`isRgAvailable()` false → `glob_search` 走 node 回退），glob pattern **带目录前缀**，如 `src/**/*.ts`。
- **错误行为 vs 声明契约**：契约是 rg `--glob` 同语义——`src/**/*.ts` 的匹配域是 `src/` 之下的 `.ts` 文件。实际 `reBase = globToRegExp(basename('src/**/*.ts')) = globToRegExp('**.ts') = ^.*\.ts$` 对任意文件名恒真，目录前缀被静默丢弃：`docs/b.ts`、仓库根下任何 `.ts` 全部命中。**同一仓库、同一 pattern，有 rg 的机器（云端）与无 rg 的机器（本地回退）返回不同文件集**，且是「多给」方向——模型基于「pattern 已限定 src/」的前提拿到越界文件后继续推理，越界文件内容被读进上下文。
- **验证**（`agent-cli/test/logic-bug-review-2026-11-11.spec.ts`，`vi.mock('node:child_process')` 强制 rg 不可用 → node 回退；临时目录 `src/a.ts` + `docs/b.ts`，pattern `src/**/*.ts`）：

  ```ts
  expect(out.files).toEqual(expect.arrayContaining([join('src', 'a.ts')]));
  expect(out.files.some((f) => f.includes('docs'))).toBe(false);
  ```

  实际失败输出：`AssertionError: expected true to be false`（第二条断言——`docs/b.ts` 被命中）。
- **为什么既有测试没抓住**：既有 search 测试要么有真 rg（走 `globWithRg`，语义正确），要么用纯文件名 pattern（`*.ts`，reBase 退化无害）；「带目录前缀 + 无 rg」组合无覆盖。
- **修复方向**：basename 匹配仅当 pattern 本身不含 `/`（纯文件名 pattern）时才参与；含 `/` 的 pattern 只按相对路径全量匹配。注意与 BUG-3 同修——只删 reBase 会让 `src/a.ts` 因 BUG-3 的 `**/` 缺陷反而漏配（见下），两处必须一起改。

## BUG 3（中）：globToRegExp 缺 `**/` 零目录语义——grep/glob 的 node 回退漏配

- **位置**：`agent-cli/src/local/tools/search.ts:7` `globToRegExp`（`**`→`.*`、`*`→`[^/]*` 直译），消费方 `grepWithNode` 的 globRe 过滤（:173 编译、:193 `!globRe.test(rel) && !globRe.test(path.basename(rel))` 跳过文件）。rg 路径（`grepWithRg` :277 把 glob 透传 `--glob`）语义正确，仅 node 回退分叉。
- **触发条件**：rg 不可用 + `grep_search`/`glob_search` 的 glob 带 `**/` 且目标文件**恰好落在 `**/` 应匹配「零个目录」的位置**——`src/**/*.ts` 命不中 `src/a.ts`；`**/*.ts` 连根目录 `.ts` 文件都命不中。
- **错误行为 vs 声明契约**：globset / gitignore / rg 的 `**/` 语义是「零个或多个目录」，`src/**/*.ts` 覆盖 `src/a.ts`。`globToRegExp('src/**/*.ts') = ^src/.*/[^/]*\.ts$` 在 `src/` 之后**强制要求还有一个目录段**：`src/a.ts`（rel 与 basename 都）不匹配 → 整文件跳过，`grep` 返回 0 命中。**与 BUG-2 相反的「少给」方向**——rg 机器命中、回退机器零命中；模型在本地设备上「搜不到」实际存在的文件，可能误判代码不存在后新建重复文件。
- **验证**（同 spec 两个用例，mock 强制回退）：

  ```ts
  // src/a.ts 内容 'export const a = 1;'，pattern 'export'，glob 'src/**/*.ts'
  expect(matches.map((m) => m.file)).toEqual(expect.arrayContaining([join('src', 'a.ts')]));
  // 根目录 c.ts，glob '**/*.ts'
  expect(matches.map((m) => m.file)).toEqual(expect.arrayContaining(['c.ts']));
  ```

  实际失败输出（两例同形）：`AssertionError: …被整文件漏掉: expected [] to deeply equal ArrayContaining ["src\a.ts"]`（matches 为空数组）。
- **为什么既有测试没抓住**：`grep-search-tool.spec.ts` 等云端同名测试测的是后端实现；agent-cli 回退路径的 glob 用例缺 `**/` 零目录样本（rg 在开发机可用时回退路径根本不执行）。
- **修复方向**：`globToRegExp` 把 `**/` 编译为 `(?:.*/)?`（整段 `**` 编译为 `.*`），与 globset 对齐；与 BUG-2 的 reBase 退化同批修复、同一组用例双向锁死（既不多给也不少给）。

## BUG 4（中）：富文本粘贴转 Markdown 的表格单元格 `|` 未转义

- **位置**：`desktop/src/utils/html-to-markdown.ts`（`convertHtmlToMarkdown` → turndown + turndown-plugin-gfm 的 tables 规则出口；`expandTableCells` 只做 colspan/rowspan 展开与首行 thead 化，不涉单元格文本转义）。
- **触发条件**：从 Excel / Word / 网页复制**含竖线的表格**（如「A|B 测试组」「key|value」列）粘贴进输入框，富文本转 Markdown 生效（0.0.513 输入效率包新路径）。
- **错误行为 vs 声明契约**：GFM 表格（CommonMark GFM spec）里 `|` 是单元格分隔符，单元格文本内的 `|` 必须转义为 `\|`，否则解析器按分隔符拆列。turndown-plugin-gfm 的 cell replacement **原样输出 cell 文本、不做管道转义**——`a|b` 落进单元格后渲染时被解析成两列，**表头 2 列变 3 列、后续行整体串列**，表格信息结构被静默破坏。粘贴转换的契约是「结构保真」（表头/行列数与原表格一致），列结构撑破即违约。
- **验证**（`desktop/src/utils/logic-bug-review-2026-11-11.test.ts`，真实 turndown + gfm，输入 `<th>a|b</th><th>c</th>` 的两列表）：

  ```ts
  expect(md).toContain('a\\|b');          // 转义后的管道符
  expect(md).not.toMatch(/a\|b/);         // 裸管道不允许存在
  ```

  实际失败输出：`AssertionError: …: expected '| a|b | c |\n| --- | --- |\n| 1 | 2 |' to contain 'a\|b'`——产出的表头行 `| a|b | c |` 按 GFM 解析恰成 3 列。
- **为什么既有测试没抓住**：`html-to-markdown.test.ts` 的表格用例（含 `expandTableCells` 系列）单元格内容都是普通中文/数字，无 `|` 样本；管道转义是 gfm tables 规则的已知盲区，首测即中。
- **修复方向**：在 gfm tables 出口对单元格文本补 `|`→`\|` 转义（包一层 cell replacement 或转换后按表格行还原局部转义）；同批把「单元格含换行」也评估掉（`\n` 在 cell 里同样破坏行结构，目前未构造用例、修转义时一并处理）。用例转正后并入 `html-to-markdown.test.ts` 结构组。

## BUG 5（中）：channelAssistantReply 空正文不回落兜底文案

- **位置**：`backend-ts/src/session/util/citation-markers.ts:75-85` `channelAssistantReply`——只要存在 ASSISTANT 行就 `return stripCitationMarkers(messages[i].content ?? '')`，fallback 仅在「一条 ASSISTANT 都没有」时返回。
- **触发条件**：渠道（飞书 / 钉钉 / 微信 / 定时任务回流）取最终回复时，**最后一条 ASSISTANT 正文为空 / 纯空白 / 剥掉 `[^n^]` 标记与定义行后只剩空白**（模型只发了工具调用、或回复全文只有引用标记与脚注定义行）。
- **错误行为 vs 声明契约**：函数 docstring 声明「语义（含**无回复时的兜底文案**）单点收敛」——fallback 的语义域是「无可用回复正文」，空/剥后空白显然在内。实际空串/空白原样返回，兜底文案 `抱歉，暂时无法生成回复。` 永不触发，下游三处行为分叉（全部真实代码路径）：
  1. `scheduled-task.service.ts:1231/:1311`（微信/飞书定时任务回流）：`if (!reply || reply.trim() === '') return;` → **静默不发**，用户对「任务跑了但什么都没收到」零感知；
  2. 飞书完成卡 `app-feishu-handler.ts:361` → `cardListener.complete('')` → **终态卡正文空白**；
  3. 飞书降级 plain reply（:362）：空串被 `!== ''` 守卫拦下、纯空白 `'   '` 却**穿过守卫发成空白消息**。
- **验证**（同 backend spec，直驱纯函数）：

  ```ts
  expect(channelAssistantReply([{ role: 'ASSISTANT', content: '' }], FALLBACK)).toBe(FALLBACK);
  expect(channelAssistantReply([{ role: 'ASSISTANT', content: '   ' }], FALLBACK)).toBe(FALLBACK);
  expect(channelAssistantReply([{ role: 'ASSISTANT', content: '[^1^]\n[^1^]: https://example.com' }], FALLBACK)).toBe(FALLBACK);
  expect(channelAssistantReply([{ role: 'ASSISTANT', content: '旧' }, { role: 'ASSISTANT', content: '' }], FALLBACK)).toBe(FALLBACK);
  ```

  实际失败输出：`AssertionError: expected '' to be '抱歉，暂时无法生成回复。'`（四断言同一形态）。
- **契约边界说明**：`feishu/agent-inbound-handler.ts:21` 注释「取最后一条 ASSISTANT，不论 content 是否为空」约束的是 **messageId 归属**（终态卡快照必须绑本轮最后一条消息，不能落到更早的有内容消息上——否则点踩反馈打错对象），与**文本出口**应否回落兜底是两件事；本条修复只动文本选择（剥标记后 trim 空白 → fallback），messageId 选取逻辑一行不动。同样地，「不回落更早一条 ASSISTANT 的旧正文」（第四断言）也符合该注释「不落旧消息」的精神——兜底文案比空正文和旧正文都更忠实。
- **为什么既有测试没抓住**：`citation-markers.spec.ts` 只测了「有正文时剥标记」与「无 ASSISTANT 时兜底」，空正文样本缺位；渠道集成测试全部用有内容的回复。
- **修复方向**：`channelAssistantReply` 取到最后一条 ASSISTANT 后先剥标记，`trim()` 为空则继续**向更早的 ASSISTANT 找**吗？——不。按 messageId 归属同口径，空即本轮无话可说，直接返回 fallback。一行改动 + 本 spec 转正。

---

## 已核查并排除（否决候选记录）

1. **`isOneShotCron('0 0 8 15 8 ?')` 把年度任务判成一次性**——误报。固定日期（秒/分/时/日/月全固定、周通配）= 一次性任务是 2026-11-03 审查定下的产品契约（`logic-bug-review-2026-11-03.spec.ts` BUG-3 与 `scheduled-task.service.spec.ts:281` 双重固化）：这类 cron 的语义就是「到了这个日期跑一次然后完结」，不是「每年重复」。判 true 是正确行为。
2. **`docker ps --filter name=^/...$` 锚定语义存疑（容器孤儿复核过滤）**——无法实证。Windows 开发机 docker daemon 需提权不可用，`name` filter 的正则锚定行为拿不到一手证据；按「避免误报」原则弃。Linux 线上可用 `docker ps -a --filter 'name=^/mao-user-1-agent-2$'` 对照无锚点 filter 实测一轮再决定是否补。
3. **csv-parse `sniffDelimiter` 首行引号内换行截断嗅探**——边缘且契约内。`findFirstLineEnd` 取第一个物理换行，首条记录跨行（引号内换行）时嗅探只看到半行；但分隔符取 `,` `\t` `;` 频次最大者，半行零候选时回落逗号，仅「TSV + 首记录跨行」组合会错判。量级不足以立 bug，留档备查。

## 备注

- BUG-2 / BUG-3 同根因（`globToRegExp` + reBase 退化），修复与转正用例建议同一批提交：单独修任一面都会被另一面的既有断言顶回来（只删 reBase → `src/a.ts` 漏配；只修 `**/` → `docs/b.ts` 仍越界命中）。
- BUG-1 修复是 5 处加参 + 注释，改动零行为面之外风险；转正用例即现 spec（改回 `it` 后应通过）。
- 本轮未要求提交推送；三个 spec 文件与本报告已落盘，等用户指令再走提交。
