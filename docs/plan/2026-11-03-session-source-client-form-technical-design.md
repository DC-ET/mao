# 会话来源区分客户端形态（桌面端 / 终端 CLI / 安卓 / Web）技术方案

- 状态：待评审（2026-11-03；§3 决策为拟定，评审通过后定案）
- 日期：2026-11-03
- 关联方案：[2026-10-29-session-source-lineage-technical-design.md](./2026-10-29-session-source-lineage-technical-design.md)（来源体系首版：七值闭集 + 四写入点 + admin 筛选；本方案是它的「客户端形态」维度扩宽，不改其任何既有决策）
- 能力底座：
  - V109 `__add_session_source.sql`（`session.source` `VARCHAR(16) NOT NULL DEFAULT 'web'`，注释即写明 `web=桌面/Web端`——桌面 / CLI / 浏览器当时共用一个值）
  - `session.repository.ts:15-32`（`SESSION_SOURCE_VALUES` 闭集 / `USER_SETTABLE_SESSION_SOURCES` 用户白名单 / `isSessionSource` 校验）
  - `shared/contracts/src/session.ts:46`（`SessionSource` 联合类型，与后端闭集手工逐值对齐）
  - `admin/src/utils/sessionSourceLabels.ts:8-27` + `admin/src/views/session/SessionListView.vue:74-76,112-115`（来源筛选下拉由汉化表派生、表格列 + 详情页标签）
  - `desktop/src/stores/session/list.ts:513-568`（桌面端唯一建会话入口，payload 不传 `source`）
  - `desktop/src/utils/platform.ts:5-7` / `desktop/src/utils/capacitor.ts:5-12`（`isElectronClient` / `isAndroidCapacitor` 形态检测已存在）
  - `agent-cli/src/commands/chat.ts:311-330`、`agent-cli/src/session/session-runner.ts:121-127`（CLI 的两个建会话入口，均不传 `source`）
  - `agent-cli/src/ws/constants.ts:8`（CLI 的 WS client 类型已是 `'cli'`，与来源值同名）
  - `backend-ts/src/session/ws/streaming-ws-registry.ts:15`（`LOCAL_CAPABLE_CLIENTS = ['electron','cli']`——CLI 与桌面同为 LOCAL 本机执行端）
