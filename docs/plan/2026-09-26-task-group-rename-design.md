# 任务分组右键重命名方案

> 状态：设计完成，待实现
> 关联代码：`desktop/src/components/task/TaskIndexPanel.vue`、`desktop/src/stores/session.ts`、`desktop/src/composables/useTaskPanelPrefs.ts`、`desktop/src/utils/cloud-project.ts`、`backend-ts/src/preference/*`、`shared/contracts/src/preference.ts`、`backend-ts/db/migration/V041__add_user_task_panel_preference.sql`

## 1. 背景与目标

任务面板的分组（如 `LOCAL:D:\projects\aiprojects` 显示为 `aiprojects`）目前标题由工作区路径自动推导，用户无法自定义。目标：分组头支持右键菜单「重命名」，用户可给分组起别名，别名持久化并多端同步；支持恢复默认名。

### 非目标

| 不做 | 原因 |
|------|------|
| 重命名真实磁盘目录 / 云端项目 slug | 重命名是纯展示层偏好，触碰文件系统风险不可控 |
| 分组合并、跨分组移动会话 | 独立需求，另行立项 |
| 飞书/钉钉私聊分组（`FEISHU_PRIVATE:` 等）重命名 | 其标签语义是 Agent 名，改名会破坏语义（见 §3.3） |
| 管理后台展示别名 | 别名属个人偏好，不进管理侧 |

## 2. 可行性结论

**可行，且对现有功能无破坏性影响。** 核心依据：

1. **分组身份与显示名天然分离。** 分组 key（`LOCAL:{path}` / `CLOUD:{path}` / `FEISHU_*` …）由 `cloudGroupKey()`（前端）与 `SessionGroupKey.of()`（后端）从 workspace 实时推导，是会话归属、`applyFilter` 过滤、分页、拖拽排序的唯一事实源；显示名是渲染时对 key 的再加工（前端 `formatGroupLabel`，后端 `SessionGroupKey.formatLabel`）。**重命名只加一层"显示名覆盖"，key 不变**，所有按 key 工作的机制零感知。
2. **已有同构持久化先例。** 分组顺序 `groupOrder`、折叠状态 `collapsedGroups` 就是按 groupKey 存在 `user_task_panel_preference`（V041，JSON 列），经 `GET/PUT /v1/user-preferences/task-panel` 多端同步。别名照搬该通道，无新表、无新路由。
3. **UI 交互可直接复用。** 会话行已有右键菜单（`openContextMenu`）与行内联重命名（`editingSessionId`/`editingTitle` + Enter 确认/Esc 取消/失焦提交），分组头照搬即可。

## 3. 详细设计

### 3.1 数据模型：扩展 task-panel 偏好

`user_task_panel_preference` 新增一列（新迁移 `V122__add_group_aliases.sql`，当前最大版本 V121）：

```sql
ALTER TABLE user_task_panel_preference
    ADD COLUMN group_aliases JSON NOT NULL COMMENT '分组 key → 自定义显示名映射' AFTER collapsed_groups;
```

**选择 JSON map 列而非独立表的理由**：与同表两个 JSON 列完全同构；别名天然按用户隔离（主键 user_id）；数量级小（每用户几个分组）；读路径完全复用现有 `findByUserId`。

契约层（`shared/contracts/src/preference.ts`）：

```ts
export interface TaskPanelPreferenceState {
  groupOrder: string[];
  collapsedGroups: string[];
  groupAliases: Record<string, string>;  // 新增
}
```

后端 `preference/types.ts` 的 `UserTaskPanelPreference` 增加 `groupAliases?: string | Record<string, string> | null`，service 的 `get/save` 增加 JSON map 的 `parseStringMap`/`writeStringMap`（复用 `parseStringList` 的容错风格：非 object 或解析失败返回 `{}`，值 trim、截断到 50 字符、剔除空值），`normalize` 时剔除 key 为 `LOCAL:未设置`/`CLOUD:临时工作区`/`FEISHU_PRIVATE:*`/`FEISHU_GROUP:*`/`DINGTALK_*` 的条目（这些分组不允许改名，见 §3.3）。路由层 `TaskPanelPreferenceRequest` 增加 `groupAliases`，缺省按 `{}` 处理（兼容旧客户端不传该字段——save 时不清空已有别名）。

