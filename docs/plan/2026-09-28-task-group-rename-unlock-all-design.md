# 放开全部场景任务分组重命名 — 可行性评估

> 状态：已按方案 A 实现（全部 key 可改名，含系统桶）
> 日期：2026-09-28
> 关联：`docs/plan/2026-09-26-task-group-rename-design.md`（原方案，明确排除飞书/钉钉）、`docs/code-review/2026-09-26-task-group-rename-review-*.md`
> 关联代码：`desktop/src/utils/cloud-project.ts`、`desktop/src/components/task/TaskIndexPanel.vue`、`desktop/src/composables/useTaskPanelPrefs.ts`、`backend-ts/src/preference/task-panel-preference.service.ts`、`skills/mao-cli/reference/pref.md`

---

## 1. 背景与目标

任务分组右键「重命名」已上线，但仅对 `LOCAL:{path}` / `CLOUD:{path}` 开放。飞书、钉钉分组被前后端同步拦截，用户感知为「只有云端/本地能改，渠道分组不能改」。本文评估**放开所有场景分组重命名**的可行性、影响面与改动点。

微信分组（`projectKey=weixin-bot`）实际归入 `CLOUD:{workspace}`，**今天已可改名**；用户反馈中的「微信不可改」更可能来自飞书/钉钉的同类体验或历史脏数据（工作区不含 `/projects/` 落入 `CLOUD:临时工作区`）。

### 目标

- 飞书私聊 / 飞书群聊 / 钉钉私聊 / 钉钉群聊分组支持右键重命名、恢复默认名。
- 别名展示、tooltip 推导名、多端同步与现有 `LOCAL`/`CLOUD` 行为完全一致。
- 不改动分组 key、会话归属、排序、折叠、分页、过滤语义。

### 非目标

| 不做 | 原因 |
|------|------|
| 重命名真实磁盘目录 / 云端项目 slug / 飞书群名 | 纯展示层偏好，不触碰外部系统 |
| 后端分组预览 API 返回个人别名 | 别名是个人偏好，不进公共/服务端推导 label |
| 管理后台展示或编辑别名 | 别名按 user_id 隔离，不进管理侧 |
| 分组合并 / 跨分组移动 | 独立需求 |

---

## 2. 可行性结论

**可行，工作量小，无破坏性影响。** 核心依据：

1. **架构上重命名只是「显示名覆盖」。** 分组 key 由 `cloudGroupKey()` / `SessionGroupKey.of()` 从 workspace 实时推导，是归属/排序/折叠/分页/过滤的唯一事实源；别名 map 只影响渲染。放开限制只是**扩大允许写入别名的 key 集合**，不动 key 本身。
2. **持久化通道已就绪。** `user_task_panel_preference.group_aliases`（JSON map，V122）已支持任意 key；当前被 `normalizeAliases` 主动剔除的部分 key，放开后自然可存。
3. **无新表、无新路由、无 API 契约变更。** `GET/PUT /v1/user-preferences/task-panel` 的 `groupAliases` 字段语义不变，只是服务端不再过滤渠道 key。
4. **前端展示链已统一走 `resolveGroupLabel`。** 标准分组头、聚焦模式 `workspaceLabel`、tooltip 推导名共用同一函数，放开后自动生效。

**结论：改两处布尔规则 + 若干测试/文档即可，预计 0.5–1 人日。**

---

## 3. 现状盘点

### 3.1 可改名矩阵（当前）

| 分组类型 | key 形态 | 当前可改 | 标签推导（fallback） |
|----------|----------|----------|----------------------|
| 本地工作区 | `LOCAL:{path}` | ✅ | 路径末段 |
| 本地未设置 | `LOCAL:未设置` | ❌ | `未设置` |
| 云端项目 | `CLOUD:{…/projects/slug}` | ✅ | slug |
| 微信 Bot | `CLOUD:{…/projects/weixin-bot}` | ✅ | `weixin-bot`（图标为微信） |
| 云端临时 | `CLOUD:临时工作区` | ❌ | `临时工作区` |
| 飞书私聊 | `FEISHU_PRIVATE:{agentId}` | ❌ | `{agentName}` |
| 飞书群聊 | `FEISHU_GROUP:{workspace}` | ❌ | `{agentName}:飞书群{botId}·{chatId前缀}` |
| 钉钉私聊 | `DINGTALK_PRIVATE:{agentId}` | ❌ | `{agentName}` |
| 钉钉群聊 | `DINGTALK_GROUP:{workspace}` | ❌ | `{agentName}:钉钉群{botId}·{leaf}` |
| 未知 key | 其他 | ❌ | 原样返回 |

