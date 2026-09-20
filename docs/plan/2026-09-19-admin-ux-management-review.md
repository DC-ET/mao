# 管理后台 UX 与管理功能评审

- 日期：2026-09-19
- 状态：**已全部修复**（2026-09-19，随 0.0.156 发布）。少数条目按代码查证结论做了调整：#7 角色删除需后端补 `DELETE /roles/:id`（前端已留 TODO）；#6 按角色筛选用户需后端 `roleId` 参数（前端以提示条占位）；#38 上传逐包失败明细需后端扩展返回结构；其余全部落地。
- 范围：`admin/src/views/` 全部 15 个路由页面（含子组件/对话框）+ 全局 Layout/SideMenu，并交叉对照 `backend-ts/src/` 对应路由与服务能力。
- 方法：逐页通读源码，标注问题；重点识别「后端已有能力、前端未暴露」与「前后端双重不一致」两类高价值缺陷。所有条目均有代码位置佐证，无臆测项。

## 问题总览（按优先级）

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 1 | 安全/数据破坏风险 |
| P1 | 8 | 管理能力缺口、后端已有能力未暴露 |
| P2 | 12 | 前后端能力错配、信息展示缺失 |
| P3 | 14+ | UX 一致性、表单校验、加载反馈等细节 |

---

## P0 安全与数据破坏

### 1. 系统 Skill 的删除/上传完全没有权限控制

- 位置：`admin/src/views/skill/SkillListView.vue:111` + `backend-ts/src/skill/skill.routes.ts:110-135`
- 问题：后端 `DELETE /v1/skill-docs/:name`、`POST /v1/skill-docs/upload` 只做 `requireUserId`，未校验任何权限码；对比同文件注册的个人 Skill 路由删除需 `agent:write`。即**任何登录用户都能删除或覆盖系统级技能**，且删除时级联从所有 Agent 中清理 `skillName`（`skill.routes.ts:122-135`），破坏面大。前端佐证：系统 tab 的删除按钮没有 `:disabled="!canWrite"`，而个人 tab 的删除按钮有，前后端双重不一致。
- 建议：后端给 skill-docs 写接口加 `agent:write`（或专用 `skill:write`）；前端系统 tab 删除按钮补 `canWrite` 守卫，与个人 tab 对齐。

---

## P1 管理能力缺口（含后端已有能力未暴露）

### 2. 审计日志缺时间范围与按用户筛选——后端已支持但前端未暴露

- 位置：`admin/src/views/audit/AuditLogView.vue:151-154`（filters 定义）
- 问题：后端 `audit.routes.ts:11-14` 已解析 `userId`/`startDate`/`endDate`，`audit.repository.ts:42-60` 已实现对应 SQL 过滤，但前端 filters 只有 action/objectType/success，无日期选择器、无用户下拉。审计场景「某人在某段时间做了什么」是最高频追查诉求。`/admin/sessions/options/users` 接口在 SessionListView 已有现成调用可复用。
- 建议：补 `el-date-picker`（日期范围）与用户下拉，随查询参数透传。

### 3. 运行态会话接口 `/v1/admin/runtime/sessions` 无任何前端调用方

- 位置：`backend-ts/src/admin/admin.routes.ts:107-141`（接口）；`admin/src/views/analytics/tabs/OverviewTab.vue:158-164`
- 问题：后端专门提供运行态会话列表接口（默认筛 RUNNING/RESUMING/WAITING_APPROVAL/FAILED/CANCELLED），admin 前端 grep 不到任何引用；Overview「运行态」卡只有数字，且只有「查看失败会话」链接（`/sessions?phase=FAILED`），「运行中」「等待审批」两个实时数字不可点击下钻。
- 建议：「运行中/待审批」数字加链接跳会话列表（SessionListView 已支持 `?phase=` query），或接入 runtime/sessions 做实时运行态面板。

### 4. 会话列表无终止/归档/删除等运维操作

- 位置：`admin/src/views/session/SessionListView.vue:60-68, 193-200`；后端 `session.routes.ts:272-276, 316-321`、`session.service.ts:450, 728`
- 问题：后端已有 `DELETE /v1/sessions/:id`、`PUT /v1/sessions/:id/archive|unarchive`（目前要求 owner，说明服务层 deleteSession/archiveSession 能力已具备），admin 列表只有「查看」。失败/卡死的会话（FAILED/RUNNING 挂起）既不能终止也不能清理。
- 建议：至少为失败会话提供删除（带确认弹窗），并在 admin 路由侧评估补 admin 鉴权的归档/删除端点。

