# 信号哨兵增强技术方案

> 状态：已确认（D1-D10 全部确认，D8 按用户提问定为模型 B；待实施）
> 日期：2026-10-27
> 上游修订：[2026-10-11-signal-watcher-technical-design.md](./2026-10-11-signal-watcher-technical-design.md)（首发方案，其「数量上限 20」「每次触发新建会话」「不做会话绑定」「不计入独立分组」四条被本方案修订）
> 覆盖端：后端 backend-ts、桌面端 desktop、管理后台 admin

---

## 1. 背景与目标

信号哨兵首发（0.0.278）后，实际使用暴露出四个体验问题，本方案一次性解决：

1. **配额上限碍事**：每用户 20 个的上限是首发时对齐 Webhook 触发器拍的，实际场景（盯一批接口）轻易触顶，触顶后前端直接隐藏新建按钮，用户无感也无处调。取消上限，移除相关代码。
2. **触发方式一刀切**：目前每次触发必然新建会话。用户需要「复用同一会话持续对话」的选项（例如长期盯一个接口，让 Agent 在同一会话里积累上下文）。触发方式改为哨兵级配置项；「复用」指哨兵首次触发自动自建会话、之后复用这个自己的会话（D8 模型 B），用户不需要选会话。
3. **触发会话混在临时工作区**：哨兵会话没有来源标识（`session.source` 落默认 `'web'`），混在置顶的「临时工作区」分组里，认不出来。给哨兵会话打标识并独立分组。
4. **机器触发也计未读**：哨兵会话跑完带未读红点、进聚焦模式置顶，与微信/飞书/钉钉通道会话「外部触发、无人工关注」的口径不一致。按通道会话口径排除未读（仅未读两处；收件箱条目与外发通知按 D1 确认保留，见 §3.4）。
5. **复制一个新哨兵要重填一遍**：想基于现有哨兵微调（换个 URL 路径、改个间隔）时，只能从零新建，请求头、判定模式、提示词全部手工重填，敏感请求头还要去翻原始凭据。列表增加「复制」：点击即把源哨兵配置预填进新建表单（敏感请求头/body 由后端在保存时从源哨兵继承），改完保存即得新哨兵。

明确不做：历史会话不回填、不做数据迁移（存量哨兵会话 `source='web'` 继续留在「临时工作区」）；不引入分布式轮询；不改探针/判定/退避/停用的既有规则；复用模式不提供「绑定用户自选会话」（D8 模型 B：只复用自己的会话）。

---

## 2. 现状代码事实（实施前已核对）

| 事项 | 现状 | 位置 |
|---|---|---|
| 哨兵配额 | `MAX_WATCHERS_PER_USER = 20`，`create` 内 `count >= 20` 抛 `PARAM_INVALID`「每用户最多 20 个哨兵」 | `backend-ts/src/signal/watcher.service.ts:21-22, 118-123` |
| `countByUser` | 唯一生产调用就是配额校验；另有两处 spec mock | `backend-ts/src/signal/signal.repository.ts:56-62` |
| 前端上限 | `MAX_WATCHERS = 20`，列表头部「已达单用户上限」提示 + 新建按钮条件渲染 | `desktop/src/views/settings/signal-watcher-form.ts:28-29`；`SignalWatchersView.vue:19-22, 267, 606` |
| 触发建会话 | `openRun.run({ userId, agentId, message, source: 'SIGNAL' })`，不传 `sessionId` → 每次新建；`session.source` 落 `'web'` | `backend-ts/src/signal/watcher.service.ts:406-411`；`backend-ts/src/openapi/open-run.service.ts:119-122` |
| 复用会话机制 | `OpenRunInput.sessionId` 已完整支持「复用」（归属/主会话/CLOUD/agentId 一致校验、busy 自动入队），API 与 WEBHOOK 两条路在用；SIGNAL 只是没传 | `backend-ts/src/openapi/open-run.service.ts:44-55, 102-118` |
| Webhook 固定会话范式（**参照但未采用其选会话形态**） | 触发器行带 `session_id BIGINT NULL`（NULL=每次新建），建/改时 `assertBindableSession` 校验；本方案的复用走「自己的会话」自动指针（D8 模型 B，见 §3.2.3） | `backend-ts/db/migration/V133__open_api.sql:25`；`backend-ts/src/openapi/webhook-trigger.service.ts:315-330` |
| 会话分组 | 前端 `cloudGroupKey` / 后端 `SessionGroupKey.of` 按 `source='embed'` 优先分流到 `EMBED:{agentId}`；其余 CLOUD 临时工作区会话落 `CLOUD:临时工作区`（置顶第一组） | `desktop/src/utils/cloud-project.ts:80-103`；`backend-ts/src/session/util/session-group-key.ts:89-107` |
| 分组展开 SQL | `applyFilter` 的四个「模式+工作区」桶显式排除 `source='embed'`（注释说明不排除会导致预览/展开条数不一致） | `backend-ts/src/session/util/session-group-key.ts:171-231` |
| 未读排除口径 | 微信/飞书/钉钉通道会话在 WS `unread`、DB `updatePhase`、`recordInbox`、任务通知外发四处排除 | `backend-ts/src/session/task-terminal.service.ts:132-135, 214-217`；`session.service.ts:1444-1448`；`notification/task/delivery.service.ts:52-55` |
| `session.source` 列 | `VARCHAR(16) NOT NULL DEFAULT 'web'`，无 ENUM/CHECK；运行时白名单 `SESSION_SOURCE_VALUES = ['web','embed']` | `backend-ts/db/migration/V109__add_session_source.sql`；`session.repository.ts:9-13` |
| `POST /v1/sessions` source 校验 | 走 `isSessionSource(body.source)`，即与 `SESSION_SOURCE_VALUES` **联动**，并非路由层硬编码白名单 | `backend-ts/src/session/session.routes.ts:150-151` |
| `createSession` 签名与装配 | 真实签名共 16 个位置参数，`source` 在**第 16 位**；装配层 `sessionService as unknown as OpenRunDeps['sessionService']` 强转，dep 接口声明与真实签名不一致时编译期不报警 | `backend-ts/src/session/session.service.ts:97-114`；`backend-ts/src/app-openapi-services.ts:73` |
| 迁移版本 | 当前最大 V173 | `backend-ts/db/migration/` |

