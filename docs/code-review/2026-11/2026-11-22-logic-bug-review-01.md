# 逻辑 BUG 审查报告（全仓第五轮）

- 日期：2026-11-22
- 审查方式：4 个只读审计代理并行分区扫描（harness 引擎+终端、后端领域服务、desktop 工具/composables、通道+agent-cli）+ 主会话逐条「反证 → 按正确契约写用例 → 普通 it 实跑抓真实失败 → it.fails 固化」实证。审计代理报 8 个候选，**1 个经主会话核实为误报排除**（详见「误报记录」），2 个机制成立但依赖线上行为/产品意图无法离线实锤，留档「候选未确认」，最终确认 5 个。
- 复核记录（2026-11-22 当日，独立复核员逐条反证）：5 条确认项全部把 `bugIt` 临时转普通 it 实跑复核——真实失败输出与下文「验证输出」一致（BUG-1 的探针派发载荷 `{"name":"shell","args":"{\"command\":{\"path\":\"a.ts\"}\"pwd\"}"}` 逐字节复现），且逐一核查上下游调用链未发现报告遗漏的守卫，**0 移除、0 降级**；就地修正 BUG-2 修复方向表述（demoteDeadActive 已自带 failPending，见该节）；2 条候选补强证据后维持「未确认」（候选 1 取得飞书官方文档口径佐证、仍缺线上实测；候选 2 剥离行为已离线实证、缺产品意图定论）；「误报记录」的 Buffer.length 语义核实无误、维持排除。
- 惯例同 logic-bug-review-2026-11-13：验证用例已随本报告**提交进仓库**（`backend-ts/src/logic-bug-review-2026-11-22.spec.ts`、`agent-loop.spec.ts` / `terminal-host-handler.spec.ts` 内的 bugIt 用例、`desktop/src/utils/logic-bug-review-2026-11-22.test.ts`），按正确契约书写、以 `bugIt = it.fails` 固化为 expected-failure 保持 CI 绿；**修复后转正为普通 it 回归**。每个 bug 均先以普通 it 实跑捕获真实失败输出（下文「验证输出」即为实跑结果），排除环境性误报。
- 基线：backend-ts `npm run build` 0 错；受影响 3 个后端 spec 62 例全绿（含 expected-fail）；desktop 新增 spec 6 例（4 passed | 2 expected fail）。
- **修复记录（2026-11-22 当日）**：5 条确认项全部修复并同日全量回归通过——BUG-1 兜底补 `delta.index == null` 前置、BUG-2 `failPendingForDevice` 移入替换分支（standby 路径不再触发）、BUG-3 六处裸 slice 统一换 `common/utf8.ts` 的 `clipByCodePoints`（card-progress-listener 4 处 + dingtalk/card-body + progress-card，顺带收口同类 merge-forward.ts `spill`）、BUG-4 `nextHunkIndex` 初值反向映射补齐、BUG-5 满额后剩余内容轻量扫描（剥引号空白）判定 truncated。全部 `bugIt` expected-failure 用例已转正为普通 it 回归（回归锚点用例保留）。

---

## 确认清单（5 个，按严重度排序）

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| BUG-1 | 高 | `backend-ts/src/harness/core/agent-loop.ts:901` | findMergeTarget 兜底吞掉第二条 tool call，派发出参数损坏的调用 |
| BUG-2 | 中 | `backend-ts/src/harness/terminal/terminal-host-handler.ts:238` | CLI 到场待命（standby）误杀活跃主机在途 open：报「设备离线」或留下孤儿 PTY |
| BUG-3 | 中 | `backend-ts/src/feishu/card-progress-listener.ts:93,130,134`、`backend-ts/src/dingtalk/card-body.ts:57` 等同链路 slice | 卡片文本按 UTF-16 码元硬切，边界 emoji 产出孤立代理进入卡片 JSON |
| BUG-4 | 中低 | `desktop/src/utils/diff-view-mode.ts:30` | diff 变更跳转「首次按 ↑」落点差一，跳过最后一处变更 |
| BUG-5 | 低 | `desktop/src/utils/csv-parse.ts:100` | 行数上限的 truncated 标志对「恰好满额 + 拖尾空行」误报 |

---

## BUG-1（高）findMergeTarget 的 provisional 兜底缺 index 前置条件，吞掉第二条 tool call

**文件与位置**：`backend-ts/src/harness/core/agent-loop.ts:893-903`

