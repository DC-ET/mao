# 会话来源全链路标记与筛选技术方案

- 状态：待评审（2026-10-29 依据提案 [2026-10-29-session-source-lineage.md](../proposals/2026-10-29-session-source-lineage.md) 细化；7 项决策已定案见 §3，不再开放）
- 日期：2026-10-29
- 能力底座：
  - V109 `__add_session_source.sql`（`session.source` 列 + `idx_session_user_agent_source_updated` 联合索引）
  - `session.repository.ts:10-26`（`SESSION_SOURCE_VALUES` 闭集 / `USER_SETTABLE_SESSION_SOURCES` 用户白名单 / `isSessionSource` 校验）
  - `session-vo.ts:192`（`toSessionVO` 已输出 `source`，桌面端零后端改动即可消费）
  - `open-run.service.ts:140-170`（哨兵触发已落 `'signal'`，本方案把同一点的 API / WEBHOOK 落 `'openapi'`）
- 本方案定位：把「会话从哪来」从 workspace 路径巧合升级为可查询的事实标签——来源闭集扩宽、4 个写入点补标记、admin 补筛选与展示、桌面补徽标。**纯增量，零迁移。**

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| 来源闭集 | `['web', 'embed', 'signal']` 三值流通 | `session.repository.ts:12` |
| 用户可设白名单 | `['web', 'embed']`，注释明确「系统来源只能由可信调用方产生，防伪造分组归属」 | `session.repository.ts:16-26` |
| 创建参数 | `createSession` 第 16 位 `source`，缺省 `'web'` | `session.service.ts:118,147` |
| 飞书建会话 | 不传 source → 落 `'web'` | `app-feishu-messaging.ts:75-82`（p2p 与群聊共用此 factory） |
| 钉钉建会话 | 不传 source → 落 `'web'` | `dingtalk/runtime.ts:117-124` |
| 微信建会话 | 不传 source → 落 `'web'` | `weixin/session.service.ts:60-75` |
| 开放接口 / 哨兵 | 仅 `SIGNAL` → `'signal'`；API / WEBHOOK → 缺省 `'web'` | `open-run.service.ts:165` |
| 列表过滤 | `/v1/sessions?source=` 与 admin 列表过滤均存在 | `session.routes.ts:248-252`、`admin-session.routes.ts:86-100` |
| admin 列表 | `listSessionsForAdmin` 无 source 参数、`toAdminSessionVO` 无 source 字段 | `session.service.ts:471-481` |
| 桌面分组 | `SessionGroupKey.of`（`session-group-key.ts:91-103`）：`embed` → EMBED 组、`signal` → 哨兵组、**其余全部走路径启发式**（`/feishu-chat/`、`projectKey` 正则） | `session-group-key.ts:11-47` |

### 1.2 问题

1. 管理员说不清渠道真实用量：机器人渠道有没有人用、开放接口建了多少会话，只能靠 `feishu-chat/`、`dingtalk-{botId}-private-{uid}` 这类目录名与 projectKey 正则倒推——那是分组实现细节，不是数据契约。
2. CHANGELOG 0.0.3xx 自承的已知限制：「浮窗会话混在会话管理列表，无法按来源筛选」——admin 侧连 web / embed 都筛不了。
3. 批量治理无从圈定：清理「哨兵 / 接口触发的陈旧会话」没有查询入口。

### 1.3 机会

扩宽是纯增量：新来源值在 `SessionGroupKey.of` 中不命中任何专属分支，自然落回既有的路径 / 模式分组（§1.1 末行），分组行为逐字节不变；embed 历史过滤是 `source = 'embed'` 精确匹配，不受新值影响；`VARCHAR(16)` 容纳全部新值（最长 `'dingtalk'` 8 字符），零 DDL。

## 2. 需求描述

### 2.1 要做的

1. **P1 来源闭集扩宽**：`SESSION_SOURCE_VALUES` 扩为 `['web', 'embed', 'feishu', 'dingtalk', 'weixin', 'signal', 'openapi']`。
2. **P1 四个写入点补标记**（每处一行，不改 `createSession` 位置签名。提案所列 `dingtalk/agent-inbound-handler.ts` 仅为接口声明，真实调用点只有 `dingtalk/runtime.ts:117`，故为四处而非提案的「五处」）：
   - `app-feishu-messaging.ts:82`（飞书 p2p + 群聊共用 factory）→ `'feishu'`；
   - `dingtalk/runtime.ts:124` → `'dingtalk'`；
   - `weixin/session.service.ts`（`createSession` 调用尾参）→ `'weixin'`；
   - `open-run.service.ts:165` → `input.source === 'SIGNAL' ? 'signal' : 'openapi'`（API / WEBHOOK 不再回落 `'web'`）。
