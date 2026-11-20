# 前端问题审查报告（admin + desktop）

- 审查时间：2026-09-28
- 复核时间：2026-09-28（逐条回读源码复核存在性与修复价值）
- 审查范围：`admin/src/`（管理后台）、`desktop/src/`（桌面 / Web / 安卓共用 UI）
- 审查维度：功能模块、UI 样式、交互逻辑
- 方法：静态源码审查。admin 侧通读公共组件（`api`/`stores/tabs`/`ResponsivePagination`/`FilterPanel`）与高频业务页（系统指令、点踩反馈、MCP、模型、用户、会话、角色权限、调用流水、钉钉机器人、系统设置）；desktop 侧重点核对聊天输入区（停止/发送按钮状态机）、队列面板、设置页表单与移动端适配。关键缺陷均已回读调用链交叉验证（含 `admin/src/api/index.ts` 拦截器与各页分页写法对照）。
- 与历史文档的关系：避开 `2026-09-27-frontend-review-03.md`、`2026-09-22-frontend-review-01.md`、`2026-09-21-frontend-review-01.md` 已修复或已记录条目。
- 与同日 `2026-09-28-frontend-review-01.md` 去重后，正文保留 **9 条**：高 2、中 6、低中 1。移除 2 条重复——「系统设置未保存编辑被 `onActivated` 覆盖」见 01 #10；「点踩反馈每页条数选择器无效」见 01 #8。MCP「每次加载把页码打回第 1 页」（本文 #6）与 01 #21「停用/启用无二次确认、无 try/catch」是同一函数上的不同缺陷，各留一侧。
- 复核结论：初评 13 条逐条回读源码，均真实存在；按复核结论移除 2 条——「Agent 运行中输入框有内容时看不到停止」经确认是设计如此（运行中优先保证排队发送，停止需清空输入后露出），不构成缺陷；「用户管理移动端没有批量启用/禁用入口」修复价值不高（移动端为次要入口，卡片内单用户启停已可用，批量治理属桌面端主场景，单独建设多选 + 浮动操作条性价比低）。其余条目的位置行号已按复核结果校正。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重度 | 位置 |
|---|---|------|------|:---:|------|
| 1 | admin | 个人指令分页总数恒为「当前页条数」，超出一页永远翻不动 | 功能 | 高 | `views/system-commands/SystemCommandListView.vue:404-413` + `api/index.ts:50-58` |
| 2 | admin | 标签页先改状态再 `router.push`，被路由守卫取消后 Tab 高亮/闭合与实际页面脱节 | 交互 | 高 | `stores/tabs.ts:54-77` |
| 3 | admin | 点踩反馈无移动端卡片适配，窄屏 6 列表格挤成一团 | 样式 | 中 | `views/feedback/FeedbackView.vue:56-80` |
| 4 | admin | 钉钉机器人移动端卡片缺少「启用/停用」操作 | 功能 | 中 | `views/dingtalk-bot/DingtalkBotListView.vue:75-79` |
| 5 | admin | 会话列表删除按钮未按注释禁用运行中会话；删空当前页不回退页码 | 交互 | 中 | `views/session/SessionListView.vue:99-105,305-348` |
| 6 | admin | MCP 列表任何一次加载都把页码重置回第 1 页 | 交互 | 中 | `views/mcp/McpServerListView.vue:401-415` |
| 7 | admin | 模型「测试」进行中点击其它行静默无反馈 | 交互 | 中 | `views/model/ModelListView.vue:99-102,461-462` |
| 8 | admin | 调用流水非数字会话 ID 筛选被静默丢弃，用户以为在筛其实没筛 | 功能 | 中 | `views/llm-call/LlmCallView.vue:64-65,293-296` |
| 9 | admin | 角色改名保存后，右侧「权限分配」标题仍是旧名称 | 功能 | 低中 | `views/permission/RolePermissionView.vue:49,243-261,318-336` |

---

# 一、高

## 1. 个人指令分页总数恒为「当前页条数」，超出一页永远翻不动（admin · 功能）

**位置**：`admin/src/views/system-commands/SystemCommandListView.vue:402-414`（`loadActiveTab` 的 personal 分支）；根因在 `admin/src/api/index.ts:50-58` 响应拦截器。

**根因**：axios 响应拦截器成功分支直接 `return response.data`，返回的是 `Result<T>` 信封（`{ code, message, data }`），`headers` 被剥掉。页面却按完整 axios response 解构：