```ts
      if (delta.index != null) {
        const byIndex = existing.find((tc) => tc.index === delta.index);
        if (byIndex) return byIndex;
      }
      // 真实 id 首片不带 index（部分网关的参数分片无 index 字段）：byId/byIndex 都落空时，
      // 恰有一条未写回真实 id 的占位调用，它就是归并目标——否则同一调用会被拆成两条
      // 重复派发（占位参数截断 + 无名尾巴），用户命令实际未被完整执行。
      // 多条占位时无法判定归属，保持旧行为。
      const provisional = existing.filter((tc) => tc.id != null && provisionalIds.has(tc.id));
      if (provisional.length === 1) return provisional[0];   // ← 901 行：delta.index != null 时也会走到
      return undefined;
```

**根因**：兜底注释自述的适用前提是「真实 id 首片**不带 index**」，但代码在 `delta.index != null` 且 byIndex 落空时同样落入。byIndex 落空意味着现有调用里**没有任何一条持有该 index**——按流式协议这必然是一条**新** tool call（应走 push 分支），当前却把它并进唯一一条 provisional 占位（index 0 的首条调用）：

- `applyToolCallDelta` 只接受首个非空 name → `read_file` 的 name 被丢弃（目标已是 `shell`）；
- arguments 被串接成非法 JSON；
- 占位 id 被写回 `call-read` 并移出 provisional 集合；
- 后续 `index: 0` 的参数分片又按 byIndex 归并进同一条调用。

**实测缺陷路径的最终派发**（探针输出，见「验证输出」）：只派发一条 `{toolName:'shell', argumentsJson:'{"command":{"path":"a.ts"}"pwd"}'}`——非法 JSON、第二条调用整条丢失，而模型认为两个调用都会执行。

**触发输入**：同一轮流中，第一条 tool call 首片无 id（合成占位），后续某条 tool call 首片带真实 id 且 index 不匹配任何现有调用。本函数注释本身就承认网关在 id/index 上有多种漂移形态（"部分网关的参数分片无 index 字段""部分 OpenAI 兼容网关不回传 id"），混用形态是同一类漂移的自然延伸。

**验证输出**（普通 it 实跑，`agent-loop.spec.ts` bugIt 用例）：

```
× AgentLoop > findMergeTarget 兜底：带 index 且 byIndex 落空的 id 首片必须追加为新调用，不得并入占位调用
  → expected "spy" to be called 2 times, but got 1 times
探针（缺陷路径实际派发）：
ZZ dispatches= [{"name":"shell","args":"{\"command\":{\"path\":\"a.ts\"}\"pwd\"}"}]
```

**反证**：(1) 函数内注释明确兜底前提是"首片不带 index"，与 `delta.index != null` 仍落入矛盾；(2) 引入兜底前的旧行为在 byIndex 落空时 `return undefined` → push 成新调用；(3) 既有测试 "creates tool calls from index-only deltas…" 与 "merges a late id-bearing delta…" / "merges a first id-bearing delta without index…" 分别锁定「无 id 按 index 追加」与「id 首片不带 index 归并」，均不涉及本场景，修复不破坏被锁行为。

**修复方向**：兜底仅限 `delta.index == null`，或追加 `provisional[0].index === delta.index` 校验。

---

## BUG-2（中）standby 分支前置的 failPendingForDevice 杀掉活跃主机仍会应答的在途 open

**文件与位置**：`backend-ts/src/harness/terminal/terminal-host-handler.ts:236-247`

```ts
    // 被替换的活跃主机是另一个进程（同一进程不会开第二条主机连接）：
    // 它的在途 open 不会再应答，立即失败，不等 10 秒超时
    this.deps.relay.failPendingForDevice(userId, deviceId);
    if (current.client === 'electron' && client === 'cli') {
      // D12：Electron 活跃时 CLI 只能待命，不替换（PTY 不能迁进程）
      conn.active = false;
```

**根因**：`failPendingForDevice` 的注释理由只适用于**替换**路径（被替换进程的在途 open 不会再应答）。但它在 standby 分支之前无条件执行：Electron 仍是活跃主机（`hasActiveHost === true`、CLI 收到 `role:'standby'` 的同时 relay 收到 `failPending`），此刻发往该活跃 Electron 的在途 open（10 秒窗口）本会得到 `opened` 应答，却被强制 reject。两种后果：