- 本方案定位：把「来源」从「桌面 / CLI / 浏览器混为一个 Web」细分为 **桌面端（desktop）/ 终端 CLI（cli）/ 安卓 App（android）/ 浏览器（web）** 四个客户端形态值，纯增量、零分组行为变更；同时补上后端闭集与契约联合的编译期一致性护栏。含一次存量回填（V181：LOCAL 会话 → `desktop`，已知会把 CLI 本地任务一并算入，见 D9）。**明确不做**「LOCAL 只能来自桌面」的服务端校验（见 §2.2）——事实上 LOCAL 执行端本就含 CLI，该校验的口径需先重新定义。
- 决策记录（2026-11-03 用户已定案）：① 客户端形态由**客户端自报**，后端只做白名单校验（D3）；② 存量 LOCAL 会话**回填为 `desktop`**，接受 CLI `--local` 会话被一并误标（D9）；③ admin 浏览器文案**保持 `Web`**（D7）。

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| 来源闭集 | 七值 `web / embed / feishu / dingtalk / weixin / signal / openapi` | `session.repository.ts:15-18` |
| `web` 的实际语义 | **桌面 Electron / 终端 CLI / 浏览器三方共用**：两端建会话都不传 `source`，后端一律回落 `'web'` | `session/list.ts:525-550`、`chat.ts:311-330`、`session.service.ts:147`、`session.repository.ts:288` |
| 契约联合 | `shared/contracts/src/session.ts:46`，与后端闭集**手工**逐值一致（无编译期护栏） | 同左 |
| 建会话入口 | `POST /v1/sessions` 接受 `source`，但白名单仅 `['web','embed']`，其余 400 | `session.routes.ts:157-168` |
| 来源改写入口 | `PUT /v1/sessions/:id/source`（Embed SDK 惰性接管），经 `isUserSettableSessionSource` + `markSessionSource` 双重校验后实为 embed-only | `session.routes.ts:328-338`、`session.service.ts:374-387` |
| admin 展示 | 「来源」列 + 筛选下拉（选项由汉化表派生）+ 详情页标签 | `SessionListView.vue:74-76,112-115`、`SessionDetailView.vue:69-71` |
| 桌面端展示 | **不展示来源**（desktop 无 `sessionSourceLabels.ts`，仅 `cloud-project.ts:104,108` 内部用 embed/signal 分支做分组） | `desktop/src/utils/cloud-project.ts:103-109` |
| 分组口径 | `SessionGroupKey.of` 只对 `embed` / `signal` 设专属分支，其余值落回路径/模式启发式 | `session-group-key.ts:91-104` |
| 派生会话来源 | 边路任务 / 子代理 / 边路提升主会话均**不设** source，落列默认 `'web'` | `streaming-ws-handler.ts:1150-1158`、`subagent-invocation.service.ts:26-45`、`session.service.ts:682-704` |
| 客户端形态信号 | WS 握手已自报 `client=electron\|android\|browser\|cli\|embed` 并归一化存储；**但不落库**，仅存于连接注册表 | `useStreamWS.ts:224,240`、`streaming-ws-handler.ts:449,2364-2370`、`streaming-ws-registry.ts:532-537` |
| LOCAL 执行端 | `LOCAL_CAPABLE_CLIENTS = ['electron','cli']`：**桌面与 CLI 都是 LOCAL 本机执行端**，CLI `--local` 建的是 LOCAL 会话 | `streaming-ws-registry.ts:15`、`chat.ts:85,309-312` |
| LOCAL 模式防线 | 桌面侧仅前端：浏览器禁选/禁发（无服务端校验） | `useChat.ts:343-347`、`ChatNewTaskConfigBar.vue:17`、`WorkspaceChip.vue:202-210` |
| 存量口径 | 飞书早期会话已由 V180 按通道映射回填；桌面 / CLI / 浏览器建的会话一律 `'web'`——CLOUD 行**无任何可靠信号**可区分三者，LOCAL 行只能确定是「桌面或 CLI」（`LOCAL_CAPABLE_CLIENTS`）而分不出具体哪个 | `V180__backfill_session_source_feishu.sql`；`platform`/`shell`/`osVersion` 两端都填且格式不互斥，不能当判据（`chat.ts:317-320` vs `useChat.ts:383-385`） |
| LOCAL 执行约束 | LOCAL 任务必须桌面或 CLI 的 WS 在线，否则发送/重试两处均直接报错返回 | `streaming-ws-handler.ts:654-663`、`1343-1352` |

### 1.2 问题

1. **管理后台说不清一条会话是谁建的**：`执行模式=本地 / 来源=Web` 有三种可能——桌面端本地任务（正常）、`mao-agent --local` 建的 CLI 本地任务（正常）、浏览器伪造的 LOCAL 垃圾行（跑不起来），三者显示完全相同。本次报障的由来正是这种不可区分；运维只能靠「会话能不能跑完」反推。
2. **客户端用量统计缺一个维度**：终端 CLI 与安卓 App（Capacitor 壳，随 desktop/dist 发版即生效）与桌面端、与浏览器访问 `https://mao.etarch.cn` 的用量全混在 `Web` 里，无法回答「CLI 有多少会话」「移动端有多少会话」。
3. **后端闭集与契约联合靠人肉对齐**：`SessionSource` 在后端是本地 `as const` 元组派生的类型（`session.repository.ts:18`），契约侧是平行联合声明。加值时漏一端的后果只有前端 `Record` 汉化表能兜（编译期），后端漏加值则是静默的——与 `LlmCallScene` 已有 `_AssertExhaustive` 护栏的成熟度不匹配（`llm-call-context.ts:25-32`）。
4. **派生会话来源失真**：桌面端 / CLI 会话拉起的边路任务 / 子代理显示 `Web`，父是桌面、子是浏览器，admin 按来源筛「桌面端任务」时漏掉整棵子树。

### 1.3 机会

