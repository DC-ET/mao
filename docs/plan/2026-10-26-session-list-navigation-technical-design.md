# 会话列表与长会话导航技术方案

> 版本：v1.1（2026-10-26 评审后修订；v1.0 评审结论见 §11）
> 状态：已评审并定稿修订（§0 决策 1/2 已于 2026-10-26 按评审结论调整定稿；提案见 [../proposals/2026-10-25-session-list-navigation.md](../proposals/2026-10-25-session-list-navigation.md)，第十六批）
> 一句话：接通后端已就绪的标题过滤，补批量归档与长会话轮次目录 / 只看回复 / 回到顶部；收藏（favorite）与置顶（pin）两个半截子功能整体移除。功能改动收敛在 desktop 层，另加一次拆除迁移与 mao-cli / agent-cli 的同步清理。

## 0. 决策记录（2026-10-26 定稿；1/2 为评审后修订）

| # | 决策点 | 定稿 | 说明 |
|---|--------|------|------|
| 1 | favorite 的归宿 | **整体移除**（v1.1 修订） | v1.0 拟「拆除」但范围只列后端；评审发现 mao-cli `session favorite` 命令与 agent-cli 类型声明也在引用（§11.1-1）。按需求方定稿：端点、服务方法、VO 字段、列（V173）、mao-cli 命令与文档、agent-cli 类型全部移除，半截子功能不留悬案。拆除范围见 §5.1.1 |
| 2 | pin 的归宿 | **取消并整体移除**（v1.1 新增） | v1.0 拟「接通 desktop」；评审发现置顶排序与「活跃优先」语义冲突、unpin 有 `updated_at` 副作用、语义系于 focusSort 档位（§11.1-2/3），修补成本高于价值。按需求方定稿：取消置顶功能，端点、排序键、列、mao-cli `session pin` 命令、agent-cli `ls` 置顶列全部移除；排序回退为「活跃相位 > 更新时间」。拆除范围见 §5.1.2 |
| 3 | 轮次目录入口 | **右侧浮动把手** | 回访高频动作一键直达；小屏降级隐藏；把手放 `.messages` 定位容器内（需先补 `position: relative`，见 §5.4），防 0.0.337 遮罩定位问题复现 |
| 4 | 多选批量范围 | **仅标准模式** | 聚焦模式是「活跃平铺」视角，归档目标本就在标准视图；双模式改动面翻倍 |
| 5 | 「只看回复」保留折叠摘要行 | **保留** | 「已执行 N 个步骤」行保留（时间感与轮次边界），只隐藏工具卡片与思考块 |
| 6 | 过滤 keyword 持久化 | **不持久化** | 内存态，刷新即清；与全局搜索弹窗的一次性语义一致 |
| 7 | 轮次目录深历史覆盖 | **只覆盖已加载轮次** | 目录 = 已加载窗口索引；深历史靠上滑分页补齐后自然更新；不引入 aroundMessageId 双路径 |
| 8 | 批量归档 API 形态 | **前端循环调既有单条端点** | 单实例一次归档量级 < 50，串行无感；不新增批量端点 |

## 1. 需求背景

提案 §1 已论证。代码侧事实已在本方案定稿前逐条核实（以下行号均为 2026-10-26 实测）：

**三个「后端已就绪、前端未接」的半截子功能：一个接上、两个移除**

- 标题过滤（接上）：`GET /v1/sessions/groups` 已透出 `keyword`（`routes.ts:190` → `session.service.ts:391`，`title LIKE`）；`GET /v1/sessions?groupKey=` 同样支持；desktop `fetchSessions` / `loadMoreInGroup` 均未传该参数。全仓无 zod / validator，query 参数不会被 schema 剥掉；空串 keyword 服务端自然忽略。
- 置顶（取消并移除，决策 2）：`PUT /v1/sessions/:id/pin`（`routes.ts:331`）+ `SessionService.togglePin` + mao-cli `session pin` + agent-cli `ls` 置顶列（`agent-cli/src/commands/ls.ts:33`）整体拆除；desktop 侧本就零调用。
- 收藏（移除，决策 1）：`PUT /v1/sessions/:id/favorite`（`routes.ts:338`）+ mao-cli `session favorite`（`skills/mao-cli/lib/commands/session.js:182-184`）+ agent-cli 类型声明整体拆除；desktop / admin 侧零调用。

**两个真缺口**

- 无批量操作：`TaskIndexPanel` 只有单条归档（右键菜单 `TaskContextMenu.vue:20`）+ 已归档区恢复。
- 长会话无导航：`ChatRoundList.vue` 历史轮折叠为「已执行 N 个步骤，任务耗时 X」；`ChatPanel.vue:71` 只有「回到最新」（锚定历史后出现），无回到顶部、无轮次目录、无只看回复。

**可复用地基**（本方案「零后端功能改动、低侵入」的根据）

- 排序口径移除 pin 后三处统一为「活跃 > 时间」：`listSessionsByGroup` 的 `活跃相位 → updated_at`（`session.service.ts:335`，`ACTIVE_PHASE_SQL_LIST` 含 CANCELLING）、分组预览 `compareSessions`（`util/session-group-key.ts`，同为活跃 → 时间，有 `session-group-order.bugcheck.spec.ts` 护栏，随决策 2 改写）、`listSessions`（`:275`）移除 pin 键后为 `updated_at DESC, id DESC`。
- 全局搜索定位链路完整：`useMessageLocate.ts`（`flashId` + `scrollElementToMessage` + `expandRoundContainingMessage`）+ `useMessageRounds.ts` 的轮次模型（`MessageRound`：userMessage / finalReply / stepCount / durationText）。
- 标准列表的 WS 刷新时机干净：标准列表**不**被 WS 静默重拉（仅聚焦列表在重连时 `fetchFocusSessions(true)`，`useStreamWS.ts:369`）；标准列表刷新只发生在 onMounted（`TaskView.vue:1235`）、手动刷新按钮、恢复归档后。

