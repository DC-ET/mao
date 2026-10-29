# 提案：每个会话从哪来 —— 会话来源全链路标记与筛选

> 一个跑了几个月的实例里，管理员面对「会话管理」列表回答不了两个问题：这些会话是谁开的——桌面端亲手建的，还是飞书 / 钉钉 / 微信机器人、开放接口、信号哨兵自己长出来的？CHANGELOG 0.0.3xx 浮窗助手上线时自己就承认了这个缺口（「浮窗会话混在会话管理列表，无法按来源筛选」）。更关键的是底子已经打好：`source` 列、创建参数、列表过滤、联合索引全部就绪（V109），只是**绝大多数通道从来没把真实来源写进去**——今天只有 web / embed / signal 三个值在流通，飞书、钉钉、微信、开放接口建的会话一律混标为 `web`。

- 状态：**已细化，技术方案待评审**（[../plan/2026-10-29-session-source-lineage-technical-design.md](../plan/2026-10-29-session-source-lineage-technical-design.md)，7 项决策已定案；方案对提案有两处收窄：分组逻辑明确不迁移 source（D2）、admin 看板统计卡明确不做）
- 日期：2026-10-29
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（P1 后端约 1 人日、P2 admin UI 约 1 人日；**零迁移**）
- 关联：`backend-ts/src/session/session.repository.ts`、`backend-ts/src/session/session.service.ts`、`backend-ts/src/openapi/open-run.service.ts`、`backend-ts/src/feishu/agent-inbound-handler.ts`、`backend-ts/src/dingtalk/runtime.ts`、`backend-ts/src/weixin/session.service.ts`、`admin/src/views/session/SessionListView.vue`

## 1. 背景与现状

### 1.1 基础设施全就绪，写入面却是空的（代码可查）

| 设施 | 现状 | 证据 |
|---|---|---|
| `session.source` 列 | VARCHAR(16)，默认 `'web'` | V109 `__add_session_source.sql` |
| 来源类型与合法值 | `SESSION_SOURCE_VALUES` 闭集 + `isSessionSource` 校验 | `session.repository.ts:12-14` |
| 用户可设来源白名单 | `USER_SETTABLE_SESSION_SOURCES = ['web', 'embed']` | `session.repository.ts:23` |
| 创建时传入来源 | `createSession` 第 16 个位置参数，缺省 `'web'` | `session.service.ts:118,147` |
| 开放接口 / 哨兵触发 | 仅 `SIGNAL` 传了 `'signal'`；**API / WEBHOOK 触发的新会话落 `'web'`** | `open-run.service.ts:165` |
| 飞书 / 钉钉 / 微信建会话 | 均不传 source → 全部落 `'web'` | `feishu/agent-inbound-handler.ts`、`dingtalk/runtime.ts:117`、`weixin/session.service.ts:60` |
| 列表按来源过滤 | `/v1/sessions` 已支持 `source` 查询参数 | `session.routes.ts:252` |
| 查询索引 | `idx_session_user_agent_source_updated` 已建 | V109 |
| admin 会话管理 | 无来源列、无来源筛选 | `admin/src/views/session/SessionListView.vue` |

### 1.2 后果

- **运营视角失明**：管理员说不清每个渠道的实际用量（机器人渠道到底有没有人用？开放接口每天真实建了几个会话？），只能靠 workspace 路径里 `feishu-chat/`、`dingtalk-chat/` 这类**目录名巧合**倒推——那是实现细节，不是契约。
- **治理无从下手**：想清理「哨兵产生的陈旧会话」「接口触发的测试会话」时无法批量圈定；信号哨兵会话在桌面端有独立分组，其余通道全靠肉眼。
- **embed 隔离语义孤悬**：`source` 唯一被认真使用的地方是 Embed SDK 历史列表过滤（`markSessionSource` 甚至写死只允许 `'embed'`），说明这个字段的设计意图本来就是「来源全程可辨」，只差把其余通道接上。

## 2. 目标 / 非目标

**目标**

1. **P1 后端补全写入面**：`SESSION_SOURCE_VALUES` 扩为闭集 `web / embed / feishu / dingtalk / weixin / signal / openapi`；五个写入点各传一行——飞书、钉钉、微信建会话传对应值，`open-run.service.ts` 对 API / WEBHOOK 触发传 `'openapi'`（`'signal'` 已就绪）。`USER_SETTABLE_SESSION_SOURCES` 与 `markSessionSource` 的 embed-only 守卫**原样不动**，用户侧永远伪造不了来源。
2. **P2 admin 会话管理**：列表加「来源」列（中文标签 + 图标）与来源筛选（复用既有 `source` 查询参数，零后端改动）；会话详情展示来源。
3. **P3（可选）桌面端来源徽标**：任务面板会话条目对非 `web` 来源显示小徽标（与信号哨兵独立分组的既有形态互补，覆盖飞书 / 钉钉 / 微信 / 开放接口）。

