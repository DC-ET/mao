# Embed SDK 对话浮窗 · 历史会话列表技术方案

- 日期：2026-09-11
- 状态：已实施（分支 feat/embed-sdk-history-session-list）
- 涉及端：backend-ts（后端）、sdk/embed（Web Embed SDK）
- 不涉及：desktop UI、admin、android、agent-cli 的功能变更（仅 SDK 构建产物随 desktop 部署）

---

## 1. 需求背景

Web Embed SDK（`MaoChat.init()`）目前采用「每用户每 agent 一个常驻会话」模型：
sessionId 持久化在 localStorage（`sdk/embed/src/core/session-manager.ts`），用户点「新对话」
会新建会话并替换本地记录，旧会话保留在服务端（desktop 会话列表可见），但浮窗内**没有任何
入口可以回到旧会话**——旧会话一旦被替换，对浮窗用户来说等于丢失。

随着 SDK 在业务系统中的使用加深，用户在同一业务页面内会累积多轮独立的对话诉求
（例如先后问两个不相关的问题，期间还想回头追问前一轮）。需要一个历史会话列表，
支持在浮窗内直接切换回历史会话继续对话。

## 2. 需求描述

### 2.1 一句话需求

SDK 对话浮窗增加历史对话列表功能，支持切换到历史会话继续对话；列表只显示
**当前用户、当前 agent、由 SDK 创建**的会话。

### 2.2 要做的

1. **会话来源标记**：`session` 表新增来源字段；SDK 创建会话时标记 `source=embed`，
   以此作为历史列表的过滤依据。
2. **存量常驻会话惰性回填**：SDK 启动恢复 localStorage 中记录的常驻会话时，后端将该
   存量会话补标为 `embed`（更早被「新对话」替换掉的旧会话无法可靠识别，**不追溯**）。
3. **后端列表接口扩展**：`GET /v1/sessions` 新增可选过滤参数 `agentId`、`source`，并支持
   不依赖 groupKey 的 `offset/limit` 分页；不传新参数时行为完全不变。
4. **浮窗历史列表面板**：标题栏「新对话」旁新增「历史」入口，以覆盖层形式展开会话列表；
   列表项为「标题 + 相对时间」，按 `updated_at` 倒序，每页 20 条，滚动到底自动加载下一页；
   列表顶部提供「新对话」项。
5. **会话切换**：点击列表项切换会话——本地 unsubscribe 旧会话 → subscribe 新会话，
   进行中任务在服务端继续跑完不中断；切回时通过 REST 重拉历史完成对账；
   localStorage 常驻会话指针同步更新。
6. **放开运行中限制**：流式输出进行中，「新对话」按钮与历史切换均允许操作（两者规则统一）。
7. **每次打开面板刷新列表**，不缓存跨打开周期的列表数据。

### 2.3 明确不做的

- ❌ 会话搜索、删除、重命名、置顶、归档、未读标记（列表只有「看 + 切」两个动作）。
- ❌ 显示 desktop 端创建的会话（`source` 过滤保证）。
- ❌ 按宿主站点（嵌入页域名）隔离会话——同一用户同一 agent 在所有接入站点共享列表。
- ❌ 追溯标记历史遗留的已替换会话。
- ❌ 切换会话时终止或提示终止进行中的任务。
- ❌ 跨浏览器页签的实时列表同步（沿用现有 TabsCoordinator 语义：localStorage 指针更新，
  其他页签下次操作时自然读到新值）。
- ❌ desktop / admin 端会话列表的任何改动（它们看不到 `source` 字段差异，行为不变）。
- ❌ 边路任务（side task）：列表只返回主会话，后端过滤 `session_type`。

## 3. 技术选型与现状分析

### 3.1 为什么用「来源字段」而不是「按 agent 过滤全部会话」

- `session` 表目前没有任何字段区分会话来自哪个端（desktop / embed SDK / 机器人通道）。
  需求方已确认列表只含 SDK 自建会话，因此必须落库标记，客户端侧无法从现有数据推导。
- 仅按 `userId + agentId` 过滤会把 desktop 创建的工作会话混进浮窗列表，干扰性强，
  已被需求方明确排除。
- 不采用「按宿主站点隔离」：需要宿主传站点标识并存库，成本高，且当前无此隔离诉求。

### 3.2 为什么扩展现有 `GET /v1/sessions` 而不是新建专用接口