### 5. 飞书机器人无连通性状态与测试能力，配置错误只能靠消息失败暴露

- 位置：`admin/src/views/feishu-bot/FeishuBotListView.vue`（整页）；后端 `feishu/monitor.service.ts:13-18`
- 问题：后端 monitor 维护长连接并有 onFailure/onReconnecting 状态回调，但 admin 路由既不暴露连接运行状态，也没有 test 端点；前端只能看到「启用/停用」和「Secret 已配置」（只代表存了值，不代表正确）。appId/appSecret 填错后机器人静默重连失败，管理员无从发现。
- 建议：后端暴露每个 bot 的连接状态（ready/reconnecting/failed + 最近失败原因），前端列表加状态列与「重连/测试」操作。本页最有价值的缺口。

### 6. 用户管理无删除、无批量操作、无角色/账号类型筛选

- 位置：`admin/src/views/user/` 整组；`backend-ts/src/user/user.routes.ts:33-40`
- 问题：后端 listUsers 只支持 keyword/status；前端无批量启用/禁用，大量账号开停全部逐条操作。列表已展示角色标签与本地/LDAP 类型，却无法按角色（如「找出所有管理员」）或账号类型筛选，需后端先支持。
- 建议：补批量启停（复用 `PUT /users/:id/status` 或后端批量接口）；后端增加按角色/账号类型筛选参数。

### 7. 角色无删除能力，也无成员查看

- 位置：`admin/src/views/permission/RolePermissionView.vue:33-39`
- 问题：前后端均无删除角色接口（permission.routes.ts 只有 create/update/assign），错误创建的角色永久残留；「用户数」列点不开，无法查看该角色下有哪些用户。
- 建议：后端补删除角色（校验角色下无用户）；前端「查看成员」跳用户列表并按角色预筛（依赖问题 6 的角色筛选参数）。

### 8. LLM 调用流水无导出，会话详情聊天记录无导出

- 位置：`admin/src/views/llm-call/LlmCallView.vue:85-96`；`admin/src/views/session/SessionDetailView.vue:18-23`
- 问题：作为计费/排障核心的调用流水无 CSV 导出；会话完整记录（含工具调用、思考过程）只能逐轮「加载更多」浏览，排查纠纷时无法留存证据。
- 建议：两页提供「导出当前筛选/全量」按钮（前端循环拉取生成 CSV/JSON/Markdown 下载）。

### 9. 系统设置页 secret 留空=不修改，但无法清除已设置的密钥

- 位置：`admin/src/views/settings/SystemSettingsView.vue:189-195`（saveCategory 的 secret 语义）
- 问题：批量保存时 secret 空串提交 null 表示「不修改」，界面上没有任何途径把一个已设置的 secret 清空/作废（例如轮换密钥后想清掉旧 Key）。
- 建议：为 secret 字段提供「清除」操作（后端 batch 支持显式置空），并在 UI 区分「未修改/已清除」状态。

---

## P2 前后端能力错配与信息展示缺失

### 10. MCP 服务器列表无分页

- 位置：`admin/src/views/mcp/McpServerListView.vue:394-405`（loadData）
- 问题：`GET /mcp-servers` 一次返回全量，前端无分页控件；服务器数量增长后首屏传输与渲染线性膨胀，与其他列表页的分页规范（ResponsivePagination）不一致。
- 建议：后端补分页参数，前端接入 ResponsivePagination。

### 11. 定时任务缺「立即执行」与执行历史查看，且 sessionId 无跳转

- 位置：`admin/src/views/scheduled-tasks/index.vue:296-306`（handleDelete/handleToggleStatus）
- 问题：列表只展示 `lastExecutionStatus` 聚合标签，无法查看历次执行的记录与失败原因；失败任务无「立即重试/立即执行」操作（若后端评估支持）；`ScheduledTask` 结构中有 `sessionId`，但任务与触发产生的会话之间没有任何跳转入口，排障断链。
- 建议：操作列补「查看会话」链接；与后端确认执行历史查询接口（或按 sessionId 跳会话详情间接查看）；评估立即执行能力。

### 12. LLM 调用流水从行数据无法跳转会话，反向下钻同样缺失