- 扩宽是纯增量：`VARCHAR(16)` 容纳 `desktop`(7) / `android`(7) / `cli`(3)，**列本身零 DDL**；唯一的迁移是一次存量 UPDATE（D9）。
- 分组行为逐字节不变：`SessionGroupKey.of` 对 `desktop` / `android` / `cli` 不命中任何专属分支，自然落回与 `web` 完全相同的模式/工作区分桶；`applyFilter` 四个桶的 `source NOT IN ('embed','signal')` 排除式对新值同样放行（`session-group-key.ts:229-247`）。回填把 LOCAL 行从 `web` 改成 `desktop` 同样不改变落桶（两者都走 `ofMode` 的 `LOCAL:{workspace}` 分支）。
- 前端零新增展示逻辑：admin 的筛选下拉由 `SESSION_SOURCE_OPTIONS`（汉化表派生）自动长出三个选项，表格列与详情标签自动生效。
- CLI 侧改动面极小：两个建会话入口都收敛到 `rest.createSession`，`CreateSessionRequest` 加一个可选字段即可；CLI 的 WS client 类型本就叫 `cli`，来源值与它同名，语义一致。
- 存量可大部分订正：`execution_mode='LOCAL'` 的历史行只可能由桌面端或 CLI 的 `--local` 创建（三个机器人通道与 openapi 建会话一律显式 `CLOUD`：`app-feishu-messaging.ts`、`dingtalk/runtime.ts`、`weixin/session.service.ts:64`、`open-run.service.ts:153`；安卓壳不支持本地模式；浏览器无本机执行端跑不起来），把它们统一标为 `desktop` 可直接消掉本次报障那类「本地 + Web」歧义行——代价是 CLI 本地任务被一并算入（D9，已决策接受）。

## 2. 需求描述

### 2.1 要做的

1. **P1 来源闭集扩为十值**：`web / embed / desktop / cli / android / feishu / dingtalk / weixin / signal / openapi`（`SESSION_SOURCE_VALUES`）。
2. **P1 建会话白名单扩宽**：`POST /v1/sessions` 的 `source` 接受 `web / embed / desktop / cli / android`（客户端可自报的五个值）；系统来源（feishu/dingtalk/weixin/signal/openapi）仍然不可自报，400 文案同步更新。
3. **P1 桌面端自报形态**：`desktop/src/stores/session/list.ts` 的 `createSession` payload 增加 `source`，由新增的形态助手按 `Electron → desktop`、`Capacitor 安卓 → android`、其余 → `web` 计算；`useStreamWS.ts:224` 的三元表达式改为复用同一助手（消除第二份复制的形态判定）。
4. **P1 CLI 自报来源**：`agent-cli/src/rest/types.ts` 的 `CreateSessionRequest` 加 `source?: 'cli'`；`commands/chat.ts:311` 与 `session/session-runner.ts:121` 两个建会话入口统一带上 `source: 'cli'`（后者已有的 `executionMode`/`permissionLevel` 默认值展开之后追加，不改其 spread 语义）。
5. **P1 契约 + 编译期护栏**：`shared/contracts/src/session.ts` 的 `SessionSource` 加 `desktop` / `cli` / `android` 三个成员；后端 `SESSION_SOURCE_VALUES` 改为 `satisfies readonly SessionSource[]` + `_AssertExhaustive` 类型断言（对齐 `llm-call-context.ts:25-32` 范式），两端加值漏一端即 tsc 失败。
6. **P1 admin 文案与色调**：`SESSION_SOURCE_LABELS` / `SESSION_SOURCE_TAG_TYPES` 补 `desktop: '桌面端'`、`cli: '终端 CLI'`、`android: '安卓'`；`web` 展示文案保持 `Web`（见 D7）。
7. **P2 派生会话继承父来源**：边路任务（`streaming-ws-handler.ts:1150`）、子代理（`subagent-invocation.service.ts:26`）、边路提升主会话（`session.service.ts:682`）三处 `source` 继承自父/源会话，不再落列默认值。
8. **P2 存量回填（V181）**：`UPDATE session SET source='desktop' WHERE source='web' AND execution_mode='LOCAL'`（含软删除行、幂等；已知把 CLI `--local` 会话一并算入，见 D9）。CLOUD 形态的存量会话分不出桌面 / CLI / 浏览器，保持 `web`，文档注明。
9. **P3 文档同步**：根 `CHANGELOG.md`（后端 / 管理后台 / 前端 / 终端 CLI 四节）、`skills/mao-cli/reference/admin.md:144` 的来源口径段落。

### 2.2 不做的

