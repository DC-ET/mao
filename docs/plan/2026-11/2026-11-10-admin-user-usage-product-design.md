# 管理后台「用户用量」视图（用户管理模块内查看单用户用量分析）产品方案

- 状态：已实施（2026-11-11；初稿 2026-11-10，同日评审修订。§12 决策回填：D1=复用 analytics:read、D2=预算联动二期、D3=反链本期做、D4=custom 上限 365 天、D5=会话数卡二期）
- 日期：2026-11-10（修订 2026-11-11）
- 类型：产品方案（含技术要点；实施前细化为 technical-design）
- 关联能力：
  - 用量分析（admin `AnalyticsView`，六 scope：overview/trends/models/users/agents/sessions，权限 `analytics:read`）
  - 调用流水（admin `LlmCallView`，已支持 `?userId=&startDate=&endDate=` 深链过滤）
  - 桌面端「我的用量」（`UsageDrawer.vue`，消费 `/v1/llm-calls/me/summary|trends`）
  - 用量预算（budget 域，独立页 `BudgetView`，本期只读联动待定 §12-D2）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 用量数据 | `llm_call` 表（V113 起，每笔 LLM 调用一行）的聚合视图；Token / 成本 / 调用数的唯一事实源 |
| 成本 | `cost_micros` 折算，单位 = 模型价格填写口径；**未配价行 cost 为 NULL，聚合自动忽略**（成本合计会低估，展示需明示） |
| 连通性自检 | `scene = 'connectivity_test'` 的系统自检调用；**user_id 恒为 NULL**（`model.service.ts` 两处写入显式置空），结构上不进任何单用户聚合；「排除连通性」只存在于 admin 全局 analytics（默认排除，`admin-analytics.service.ts`） |
| 无归属调用（用户维度） | `user_id` 为 NULL 的行（连通性自检、语音合成等系统级调用）不进任何单用户聚合；群聊调用按 executionUserId 记到触发用户（V113 表注释口径） |
| 无归属调用（Agent 维度） | `agent_id` 为 NULL 的调用（压缩、标题生成等系统场景），Agent 维度聚合时单列兜底展示 |
| 周期 `UsageRange` | `today / yesterday / week / lastWeek / month / lastMonth / last7 / last30 / custom`（`llm-call.service.ts`，与桌面「我的用量」同枚举；`custom` 为闭区间日历日，上限 365 天对齐桌面 `MAX_CUSTOM_LOOKBACK_DAYS`） |

## 1. 需求背景

管理员在用户管理模块（用户列表 → 用户详情抽屉）希望直接回答这些问题，而不是切换到用量分析页跨页拼凑：

1. **画像**：这个用户最近用了多少 Token / 成本？重度还是轻度？
2. **异常**：失败率是否偏高？成本是否突增（趋势）？主要花在哪个模型 / Agent / 场景？
3. **排障**：某用户报「回答变慢 / 失败」，管理员想按用户快速看调用流水与会话。
4. **闲置**：账号是否长期未使用（间接参考最后登录 + 窗口内调用数）。

### 1.1 现状盘点：数据底座已齐全，缺的只是「按用户的出口」