---

## 3. 技术方案

### 3.1 取消哨兵配额（子项 1）

纯删除，无新机制：

| 文件 | 改动 |
|---|---|
| `backend-ts/src/signal/watcher.service.ts` | 删 `MAX_WATCHERS_PER_USER` 常量（:21-22）与 `create` 内配额校验三行（:118-123） |
| `backend-ts/src/signal/signal.repository.ts` | 删 `countByUser`（:56-62，移除后无任何调用方） |
| `backend-ts/src/signal/watcher.service.spec.ts` | 删 `rejects more than the per-user cap` 用例（:228-237）+ import（:10）+ 假 repo mock（:130） |
| `backend-ts/src/signal/watcher.routes.spec.ts` | 删假 repo mock（:61） |
| `desktop/src/views/settings/signal-watcher-form.ts` | 删 `MAX_WATCHERS`（:28-29） |
| `desktop/src/views/settings/SignalWatchersView.vue` | 新建按钮改无条件渲染，删 `limit-hint` 分支（:19-22）、import（:267）、样式（:606） |

不动的：webhook 触发器（`MAX_TRIGGERS_PER_USER`）与出站订阅（`MAX_SUBSCRIPTIONS_PER_USER`）的上限保持原样，本次只取消哨兵。

### 3.2 触发方式可配置：新建 / 复用会话（子项 2）

#### 3.2.1 数据模型（新迁移 V174）

```sql
ALTER TABLE `signal_watcher`
  ADD COLUMN `trigger_mode` VARCHAR(16) NOT NULL DEFAULT 'NEW_SESSION'
    COMMENT '触发方式：NEW_SESSION=每次新建会话，REUSE_SESSION=复用本哨兵自己的会话',
  ADD COLUMN `reuse_session_id` BIGINT NULL
    COMMENT 'REUSE_SESSION 模式当前复用的会话 id（系统维护：首次触发自动创建并回写，用户不直接选择）';
```

- 默认 `NEW_SESSION` = 现状行为，存量哨兵零迁移自动兼容。
- 两列而非单列 `reuse_session_id`（Webhook 范式）的理由：前端是显式 radio，契约枚举 `SignalTriggerMode` 吃编译期穷尽；单列靠 NULL 语义在「编辑时清空」场景需要额外约定。
- 回滚 = 再发一个迁移 drop 两列（Flyway 无 down）；后端代码回滚后列残留但无读写，旧代码 insert 白名单不写新列，默认值兜底，行为兼容。

#### 3.2.2 契约（跨端枚举，照 AGENTS.md 流程）

1. `shared/contracts/src/signal.ts` 新增 `export type SignalTriggerMode = 'NEW_SESSION' | 'REUSE_SESSION'`
2. `shared/contracts/src/index.ts:25` re-export 列表加成员
3. 后端 `backend-ts/src/signal/types.ts` 加 `SIGNAL_TRIGGER_MODES` + `isSignalTriggerMode`，`as const satisfies SignalTriggerMode`（照 `SIGNAL_COMPARE_MODES` 范式）
4. 前端汉化表 `Record<SignalTriggerMode, string>`（`SignalWatchersView.vue`，照 compareMode 的 `:317-325`）；admin 清单同款

#### 3.2.3 后端链路（五处白名单式同步，漏一处运行期丢字段）

| 文件 | 改动 |
|---|---|
| `signal/types.ts` | `SignalWatcher` 行类型加 `triggerMode` / `reuseSessionId` |
| `signal/signal.repository.ts` | `insert`（:15-34）与 `update` patch 白名单（:98-117）加两列 |
| `signal/watcher.service.ts` | `WatcherInput`（:56-67）、`SignalWatcherView`（:70-89）、`create`（:124-142）、`update` merged/patch（:154-195）、`normalizeInput`（:499-562）加字段与规则；`WatcherServiceDeps` 增 `getSession` dep；触发处（:406-411）指针预检 + 传 `sessionId` + 首触回写 |
| `signal/watcher.routes.ts` | `toInput`（:22-55）解析 `triggerMode`（**不解析** `reuseSessionId`——指针系统维护，防伪造） |
| `signal/watcher.service.spec.ts` 等 | 补用例（见 §6） |

`normalizeInput` 与 `update` 的规则（D8 确认模型 B：**复用 = 哨兵自己的会话，用户不选会话，指针由系统维护**）：