## 2. 需求描述

### 2.1 目标

1. **P1 列表收口**：列表顶部过滤框（防抖调既有 `keyword` 参数，聚焦 / 标准双模式生效）。
2. **P2 批量归档**：标准模式多选 → 底部操作条批量归档（二次确认，成功数提示，失败保留原位）；单条行为零变化。
3. **P3 长会话导航**：轮次目录（已加载轮次索引，点击定位 + 闪烁）；「只看回复」开关（隐藏工具 / 思考，保留对话主干与折叠摘要行）；回到顶部按钮（与「回到最新」对称）。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|------|----|------|
| 后端 | favorite 与 pin 整体移除（删端点 / 服务方法 / VO 字段 / 排序键 / 两列，V173 一次迁移，见 §5.1.1/§5.1.2）；其余零改动（keyword / 归档端点与排序全部既有） | 不加批量端点、不动 keyword 与归档相关逻辑 |
| CLI | mao-cli 删 `session favorite` / `session pin` 两命令与文档；agent-cli 删两字段与 `ls` 置顶列 | 不改两 CLI 其他命令 |
| desktop 列表 | 标准模式全量交互 + 聚焦模式过滤 | 聚焦模式不开多选（决策 4）；标签 / 文件夹体系不做 |
| 过滤 | keyword 标题过滤，服务端口径 | 不持久化（决策 6）；归档区不过滤（固定 status=ARCHIVED） |
| 导航 | 已加载轮次目录 + 只看回复 + 回到顶部 | 深历史按需取页（决策 7）；执行中轮不进目录；分享页行为零变化 |
| 移动端 | 过滤框折叠为图标、长按兼容既有菜单、目录把手小屏降级 | 不引入新手势、不改布局（安卓壳约束） |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| keyword 收敛点 | `stores/session/list.ts` 单一 `listKeyword` state | 三条 fetch 路径（fetchSessions / loadMoreInGroup / fetchFocusSessions）与 WS 重连路径统一读同一状态，防「过滤被静默清掉」（C2） |
| 批量归档 | store 新增 `archiveSessions(ids)`：API 串行循环 + 单次本地迁移 + 归档区一次静默刷新 | 复用既有归档 / 恢复全链路语义；避免循环调用单条函数带来的 N 次静默重拉（C3） |
| 轮次目录数据源 | `useMessageRounds` 的 `messageRounds` 派生（纯 computed，零新增数据请求） | 目录即已加载窗口索引（决策 7），与定位链路同源 |
| 目录定位 | 复用 `flash()` + `scrollElementToMessage` + `expandRoundContainingMessage`，不新造滚动 | 与全局搜索跳转完全同构，回归面最小（`flash()` 为需补的薄封装，见 §5.4） |
| 「只看回复」 | ChatRoundList 新增 prop `replyOnly`，渲染层条件过滤 | 不触碰消息数据与 store；`activeRound` 不参与过滤（执行中须看进度） |
| 组件通信 | 沿用 TaskIndexPanel → 子组件的 prop + callback 模式，新增最小 prop 集 | 与既有 30+ prop 的列表组件风格一致，不改既有签名 |
| 图标 | 过滤 / 多选 / 目录 / 回到顶部 用 `desktop/src/main.ts` 已注册图标，缺失才补一行 | 保持 0.0.345 起「按需注册」口径不回归（C10） |

## 4. 总体架构

```
┌─────────────────────── 后端（favorite / pin 整体移除） ──────────────────────┐
│ PUT /v1/sessions/:id/favorite     ★移除（§5.1.1）                            │
│ PUT /v1/sessions/:id/pin          ★移除（§5.1.2），排序键回退「活跃 > 时间」 │
│ GET /sessions/groups?keyword=     标题 LIKE，预览排序 活跃 → updated_at      │
│ GET /sessions?groupKey=&keyword=  分页排序同口径                            │
│ GET /sessions?status=ACTIVE       聚焦模式全量（列表 = 活跃平铺源）          │
│ V173                              DROP COLUMN is_favorite, is_pinned        │
└───────────────────────────────────────────────────────────────────────────┘
                 │ 其余全部既有端点；desktop store 只是开始传 keyword
                 ▼
┌────────────────────────── stores/session/list.ts ─────────────────────────┐
│ listKeyword: ref('')  ── 三条 fetch 路径统一读取（fetchSessions /           │
│                            loadMoreInGroup / fetchFocusSessions）          │
│ archiveSessions(ids) ── 过滤运行中 → 逐条 PUT → 单次投影迁移 + 一次刷新     │
└───────────────────────────────────────────────────────────────────────────┘
        │                                  │
        ▼                                  ▼
┌ TaskIndexPanel ┐ 过滤框(折叠图标)      ┌ ChatPanel / ChatRoundList ┐
│ ├ 标准模式     │ 多选操作条             │ ├ 轮次目录（浮动把手）    │
│ ├ 聚焦模式     │                       │ ├ 只看回复开关            │
│ └ 已归档区     │                       │ └ 回到顶部（与回到最新对称）│
└────────────────┘                        └──────────────────────────┘
```

数据流原则（与既有架构一致）：

- **实体缓存是唯一真相源**（`upsertSessionEntity` 唯一写入口）；批量归档只改 `status` 字段，不碰 `phase / running / unread`，不与 WS 实时相位逻辑交叉。
- **投影只存 ID**：批量归档 = 一次 `standardSessionIds / focusSessionIds` 过滤 + 归档区头部插入，组件经 ID 读实体，天然一致。

## 5. 详设