- 位置：`admin/src/views/llm-call/LlmCallView.vue:97-101, 173`；`SessionDetailView.vue` 全文
- 问题：行数据中有 `sessionId`（仅详情弹窗展示纯文本），表格列和操作列都没有「查看会话」入口；反向（会话详情 → 该会话的调用流水）也缺失。
- 建议：操作列增加「查看会话」链接（sessionId 非空时）；SessionDetail 信息卡增加「调用流水」入口。

### 13. 审计日志无跨页跳转，用户名不可点击

- 位置：`admin/src/views/audit/AuditLogView.vue:24-28`
- 问题：审计日志列出用户名但不可点击，无法跳到该用户的会话列表（`/sessions?userId=x`）或调用流水；对比 Analytics UserTab（`UserTab.vue:53, 63`）已实现同类跳转。objectType+objectId 也应能跳到对应管理页。
- 建议：用户名加下钻链接；详情弹窗补 `objectId` 展示（表落库字段，`audit.repository.ts:18`）。

### 14. Agent 列表未展示后端已返回的创建人

- 位置：`admin/src/views/agent/AgentListView.vue:30-50`；`backend-ts/src/agent/agent.routes.ts:227-233`
- 问题：后端 `toVO` 已查询并填充 `creatorName`（代价已付出），前端列表没有「创建人」列。「这个 Agent 是谁建的」是管理高频信息。顺带：后端 toVO 中 creator/experience/suggestedQuestion 是逐条查询（N+1）。
- 建议：列表增加创建人列；后端改批量查询。

### 15. Agent 提示词版本历史只显示操作人裸 ID

- 位置：`admin/src/views/agent/AgentPromptHistoryDialog.vue:27`；`backend-ts/src/agent/agent.routes.ts:100-104`
- 问题：后端只回传 `operatorId`，前端直接显示数字；对照本项目 admin 路由成熟做法（`/v1/admin/user-commands`、`/v1/admin/user-skills` 用 `userLookup.findByIds` 批量补 username），审计价值打折。
- 建议：后端 VO 补 `operatorName`（或前端映射）。

### 16. 模型列表无「默认模型」标识

- 位置：`admin/src/views/model/ModelListView.vue:65-77`
- 问题：后端返回 `isDefault`，筛选器也提供「默认/非默认」筛选项，但表格名称列徽标只有视觉/启用/协议三种 icon，筛出来也认不出哪个是默认模型。
- 建议：名称列加「默认」tag（同 AgentListView 做法）。

### 17. 用量分析明细被后端截断为 Top 20，前端无提示、无全量入口

- 位置：`admin/src/views/analytics/tabs/UserTab.vue / AgentTab.vue / ModelTab.vue`；`backend-ts/src/admin/admin.routes.ts:47`
- 问题：users/agents scope 默认 `limit=20`（上限 100），前端只在 header 小字写「Top {{ userRows.length }}」，没有「查看全部」入口，各表也无导出。
- 建议：limit 提升/远程分页，或提供跳转会话列表按条件看全量的入口，并补 CSV 导出。

### 18. 分析页下钻链接丢失统计周期上下文

- 位置：`admin/src/views/analytics/tabs/OverviewTab.vue:158-164`
- 问题：所有下钻链接（`/sessions?phase=FAILED`、`/llm-call?success=false` 等）不带时间范围，分析页看到「近 7 天失败 12 个」，点过去是全量列表，口径不一致。LlmCallView 已支持日期参数，可直接透传。
- 建议：下钻链接按后端能力透传 startDate/endDate。

### 19. 分析页跨页签模块级缓存永不失效

- 位置：`admin/src/views/analytics/composables/useScopeQuery.ts:16`
- 问题：`cache`/`inflight` 是模块级 Map 且跨组件存活，切走再切回时只要 loadedKey 命中就直接用旧数据，`fetchedAt` 可能是数小时前；刷新按钮是唯一出路。
- 建议：加 TTL（如 5 分钟过期）或在 onActivated 时强制刷新。

### 20. 飞书 Bot 编辑时可修改 appKey 且无唯一性预检

- 位置：`admin/src/views/feishu-bot/FeishuBotListView.vue:160, 240`
- 问题：`appKey` 是机器人内部唯一标识（表单 hint 自述），编辑时允许修改并随 PUT 提交；若与其他 bot 冲突或被 webhook/绑定关系引用，变更影响面大且无二次确认。
- 建议：编辑模式将 appKey 置只读（同 UserFormDialog 对 username 的处理），或修改时强确认。