- `triggerMode` 仅归一化校验（`SIGNAL_TRIGGER_MODES` 白名单）；**没有**「选会话」输入，`reuseSessionId` 不接受用户提交（`toInput` 不解析该字段，防伪造指向他人生效中的会话）。
- `update` 时 `triggerMode` 改为非 `REUSE_SESSION`（或从复用切走）→ `reuseSessionId` 置 NULL。由此「REUSE → NEW → REUSE」往返即**手动重置复用会话**的入口（无需额外 UI）。
- `update` 时 `agentId` 变更 → `reuseSessionId` 置 NULL（旧指针指向的会话属于旧 Agent，openRun 会以「只能触发该会话所属的 Agent」拒绝；清指针让下次触发自建，不进连败）。
- `DISABLED → ACTIVE` 重置基线并清零失败；指针保留（会话仍有效），不强制重建。

触发处逻辑（`watcher.service.ts:406-411` 一带；复用上方 :390 已重读的 `fresh` 行而非函数开头读的 `watcher`——探针在途 10~15 秒期间用户可能改 triggerMode/清指针，与 :390「触发前复读状态」同一理由）：

```ts
// 指针有效性预检：会话被用户删/归档导致失效时清指针走新建，不计入 consecutive_failures
let reuseId = fresh.triggerMode === 'REUSE_SESSION' ? fresh.reuseSessionId : null;
if (reuseId != null && !(await this.isReusableSession(watcher, reuseId))) {
  reuseId = null;
  await this.deps.watcherRepo.update(watcher.id!, watcher.userId, { reuseSessionId: null });
}
const outcome = await this.deps.openRun.run({
  userId: watcher.userId,
  agentId: watcher.agentId,
  message: prompt,
  source: 'SIGNAL',
  sessionId: reuseId,                       // null = 新建（NEW_SESSION 或复用模式首触）
});
// 复用模式首触：把新建的会话 id 回写为指针，之后每次复用
if (fresh.triggerMode === 'REUSE_SESSION' && fresh.reuseSessionId == null && outcome.sessionId != null) {
  await this.deps.watcherRepo.update(watcher.id!, watcher.userId, { reuseSessionId: outcome.sessionId });
}
```

`isReusableSession(watcher, sessionId)`：经新增 dep `getSession`（装配传 `sessionService.getSession`）校验会话存在、本人所有、非 `SUBAGENT`/`SIDE_TASK`、`CLOUD`、`agentId` 与哨兵一致；任一不满足返回 false。一次 SELECT 的成本换取「指针失效不烧连败、不触发停用」。

运行期其余约束由 `openRun` 现成兜底（锁内重读、busy 自动入队返回 `queued:true` 不计失败）。

不影响基线的约定（照现状「改名称/间隔/提示词不重置」）：改 `triggerMode`、指针清零/重建**不重置** `last_value_hash`（探测面未变）。`DISABLED → ACTIVE` 仍重置基线并清零失败，不变。

#### 3.2.4 前端链路

| 文件 | 改动 |
|---|---|
| `desktop/src/api/index.ts` | `SignalWatcherView`（:963-983）加 `triggerMode`/`reuseSessionId`（后者只读展示）；`SignalWatcherInput`（:1011-1027）加 `triggerMode`（**不加** `reuseSessionId`——指针系统维护） |
| `desktop/src/views/settings/signal-watcher-form.ts` | `SignalWatcherForm` 接口加 `triggerMode`；`buildWatcherPayload`（:76-108）按「省略=保留原值」口径：新建态必下发；编辑态仅在用户改过 radio 时下发，防止把旧值覆盖成默认 `NEW_SESSION` |
| `desktop/src/views/settings/SignalWatchersView.vue` | 对话框加「触发方式」radio（仿判定模式 :127-133），**无会话选择器**（模型 B）；`openEditDialog`（:395-412）回显 `triggerMode`；`resetForm`（:372-384）重置；卡片 meta 加「触发方式」徽标（:60-67）；列表头部文案（:16「每次触发都会新建一次 Agent 会话」）改为中性表述；表单 hint 说明「复用 = 本哨兵首次触发自动建会话、之后复用；切到新建再切回可重置」 |
| `admin/src/views/signal/SignalWatcherListView.vue` | 加「触发方式」列（只读）；该视图行类型是文件内本地 `WatcherRow` interface，须同步加 `triggerMode` 字段；汉化表同 `Record<SignalTriggerMode, string>`（文件已从 `@mao/contracts` import 类型，照 `STATUS_LABELS` 范式） |
| `desktop/src/views/settings/signal-watcher-form.test.ts` | 补 payload 口径用例（编辑未改不动原值） |
| `desktop/src/views/settings/SignalWatchersView.layout.test.ts` | 补 radio 渲染用例；断言**不存在**会话选择器 |

频次上限（每小时 4 次、超出打 `TRIGGER_RATE_LIMITED` warning）两种模式通用，**不分档**（D3 确认：复用模式不照 Webhook 的 BOUND 30 次/时提额）。

### 3.3 哨兵会话独立分组（子项 3）

#### 3.3.1 标识：`session.source = 'signal'`

