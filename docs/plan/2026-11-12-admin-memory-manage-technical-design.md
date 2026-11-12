# 管理后台用户记忆管理能力补全技术方案

- 状态：草案（2026-11-12；同日评审结论：需求与方案均可行，评审补充已并入正文并标注「评审补充/评审更正」，待确认项见 §10）
- 日期：2026-11-12
- 关联方案：
  - [2026-10-02-long-term-memory-technical-design.md](./2026-10-02-long-term-memory-technical-design.md)（记忆系统 P1 总设计；其 §5.4「管理后台只读审计」由本方案 supersede）
  - [2026-09-24-admin-permission-catalog-design.md](./2026-09-24-admin-permission-catalog-design.md)（管理后台 read/write 权限码对模式）
  - [2026-11-10-admin-online-devices-technical-design.md](./2026-11-10-admin-online-devices-technical-design.md)（admin 新页面/新端点先例）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 记忆条目 `memory_item` | 一行长期记忆：`content` + `scope`（USER/PROJECT）+ `status`（ACTIVE/DISMISSED）+ `source`（AUTO/MANUAL） |
| 生效中 / 已忽略 | `status=ACTIVE`（注入系统提示词）/ `DISMISSED`（保留但不注入；软拒，可恢复） |
| 自动 / 手动 | `source=AUTO`（任务收尾由 LLM 抽取沉淀）/ `MANUAL`（用户手写；管理员代建同归此类） |
| dedup_hash | `SHA-1("{scope}\|{projectKey ?? ''}\|{规范化 content}")`，同用户唯一（`uk_memory_dedup`） |
| 200 上限 | 单用户 ACTIVE 状态记忆总量上限 `MEMORY_ACTIVE_LIMIT=200`（D7），DISMISSED 不占名额 |

## 1. 需求背景

### 1.1 现状：管理后台只有只读审计

记忆系统 P1 交付时（技术方案 §5.4），管理后台定位为「只读审计」：

| 层 | 现状 | 位置 |
|---|---|---|
| 后端 | 仅 `GET /v1/admin/memory?userId=&page=&pageSize=&scope=&status=`，注释明示「仅查询，不提供任何写接口」 | `backend-ts/src/admin/admin.routes.ts:181-218` |
| 权限 | 仅 `memory:read`（V129 种子，注释「无对应 write 码：admin 仅只读」） | `backend-ts/db/migration/V129__memory_item.sql:29-36` |
| 前端 | `MemoryAuditView.vue`：顶部固定提示「仅供治理用途……本页面为只读，不提供任何修改能力」；按 userId 手输查询 + 分页表格 | `admin/src/views/memory/MemoryAuditView.vue:3-10` |
| Service | `MemoryService.listForAdmin()` 直接透传用户域 `list()`，硬编码 `projectKey: null` | `backend-ts/src/memory/memory.service.ts:97-100` |
| 文档 | mao-cli 参考「仅查询，无任何写接口」 | `skills/mao-cli/reference/memory.md:76` |

管理能力（增、删、改、忽略/恢复、自动收集开关）只存在于用户自己的桌面端设置页（`/v1/memory` 系列，`desktop/src/views/settings/MemoryView.vue`），且全部接口归属校验为 `user_id = 当前登录用户`，管理员无法代操作。

### 1.2 缺口

**缺口一：无写能力，错误记忆只能等用户自己清理。**
记忆会被注入后续所有会话的系统提示词（用户级 8 条 + 项目级 12 条，`updated_at` 倒序）。自动抽取（AUTO）存在抽错、抽旧的风险（模型误判、项目事实过期），一条错误的用户级记忆会持续污染该用户所有会话，而普通用户不一定知道去设置页清理。管理员目前没有任何干预手段。

**缺口二：检索筛选简陋，找不到该管的记忆。**

| 现状 | 问题 |
|---|---|
| userId 必填且手输数字 ID | 管理员通常不知道用户 ID；无用户选择器/搜索 |
| 仅 scope / status 两个下拉 | 缺 `source`（自动/手动）过滤——「只看 Agent 自动抽错的」是最高频治理场景，恰恰筛不出来 |
| `projectKey` 过滤缺失 | 路由层硬编码 `projectKey: null`（`admin.routes.ts:198`），服务端仓库层其实已支持 |
| 关键词（keyword）缺失 | 仓库层 `buildFilter` 已支持 content/projectKey LIKE（`memory.repository.ts:198-204`），admin 路由未透传 |
| 无时间范围过滤 | 无法回答「最近一周新增/更新了哪些记忆」 |
| 恒按单用户查询 | `buildFilter` 首条件恒为 `user_id = ?`，无法跨用户列表，回答不了「全库 PROJECT 级记忆分布」「某关键词命中了哪些用户的记忆」 |