### 21. 模型表单「供应商」纯自由文本，后端 providers 接口未复用

- 位置：`admin/src/views/model/ModelFormDialog.vue:24-30`；`backend-ts/src/model/model.routes.ts:60-63`
- 问题：后端已有 `GET /v1/models/providers`（列表页已用于筛选下拉），但表单里 provider 是自由输入框，同一供应商易被拼成 "openai/OpenAI/Openai"，导致筛选下拉碎片化。
- 建议：改为可输入的 `filterable allow-create` el-select，选项来自 providers 接口。

### 22. 指令管理两个 tab 全量拉取 + 纯前端过滤分页

- 位置：`admin/src/views/system-commands/SystemCommandListView.vue:303-319, 112-121, 438-443`
- 问题：系统指令和个人指令都是 GET 全量后前端 filter + slice 分页，后端 `listPersonalAll` 无任何条件参数；个人指令随用户增长持续膨胀。
- 建议：后端补 keyword/分页参数，前端真分页。

---

## P3 UX 细节与一致性

### 23. 全局布局无「修改密码」入口，退出登录无确认

- 位置：`admin/src/components/Layout.vue:57-67`（handleCommand）
- 问题：右上角用户下拉只有「退出登录」一项，直接执行无确认；本地账号管理员无法在后台修改自己的密码（需回到桌面端或其他途径），也不展示当前登录账号的角色信息。
- 建议：下拉补「修改密码」与当前角色展示；退出加二次确认。

### 24. 登录页无表单校验规则，错误提示依赖后端原文

- 位置：`admin/src/views/auth/LoginView.vue:12-27`
- 问题：用户名/密码输入框未绑定 `rules`（仅手写判空提示），输入格式错误只能等后端返回原文 message 直接 toast，异常码无差异化文案（如「账号已禁用」与「密码错误」文案区分）。
- 建议补 el-form rules 与差异化错误提示。

### 25. Agent 列表搜索框不支持回车触发查询

- 位置：`admin/src/views/agent/AgentListView.vue:19-25`
- 问题：UserListView、ModelListView、SystemCommandListView 的关键词输入框都有 `@keyup.enter="handleSearch"`，唯独 Agent 列表没有，交互不一致。
- 建议：补 `@keyup.enter`。

### 26. 默认 Agent 的删除按钮未前置禁用

- 位置：`admin/src/views/agent/AgentListView.vue:40, 217`；`backend-ts/src/agent/agent.service.ts:152-156`
- 问题：后端对 `isDefault === 1` 的 Agent 直接抛 `AGENT_IS_DEFAULT`，前端仍渲染可点击的「删除」按钮，操作后才报错。
- 建议：`row.isDefault` 时禁用删除按钮并加 tooltip 说明。

### 27. 模型表单 baseUrl 未设必填校验，编辑可随意切换模型类型

- 位置：`admin/src/views/model/ModelFormDialog.vue:162-165, 11-15`
- 问题：`baseUrl` 只有 pattern 校验（async-validator 对空值跳过 pattern），而创建接口 `body.baseUrl!` 必填，留空提交会得到后端异常而非表单内联错误。编辑对话框中 modelType 的 radio-group 未禁用，把已投入使用的文本模型改成语音/文生图会把 `supportsVision`、`isDefault` 强制归零（:209-211），使所有引用该模型的 Agent/Bot 语义错位。
- 建议：baseUrl 补 `{ required: true }`；编辑模式禁用类型切换，或切换时弹确认说明后果。

### 28. 权限勾选无分组、无搜索、无全选

- 位置：`admin/src/views/permission/RolePermissionView.vue:44-58`
- 问题：权限平铺为两列 checkbox grid，权限码增长后只能逐个找；角色编码无格式校验（前端只校验非空，后端 createRole 也直接透传，「ops admin」这类编码都能建进去）。
- 建议：按权限码前缀分组折叠 + 域级全选；角色编码统一 pattern 校验（如 `^[A-Z0-9_]{2,32}$`）。

### 29. 权限脏状态仅在切换角色时守卫，路由离开无守卫

- 位置：`admin/src/views/permission/RolePermissionView.vue:77-79, 110-117`
- 问题：`dirtyPermissions` 只用于行点击确认；点侧边菜单切页、刷新浏览器时未保存的权限修改直接丢失且无提示。
- 建议：补 `onBeforeRouteLeave` + `beforeunload` 守卫，保存按钮在脏状态下高亮。