3. **P1 契约下沉**：`@mao/contracts` `session.ts` 导出 `SessionSource` 联合类型；admin 与 desktop 各自 `Record<SessionSource, string>` 中文汉化表（编译期穷尽，AGENTS.md 规范）。
4. **P2 admin 会话管理**：`listSessionsForAdmin` 加 `source` 过滤参数（`session.source = ?` 等值）；`toAdminSessionVO` 加 `source`；`SessionListView` 加「来源」列（图标 + 中文标签）与顶部筛选下拉；`SessionDetailView` 头部展示来源标签。
5. **P3 桌面来源徽标**：任务面板分组列表（`TaskSessionGroupList.vue`）条目对 `source !== 'web'` 的会话显示渠道小图标（title 提示中文标签），统一规则不做来源特判（信号哨兵组内条目也带徽标，冗余可接受，规则简单优先）。

### 2.2 不做的

- **不做**分组逻辑迁移：`SessionGroupKey.of` 的路径 / projectKey 启发式**原样保留**——飞书群聊按 workspace 分组、私聊按 projectKey 分组的语义依赖路径细节，不是 source 能表达的；本方案只加标签，不动分组。
- **不做**`USER_SETTABLE_SESSION_SOURCES` 扩宽（保持 `['web', 'embed']`）与 `markSessionSource` 守卫改动（保持 embed-only）：用户永远不能把会话手工挪进任何系统来源。
- **不做**存量数据回填：历史 `'web'` 行保持原样，筛选口径定义为「按创建时来源」，文档注明 V109 前后差异。
- **不做**admin 数据看板「按来源的会话数」统计卡（治理诉求由筛选 + 列覆盖，聚合图表留待有真实运营需求后另立）。
- **不做**定时任务运行的独立来源维度（定时任务复用用户绑定的会话，source 保持创建时的值；运行来源已由轨迹 / `llm_call` 承担）。
- **不做**来源级权限（source 是事实标签，不是授权依据；渠道接入控制已有 bot 绑定 / Agent 可见性各自口径）。
- **不做** CLI（mao-agent）来源标记：CLI 经 `POST /v1/sessions` 建会话（`agent-cli/src/rest/rest-client.ts:81`），路由层白名单仅 `['web','embed']`，CLI 会话落 `'web'`，闭集不含 `'cli'`。如运营需要区分终端 CLI 渠道再另立提案（需同步放宽路由白名单并补汉化表），本期接受 CLI 与桌面会话在来源上不可区分。
- 边路任务 / 子代理会话不经 `createSession`（`streaming-ws-handler.ts:1156` 直接 `save`，source 落列默认 `'web'`）：admin 按来源筛选时**不含**通道会话的边路任务。筛选口径定义为「会话自身的直接来源」，边路跟随父会话展示、不单独标记，接受。
- **不新增**迁移、端点、收件箱 kind。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 落选项与理由 |
|---|---|---|---|
| D1 | 闭集取值 | 七值 `web / embed / feishu / dingtalk / weixin / signal / openapi` | 与通道域一一对应；`VARCHAR(16)` 容纳，零 DDL |
| D2 | 分组是否改用 source | 不改 | 启发式迁移是行为变更（回归面大），且群聊分组需要 workspace 粒度，source 表达不了 |
| D3 | `open-run` 的映射 | 三元 `SIGNAL→'signal'，其余→'openapi'` | API 与 WEBHOOK 共用此调用点且语义同属「开放接口触发」，不拆两值 |
| D4 | 位置参数防护 | 沿用 `open-run.service.ts:21-26` 既有注释护栏，只改传参值 | 三个通道写入点均为尾参追加，中间参数不动 |
| D5 | admin 筛选实现 | `listSessionsForAdmin` 加等值参数（复用既有 clauses 拼装范式） | 联合索引首列不是 source，admin 全表筛选量级可接受；不做新索引 |
| D6 | 汉化表位置 | admin / desktop 各自 `Record<SessionSource, string>`，契约只出联合类型 | 与 `LlmCallScene` 汉化表同范式，tsc 穷尽兜底 |
| D7 | 桌面徽标范围 | 仅 `TaskSessionGroupList.vue` 条目 | 搜索结果 / 轨迹等其余列表不加，避免视觉噪音扩散 |

## 4. 实现步骤

### 4.1 P1 后端（backend-ts）

1. `session.repository.ts:12`：`SESSION_SOURCE_VALUES` 扩为七值；`isSessionSource` / `SessionSource` 类型自动跟随。`USER_SETTABLE_SESSION_SOURCES` 与其注释**原样不动**。
2. `app-feishu-messaging.ts:82`：`createSession(..., null, null, 'feishu')`（补两个尾参：gitBranch 后加 source）。
3. `dingtalk/runtime.ts:124`：同上，尾参 `'dingtalk'`。
4. `weixin/session.service.ts:60`：`createSession(..., null, 'weixin')`。
5. `open-run.service.ts:165`：`input.source === 'SIGNAL' ? 'signal' : 'openapi'`，同步更新该处注释（API/WEBHOOK 不再落 'web'）。
6. `admin-session.routes.ts:86`：`listSessionsForAdmin` 调用加 `queryOptStr(request, 'source')`；非法值直接忽略（admin 侧无伪造面，宽松处理即可）——**定案：不校验，非法值按不过滤处理**。
7. `session.service.ts:471`：`listSessionsForAdmin` 加 `source?: string | null` 参数，非空时 `clauses.push('source = ?')`。
8. `session-vo.ts:251` `toAdminSessionVO`：加 `source: session.source ?? 'web'`。