### 3.2 限制实现位置（双端必须同规则）

| 层 | 文件 | 函数 | 行为 |
|----|------|------|------|
| 前端门禁 | `desktop/src/utils/cloud-project.ts` | `isGroupRenameable` | 右键菜单是否出现「重命名」；`resolveGroupLabel` 是否读别名 |
| 前端展示 | 同上 | `resolveGroupLabel` | `!isGroupRenameable` 时**直接忽略别名**走 fallback |
| 后端门禁 | `backend-ts/src/preference/task-panel-preference.service.ts` | `isGroupRenameable` + `normalizeAliases` | 保存时剔除不可改名 key 的条目（防旧客户端/伪造请求写入） |
| 文档 | `skills/mao-cli/reference/pref.md` | — | 写明会被剔除的 key 列表 |

前后端各有一份 `isGroupRenameable`，注释互相锚定「保持同一规则」。**放开必须双端同改**，否则前端能设、后端洗掉，刷新后丢失。

### 3.3 原设计为何排除渠道分组（`2026-09-26-…-design.md` §1/§3.3）

- `FEISHU_PRIVATE` / `DINGTALK_PRIVATE`：标签 = Agent 名，视为**身份标识**而非路径派生名。
- `FEISHU_GROUP` / `DINGTALK_GROUP`：标签 = `Agent:群名` **合成语义**，改别名会「破坏组合结构」。
- `LOCAL:未设置` / `CLOUD:临时工作区`：**系统语义桶**，多个不相关会话共用，改名会让归属描述失真。

这些是产品语义取舍，不是技术限制。用户诉求本质是：「分组太多认不出来，想起个自己认识的名字」——渠道分组恰恰是最需要自定义的（`Coder:飞书群1·oc_a1b2` 可读性差）。

---

## 4. 方案选项

| 方案 | 范围 | 评价 |
|------|------|------|
| A. 全部放开（含系统桶） | 所有 key 均可改名 | 实现最简单（`isGroupRenameable` 恒 true 或删除），但「临时工作区」「未设置」是多会话兜底桶，改名后难以理解，**不推荐** |
| B. 放开渠道分组，保留系统桶 | `FEISHU_*` / `DINGTALK_*` 可改；`LOCAL:未设置` / `CLOUD:临时工作区` / 未知 key 仍不可改 | **推荐**。满足「所有场景」真实诉求，保留系统语义护栏 |
| C. 仅放开群聊，私聊仍按 Agent | `FEISHU_GROUP` / `DINGTALK_GROUP` 可改；`*_PRIVATE` 不可改 | 折中，但用户对「私聊 = 某个 Agent」同样有改名诉求（如「报销助手」），且规则更碎、更难解释 |

**推荐方案 B。** 下文改动点均按 B 描述；若最终选 A，只需把 `isGroupRenameable` 进一步放宽（见 §5.1 备注）。

---

## 5. 详细改动点（方案 B）

### 5.1 规则函数（核心，双端对称）

**前端** `desktop/src/utils/cloud-project.ts`：

```ts
/** 哪些分组 key 允许用户重命名：系统语义桶与未知 key 不允许（与后端 normalize 规则一致）。 */
export function isGroupRenameable(key: string): boolean {
  // 系统语义桶：多会话兜底，改名会失真
  if (key === 'LOCAL:未设置' || key === 'CLOUD:临时工作区') return false
  // 渠道身份/合成分组：允许自定义别名（别名仅覆盖显示，key 与推导逻辑不变）
  if (
    key.startsWith('FEISHU_PRIVATE:') || key.startsWith('FEISHU_GROUP:') ||
    key.startsWith('DINGTALK_PRIVATE:') || key.startsWith('DINGTALK_GROUP:')
  ) return true
  // 工作区分组
  if (key.startsWith('LOCAL:')) return true
  if (key.startsWith('CLOUD:')) return true
  return false
}
```