### 5.1 后端（除 favorite / pin 移除外零改动，评审可逐条核对）

| 能力 | 既有位置 | 满足度 |
|---|---|---|
| keyword 标题过滤 | `session.service.ts:391`（`baseSessionListQuery`），groups / 分页 / 全量列表三入口均已透出 | 前端开始传参数即可；LIKE 无 ESCAPE（`%`/`_` 通配符）记为已知（C15） |
| 排序一致性 | `session.service.ts:335`（分页）/ `util/session-group-key.ts compareSessions`（预览，经 `service.ts:297` 内存重排）+ bugcheck 护栏 | 移除 pin 后两处统一「活跃 > 时间」，护栏随决策 2 改写（§5.1.2） |
| VO 透传 | `session-vo.ts` 三条读路径均经 `enrichSessions → toSessionVO` | 无需新增字段（决策 2 后无 isPinned/isFavorite） |
| 单条归档 / 恢复 | `routes.ts` archive / unarchive + store 既有全链路 | 批量循环复用 |

desktop 侧无需新增类型字段（决策 2 后 VO 不再有 `isPinned` / `isFavorite`，`normalizeSession` 的 spread 语义无遗漏可透传）；`stores/session/types.ts:146` 侧栏排序注释（「活跃任务优先 → 置顶 → updated_at」）随决策 2 同步改为「活跃任务优先 → updated_at」（纯注释）。

### 5.1.1 favorite 整体移除（决策 1）

「后端已就绪、前端零调用」的半截子功能，按需求方决定拆除——端点自上线起 desktop / admin 零调用，但 mao-cli 与 agent-cli 有引用，一并清理，不留悬案。

- 删除 `PUT /v1/sessions/:id/favorite`（`session.routes.ts:338-343`）与 `SessionService.toggleFavorite`（`session.service.ts:1011-1015`）。
- `session-vo.ts:31/193` 的 `isFavorite` 映射、`types.ts:11` 的字段声明、`session.repository.ts:248/288` 的读写引用、`session.service.ts:137/671` 两处新建默认值一并移除。
- mao-cli：删 `lib/commands/session.js:182-187` 的 `favorite` case 与 `:25` 帮助行；`business_process.md:55`、`reference/session.md`（表格行 / 节标题 / 用途行 / 示例共 4 处）同步删。用户可见的 CLI 能力变更，CHANGELOG 记 mao-cli 小节（AGENTS.md 要求）。
- agent-cli：`src/rest/types.ts:47` 的 `isFavorite` 字段声明删除。
- 引用 `isFavorite` 的既有 spec 同步清理：`session-extra.spec.ts:99/107`（夹具 + `toggleFavorite` 调用）、`session.routes.spec.ts:32/66/176`（夹具 + service mock + HTTP 打端点）。
- 迁移见 §5.1.2 末尾（与 pin 同批一次 V173）。

### 5.1.2 pin 取消与整体移除（决策 2，v1.1 新增）

v1.0 计划「接通 desktop」，评审后按需求方决定取消：置顶排序与「活跃优先」语义冲突（运行中任务应优先于置顶的空闲任务，§11.1-3），unpin 还会 bump `updated_at` 造成「取消置顶上浮 + 相对时间跳刚刚」（§11.1-2），语义兑现依赖 focusSort 前端重排、修补面大于价值。整体移除，排序回退「活跃相位 > 更新时间」：

- 删除 `PUT /v1/sessions/:id/pin`（`session.routes.ts:331-336`）与 `SessionService.togglePin`（`session.service.ts:1005-1009`）。
- 排序键移除：`listSessions` 的 `ORDER BY is_pinned DESC, updated_at DESC, id DESC`（`:275`）→ `ORDER BY updated_at DESC, id DESC`；`listSessionsByGroup`（`:335`）去掉 `is_pinned DESC,`；`compareSessions`（`util/session-group-key.ts:258-259`）去掉置顶次级键。三处口径统一为「活跃相位 > 更新时间 > id」。
- 字段移除：`session-vo.ts:30/192` 的 `isPinned`、`types.ts:10` 的字段声明、`session.repository.ts:247/287` 的读写引用、`session.service.ts:136/670` 两处新建默认值。
- mao-cli：删 `session pin` 命令（`session.js:176-181` case + `:24` 帮助行）+ `business_process.md:55` + `reference/session.md`（表格行 / 节标题 / 用途行 / 示例共 4 处）。
- agent-cli：`src/rest/types.ts:46` 字段删除；`src/commands/ls.ts:33` 去掉 `ls` 输出的置顶列（`formatRow` 的 `pin` 前缀字符与随之的对齐调整）。
- specs：`session-extra.spec.ts`（夹具 + `togglePin` 调用 :106）、`session.routes.spec.ts:65/197`（service mock + 断言）、`session-group-order.bugcheck.spec.ts` **改写**为「活跃 > 时间」断言（去 pin 夹具）——排序护栏不丢，只是口径随决策 2 收窄。
- desktop：无功能代码可删（本就零调用）；`stores/session/types.ts:146` 注释口径同步（见 §5.1）。
- 迁移 `V173__drop_session_favorite_and_pin.sql`：`ALTER TABLE session DROP COLUMN is_favorite, DROP COLUMN is_pinned`（当前最新 V172；两列自 V001 创建后无迁移触碰，按仓库「不考虑存量兼容」约定直接 drop，不做条件 DDL）。
- 拆除与本方案其余部分无耦合，可独立成一个前置提交先行合入，再上前端三阶段。

### 5.2 store 层（`desktop/src/stores/session/list.ts`）

```ts
// 过滤 keyword：单一状态源，三条 fetch 路径与 WS 重连路径统一读取
const listKeyword = ref('')
function setListKeyword(kw: string) { listKeyword.value = kw.trim() }
```