**缺口三：文案与补全后的能力不符。** 页面提示、路由注释、mao-cli 参考三处「只读/仅供治理用途」表述在能力补全后成为错误信息，需同任务移除/改写。

### 1.3 目标（本期全部交付）

1. 管理端记忆写能力：编辑内容、忽略/恢复、物理删除、代建（默认开放，见 D2）；
2. 检索筛选补全：用户搜索选择器、关键词、source、projectKey、更新时间范围、跨用户列表；
3. 权限读写分离：新增 `memory:write`，GET 维持 `memory:read`；
4. 写操作自动留痕（复用既有审计拦截器，零新增代码）；
5. 移除三处「只读/审计」文案，mao-cli 参考同步；
6. 不改动：用户域 `/v1/memory` 全部语义、注入链路、桌面/安卓/agent-cli、DB 表结构（零 DDL，仅权限种子）。

## 2. 方案总览

| 层 | 改动 |
|---|---|
| DB | 一条迁移 `V193__memory_admin_manage.sql`：`memory:write` 权限码种子（授 role_id=1）。零表结构改动 |
| 契约 | **零改动**：`MemoryScope`/`MemoryStatus`/`MemorySource` 已下沉 `shared/contracts/src/memory.ts`，admin 汉化表已是 `Record<契约联合, string>` 穷尽声明 |
| Service | `MemoryService` 新增 admin 方法族（`listForAdmin` 扩展 + `updateForAdmin`/`removeForAdmin`/`createForAdmin`），内部抽共用私有逻辑，复用既有全部校验（500 字、dedup、200 上限） |
| Repository | `buildFilter` 的 `user_id` 条件改可选（跨用户列表）；新增 `source` 与 `updated_at` 范围过滤 |
| REST | `admin.routes.ts`：GET 扩展查询参数；新增 `PATCH/DELETE /v1/admin/memory/:id`、`POST /v1/admin/memory`；新增轻量用户搜索 `GET /v1/admin/memory/users` |
| admin 前端 | `MemoryAuditView.vue` 改造为管理页（筛选区补全 + 行内编辑/忽略/恢复/删除 + 代建弹窗），按 `memory:write` 控制操作显隐；菜单 label 改「记忆管理」（D6） |
| 审计 | 零代码：`/v1/admin` 前缀已在 `AUDITED_PREFIXES`（`audit.interceptor.ts:7-18`），读写全量留痕 |
| 文档 | mao-cli `reference/memory.md` 同步；changelog 碎片；README 如有记忆段落同步 |

不改动：用户域 `memory.routes.ts`、注入链路（`prompt-engine.ts` / `listForInjection`）、抽取链路、桌面/安卓/agent-cli、部署脚本。