- 现有路由已具备 `requireUserId` 归属过滤、`enrichSessions`（agent 名/待审批计数等聚合）、
  groupKey 分页实现；扩展查询参数复用全部既有逻辑，改动集中在
  `session.routes.ts` / `session.service.ts` / `session.repository.ts` 三处。
- 新建 `/v1/sessions/embed` 需要复制路由、enrich、分页三套逻辑，后续双处维护，无收益。

### 3.3 切换会话复用的既有机制

| 既有机制 | 位置 | 在本方案中的用途 |
| --- | --- | --- |
| WS subscribe/unsubscribe 帧 | `ws-client.ts` / `StreamingWsHandler` | 切换时换绑事件流 |
| REST 重拉历史 + 对账 | `controller.ts`（断线重连对账） | 切回会话时还原消息与工具状态 |
| `session_snapshot` 终态对账 | controller | 处理切换期间已结束的任务残留状态 |
| localStorage 常驻指针 | `session-manager.ts` | 切换后更新「最近会话」，下次打开默认恢复 |
| TabsCoordinator | `core/tabs.ts` | 多页签下避免重复建会话，切换后指针一致 |

## 4. 详细设计

### 4.1 数据模型（迁移 `V109__add_session_source.sql`）

```sql
ALTER TABLE `session`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'web'
  COMMENT '会话来源：web=桌面/Web 端创建，embed=Embed SDK 创建'
  AFTER `session_type`;

CREATE INDEX idx_session_user_agent_source_updated
  ON `session` (`user_id`, `agent_id`, `source`, `updated_at`);
```

- 列值枚举：`web`（默认，覆盖 desktop/常规 Web 创建）、`embed`。机器人通道会话
  （feishu/weixin）沿用默认值 `web`，本方案不为其引入新枚举。
- 已有的 `user_id` 查询路径不受影响；新索引服务 embed 列表查询的过滤+排序。

### 4.2 后端接口

#### 4.2.1 创建会话带来源：`POST /v1/sessions`

- 请求体新增可选字段 `source?: 'embed'`；缺省落 `web`。
- 仅接受 `embed` / 不传 两个取值，其他值返回参数错误（不做白名单扩展点）。
- 落库写入 `session.source`；会话 VO（`session-vo.ts`）透出 `source` 字段。

#### 4.2.2 存量惰性标记

- SDK 恢复 localStorage 常驻会话走 `GET /v1/sessions/:id`。方案：SDK 在 boot 恢复
  成功后，若该会话 VO 的 `source !== 'embed'`，调用新增的
  `PUT /v1/sessions/:id/source`（body: `{ source: 'embed' }`，仅允许 `web → embed`
  单向迁移，归属校验复用 `requireSessionOwner`）打标记。
- 该接口不暴露给 desktop/admin 使用，桌面端不感知。

#### 4.2.3 列表接口扩展：`GET /v1/sessions`

