# 角色技能授权技术方案

- 状态：已实现
- 日期：2026-11-24
- 评审：2026-11-24 补充斜杠菜单的真实调用方、空名单过滤、摘除接口改为异步、写入校验和技能名大小写。目标与数据模型未改。
- 一句话：系统技能继续以 Agent 为能力边界；角色可以按 Agent 追加专属系统技能。同一编程 Agent 上，开发、测试、数仓看到的技能不同，不必为每个岗位复制一份 Agent。
- 关联代码（撰写时已核实，均为当前工作区）：
  - Agent 共用技能只存在 `agent.skill_names`（JSON 数组）：`backend-ts/src/agent/types.ts:12`、`backend-ts/src/agent/agent.service.ts:107-108`、`:165-167`
  - 会话挂载只读这份名单：`backend-ts/src/harness/skill/skill-sync-service.ts:36`、`:169-177`（`resolveSkillNames`）
  - 提示词目录在挂载之后再解析一次，两处逻辑不共用：`backend-ts/src/harness/core/harness-service.ts:372`（先 `syncToSession`）、`:544-578`（再 `JSON.parse(agent.skillNames)` 与个人技能合并）
  - 斜杠技能菜单第三处解析：`backend-ts/src/command/command.routes.ts:96-115`、`:151-160`。`agentSkillNames.length > 0` 才过滤，空名单等于不过滤、列出全部系统技能
  - 桌面 / Web / 安卓实际调用不带 `agentId`，并在 composable 生命周期内只拉一次：`desktop/src/composables/useEditorTagPanels.ts:121-131`（`commandsLoaded`）。主会话、新建任务、边路任务、消息编辑各有自己的 Agent，不能共用 TaskView 注入的那一个
  - 个人技能对所有 Agent 生效，同名覆盖系统技能：`skill-sync-service.ts:41-48`；上传时拒绝与系统技能同名：`backend-ts/src/skill/user-skill.service.ts:210-216`
  - 技能视图按 (user, agent) 物化，路径不随技能名单变化：`backend-ts/src/harness/skill/skill-view.service.ts:101`（`ensureView`）
  - 删除系统技能只摘 Agent 名单：`backend-ts/src/skill/skill.routes.ts:190-204` → `agent.repository.ts:194`
  - 角色是权限角色，用户可多角色：`role` / `user_role`（`backend-ts/db/migration/V001__init_schema.sql:19-32`）；种子只有 `ADMIN`、`USER`（同文件 :190-191）。接口在 `backend-ts/src/permission/permission.routes.ts`
  - 管理后台：Agent 表单勾选 Skills（`admin/src/views/agent/AgentFormDialog.vue`）、Skills 列表「关联 Agent」（`admin/src/views/skill/SkillListView.vue:177`、`admin/src/composables/useAgentRelations.ts:62`）、角色页只有权限（`admin/src/views/permission/RolePermissionView.vue`）
  - 运行依赖的 ensure 只挂在 Agent 保存上：`agent.service.ts:121`、`:167`（`ensureForSkills`）
- 关联方案：[技能视图与容器隔离](./2026-11-03-skill-view-container-isolation-technical-design.md)、[容器隔离升到人 + Agent](./2026-11-07-user-agent-container-isolation-technical-design.md)。本方案不改视图路径、不改挂载键。

## 1. 现状与问题

系统技能能不能进一次会话，只看 `agent.skill_names`。个人技能在 `userskills/{userId}/`，对该用户的每个 Agent 都生效，并且同名时盖过系统技能。角色只承载权限点，和技能没有关系。

开发、测试、数仓共用一个编程 Agent 时，岗位专属技能没有落点：

- 把大数据技能勾进编程 Agent，三个岗位都会看到，技能目录进系统提示，命令和依赖也进会话。
- 为每个岗位复制一个编程 Agent，提示词、模型、工具、团队经验库、渠道绑定都会分叉。
- 管理后台可以把技能包写进指定用户的个人技能。那是一份拷贝，对所有 Agent 生效，系统技能更新不会跟着走，也不能按岗位收回。