1. 主机尚未处理 open：用户拿到「执行端设备离线」，设备明明在线；
2. 主机已 spawn PTY：稍后回的 `opened` 帧到 relay 时 pending 已删、被静默丢弃——设备上留下一个**无登记的孤儿 PTY**（reconcile 只关「列表外的登记」、HOST_LOST 只关「已登记的终端」，孤儿两边都够不着，直到设备断开）。

**触发输入**：Electron 为活跃主机 + 某终端 open 在途（≤10s）+ 同设备 mao-agent CLI 发起 auth——典型于设备上 CLI 重启 / 首次连接的时机。

**验证输出**（普通 it 实跑，`terminal-host-handler.spec.ts` bugIt 用例；对照用例锁定替换路径行为不变）：

```
× TerminalHostHandler > BUG（2026-11-22 审查）：CLI 到场待命（standby）不得 failPending——
  活跃 Electron 的在途 open 仍会被正常应答
AssertionError: expected [ { op: 'failPending', …(1) } ] to have a length of +0 but got 1
✓ 对照（替换路径）：CLI 活跃时 Electron 到场顶替，旧主机在途 open 必须 failPending
```

**反证**：(1) standby 分支自带的注释「Electron 活跃时 CLI 只能待命，**不替换**」直接否定「在途 open 不会再应答」的前提；(2) `demoteDeadActive`（活跃连接已半死）与替换路径各自需要 failPending，standby 路径不需要；(3) 既有 D12 用例未断言 failPending，该行为未被锁定为契约。

**修复方向**：把 handleAuth 里无条件的 `failPendingForDevice` 下移进替换分支（与 `closeSocket(current.socket)` 同处）；`demoteDeadActive` 已自带该调用（`:268`），无需改动。

---

## BUG-3（中）通道卡片文本按 UTF-16 码元硬切，边界 emoji 产出孤立代理进入卡片 JSON

**文件与位置**（同一缺陷类，feishu / dingtalk 卡片链路共 6 处裸 slice）：

- `backend-ts/src/feishu/card-progress-listener.ts:93`（正文累积 `next.slice(0, CARD_TEXT_MAX)`）
- `backend-ts/src/feishu/card-progress-listener.ts:130,134`（工具摘要 `.slice(0, 240)`）
- `backend-ts/src/feishu/card-progress-listener.ts:165,181`（`trimCardText` → `slice(0, CARD_TEXT_MAX)`，终态正文/失败信息）
- `backend-ts/src/dingtalk/card-body.ts:57`（`body: sections.join('\n\n').slice(0, BODY_MAX)`）
- `backend-ts/src/feishu/progress-card.ts:189`（`content.slice(0, 6000)`）

**根因**：截断按 UTF-16 码元数硬切，切点落在代理对（emoji 等）中间时产出孤立高/低代理，经 `JSON.stringify` 进入发往飞书 / 钉钉的卡片 JSON（`cardParamMap`）。轻则边界渲染为 U+FFFD 乱码；重则服务端拒绝该 JSON，终态 PATCH 重试失败、进度卡永久停在「正在处理」（progress-card.ts 注释已记录过同形态的 11310 报废事故）。本仓 weixin 侧已把同类问题当 bug 修过（`weixin/send.service.ts` `prefixLenWithinBytes` 按码点累积），通道卡片链路漏修。

**验证输出**（普通 it 实跑，`logic-bug-review-2026-11-22.spec.ts` 两个 bugIt 用例，输入把 emoji 精确摆到第 6000 码元切点）：

```
× FeishuCardProgressListener.complete 卡片正文截断（CARD_TEXT_MAX=6000）
  > 截断点恰在 emoji 中间时不得产出孤立代理
AssertionError: expected true to be false    （endsWithLoneSurrogate(completed.content) === true）

× dingtalk progressCardParams 卡片正文截断（BODY_MAX=6000）
  > 截断点恰在 emoji 中间时 body 不得含孤立代理
AssertionError: expected true to be false
```

**影响面**：`assistant` 回复含 emoji 且其 UTF-16 位置恰好压线（正文 6000 / 工具摘要 240 / 合并转发 4000 各闸口）——长中文回复里 emoji 密度不低，压线概率 = 边界宽度 / 文本量，属可稳定构造的确定性缺陷。

