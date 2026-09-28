# 飞书卡片「点踩反馈」技术方案

- 日期：2026-09-28
- 状态：已与需求方达成共识，待实施
- 前置：`docs/plan/2026-09-27-message-dislike-feedback-technical-design.md`（桌面端点踩，已上线 0.0.208）
- 涉及端：backend-ts（后端）、admin（管理后台展示来源）
- 不涉及：desktop、android 原生壳、agent-cli

---

## 1. 需求背景

桌面/Web/安卓端已在任务结果消息上提供点踩反馈，但飞书通道用户（IM 内 @机器人 派任务）看不到、也用不了该能力：飞书侧只能看到进度卡片文字，对结果不满意时无处标记，管理后台的点踩统计因此缺失飞书这一路的样本。本需求在飞书**任务完成卡片**上增加点踩按钮，让 IM 用户也能一键标记不满，并与桌面端数据汇入同一张统计表。

## 2. 需求描述

### 2.1 要做的

1. 飞书进度卡片在**任务完成（COMPLETED）**终态时，按钮区渲染「👎 不满意」按钮（放在「会话详情」按钮左侧）。
2. 点击行为（**同一个按钮 toggle**）：
   - 未点踩态：按钮文案「不满意」，中性灰（`type: default`）；点击后写入点踩记录，卡片立即刷新为已点踩态。
   - 已点踩态：按钮文案「已点踩 · 再点取消」，红色高亮（`type: danger`）；再点一次删除点踩记录，卡片恢复未点踩态。
   - 点踩/取消均弹出 toast 反馈（「已标记不满意」/「已取消点踩」）。
3. **不选择原因**：飞书点踩固定写入专属原因分类 `NO_REASON`（后台展示为「未选择原因（飞书）」），与桌面端四选一原因区分开。
4. **仅消息发送者可操作**：回调校验 `event.operator.open_id === action.sender`，不满足时 toast「仅消息发送者可操作」，与现有「取消任务」「重试」按钮同规则。
5. 记录归属：飞书点踩同样写入 `message_feedback` 表，`user_id` 取该会话所属用户（飞书会话由绑定用户创建，原发送者即会话所有者），`message_id` 取该会话**最后一条 ASSISTANT 消息**（与 `getLatestAssistantReply` 同源口径）。
6. 数据来源区分：`message_feedback` 表新增 `source` 列（`desktop` / `feishu`，存量行回填 `desktop`），管理后台明细列表新增「来源」列展示；桌面端写入 `desktop`，飞书写入 `feishu`。
7. 管理后台原因分布与筛选项自动包含 `NO_REASON`（从汇总接口的 `byReason` 动态取，不硬编码）。
8. 进程重启/崩溃恢复后仍可点踩、可取消：点踩状态以 `message_feedback` 表为准查询，不依赖进程内存。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 原因选择 | 飞书侧不弹原因选项，固定 `NO_REASON` |
| FAILED / CANCELLED 卡片点踩 | 仅 COMPLETED 完成卡提供按钮 |
| 桌面端来源筛选 | 管理后台本期只展示来源列，不做按来源筛选 |
| 点踩率指标 | 延续桌面端决策：只统计绝对数量与分布 |
| 钉钉 / 微信通道点踩 | 本期只做飞书；其余通道后续如需要单独立项 |
| 点踩后推送通知 | 不向任何通道推送点踩事件 |

## 3. 技术选型

全部复用现有设施，不引入新依赖：

- **回调链路**：飞书 `card.action.trigger` → `FeishuCardActionService.handle()` 现有分派；点踩是 `feishu_progress` 家族的新 `act: 'dislike'` 分支，与 `cancel`/`retry` 并列。
- **卡片构建**：`buildFeishuProgressCard` 扩展参数 `disliked?: boolean`；COMPLETED 且 `action != null` 时渲染点踩按钮。
- **数据层**：复用 `message_feedback` 表与 `FeedbackService`；`FEEDBACK_REASONS` 增加 `NO_REASON`（仅服务端校验放行，桌面端选项列表不含它）。
- **迁移**：`backend-ts/db/migration/V124__message_feedback_source.sql`（当前线上已执行到 V123）。
- **管理后台**：复用点踩反馈页；原因筛选项改为读汇总接口 `byReason`，明细加「来源」列。

## 4. 数据模型变更

### 4.1 迁移 V124