**后端** `backend-ts/src/preference/task-panel-preference.service.ts` 同步改 `isGroupRenameable`（保持注释互指）。`normalizeAliases` 调用点不变。

> **方案 A 备注**：若连系统桶也放开，把前两个 `return false` 删掉即可；`resolveGroupLabel` 因 `isGroupRenameable` 恒真而自然全量读别名。仍建议保留「未知 key 拒绝」，避免偏好 map 被垃圾 key 撑大。

### 5.2 展示链 `resolveGroupLabel`

**无需结构性改动。** 现逻辑：

```ts
const fallback = formatFallbackGroupLabel(key, session)
if (!isGroupRenameable(key)) return fallback
const alias = aliases[key]?.trim()
return alias ? alias : fallback
```

`isGroupRenameable` 放开后，渠道分组自动「别名 > 推导名」。注意两点：

1. **fallback 必须保留完整推导能力**（`formatCloudGroupLabel` 对 `FEISHU_*`/`DINGTALK_*` 的合成逻辑已存在），tooltip 的 `resolveGroupLabel(key, {})` 会继续显示推导名，满足「别名 + 真实身份」双可见。
2. **后端 `SessionGroupKey.formatLabel` 不改。** 服务端分组预览 label 仍是推导名；前端 `groupedSessions` / `workspaceLabel` 以 `resolveGroupLabel` 为准（现状已如此）。个人别名不进公共 API。

### 5.3 交互层 `TaskIndexPanel.vue`

| 触点 | 现状 | 改动 |
|------|------|------|
| 右键菜单「重命名」显隐 | `v-if="isGroupRenameable(key)"` | 不改代码，规则放开后自动出现 |
| 右键菜单「重置名称」 | `v-if="hasGroupAlias(key)"` | 不改 |
| `openGroupContextMenu` 早退 | `!isGroupRenameable && !hasGroupAlias` 时不弹菜单 | 不改 |
| 预填当前名 | `resolveGroupLabel(key, groupAliases.value)`（2026-09-28 已修） | 不改，对渠道分组同样预填推导名 |
| tooltip | `别名（推导名）` | 不改 |
| 聚焦模式 `workspaceLabel` | 已走 `resolveGroupLabel` | 不改，自动显示别名 |

**结论：UI 零改动或仅注释更新。**

### 5.4 文档与 CLI

| 文件 | 改动 |
|------|------|
| `skills/mao-cli/reference/pref.md` | 删除「`FEISHU_*`、`DINGTALK_*` 会被剔除」表述，改为「仅 `LOCAL:未设置`、`CLOUD:临时工作区` 等系统桶被剔除」 |
| `docs/plan/2026-09-26-task-group-rename-design.md` | 顶部加一行「2026-09-28 起渠道分组放开，见解锁评估文档」；或在 §3.3 表格旁注变更 |
| `CHANGELOG.md` | 前端小节记一条用户可见改动 |

### 5.5 不需要改的部分

| 项 | 原因 |
|----|------|
| 数据库 / 迁移 | `group_aliases` JSON 已能存任意 key |
| `shared/contracts/src/preference.ts` | 字段类型不变 |
| `preference.routes.ts` / repository | 透传 map，无 key 白名单 |
| `cloudGroupKey` / `SessionGroupKey.of` | key 推导不变 |
| `groupOrder` / `collapsedGroups` | 按 key 存取，与别名解耦 |
| 嵌入 SDK / 任务列表浮窗 | 不消费分组标题 |
| 管理后台 | 不展示别名 |

---

## 6. 影响面评估

### 6.1 行为变化（用户可感知）

| 场景 | 变化 |
|------|------|
| 飞书/钉钉分组右键 | 出现「重命名」；可改名、可重置 |
| 已有别名的渠道分组 | 刷新后仍显示别名（多端同步一致） |
| 聚焦模式工作区标签 | 显示别名（与标准分组头一致） |
| tooltip | 保持「别名（推导名）」 |
| 未改名用户 | 零变化（fallback 原逻辑） |
| 旧客户端写偏好 | 不再剔除渠道 key；旧客户端若仍带过滤逻辑，只是「读得到但自己不显示」——向后兼容 |