## 3. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 新增 `memory:write` 权限码，读写分离 | 与 V121 建立的 `xxx:read`/`xxx:write` 对模式一致（skill、command、mcp、feishu-bot 等均有先例）。管理他人记忆属高敏写操作，不应与只读审计同权 |
| D2 | 默认开放管理员代建（POST），列为待确认 | 「管理能力补全」的完整口径包含代建（如替用户补一条项目规范）。代建 `source=MANUAL`、受 200 上限与 dedup 约束，与用户手写同口径，无特殊风险面；若评审认为有滥用风险可砍掉，仅影响路由一个端点 |
| D3 | admin 改/删操作（PATCH/DELETE）目标用户由记忆 id 反查，不接受调用方传 userId（评审补充限定：POST 代建无行可反查，属例外——目标用户由 body.userId 指定并校验存在，见 §4.2/§4.4） | `memory_item.id` 全局唯一；少一个可篡改参数，杜绝「改 A 的请求写到 B」的越权形态 |
| D4 | admin 方法族放在 `MemoryService`，复用全部既有校验；不绕开 service 直连 repository | dedup、500 字、200 上限、DISMISSED→ACTIVE 限额（`memory.service.ts:156-159`）是记忆系统不变量，admin 必须同守。在 admin.routes 里自建校验必然漂移 |
| D5 | 跨用户列表（userId 为空）时，强制要求 keyword/scope/status/source/projectKey 至少一个非空 | `buildFilter` 去掉 `user_id` 条件后无索引兜底（见 §6.1），无条件全表 LIST 是全库泄露面，也是慢查询源 |
| D6 | 用户搜索选择器不依赖 `user:read`：新增 `GET /v1/admin/memory/users`（权限 `memory:read`） | 常见角色会有 memory:read 但无 user:read；且管理后台用户列表 VO 字段重，记忆页只要 id/username/displayName |
| D7 | 页面/菜单改名为「记忆管理」（`MemoryManageView.vue`），列为待确认 | 能力从审计变管理后，原页面名与「审计」文案均不合身；改名涉及 router（name/title/component）与 menuNav 两处（评审核对：chunk-reload.ts 为通用 stale-chunk 跳转逻辑，无路由名映射，无需改），成本低 |
| D8 | 不开放 admin 代改他人「自动收集」开关（`user_memory_preference`） | 属用户隐私偏好且影响后续自动抽取行为，与「治理已有记忆」不是一回事；桌面端用户自控。后续如需要可独立立项 |
| D9 | 编辑/恢复刷新 `updated_at` 的口径与用户侧完全一致，不特判 admin | 注入排序本来就走 `updated_at DESC`（用户编辑同样重排），admin 代编辑不引入新行为；注入输出顺序由 `listActiveUser` 内层截断 + 外层 `id ASC` 稳定（`memory.repository.ts:100-109`），重排不打破前缀缓存 |

## 4. 后端设计

### 4.1 迁移：`V193__memory_admin_manage.sql`

```sql
-- 管理后台记忆管理权限码（读写分离，模式同 V121）：
-- memory:read 已由 V129 授予 role_id=1；write 码同口径只授系统管理员，不向其他角色复制
-- （复制会导致原本只读审计的角色获得改他人记忆的能力）。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理用户记忆', 'memory:write', '编辑、忽略、恢复、删除、代建任意用户的长期记忆'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'memory:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` = 'memory:write';
```

同时修订 `V129__memory_item.sql:29` 的注释口径不在本期范围（历史迁移不改写；新迁移注释已说明 write 码由来）。

### 4.2 Service（`backend-ts/src/memory/memory.service.ts`）

**`listForAdmin` 扩展**：入参从 `(userId, query)` 改为 `(query)`，`query` 新增可选 `userId`（为空=跨用户）、`source`、`keyword`（已有）、`projectKey`（已有）、`updatedFrom`/`updatedTo`；直接透传仓库层，逻辑不变。

**新增 admin 写方法族**（内部重构：把 `create`/`update` 的躯体抽为私有方法，用户域与 admin 域共用，归属校验分歧外置）：

```ts
/** 管理后台：跨用户编辑内容 / 切换状态。id 不存在即 MEMORY_ITEM_NOT_FOUND；不做归属校验（D3）。 */
async updateForAdmin(id: number, input: { content?: string | null; status?: string | null }): Promise<MemoryItemVO>

/** 管理后台：跨用户物理删除。 */
async removeForAdmin(id: number): Promise<void>

