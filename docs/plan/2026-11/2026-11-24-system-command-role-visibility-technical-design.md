# 系统指令按角色可见技术方案

- 状态：已实现（迁移号 `V204`，角色技能授权工作区已占用 `V203`）
- 日期：2026-11-24
- 评审：2026-11-24 补充部分更新、软删角色、历史消息身份、标题降级残留、管理端查看/移动端/搜索，以及契约和 CLI 边界。目标与表结构未改。
- 一句话：系统指令默认仍对所有用户可用；管理员可以把某一条改成「仅指定角色可用」。看不到的指令不出现在列表里，消息里的 `#{name}#` 也不会展开成它的正文。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 系统指令是 `user_command.user_id = 0` 的行，个人指令是 `user_id > 0`：`backend-ts/db/migration/V039__add_user_command.sql`、`V045__add_system_commands.sql`（种子 `review` / `codebase` / `commit_and_push` / `plan`）
  - 用户可见集合把全部系统指令放进去，个人同名覆盖：`backend-ts/src/command/command.service.ts:17-26`（`listAvailableForUser`）、`:36-41`（`getByUserIdAndName` 先个人、再系统）
  - 桌面「系统指令」页签不看当前用户：`backend-ts/src/command/command.routes.ts:49-51`（`GET /v1/user-commands/system` 直接 `listByUserId(0)`）
  - 斜杠菜单走 `listAvailableForUser`：`command.routes.ts:129`
  - 模型侧展开 `#{name}#` 走 `getByUserIdAndName`，身份是发言者：`backend-ts/src/harness/core/prompt-engine.ts:262-315`
  - 会话标题把 marker 换成正文时用的是会话归属者：`backend-ts/src/session/session-title.service.ts:75`、`:156-160`
  - 管理端 CRUD：`backend-ts/src/command/admin-system-command.routes.ts`（`command:read` / `command:write`）。提升个人指令时复制一行 `user_id = 0`：`:154-185`
  - 管理后台表单只有名称和正文：`admin/src/views/system-commands/SystemCommandListView.vue:196-211`
  - 桌面系统指令页签只渲染接口返回值：`desktop/src/components/command/CommandManager.vue:134-139`
- 关联方案：[2026-08-25 系统快捷指令管理后台](../2026-08/2026-08-25-system-commands-admin-tech-design.md)（把 `user_id = 0` 定成全体可见）。[角色技能授权](./2026-11-24-role-skill-grant-technical-design.md) 是另一件事：技能按 Agent 追加，指令按人过滤，两套表不要并成一张。

## 1. 现状与问题

系统指令和个人指令共用 `user_command`。`user_id = 0` 表示系统指令，四条种子和后来在后台新增的行都是这个约定。用户侧两处读取都不分人：

- `listAvailableForUser` 先装入全部系统指令，再用个人指令按名字覆盖。斜杠菜单和会话标题用它。
- `GET /v1/user-commands/system` 连当前用户都不取，桌面「系统指令」页签因此是全量。

模型真正执行指令，是 `PromptEngine` 把用户消息里的 `#{name}#` 换成 `getByUserIdAndName` 查到的正文。个人指令优先；没有个人指令时，任何系统指令都能被这个名字展开。只改列表、不改这次查找，知道名字的人仍能把正文送进模型。

管理后台的「指令管理」也写明系统指令供全体用户使用（`SystemCommandListView.vue:8`、个人指令页的提示 `:41`）。没有「给数仓，不给开发」的字段。

这和角色技能不是一类限制。技能决定某次 Agent 会话的目录里有什么，所以授权要带 Agent。指令是一段可被名字调用的提示词模板，调用发生在用户消息上，和当前打开哪个 Agent 无关。本次只做「全局」和「指定角色」两档。

## 2. 目标与非目标

### 2.1 目标

1. 每条系统指令有可见范围：`all`（全局，所有登录用户）或 `roles`（仅指定角色）。已有行默认 `all`，升级后 `review` 等种子指令仍全员可用。
2. `roles` 下至少指定一个角色。用户只要拥有其中任一角色就可见（并集，不是必须同时拥有）。
3. 不可见的系统指令同时从三处消失：桌面系统指令页签、斜杠菜单、`#{name}#` 展开。展开失败保持今天的行为：marker 留下，打一条 `Command not found` 警告，不把正文送进模型。
4. 管理后台列表展示范围，新建和编辑可改。个人指令提升为系统指令时默认全局，对话框里可以顺手改成指定角色。
5. `mao system-command` 的创建、更新、列表能读写这个范围。