会话实际用到的系统技能名今天有三处各自解析：`SkillSyncService.resolveSkillNames`、`HarnessService` 内联 `JSON.parse`、`command.routes.ts` 的 `resolveAgentSkillNames`。角色授权必须收成一处，否则挂载、提示词目录和斜杠菜单会不一致。

斜杠菜单这条今天在界面上并没有按 Agent 过滤。`GET /v1/quick-commands` 只有带了 `agentId` 才查 Agent 名单，而 `useEditorTagPanels` 不带这个参数，所以桌面、Web、安卓输入框看到的是全部系统技能，并且换 Agent 不会重拉。只改后端过滤、不改这个调用，岗位差异不会出现在菜单里。

群会话的执行身份已经是发言者，不是会话归属者（`prompt-engine.ts:699-706`：技能与凭据属于发言者）。个人技能按 `runtimeUserId` 取（`harness-service.ts:554`）。角色技能必须同一口径。

## 2. 目标与非目标

### 2.1 目标

1. 管理员可以把系统技能授权给角色，并限定作用的 Agent。`agent_id = 0` 表示该角色使用任何 Agent 都追加。
2. 一次会话的系统技能 = Agent 共用名单 ∪ 执行身份各角色在该 Agent 上的授权。多角色取并集。同名只出现一次。
3. 个人技能的既有规则不变：全部 Agent 生效，同名覆盖系统技能（不论这个名字来自 Agent 还是角色）。
4. 挂载、提示词目录、LOCAL 同步包、斜杠技能菜单、摘除检测使用同一份名单。
5. 技能视图仍按 (user, agent, skill) 物化。授权变化不重建容器，下一轮 `syncToSession` 增删软链。
6. 删除系统技能时，同时摘掉 Agent 名单和角色授权。删除 Agent 时，摘掉限定到该 Agent 的授权。
7. 管理后台角色页可维护授权；Skills 列表能看到被哪些角色引用。`mao role` 能查看和覆盖式保存授权。

### 2.2 非目标