### 30. 用户编辑对话框允许把自己禁用，报错时机后置

- 位置：`admin/src/views/user/UserFormDialog.vue:62-67`；`backend-ts/src/user/user.service.ts:69-71`
- 问题：列表页行内「禁用」按钮对当前用户做了 `isCurrentUser` 禁用，但编辑对话框里的「状态」开关没有同样守卫；后端虽有兜底，用户要等提交失败才看到错误。
- 建议：编辑当前登录用户时禁用该开关并注明原因。

### 31. 编辑模型可回填明文 API Key 的安全设计

- 位置：`admin/src/views/model/ModelFormDialog.vue:199-206`
- 位置（后端）：`backend-ts/src/model/model.routes.ts`
- 问题：`model:write` 权限下后端直接返回明文 Key 并回填输入框，任何拥有模型写权限的管理员都能看到所有供应商的生产密钥。
- 建议：至少改为「点击查看」式按需揭示，并考虑在审计日志记录查看行为。

### 32. 工具调用复制无成功反馈，复制的是截断文本

- 位置：`admin/src/views/session/components/ToolCallCard.vue:112-118, 131-133`
- 问题：`copyText` 无 Promise 处理：成功无提示，失败（非 HTTPS/权限拒绝）静默吞掉，用户误以为已复制；`.filter()` 走 `truncatedResult` 截断到 4000 字符，复制按钮复制的是截断后文本而非完整输出，却无任何提示。
- 建议：复制成功/失败给 ElMessage 反馈；超限时提示「仅复制已截断内容」或提供完整下载。

### 33. 用户消息折叠阈值仅按行数，单行超长文本不折叠

- 位置：`admin/src/views/session/components/MessageGroup.vue:139`
- 问题：`isUserLong` 只统计换行数 > 10，一条 5000 字的单行粘贴内容不会被折叠，直接撑爆版面；助手最终回复也没有折叠机制。
- 建议：阈值改为「行数 > 10 或字符数 > 800」。

### 34. 定时任务筛选区 UX 细节：状态开关行内混排、关键词不防抖

- 位置：`admin/src/views/scheduled-tasks/index.vue`（操作列与搜索表单）
- 问题：操作列的 el-switch（启/停）与删除 popconfirm 混在同一格，移动端易误触；关键词输入仅回车/查询触发（McpServerListView 已有 300ms 防抖输入即查），两页交互不一致。
- 建议：开关与删除分列或间距拉开；关键词与 MCP 页对齐防抖输入即查。

### 35. 指令/飞书 Bot 页写操作按钮无前端权限守卫

- 位置：`admin/src/views/system-commands/SystemCommandListView.vue:10, 70, 145`；`admin/src/views/feishu-bot/FeishuBotListView.vue` 整页
- 问题：新增/编辑/删除按钮无 `v-if` 权限/管理员显隐控制（后端 requireAdmin），有菜单访问权的管理员点击只会得到 403 提示；飞书 Bot 页还无任何搜索/筛选。
- 建议：按 isAdmin 或专用权限码控制按钮显隐；飞书 Bot 页补名称/appId 搜索。

### 36. Agent 表单下拉加载失败静默留空，头像上传无失败反馈

- 位置：`admin/src/views/agent/AgentFormDialog.vue:633-646, 474-491`
- 问题：Skills/MCP/模型下拉加载失败时仅清空数组，用户看到「没有可选项」而非「加载失败」，无法区分「系统没有技能」与「加载失败」；`uploadAvatar` 只有 try/finally 无 catch，上传失败无明确提示。
- 建议：下拉加 loading/失败重试；头像上传补 catch 提示。

### 37. 分析页非首次加载为纯转圈面板，趋势图缺 dataZoom，选中行无高亮

- 位置：`admin/src/views/analytics/AnalyticsView.vue:52-54`；`tabs/TrendsTab.vue:100-135`；`tabs/ModelTab.vue:163-171`
- 问题：非 overview 首次加载时整个区域是 280px 的 v-loading 空 div（白板转圈）；TrendsTab 内联的 call/quality 趋势图无 dataZoom（chart-options.ts 的 series/token 图 >30 天时启用，90 天视图 X 轴拥挤）；ModelTab 点击行切换 sceneModelId 后行无高亮、也无法清除选择查看全部模型。
- 建议：loading 区改 el-skeleton；趋势图抽公共 dataZoom 逻辑；选中行加 row-class-name 高亮 + hint 区「清除」按钮。