- `SESSION_SOURCE_VALUES` 加 `'signal'`（`session.repository.ts:9`）。
- `open-run.service.ts`：`OpenRunDeps.createSession` 声明（:19）改为**镜像真实 16 参位置签名**（`…gitCloneUrl?, gitBranch?, source?: SessionSource | null`）；调用处（:121）做映射 `input.source === 'SIGNAL' ? 'signal' : undefined`。注意：API/WEBHOOK 两条路共用此调用点，映射必须只对 SIGNAL 生效。`createSession` 真实签名 `source` 是**第 16 个位置参数**（`session.service.ts:97-114`），从当前实参 `executionMode`（第 4 位）到 `source` 中间要填 **11 个 `undefined`**。装配层 `app-openapi-services.ts:73` 是 `sessionService as unknown as OpenRunDeps['sessionService']` 强转——接口声明与真实签名不一致编译期不报警，数错位参（如把 `'signal'` 落到第 5 位 `workspace` 或第 14 位 `gitCloneUrl`）是**静默运行时 bug**：`session.source` 保持 `'web'`、§3.3 分组静默失效。接口声明与调用处须与真实签名逐位对齐，并加注释锁定「改 `session.service.ts` 签名必须同步此处」。
- `POST /v1/sessions`（`session.routes.ts:150-151`）的 source 白名单**需要新增改动**：现状该校验走 `isSessionSource(body.source)`，读的正是要加 `'signal'` 的 `SESSION_SOURCE_VALUES`——不改这里，用户可 `POST /v1/sessions {"source":"signal"}` 手工建信号分组会话（防伪造分组归属的手段目前并不存在）。改为路由层显式硬编码 `['web','embed']`（内联白名单或新增 `isUserSettableSessionSource`），不跟 `SESSION_SOURCE_VALUES` 联动；该来源只能由哨兵触发经 openRun 产生。
- `markSessionSource`（`session.service.ts:369-380`）仍只允许 `'embed'`，不动。

#### 3.3.2 分组 key：`SIGNAL`（无参数）

与 `EMBED:` 同级的 source 驱动 key，不带 agentId——一个用户的全部哨兵会话进同一组。展示名「信号哨兵」、图标 Satellite（D4 确认；实施修正：`@element-plus/icons-vue@2.3.2` 无 Satellite 导出，改用语义最接近的 AlarmClock）。

后端 `backend-ts/src/session/util/session-group-key.ts` 四处同改：

| 函数 | 改动 |
|---|---|
| `of()`（:89-97） | embed 判断之后加 `if (source === 'signal') return SIGNAL_GROUP_KEY` |
| `applyFilter()`（:171-231） | ① 新增 SIGNAL 桶 `{ clauses: ['source = ?'], params: ['signal'] }`；② `LOCAL_UNSET`/`LOCAL:`/`CLOUD_TEMP`/`CLOUD:` 四个桶的排除条件从 `!= 'embed'` 扩为 `NOT IN ('embed','signal')`——**不扩就是 embed 注释里那个 bug：预览出现一次、展开多一条、total 对不上、分页偏移错乱** |
| `formatLabel()`（:109-156） | SIGNAL → `'信号哨兵'` |
| `compareKeys()`（:158-169） | SIGNAL 排最后：所有既有规则之后、`localeCompare` 之前，`a=SIGNAL` 返回 1、`b=SIGNAL` 返回 -1 |

前端 `desktop/src/utils/cloud-project.ts` 四处同改（规则与后端靠注释对齐，现状如此）：

| 函数 | 改动 |
|---|---|
| `cloudGroupKey()`（:80-103） | embed 分支之后加 `if (session.source === 'signal') return SIGNAL_GROUP_KEY` |
| `formatCloudGroupLabel()`（:111-153） | SIGNAL → `'信号哨兵'`（不加分支会裸奔显示 key） |
| `groupIconKind()`（:33-43） | 加 `'signal'` 分支；`GroupIconKind` 联合（:19）加成员；`TaskSessionGroupList.vue:26-56` 模板加图标分支（AlarmClock，Satellite 在 icons-vue@2.3.2 不存在） |
| — | 新增导出 `SIGNAL_GROUP_KEY` / `isSignalGroupKey`（照 `EMBED_GROUP_PREFIX` 范式） |

排序三处同改（漏一处则后端组序与前端不一致）：

1. `backend-ts/src/session/util/session-group-key.ts` `compareKeys`（见上）
2. `desktop/src/components/task/TaskIndexPanel.vue:965-972` 组排序：SIGNAL 置最后（注意现有 `'CLOUD:临时工作区'` 硬编码置顶在它之前生效）
3. `desktop/src/composables/useTaskPanelPrefs.ts:322-330` `sortGroups`（用户未自定义顺序时的默认口径，与 TaskIndexPanel 同规则）

深链注入修补：`desktop/src/stores/session/list.ts:607-609` 对不在本地列表的会话注入 `groupMeta` 时 `label` 是裸 key，SIGNAL 会话深链（如从收件箱/轮询记录点入）会闪一下「SIGNAL」；改为 `label: formatCloudGroupLabel(key)` 顺手修掉。

空组问题不存在：分组由会话聚合产生（`listSessionGroups` 纯内存分桶），没有哨兵会话的用户不会看到这个组。

### 3.4 排除未读（子项 4）