```ts
// api/index.ts:50-58
api.interceptors.response.use((response) => {
  const data = response.data as Result<unknown>
  if (data.code !== 0) { ... }
  return response.data   // ← 无 headers
})

// SystemCommandListView.vue:404-413
const { data, headers } = await api.get('/admin/user-commands', { ... })
const headerTotal = Number(headers?.['x-total-count'])   // 恒为 undefined → NaN
serverTotal.value = Number.isFinite(headerTotal) ? headerTotal : (data || []).length
```

`headers` 恒为 `undefined`，`headerTotal` 恒为 `NaN`，`serverTotal` 永远回退为当前页数组长度。后端确实对该接口设置了 `x-total-count`（`backend-ts/src/command/admin-system-command.routes.ts:136`），缺陷纯在前端拦截器丢响应头，属前后端契约中途断裂。

**触发**：系统指令 → 「个人指令」Tab，且个人指令数量超过一页（默认 pageSize=10/20）。

**影响**：分页器显示「共 20 条 / 1 页」，第二页起的指令永远看不到。对比同页「系统指令」Tab 是全量拉取 + 前端分页，行为也不一致。

**建议**：拦截器在成功分支保留响应头（例如返回 `{ data: result.data, headers: response.headers }`），或后端把 total 放进 `Result.data`（`{ items, total }`）与其它分页接口对齐；页面侧同步改解构。

---

## 2. 标签页先改状态再 `router.push`，被路由守卫取消后 Tab 与页面脱节（admin · 交互）

**位置**：`admin/src/stores/tabs.ts:54-77`（`removeTab` / `setActiveTab`）；触发点 `admin/src/views/permission/RolePermissionView.vue:374-386`（`onBeforeRouteLeave`）。

**根因**：两个方法都是「先改 UI 状态，再导航」，而导航可能被 `onBeforeRouteLeave` 中止：

```ts
// tabs.ts:70-76
function setActiveTab(path: string) {
  activeTabPath.value = path          // 先高亮目标 Tab
  const target = tabs.value.find(t => t.path === path)?.fullPath ?? path
  if (router.currentRoute.value.fullPath !== target) {
    router.push(target)               // 可能被守卫 return false
  }
}

// tabs.ts:58-66
tabs.value.splice(idx, 1)             // 先删标签
...
router.push(neighbor.fullPath)        // 可能被守卫 return false
```

角色权限页有未保存勾选时：

```ts
onBeforeRouteLeave(async () => {
  try {
    await ElMessageBox.confirm('当前角色的权限修改尚未保存，离开后将丢失，确认离开吗？', ...)
    return true
  } catch {
    return false                      // 留在当前页 → push 被中止
  }
})
```

导航被中止时路由不变化，`Layout.vue:136-138` 的 `watch(route)` 不会触发，`activeTabPath` 没有任何回sync机制，脱节状态会一直保留。

**触发**：在角色权限页勾选/取消若干权限（未保存）→ 点击其它 Tab，或关闭当前 Tab → 弹窗选「留在当前页」。

**影响**：
- 点「留在当前页」后，TabBar 已高亮到目标标签，页面却仍在角色权限页；
- 若关闭的是当前标签，标签已从 TabBar 消失，用户却仍停在该页；再点其它标签可能被反复拦截，观感为「标签关不掉 / 点不动」。

**建议**：`setActiveTab` / `removeTab` 改为 `await router.push(...)`，导航成功后再更新 `activeTabPath` / 删除标签；失败（`NavigationFailure`）则回滚或用 `router.currentRoute` 重新同步。

---

# 二、中

## 3. 点踩反馈无移动端卡片适配，窄屏表格挤成一团（admin · 样式）

**位置**：`admin/src/views/feedback/FeedbackView.vue:56-80`。

**根因**：主要列表页（用户 / 会话 / 审计 / 调用流水 / Agent / Skill / MCP / 模型 / 钉钉 / 飞书 / 系统指令 / 定时任务，共 12 处）都有 `isMobile` 分支渲染 `mobile-card-list`，点踩反馈是其中唯一始终用 6 列 `el-table`（时间 / 用户 / 会话 / Agent / 原因 / 消息内容）的列表页。全文件无 `isMobile` / `mobile-card-list`。（角色权限页、用量分析各 Tab 等非标准列表页也无卡片，不纳入对比。）

**触发**：手机或窄窗口打开管理后台 → 点踩反馈。