- **不做**「LOCAL 只能来自桌面」的服务端校验（用户明确本期不做）：`POST /v1/sessions` 仍不校验 `executionMode=LOCAL` 的调用方形态。注意该校验若要做，口径必须含 CLI——`LOCAL_CAPABLE_CLIENTS = ['electron','cli']`，写成「只能桌面」本身就是错的。后续方向是 UA 交叉校验或 Electron / CLI 双形态 attest header，另立提案。
- **不做**来源级权限 / 授权：`source` 是事实标签（契约注释原话），不参与任何鉴权与分组归属判定。
- **不做**分组逻辑改动：`SessionGroupKey.of` / `applyFilter` / 桌面 `cloud-project.ts` 的分支一律不动（D2）。
- **不做**存量 CLOUD 会话的回填 / 猜测：CLOUD 会话分不出桌面、CLI 还是浏览器（三者都不传 `platform`/`shell`/`osVersion`，无任何判据），一律保持 `web` 并在文档注明口径。LOCAL 行的回填范围已由 D9 定案。
- **不做**admin 数据看板的「按来源会话数」聚合卡（治理诉求由筛选 + 列覆盖）。
- **不做**桌面端来源徽标 / 筛选（desktop 目前完全不展示来源，本期不引入，避免视觉面扩散）。
- **不做** Embed SDK 惰性接管口径变化：`PUT /v1/sessions/:id/source` 仍只允许 `web → embed`（D6）。
- **不做** mao-cli（`skills/mao-cli/`）自身建会话的来源标记：该 skill 是终端操作 Mao 的 CLI，与 mao-agent（`agent-cli/`）是两个东西；若也要区分需另立提案。
- **不新增**端点、收件箱 kind、定时任务来源维度。

## 3. 技术选型（待评审确认后定案）

| # | 决策点 | 拟定 | 落选项与理由 |
|---|---|---|---|
| D1 | 新值命名 | `desktop` / `cli` / `android` | `cli` 与 WS `client` 归一化值同名（`agent-cli/src/ws/constants.ts:8`），语义一致；`desktop` 用平台名而非 `electron`，避免同一概念两套词 |
| D2 | 分组是否改用 source | 不改 | 新值不命中 `of()` 任何分支，落桶与 `web` 完全一致；改动分组是行为变更，回归面与收益不成比例 |
| D3 | 形态由谁判定 | **客户端自报**（payload 声明），后端只做白名单校验 | 后端无可靠调用方信号（REST 只带 Bearer token，UA 可伪造且 Electron 未设固定标记）；`source` 是事实标签而非授权依据，伪造收益仅限 admin 统计噪音；系统来源（影响分组归属的那些）仍不可自报，安全边界不变 |
| D4 | 白名单常量拆分 | 拆为 `CLIENT_DECLARABLE_SESSION_SOURCES`（建会话，五值）与 `SESSION_MARK_SOURCES`（PUT 惰性接管，仅 `embed`），删除 `USER_SETTABLE_SESSION_SOURCES` | 现常量被 POST 与 PUT 共用；扩宽后 PUT 会放过 `desktop` 再被 `markSessionSource` 以另一条文案 400，出现「两层校验两种文案」的混乱。拆分后两个入口各自的文案精确（仅 2 处调用、无测试引用，拆除成本零） |
| D5 | 闭集 ↔ 契约一致性 | `as const satisfies readonly SessionSource[]` + `_AssertExhaustive` 类型断言 | 复刻 `llm-call-context.ts:25-32` 成熟范式；后端本地 `SessionSource` 类型保持从元组派生，现有 import 零改动 |
| D6 | PUT 是否接受 desktop/cli/android | 不接受，维持 embed-only | 没有「把会话改判成桌面/CLI 建的」合法流程；该端点专为 Embed 惰性接管存在 |
| D7 | `web` 展示文案 | 保持 `Web` | 与用户口径一致；扩宽后 `Web` 与 `桌面端`/`终端 CLI`/`安卓` 并列即「浏览器」，语义自明。避免改动既有筛选值/文档链接 churn |
| D8 | 派生会话来源 | 边路 / 子代理 / 提升 三处继承父来源 | 父桌面、子 Web 的展示矛盾比「不过滤子树」更难解释；三处均为在已有对象上补一个字段，零行为风险 |
| D9 | 存量回填范围 | `source='web' AND execution_mode='LOCAL'` → `desktop`（V181） | 用户已决策接受其代价：LOCAL 行只可能由桌面或 CLI `--local` 创建（`LOCAL_CAPABLE_CLIENTS=['electron','cli']`），无字段可区分二者，回填等于把 CLI 本地任务一并算成桌面端——换来「本地 + Web」歧义行全部消解、历史本地任务可被筛出。CLOUD 行无任何判据（三类客户端都不传环境信息），一律保持 `web`。含软删除行（与 V180 同口径）；幂等；逆运算写进迁移注释 |
| D10 | admin 色调 | `desktop → primary`、`cli → info`、`android → success` | 与既有渠道色板一致（web 仍是 info 灰、不做强调）；CLI 与 web 同为「非壳」形态，用 info 不额外强调 |
| D11 | CLI 传参方式 | `CreateSessionRequest.source?: 'cli'`（可选字段、字面量类型），两个入口都显式传 | CLI 只有一种形态，不需要三态判别；字段保持可选是为与接口其余成员一致，但调用点必须显式传，避免依赖后端默认值（默认值仍是 `web`） |