### 2.2 非目标

- 不按 Agent、部门、单个用户限制。个人指令仍然是「只属于这个用户」，不增加可见范围字段。
- 不让管理员角色在桌面端自动看见全部系统指令。后台列表靠 `command:read` 看全量；桌面端和管理员自己的角色绑定一致。需要管理员在桌面使用时，把该角色加进范围，或保持全局。
- 不改变「个人指令同名覆盖系统指令」。用户看不见某条系统指令时，仍可以有一条同名个人指令，查找命中个人指令。
- 不改桌面端的请求路径和指令编辑器。页签继续请求 `GET /v1/user-commands/system`，少返回的行自然不显示。
- 不改气泡预览缓存。`desktop/src/utils/commandContent.ts` 只拉个人指令，系统指令正文的展开在服务端。这是既有缺口，本次不补。
- 不新增角色删除。当前没有删除角色的接口。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 范围档位 | 指令上显式存 `visibility`：`all` 或 `roles`。角色放子表 | 只靠「没有角色行 = 全局」，清空多选会在不知情时变成全员可见。显式档位让保存意图落在列上 |
| D2 | 多角色 | 任一角色即可 | 「开发、测试可用」是或，不是「必须同时是开发和测试」 |
| D3 | 存量 | 列默认 `all`，不回填角色行 | 与今天「全体可用」一致。不在迁移里猜测哪些指令该收窄 |
| D4 | 过滤点 | 用户侧只留一个判定 `isVisibleTo(command, userId)`，三处读取都走它。管理端列表不过滤 | 漏掉展开路径就会变成「菜单里没有，打出名字仍能执行」 |
| D5 | 身份 | 展开用发言者（`prompt-engine.ts:263` 已是 `runtimeUserId`）。标题预处理维持会话归属者（`session-title.service.ts:75`） | 群聊里谁发言，谁的角色决定这条指令展不展开。标题链路今天就不是发言者，本次不改标题身份；归属者不可见的正文不会进标题模型 |
| D6 | 生效时机 | 每轮请求查库，不缓存可见集 | 指令没有技能那种会话内物化。收回角色后，下一轮请求即不再展开 |
| D7 | 权限 | 读写仍是 `command:read` / `command:write`。角色下拉不复用 `GET /v1/roles` | `GET /roles` 要 `role:read` 或 `user:write`，且返回权限点。只有指令权限的账号会拉不到角色，或看到不该看的权限集合 |
| D8 | 个人指令 | `visibility` 列对 `user_id > 0` 恒为 `all`，没有角色行。用户接口不接受这个字段 | 个人指令的边界是 user_id，不是角色 |
| D9 | 提升 | `promote` 默认 `all`。请求体可选 `visibility` + `roleIds`，校验与新建相同 | 提升对话框已经在写名称和正文，同一次提交把范围定下来，避免先变成全员再去改 |
| D10 | 部分更新 | 请求里没有 `visibility` 时，忽略 `roleIds`，范围和角色行都保持 | 今天的编辑和 CLI `update` 只提交名称和正文。带上残留的空 `roleIds` 不能把范围清掉 |
| D11 | 软删角色 | 校验、下拉、可见性、`roleNames` 都只认 `role.deleted = 0` | `role` 有软删列。当前没有删除角色的接口，这是读路径兜底 |
| D12 | 历史标记 | 一轮请求里所有用户消息的 `#{name}#` 都用本轮 `runtimeUserId` | `message` 没有发送者用户 id，不能按每条消息的作者拆开 |

## 4. 可见性规则

系统指令对用户 `U` 可见，当且仅当：

```text
visibility = 'all'
或 visibility = 'roles' 且 U 的 user_role 与该指令的角色行有交集
```

交集里的角色必须 `role.deleted = 0`。角色行指向已软删角色时，这一行不参与判定。

`listAvailableForUser(U)` 改为：可见的系统指令先入 map；仅当 `U > 0` 时，再把该用户的个人指令按名字覆盖。`U <= 0` 没有个人层。若把 `user_id = 0` 的行再覆盖进来，刚才滤掉的系统指令会回到 map 里。

`getByUserIdAndName(U, name)` 只有 `U > 0` 的个人行可以先命中。没有个人行时，系统行还要过上面的判定，不可见则返回 `null`。现在的实现对 `userId === 0` 会把系统行当作个人行直接返回（`command.service.ts:38-40`）。落地时去掉这条早退，哨兵用户不能跳过可见性。