/** 管理后台：代建。source 固定 MANUAL，与用户手写同口径（D2）。 */
async createForAdmin(userId: number, input: { scope: string; content: string; projectKey?: string | null }): Promise<MemoryItemVO>
```

重构口径：

- 现有 `requireOwnedRow(userId, id)`（`:246-256`）保留给用户域；新增 `requireRow(id)`：仅校验 id 合法 + 行存在（越权概念不适用，admin 本就跨用户）；
- `create()` 躯体抽 `private createInternal(userId, input, source: MemorySource)`，用户域 `create` 传 `'MANUAL'`，`createForAdmin` 同样传 `'MANUAL'`——两者行为完全一致，代建不享受任何豁免；
- `update()` 躯体抽 `private applyUpdate(row, input)`（内容规范化/校验、dedup 重算与冲突、status 解析、DISMISSED→ACTIVE 的 200 限额、事务两步写），用户域 `update` = `requireOwnedRow` + `applyUpdate`，admin 域 = `requireRow` + `applyUpdate`；
- `assertActiveLimit` / `assertContent` / `parseScope` / `parseStatus` / `parseProjectKey` / `computeDedupHash` 全部原样复用，admin 路径零校验分叉；
- 代建目标 userId 合法性（评审补充）：非正整数直接 `PARAM_INVALID`（路由层先行校验）；正整数但用户不存在时报 `USER_NOT_FOUND`（3014）——`memory_item` 建表无外键（V129），不校验会插入孤儿记忆行。校验放路由层：复用已注入的 `AdminUserLookup.findByIds([userId])` 非空判断，不为跨域存在性检查拓宽 `MemoryService` 构造器（存在性不是记忆不变量，不属 D4 范畴）；

### 4.3 Repository（`backend-ts/src/memory/memory.repository.ts`）

`page`/`count` 的 query 类型 `MemoryListQuery & { userId: number }` 改为 `{ userId?: number | null }`，`buildFilter`（`:183-206`）相应调整：

| 条件 | 改动 |
|---|---|
| `user_id = ?` | 仅当 `query.userId` 为正整数时追加（D5 的强制过滤由路由层保证，仓库层不重复裁决） |
| `source = ?` | 新增，`query.source` 非空时追加 |
| `updated_at` 范围 | 新增，`query.updatedFrom`/`updatedTo` 非空时按 `>= ?` / `<= ?` 追加；时间串由路由层规范化为 `YYYY-MM-DD 00:00:00` / `YYYY-MM-DD 23:59:59`（闭区间，与 admin 既有 date-range 口径一致） |
| scope / projectKey / status / keyword | 不变 |

`MemoryListQuery`（`types.ts:58-66`）同步补 `source?: MemorySource | null`、`updatedFrom?: string | null`、`updatedTo?: string | null`、`userId?: number | null`。

注入查询（`listActiveUser` / `listActiveProject` / `listActiveForDedup` / `listStaleAuto` / `listDismissedContents`）、`countActive`、`findByHash` 等全部为独立 SQL，不受影响。

### 4.4 路由（`backend-ts/src/admin/admin.routes.ts`）

**GET `/v1/admin/memory`（扩展，权限 `memory:read`）**

| 参数 | 必填 | 说明 |
|---|---|---|
| `userId` | 否 | 为空=跨用户列表，此时 keyword/scope/status/source/projectKey 至少一个非空（D5，否则 `PARAM_INVALID`；评审补充：updatedFrom/updatedTo **不计入**合格条件——updated_at 无索引，纯时间区间近乎全表 dump，见 §6.1）；提供但非正整数（0/负数/非数字）→ `PARAM_INVALID`，不静默按「跨用户」降级（评审补充：现状非法值返空列表，若静默降级，一次手误就把单用户查询放大成跨用户查询） |
| `keyword` | 否 | content / projectKey LIKE 包含匹配（仓库层已有，透传） |
| `scope` / `status` | 否 | 同现状白名单解析 |
| `source` | 否 | `AUTO` / `MANUAL` 白名单解析（模式同 `parseScopeFilter`） |
| `projectKey` | 否 | 去掉现状硬编码 `null`，透传 |
| `updatedFrom` / `updatedTo` | 否 | `YYYY-MM-DD`，闭区间 |
| `page` / `pageSize` | 否 | 同现状（≤100） |

username/displayName 补全逻辑（`:203-215`）从「单 userId」改为「页内 userId 去重集合」批量 `memoryUserLookup.findByIds`，跨用户模式下同样生效；lookup 失败仍静默降级（不影响列表返回）。

**GET `/v1/admin/memory/users`（新增，权限 `memory:read`）**

用户搜索选择器数据源（D6）：`?keyword=&pageSize=` → `{ records: [{id, username, displayName}] }`，`pageSize` 默认 20、上限 100（评审补充，与其余分页口径一致）。`AdminUserLookup` 接口（`:39-42`）新增 `search(keyword: string, pageSize: number)`；装配处（`app-routes.ts:670` 一带）传入基于 `UserService.listUsers` 的实现（其 `keyword` 参数已支持，评审核对），`keyword` 为空时按注册时间倒序取前 N 条（选择器初始态）。

**PATCH `/v1/admin/memory/:id`（新增，权限 `memory:write`）**

- Body：`{ content?: string, status?: 'ACTIVE' | 'DISMISSED' }`，与用户域 PATCH 同语义（编辑不改 status、DISMISSED→ACTIVE 须显式传、编辑重算 dedup_hash 冲突报 `MEMORY_CONTENT_DUPLICATE`）；
- `content` 非字符串返回 `PARAM_INVALID`（同 `memory.routes.ts:94-96` 口径，不 coerce）；
- id 不存在 → `MEMORY_ITEM_NOT_FOUND`（3033）。

**DELETE `/v1/admin/memory/:id`（新增，权限 `memory:write`）**

- 物理删除，语义同用户域 DELETE；id 不存在 → `MEMORY_ITEM_NOT_FOUND`。

**POST `/v1/admin/memory`（新增，权限 `memory:write`，D2）**

- Body：`{ userId, scope, content, projectKey? }`；`userId` 必填正整数；其余约束与用户域 POST 完全一致（PROJECT 必填 projectKey ≤128 且排除机器人渠道键、content ≤500、200 上限报 `MEMORY_LIMIT_EXCEEDED`、dedup 冲突报 `MEMORY_CONTENT_DUPLICATE`）。

`AdminRouteDeps`（`:44-50`）的 `memoryAuditor?: AdminMemoryAuditor` 接口相应扩展（`listForAdmin` 签名变更 + `updateForAdmin`/`removeForAdmin`/`createForAdmin`），`memoryUserLookup?: AdminUserLookup` 增加 `search`。两者继续可选，但（评审补充）三个写路由要求两者**同时装配**，缺任一返回 `INTERNAL_ERROR`（5001）：写操作没有「空成功」语义，静默返空会掩盖装配错误，且目标用户存在性校验依赖 lookup（见 §4.2）。生产装配（`app-routes.ts:670` 一带）恒同传，此分支仅为测试装配容错。

### 4.5 审计（零代码）

`shouldAudit()` 的 `AUDITED_PREFIXES` 已含 `/v1/admin`（`audit.interceptor.ts:14`）且不区分方法（命中即 return true，`shouldAudit` :33-48）——现状 GET 审计已在跑，新增的三个写方法自动获得：操作人（JWT）、方法、路径、objectId（路由参数）、状态码、成败、IP、时间。管理员事后可在「审计日志」页（`audit:read`）追溯全部记忆管理动作，无需在路由里手写 `auditService.record`。

## 5. admin 前端设计

### 5.1 路由与菜单

| 改动点 | 内容 |
|---|---|
| `admin/src/router/index.ts:124-127` | path `memory` 不变；`name: 'MemoryManage'`（原 `MemoryAudit`）；`component` 指向 `views/memory/MemoryManageView.vue`；`meta.title` 改「记忆管理」；`permission` 维持 `memory:read`；`keepAlive` 不变 |
| `admin/src/utils/menuNav.ts:77` | label 改「记忆管理」；`permission` 维持 `memory:read`（写按钮显隐走 §5.4，菜单只按读权限） |
| `admin/src/router/chunk-reload.ts` | 无需改动（评审核对：该文件为通用 stale-chunk 整页跳转逻辑，无路由 name/路径映射表；Layout 的 keep-alive 按 `route.path` 作 key、无组件名 include，视图改名无 keepAlive 影响） |
| `chunk-reload.spec.ts` / `menuNav.spec.ts` | 评审核对：两者均无记忆页 name/label 相关穷尽断言，无需同步（实施中若新增断言则跟随） |

### 5.2 页面（`admin/src/views/memory/MemoryManageView.vue`）

由 `MemoryAuditView.vue` 改造（非新建），整体结构沿用，变化如下：

**顶部说明**：移除「仅供治理用途……不提供任何修改能力」el-alert，替换为中性说明：「记忆会注入用户后续会话的系统提示词；管理操作将记入审计日志。」有 `memory:write` 时不显示只读提示；无 `memory:write` 时显示「当前角色只读」。

**筛选区**（`el-form inline`，全部变化即查询）：

| 控件 | 绑定 | 说明 |
|---|---|---|
| 用户选择 | `el-select` filterable remote | 数据源 `GET /v1/admin/memory/users`（D6），按 username/displayName 模糊搜；选中后带出 userId；可 clear（clear 后=跨用户模式，须配其他过滤，见 §6.1） |
| 关键词 | `el-input` | content/projectKey 包含匹配，回车触发 |
| 作用域 / 状态 / 来源 | 三个 `el-select` | 来源为新增过滤项，复用页面内已有 `SOURCE_LABELS`（原文件 :137-145 的 `SCOPE_LABELS`/`SOURCE_LABELS`/`STATUS_LABELS` 三张 `Record<契约联合, string>` 穷尽汉化表，零契约改动） |
| 项目标识 | `el-input` | 新增，projectKey 精确匹配 |
| 更新时间 | `el-date-picker type="daterange"` | 新增，`YYYY-MM-DD` 闭区间；用法同 `FeedbackView.vue`/`AuditLogView.vue` 既有日期区间 |
| 查询 / 重置 | `el-button` | 查询按钮在跨用户模式（userId 空）下，前端同步做 D5 预校验（至少一个其他过滤非空），不满足时 `ElMessage` 提示而不发请求 |

**表格**：列在现有（ID/用户/作用域/项目/内容/来源/状态/更新时间）基础上补 `originSessionId`（AUTO 来源的会话参照，纯展示 `#id`）；「用户」列跨用户与单用户两种模式统一保留（避免模式切换时列跳变，见 D10）。新增**操作列**（§5.4 控制显隐）：