## 4. 实现步骤

### 4.1 后端（backend-ts）

1. `session.repository.ts:11-32`：
   - `SESSION_SOURCE_VALUES` 扩为十值（顺序：`web, embed, desktop, cli, android, feishu, dingtalk, weixin, signal, openapi`），并加 `satisfies readonly SessionSource[]`（`SessionSource` 从 `@mao/contracts` import type）+ `_AssertExhaustive` 断言（D5）；
   - 删除 `USER_SETTABLE_SESSION_SOURCES` / `isUserSettableSessionSource`，新增 `CLIENT_DECLARABLE_SESSION_SOURCES = ['web','embed','desktop','cli','android'] as const satisfies readonly SessionSource[]` + `isClientDeclarableSessionSource`，以及 `SESSION_MARK_SOURCES = ['embed'] as const` + `isSessionMarkSource`（D4）；
   - 更新文件头注释：`web` 口径改为「浏览器（桌面/Web/移动浏览器）」；补一句 `cli` 由 mao-agent 自报、`desktop`/`android` 由桌面壳自报。
2. `session.routes.ts:157-161`（POST）：校验改用 `isClientDeclarableSessionSource`，400 文案改 `source 仅允许 'web' / 'embed' / 'desktop' / 'cli' / 'android'`。
3. `session.routes.ts:328-338`（PUT）：校验改用 `isSessionMarkSource`，400 文案统一为 `source 仅允许 'embed'`（与 `markSessionSource` 的既有文案对齐，消除两层校验两种文案）。
4. `session.service.ts:682-704`（`promoteSideTaskToMainSession`）：`target` 补 `source: source.source`（D8）。
5. `streaming-ws-handler.ts:1150-1157`（边路任务）：`sideSession` 补 `source: parentSession.source`（D8）。
6. `harness/delegate/subagent-invocation.service.ts:26-45`（子代理）：`child` 补 `source: parent.source`（D8）。
7. 不改：`session.service.ts:147`、`session.repository.ts:288`、`session-vo.ts:194,267` 的 `?? 'web'` 回落（未声明即浏览器/历史会话，语义正确）；`listSessionsForAdmin` 的 source 过滤与 `toAdminSessionVO`（已存在，非法值宽松忽略的既有口径不变）。

### 4.2 契约（shared/contracts）

`session.ts:46`：`SessionSource` 加 `'desktop' | 'cli' | 'android'`，注释同步（`'web'/'embed'/'desktop'/'cli'/'android'` 是客户端可自报值；其余只能由通道内部调用方写入）。

### 4.3 管理后台（admin）

1. `admin/src/utils/sessionSourceLabels.ts:8-27`：两张 `Record<SessionSource, …>` 补 `desktop` / `cli` / `android` 三项（D7、D10）。筛选下拉（`SESSION_SOURCE_OPTIONS` 派生）、表格列、详情标签自动生效，**视图文件零改动**。
2. 无其它改动。

### 4.4 桌面端（desktop）