**反证**：`trimCardText` 等处的 MAX 常量语义就是「字符上限」，与 weixin 侧修复注释（"逐码元累积会把代理对从中间切断，产出非法 UTF-8 分片"）自定的正确性标准相悖；不存在「有意按码元切」的契约说明。

**修复方向**：统一改用 `common/utf8.ts` 的 `clipByCodePoints`（已存在、行为正确、含 weixin 修复先例）。

---

## BUG-4（中低）diff 变更跳转游标「首次反向」差一，跳过最后一处变更

**文件与位置**：`desktop/src/utils/diff-view-mode.ts:28-31`

```ts
/** 变更跳转游标：循环步进（Δ=±1），总数为 0 时原样返回 -1。 */
export function nextHunkIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}
```

**根因**：公式对 `current >= 0` 的双向循环步进正确；对 `current = -1`（FileDiffViewer 的未选中初值，`components/center/FileDiffViewer.vue:84`、换模型重置 `:201`）只对正向正确（`-1+1+N ≡ 0` → 第一处），反向时 `-1-1+N = N-2`，落点跳过最后一处变更（正确应为 `N-1`）。用户感知：**打开 diff / 切文件后第一次按 ↑（上一处变更），落在倒数第二处**；仅 2 处变更时表现为「↑ 跳到顶部」。正向（↓）路径正确，属不对称缺陷。

**验证输出**（普通 it 实跑，`desktop/src/utils/logic-bug-review-2026-11-22.test.ts` bugIt 用例）：

```
× 首次反向从未选中应循环到最后一处变更（total-1）
AssertionError: expected 1 to be 2 // Object.is equality     （nextHunkIndex(-1, 3, -1)）
```

**反证**：函数注释自述「循环步进」——正向初值映射 `→0` 与反向初值映射 `→N-1` 才是对称闭环；`changes` 按行号升序，↑ 的用户预期是"从无选中跳到最后一处"。既有用例（`diff-view-mode.test.ts:42-54`）覆盖 `(-1,3,1)`、`(0,3,±1)`、`(2,3,1)`、`(1,3,-1)` 与 total=0 两例，恰好漏掉 `(-1,·,-1)` 象限。

**修复方向**：`current < 0 ? (delta === 1 ? 0 : total - 1) : (current + delta + total) % total`。

---

## BUG-5（低）CSV 行数上限的 truncated 标志对「恰好满额 + 拖尾空行」误报

**文件与位置**：`desktop/src/utils/csv-parse.ts:99-103`（上限检查先于「剩余内容是否成行」探测）

```ts
  while (i < text.length) {
    if (rows.length >= CSV_MAX_ROWS) {
      truncated = true
      break
    }
```

**根因**：截断判定在解析剩余内容**之前**做——若剩余内容只是会被 `endRow`（`:88-97`）跳过的空行，仍置 `truncated = true`。「恰好 5000 行 + 末尾单个换行」与「同样 5000 行 + 末尾多个空行」两份**内容完全等价**的文件，前者 `truncated=false`、后者 `true`。文件头注释承诺"超出截断**并标记**"，误报分支没有任何数据行被丢弃。影响：工具结果表格 / 文件预览（`CsvTableView` 共用）错误显示「已截断」提示，误导用户以为数据不全。

**验证输出**（普通 it 实跑，desktop 同文件 bugIt 用例；正反两个防回归锚点用例均通过）：

```
× 恰好 5000 行 + 末尾空行：内容零丢失，不应标记 truncated
AssertionError: expected true to be false    （truncated === true）
```

**反证**：A（末尾单 `\n`）与 B（末尾 `\n\n`）两份文件实际内容等价而结果不同，不可能是期望行为；且该分支无「有意触顶即报」的注释或测试锁定。

**修复方向**：break 前先探测剩余内容是否含非空数据行（或把上限检查移到 `endRow` push 之前、对"因上限丢弃真实行"计数）。

---

## 候选未确认（机制成立，缺离线实锤条件，留档不下结论）