- 不新增「技能组」或部门维度。岗位和权限是同一套角色时才用本方案。若线上角色只有「系统管理员 / 普通用户」，应新建开发、测试、数仓等角色再授权，不要把岗位技能挂到 `ADMIN` 或 `USER` 上。
- 不做拒绝名单。某技能只给数仓时，不要把它留在 Agent 共用名单里。
- 不把角色授权写回 `agent.skill_names`，也不按角色复制 Agent。
- 不改个人技能的存储、上传禁同名、以及对所有 Agent 生效的语义。
- 不改技能视图目录、容器挂载、经验库隔离。
- 不改桌面端技能管理里「系统技能」全量只读列表（`SkillManager.vue:32-35`）。那是技能目录，不是「本次会话可用」。会话里可用哪些，由提示词目录和斜杠菜单表达；斜杠菜单要改成按当前输入框的 Agent 过滤（见 §7）。
- 不改 `${技能名}$` 的展开条件。`prompt-engine.ts` 今天只要加载器、个人技能或 LOCAL 未同步技能里存在这个名字，就把标记换成 `/name`，不看本次会话名单。未授权的技能因此不会进入目录和挂载，手打标记也拿不到技能正文。收紧展开会改变「知道名字就能点名」的既有行为。
- 不改 `POST /v1/skills/sync-package` 的身份。路由已要求调用者就是会话归属者（`skill.routes.ts:218-225`），传给 `writeSyncZip` 的 `userId` 就是归属者。群里非归属者不走这条；群发言者的技能差在 CLOUD 的 `syncToSession`。
- 不改子代理。`background-subagent-manager.ts` 今天把 `availableSkillNames` 置空，本方案不动。
- 不做授权生效的主动推送。已打开的会话下一轮同步才增删技能，与今天改 Agent 技能名单的时效相同。
- 不给角色增加删除接口。当前角色没有删除入口（`permission.routes.ts` 只有创建、改名、赋权限、改成员）。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 授权语义 | 追加，不筛选。Agent 名单是所有使用者的基线，角色授权往上加 | 需求是岗位多出来的技能，不是从共用名单里藏技能。筛选要给每个技能定默认可见性，漏配会变成「Agent 上勾了却没人能用」 |
| D2 | 作用范围 | 每条授权必须带范围：某个 Agent，或全部 Agent（存 `agent_id = 0`） | 不带范围的角色技能会进写作、问答等无关 Agent，提示词和容器视图一起变脏 |
| D3 | 用哪套角色 | 复用 `role` / `user_role`，不建新主体 | 一个人可有多个角色，权限已经按并集合并。入职赋一次角色就同时得到权限和技能 |
| D4 | 多角色 | 并集。两个角色授了同一个技能，会话里一份 | 与权限并集一致。交集会让「又做开发又做数仓」的人两边都拿不到 |
| D5 | 身份 | 按执行身份 `runtimeUserId` 解析，不按会话归属者 | 与个人技能、执行身份段一致。群里数仓同学发言才带上大数据技能，会话创建者的角色不外溢 |
| D6 | 同名内容 | 角色与 Agent 点到同一系统技能目录，没有第二份内容。个人技能目录仍后写覆盖（`skill-sync-service.ts:41-48`） | 授权是「出不出现」，不是「用哪一版」 |
| D7 | 解析入口 | 只在 `SkillSyncService` 增加 `resolveSystemSkillNames(agent, userId)`。挂载、摘除、zip、Harness 目录、斜杠菜单都调它。Harness 删除内联 `JSON.parse` | 三处解析是当前会漂移的点。角色查询再复制两份会立刻分叉 |
| D8 | 存储 | 新表按技能名引用系统技能，不拷贝目录 | 系统技能更新后，现有视图指纹在下次同步重建。个人技能投放做不到这一点 |
| D9 | 名字校验 | 写入时 `isValidSkillName` 且 `skillLoader.hasSkill`；`agent_id ≠ 0` 时 Agent 存在且未软删。读的时候丢掉加载器中已没有的名字；当前 Agent 已软删时，再丢掉限定到该 id 的授权，`agent_id = 0` 保留 | 写入拒绝笔误。读时跳过是删除级联失败后的兜底，避免提示词列出挂不上的名字。正常会话加载不到已软删 Agent |
| D10 | 保存形态 | 覆盖式：`PUT` 的数组就是该角色的最终授权，与 `PUT /roles/:id/permissions` 相同 | 增量增删在并发保存时丢更新。角色授权条数预期很小 |
| D11 | 权限 | 读 `role:read`，写 `role:write`。不另加权限点，不要求 `skill:write` | 改的是授权，不是技能正文。`role:write` 已经能改角色成员。`GET /v1/skill-docs` 只需登录，角色页拉得到技能列表 |
| D12 | 依赖安装 | 保存授权时，把本次技能名交给现有 `ensureForSkills`（`agent.service.ts:121` 同一钩子） | 只通过角色授 `browser-use` 时，Agent 保存钩子不会跑，服务器依赖不会装。会话启动不补 ensure，避免每轮探测 |
| D13 | 目录顺序 | 先保持 Agent JSON 里的原顺序，再追加「仅来自角色」的名字，按名字升序。个人技能仍接在系统技能之后 | 角色查询的行序不稳定。只稳定排序新增部分，避免无意义地打乱已有提示词前缀 |
| D14 | 外键 | 不加数据库外键，删除由应用级联。与现有迁移一致（近期迁移无 `FOREIGN KEY`） | 技能名不是表主键，Agent 是软删 |
| D15 | 容器 | 不改隔离键，不因授权变更重建容器 | 视图路径已经是 `{userId}/{agentId}/{skill}`。名单变了只改目录内容，与改 `skill_names` 相同 |
| D16 | 斜杠菜单 | 输入框请求带上这条输入框所属的 Agent。带了 `agentId` 就按解析结果严格过滤，空名单表示没有系统技能。没带 `agentId` 仍全量列出 | 今天界面不带 `agentId`，后端过滤不会发生。`length > 0` 才过滤会让「共用技能为空」的 Agent 在菜单里仍看到全部系统技能，和提示词目录不一致 |

## 4. 生效规则

记执行身份为 `userId`，当前 Agent 为 `agentId`。

