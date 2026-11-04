# 提案：分享链接开了就再没处管了 —— 分享一览与来源徽标

> 会话分享做完之后缺少后续治理：桌面端只能在当前会话里「打开才看得到」已生成链接，不知道自己开了多少个分享、谁正在看、还有没有个快过期的匿名链接散在外面。管理后台的会话管理装了来源列与筛选（`SESSION_SOURCE_LABELS`），而桌面任务列表里却不显示来源——同一套标签、两边体验断裂：用户在桌面看到一堆会话，看不出哪条是飞书群里 @ 出来的、哪条是开放接口跑的。

- 状态：**已否决，存档勿再评审**（2026-11-04 评审驳回）
- 日期：2026-11-04
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（分享一览只读端点 + 桌面任务列表来源徽标；约 2 人日；零迁移）
- 关联：`backend-ts/src/session/session-share.repository.ts`、`desktop/src/components/task/ShareDialog.vue`、`desktop/src/components/task/TaskIndexPanel.vue`、`admin/src/utils/sessionSourceLabels.ts`

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺「一览与徽标」（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 分享后端生成/刷新/撤销 | ✅ `POST /v1/sessions/:id/share`、`PUT`、`DELETE`、`GET` 均已链路齐全；水位/访问计数/过期/`revoked_at` 全部在；字段含 `createdBy`/`viewCount`/`expiresAt` | `session-share.routes.ts:31-55`、`session-share.service.ts:79-185` |
| 分享一览 | ❌ 无「我的分享」列表端点。用户无法不打开每个会话就看到自己全部分享的链接、归属会话、过期、访问次数；只能逐会话打开 `ShareDialog` | — |
| 管理后台来源 | ✅ `SESSION_SOURCE_LABELS` / `SESSION_SOURCE_TAG_TYPES` 两份 `Record<SessionSource, …>` 汉化表，admin 会话列表有来源列与筛选 | `admin/src/utils/sessionSourceLabels.ts` |
| 桌面来源徽标 | ❌ 桌面无同款来源徽标。`TaskIndexPanel` 的 `source` 变量是组装新建任务用的 Agent/工作区上下文，与会话 `source` 字段无关；`session-vo.ts` 已回 `source`（`web` 回退） | `TaskIndexPanel.vue:920-929`、`session-vo.ts:194` |

### 1.2 真实痛点

1. **分享开了就忘本是常态**：分享出去的匿名链接有时未过期、有人看过后用户却再想不起来撤销；管理后台的会话列表也看不出有没有对外分享——工作区文件分享只在单会话弹窗里看得见，缺一处全局一览。
2. **桌面看不到会话从哪儿来**：飞书群里 @ 出的会话、定时任务跑出的会话、开放接口触发的会话在桌面任务列表里一律长得一样，无法一眼区分「我要去的那个飞书对话」。

## 2. 目标 / 非目标

**目标**

1. **分享一览（只读）**：新增只读端点 `GET /v1/sessions/shares`（当前用户 `created_by = userId` 下 `revoked_at IS NULL` 的分享，按 `expires_at` 升序），返回归属会话 `session_id` + 标题、token（按钮复制/跳转）、`expiresAt`、`viewCount`、`lastViewedAt`；桌面加一处「我的分享」抽屉/页签聚合入口，点击跳回归属会话并打开既有 ShareDialog（撤销走既有 DELETE，会话删除后分享自然过期——已核 `isExpired`/会话级删除的 check 在 `session-share.service.ts`）。
2. **桌面任务列表来源徽标**：复用 admin 已定的 `SESSION_SOURCE_LABELS` / `SESSION_SOURCE_TAG_TYPES` 文案与色调，在 `TaskIndexPanel` 每项后渲染小徽标；桌面补 `desktop/src/utils/sessionSourceLabels.ts` 同源汉化表（`Record<SessionSource, string>` 编译期穷尽，与 admin 一字不改）。

**非目标**

- 不做分享的有效期推续/批量撤销/分享策略管理（仅一览 + 既有单条撤销）。
- 不改分享链接的鉴权门/快照水位/匿名链接开关。
- 不给用户开管理后台会话列表的能力（admin 行为不变）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话导出 Markdown（2026-11-02 已驳回） | 不做可读文档导出，只做分享一览与来源徽标。 |
| 会话分享/导出（2026-10-06 已实施） | 不改快照/水位/链接鉴权，只补一览入口与桌面徽标。 |
| 执行中引导/批量任务/交付物中心 | 不新增任何执行形态，只给已有的分享与来源补可见性。 |

## 4. 方案设计

### 4.1 分享一览（只读端点 + 桌面抽屉）

- **端点**：`GET /v1/sessions/shares`，权限=属主（`created_by = userId`），仅返回 `revoked_at IS NULL`；`revoked_at` 已撤销/`isExpired` 的在视图里置灰或不出现（语义：分享一览=当前可用）。不需要新表：`session_share` 的 `created_by`/`revoked_at`/`expires_at` 已齐。
- **桌面**：顶栏铃铛/快捷指令旁补一处入口，打开后列出分享一览表（链接复制、过期时间、访问次数、上次访问、跳转会话）；「去会话」直接打开归属会话并聚焦 ShareDialog；「撤销」调既有 `DELETE /v1/sessions/:id/share`，不变。

### 4.2 桌面任务列表来源徽标

- 桌面 `desktop/src/utils/sessionSourceLabels.ts` 与 admin 同文案复刻，`Record<SessionSource, string>` 编译期穷尽。
- `TaskIndexPanel.vue` 每项渲染小徽标：`session.source ?? 'web'` 回落 `Web`；色调与 admin 一致（`primary/success/warning/danger/info`），点击点跳转不影响——徽标本身不可点击、不触发筛选。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `GET /v1/sessions/shares` 只读端点（`session_share.repository.ts` 新增 `listActiveByCreatedBy`；按 `expires_at` 升序） |
| desktop | 分享一览抽屉/页签（复用 `sharePageUrl`）、`desktop/src/utils/sessionSourceLabels.ts`（与 admin 同文案）、`TaskIndexPanel.vue` 来源徽标 |
| admin | **无改动** |
| skills/mao-cli | 补桌面端说明（分享一览、来源徽标） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 分享一览把 token 枚举给非属主 | 权限门=属主 `created_by = userId`，与既有单会话分享的属主门同口径 |
| 徽标色/字单独造一份分心 | 与 admin 同文案、同色调、用 `Record<SessionSource, …>` 穷尽兜底 |

## 7. 测试要点

1. 分享一览端点：只返回本人+未撤销；过期分享在列表里的处理与 `isExpired` 一致；会话删除后分享在列表中不可见。
2. 桌面：一览列表点「去会话」打开归属会话和 ShareDialog；撤销后列表刷新；来源徽标与 admin 逐字逐色一致。
3. 回归：单会话分享的生成/刷新/撤销、水位冻结、匿名链接开关行为不变。

## 8. 待确认决策

1. 分享一览入口位置（顶栏铃铛旁抽屉 vs 任务面板内的页签）——建议顶栏铃铛旁。
2. 一览列表默认排序（过期时间升序，快过期的浮在上面提醒）和是否把已撤销单独标出（建议不标出，已撤销不再是「我的有效分享」）。