1. **`limitMarkdownTables` 分隔行正则要求 `-{3,}`，GFM 只要求 ≥1 个 `-`**（`feishu/progress-card.ts:97`）。紧凑表格（`|-|-|`）不被计数 → 正文第 6 张紧凑表格绕过转义保护，可复现线上 11310（卡片停在「正在处理」）事故。**复核补充（2026-11-22）**：飞书官方文档（JSON 2.0 富文本组件）明确「支持除 `HTMLBlock` 外所有标准的 Markdown 语法」并指向 CommonMark Spec 0.31.2，且逐项列出的渲染差异（软/硬换行、HTML 标签集合）**不含表格分隔行连字符数**——按 GFM 口径 `|-|-|` 是合法分隔行，文档证据倾向于「飞书会渲染紧凑分隔行」；但官方示例全部用 ≥8 连字符，实现是否从宽仍需实测。**未确认点**：对线上卡片 API 实测一张 `|-|-|` 表的渲染/拒绝结果后定论。同一张实测可顺带对清另一个口径出入：官方文档写「单个富文本组件中，最多可放置**四个**表格」，而代码 `MAX_CARD_TABLES = 5` 依据的是线上 11310 回看（>5 张才失败）——两者至少有一个不反映现状。另注：LLM 产出的表格极少用单连字符分隔行，即便机制成立，触发概率也显著低于 `---` 形态，修复价值取决于实测结果。
2. **钉钉入站 `cleanText` 把行首所有 @提及（含非 bot 成员）整体剥掉**（`dingtalk/event-normalizer.ts:55-57`）。`@张三 @机器人 你们俩对齐一下` → Agent 只看到 `你们俩对齐一下`，「还 @ 了谁」语义丢失；飞书侧同场景是把占位符**还原为 @姓名**交给模型（`feishu/event-normalizer.ts:133`）。**复核补充（2026-11-22，行为已离线实证）**：剥离是确定性的（`raw.trim().replace(/^(?:@\S+\s+)+/, '')`）；normalize 结果没有任何保留提及的字段、下游也无补偿机制，钉钉群聊「还 @ 了谁」确实到不了模型；既有用例只锁「`@机器人 你好` → `你好`」单提及剥离；正则对消息**中部**的 @机器人 不剥离（`@张三 帮忙看看 @机器人 这个报错` → `帮忙看看 @机器人 这个报错`），说明它只为行首 @ 前缀噪声而设；git 追溯该正则自 2026-09-24 频道接入初始提交起就是现状、无注释。**未确认点**：是否要保留非 bot 提及取决于产品意图——也可能有意只取指令正文。行为差异可测试固化，但「正确契约」取决于产品意图，不满足本轮实证标准。

---

## 误报记录（审计代理候选经核实排除，防重复排查）

- **`buildCommitInput` 截断标记「字节 vs 码元」量纲错配**（`file/git-write-operation.service.ts:361`，审计代理报"高置信已数值实证"）。核实结论：**误报**。`const source = Buffer.from(raw.diff, 'utf8')` 是 Buffer，`source.length` 即**字节数**，`used < source.length` 是字节对字节，比较正确；代理把 Buffer.length 误读为字符串码元数。教训：`Buffer.length` 与 `string.length` 量纲差异是本仓多字节文本审查的高频陷阱，反证时必须先确认操作数类型。

---

## 验证用例落点（已提交，修复后转正）

| 文件 | 用例 | 固化方式 |
|---|---|---|
| `backend-ts/src/harness/core/agent-loop.spec.ts` | `findMergeTarget 兜底：带 index 且 byIndex 落空的 id 首片必须追加为新调用…` | 已转正为普通 it 回归（2026-11-22 修复） |
| `backend-ts/src/harness/terminal/terminal-host-handler.spec.ts` | `CLI 到场待命（standby）不得 failPending…` + 替换路径对照用例 | 已转正为普通 it 回归 + 普通 it 对照（2026-11-22 修复） |
| `backend-ts/src/logic-bug-review-2026-11-22.spec.ts` | 飞书 / 钉钉卡片截断孤立代理 2 例 | 已转正为普通 it 回归（2026-11-22 修复） |
| `desktop/src/utils/logic-bug-review-2026-11-22.test.ts` | `nextHunkIndex` 首次反向 + `parseCsv` 拖尾空行 2 例（各带正向防回归锚点） | 已转正为普通 it 回归（2026-11-22 修复） |

5 条确认项已于 2026-11-22 全部修复，上述用例均已转正为普通 it 回归（用例本身即回归，见头部修复记录）。

## 后续建议

- ~~BUG-1 建议优先修~~、~~BUG-3 一次性收口~~：均已当日修复；「候选未确认」两项待线上实测 / 产品意图确认后定论。
- 两个「候选未确认」均只需一次线上/产品确认即可定论，成本低。