### 3.2 显示优先级链

标签解析收敛为一个纯函数，放 `desktop/src/utils/cloud-project.ts`：

```ts
/** 分组显示名：用户别名 > 路径推导名；LOCAL:未设置/FEISHU_* 等不可改名分组忽略别名。 */
export function resolveGroupLabel(
  key: string,
  aliases: Record<string, string>,
  session?: Pick<Session, 'agentName' | 'title'>
): string {
  if (!isGroupRenameable(key)) return formatCloudGroupLabel(key, session)  // 或既有 LOCAL 处理
  const alias = aliases[key]?.trim()
  return alias ? alias : /* 既有 formatGroupLabel 逻辑 */
}
```

`TaskIndexPanel.vue` 的 `formatGroupLabel` 整体替换为 `resolveGroupLabel`（原函数删除，避免双轨）。别名命中时直接展示，未命中回落到现有推导逻辑——**不设别名的用户看到的行为与今天完全一致**。

### 3.3 哪些分组可改名

| 分组 | 可改名 | 理由 |
|------|--------|------|
| `LOCAL:{path}`（已设置 workspace） | ✅ | 主要诉求场景（如 `aiprojects` → `AI 项目`） |
| `CLOUD:{path}` | ✅ | 同上 |
| `CLOUD:临时工作区` | ❌ | 系统语义桶，改名会让多个会话的归属描述失真 |
| `LOCAL:未设置` | ❌ | 同上 |
| `FEISHU_PRIVATE:*` / `DINGTALK_PRIVATE:*` | ❌ | 标签 = Agent 名，是身份标识而非路径派生 |
| `FEISHU_GROUP:*` / `DINGTALK_GROUP:*` | ❌ | 标签 = `Agent:群名` 合成语义，改别名会破坏组合结构 |

新增导出 `isGroupRenameable(key: string): boolean`（`cloud-project.ts`），右键菜单按它决定是否出现「重命名」项；后端 normalize 同规则过滤（前缀判断保持两侧一致）。

### 3.4 前端交互

**右键菜单**：`group-header` 增加 `@contextmenu.prevent="openGroupContextMenu($event, group)"`。现有会话右键菜单是自绘浮层（`contextMenu` ref + 绝对定位），分组菜单新建独立的 `groupContextMenu` 状态（`{ visible, x, y, key }`），复用同一套定位/关闭逻辑（点击遮罩、Esc、滚动关闭）。菜单项：

- 「重命名」——仅 `isGroupRenameable(key)` 时显示
- 「重置名称」——仅存在别名时显示（等价保存时不带该 key）

**行内编辑**：与既有会话重命名一致——点击「重命名」后 `group-label` 处切换为 `<input>`（`renamingGroupKey`/`renamingValue` ref），Enter 提交、Esc 取消、失焦提交、空值等价于重置。提交后调 store 动作，成功 `ElMessage.success('已重命名')`，失败保持编辑态（沿用会话重命名的错误处理约定）。

**视觉提示**：存在别名的分组在 hover 标题时通过 `title` 原生 tooltip 显示完整推导名（如「AI 项目（aiprojects）」），避免用户忘记别名对应的真实目录。

### 3.5 状态与 store

`useTaskPanelPrefs`（现成多端同步通道）增加：

- state：`groupAliases = ref<Record<string, string>>({})`
- `loadPrefs`：读 `data.groupAliases`，缺省 `{}`
- `renameGroup(key, name)` / `resetGroupAlias(key)`：更新 map + `scheduleSave()`（沿用 300ms 防抖 PUT）
- `persistPrefs`：PUT body 增加 `groupAliases`
- 兜底：未登录（`!getToken()`）时写 localStorage（key `task-group-aliases`），与 `readLegacyOrder` 同风格——LOCAL 分组重命名在未登录态也能用