口径：**只排除未读**（D1 确认，与通道会话的未读口径一致，但不连带排除收件箱与外发）。哨兵会话终态后：无未读红点、不进聚焦模式置顶；收件箱仍会写入 `TASK_COMPLETED`/`TASK_FAILED` 条目（保留审计痕迹），仍计收件箱未读数、窗口失焦仍弹系统通知，用户启用了任务通知偏好时仍外发钉钉/飞书/邮件。

只改两处未读判定：

| 位置 | 现状排除 | 改动 |
|---|---|---|
| `backend-ts/src/session/task-terminal.service.ts:132-135` | WS `session_status.unread` 排除三通道会话 | 加 `&& session.source !== 'signal'` |
| `backend-ts/src/session/session.service.ts:1444-1448` | `updatePhase` 终态落 `unread=1` 排除三通道会话 | 同样加 source 条件（与 WS 事件保持一致，注释同款更新） |

**不改**：`recordInbox`（`task-terminal.service.ts:214-217`）与任务通知外发（`notification/task/delivery.service.ts:52-55`）——按 D1 保留现有行为。

排除未读后自然不进聚焦模式置顶（聚焦模式按 unread 汇聚，代码注释即此理由）。`WATCHER_DISABLED`（哨兵被停用）是另一条链路，**不排除、不设偏好开关、始终通知**，保持现状——哨兵异常必须让用户知道，这与「触发不打扰」不矛盾。

**顺手补齐（既有缺口）**：收件箱条目保留后，`desktop/src/components/inbox/InboxDrawer.vue:58-62` 的 `SOURCE_BADGES` 应补 `SIGNAL: '信号哨兵'`——否则哨兵触发的终态条目在收件箱里没有来源角标，与 SCHEDULED/WEBHOOK/API 三类不对称。`InboxSource` 契约联合在首发时已含 `'SIGNAL'`（`shared/contracts/src/inbox.ts`），此处只是前端映射表漏加。

### 3.5 历史数据（子项 5）

不回填、不迁移存量会话。存量哨兵会话 `source='web'` 继续留在「临时工作区」；新规则只对改造后新触发的会话生效。`signal_watcher` 表两列默认值保证存量哨兵行为不变（`NEW_SESSION`）。

### 3.6 复制哨兵（子项 6）

需求（D9/D10 确认后的交互）：列表点「复制」**不调用任何写 API**，仅打开新建对话框并把源哨兵的配置预填进去；用户当场改名字/间隔/判定模式等，保存后即得新哨兵。

#### 3.6.1 为什么保存时需要后端协助（已核实的两个坑）

预填的数据源是列表/详情视图，而视图是脱敏的：

1. **请求头打码**：敏感键值经 `maskProbeHeaders` 变为 `******`（`probe-validate.ts:78-91`）。若把掩码当普通值提交，`create` 不经过 `restoreMaskedHeaders`（还原只在 `update` 生效，`watcher.service.ts:585-601`）、`assertProbeHeaders` 也不校验掩码值——字面量 `******` 会原样加密落库，探针真的发出 `Authorization: ******`。
2. **body 不回显明文**：`toView` 只回 `hasBody` + `bodyLength`（`watcher.service.ts:651-652`）。纯前端复制必丢 body，POST 哨兵会被「POST 必须填写请求体」拒绝。

因此：**复制点击不保存（纯前端预填），但保存时 `POST /v1/signal-watchers` 带 `copyFrom`（源哨兵 id），由后端把掩码头值从源行解密还原、body 缺省时继承源行**。敏感凭据始终不落到前端，也不进任何新端点。

#### 3.6.2 交互流程（前端）

1. 列表项操作区（编辑按钮旁，`SignalWatchersView.vue:44` 附近）加「复制」按钮（Copy 图标 + tooltip「复制此哨兵」）。无确认弹窗——复制只是开表单，非破坏性。
2. 点击 → `openCopyDialog(watcher)`：`resetForm()` 后预填，`editing=false`、`copyFromId=watcher.id`，对话框标题/提交按钮文案随「新建/复制」切换。
3. 预填规则：
   - `name` = `{源名} 副本`（前端拼后缀，用户可改）
   - `agentId`/`url`/`method`/`intervalMinutes`/`compareMode`/`jsonPath`/`promptTemplate` 取视图原值
   - `headers`：`headerPairsFromView` 同款——敏感键 value 空 + `masked` 标记（编辑弹窗既有语义：「掩码行留空 = 沿用源值」），非敏感键原值
   - `body`：留空，placeholder「留空则沿用源哨兵请求体（已保存 N 字符）」（N 取 `watcher.bodyLength`）；要换新体就直接输入
   - `triggerMode` 同源；`reuseSessionId` 不预填（模型 B 指针系统维护，副本首次触发自建，见 §3.6.4）
4. `canSubmit`：POST 且**非复制态**才强制 body；复制态 body 可空（继承源）。
5. 提交：`buildWatcherPayload` 在 `copyFromId` 存在时下发 `copyFrom`；成功后关对话框 + `fetchWatchers()` + toast「已创建副本」。两个必须显式处理的 payload 口径：
   - 现状 `buildWatcherPayload` 对新建态 POST **无条件下发 `body`**（空串也下发，服务端 `normalizeInput` 把 `''` 当 null 后抛「POST 方法必须填写请求体」）。复制态要「body 空则**不下发 body 键**（继承源）」，需给函数加复制态入参（如 `copyFromId`）区分，不能沿用新建态分支。
   - 源哨兵为 GET（`bodyLength=0`）时用户在复制表单切 POST 且留空：服务端无 body 可继承，按「POST 方法必须填写请求体」拒绝——属预期报错，此时表单 hint「留空则沿用源哨兵请求体」具有误导性，可接受（服务端报错文案已指明清空原因），如需更顺可在 hint 对 `bodyLength=0` 换文案。