| 已有能力 | 位置 | 说明 |
|---|---|---|
| llm_call 明细与聚合 | `backend-ts/src/usage/llm-call.repository.ts` | 聚合五法 `aggregateSummary`（总账，含成功/失败/取消/Token/缓存/成本/解码）/ `aggregateByModel` / `aggregateByScene` / `aggregateByAgent` / `aggregateTrend`（day/hour 分桶、后端补零）——**userId 必填首参、WHERE 强制注入**；`list`（分页流水）的 userId 为可选 filter |
| 单用户服务方法 | `llm-call.service.ts` `summaryForUser` / `trendsForUser` / `listForUser` | 桌面端「我的用量」已在用，服务层无登录态耦合（userId 是参数），admin 可直接复用 |
| 索引 | `idx_llm_call_user_created`（V113）、`idx_llm_call_agent_created`（V138） | 按 (user_id, created_at) 窗口聚合已覆盖，无迁移 |
| 全局用户排行 | `GET /v1/admin/analytics/users`（`analytics:read`） | UserTab 有活跃 / Token 排行 + 用户用量明细行，已深链 `/sessions?userId=`、`/llm-calls?userId=` |
| 调用流水按用户过滤 | `LlmCallView.vue` `applyQueryFilters` 已解析 `userId / startDate / endDate` 并透传请求参数；后端 `listForAdmin` 支持 `filter.userId` | 深链目标现成（含日期参数，无需补齐） |
| 会话列表按用户过滤 | `SessionListView` 读 `?userId=` query | 深链目标现成 |
| 汉化表 | `admin/src/utils/llmCallLabels.ts`（`Record<LlmCallScene, string>` 穷尽） | 场景中文标签直接复用 |

### 1.2 缺口

1. **用户管理模块零用量入口**：`UserListView` 操作列只有详情/编辑等，`UserDetailDrawer` 七个 Tab（会话/定时任务/快捷指令/个人技能/Git 凭证/环境变量/MCP 服务器）无一展示用量。
2. **admin 无单用户 summary / trends 接口**：现有 `/v1/llm-calls/me/summary|trends` 仅登录态取自己；`/v1/admin/analytics/*` 只有全局聚合，不能按单用户取总账+分布+趋势。
3. **契约未下沉**：聚合行与响应类型手写于 `desktop/src/api/index.ts` 879-976 行（`UsageTotals` / `UsageModelRow` / `UsageSceneRow` / `UsageAgentRow` / `UsageRange` / `UsageDateRange` / `UsageTrendBucket` / `MyUsageSummary` / `MyUsageTrends`；与后端字段逐一对齐、无 drift，仅命名不同），违反 AGENTS.md「跨端类型走 @mao/contracts」；admin 接入前应先收口。

## 2. 目标用户与核心场景

| 角色 | 场景 | 动作 |
|---|---|---|
| 管理员（日常巡检） | 用户列表逐个查看用量规模 | 打开抽屉 → 用量 Tab → 默认 last30 统计卡一眼读数 |
| 管理员（异常排查） | 某用户反馈「失败多 / 变慢」 | 用量 Tab 看失败率与趋势 → 点「调用流水」深链（自动带 userId + 周期日期）→ 定位失败行 |
| 管理员（成本管控） | 评估某用户成本主要构成 | 按模型 / 按 Agent 分布表 → 决策是否配价、是否设预算（跳预算页为二期 §12-D2） |
| 管理员（用量分析页反查） | 在 UserTab 排行看到某用户 token 异常 | 操作列「用量详情」回跳用户管理抽屉的用量 Tab（闭环） |

## 3. 目标与非目标

**目标**
1. 管理员在用户详情抽屉内 **≤2 次点击、≤1 秒** 读到单用户指定周期的用量画像（总账 + 分布 + 趋势）。
2. 单用户聚合与调用流水、桌面端用户自查对同一用户同一窗口的 Token、成本、调用数**一致**（连通性自检天然不含，见 §8）。
3. 零新增表、零迁移（聚合与索引全部复用）。

**非目标（本期不做）**
- 计费账单 / 导出报表（成本口径是「模型价格填写口径」，非计费口径，导出易引起歧义）。
- 跨用户对比页（用量分析 UserTab 排行已承担）。
- 实时流式 / 秒级数据（llm_call 落库即为准，轮询/手动刷新足够）。
- 预算编辑与超限管理（budget 域已有独立页；本期最多只读联动 §12-D2）。
- 桌面端 / Web 用户侧改动（用户看自己的用量已有 UsageDrawer）。

## 4. 方案选型