1. `desktop/src/utils/platform.ts`：新增 `clientKind(): 'electron' | 'android' | 'browser'`（`isElectronClient()` → electron；`isAndroidCapacitor()` → android；其余 browser）与 `clientSessionSource(): 'desktop' | 'android' | 'web'`（前者到来源值的映射，D1）。`platform.ts` import `./capacitor` 无环（capacitor.ts 无本地 import）。
2. `desktop/src/stores/session/list.ts:525-534`：payload 增 `source: clientSessionSource()`——在建会话入口一次性自报，`useChat.ts` 的 10 个位置参数签名不动（不再增长第 11 个位置参数，`open-run.service.ts:144-146` 注释记录过位置参数错位的静默风险）。
3. `desktop/src/composables/useStreamWS.ts:224`：`const client = clientKind()`（替换内联三元，WS 握手词表 `electron/android/browser` 不变）。
4. 不改：浏览器 LOCAL 三道前端防线（`useChat.ts:343-347`、`ChatNewTaskConfigBar.vue:17`、`WorkspaceChip.vue:202-210`）——本期不加服务端校验，前端防线是 LOCAL 在桌面侧的唯一现存约束，必须保留。

### 4.5 终端 CLI（agent-cli）

1. `agent-cli/src/rest/types.ts:92-105`：`CreateSessionRequest` 加 `source?: 'cli'`（D11）。
2. `agent-cli/src/commands/chat.ts:311-317`：`req` 对象加 `source: 'cli' as const`（与 `agentId`/`executionMode` 并列，位置显式）。
3. `agent-cli/src/session/session-runner.ts:121-127`：`createAndAttach` 的 `rest.createSession({...})` 展开对象里加 `source: 'cli' as const`（当前无调用方，属于预留入口，一并改避免漏改）。
4. 不改：CLI 的 `--local` 信任 / 审批 / 本地执行链路（与来源无关）；CLI 的 WS client 类型（已是 `cli`）。

### 4.6 数据库迁移

`backend-ts/db/migration/V181__backfill_session_source_local_desktop.sql`（新增，**取落地时空着的下一个迁移号**，撰写本方案时最新为 V180；列本身零 DDL，`VARCHAR(16)` 容纳全部新值）：