#### 3.6.3 create 的 copyFrom 继承（后端）

`watcher.routes.ts` `toInput` 解析可选 `copyFrom`（正整数）；`watcher.service.ts` `create` 增加分支：

- **执行顺序**：copyFrom 的 headers 还原与 body 继承必须在 `normalizeInput(input)` **之前**完成——`create` 现状首行（:119）即 `normalizeInput`，POST 缺 body 会先抛「POST 方法必须填写请求体」，写在 normalize 之后的继承逻辑够不着。
- `copyFrom` 存在 → `requireOwned(copyFrom, userId)` 取源行（不存在/非本人同现有 `PARAM_INVALID`（400）口径，防越权拿凭据）
- `input.headers` 中值等于 `SECRET_MASK` 的键 → 从**源行解密 headers** 还原（直接复用 `restoreMaskedHeaders`，对照行换成源行）；键在源行不存在（用户改了键名）→ 抛「请求头 X 需要填写新的值」，强制重填
- `body` 未下发（undefined）且 `method='POST'` → 继承源行解密 body；显式清空（用户切换 GET 时 `normalizeInput` 本就会清）无需特殊处理
- 其余字段、配额校验（随子项 1 已取消）、基线置空、`status:'ACTIVE'`（`watcher.service.ts:136` 硬编码，D7 天然满足）全部照 create 现状

语义边界（写进表单测试）：复制态下「删光全部请求头行」= 不要请求头（预填行都在，删光是明确动作）；「body 留空」= 沿用源体（body 无明文可预填，空是默认态，二者不可区分，文档约定为空即沿用）。

#### 3.6.4 复用归属模型（D8 已确认：模型 B）

源哨兵为 `REUSE_SESSION` 时：`triggerMode` 随源预填，**`reuseSessionId` 不预填**——模型 B 下指针是系统维护的内部状态（每个哨兵复用自己的会话），副本从空指针开始，首次触发时自建自己的会话。复制因此零特殊处理，也不会出现两个哨兵共用一个会话。

对照说明（备选模型 A：用户在表单里绑一个已有会话，照 Webhook）已评估并放弃：需要会话选择器、保存时 `assertBindableSession` 式校验、复制时还要决定绑定去留——失败路径更多，与「哨兵自包含」的形态不符。

---

## 4. 改动文件清单

**后端（8）**：`session/session.repository.ts`、`session/session.routes.ts`（source 白名单改硬编码，§3.3.1）、`openapi/open-run.service.ts`、`session/util/session-group-key.ts`、`session/session.service.ts`、`session/task-terminal.service.ts`、`signal/{types,signal.repository,watcher.service,watcher.routes}.ts`、`db/migration/V174__signal_watcher_trigger_mode.sql`

**契约（2）**：`shared/contracts/src/signal.ts`、`shared/contracts/src/index.ts`

**前端 desktop（8）**：`utils/cloud-project.ts`、`components/task/TaskIndexPanel.vue`、`components/task/TaskSessionGroupList.vue`、`composables/useTaskPanelPrefs.ts`、`stores/session/list.ts`、`api/index.ts`、`views/settings/{signal-watcher-form.ts,SignalWatchersView.vue}`、`components/inbox/InboxDrawer.vue`

**前端 admin（1）**：`views/signal/SignalWatcherListView.vue`

复制功能（子项 6）不引入新源文件、不新增端点：`copyFrom` 落在既有 `POST /v1/signal-watchers` 上（`signal/watcher.routes.ts` + `watcher.service.ts`），前端落在已列出的 `SignalWatchersView.vue` + `signal-watcher-form.ts` + `api/index.ts`。

**测试（约 8 个 spec/test，见 §6）**

**文档（4）**：`CHANGELOG.md`（新版本条目）、`skills/mao-cli/reference/signal-watcher.md`、`README.md`（:57、:88 两处）、本方案 + 首发方案顶部加互指标注

---

## 5. 测试计划

后端 Vitest：