```sql
ALTER TABLE `message_feedback`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'desktop' COMMENT '来源：desktop / feishu' AFTER `reason`;

UPDATE `message_feedback` SET `source` = 'desktop' WHERE `source` = '' OR `source` IS NULL;
```

- 存量行（桌面端点踩）自动为 `desktop`，无需数据订正。
- 不加 `source` 专用索引：当前数据量小，明细查询以 `created_at` 倒序为主路径。

### 4.2 枚举扩展

| 值 | 展示文案 | 写入方 |
| --- | --- | --- |
| `WRONG_RESULT` | 结果错误 | 桌面端 |
| `SLOW_RESPONSE` | 处理速度慢 | 桌面端 |
| `NOT_SOLVED` | 问题未解决 | 桌面端 |
| `OTHER` | 其他 | 桌面端 |
| `NO_REASON` | 未选择原因（飞书） | 飞书 |

## 5. 交互与接口设计

### 5.1 卡片按钮（COMPLETED 态）

```
[👎 不满意]            ← default 灰；value {kind:'feishu_progress', act:'dislike', sessionId, sender}
[会话详情]              ← 现有 open_url 按钮
```

已点踩后同一位置变为：

```
[👎 已点踩 · 再点取消]   ← danger 红；同一个 act:'dislike'，服务端按当前记录 toggle
[会话详情]
```

### 5.2 回调处理流程（`handleProgressDislike`）

1. 校验 `event.operator.open_id === action.sender`，否则 toast「仅消息发送者可操作」并返回当前卡片。
2. `sessionOwnerLookup(sessionId)` 取会话归属用户（按钮仅发送者可点，发送者即会话所有者，无需 open_id→用户反查）。
3. `findLatestAssistantMessageId(sessionId)` 取最后一条 ASSISTANT 消息 ID；不存在时 toast「未找到可反馈的任务结果」。
4. toggle：`message_feedback` 中该 `message_id` 有记录则删除，无记录则插入（`reason=NO_REASON, source=feishu`）。
5. **必须在回调响应内返回整张新卡片**（飞书 3 秒约束，否则客户端还原为点击前旧卡）：以当前进度快照重建 COMPLETED 卡，按钮按 toggle 后的状态渲染；同时返回 toast。
6. 群内其他人靠回调响应只更新点击者视图（与现有取消/重试按钮行为一致），不做额外 PATCH。

### 5.3 管理端接口

无新增接口。变更：
- `GET /v1/feedback/admin/summary` 的 `byReason` 自动含 `NO_REASON`（服务端 `FEEDBACK_REASONS` 已含，`label` 为「未选择原因（飞书）」）。
- `GET /v1/feedback/admin/list` 明细项新增 `source` 字段；页面新增「来源」列（桌面端 / 飞书）。
- 原因筛选项由页面硬编码改为读汇总接口 `byReason` 动态渲染。

## 6. 实现步骤

### 6.1 后端

1. **迁移** `V124__message_feedback.sql`：加 `source` 列。
2. **feedback 领域**：
   - `feedback.repository.ts`：`FEEDBACK_REASONS` 加 `NO_REASON`；upsert/明细映射带 `source`；新增 `existsByMessageId(messageId)`（toggle 判定）；`sumByReason`/`listDetails` 无需改（source 随行返回）。
   - `feedback.service.ts`：`REASON_LABELS` 加 `NO_REASON`；`dislike` 增加可选 `source` 参数（默认 `desktop`）；新增 `toggleSessionDislike(userId, sessionId, source)`：取会话归属 → 取最后一条 ASSISTANT 消息 → toggle → 返回 `{ disliked: boolean }`。
   - `FeedbackMessageLookup` 新增 `findLatestAssistantMessageId(sessionId)`，`FeedbackDbLookup` 实现（查该会话最后一条 `role='ASSISTANT' AND deleted=0` 的 id）。
3. **飞书侧**：
   - `types.ts`：`FeishuProgressCardActionValue.act` 增加 `'dislike'`。
   - `progress-card.ts`：`buildFeishuProgressCard` 增加入参 `disliked?: boolean`；`status === 'COMPLETED' && action != null` 时渲染点踩按钮（toggle 文案与颜色）。
   - `card-action.service.ts`：新增 `handleProgressDislike`，构造函数注入 `toggleDislike: (sessionId) => Promise<{ disliked: boolean } | null>`（null 表示未找到可反馈消息）。
   - `patched-progress.ts`：`FeishuProgressSnapshot` 的 buildCard 输入与 `renderCurrent` 支持 `disliked` 透传。
   - `create-app.ts`：`buildCard` 闭包透传 `disliked`；卡片动作服务注入 `toggleDislike`（内部调 `feedbackService.toggleSessionDislike`，source=`feishu`）。