### 38. Skill 列表「校验」与「状态」两列信息重复，上传失败无差异化反馈

- 位置：`admin/src/views/skill/SkillListView.vue:85-96, 97-105, 432-447`
- 问题：两列都基于同一表达式 `row.filePath || row.folderPath` 判定（"通过/异常" vs "可用/不可用"），浪费列宽；上传部分成功部分失败时只有一条整体成败提示，无法定位哪个目录包缺 SKILL.md。
- 建议：合并两列或让「状态」反映真实运行态；后端返回逐包校验明细，前端列表化展示失败原因。

### 39. 审计日志列表无自动刷新选项

- 位置：`admin/src/views/audit/AuditLogView.vue:39-41`
- 问题：列表仅在手动点刷新时更新，作为排障页面不便盯实时故障。
- 建议：提供「自动刷新」开关（30s/60s 轮询）或「最近 N 分钟」快捷过滤。

### 40. 会话详情页信息卡无刷新、无关联下钻

- 位置：`admin/src/views/session/SessionDetailView.vue:41-52`
- 问题：信息卡没有手动刷新按钮（仅 keep-alive 激活时刷新）；用户名/Agent 名/模型名均为纯文本，不能跳用户会话列表、Agent 管理或调用流水。
- 建议：头部加刷新按钮；信息卡字段加下钻链接。

### 41. LLM 流水移动端卡片丢关键字段，模型下拉硬编码 200 条上限

- 位置：`admin/src/views/llm-call/LlmCallView.vue:151（移动端卡片区）, 380-384`
- 问题：`effort`/`protocol`/`retryCount`/`cachedTokens` 在移动端卡片完全缺失，失败排障时移动端看不到错误信息；模型筛选用 `page:1, size:200` 拉选项，超 200 条静默缺失；Agent 筛选是手填 ID 输入框，与 SessionListView 的 Agent filterable 下拉体验不一致。
- 建议：移动端卡片补 errorMessage/耗时/重试字段；模型下拉改远程搜索；Agent 改下拉（复用 options 接口）。

### 42. 会话列表顶部指标卡冗余

- 位置：`admin/src/views/session/SessionListView.vue:4-11, 353-366`
- 问题：「匹配会话」指标卡只重复分页 total，无信息增量，且移动端 media query 下单卡占半宽、右侧留白错位。
- 建议：移除该卡片，或扩充为各 phase 计数等多指标。

### 43. ThinkingBlock 无复制按钮，与其他组件不一致

- 位置：`admin/src/views/session/components/ThinkingBlock.vue:24-27`
- 问题：thinking 长文本只有内部滚动（max-height 400px），没有复制/下载手段，与 ToolCallCard 有复制按钮形成不一致。
- 建议：补复制按钮。

### 44. 分析页 SessionTab 执行模式直接渲染英文枚举

- 位置：`admin/src/views/analytics/tabs/SessionTab.vue:96-100`
- 问题：「会话结构」卡的执行模式行直接显示 `item.executionMode`（CLOUD/LOCAL 原文），而 `utils/labels.ts` 已有 `executionModeLabel`；同一卡内类型行有 typeLabel 翻译、模式行没有。
- 建议：复用 `executionModeLabel`。

---

## 修复路线建议

1. **第一批（安全 + 高价值缺口）**：#1 系统 Skill 权限、#2 审计日志筛选、#3 运行态会话下钻、#5 飞书 Bot 连接状态、#9 secret 清除。多数需要少量后端配合，前后端可同任务闭环。
2. **第二批（管理能力补齐）**：#4 会话运维操作、#6 用户批量/筛选、#7 角色删除与成员、#8 导出能力、#11 定时任务执行历史与跳转。
3. **第三批（体验一致性）**：P2/P3 中纯前端的条目（#10、#13、#14、#16、#19、#23、#25、#26、#27、#28、#29、#30、#32、#33、#34、#36、#37、#39、#40、#42、#43、#44），可按页面分批顺手修复。
4. **文档同步**：按 CLAUDE.md 约定，实施修复时需同步 CHANGELOG.md 与 `skills/mao-cli/`（涉及 CLI 可见能力时）。