### 6.2 兼容与数据

| 维度 | 评估 |
|------|------|
| 存量数据 | 无需迁移。历史上被 `normalizeAliases` 剔除的渠道别名本就未落库；放开后新别名正常写入 |
| 多端同步 | 同一 `groupAliases` map，行为与 `LOCAL`/`CLOUD` 一致 |
| 版本兼容 | 新后端 + 旧前端：旧前端不显示渠道重命名入口，但偏好读写无害。旧后端 + 新前端：后端仍会洗掉渠道别名，表现为「改完刷新丢失」——**需前后端同版本发布**（单域名部署下通常同批上线） |
| API 契约 | 无变更，不需要改 `mao-cli` 命令参数 |

### 6.3 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 用户把「Coder:告警群」改成无意义名，丢失 Agent/群身份线索 | 低 | tooltip 常驻推导名；「重置名称」一键恢复 |
| 多个飞书私聊分组（不同 Agent）被改成同名，难以区分 | 低 | 属用户自担；key 仍是身份事实源，排序/归属不受影响 |
| 系统桶被改名（若选方案 A）导致「临时工作区」语义丢失 | 中 | **方案 B 保留锁定**；方案 A 需在产品上接受 |
| 前后端规则漂移 | 中 | 两侧注释互指 + 单测锁定同一矩阵；code review 对照表 |
| 飞书群聊 fallback 前后端不一致（前端用路径合成、后端用 groupName） | 低 | **现状已存在**，与本次无关；别名只覆盖显示，tooltip 用前端 `formatFallbackGroupLabel`，不受后端 label 影响 |

---

## 7. 测试计划

### 7.1 单测

**前端** `desktop/src/utils/cloud-project.test.ts`：

- `isGroupRenameable`：`FEISHU_*` / `DINGTALK_*` → `true`；`LOCAL:未设置` / `CLOUD:临时工作区` / 未知 key → `false`（方案 B）
- `resolveGroupLabel`：渠道分组命中别名 / 无别名回落推导名 / 系统桶忽略别名

**后端** `task-panel-preference.service.spec.ts`：

- `normalizeAliases` 不再剔除 `FEISHU_*`/`DINGTALK_*`；仍剔除系统桶与空值、仍截断 50 字符
- `isGroupRenameable` 矩阵与前端一致

### 7.2 手工 / E2E

1. 飞书群聊分组右键 → 重命名 → 预填推导名 → 改名保存 → 标签与聚焦模式标签同步变化
2. tooltip 显示「新名（Agent:飞书群…）」
3. 「重置名称」恢复推导名
4. 刷新页面 / 另一端登录同账号 → 别名仍在
5. 飞书私聊、钉钉私聊/群聊各抽一条
6. 回归：`LOCAL`/`CLOUD` 分组改名行为不变；系统桶右键仍无「重命名」

> E2E 依赖飞书/钉钉种子会话，若 `scripts/e2e-setup.sh` 无渠道种子，则以手工验收为主，单测兜底规则矩阵。

---

## 8. 实施顺序与工作量

| 步骤 | 内容 | 预估 |
|------|------|------|
| 1 | 后端 `isGroupRenameable` + `normalizeAliases` 测试更新 | 0.5h |
| 2 | 前端 `isGroupRenameable` + `resolveGroupLabel` 测试更新 | 0.5h |
| 3 | 文档：`pref.md`、原设计文档旁注、CHANGELOG | 0.5h |
| 4 | 手工验收（飞书/钉钉各场景 + 回归） | 0.5–1h |
| **合计** | | **约 0.5–1 人日** |

无迁移、无契约变更、无 UI 重构；主要成本在双端规则对齐与验收。

---

## 9. 决策点（待确认）

1. **方案 B（推荐）还是方案 A？** 即 `LOCAL:未设置` / `CLOUD:临时工作区` 是否也允许改名。
2. **私聊分组是否一并放开？** 推荐放开（与群聊同一规则）；若担心 Agent 身份语义，可退到方案 C。
3. **发布节奏：** 建议 desktop 前端 + backend 同批上线（单域名部署已合并，通常可同批）；若分批，先前端会出现「改完刷新丢失」，需在 CHANGELOG 注明依赖后端版本。

确认后按 §8 实施即可。