一轮 `buildRequest` 里，历史中所有用户消息的 `#{name}#` 共用本轮 `runtimeUserId`（`prompt-engine.ts:264`）。因此：无权限者自己这一轮，历史里别人写下的标记也不会展开；有权限者下一轮发言时，历史里无权限者写下的同名标记会按有权限者展开。正文只进入这一次模型请求，不写回 `message`，也不进 context manifest。

定时任务、Webhook、飞书、钉钉、嵌入页都走 `PromptEngine`，不单开展开分支。本轮执行身份是谁，就用谁的角色。压缩摘要读的是未展开的消息原文。

`GET /v1/user-commands/system` 改为 `requireUserId`，只返回对当前用户可见的系统指令。响应字段仍是 `id`、`name`、`content`，不带角色 id。

管理端 `GET /v1/admin/system-commands` 返回全部系统指令，并带上范围，供表格和编辑回显。

例子：`review` 为全局，`warehouse-check` 只给数仓角色。

| 用户 | 斜杠菜单与系统指令页签 | 消息里的 `#{warehouse-check}#` |
|---|---|---|
| 数仓角色 | 有 `review` 和 `warehouse-check` | 展开为该指令正文 |
| 只有普通用户角色 | 只有 `review` | 不展开 |
| 数仓角色，且自己有同名个人指令 | 菜单里是个人指令那条 | 展开个人正文（既有优先级） |

## 5. 数据模型

落地文件是 `V204__system_command_role_visibility.sql`。撰写时最大为 `V202`；[角色技能授权](./2026-11-24-role-skill-grant-technical-design.md) 的工作区已放了 `V203`，本方案顺延。

```sql
ALTER TABLE `user_command`
    ADD COLUMN `visibility` VARCHAR(16) NOT NULL DEFAULT 'all' COMMENT 'all=全局 roles=指定角色；仅 user_id=0 使用 roles';

CREATE TABLE IF NOT EXISTS `user_command_role` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `command_id`  BIGINT NOT NULL,
    `role_id`     BIGINT NOT NULL,
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_command_role` (`command_id`, `role_id`),
    KEY `idx_user_command_role_role` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

不加数据库外键，与近期迁移一致。删除系统指令时同步删除它的角色行。

## 6. 后端

### 6.1 判定

`UserCommandRepository` 增加按指令 id 列出 `role_id`、按用户列出其可见的系统指令。可见查询：

```sql
SELECT c.*
FROM user_command c
WHERE c.user_id = 0
  AND c.deleted = 0
  AND (
    c.visibility = 'all'
    OR EXISTS (
      SELECT 1 FROM user_command_role cr
      INNER JOIN user_role ur ON ur.role_id = cr.role_id
      INNER JOIN role r ON r.id = cr.role_id AND r.deleted = 0
      WHERE cr.command_id = c.id AND ur.user_id = ?
    )
  )
ORDER BY c.created_at DESC, c.id DESC
```

`listAvailableForUser` 用这条替换「全部 `user_id = 0`」。`getByUserIdAndName` 在落到系统行之后调用同一条件：行存在但不可见，返回 `null`。不要在 `PromptEngine` 里再写一套角色判断。

`visibility` 不是 `all`/`roles` 的脏数据按不可见处理，并打警告。避免列被写成别的值时变成全员可见。

用户侧 `insert` / `updateById` 不写 `visibility`。个人行靠列默认值 `all`。管理端写入才显式带上这一列。

### 6.2 管理端接口

权限不变。`AdminUserCommandVO` 增加 `visibility: 'all' | 'roles'` 和 `roleIds: number[]`。列表为了表格直接显示，再带 `roleNames: string[]`（按角色名升序）。个人指令列表的 VO 固定 `visibility: 'all'`、`roleIds: []`，前端不展示。

| 方法 | 路径 | 变化 |
|---|---|---|
| GET | `/v1/admin/system-commands` | 每条带 `visibility`、`roleIds`、`roleNames` |
| GET | `/v1/admin/system-commands/:id` | 同上 |
| GET | `/v1/admin/system-commands/role-options` | 新增。`command:read`。返回未软删角色的 `{ id, name, code }[]`，按 `name` 升序，不含权限点。注册在 `/:id` 之前，避免被当成 id |
| POST | `/v1/admin/system-commands` | 正文增加可选 `visibility`、`roleIds`。缺省 `all` |
| PUT | `/v1/admin/system-commands/:id` | 同上。未传 `visibility` 时保持原值，并忽略 `roleIds`；传了则角色行按新范围整表替换 |
| DELETE | `/v1/admin/system-commands/:id` | 软删指令，并删除 `user_command_role` 中该 `command_id` |
| POST | `.../promote` | 可选 `visibility`、`roleIds`，缺省 `all` |