- `fetchSessions(silent)`：`api.get('/sessions/groups', { params: { previewLimit: DEFAULT_GROUP_PREVIEW, keyword: listKeyword.value || undefined } })`——空串不传，保持与现状字节一致（axios 默认序列化丢弃 undefined，已实测确认）。
- `loadMoreInGroup(key)`：params 增补同一 `keyword`。**offset 口径不变**（仍以 `meta.loadedCount` = 服务端已返回条数为准）——服务端按同一 keyword 分页，本地 offset 与服务端窗口天然自洽（C1）。
- `fetchFocusSessions(silent)`：params 增补同一 `keyword`（`status=ACTIVE` 分支同样走 `baseSessionListQuery`；该接口响应是裸数组，勿误用 `.items` 读取）；WS 重连静默重拉（`useStreamWS.ts:369`，另 `TaskIndexPanel.vue:299/1086` 归档恢复与手动刷新也会拉）因此自动一致，过滤不会被悄悄清掉（C2）。
- `fetchArchivedSessions`：**不传 keyword**（归档区固定 `status=ARCHIVED`，语义不参与标题过滤）。

```ts
// 批量归档：过滤运行中 → 串行 PUT → 单次本地迁移 → 归档区一次静默刷新（C3/C4）
async function archiveSessions(ids: string[]): Promise<{ archived: number; skipped: number }> {
  const targets = ids.filter(id => {
    const s = sessionEntities.value.get(id)
    return s != null && s.status !== 'ARCHIVED' && !ACTIVE_PHASES.has(s.phase)
  })
  const skipped = ids.length - targets.length
  const succeeded: string[] = []
  for (const id of targets) {
    if (archivingIds.value.has(id)) continue                 // 与单条归档共用并发锁
    archivingIds.value = new Set(archivingIds.value).add(id)
    try {
      await api.put(`/sessions/${id}/archive`)
      const entity = sessionEntities.value.get(id)
      if (entity) {
        upsertSessionEntity({ ...entity, status: 'ARCHIVED' })
        bumpGroupMetaForSession(entity, -1)                  // 组计数逐条减，同单条口径
      }
      succeeded.push(id)
    } catch { /* 单条失败：保留原位（不预移除原则） */ }
    finally {
      const next = new Set(archivingIds.value); next.delete(id)
      archivingIds.value = next
    }
  }
  if (succeeded.length > 0) {
    const done = new Set(succeeded)
    standardSessionIds.value = standardSessionIds.value.filter(x => !done.has(x))
    focusSessionIds.value = focusSessionIds.value.filter(x => !done.has(x))
    archivedSessionIds.value = [...succeeded, ...archivedSessionIds.value]
    if (archivedLoaded.value) await fetchArchivedSessions(true)   // 一次，不是 N 次
  }
  return { archived: succeeded.length, skipped }
}
```

> 评审补充（§11.2-1）：`bumpGroupMetaForSession` 只减 `total` 不减 `loadedCount`（`list.ts:231-234`）——组内已加载窗口归档后，下次 `loadMoreInGroup` 的 offset 以服务端新条数为准，会跳过对应数量的会话（单条归档既有缺陷，批量放大）。建议本方案顺带修正（归档成功时同步 `loadedCount - 1`），或记为已知限制（C5）。另 `skipped` 计数不含 `archivingIds` 锁跳过的 id（锁跳过者既不计 archived 也不计 skipped），toast 口径需明示（C14）。

`utils/focusSort.ts` 不参与本方案——决策 2 后无置顶级，该文件零改动。

### 5.3 列表交互（P1 / P2）

**过滤框**（`TaskIndexPanel.vue` `panel-header`）

- `header-actions` 左侧加折叠态放大镜按钮（Search 图标已注册），点击展开为输入框（再点外部 / Esc 收起）；输入 300ms 防抖 → `setListKeyword` → `fetchSessions()`（非 silent，让 loading 反馈）；聚焦模式下 `loadFocus()`。
- 过滤激活时输入框显示清空叉；底部已归档区**不**随过滤变化（文案不变）。
- 空结果：分组列表渲染既有空态（复用分组空态样式，文案「没有匹配的任务」）。
- 窄屏：过滤框折叠为图标即可；`header-actions` 不受 `showItemActions` 门控（永远渲染），但面板可拖至 120px 最小宽，第 4 个按钮在安卓 WebView 下会拥挤，实现时控制图标按钮尺寸。

**多选批量归档**（仅标准模式，决策 4）

- `TaskIndexPanel` 加选择模式 state（`selecting: ref(false)`）；标准模式 `header-actions` 加「多选」入口——**不放分组头部**：`group-header-actions` 被 `showItemActions` 门控（面板 <200px 整体隐藏），窄屏 / 安卓 WebView 会看不到。
- 选择态：行首替换相位点为复选框（点击行 = 切换勾选而非打开会话）；底部固定操作条「已选 N · 归档 · 取消」（挂在 `.panel-content` 滚动区之外，避开 `.resize-handle`）。
- 运行中（`ACTIVE_PHASES`，含 WAITING_APPROVAL / CANCELLING / RESUMING）/ 已归档行不可勾选（复选框禁用 + tooltip）。注意与单条归档的语义差异：单条对同集合是「确认后可归档」（`TaskIndexPanel.vue:519-536` 弹窗），批量静默跳过——文案明示（C14）。
- 确认用既有 `ElMessageBox.confirm` 口径 → `archiveSessions` → 结果 toast「已归档 N 个，M 个跳过」；勾选态清空，退出选择模式。
- 深链注入兼容：选择模式下不做注入行的特殊处理（注入仅发生在导航路径，与选择模式互斥出现概率极低；若发生，注入行默认不勾选）。