**影响**：列被压到极窄，消息预览截断，只能横向滚动，无法快速扫读；与全站移动端卡片风格不一致。

**建议**：对齐 `AuditLogView` / `LlmCallView` 的移动卡片模式：头部原因 Tag + 时间，正文用户 / 会话 / 消息预览，会话 ID 可做成跳转。

---

## 4. 钉钉机器人移动端卡片缺少「启用/停用」操作（admin · 功能）

**位置**：`admin/src/views/dingtalk-bot/DingtalkBotListView.vue:75-79`（移动卡片操作区）；对照桌面 `:53-60`、飞书移动卡片 `FeishuBotListView.vue:99-107`。

**根因**：桌面行有「编辑 / 停用(启用) / 重连 / 删除」，飞书机器人移动卡片也有启停按钮，钉钉移动卡片只有「编辑 / 重连 / 删除」：

```vue
<div class="mobile-card-actions" v-if="canWrite">
  <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
  <el-button link :disabled="!row.enabled" @click="handleReconnect(row)">重连</el-button>
  <el-button type="danger" link @click="handleDelete(row)">删除</el-button>
</div>
```

**触发**：手机打开管理后台 → 钉钉机器人列表。

**影响**：手机上无法启停机器人，只能删除重建或回电脑，功能缺失。

**建议**：补上与桌面一致的启停按钮（`@click="handleEnabledChange(row)"`，`:type="row.enabled ? 'warning' : 'success'"`）。

---

## 5. 会话列表删除按钮未禁用运行中会话；删空当前页不回退页码（admin · 交互）

**位置**：`admin/src/views/session/SessionListView.vue:99-105`（删除按钮）、`:305-348`（`canDelete` / `handleDelete`）。

**根因**：注释声称「提前禁用并说明」，但按钮没挂禁用：

```vue
<el-button v-if="canWrite" type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
```

```ts
/** 运行中的会话不允许删除（后端拒绝），提前禁用并说明。 */
function canDelete(row: any): boolean { return !RUNNING_DELETE_PHASES.has(row?.phase) }
...
await api.delete(`/admin/sessions/${row.id}`)
ElMessage.success('已删除')
fetchSessions()   // 无页码回退
```

**影响**：
1. 运行中会话仍可点删除，点了才弹 `ElMessage.warning`（`:330-333`，后端 `session.service.ts:489` 同样拒绝），属于「先放行再拦截」，与注释描述不符；
2. 若删除的是最后一页最后一条，用户停留在空页。Agent / 模型列表都有 `maxPage` 回退逻辑（`AgentListView.vue:304-307`、`ModelListView.vue:484-486`），此处缺失。

**建议**：删除按钮加 `:disabled="!canDelete(row)"` + `el-tooltip` 说明；删除成功后按 `total-1` 计算 `maxPage` 并夹紧 `currentPage`。

---

## 6. MCP 列表任何一次加载都把页码重置回第 1 页（admin · 交互）

**位置**：`admin/src/views/mcp/McpServerListView.vue:401-415`（`loadData`）。

**根因**：`loadData()` 成功后无条件 `currentPage.value = 1`：

```ts
const { data } = await api.get('/mcp-servers', { ... })
if (seq !== loadDataSeq) return
servers.value = data || []
// 数据集变化后页码可能越界，回到第一页
currentPage.value = 1   // 所有调用方共用，含 toggleStatus(:528-532)/handleDelete(:535-538)
```

**触发**：在第 3 页点「停用/启用/删除」任一操作。

**影响**：刷新后直接跳回第 1 页，丢失浏览位置。关键字防抖搜索（`:419-425`）与 `statusFilter` 的 `@change`（`:27`）重置页码是合理的，但状态切换 / 删除不该回到第 1 页。

**建议**：把「重置页码」放到筛选变更回调里；`toggleStatus` / `handleDelete` 后仅在页码越界时夹紧（`Math.min(currentPage, maxPage)`）。

**去重**：停用/启用缺少二次确认、且失败时没有 `try/catch`，见 `2026-09-28-frontend-review-01.md` #21，不在本条重复。

---

## 7. 模型「测试」进行中点击其它行静默无反馈（admin · 交互）

**位置**：`admin/src/views/model/ModelListView.vue:99-102`（按钮）、`:461-462`（`handleTest`）。

**根因**：`testingId` 是全局互斥，但按钮只禁用当前行：

```vue
:loading="testingId === row.id"
:disabled="testingId === row.id"   <!-- 只禁自己 -->
@click="handleTest(row)"
```