### 4.2 P1 契约 + P2 admin

1. `shared/contracts/src/session.ts`：`export type SessionSource = 'web' | 'embed' | 'feishu' | 'dingtalk' | 'weixin' | 'signal' | 'openapi'`（注释：与后端 `SESSION_SOURCE_VALUES` 逐值一致）。
2. `admin/src/utils/sessionSourceLabels.ts`（新增）：`Record<SessionSource, string>` + `Record<SessionSource, string>` 图标名表。
3. `admin/src/views/session/SessionListView.vue`：筛选区加来源下拉（全部 / 七值）；表格加「来源」列（tag 样式，web 不加色、embed / signal / openapi / 通道各自色调与现状徽标体系一致）。
4. `admin/src/views/session/SessionDetailView.vue`：头部 meta 区加来源标签。

### 4.3 P3 desktop

1. `desktop/src/utils/sessionSourceLabels.ts`（新增）：同款 `Record<SessionSource, string>` 与图标表。
2. `TaskSessionGroupList.vue`：条目次行在 `source !== 'web'` 时渲染渠道图标 + tooltip（数据来自既有 `SessionVO.source`，**零后端改动**）。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `session.repository.ts`（闭集）、`app-feishu-messaging.ts`、`dingtalk/runtime.ts`、`weixin/session.service.ts`、`openapi/open-run.service.ts`（四处尾参）、`admin-session.routes.ts` + `session.service.ts`（admin source 过滤）、`session-vo.ts`（admin VO） |
| contracts | `shared/contracts/src/session.ts` 加 `SessionSource` |
| admin | `sessionSourceLabels.ts`（新增）、`SessionListView.vue`、`SessionDetailView.vue` |
| desktop | `sessionSourceLabels.ts`（新增）、`TaskSessionGroupList.vue` |
| 测试 | 后端：四个写入点各一条「source 落库值」断言（mock/捕获 createSession 尾参）+ open-run 的 SIGNAL / API / WEBHOOK 三态 + admin 列表 source 过滤 + embed 精确过滤回归 + `markSessionSource` embed-only 守卫回归；admin/desktop：`npm run build`（vue-tsc 穷尽即验证汉化表） |
| 文档 | 根 `CHANGELOG.md`「后端」「管理后台」「前端（桌面 / Web / 安卓）」三节；`skills/mao-cli/reference/admin.md` 会话管理一节补来源筛选说明 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 新来源值意外产生新分组 | `SessionGroupKey.of` 对未知 source 无分支、自然落回启发式（§1.1 末行已核实）；补一条回归测试：`of()` 对七个值的分组键与扩宽前对 web 的分组键规则一致（feishu 会话仍进 FEISHU_* 组） |
| embed 历史列表回归 | `source = 'embed'` 精确匹配未动；补回归：扩宽后 embed 会话仍只出现在浮窗历史、桌面 EMBED 分组不变 |
| 用户伪造来源 | `USER_SETTABLE_SESSION_SOURCES` 与 `markSessionSource` embed-only 守卫原样；POST /v1/sessions 的 400 文案不变 |
| `createSession` 位置参数错位（静态强转无编译期保护） | 三个通道写入点均为「末尾追加一个实参」，中间参数零改动；测试断言落库 source 之外还断言 workspace / projectKey 不串位 |
| 桌面徽标干扰信号哨兵分组 | 哨兵组内也显示徽标（统一规则），不加特判；视觉上与既有分组标签不冲突（徽标在条目内，分组在桶头） |

## 7. 测试要点

1. 四个写入点：飞书 p2p / 飞书群聊共用 factory 断言 `'feishu'`；钉钉 `'dingtalk'`；微信 `'weixin'`；断言除 source 外其余实参与改动前一致。
2. `open-run`：`SIGNAL` → `'signal'`、`API` / `WEBHOOK` → `'openapi'`、复用既有会话时**不改写**原 source。
3. admin 列表：`source=feishu` 只回飞书会话；不传 source 回全量；`toAdminSessionVO.source` 存在。
4. 回归：`/v1/sessions?source=embed`（浮窗历史）行为不变；`markSessionSource('web')` 仍 400；桌面分组键对七个 source 值的落桶与扩宽前一致。
5. 汉化表穷尽：两份 `Record<SessionSource, string>` 缺项时 `vue-tsc -b` 失败（构建即验证）。