校验，失败则整单不写：

- `visibility` 只接受 `all` 或 `roles`。未传则不改范围，也不看 `roleIds`。
- `all`：忽略 `roleIds`，保存时删掉该指令已有角色行。
- `roles`：`roleIds` 每项必须是正整数，去重后至少 1 个。一次 `IN` 查询核对，缺任一 id，或该角色已软删，则 400。
- `roleNames` 按当时 `role.name` 升序现查，不把名字写进 `user_command_role`。`visibility = roles` 但一个未软删角色都没有时，表格仍显示「指定角色」，编辑多选为空，保存前必须重选。
- 角色 id 在写入前校验完。指令列更新与角色行删除、插入用同一个 `db.transaction` 连接。校验失败则整单不写。

`command.service.ts` 的用户侧 `create` / `update` 不接受 `visibility`。系统指令的写入继续只走 admin 路由（用户侧 `update`/`delete` 对 `user_id = 0` 仍抛 `COMMAND_SYSTEM_READONLY`）。

### 6.3 用户侧接口

`GET /v1/user-commands/system` 使用 `requireUserId`，调用过滤后的列表。`GET /v1/quick-commands` 不改形状，`commands` 数组随 `listAvailableForUser` 变短。

不新增桌面专用字段。客户端不负责过滤；服务端没滤掉的才算漏。

## 7. 管理后台

`SystemCommandListView.vue` 系统指令表增加「可见范围」列：`all` 显示「全局」；`roles` 显示角色名，放不下时用 tooltip 展开展示全部。移动端卡片在正文上方加同样一行。查看对话框里现在的「用户：系统（全局）」（`:226`）改成按范围显示：全局，或「指定角色：」加角色名。

系统指令关键词是前端过滤（`:381-389`）。匹配串加上 `roleNames`，按角色名能搜到。编辑回显用列表里的 `visibility` 和 `roleIds`。切回「全局可用」时提交 `visibility = all`。

新建 / 编辑对话框在正文下增加：

- 单选：全局可用、指定角色。默认全局。
- 选「指定角色」时出现多选，选项来自 `role-options`。未选角色不允许保存。
- 一句说明：指定角色后，不在这些角色里的用户不会在桌面看到这条指令，也无法用 `#{名称}#` 展开它。

页头「管理全局系统指令」改为「管理系统指令的内容，以及全局或按角色可见」。个人指令 Tab 的提示里「供全体用户使用」改为「复制为系统指令；默认全局可用，可改为指定角色」。

提升对话框复用同一组单选和多选，提交进 `promote` 的 body。不改则后端按全局创建。

无 `command:write` 时控件只读，与今天的编辑按钮一致。

## 8. 桌面 / Web / 安卓

不改 `CommandManager.vue` 的请求。过滤后的系统指令页签、以及 `useEditorTagPanels.ts` 请求的 `/quick-commands`，都会少掉不可见项。系统指令页签是打开时现拉。斜杠菜单的 `commandsLoaded` 在这个输入框实例里只拉一次（`useEditorTagPanels.ts:121-130`），已打开的页面不会因为后台改了范围而立刻少一项；下次进入页面会少。发出去的消息仍由服务端按当轮角色决定展不展开。

空列表沿用「暂无系统指令」。不在桌面解释「因为你的角色没有」。

安卓壳加载同一套 desktop 页面，没有单独的指令接口。

## 9. mao-cli

`skills/mao-cli/lib/commands/system-command.js` 与 `skills/mao-cli/reference/command.md`：

| 命令 | 变化 |
|---|---|
| `system-command list` / `get` | 输出增加 `visibility`、`roleIds`、`roleNames` |
| `system-command create` | 增加 `--visibility all\|roles`、`--role-ids 3,4`。缺省 `all` |
| `system-command update` | 同样两个可选参数。传入 `--visibility` 才改范围 |
| `system-command promote-personal` | 同样两个可选参数。缺省全局 |

`--visibility roles` 且没有 `--role-ids` 时，CLI 在发请求前报错，与后端 400 的文案一致。只传 `--role-ids`、不传 `--visibility` 时同样在本地报错，不把角色 id 塞进一次「没声明要改范围」的请求。