**与 groupOrder 的一致性陷阱**：`groupOrder` 是用户拖拽后写入的 key 快照，分组 key 不变所以**不需要**迁移；但若未来支持删除分组记录，需同步清理两个 map，实现时在 `renameGroup` 注释中说明。

`session.ts` store 无需改动（`groupMeta.label` 来自服务端且 UI 未消费该字段渲染标题，标题实际渲染走 `groupedSessions` 的 `formatGroupLabel`）。

### 3.6 后端改动清单

1. 迁移 `V122__add_group_aliases.sql`（§3.1）
2. `shared/contracts/src/preference.ts`：`TaskPanelPreferenceState.groupAliases`
3. `preference/types.ts`：`UserTaskPanelPreference.groupAliases`
4. `task-panel-preference.service.ts`：`parseStringMap`/`writeStringMap` + normalize 过滤不可改名 key + 50 字符截断
5. `preference.routes.ts`：请求/VO 增加 `groupAliases`（缺省 `{}`，save 不清空未传字段）
6. 单测：service 层 round-trip（存取、非法 JSON、不可改名 key 过滤、超长截断、旧客户端不传字段不丢数据）；既有 task-panel 偏好用例补 `groupAliases` 断言

### 3.7 前端改动清单

1. `utils/cloud-project.ts`：`isGroupRenameable` + `resolveGroupLabel` + 单测（别名命中/未命中/不可改名分组忽略别名/Windows 路径 key）
2. `composables/useTaskPanelPrefs.ts`：`groupAliases` state + `renameGroup`/`resetGroupAlias` + load/persist 扩展
3. `components/task/TaskIndexPanel.vue`：分组头 `@contextmenu`、`groupContextMenu` 浮层与菜单项、行内编辑 input、`formatGroupLabel` → `resolveGroupLabel`
4. Playwright（`tests/desktop.spec.ts` 或就近文件）：分组头右键出现菜单 → 重命名 → 标题变化 → 刷新后仍生效（E2E 环境有种子会话可依赖）

## 4. 对现有功能的影响评估

| 功能 | 影响 | 说明 |
|------|------|------|
| 会话归属 / 过滤 / 分页 | 无 | key 不变，`applyFilter`、`loadMoreInGroup`、`cloudGroupKey` 均按 key 工作 |
| 分组拖拽排序 / 折叠 | 无 | `groupOrder`/`collapsedGroups` 按 key 存取；别名 map 独立，互不干扰 |
| 飞书 / 钉钉 / 微信分组 | 无 | 不可改名，`formatCloudGroupLabel` 原逻辑不动 |
| 其他端 / 其他用户 | 无 | 别名按 user_id 隔离；未设置别名的端显示推导名（同一账号多端同步后一致） |
| 后端分组预览 API | 不改 | `SessionGroupKey.formatLabel` 返回的 label 仅作兜底，前端展示以本方案为准；服务端不感知别名，避免把个人偏好扩散到公共 API |
| 嵌入 SDK / 会话列表浮窗 | 无 | 未消费分组标题渲染 |

**主要风险**：别名与 workspace 路径无关联校验，用户可能把分组改成无法辨认的名字。缓解：tooltip 展示推导名（§3.4）；重置入口常驻（存在别名时）。

## 5. 实施顺序

1. 后端：契约 + 迁移 + service/routes + 单测（`cd backend-ts && npm test`）
2. 前端：`cloud-project.ts` 纯函数 + 单测 → `useTaskPanelPrefs` → `TaskIndexPanel.vue` 交互（`npx vue-tsc -b` + vitest）
3. E2E：右键重命名用例
4. CHANGELOG `0.0.x` 前端小节 + 同步 `skills/mao-cli` 中任务面板相关文档（如有涉及）