```sql
-- V181: 回填「本地模式」历史会话的来源为 desktop。
-- 背景：V109 起桌面 / CLI / 浏览器共用 source='web'；本期把来源细分为 desktop/cli/android/web。
-- 判据：execution_mode='LOCAL' 的会话只可能由桌面 Electron 或 mao-agent --local 创建——
--   三个机器人通道与开放接口建会话一律显式 CLOUD（app-feishu-messaging.ts /
--   dingtalk/runtime.ts / weixin/session.service.ts:64 / open-run.service.ts:153），
--   安卓壳不支持本地模式，浏览器无本机执行端时 LOCAL 任务直接被拒
--   （streaming-ws-handler.ts:654-663 发送 / 1343-1352 重试两处 isConnected 检查；
--   本机执行端白名单 LOCAL_CAPABLE_CLIENTS = ['electron','cli']，streaming-ws-registry.ts:15）。
-- 已知不精确（已决策接受，见技术方案 D9）：CLI --local 建的 LOCAL 会话无字段可与桌面区分，
--   会一并被标为 desktop；CLOUD 会话无任何判据，保持 web。
-- 范围：仅 source='web' 且 execution_mode='LOCAL' 的行；软删除行一并纠正（与 V180 同口径）。
-- 幂等：回填后不再命中任何行。逆运算（如需回滚）：
--   UPDATE `session` SET source='web' WHERE source='desktop' AND execution_mode='LOCAL';
-- 执行前先 SELECT COUNT(*) 评估行量；异常庞大时按 id 区间分批，避免长事务锁表。
UPDATE `session` SET `source` = 'desktop'
WHERE `source` = 'web' AND `execution_mode` = 'LOCAL';
```

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `session.repository.ts`（十值闭集 + satisfies/穷尽断言 + 两个白名单常量拆分）、`session.routes.ts`（POST/PUT 两处校验与文案）、`session.service.ts`（提升继承）、`ws/streaming-ws-handler.ts`（边路继承）、`harness/delegate/subagent-invocation.service.ts`（子代理继承） |
| contracts | `shared/contracts/src/session.ts` 联合加三成员 |
| admin | `sessionSourceLabels.ts` 两表补三项（视图零改动） |
| desktop | `utils/platform.ts`（新增两个助手）、`stores/session/list.ts`（payload 带 source）、`composables/useStreamWS.ts`（复用助手） |
| agent-cli | `rest/types.ts`（`source` 字段）、`commands/chat.ts` + `session/session-runner.ts`（两个入口传 `'cli'`） |
| 迁移 | `V181__backfill_session_source_local_desktop.sql`（仅一条 UPDATE，列零 DDL） |
| 测试 | 见 §7 |
| 文档 | 根 `CHANGELOG.md`（后端 / 管理后台 / 前端（桌面 / Web / 安卓）/ 终端 CLI（mao-agent）四节）、`skills/mao-cli/reference/admin.md:144` 来源口径段落；README / DEPLOY 不涉及会话来源，无需改动 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| **发布顺序敏感**：新桌面 dist / 新 mao-agent 先于后端起，旧后端白名单拒绝 `desktop`/`cli`/`android` → 400，桌面 / 安卓 / CLI 全线建不了会话 | §8 明确「先部署 backend-ts，再部署 desktop/dist 与 mao-agent」；CLI 是用户侧 `npm i -g` 独立安装，版本滞后更常见，故 CHANGELOG 需写明最低后端版本 |
| 浏览器 / 任意客户端伪造 `desktop`/`cli`/`android` 污染 admin 统计 | 接受（D3）：source 是事实标签、不参与分组与授权；系统来源仍不可自报。若噪音真实出现，走 UA 交叉校验 / attest header 的后续提案 |
| 新值意外产生新分组 / 破坏展开条数 | `of()` 对 desktop/cli/android 无分支，落桶同 web；补回归：`of()` 与 `applyFilter()` 对三个新值行的口径与 web 行逐项一致（复用 `session-group-filter-consistency.spec.ts` 求值器）；V181 把 LOCAL 行改成 `desktop` 后落桶不变（仍走 `LOCAL:{workspace}`） |
| 派生会话继承 source 引发回归 | 三处均为「补一个字段」；补断言：边路/子代理/提升后的 source 等于父值，且其余字段（workspace/projectKey/executionMode）不串位 |
| V181 误伤 / 误标 | WHERE 同时限定 `source='web' AND execution_mode='LOCAL'`，不碰 CLOUD 行与其它来源值；含软删除行（与 V180 同口径）；幂等；逆运算写进注释；执行前先 COUNT(*) 评估行量，异常庞大则按 id 分批。**已知不精确**：CLI `--local` 会话被一并标为 `desktop`（D9 已决策接受），mao-cli 文档注明 |
| CLI 两个入口漏改其一 | `chat.ts` 与 `session-runner.ts` 都显式传 `'cli' as const`；测试断言两条路径的 payload 均含 `source: 'cli'` |
| 白名单拆分拆错，PUT 放过非 embed | `isSessionMarkSource` 仅 `['embed']`；补回归：PUT `desktop`/`cli`/`web`/`signal` 均 400，PUT `embed` 200 |
| 契约加值漏后端（或反向） | `_AssertExhaustive` + `satisfies` 双侧断言（D5）；`npm run build` 即验证 |
| 汉化表漏项 | admin 两张 `Record<SessionSource, string>` 编译期穷尽；`npm run build`（vue-tsc）验证 |
| 回填后 CLOUD 历史会话仍显示 `Web`，被误读为「全是浏览器建的」 | mao-cli 文档口径写清「早于本版本的 CLOUD 会话统一记为 Web，无法区分桌面 / CLI / 浏览器；本地模式会话已回填为桌面端（含 CLI 本地任务）」 |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. 闭集与白名单：`SESSION_SOURCE_VALUES` 十值；`isClientDeclarableSessionSource` 对 `web/embed/desktop/cli/android` 为 true、对 `feishu/dingtalk/weixin/signal/openapi` 为 false；`isSessionMarkSource` 仅 `embed`。
2. 路由：POST `source=desktop` / `cli` / `android` → 200 且 `createSession` 尾参收到该值；POST `source=signal` / `mobile` → 仍 400（含既有断言不回退）；PUT `source=desktop` / `cli` / `web` → 400 且文案为「仅允许 'embed'」；PUT `source=embed` → 200。
3. 落库：`createSession` 不传 source → `'web'`；传 `'cli'` → `'cli'`（`session.repository.spec.ts` / `session.service.spec.ts` 各一条）。
4. 继承：边路任务 / 子代理 / 提升主会话三处 `source === 父会话 source`，且 workspace / projectKey / executionMode 不串位。
5. 分组回归：`session-group-key.spec.ts` 补 `of({source:'desktop'|'cli'|'android', …})` 与对应 `web` 行同键；`session-group-filter-consistency.spec.ts` 的 `sessions` 表补 desktop/cli/android 三行（CLOUD 项目 / LOCAL 各一），断言「预览分组 == 展开过滤」不变量仍成立。
6. admin 列表：`source=cli` 只回 CLI 会话；`toAdminSessionVO.source` 缺省 `'web'`（`session-source-lineage.spec.ts` 既有断言扩展）。
7. Flyway：V181 走 `flyway.spec.ts` 既有良构校验（文件名可解析、SQL 非空、checksum 为数字），无需新用例；迁移语义由 §4.6 注释与 D9 的判据链保证。