新增可选 query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agentId` | int | 过滤指定 agent 的会话 |
| `source` | string | 过滤来源，仅接受 `web` / `embed` |
| `offset` / `limit` | int | 分页；与 `agentId` 或 `source` 任一同时使用时生效，`limit` 上限 50，默认 20 |

行为约定：

- 三个新参数**全部不传**时，走现有逻辑（groupKey 分支或全量列表），响应结构不变，
  desktop 不受影响。
- 传 `source=embed`（SDK 场景固定同时传 `agentId`）时：
  - 过滤条件：`user_id = 当前用户 AND agent_id = ? AND source = 'embed'
    AND session_type 为主会话 AND deleted = 0`；
  - 按 `updated_at DESC` 排序；
  - 响应结构：`{ items, total, offset, limit, hasMore }`，items 复用 `enrichSessions`；
  - 无 groupKey、keyword、status 参与（embed 列表不需要）。

### 4.3 SDK 会话层（`sdk/embed/src/core/`）

#### 4.3.1 `session-manager.ts`

- `createSession()` 请求体增加 `source: 'embed'`。
- 新增 `listSessions(offset: number): Promise<EmbedSessionPage>`：
  `GET /sessions?agentId={agentId}&source=embed&offset={offset}&limit=20`。
- 新增 `markSourceEmbed(id)`：恢复常驻会话后按 4.2.2 调用（VO 已是 embed 则跳过）。
- 既有 `resolveSession()` 语义不变：仍返回 localStorage 指向的「最近会话」。

#### 4.3.2 会话切换（`controller.ts`）

新增 `switchSession(id: number)`，步骤：

1. 若目标 id 等于当前会话 id，直接收起面板，不做任何网络操作。
2. `ws.unsubscribe(旧会话)` → `ws.subscribe(新会话)`（复用现有断线重连的
   全量 re-subscribe 数据结构，保证重连后订阅的是新会话）。
3. 清空内存中的消息/工具状态 → `GET /sessions/{id}` 校验可访问 →
   REST 拉取历史消息（复用现有历史映射逻辑 `loadHistory`）。
4. 等待 `session_snapshot` 到达完成终态对账（复用现有机制）；
   若原会话有进行中任务，任务在服务端继续执行，切换期间事件不再接收。
5. `sessionManager.writeStoredSessionId(新id)` 更新常驻指针。
6. 失败路径：任一步骤抛错则回退订阅到原会话并提示「切换失败」，不产生半切换状态。

#### 4.3.3 放开运行中限制

- `ChatPanel.vue` 中「新对话」按钮移除 `:disabled="running"`；
- `controller.newSession()` / `switchSession()` 内部不做 running 拦截。

### 4.4 SDK UI（`sdk/embed/src/ui/`）

- **入口**：`ChatPanel.vue` 标题栏「新对话」按钮左侧新增「历史」图标按钮（沿用
  `mao-panel__btn` 样式），点击切换面板可见性。
- **面板**：`HistoryPanel.vue`（新增），绝对定位覆盖消息区（不遮挡标题栏与输入区）：
  - 顶部固定「新对话」项（图标 + 文案），点击等价于现有 newSession 后收起面板；
  - 列表项：会话标题（超长省略）+ 相对时间（如「3 分钟前」「昨天」）；
    当前活跃会话高亮标识；
  - 滚动容器触底时按 `offset` 递增加载下一页；`hasMore=false` 后显示「没有更多了」；
  - 首次打开与每次重新打开均重新拉取第一页；加载中显示既有三点脉动样式。
- **新增 SDK 实例方法**：`MaoChatInstance.toggleHistory()`（可选暴露，对齐现有
  open/close/toggle 命名），同时更新 `types.ts`。
- 文案、主题色、圆角等全部复用 `theme.ts` / `style.css` 既有变量，不引入新样式体系。

### 4.5 边界与并发

| 场景 | 处理 |
| --- | --- |
| 列表为空 | 面板居中显示「暂无历史对话」，仅保留顶部「新对话」项 |
| 会话在列表加载后被删除（另一端操作） | 点击时 `GET /sessions/{id}` 报 3002/1002 → 从列表移除该项并提示「会话已不存在」 |
| 多页签同时打开 | 各页签独立拉列表与切换；localStorage 指针最后写入者生效，TabsCoordinator 既有约束不变 |
| 运行中切换后再切回 | 依赖 `session_snapshot` 对账 + REST 历史重拉，不维护切换期间的事件缓存 |
| `limit` 超限 / 非法 `source` | 后端 400 参数错误；SDK 侧固定传合法值 |
| SSO 模式 | 无差异：列表接口走同一 REST 鉴权；scope 仅影响 localStorage key，不影响服务端数据 |

## 5. 实现步骤

1. **迁移与实体**：新增 `V109__add_session_source.sql`；`session/types.ts` Session
   增加 `source` 字段；repository 创建/查询 SQL 适配。
2. **后端接口**：`POST /v1/sessions` 支持 `source`；`PUT /v1/sessions/:id/source`；
   `GET /v1/sessions` 扩展 `agentId`/`source`/`offset`/`limit`；`session-vo.ts` 透出 `source`。
3. **后端测试**：routes/service/repository 单测——新参数过滤正确性、不传参数行为回归、
   分页边界、source 非法值、PUT source 单向迁移与归属校验。
4. **SDK 核心层**：session-manager 扩展（source、listSessions、markSourceEmbed）、
   controller `switchSession` 与运行中限制放开，配套 vitest 单测（切换成功/失败回退/
   目标会话已删除/同会话幂等）。
5. **SDK UI**：HistoryPanel.vue + ChatPanel 接线 + 相对时间工具 + 组件测试。
6. **构建产物与版本**：`sdk/embed/package.json` 版本 `0.1.1 → 0.2.0`；构建并将产物
   同步至 `desktop/public/embed/`（`mao-chat.js` + 版本化副本 `mao-chat.v0.2.0.js`）。
7. **文档同步**：CHANGELOG.md 顶部新版本小节（用户/运维可见改动）；README.md / 相关
   SDK 文档；skills/mao-cli 若涉及 SDK 说明则同步。

## 6. 落地清单

### 6.1 文件改动清单

| 层 | 文件 | 动作 |
| --- | --- | --- |
| 迁移 | `backend-ts/db/migration/V109__add_session_source.sql` | 新增 |
| 后端 | `backend-ts/src/session/types.ts` | 修改（Session.source） |
| 后端 | `backend-ts/src/session/session.repository.ts` | 修改（创建写 source、列表过滤/分页） |
| 后端 | `backend-ts/src/session/session.service.ts` | 修改（listSessions 扩展参数） |
| 后端 | `backend-ts/src/session/session.routes.ts` | 修改（POST source、PUT source、GET 列表参数） |
| 后端 | `backend-ts/src/session/session-vo.ts` | 修改（VO 透出 source） |
| 后端 | `shared/contracts/src/session.ts` | 修改（契约类型） |
| 后端 | `backend-ts/src/session/*.spec.ts` | 新增/修改（回归 + 新行为测试） |
| SDK | `sdk/embed/src/types.ts` | 修改（InitOptions 不变，Instance 增 toggleHistory） |
| SDK | `sdk/embed/src/core/session-manager.ts` | 修改 |
| SDK | `sdk/embed/src/core/session-manager.spec.ts` | 修改 |
| SDK | `sdk/embed/src/controller.ts` | 修改（switchSession、放开限制、恢复时打标） |
| SDK | `sdk/embed/src/controller.spec.ts` | 修改 |
| SDK | `sdk/embed/src/ui/HistoryPanel.vue` | 新增 |
| SDK | `sdk/embed/src/ui/HistoryPanel.spec.ts` | 新增 |
| SDK | `sdk/embed/src/ui/ChatPanel.vue` | 修改（历史入口、放开新对话禁用） |
| SDK | `sdk/embed/src/ui/ChatPanel.spec.ts` | 修改 |
| SDK | `sdk/embed/package.json` | 修改（0.2.0） |
| 产物 | `desktop/public/embed/mao-chat.js`、`mao-chat.v0.2.0.js` | 重新构建同步 |
| 文档 | `CHANGELOG.md`、`README.md`、`skills/mao-cli/SKILL.md`（如涉及） | 修改 |

### 6.2 验证清单

- `cd backend-ts && npm run build && npm test`：含列表新参数回归（不传参数行为不变）。
- `cd sdk/embed && npm test`（vitest）：session-manager / controller / UI 组件测试。
- 手动验证（demo 页 `sdk/embed/demo/index.html`）：
  1. 新建 ≥ 2 个会话 → 历史面板可见两条，当前会话高亮；
  2. A 会话流式输出中切到 B → 输入框可用，切回 A → 内容与工具状态完整还原；
  3. 运行中点「新对话」→ 新会话创建，A 任务不受影响；
  4. 滚动加载分页、空列表、目标会话已删除三个边界；
  5. 刷新页面 → 默认恢复最后一次活跃会话；
  6. desktop 会话列表行为与之前完全一致（回归）。

### 6.3 发版与部署

- 后端随常规后端发版（迁移在启动时自动执行，`FLYWAY_ENABLED` 机制不变）。
- SDK 产物部署 = `desktop/public/embed` 更新后执行 `bash scripts/deploy-desktop.sh`
  （静态资源，无需重启后端）；宿主页面引用的 `mao-chat.js` 为固定文件名，天然热更新。
- 版本号仅用于产物溯源（版本化副本文件），宿主无需改引用。

## 7. 风险与限制

1. **旧会话不可恢复入口**：上线前被「新对话」替换掉的 SDK 会话不会出现在列表中
   （无法可靠识别来源），这是与需求方确认过的取舍。
2. **切换期间事件丢失是预期行为**：任务在服务端跑完，切换期间的过程事件不补推，
   切回时看到的是结果态；与 desktop 跨会话语义一致。
3. **`source` 为字符串枚举**：后续若新增来源（如机器人通道细分），需同步扩展校验白名单，
   本方案不做预留抽象。