| 操作 | 交互 | 调用 |
|---|---|---|
| 编辑 | `el-dialog`：content textarea（500 字计数）+ status 单选；提交 | `PATCH /admin/memory/:id` |
| 忽略 / 恢复 | 行内按钮，按 `row.status` 切换文案；直接调 | `PATCH /admin/memory/:id { status }` |
| 删除 | 行内按钮 → `ElMessageBox.confirm` 二次确认（文案明示物理删除、影响该用户后续会话注入） | `DELETE /admin/memory/:id` |

**代建**：卡片 header 右侧「新增记忆」按钮（§5.4 控制显隐）→ `el-dialog`：用户（remote select，同筛选区）、作用域、项目标识（PROJECT 时必填。注意 admin 无法代查该用户项目列表——`GET /v1/memory/projects` 返回的是当前登录管理员自己的项目，此处接受手输 key。评审更正：服务端 `parseProjectKey` 仅做格式校验（非空、非机器人渠道键、≤128 字），与用户域 POST 同口径，**不校验**该 key 在目标用户历史会话中出现过——弹窗文案须提示「填写该用户历史会话中出现过的项目标识」，手误产生的 PROJECT 记忆永不注入（死数据））、内容。提交 `POST /admin/memory`。

**反馈**：操作成功 `ElMessage.success` + 重置到第 1 页重查；`MEMORY_LIMIT_EXCEEDED`/`MEMORY_CONTENT_DUPLICATE` 的业务 message 由现有响应拦截器透出（不吞）；分页沿用 `ResponsivePagination`。