**前端 / CLI**

8. desktop：`session-cloud-workspace.test.ts` 或新增 spec——三种形态下 `createSession` 的 payload `source` 分别为 `desktop`（mock `window.electronAPI`）/ `android`（mock `window.Capacitor.isNativePlatform/getPlatform`）/ `web`（都不 mock）；既有四条 payload 断言（workspace/workspaceMode/gitCloneUrl/LOCAL workspace）不回退。
9. agent-cli（`cd agent-cli && npm test`）：`rest-client.spec.ts` 或新增 spec——`chat.ts` 的建会话请求与 `session-runner.createAndAttach` 两条路径的 payload 均含 `source: 'cli'`（mock fetch / rest stub，断言请求体）。
10. `cd desktop && npm run build`、`cd admin && npm run build`、`cd agent-cli && npm run build && npm test`（vue-tsc / tsc 穷尽即验证汉化表、契约断言与 CLI 类型）。

**E2E**：不新增（来源列无既有 Playwright 覆盖，`tests/` 不改）。

## 8. 文档与发布

1. **CHANGELOG**（根 `CHANGELOG.md` 顶部新建版本小节；**版本号取落地时的下一个**，勿照抄本文档里的号——撰写本方案时顶部为 0.0.421，且同期有其它功能在并发落地）：
   - 后端：来源闭集新增 `desktop` / `cli` / `android`，`POST /v1/sessions` 接受三者自报；边路任务 / 子代理 / 边路提升的会话继承父会话来源；V181 把存量本地模式会话的来源订正为「桌面端」（含 CLI `--local` 建的会话，无字段可区分）。
   - 管理后台：会话列表「来源」列与筛选新增「桌面端 / 终端 CLI / 安卓」，Web 口径收窄为浏览器。
   - 前端（桌面 / Web / 安卓）：桌面端与安卓 App 新建会话自报客户端形态，管理后台可按形态筛选。
   - 终端 CLI（mao-agent）：新建会话自报来源 `cli`，管理后台可筛出「终端 CLI」会话；依赖后端 ≥ 本版本（旧后端会 400 拒绝）。
2. **mao-cli**：`skills/mao-cli/reference/admin.md:144` 的来源段落改写——「桌面/Web 为 Web」改为「桌面端为桌面端、终端 CLI（mao-agent）为终端 CLI、安卓 App 为安卓、浏览器为 Web」；并注明：本版本起新建会话按客户端形态打标，存量本地模式会话已回填为「桌面端」（CLI `--local` 建的会话一并计入，无法区分），存量云端会话仍一律记为 Web（无法区分桌面 / CLI / 浏览器）。
3. **发布顺序（硬约束）**：先部署 backend-ts（白名单随发版生效，V181 由启动迁移执行），再 `bash scripts/deploy-desktop.sh`；mao-agent 由用户侧 `npm i -g @mao/agent-cli` 升级，CHANGELOG 注明最低后端版本。安卓壳无需 `build-apk.sh`——前端发版即部署 desktop/dist，Capacitor 远程加载即时生效。
4. **回滚**：代码回滚即可；数据可用 V181 注释里的逆运算退回（`source='desktop' AND execution_mode='LOCAL'` → `web`）。旧后端收到新来源值只会 400，不会写坏数据。