| 文件 | 用例 |
|---|---|
| `signal/watcher.service.spec.ts` | 删配额用例；新增（模型 B）：REUSE 首触不传 `sessionId` 且成功后回写指针、次触传指针 `sessionId`、指针失效（会话删/非本人/Agent 不符）时清指针走新建**且不计连败**、切 `NEW_SESSION` 清指针、`NEW→REUSE` 往返重置指针、改 `agentId` 清指针、`NEW_SESSION` 全程不收 `sessionId` |
| `signal/watcher.routes.spec.ts` | `toInput` 解析 `triggerMode`/`reuseSessionId`/`copyFrom`；create+copyFrom 路由层：非本人/不存在的 `copyFrom` 拒绝 |
| `signal/watcher.service.spec.ts`（copy 组） | create+`copyFrom`：掩码头值还原为源行原值（密文解密比对）、改名后的掩码键报错、POST body 缺省继承源行、body 显式新值覆盖、删光请求头行=无头、源行非本人抛错；create 无 `copyFrom` 时行为零变化（回归） |
| `session/util/session-group-key.spec.ts` | SIGNAL 桶 `of()` 归属；`applyFilter` SIGNAL 桶 SQL + 四桶排除 signal（断言 params 不含 signal 会话）；`formatLabel`；`compareKeys` SIGNAL 排最后（本文件即现有排序护栏） |
| `session/util/session-group-filter-consistency.spec.ts` | fixtures 加 `row({ source: 'signal' })` 两种形态（CLOUD+projects 工作区、CLOUD+workspace NULL——后者才是哨兵会话实际形态，openRun 建会话不传 workspace），并仿「embed 会话不落入任何模式/工作区分组」补 signal 版断言。**这个 spec 才是防 §7 第 2 行「预览一次、展开多条、分页错乱」的护栏**（用 `testing/sql-where.ts` 内存求值 of()/applyFilter 一致性），勿只加 key.spec 的 toEqual 断言 |
| `session/session.service.spec.ts` / task-terminal 相关 spec | signal 会话终态 `unread` 不落 1（DB + WS 两路）；**保留行为回归**：signal 会话仍写收件箱条目（D1）、仍进任务通知外发准备 |
| `openapi/open-run.service.spec.ts` | mock 签名与 `toHaveBeenCalledWith(7, 5, null, 'CLOUD')` 断言随接口变更同改；补 SIGNAL 路第 16 参为 `'signal'`、API/WEBHOOK 路第 16 参为 `undefined` 的位置参数断言（防错位静默 bug，见 §7） |

前端 vitest：

| 文件 | 用例 |
|---|---|
| `utils/cloud-project.test.ts` | SIGNAL key 归属、label、icon、`compareKeys` 对应前端排序 |
| `views/settings/signal-watcher-form.test.ts` | `buildWatcherPayload` 新建/编辑两态对 triggerMode/reuseSessionId 的下发口径（编辑未改不动原值）；复制态下发 `copyFrom`、POST body 空则不下发 body 键（继承）、删光头行则 headers 为空对象语义 |
| `views/settings/SignalWatchersView.layout.test.ts` | radio 渲染；断言**不存在**会话选择器（模型 B）；「复制」按钮渲染；点击**不触发任何写 API**、打开新建对话框且预填（name 带「副本」后缀、敏感头为掩码行、body 占位文案）；提交时 payload 带 `copyFrom`；复制态 POST 空 body 可提交 |
| `components/inbox/InboxDrawer.test.ts` | `SOURCE_BADGES` 补 `SIGNAL: '信号哨兵'` 后断言哨兵触发的终态条目显示来源角标 |

E2E（Playwright）：设置页现有用例不触配额文案（已核实无断言）；如 settings-cards 覆盖哨兵卡片，改造后徽章变化需同步；跑 `bash scripts/e2e-setup.sh` 后按既有流程验证。

构建验证：`cd backend-ts && npm run build && npm test`；`cd desktop && npm run build`；`cd admin && npm run build`。

---

## 6. 文档同步（同任务完成）

- `CHANGELOG.md`：实施发版时在顶部新建版本条目（`### 后端`：取消哨兵数量上限、触发方式可配（复用=自己的会话）、复制继承（`copyFrom`）、`signal` 来源与独立分组、排除未读；`### 前端`：设置页触发方式 radio、列表复制（预填新建）、任务列表「信号哨兵」分组；`### 管理后台`：触发方式列）。历史 0.0.278 条目不改写。
- `skills/mao-cli/reference/signal-watcher.md`：规则表「数量/间隔」行删 20 上限；新增「触发方式」行（复用 = 自己的会话，首触自建、之后复用；切到新建再切回可重置）与「复制」行（点复制开预填表单，保存时带 `copyFrom` 继承敏感请求头与 body）；端点表 POST body 说明补 `triggerMode`/`copyFrom` 字段（`reuseSessionId` 系统维护，不接受提交）。
- `README.md`：:57 表格行与 :88 说明补触发方式、独立分组与「可一键复制」，删「每次触发都会新建一次 Agent 会话」的绝对表述（:88）。
- 本方案转「已确认」；首发方案 `2026-10-11-signal-watcher-technical-design.md` 顶部加「部分决策被 2026-10-27 增强方案修订」指针（历史内容不改写）。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 分组规则前后端零共享，漏一端静默分裂 | §3.3 清单逐项打勾；两端 spec 各加 SIGNAL 用例；label 兜底（`return key`）不会报错只会劣化，测试显式断言 label |
| `applyFilter` 四桶忘排除 signal → 分页错乱 | 照 embed 注释同款理由写进代码注释；`session-group-key.spec.ts` 断言四桶 params 含 `'signal'` 排除 + `session-group-filter-consistency.spec.ts` 加 signal 行防 of()/applyFilter 漂移 |
| `createSession` 位置参数错位 → `source='signal'` 静默丢失 | 装配层 `as unknown as` 强转使编译期不报警（§2 现状表）：接口声明镜像真实 16 参签名、调用处数清 11 个 `undefined`，spec 断言 `toHaveBeenCalledWith` 第 16 参为 `'signal'`（SIGNAL 路）与 `undefined`（API/WEBHOOK 路） |
| 复用指针失效（会话被删 / Agent 变更）→ 触发失败连败停用 | 触发前 `isReusableSession` 预检，失效即清指针自建，不计 `consecutive_failures`；改 Agent 保存时即清指针（§3.2.3） |
| REUSE 模式单会话消息无限增长，上下文膨胀 | 属既有会话能力（压缩/归档）范畴，本次不特殊处理；设置页文案提示「复用会话会持续累积上下文」 |
| `POST /v1/sessions` 误放 `signal` 来源 | 路由层显式白名单 `['web','embed']` 不联动（§3.3.1） |
| 取消上限后误建大量哨兵 → 轮询压力 | 调度器批量 50 + 单飞不变；上限取消是产品决策，接受 |
| 复制继承的敏感值解析失败（用户改了敏感头的键名） | 复用 `restoreMaskedHeaders` 既有报错「请求头 X 需要填写新的值」，强制重填而非静默丢凭据 |
| 复制态「body 留空」无法区分「沿用」与「主动清空」 | 文档约定空=沿用（body 无明文可预填，空是默认态）；要清空 body 就切 GET，`normalizeInput` 本就会清 |
| 回滚 | 代码 git revert；V174 列残留无读写（默认值兼容）；前端回滚后 SIGNAL 分组消失，哨兵会话回到「临时工作区」（key 规则随代码走，无脏数据） |