### 5.3 空态与边界

- 未选用户且无其他过滤：`el-empty`「请选择用户或输入关键词跨用户检索」（替代原「请输入用户 ID 查询」）；
- 有过滤无结果：「无匹配记忆」；
- 跨用户模式表格「用户」列展示 username/displayName（lookup 补全失败回落 `#userId`）。

### 5.4 写权限的按钮级控制

`admin/src/stores/auth.ts` 已暴露 `hasPermission(code)`（`auth.ts:26-28`）。页面内：

```ts
const canManage = computed(() => auth.hasPermission('memory:write'))
```

- `canManage` 为 false：操作列与「新增记忆」按钮整体不渲染，顶部显示只读提示；表格/筛选/分页完全可用（memory:read 语义不变）；
- 后端是权限的事实源，前端显隐只为体验；越权调用仍被 `requireRequestPermission(..., 'memory:write')` 拦 403。

## 6. 边界与风险

### 6.1 跨用户列表的查询面（D5 的量化依据）

`memory_item` 无 `user_id` 条件时，`idx_memory_user (user_id, scope, status)` 与 `idx_memory_project (user_id, project_key, status)` 均不可用：

- 规模上界：单用户 ACTIVE ≤200（原记忆方案 D7），DISMISSED 不占名额但受「负面约束集上限 50」的抽取约束（原记忆方案 D13）与手动忽略频率限制，量级有限；总行数 ≈ 注册用户数 × 百级以内，生产当前为千~万行量级；
- keyword LIKE（`content LIKE %..%`）在跨用户模式下必然全表扫描，但分页 `LIMIT 100` + 千行量级可接受；
- **护栏**：userId 为空时强制至少一个过滤条件（D5），把「无条件全库 dump」挡在路由层；keyword/scope/status/source/projectKey 任一即可让扫描带裁剪；
- 后续若行数上到十万级再评估引入 `updated_at` 索引或 ES，本期不做（YAGNI，参照 session 消息搜索的演进路径）。