`update` 今天就必填 `--content`（`system-command.js:70`）。只改范围时也要带上正文。文件头说明里的「全体用户可见」一起改掉。

`mao command` 只打 `/user-commands`，没有系统指令。`mao quick-command` 打 `/quick-commands`，`commands` 会随过滤变短。这两条 CLI 不改参数。

## 10. 测试

`command.service.spec.ts`：

- `visibility = all` 的系统指令对任意用户可见，与今天的合并、个人覆盖用例一致。
- `roles` 且用户有交集：可见，并出现在 `listAvailableForUser`。
- `roles` 且无交集：列表没有；`getByUserIdAndName` 返回 `null`；同名个人指令仍返回个人正文。
- 多个角色命中一个即可见。
- `visibility` 为非法值：不可见。
- `getByUserIdAndName(0, name)` 不因早退返回不可见的系统行。

`admin-system-command.routes.spec.ts`：

- 缺省创建为 `all`，无角色行。
- `roles` 且空 `roleIds`、未知角色 id、非法 `visibility`：400，表不变。
- `all` 会清掉原先的角色行。
- PUT 不传 `visibility` 时，即使 body 里有 `roleIds`，角色行也不变。
- 软删角色不出现在 `role-options`，不能写入；已挂上的软删角色不使指令对用户可见。
- 删除指令后角色行为空。
- `promote` 不传范围时为 `all`；传入 `roles` 时带上角色。
- `role-options` 在仅有 `command:read` 时 200，且没有 `permissionIds`。

`command.routes` 或现有路由 spec：`GET /v1/user-commands/system` 不返回当前用户不可见的行。`quick-commands` 的 `commands` 同样不包含。

`prompt-engine.spec.ts` 已覆盖查找返回 `null` 时 marker 保留并打 `Command not found`。角色判断放在 service 测试，prompt 测试不重复查表，也不再复制这条。

`session-title.service.spec.ts`：`listAvailableForUser` 仍用会话 `userId`。mock 不返回的指令不会进入标题预处理。

## 11. 文档与发布

实现时同步：

- `changelog/unreleased/`：管理后台写可见范围；后端写「不可见则不展开」；终端 CLI（mao-cli）写创建、更新、提升可带可见范围。桌面无独立行为，不单开前端小节。
- `skills/mao-cli/reference/command.md`。`reference/admin.md` 里「全体用户可见」那句改成「默认全局，可按角色限制」。
- `shared/contracts` 增加 `CommandVisibility = 'all' | 'roles'`。admin 的「全局」文案用 `Record<CommandVisibility, string>`。用户侧响应不带这个字段，desktop 不加汉化表。
- 不改 2026-08-25 的历史方案。

无单独上线步骤。已写在历史消息里的 `#{name}#`：用户仍有权则继续展开；被收回后下一轮不再展开，气泡里的标记文本保持原样。

## 12. 实施顺序

1. 迁移、repository 的可见查询与角色行替换。
2. `listAvailableForUser`、`getByUserIdAndName`、`GET /user-commands/system`。
3. 管理端创建、更新、删除、提升和 `role-options`。
4. 后端 spec。
5. 管理后台列、表单、提升对话框、页头文案。
6. mao-cli、reference、changelog 碎片。
7. `cd backend-ts && npm test`；`cd admin && npm run build`。

## 13. 风险

- 把一条常用指令改成「指定角色」后，不在角色里的人下一轮起就无法展开，包括已经插在输入框里的 `#{name}#`。保存前没有「还有多少人在用」的统计，本次不做。
- `command:write` 可以把指令限制到任意角色，也可以再改回全局。与今天能改全体可见的正文是同一权限，不另做审批。
- 标题仍按会话归属者过滤。群里第一个发言的人若不是归属者，他专用的指令不会进标题正文。标题里最多留下未展开的标记，不会把别人的指令正文写进共享标题。归属者可见时，标题模型拿到的是展开后的正文。模型失败则 `TitleGenerator.generate` 取预处理文本的前 50 字（`title-generator.ts` 的 `MAX_TITLE_LENGTH`）写入会话标题，正文开头可能出现在标题里，能看到该会话的人看得到。本次不改这套降级。
- 群会话里，有权限者的下一轮会把历史中的标记展开进模型。模型若在回复里复述正文，群里其他人看得到回复。用户消息气泡里仍然是标记。
- 已打开输入框的斜杠菜单有一次缓存，见 §8。收回角色后，下一轮请求不再展开。