| 选项 | 描述 | 评价 |
|---|---|---|
| **A. 抽屉新增「用量」Tab**（推荐） | `UserDetailDrawer` 增加 tab，懒加载 summary/trends | 上下文（用户身份、其他 Tab）不丢；与现有「会话 / 定时任务 / …」信息架构一致；改动集中在 drawer + 一个新组件 |
| B. 独立路由页 `/users/:id/usage` | 全屏单用户用量页 | 可分享 URL、版面大；但用户管理主路径是抽屉，独立页会割裂动线，且与 AnalyticsView 视觉重复 |
| C. 用量分析页全局加 userId 过滤 | AnalyticsView 各 Tab 支持单用户过滤 | 改六个 scope + 前端六 Tab，动刀面大；且「单用户画像」与「全局大盘」产品心智不同 |

**决策：A 为主方案**，配合两个深链闭环：
- Tab 内提供「调用流水」「会话列表」出口（复用既有 `?userId=` 深链，周期换算成 `startDate/endDate`；LlmCallView 已解析这两参数，直接拼 query）；
- 用量分析 UserTab 操作列增加「用量详情」回链（`/users?detail={userId}&tab=usage`），补齐「排行 → 单用户画像」反向动线（本期做，量小，§12-D3）。

## 5. 功能设计

### 5.1 入口与可见性

- Tab 名「用量」，位于「会话」之后（高频度仅次于会话）。
- **权限门控**：仅持有 `analytics:read` 的账号可见该 Tab（`authStore.hasPermission` 判定，无权限不渲染——与抽屉既有 `canManageContainer` 门控同模式）。权限决策见 §6.4 / §12-D1。

### 5.2 周期选择

- 顶部周期下拉：`今日 / 昨日 / 本周 / 上周 / 本月 / 上月 / 近 7 天 / 近 30 天（默认） / 自定义`。
- 枚举与后端 `UsageRange` 一一对应（复用 `parseUsageRange` 白名单）；`自定义` 展开起止日期（闭区间 YYYY-MM-DD，start ≤ end，上限 365 天对齐桌面）。
- 趋势粒度自动推导：`today / yesterday` 按小时分桶，其余按天（与 `trendsForUser` 粒度白名单一致）。

### 5.3 统计卡行（周期总账，`totals`）

| 卡片 | 字段 | 说明 |
|---|---|---|
| 总 Token | `totalTokens` | 千分位；副行「输入 X · 输出 Y · 缓存命中 Z」 |
| 总成本 | `cost` | 悬浮提示「成本 = 模型价格填写口径；未配价模型不计入，实际消耗可能高于此值」 |
| 调用次数 | `callCount` | 副行「成功 X · 失败 Y（成功率 %）· 取消 Z」；取消不计入失败与成功率分母（既有口径） |
| 解码吞吐 | `decodeTokens` / `decodeMs` | 前端派生吞吐（tokens/s，口径同桌面 `utils/throughput.ts` 的 `avgThroughput`）；无可解码样本显示 `-` |

### 5.4 分布区（三块并列，同一周期）

- **按模型**（`byModel`）：模型名 / 调用数 / Token / 成本，按 Token 降序。
- **按场景**（`byScene`）：场景名走 `llmCallLabels` 汉化表（编译期穷尽，新场景漏译 tsc 即报错）。
- **按 Agent**（`byAgent`）：`agentName` null 兜底「系统调用（压缩 / 标题等）」；已删 Agent 名字缺失兜底「已删除」。

### 5.5 趋势图（`trends.buckets`）

- 折线双序列：Token 与调用数（双 Y 轴）；失败率可选二期。
- 后端已补零，序列连续无缺口，前端直接渲染。

### 5.6 深链出口（Tab 底部操作区）

- 「查看调用流水」→ `/llm-calls?userId={id}&startDate={周期起}&endDate={周期止}`（LlmCallView `applyQueryFilters` 已解析这三个参数，直接拼 query）。
- 「查看会话」→ `/sessions?userId={id}`（已支持）。
- **按钮权限门控**：两按钮分别以 `hasPermission('llm-call:read')` / `hasPermission('session:read')` 判定，无权限不渲染（对应目标页的路由权限，避免「Tab 可见、点出 403」）。