### 6.2 200 上限对 admin 的口径

admin 恢复 DISMISSED→ACTIVE 与代建同样受 `assertActiveLimit` 约束（D4 复用），超限返回 `MEMORY_LIMIT_EXCEEDED`（3036），前端提示「该用户生效中的记忆已达 200 条上限」。这是**故意不开口子**：管理员批量恢复可以把限额击穿，进而让注入段固定截断到 8/12 条之外的旧记忆被挤出——与用户侧语义保持一致比方便管理更重要。

### 6.3 dedup 冲突

admin 编辑内容重算 hash 撞同用户其他行 → `MEMORY_CONTENT_DUPLICATE`（3035）。提示语与用户侧一致（「已存在相同内容的记忆」），不特殊处理。

### 6.4 管理员代操作的合规语义

管理员编辑/删除的是**他人个人数据**：写操作全量留痕（§4.5）是底线能力，页面删除确认文案必须明示「物理删除、不可恢复、影响该用户后续所有会话的注入」。代建（D2）若评审通过，同样留痕。

### 6.5 注入即时性与前缀缓存

编辑/恢复刷新 `updated_at` → 该用户下次会话注入排序可能变化（D9：与用户自己编辑同口径，非新增行为）；`listActiveUser` 外层 `id ASC` 保证注入顺序稳定，touch/编辑不重排输出，前缀缓存影响与用户侧编辑完全相同（评审更正引用：见 [2026-10-12-prompt-prefix-cache-optimization-technical-design.md](./2026-10-12-prompt-prefix-cache-optimization-technical-design.md) §3.4(d)，原文误写 §4.4）。

### 6.6 缺依赖装配的降级

`memoryAuditor`/`memoryUserLookup` 为可选依赖（现状如此）：未装配时 GET 返空列表；写路由按 §4.4 口径要求两者同时装配、缺任一返回 `INTERNAL_ERROR`（5001），不做「空成功」降级（评审补充）。新增的 `search` 挂在同一可选接口上，语义一致。

## 7. 测试

| 层 | 用例 |
|---|---|
| `memory.service.spec.ts` | ① `updateForAdmin` 改他人记忆成功（无归属校验但 id 不存在报 3033）；② 编辑重算 dedup 撞同用户其他行报 3035；③ DISMISSED→ACTIVE 受 200 上限约束（造 200 条 ACTIVE 后恢复报 3036）；④ `removeForAdmin` 物理删除他人记忆；⑤ `createForAdmin` source=MANUAL 且与用户 create 行为一致（同参数同结果）；⑥ 重构回归：用户域 create/update/remove 既有用例全绿（`createInternal`/`applyUpdate` 抽离无行为变化） |
| `memory.repository.spec.ts` | ① `buildFilter` 无 userId 时不产生 `user_id` 条件；② userId + source + updatedFrom/updatedTo 组合条件与参数顺序；③ keyword 与 source 叠加；④ 既有注入查询用例不受影响 |
| `admin.routes.spec.ts` | ① GET 新参数透传（keyword/source/projectKey/updatedFrom/updatedTo）；② userId 为空且无其他过滤 → PARAM_INVALID；③ userId 为空 + keyword → 跨用户查询且 username/displayName 批量补全（lookup 一次批量调用）；④ `GET /memory/users` keyword 透传 + 权限 memory:read；⑤ PATCH/DELETE/POST 无 memory:write → 403，有则放行；⑥ 非法 path id → 3033；⑦ content 非字符串 → PARAM_INVALID 不 coerce；⑧ 业务错误码（3035/3036）透传；⑨ userId 提供但非法（0/负数/非数字）→ PARAM_INVALID、不按跨用户降级（评审补充）；⑩ POST 目标用户不存在 → USER_NOT_FOUND（3014，评审补充）；⑪ 写路由缺可选依赖（auditor/lookup 缺一）→ 5001（评审补充） |
| 迁移 | `V193` 幂等（重复执行不插重复码）；role_id=1 获得 memory:write；其他角色不获得 |
| admin 前端 | `menuNav.spec.ts` / `chunk-reload.spec.ts` 穷尽断言同步；页面单测（如有）覆盖：跨用户模式 D5 前端预校验不发请求、无 write 权限不渲染操作列；`cd admin && npm run build`（`vue-tsc -b && vite build`，勿用 `npx vue-tsc --noEmit` 假通过） |
| E2E | 可选：admin 登录 → 记忆管理页可见、筛选可查（不断言具体数据） |