4. **测试**：`feedback.spec.ts`（toggle、NO_REASON、source）、`progress-card.spec.ts`（完成卡按钮、已点踩文案/颜色、非完成态不渲染）、`card-action.service.spec.ts`（toggle 回调、非发送者拒绝、无 assistant 消息时 toast）。

### 6.2 管理后台

1. `FeedbackView.vue`：原因筛选项改读 `summary.byReason`；明细表加「来源」列（`source === 'feishu' ? '飞书' : '桌面端'`）。
2. 无路由/菜单改动（`feedback:read` 权限不变）。

### 6.3 文档（同任务完成）

- CHANGELOG 新增小节（前端/后端/管理后台）。
- `skills/mao-cli/reference/feedback.md` 补充 `NO_REASON`、`source` 字段说明。
- 本方案文档落 `docs/plan/2026-09-28-feishu-card-dislike-technical-design.md`。

## 7. 落地清单

| # | 交付物 | 位置 |
| --- | --- | --- |
| 1 | V124 迁移（source 列） | `backend-ts/db/migration/V124__message_feedback_source.sql` |
| 2 | reason 枚举 + source 映射 + exists/toggle | `backend-ts/src/feedback/feedback.repository.ts` |
| 3 | NO_REASON label + toggleSessionDislike + findLatestAssistantMessageId | `backend-ts/src/feedback/feedback.service.ts` |
| 4 | act 扩展 'dislike' | `backend-ts/src/feishu/types.ts` |
| 5 | 完成卡点踩按钮（toggle 文案/颜色） | `backend-ts/src/feishu/progress-card.ts` |
| 6 | 点踩回调处理 + toggle 注入 | `backend-ts/src/feishu/card-action.service.ts` |
| 7 | disliked 透传 | `backend-ts/src/feishu/patched-progress.ts` |
| 8 | buildCard 闭包 + toggleDislike 注入 | `backend-ts/src/create-app.ts` |
| 9 | 三个 spec 更新 | `backend-ts/src/feedback/*.spec.ts`、`feishu/*.spec.ts` |
| 10 | 原因动态选项 + 来源列 | `admin/src/views/feedback/FeedbackView.vue` |
| 11 | CHANGELOG + mao-cli 文档 | `CHANGELOG.md`、`skills/mao-cli/reference/feedback.md` |

## 8. 验证方案

1. 后端：`cd backend-ts && npm test`（feedback + feishu 相关 spec 全绿）、`npm run build`。
2. 管理后台：`cd admin && npm run build`（vue-tsc + vite）。
3. 真实联调（如可触达飞书测试机器人）：完成任务卡出现「不满意」→ 点击变红「已点踩 · 再点取消」→ 再点恢复；换非发送者账号点击被拒；管理后台出现记录且来源为「飞书」、原因为「未选择原因（飞书）」。
4. 迁移：本地 e2e 库执行 V124 成功，存量行 source=desktop。

## 9. 风险与关键假设

- **关键假设 1**：飞书点踩的 `user_id` 取会话所属用户。依据：飞书会话由绑定用户创建，进度卡按钮已限制仅原发送者可点，发送者即会话所有者。若未来飞书支持代操作（他人替点），需改为 open_id→用户反查。
- **关键假设 2**：点踩状态以 DB 为准查询，进程重启后状态不丢；卡片本身不带状态缓存。
- **关键假设 3**：`source` 列仅用于后台展示来源，不做筛选与索引；若后续按来源筛选再加索引。
- **风险**：飞书回调 3 秒内必须返回整张卡。toggle 链路只有 2 次轻量 DB 查询，无外部 HTTP，时延可控；返回卡片复用现有快照构建逻辑，无新增 IO。
- **边界**：会话被删/消息被清理后，`findLatestAssistantMessageId` 返回空，回调 toast 提示，不写脏数据。
- **边界**：重试（retry）后的新进度卡同样带点踩按钮（COMPLETED 态），语义一致。