### 5.4 长会话导航（P3）

**轮次目录**

- 新组件 `components/chat/RoundDirectory.vue`：数据 = `useMessageRounds` 的 `messageRounds`（`ChatRoundList` 已有同源 computed；目录组件自行调用 composable 或由 `ChatPanel` 传入，二选一，实现时按依赖方向定——推荐 ChatPanel 传入，避免双实例双份 computed）。
- 每行：轮次序号 + 用户消息摘要（复用 `forkLabelOf` 同款剥离：`stripInternalMarkers(userVisibleText(...))` 截 12-16 字）+ 相对时间 + `stepCount/durationText`（有则显示）。
- 只列 `historyRounds`（执行中轮不列——流式期间目录高频变化且当前轮就在屏幕底部，目录无意义）。注意空闲态 `historyRounds` 含刚完成的最后一轮（期望行为）。
- 点击：`expandRoundContainingMessage(messageRounds, roundsExpanded, round.userMessage.id)`（在 `useMessageRounds.ts:176-189`）→ `flash(round.userMessage.id)` → `scrollElementToMessage(container, id)`（在 `components/search/search-highlight.ts:72-81`，`msg-${id}` 选择器契约）。**目标必然已加载**（目录只索引已加载轮次，决策 7），不引入 `aroundMessageId` 取页路径。**评审补充（§11.2-5）**：`flashId` 的 2s 自清定时器封装在 `useMessageLocate.ts:32/38-41` 闭包内、对外只暴露只读 `flashId`——需给 `useMessageLocate` 暴露 `flash(messageId)` 薄方法（内部已含 `onLocate → pauseFollow` 与 nextTick 滚动），勿在目录组件里重造定时器。
- 入口：聊天区右缘浮动把手（`position: absolute` 贴 `.messages` 容器内，避免遮罩层曾出现的定位问题——`0.0.337` 修复教训：祖先链无定位祖先时 `absolute` 回落视口）。**评审核实（§11.2-3）：`.messages`（`ChatPanel.vue:955-960`）及其整条祖先链（`.chat-panel` / `CenterTabContainer` / `TaskView`）当前均无 `position` 声明——必须先给 `.messages` 补 `position: relative`（或把手改 `sticky`），否则必然复现 0.0.337 类回落视口 bug。** 小屏（`isMobileViewport`，注意该判断目前是 ChatPanel 本地 ref、无共享 composable 可复用）降级：把手隐藏，目录入口移到检查器工具栏按钮（或暂不提供，决策 3 的延伸，实现时定）。

**只看回复**

- `ChatRoundList` 新增 prop `replyOnly: boolean`（默认 false）。**评审核实（§11.2-4）：ChatPanel 会话态不存在「与队列面板同级的一行工具」**——QueuePanel 仅队列非空时渲染且是队列列面，唯一工具行是底部 ChatInput 内的 ChatInputToolbar。开关需新建表面：推荐把 `.history-anchor-bar` 泛化成常驻 sticky 顶栏（开关 + 回到顶部同住，见下文「回到顶部」），或新增一条 sticky 行——属方案未计入的 UI 工作量。图标 + tooltip「只看回复」。
- 过滤语义（渲染层条件渲染，零数据改动）：
  - `replyOnly` 为真时：折叠轮的 `displaySteps` 不渲染（折叠摘要行**保留**，决策 5）——实现为 `.steps-detail` 的 `v-if`（`ChatRoundList.vue:33`）加 `&& !replyOnly`；展开轮隐藏 steps-detail 后即只剩 `userMessage` + `finalReply`；`CompactionMarker` / `FileChangePanel` 均在本轮固定位置、不受影响，天然保留。**评审补充（§11.2-6）两处边缘**：(a) 无步骤轮的 finalReply 思考块走 `hideThinking` prop（`:100`，主聊天为 false），replyOnly 为真时应随传 true（折叠轮 finalReply 已硬编码 true，`:71`，无需动）；(b) finalReply 气泡内嵌的 toolCalls（轮次以工具段结尾时）**无法用现有 prop 隐藏**（MessageBubble 只有 `hideThinking / hideFileChanges / hideSubagentProcess`），需新增 MessageBubble prop 或 CSS 方案，否则该边缘路径会漏出工具卡片。
  - `activeRound` 与流式过程**完全不参与**过滤——执行中必须看到进度（`activeRoundMsgs` 把步骤与回复拍平，本也无干净切分）；开关只影响历史区。
  - 分享页（`hideThinking` 已 true）行为不变：开关默认关，分享页不传 `replyOnly`。
- 与滚动控制器的交互：切换时调 `pauseFollow()` 显式暂停（防内容塌陷后 ResizeObserver 触发 `scheduleFollow` 抢位置）；`useChatScroll.handleScroll` 已有 `contentShrank` 分支（内容塌陷视为布局产物，不上滑判定，`useChatScroll.ts:245-252`），天然兼容——切换不会误关 / 误开跟随，用例回归此路径（C8）。

**回到顶部**

- **可见性条件（评审补充，§11.2-2 / C6）**：`historyAnchored` 实际**只在 aroundMessageId 定位时置位**（`useMessageLocate.ts:71`），普通上滑分页（`useChat.ts:232-259`）不置位——即「回到最新」条只在全局搜索跳转后出现。若回到顶部寄生同一横条，常规长会话阅读时不可见，失去意义。建议按钮独立可见条件：`useChatScroll` 的 `userScrolledUp`（或容器 `scrollTop > 阈值`），并把该横条改为常驻（或新增贴顶镜像条）。
- 点击行为：`container.scrollTop = 0` 必须走 `useChatScroll` 新增的 `scrollToTop()` 薄封装（镜像 `scrollToMessage`（`:292-304`）的 `programmatic` 记账）——`handleScroll` 对 programmatic 早退（`:239`），直接操作 DOM 会绕开该保护，误触 `:262` 的上滑分页或误判上滑。