### 5.7 反向入口（用量分析页）

- `UserTab` 操作列追加「用量详情」链接（现列宽 100 只放「调用流水」一个链接，调至约 150）；**用户名链接保持指向会话列表不动**（不破坏既有动线）。
- `/users?detail={userId}&tab=usage` 深链为**新增实现**：`UserListView` 挂载时解析 query（现状只解析 roleId）→ `GET /v1/users/:id` 取用户 → 打开抽屉并传 initialTab。

### 5.8 状态设计

| 状态 | 表现 |
|---|---|
| 加载 | Tab 内骨架屏（沿用 drawer 既有 `loadingTabs` 加载态 map；加载触发方式为懒加载——现状其余六个 Tab 是抽屉打开时全量预载，本 Tab 是首个懒加载 Tab） |
| 空数据 | 周期内无调用 → 统计卡全 0 + 趋势空态「该周期内无 LLM 调用」（区分于加载失败） |
| 请求失败 | Tab 内错误条 + 重试（不弹全局消息） |
| 用户不存在（已删） | 接口 404 → Tab 显示「用户不存在」（见 §6.5） |
| 无 `analytics:read` | 整个 Tab 不渲染（非置灰） |

## 6. 后端设计要点

### 6.1 新路由（复用服务层，零新查询逻辑）

```
GET /v1/admin/users/:id/usage/summary?range=last30&startDate=&endDate=
GET /v1/admin/users/:id/usage/trends?range=last30&granularity=day&startDate=&endDate=
```

- 直接调用既有 `llmCallService.summaryForUser(id, range, dateRange)` / `trendsForUser(id, range, granularity, dateRange)`（服务层 userId 本就是参数，桌面端同源）。
- 参数解析/白名单/`custom` 校验复用 `llm-call.routes.ts` 的 `parseUsageDateRange` / `parseGranularity` 既有工具（抽公共或同款实现）；路由层校验 custom 上限 365 天（对齐桌面 `MAX_CUSTOM_LOOKBACK_DAYS`）。
- 放置位置：新文件 `backend-ts/src/usage/llm-usage-admin.routes.ts`（或并入 llm-call.routes.ts，实施定）。审计：`/v1/admin` 前缀在审计拦截器白名单内、GET 记 READ 动作，只读接口自然留痕。

### 6.2 契约下沉（规范强制）

- 下沉到 `shared/contracts/src/usage.ts`（现仅含 `LlmCallScene`；先例：statistics.ts 由在线设备方案新建）：
  - 响应壳 `MyUsageSummary` / `MyUsageTrends`（现定义于 `llm-call.service.ts` 100-113 行附近）；
  - 聚合行 `LlmCallSummaryRow` / `LlmCallModelAggRow` / `LlmCallSceneAggRow` / `LlmCallAgentAggRow` / 趋势桶（现定义于 `llm-call.repository.ts` 77-139 行附近）；
  - 入参枚举 `UsageRange` / `UsageDateRange` / `TrendGranularity`。
- 后端 `llm-call.service.ts` / `llm-call.repository.ts` re-export 保持既有 import 路径；`desktop/src/api/index.ts` 删除手写副本（879-976 行的 `UsageTotals` / `UsageModelRow` / `UsageSceneRow` / `UsageAgentRow` / `UsageTrendBucket` 等，桌面命名与后端不同，改名由编译期兜底）改 `import type`。

### 6.3 连通性口径（评审更正：无需任何参数）