**非目标**

- 不动 `TaskNotifySource` / `MessageQueueSource` / `InboxKind`——它们各自语义正确，不与 `SessionSource` 合并。
- 不做按来源的用量报表（admin 用量分析已有 Agent / 用户 / 模型维度，来源维度列为后续可选）。
- 不追溯改历史数据的 source（存量 `'web'` 保持原样，文档注明「V109 之前/未标记时期不可区分」）。
- 不做来源级权限（谁能用哪个渠道）——渠道绑定与 Agent 可见性已有各自口径。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话移交（2026-10-25 否决） | 不动归属与人员，只是给会话打一个只读事实标签。 |
| 开放接口调用中心（已实施） | 那是**调用**流水；本提案补的是**产物（会话）**在会话列表里的可辨性，两者互补。 |
| 用户自建 Agent / 平台扩张（2026-10-25 否决） | 无任何新对外面、新权限面。 |

## 4. 方案

### 4.1 后端（P1）

- `session.repository.ts`：`SESSION_SOURCE_VALUES` 扩为上述七值闭集；`SessionSource` 类型随之变宽，`isSessionSource` 自动覆盖。
- 写入点（每处一行）：
  - `feishu/agent-inbound-handler.ts` 建会话 → `'feishu'`；
  - `dingtalk/runtime.ts:117` 与 `dingtalk/agent-inbound-handler.ts` → `'dingtalk'`；
  - `weixin/session.service.ts:60` → `'weixin'`；
  - `open-run.service.ts:165` → API / WEBHOOK 触发的新会话传 `'openapi'`（替换现在的 `undefined` 回落 `'web'`）。
- embed 历史过滤（`source = 'embed'` 精确匹配）与 `markSessionSource` 守卫零改动；`'web'` 缺省语义保持（桌面 / Web / 定时任务绑定的普通会话仍是 `web`）。

### 4.2 admin（P2）

- `SessionListView`：来源列（`Record<SessionSource, string>` 汉化表吃编译期穷尽，符合 AGENTS.md 跨端枚举规范）+ 顶部筛选下拉；`SessionDetailView` 头部展示来源标签。
- 来源契约下沉 `@mao/contracts`（`session.ts` 导出联合类型 + 汉化表类型），desktop P3 与 admin 共用。

### 4.3 desktop（P3，可选）

- 任务面板会话条目：非 `web` 来源显示渠道图标徽标（与既有「信号哨兵」分组并存：分组解决哨兵，徽标覆盖其余通道）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | 闭集扩宽 + 5 个写入点各一行；无迁移、无新端点 |
| contracts | `SessionSource` 联合类型下沉 + 汉化表类型 |
| admin | 会话列表来源列 + 筛选；详情来源标签 |
| desktop | P3 徽标（可选） |
| agent-cli / mao-cli / android | 无（安卓随 Web 获得 P3 徽标，如有） |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 来源值被误用于权限判断（未来有人拿 `'openapi'` 做鉴权分支） | `USER_SETTABLE_SESSION_SOURCES` 不扩；文档明确 `source` 是**事实标签**不是授权依据 |
| 汉化表漏项 | admin/desktop 汉化表用 `Record<SessionSource, string>` 声明，tsc 编译期穷尽兜底（AGENTS.md 既有规范） |
| open-run 的位置参数陷阱 | `open-run.service.ts:21-26` 已有「位置签名必须与 createSession 逐位一致」的注释护栏，本次只改传参值不改签名 |
| 存量数据歧义（历史 `'web'` 里混着机器人会话） | 不回填；筛选语义定义为「按创建时来源」，文档注明口径 |
| embed 历史列表回归 | `source='embed'` 精确匹配不动，补一条 embed 会话在扩宽后仍只出现在浮窗历史的回归测试 |

## 7. 测试要点

1. 五个写入点各自建会话后 `source` 落库正确；桌面端建会话仍为 `'web'`。
2. 开放接口 API / WEBHOOK 触发新建会话 → `'openapi'`；复用既有会话时不改写原 source。
3. `/v1/sessions?source=feishu` 过滤正确；非法值 400（`isSessionSource` 既有校验）。
4. embed 回归：浮窗历史仅含 `'embed'`；`markSessionSource` 仍拒绝非 embed 值。
5. admin 汉化表穷尽：在闭集里临时加一个假值应导致 vue-tsc 报错（哨兵测试可选）。

## 8. 待确认决策

1. 闭集取值：七值是否合适？定时任务触发的运行复用绑定会话（source 保持创建时的 `'web'`），是否需要单独的运行来源维度（建议不需要，运行来源已有 `llm_call` / 轨迹承担）？
2. P3 桌面徽标是否本期一起做（不做的代价：普通用户看不到自己飞书会话的来源，仅 admin 可辨）？
3. admin 是否顺带在数据看板加一个「按来源的会话数」小卡（纯聚合查询，约 0.5 人日）？