## 6. 改动面

| 层 | 文件 | 改动 |
|---|---|---|
| backend-ts | `session.routes.ts` / `session.service.ts` / `session-vo.ts` / `types.ts` / `session.repository.ts` / `util/session-group-key.ts` + 三个 spec + `db/migration/V173__drop_session_favorite_and_pin.sql` | favorite + pin 整体移除（决策 1/2，§5.1.1/§5.1.2）；其余零改动 |
| mao-cli | `lib/commands/session.js` + `business_process.md` / `reference/session.md` | 删 `session favorite` / `session pin` 两命令与文档（§5.1.1/§5.1.2） |
| agent-cli | `src/rest/types.ts` / `src/commands/ls.ts` | 删 `isFavorite` / `isPinned` 字段与 `ls` 置顶列（§5.1.1/§5.1.2） |
| desktop store | `stores/session/list.ts` | `listKeyword` + 三 fetch 路径传参 + `archiveSessions` |
| desktop store | `stores/session/types.ts` | 仅注释口径同步（决策 2） |
| desktop 组件 | `components/task/TaskIndexPanel.vue` | 过滤框、选择模式、批量操作条 |
| desktop 组件 | `components/task/TaskSessionGroupList.vue` / `TaskFocusList.vue` | 选择态复选框 |
| desktop 组件 | `components/chat/ChatPanel.vue` / `ChatRoundList.vue` | 目录把手与传参、`replyOnly` prop、回到顶部 |
| desktop 组件 | `components/chat/RoundDirectory.vue` | 新增（轻量列表） |
| desktop composable | `composables/useMessageLocate.ts` / `useChatScroll.ts` | `flash()` 薄封装（§5.4）/ `scrollToTop()` 薄封装 |
| desktop | `main.ts` | 新图标按需补注册（若有） |

预估：拆除清理（backend + 两 CLI + 迁移）1 人日，可作前置提交先行合入；P1 0.5-1 人日、P2 1 人日、P3 2-3 人日；合计 4.5-6 人日。三阶段可独立上线 / 独立回滚（各自只加 prop 与 store 方法，不互相依赖）。

## 7. 测试要点

**后端**：无新测试；pin / favorite 既有用例随拆除删除（`session.routes.spec.ts` / `session-extra.spec.ts`）；`session-group-order.bugcheck.spec.ts` 随决策 2 **改写**为「活跃 > 时间」断言（去 pin 夹具），改写后全绿即排序护栏不丢。

**desktop 单测**（vitest，沿用既有 mock api 约定，见 `stores/session.test.ts`）：

- `listKeyword`：空串不传参数（对 mock 入参 `not.toHaveProperty` 或 URL 级断言，mock 层测不出序列化差异）；三条 fetch 路径都带 keyword；loadMore 在 keyword 下 offset 口径不变（含深链注入后 loadedCount 推进）。
- `archiveSessions`：RUNNING / WAITING_APPROVAL / CANCELLING / RESUMING 被跳过（`ACTIVE_PHASES` 四相位全覆盖）；部分失败时成功者迁移、失败者留原位；组计数逐条减；归档区只静默刷新一次（mock 计数断言）；聚焦投影同步移除；锁跳过者的计数口径。
- `RoundDirectory` / `replyOnly`：目录行数据取自 rounds（摘要剥离、执行中轮不列）；`replyOnly` 下工具 / 思考隐藏、摘要行 / FileChangePanel / CompactionMarker 保留、activeRound 不受影响；切换时 `pauseFollow` 调用（mock 断言）。
- `useChatScroll`：`scrollToTop` 不误开 / 误关跟随（`programmatic` 记账）；`contentShrank` 既有分支补一条「replyOnly 切换导致内容塌陷」用例。
- **测试基线约束**：vitest 只收 `src/**/*.test.ts`（`.spec.ts` 不跑，`desktop/vitest.config.ts`）；组件级测试无 `@vue/test-utils`（既有先例：模板 AST 断言 / 自定义渲染器 / 源码字符串断言，或 `// @vitest-environment jsdom` 自建）。

**E2E**（不依赖固定用例数）：过滤框输入 → 分组结果过滤 + 清空还原；批量归档 → 已归档区恢复；轮次目录点击定位高亮；只看回复开关。既有任务列表 / 搜索定位用例全量回归。**评审补充**：全 `tests/` 当前**没有**归档 / 恢复用例（grep 零命中），「归档恢复」需新建且是首批；新 E2E 优先放独立 `desktop-*.spec.ts`（走 desktop-visual project 的 mock 路线；`desktop.spec.ts` 是真实后端串行且已 58KB），过滤框 mock 路线需扩 `mockLoggedInDesktopApi` 的 `/sessions/groups` 返回；批量归档写种子库，参照 `clearGroupAliases`（`tests/desktop.spec.ts:696-720`）直连 :9180 清场。

**CLI**：拆除后 `mao session --help` 与 `mao-agent ls` 无 pin / favorite 残留；两 CLI 既有单测（agent-cli 有 vitest，若有相关夹具）同步修正。

## 8. 验收标准