命令：`cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?`（grep `Test Files|Tests|FAIL` 摘要）。

## 8. 实施清单

| 文件 | 改动 |
|---|---|
| `backend-ts/db/migration/V193__memory_admin_manage.sql` | 新建：memory:write 种子（§4.1） |
| `backend-ts/src/memory/types.ts` | `MemoryListQuery` 补 source/updatedFrom/updatedTo/userId |
| `backend-ts/src/memory/memory.repository.ts` | `page`/`count`/`buildFilter` 支持可选 userId + source + 时间范围 |
| `backend-ts/src/memory/memory.service.ts` | `listForAdmin` 扩展；抽 `createInternal`/`applyUpdate`/`requireRow`；新增 `updateForAdmin`/`removeForAdmin`/`createForAdmin` |
| `backend-ts/src/memory/memory.service.spec.ts` / `memory.repository.spec.ts` | §7 用例 |
| `backend-ts/src/admin/admin.routes.ts` | GET 扩展 + 3 个写路由 + 用户搜索路由；`AdminMemoryAuditor`/`AdminUserLookup` 接口扩展；移除「仅查询、无写接口」注释 |
| `backend-ts/src/admin/admin.routes.spec.ts` | §7 用例 |
| `backend-ts/src/app-routes.ts`（:670 一带装配处） | `memoryUserLookup` 补 `search` 实现（基于 `UserService.listUsers`） |
| `admin/src/views/memory/MemoryManageView.vue` | 由 `MemoryAuditView.vue` 改造/改名（§5.2）；旧文件删除 |
| `admin/src/router/index.ts` | name/title/component 更新 |
| `admin/src/utils/menuNav.ts` | label 改「记忆管理」 |
| `admin/src/router/chunk-reload.ts` + spec | 路由名映射同步 |
| `skills/mao-cli/reference/memory.md` | 「管理后台」节改写：读写能力 + 新查询参数；删除「仅查询，无任何写接口」 |
| `README.md` | 管理后台功能清单/记忆段落同步（如有对应段落） |
| `changelog/unreleased/2026-11-12-admin-memory-manage.md` | 新建：「管理后台」小节——用户记忆管理能力（编辑/忽略/恢复/删除/代建 + 检索筛选补全，memory:write 权限，写操作留痕） |

无 desktop/android/agent-cli 改动、无表结构迁移、无 OTA。

## 9. 发布

1. 后端：`/opt/mao` pull 后重启（V193 随 TS 启动执行，FLYWAY_ENABLED）；
2. admin：`bash scripts/deploy-admin.sh`（rsync，无需重启），前端刷新/`version.json` 即生效；
3. 权限生效：`memory:write` 种子只授 role_id=1，现有管理员角色下次登录（或刷新 profile）后权限列表含新码；老角色只读不受影响。

## 10. 待确认项

| # | 事项 | 默认方案 |
|---|---|---|
| D1 | 权限：新增 `memory:write` vs 复用 `memory:read` 做全部操作 | 新增 write 码（§3-D1） |
| D2 | 是否开放管理员代建记忆（POST） | 开放（§3-D2） |
| D5 | 跨用户列表是否允许无条件查询 | 禁止，强制至少一个过滤条件（§3-D5） |
| D6 | 用户选择器：新增 `/admin/memory/users`（不依赖 user:read）vs 复用 `/v1/users`（依赖 user:read） | 新增轻量端点（§3-D6） |
| D7 | 页面/菜单改名「记忆管理」vs 保留「用户记忆」 | 改名（§3-D7） |
| D8 | admin 是否可代改他人「自动收集」开关 | 不做（§3-D8） |
| D10 | 单用户模式下「用户」列是否隐藏 | 保留展示（跨用户与单用户同一套列，避免模式切换列跳变） |