- **无需新增 `excludeConnectivity` 参数**：`connectivity_test` 行的 `user_id` 恒为 NULL（`model.service.ts` 两处写入显式置空），而单用户聚合 SQL 是 `WHERE user_id = ?`——连通性行结构上永远不进任何单用户聚合。
- 因此桌面 me/* 与本功能口径**天然一致**，服务层签名零改动；「排除连通性」只存在于 admin 全局 analytics（`admin-analytics.service.ts` 的显式 SQL 过滤）。

### 6.4 权限（D1）

- 复用 `analytics:read`（与用量分析、在线设备同语义：看聚合用量数据 = analytics 域读权限），不新增权限码、无迁移。
- **可见人群闭环**：本 Tab 实际可见人群 = `user:read`（用户管理页路由门）∧ `analytics:read`（Tab 门）；纯 `analytics:read` 角色到不了用户管理页，无需为其设计降级。
- 深链出口按钮按目标页权限二次门控（§5.6）；单用户调用流水细览由 `llm-call:read` 保护——本 Tab 只展示聚合，流水细览引导至既有 LlmCallView（权限体系不变）。

### 6.5 归属与存在性校验

- `:id` 非数字 → 业务码 `PARAM_INVALID`；用户不存在 → 业务码 `USER_NOT_FOUND`（均 HTTP 200 + Result code≠0，全站 BusinessException 口径；前端按 code 提示「用户不存在」）。不做越权问题（管理员本可见全部用户，权限由 `analytics:read` 把守）。

## 7. admin 前端设计要点

- 新组件 `admin/src/views/user/components/UserUsageTab.vue`：内部自持 `range` state + 两个请求（summary/trends 并行），切换周期即重拉；不进全局路由。
- `UserDetailDrawer`：
  - **懒加载为本期新增**：新增 `watch(activeTab)`，首次切到 usage 才请求；既有六个 Tab 保持 `handleOpen` 全量预载不动；
  - `handleOpen` 现硬编码 `activeTab = 'sessions'`，需改为接受 `initialTab` prop（§5.7 深链依赖）；
  - `destroy-on-close` 已有，关闭即释放组件状态。
- 统计卡/表格样式对齐 analytics 现有卡片风格；趋势图复用 `chart-options.ts` 的轴/图例/格式化 helper，双轴折线 option 参照桌面 `components/usage/trend-options.ts` 形态新写（chart-options 无现成双轴工厂）。
- 汉化：场景标签复用 `llmCallLabels.ts`；新枚举（若有）按 `Record<联合, string>` 穷尽规范。

## 8. 统计口径一致性（关键评审点）

| 口径 | 桌面「我的用量」（me/*） | 用量分析页（admin/analytics/*） | 本功能（admin/users/:id/usage/*） |
|---|---|---|---|
| 连通性自检 | **不含**（connectivity_test 行 user_id 恒 NULL，天然不进单用户聚合） | **不含**（全局聚合显式 SQL 排除，`excludeConnectivity !== false`） | **不含**（同桌面，天然） |
| 成本 | 价格填写口径，未配价不计 | 同左 | 同左 |
| 取消 | 计入调用数、不计失败与成功率分母 | 同左 | 同左 |
| 周期枚举 | `UsageRange` 九种 | `PeriodValue`（3/7/30/90 天滚动 + 日历周期） | `UsageRange` 九种（对齐桌面枚举，语义覆盖 analytics 子集） |
| 时区 | Asia/Shanghai | 同左 | 同左 |

> 评审更正：初稿认为桌面与 admin 存在连通性「口径分叉」——实际单用户层面天然一致（NULL 归属），无需任何对齐动作；全局 analytics 的排除逻辑是显式过滤，与本功能无关。

## 9. 边界与风险

| 风险 | 评估 | 对策 |
|---|---|---|
| 自定义跨度过大（如一年）聚合慢 | `idx_llm_call_user_created` 覆盖 (user_id, created_at)；单用户行数有限 | custom 上限 365 天（对齐桌面 `MAX_CUSTOM_LOOKBACK_DAYS`，§12-D4），超限 400 + 前端提示 |
| 未配价模型成本低估 | 既有口径（SUM 忽略 NULL） | 统计卡 tooltip 明示；不引入「估算成本」（避免拍脑袋价格） |
| 已删用户残留 llm_call 行 | userId 不外键 | 404 + 空态文案（§5.8） |
| 抽屉首开性能 | 现状 handleOpen 全量预载六 Tab，新增懒加载 Tab 不加重首开 | 懒加载为本期新增（§7）；`destroy-on-close` 已有 |
| hour 粒度跨大周期桶数爆炸 | trendsForUser 粒度白名单 day 兜底 | 粒度由前端按周期推导（§5.2），不暴露给用户 |

## 10. 测试要点

1. 后端：新路由权限（无 `analytics:read` 403）、参数白名单（非法 range 回落 last30；custom 起止**倒置交换**、缺省/非法格式回落；非数字 id → PARAM_INVALID 业务码）、用户不存在 → USER_NOT_FOUND 业务码（HTTP 200 Result 口径）、custom 超 365 天 PARAM_INVALID。
2. 回归锁：断言 `connectivity_test` 行（user_id NULL）不出现在任何用户的 summary/trends 中（结构上天然不含，锁住「写入侧不得给连通性行记 userId」的隐式契约）。
3. 服务层回归：契约下沉 re-export 后桌面端 summary/trends 行为零变化（llm-call.service.spec 现有用例继续通过）。
4. admin：Tab 权限可见性（无权限不渲染）、周期切换重拉、custom 展开校验（上限 365）、空态/错误态、深链 query（`?detail=&tab=usage` 打开抽屉定位）、场景/Agent 名兜底文案、深链按钮按 llm-call:read / session:read 门控。
5. E2E（可选）：管理员打开用户抽屉用量 Tab 断言统计卡渲染。
6. 验证环境：后端 vitest；admin 组件无既有测试范本则手测 + E2E 覆盖；Windows 本机 `npm test` 的存量平台性失败不作为阻塞口径（以 CI 为准）。

## 11. 实施清单

| 阶段 | 内容 | 粗估 |
|---|---|---|
| P1 契约与后端 | usage 契约下沉（含 desktop 手写副本删除）+ 新路由 + 参数解析 + 测试 | 0.5～1 天 |
| P2 admin Tab | UserUsageTab.vue（周期/统计卡/分布/趋势/空态）+ Drawer 集成 + 懒加载 + initialTab | 1 天 |
| P3 动线闭环 | UserTab 反链 + `/users?detail=` 深链解析 + 调用流水深链（日期参数已支持，直接拼 query）+ E2E | 0.5 天 |

### 11.1 发布与配套

- 纯增量（零迁移、零新权限码）：后端先行或与 admin 同发均可；admin 发版 = 部署 dist、刷新即生效；回滚 = 回退部署即可（无数据兼容问题）。
- P1 契约下沉触及 desktop：`desktop` 须 `npm run build`（vue-tsc -b）验证手写副本删除后无编译错。
- 按 AGENTS.md 同任务写 CHANGELOG（backend-ts / admin 两节）；本方案文档不属历史设计，实施后随任务更新。
- 不需要灰度/开关：新 Tab 仅对 `analytics:read` 账号可见，风险面即管理员小流量。

## 12. 开放决策（待评审拍板）

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| D1 | 权限码 | `analytics:read`（复用，零迁移） | `user:read`（跟模块走，但语义上用量 ≠ 用户管理）；新增 `usage:read`（过度设计） |
| D2 | 预算使用率联动 | 二期（budget 已有独立页与当期消耗查询，可在统计卡区加「预算余量」条） | 本期一起做（统计卡区直接渲染 usage_budget 当期消耗） |
| D3 | UserTab 反链 | 本期做（改动极小） | 二期 |
| D4 | custom 上限 | 365 天（对齐桌面） | 不限制（信任管理员） |
| D5 | 「涉及会话数」统计卡（`COUNT(DISTINCT session_id)`，一行 SQL） | 二期（抽屉「会话」Tab 已有列表与总数，信息增量小） | 本期一起做（增强闲置画像） |