1. 过滤与批量归档两个动作均 2 次点击内完成；过滤结果在组预览与「展开更多」分页中口径一致（服务端口径）。
2. 过滤期间：手动刷新、WS 重连（聚焦模式）、恢复归档三条路径都不会让过滤条件被静默丢弃或结果错位。
3. 批量归档：运行中会话自动跳过并计数提示；失败条目不消失、可重试；归档区顺序与单条归档混用后一致。
4. 长会话（>200 条消息）：轮次目录 3 秒内定位到任意已加载轮并高亮；「只看回复」开启后屏幕只剩对话主干，关闭即还原，滚动位置不跳。
5. 后端 diff 仅限 favorite / pin 移除（一个迁移 + 端点 / 服务方法 / 字段 / 排序键的删除，两处 ORDER BY 与一处内存比较器去 pin 键，评审可逐行核对）；既有单测 / e2e 全绿；分享页、子代理面板、边路任务面板行为零变化。
6. mao-cli / agent-cli：`session favorite` / `session pin` 命令、`ls` 置顶列与全部文档引用移除后无残留；两 CLI 帮助输出正常。

## 9. 风险与开放问题

| # | 冲突 / 风险 | 应对 |
|---|---|---|
| C1 | keyword 只加到一边请求：groups 带、loadMore 不带 → 展开更多混入不匹配会话 | keyword 收敛为 store 单一状态，三条 fetch 路径统一读；offset 仍以服务端返回条数为准，天然自洽 |
| C2 | WS 重连静默重拉聚焦列表若不带 keyword → 过滤被悄悄清掉；深链注入把不匹配会话 unshift 进头部 | 聚焦路径读同一 store keyword；深链注入是显式导航，导航意图优先于列表过滤（与既有搜索跳转语义一致），注释写明 |
| C3 | 循环调用单条 `archiveSession` → N 次归档区静默重拉 + 并发锁逐条争用 | 新增 `archiveSessions` 批量函数：单次投影迁移 + 归档区一次静默刷新；与单条共用 `archivingIds` 锁防并发混用 |
| C4 | 批量后组计数 / 空组渲染 | 逐条 `bumpGroupMetaForSession(-1)` 与单条同口径；不新增「隐藏空组」行为（与单条归档后表现一致，避免两套语义） |
| C5 | `bumpGroupMetaForSession` 不减 `loadedCount` → 归档后「展开更多」offset 漂移漏条（§11.2-1；单条既有、批量放大） | 顺带修正（归档成功同步 `loadedCount - 1`）或记为已知限制并写入验收口径 |
| C6 | 回到顶部可见性：`historyAnchored` 仅 aroundMessageId 定位置位（§11.2-2） | 按钮独立可见条件（`userScrolledUp` / scrollTop 阈值），横条常驻化 |
| C7 | 目录承诺「任意轮可跳」与深历史未加载的矛盾 | 目录只索引已加载轮次（决策 7）；上滑分页补齐后目录自然更新；不引入 aroundMessageId 双路径 |
| C8 | 「只看回复」内容塌陷误触滚动控制器 | 切换显式 `pauseFollow`；`useChatScroll` 既有 `contentShrank` 分支天然兼容；补专项用例 |
| C9 | 新交互侵入 30+ prop 的列表组件 | 只加 prop 与回调不改既有签名；选择模式 / 过滤框为面板级 state，子组件零感知或最小感知 |
| C10 | 图标未注册导致空图标（0.0.345 教训） | 上线前核对 `main.ts` 注册表；CI 无此检查，纳入人工验收清单 |
| C11 | 回归面：store 单测 / 定位链路 / e2e 任务列表 | §7 全量清单（focusSort 已不涉及——决策 2 后无置顶级） |
| C12 | 移动端 WebView 小屏：过滤框 / 多选 / 目录把手布局 | 过滤框折叠为图标；多选入口放 header-actions（不放会隐藏的分组头部）；把手小屏降级（隐藏或移入检查器）；不引入新手势，长按菜单兼容既有 |
| C13 | 多选与右键菜单 / 行点击的手势竞争 | 选择模式是显式模态态：进入后行点击 = 勾选、右键仍开菜单（菜单项在选模式下禁用归档入口防歧义）；Esc / 点击「取消」退出。注意底部操作条点击会冒泡到既有 `onGlobalClick`（`TaskIndexPanel.vue:618-649`），需互斥 |
| C14 | 批量 vs 单条归档语义不对称：单条对 ACTIVE_PHASES「确认后可归档」（`TaskIndexPanel.vue:519-536` 弹窗），批量静默跳过 | 方案明示差异（批量保守跳过）；`skipped` 计数口径（是否含 `archivingIds` 锁跳过者）需定义 |
| C15 | 零碎：`title LIKE` 无 ESCAPE（`%`/`_` 当通配符，admin 搜索有 `escapeLike`）；bugcheck spec 注释行号漂移（`:302-304` 等已失效，实际 `:335`） | LIKE 转义随 V173 批修或记为已知；注释行号随手修 |

**开放问题**（不阻塞评审，实施时定）：目录把手小屏最终形态（隐藏 vs 检查器按钮）；`archiveSessions` 串行 vs 限量并发（默认串行，N<50 无感）；V173 一并 drop 两列 vs 拆两个迁移（建议一并，拆除本就是一批）。

## 10. 发布与文档同步

- **CHANGELOG**：实施任务同批写顶部 `## x.y.z (日期)` 新块（当前最新 0.0.350，本方案开 0.0.351）——前端小节记「列表标题过滤 / 批量归档 / 轮次目录 / 只看回复」；后端小节记「移除会话收藏与置顶（V173 drop `is_favorite` / `is_pinned`）」；mao-cli 小节记「移除 `session favorite` / `session pin` 命令」；按 `./scripts/changelog-extract.sh` 口径走。
- **mao-cli**：`skills/mao-cli/reference/desktop.md` 的任务列表节（`:18`）与「回复、思考与工具」节（`:98`，无字面「聊天区」小节）补过滤 / 多选 / 目录 / 只看回复说明；`README.md`「核心能力」协作行补一句。拆除部分见 §5.1.1/§5.1.2（含 `reference/session.md` / `business_process.md`）。
- **提案台账**：本文档评审通过后，`docs/proposals/README.md` 第十六批该条目标注「已转入实施」并链到本方案。