```text
agentNames   = agent.skill_names 里合法且加载器存在的名字（保持原顺序）
roleNames    = 该用户全部角色的授权中，
               (agent_id = 0 或 agent_id = agentId) 且技能仍存在的名字
systemNames  = agentNames，再按名字升序补上 roleNames 里还没有的
sessionNames = systemNames，再补上该用户个人技能里还没有的（个人技能同名时目录覆盖系统技能）
```

无授权、或 `userId` 为空：`roleNames` 为空，结果与今天相同。

例子：编程 Agent 共用 `git`、`code-review`。数仓角色只在该 Agent 上授权 `bigdata`。数仓同学的个人技能里有 `my-notes`。

| 使用者 | 编程 Agent | 写作 Agent |
|---|---|---|
| 数仓角色 | git、code-review、bigdata、my-notes | 写作 Agent 自己的共用技能、my-notes |
| 无此角色 | git、code-review、以及此人的个人技能 | 同上，没有 bigdata |

定时任务、飞书、嵌入页走同一条 Harness，不单开分支。任务和渠道会话的执行身份是谁，就用谁的角色。

## 5. 数据模型

下一版迁移号以落地时仓库里最大的 `V*` 为准。撰写时最大为 `V202__browser_live_replay_and_cleanup_settings.sql`，预期为 `V203__role_skill_grant.sql`。