```ts
async function handleTest(row: any) {
  if (testingId.value != null) return   // 静默丢弃
```

**触发**：A 行测试进行中，点 B 行「测试」。

**影响**：按钮无 loading、无禁用、无提示，看起来像「按钮坏了」。

**建议**：任一测试进行中禁用全部测试按钮（`:disabled="testingId != null"`），或点击时 `ElMessage.info('已有测试进行中')`；更好的做法是允许并发测试、按行维护 `testingIds: Set`。

---

## 8. 调用流水非数字会话 ID 筛选被静默丢弃（admin · 功能）

**位置**：`admin/src/views/llm-call/LlmCallView.vue:64-65`（会话 ID 输入框）、`:293-296`（`buildFilterParams`）。

**根因**：「会话 ID」是自由文本输入，`buildFilterParams` 里数值校验失败就直接不传 `sessionId`：

```ts
if (filters.sessionId) {
  const sessionId = Number(filters.sessionId)
  if (Number.isFinite(sessionId)) params.sessionId = sessionId   // 不合法则静默省略
}
```

Agent ID 筛选（`:289-292`）存在完全相同的静默丢弃模式，修复时应一并处理。

**触发**：会话 ID 输入 `abc` / `12a` 后点查询。

**影响**：请求变成无筛选，列表显示全部数据且无任何提示，用户误以为筛选生效。

**建议**：输入框改 `type="number"` / 数字校验规则，非法时标红并阻止查询；或在丢弃时 `ElMessage.warning('会话 ID 需为数字')`。

---

# 三、低中

## 9. 角色改名保存后，右侧「权限分配」标题仍是旧名称（admin · 功能）

**位置**：`admin/src/views/permission/RolePermissionView.vue:49`（右侧标题 `{{ currentRole.name }}`）、`:243-261`（`fetchAll`）、`:318-336`（`saveRole`）。

**根因**：`saveRole` 成功后 `fetchAll()` 刷新 `roles` 数组，但 `currentRole` 仍指向旧对象；`fetchAll` 只在 `currentRole` 为空时才 `selectRole(roles[0])`：

```ts
async function saveRole() {
  ...
  await fetchAll()   // 只在 currentRole 为空时才 selectRole(roles[0])
}
// fetchAll:
if (!currentRole.value && roles.value.length > 0) {
  selectRole(roles.value[0])
}
```

**触发**：选中角色 → 改名 → 点保存。

**影响**：右侧标题显示改名前的旧名，需手动再点一次左侧行才更新，易造成「改了没生效」的错觉。

**建议**：`saveRole` 成功后 `const updated = roles.value.find(r => r.id === roleForm.id); if (updated) selectRole(updated)`（注意保留 `dirtyPermissions` 语义）；或 `fetchAll` 里按 id 回写 `currentRole`。

---

## 附：观察项（未计入正文）

| 位置 | 说明 |
|---|---|
| `desktop/src/views/settings/ProfileView.vue:56-58` | 提示文案写「LDAP / 飞书账号的显示名称与邮箱由系统维护」，但 `authSource` 还含 ECP / COMPANY_SSO（`backend-ts/src/auth/external-provider.ts:9`），文案不完整 |
| `desktop/src/components/chat/QueuePanel.vue:76-87` | 队列 ≥6 条默认折叠时，首条只展示摘要、操作按钮全隐藏，需展开才能编辑/删除；可接受的紧凑设计，但首条操作可达性略差 |
| `admin/src/components/FilterPanel.vue:15` | 移动端「更多筛选」展开后，切换页面/重置不会自动收起，筛选区偏长 |
| `admin/src/style.css` / 多处 `views/**` | admin 整站仅浅色主题，硬编码 `#d2d2d7`/`#606266` 等散落各页；若未来做暗色主题成本较高（当前无暗色需求则可暂不处理） |

---

## 优先级建议

1. **#1（个人指令分页不可达）** 与 **#2（Tab 状态脱节）** 优先：前者是数据不可达，后者是界面状态错乱。
2. **#4 / #5 / #6**（钉钉移动端启停、会话删除、MCP 页码）属高频操作路径上的功能/交互缺陷，建议同批清理。
3. **#3 / #7 / #8** 提升移动端与筛选体验。
4. **#9** 与观察项可随迭代清理。
5. 已并入 01 的两条（系统设置未保存覆盖、点踩反馈每页条数）按 01 #10、#8 排期，不在本文重复。