---

## 8. 验收标准

1. 新建第 21 个哨兵成功，设置页无上限提示，`countByUser` 相关代码与用例清零。
2. 哨兵可选「每次新建会话 / 复用会话」；复用模式下首次触发自动创建自己的会话、之后复用（轮询记录 `triggeredSessionId` 相同），busy 时自动排队不失败；「切到新建再切回」可重置复用会话；改 Agent 后指针清零、下次触发自建。
3. 哨兵会话出现在任务列表「信号哨兵」分组，排在所有分组最后；无该会话时不出现该组。
4. 哨兵会话终态无未读红点、不进聚焦置顶；收件箱仍写入终态条目并显示「信号哨兵」来源角标，外发通知照旧；`WATCHER_DISABLED` 停用通知照常。
5. 既有普通会话、embed、飞书/钉钉/微信通道会话的分组、未读、通知行为零变化（回归 spec 全绿）。
6. `backend-ts` build+test、`desktop`/`admin` build、E2E 全绿；CHANGELOG、mao-cli reference、README 同步。
7. 列表「复制」不调用写 API，打开预填的新建对话框（name 带「副本」后缀、非敏感字段原值、敏感请求头为掩码行、POST body 占位提示沿用）；保存后新哨兵敏感请求头与 body 与源一致（密文解密比对相等）、基线为空、状态 ACTIVE；掩码键被改名后保存被拒并提示重填；`copyFrom` 非本人被拒。

---

## 9. 决策点确认结果（2026-10-27）

| # | 决策点 | 确认结论 | 落地位置 |
|---|---|---|---|
| D1 | 排除未读的范围 | **只排未读，保留收件箱与外发**：哨兵会话无未读红点、不进聚焦置顶；收件箱仍写终态条目（补「信号哨兵」来源角标），失焦仍弹系统通知，外发照旧 | §3.4；`task-terminal.service.ts:132-135`、`session.service.ts:1444-1448`；`InboxDrawer.vue:58-62` |
| D2 | 新建哨兵的默认触发方式 | **NEW_SESSION**（保持现状语义，用户显式切复用） | §3.2.1 列默认值、§3.2.4 表单初值 |
| D3 | 复用模式频次上限 | **不分档**：两种模式统一每小时 4 次，超出照常触发 + `TRIGGER_RATE_LIMITED` warning | §3.2.4；`watcher.service.ts` 频次逻辑不动 |
| D4 | 新分组显示名与图标 | **「信号哨兵」+ Satellite 图标** | §3.3.2；两端 `formatLabel`、`TaskSessionGroupList.vue` |
| D5 | REUSE 模式编辑 Agent 致绑定失效 | 原口径「拒绝保存」**被 D8 模型 B 取代**：模型 B 无用户绑定，改 Agent 即清指针、下次触发自建 | §3.2.3 |
| D6 | 管理后台加「触发方式」列 | **加** | §3.2.4；`admin/src/views/signal/SignalWatcherListView.vue` |
| D7 | 副本的默认状态 | **ACTIVE**——复制走 create，`watcher.service.ts:136` 硬编码 `status:'ACTIVE'` 且基线置空，天然满足 | §3.6.3 |
| D8 | 复用模式的归属模型（用户提问：「不能是每个哨兵复用自己的会话吗？」） | **模型 B：复用自己的会话（自动）**——不选会话；首次触发自动创建并回写 `reuse_session_id`，之后复用；每个哨兵天然只复用自己的会话，复制零处理。放弃模型 A（表单绑已有会话，照 Webhook）：失败路径更多、与哨兵自包含形态不符 | §3.2.3、§3.6.4 |
| D9 | 复制成功后的交互 | **自动打开表单**：点复制即开预填的新建对话框（不调写 API），用户改完保存走 create | §3.6.2 |
| D10 | 副本命名 | **表单内命名**：name 预填「{源名} 副本」，用户在自动打开的对话框里改；无服务端命名、无命名弹窗 | §3.6.2 |