## 11. 评审结论与补充（2026-10-26）

**结论：需求可行；技术方案主体可行。** v1.0 的 desktop 侧代码级断言经逐条复核基本全部属实（store 13 条、聊天区组件 / composable 10 条、任务列表组件 10 条均 CONFIRMED），后端「keyword 已就绪」判断成立。评审发现 3 处事实性错误与约 10 处缺口；**需求方已就其中两项定稿：决策 1 扩为 favorite 全量拆除（§5.1.1），决策 2 为 pin 整体取消（§5.1.2）**——§11.1-1/2/3 即这两项决策的依据，存录备查。其余补充（§11.2）已并入正文。本轮评审未改任何代码。

### 11.1 勘误（事实性错误；1/2/3 均已由决策 1/2 落定，存录备查）

1. **「favorite 零调用」前提不成立。** `mao session favorite` 命令在调用 `PUT /sessions/:id/favorite`（`skills/mao-cli/lib/commands/session.js:182-184`，帮助行 `:25`，文档 `business_process.md:55`、`reference/session.md` 4 处）；后端 `session.routes.spec.ts:176` 还直接 HTTP 测该端点；agent-cli `src/rest/types.ts:47` 声明了 `isFavorite`。「三端 + CLI 全仓无引用」仅对 desktop / admin 成立。→ 决策 1 定稿为全量拆除（§5.1.1）。
2. **「pin 不触碰 `updated_at`」不成立。** `session.updated_at` 为 `DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`（`V001__init_schema.sql:157`，无迁移改过），`updateById`（`db/db.ts:55-63`）只 SET 传入列——`is_pinned` 翻转即 bump `updated_at`，取消置顶的会话会以「刚更新」进入非置顶档顶部、相对时间跳「刚刚」。→ 与 §11.1-3 一并构成决策 2（pin 整体取消）的主要依据。
3. **「置顶排序三处口径一致」表述不准确。** `listSessions`（`session.service.ts:275`）无活跃相位优先；分组预览组内的「活跃优先」来自内存 `compareSessions` 重排（`session.service.ts:297`）。聚焦模式「运行中任务仍优先」由 desktop `focusSort` 前端重排兑现，语义系于档位——接通 pin 会让「置顶 vs 运行中」的预期管理变复杂。→ 决策 2 取消 pin 后此问题消解，排序三处统一「活跃 > 时间」。

### 11.2 补充（缺口；已并入正文对应小节）

1. **批量归档继承 `loadedCount` offset 漂移**（→ §5.2 / C5）：`bumpGroupMetaForSession` 只减 `total` 不减 `loadedCount`（`list.ts:231-234`），组内归档后「展开更多」会漏条（单条既有、批量放大）。
2. **回到顶部可见条件**（→ §5.4 / C6）：`historyAnchored` 仅在 aroundMessageId 定位时置位（`useMessageLocate.ts:71`），上滑分页不置位；寄生「回到最新」条 = 常规阅读不可见。
3. **目录把手定位**（→ §5.4）：`.messages` 及整条祖先链无 `position` 声明（`ChatPanel.vue:955-960` 等），必须先补 `position: relative`（或 sticky），否则复现 0.0.337 回落视口问题。
4. **「只看回复」开关无既有工具行可挂**（→ §5.4）：ChatPanel 会话态没有「与队列面板同级的一行工具」（QueuePanel 是队列列面）；推荐把 `.history-anchor-bar` 泛化成常驻 sticky 顶栏，未计入的 UI 工作量。
5. **`flash()` 接口缺口**（→ §5.4）：`flashId` 2s 自清定时器在 `useMessageLocate` 闭包内、对外只读；目录点击需暴露 `flash(messageId)` 薄方法（含 `onLocate → pauseFollow` 与滚动）。
6. **replyOnly 边缘路径**（→ §5.4）：无步骤轮 finalReply 的思考块走 `hideThinking` prop 需随传 true；finalReply 内嵌 toolCalls 无 prop 可隐藏，需新 MessageBubble prop 或 CSS。
7. **图标**（→ §6 / C10）：Element Plus 无 `Pin` 图标（置顶用 `Top`，决策 2 后本方案不再需要）；多选复选框若走图标需核对 `Checked` 注册（`main.ts` 未注册，局部 import 可绕开）。
8. **批量 / 单条归档语义不对称**（→ §5.3 / C14）：单条对 ACTIVE_PHASES「确认后可归档」（`TaskIndexPanel.vue:519-536`），批量静默跳过，需文案明示。
9. **测试基线**（→ §7）：无归档 / 恢复 e2e（需新建）；vitest 只收 `.test.ts`；「空串不传参数」mock 层不可测；无 `@vue/test-utils`；新 e2e 优先独立 `desktop-*.spec.ts`。
10. **窄屏 / 交互细节**（→ §5.3 / C12/C13）：多选入口不放会隐藏的分组头部（`group-header-actions` <200px 隐藏、面板可拖至 120px）；底部操作条点击冒泡到既有 `onGlobalClick`（`TaskIndexPanel.vue:618-649`）需互斥；`isMobileViewport` 无共享 composable（`usePanelLayout` 内未导出）。
11. **零碎**（→ C15）：`title LIKE` 无 ESCAPE；bugcheck spec 注释行号漂移（`session.service.ts:302-304` 等已失效，实际 `:335`）。

### 11.3 开放问题

- 目录把手小屏最终形态（隐藏 vs 检查器按钮）。
- `archiveSessions` 串行 vs 限量并发（默认串行，N<50 无感）。
- V173 一并 drop 两列 vs 拆两个迁移（建议一并）。
- v1.0 的「置顶视觉用钉子还是底色」随决策 2 取消，不再存在。