```sql
CREATE TABLE IF NOT EXISTS `role_skill_grant` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `role_id`     BIGINT NOT NULL,
    `skill_name`  VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `agent_id`    BIGINT NOT NULL DEFAULT 0 COMMENT '0 = 全部 Agent；否则只在该 Agent 追加',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_role_skill_agent` (`role_id`, `skill_name`, `agent_id`),
    KEY `idx_role_skill_grant_agent` (`agent_id`),
    KEY `idx_role_skill_grant_skill` (`skill_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`skill_name` 用 `utf8mb4_bin`。技能目录在 Linux 上区分大小写，`isValidSkillName` 也允许大小写并存；库默认的不区分大小写排序规则会把 `Foo` 和 `foo` 收成同一行。`idx_role_skill_grant_skill` 给按技能名摘授权用，唯一索引的前缀是 `role_id`，盖不住这条删除。

`agent_id` 用 `0` 而不是 `NULL`：MySQL 唯一索引里 `NULL` 互不相等，同一角色可以把「全部 Agent」插进多次。

不给种子角色插入任何行。升级后行为与升级前一致。

## 6. 后端

### 6.1 模块

新增 `backend-ts/src/permission/role-skill-grant.repository.ts` 与 `role-skill-grant.service.ts`，由 `permission.routes.ts` 暴露 HTTP。不要放进 `skill/`：技能正文的上传删除仍归 `SkillDocService`，授权是角色域。

`RoleSkillGrantService` 对运行时只提供：

```ts
namesFor(userId: number, agentId: number): Promise<string[]>
```

实现：`user_role` 取出该用户的 `role_id`，再查 `role_skill_grant` 中 `role_id IN (...) AND (agent_id = 0 OR agent_id = ?)`。用户没有角色时不打第二枪，返回空数组。不建跨请求缓存，管理后台改完，下一轮同步就能读到。

`SkillSyncService` 构造注入这个查询（窄接口，测试里默认返回 `[]`）。接线在 `create-app.ts` 现有的 `new SkillSyncService(...)`。`resolveSkillNames(agent)` 保留为「只解析 Agent JSON」，供单测和「基线是什么」使用。新增：

```ts
resolveSystemSkillNames(agent: Agent, userId: number | null): Promise<string[]>
```

`userId == null` 或 `agent.id == null` 时退回 `resolveSkillNames`。否则按 §4 合并。加载器里不存在的名字丢掉，不放进 `failed`：授权行指向已下线技能是数据残留，不是这一轮挂载失败。

已软删 Agent 的过滤只看调用方手里的这份 Agent：`agent.deleted` 非 0 时，丢掉 `agent_id` 等于该 id 的授权，`agent_id = 0` 的行仍保留。正常会话经 `notDeleted()` 加载，到不了这条。不要为每条授权再查一次 Agent 表。

以下调用改为走 `resolveSystemSkillNames`：

- `syncToSession` 的 `systemNames`（`skill-sync-service.ts:36`）
- `getRemovedSkillNames` 的 `current`（`:127`）。漏改会把仍然授权的技能每轮报成已移除。这个方法今天是同步的，`streaming-ws-handler.ts:223` 的类型和 `:2706` 的调用也是同步的；内部要查授权后必须改成 `Promise<string[]>`，调用处 `await`。漏 await 时 `removed` 会变成 Promise，事件里变成 `{}`
- `writeSyncZip` 的 `systemNames`（`:191`），用户 id 用调用方已经传入的那个（同步包路由传入的是会话归属者）。漏改则 LOCAL 同步包没有角色技能
- `HarnessService` `:544-564` 的内联解析。系统技能段改为 `await resolveSystemSkillNames(agent, runtimeUserId)`，个人技能与 LOCAL 未同步技能的合并留在原地
- `command.routes.ts` 的 `resolveAgentSkillNames`。`GET /v1/quick-commands?agentId=` 用登录用户（`requireUserId`，即正在打字的人）和这份 Agent 做 `resolveSystemSkillNames`，按结果严格过滤：名单里没有的系统技能不出现，解析结果为空就没有任何系统技能。去掉 `agentSkillNames.length > 0` 才过滤的短路。未带 `agentId` 时维持今天的行为：系统技能全量列出。个人技能仍接在系统技能之后，同名仍由个人技能盖过描述。菜单只要求名字集合与本次系统名单一致，不按 D13 重排

`syncToSession` 里系统技能仍走 `ensureView(userId, agent.id, skillName, folder)`。角色技能不单独建视图维度。

### 6.2 HTTP

| 方法 | 路径 | 权限 | 行为 |
|---|---|---|---|
| GET | `/v1/roles/:id/skills` | `role:read` | 该角色全部授权。每项 `{ skillName, agentId }`，`agentId` 为 `0` 时表示全部 Agent。角色不存在 404 |
| PUT | `/v1/roles/:id/skills` | `role:write` | 正文 `{ grants: [{ skillName, agentId }] }`。覆盖该角色全部行。角色不存在 404，不写表。`grants` 缺省或不是数组时 400；`grants: []` 合法，清空该角色全部授权 |
| GET | `/v1/role-skill-grants` | `role:read` | 全表，供 Skills 列表反查。每项带 `roleId`、`roleName`、`skillName`、`agentId`。Agent 显示名由前端用已有 Agent 列表拼，不在这条接口里联结 Agent |

PUT 校验，任一失败整单 400，不部分写入：

- `skillName` 是字符串，通过 `isValidSkillName`，且 `skillLoader.hasSkill`
- `agentId` 省略或 `null` 存 `0`。出现时必须是 `>= 0` 的整数；字符串、负数、小数 400。`0` 表示全部 Agent。非 0 时 Agent 存在且未软删。停用但未软删的 Agent 允许授权，会话若仍在该 Agent 上，授权照常生效
- 请求内 `(skillName, agentId)` 不重复
- 同一 `skillName` 不能同时出现 `agentId = 0` 和某个具体 Agent。范围重叠时管理员无法判断哪条生效，直接拒绝

校验通过后，在一个事务里删除该 `role_id` 的旧行再插入新行。事务提交成功后再对本次 `skillName` 去重，调用与 Agent 保存同一个 `ensureForSkills` 注入。不要在事务里调用，失败不回滚已提交的授权（确保器今天自吞异常）。若技能运行依赖方案已把入口收成 registry，这里调那个 registry，不要绕过它直连 `BrowserDepsService`。确保器按名单自过滤，不含 `browser-use` 时今天就是空操作。

### 6.3 级联

- 系统技能删除成功之后（`skill.routes.ts:196` 现有摘 Agent 名单的位置）再删 `role_skill_grant.skill_name = ?`。内置技能删除仍 409，两处都不摘。
- `AgentService.deleteAgent`（`agent.service.ts:242`）在软删之前删除 `agent_id = 该 id` 的行。`agent_id = 0` 的行保留。
- 角色成员变化不改授权表。人离开角色后，下一轮 `namesFor` 自然不再返回。

## 7. 斜杠菜单

桌面、Web、安卓共用 `useEditorTagPanels`。`ensureCommandsLoaded` 带上这条输入框所属的 Agent，并在 Agent 变化时丢掉 `commandsLoaded` 再拉。四条输入框各用各的 Agent，不要 `inject` TaskView 提供的那一个：

| 输入框 | Agent 从哪来 |
|---|---|
| 新建任务（`ChatInput` 的 `isNewTask`） | 已有 prop `selectedAgentId`。还没选 Agent 时不带 `agentId`，菜单仍是全部系统技能 |
| 已有主会话 | 该会话的 `agentId`。停靠态上的 `selectedAgentId` 是新建任务的选择，不能拿来过滤 |
| 边路任务（`SideChatPanel`） | 这条边路任务自己的 `agentId`，经 prop 传入。它和主会话的 Agent 可以不同 |
| 消息编辑（`MessageEditEditor`） | 所编辑会话的 `agentId`。会话实体不在时不带 `agentId`，与今天一样列出全部系统技能 |

LOCAL 未上传技能仍由 `ensureLocalSkillsLoaded` 在客户端并进菜单，不进这次过滤。安卓没有单独的原生菜单。

## 8. 管理后台

角色页右栏（`RolePermissionView.vue`）改为两个页签：「权限」保持现状，「技能」仅在选中角色后可编辑。

技能页签：

- 顶部一句说明：这些技能会在该角色使用对应 Agent 时追加，不会写进 Agent 的共用列表。不要把岗位技能授给「系统管理员」或「普通用户」，否则所有持有该角色的人都会带上。
- 表格列：技能名、作用范围（「全部 Agent」或 Agent 名称）、移除。
- 添加一行：系统技能下拉（`GET /v1/skill-docs`）、Agent 下拉（`GET /agents?includeDisabled=true`，首项「全部 Agent」）、添加。
- 「保存技能」覆盖式提交当前表格。技能页签用自己的脏标记，不复用 `dirtyPermissions`。权限页已有未保存确认（切换角色、离开路由）。权限或技能任一未保存时，切换角色、切换页签、离开路由都要确认。只改了技能就切走，不能静默丢掉。
- 无 `role:write` 时表格只读，与权限勾选一致。

Skills 列表在「关联 Agent」旁增加「关联角色」。数据来自 `GET /v1/role-skill-grants`。无 `role:read` 或请求失败时该列为空，不挡住技能列表（与 `useAgentRelations` 的 fail-soft 相同）。气泡内一行一个引用，文案如「数仓 · 编程 Agent」「数仓 · 全部 Agent」。

Agent 表单的 Skills 勾选不变，文案补一句：这里是所有使用者的共用技能；岗位专属技能到「角色权限」里按 Agent 追加。

## 9. mao-cli

`skills/mao-cli/reference/role.md` 增加两条，实现放在 `skills/mao-cli/lib/commands/role.js` 现有分支旁，并写进该文件的 `help()`。`SKILL.md` 已指向 `reference/role.md`，不用改路由表。

| 场景 | 命令 |
|---|---|
| 查看某角色的技能授权 | `role skills --id <id>` |
| 覆盖式保存 | `role assign-skills --id <id> --grants <列表>` |

`--grants` 为逗号分隔。每项是 `技能名` 或 `技能名@agentId`。没有 `@` 表示全部 Agent（`agent_id = 0`）。`@` 后面不是非负整数时，命令报错退出，不发请求。不传 `--grants` 同样报错退出。只有显式空字符串才清空该角色全部授权。

```bash
mao role skills --id 3
mao role assign-skills --id 3 --grants 'bigdata@12,sql-review'
mao role assign-skills --id 3 --grants ''
```

`skills/mao-cli/reference/skill-docs.md` 用一小节说明三层来源：Agent 共用、角色按 Agent 追加、个人技能覆盖同名并在全部 Agent 生效。

## 10. 测试

后端，优先补在现有 spec 上，不另起一套框架：

- `resolveSystemSkillNames`：无授权、`userId` 为空、与 Agent 名单重复、只命中 `agent_id = 0`、不命中其他 Agent、多角色并集、加载器中已不存在的名字被丢弃。当前 Agent 已软删时，限定到该 id 的授权丢掉，`agent_id = 0` 仍保留。
- `syncToSession`：角色技能挂到该 (user, agent) 的视图；另一个 Agent 的会话不挂这条限定授权。
- `getRemovedSkillNames`：返回 Promise。授权仍在时不把该技能报成移除；授权撤掉后的下一轮报移除。
- `writeSyncZip`：包内含角色技能，且用的是入参里的用户，不是另查的发言者。
- Harness：`availableSkillNames` 的顺序符合 D13；个人技能仍覆盖同名系统技能的文档（`skillDocMap` 后写）。
- `GET /v1/quick-commands?agentId=`：带上该登录用户的角色技能；解析结果为空时不列出系统技能，个人技能仍在；不带 `agentId` 时仍列出全部系统技能。
- PUT：非法技能名、未知技能、已删除 Agent、非整数 `agentId`、`grants` 缺省、重复行、同一技能同时「全部」和「某个 Agent」、无 `role:write`、角色不存在，均拒绝且表不变。`grants: []` 清空。停用未软删的 Agent 可以写入。成功路径覆盖旧行。含 `browser-use` 时 `ensureForSkills` 在事务提交后被调用，不含时不被调用成「带 browser-use 的名单」。
- 删除系统技能：Agent 名单与 `role_skill_grant` 都去掉该名字。删除 Agent：只去掉 `agent_id` 等于它的行。

管理后台无单测框架要求。角色页与 Skills 列表的交互在实现时用页面走一遍：保存、刷新后仍在、换一个 Agent 的会话不会出现限定技能、无写权限只读、无 `role:read` 时技能列表主表仍可打开、只改技能就切换角色或页签会先确认。

斜杠菜单补在现有 `desktop/src/composables/useEditorTagPanels.test.ts`：请求带当前 Agent；Agent 变化会重新请求；没有 Agent 时不带 `agentId`。

## 11. 文档与发布

实现任务除本方案外同步：

- `changelog/unreleased/` 一条。小节用「管理后台」写授权入口，用「后端」写会话生效规则，用「前端」写斜杠菜单按当前 Agent 过滤（桌面 / Web / 安卓共用这套输入框，不单开安卓小节）。
- `skills/mao-cli/reference/role.md`、`skills/mao-cli/reference/skill-docs.md`。
- 不改历史设计文档。`README.md` 若有「技能只关联 Agent」的句子再改；没有则不动。

无数据迁移之外的上线步骤。已有会话不回溯补挂，下一轮对话同步即可。把岗位技能从 Agent 共用名单挪到角色授权时，要先保存角色授权，再从 Agent 上取消勾选，避免中间一轮两边都没有。

## 12. 实施顺序

1. 迁移与 `RoleSkillGrantService`（含 PUT 校验和级联）。
2. `resolveSystemSkillNames`，并改挂载、摘除（含改为异步）、zip、Harness、斜杠菜单接口。
3. 保存授权时的 `ensureForSkills`。
4. 后端 spec。
5. 角色页技能页签、Skills 列表「关联角色」、Agent 表单那句说明。
6. 输入框把所属 Agent 传给 `/quick-commands`，换 Agent 重新拉取。
7. mao-cli 与 reference、changelog 碎片。
8. `cd backend-ts && npm test`；admin 与 desktop 都跑 `npm run build`（`vue-tsc -b && vite build`）。

## 13. 风险

- 授权给 `USER` 或 `ADMIN` 等于几乎全员生效。界面说明写明，程序不拦截：这两个角色在有的部署里确实会被当成岗位使用。
- 角色技能进入系统提示。岗位包过大时每轮都占上下文。方案不设条数上限，由管理员控制；单角色授权预期是数个到十数个技能，不是把整个系统技能库授出去。
- `role:write` 可以给角色挂上带命令和凭据说明的技能。这与该权限今天就能调整「谁属于这个角色」同级，不另做审批。
- 手打 `${未授权技能}$` 仍会变成 `/name`，只是目录和文件里没有它。这是既有行为，不是授权漏洞。
