# 机器人通道工作区总览技术方案

- 状态：已实施（2026-11-02）
- 日期：2026-11-02
- 本方案定位：兑现 [2026-10-29 工作区总览与生命周期方案](2026-10-29-workspace-overview-lifecycle-technical-design.md) D2 / §2.2 的「另立提案」——把飞书 / 钉钉入站通道产生的工作区纳入桌面「我的工作区」页签的可见与管理范围。**纯增量，零迁移，不动每用户根目录的既有枚举与删除语义。**
- 能力底座：
  - [2026-10-29-workspace-overview-lifecycle-technical-design.md](2026-10-29-workspace-overview-lifecycle-technical-design.md)（总览端点、删除守卫 D4、中央页签注册）
  - `harness/container/channel-workspace.ts`（通道目录布局唯一事实源 + `isChannelWorkspace`）
  - `container-mount-planner.ts:142-169` `planSessionWorkspace`（通道工作区归属校验现成范式：私聊 leaf 按 userId、群 leaf 按设计共享）

## 1. 需求背景

### 1.1 现状

| 能力 | 现状 | 证据 |
|---|---|---|
| 通道工作区布局 | `{workspaceRoot}/feishu-chat\|dingtalk-chat/{accountId}/{leaf}`，leaf 为群 chatId / conversationId 或 `private-{userId}` / `p2p-{userId}`；位于全局根、按机器人聚合，不在每用户根内 | `channel-workspace.ts:11-22`、`feishu-media.ts:20-24`、`dingtalk/workspace.ts:6-24` |
| 群 / 私聊归属 | 群工作区由同群多个 mao 用户的会话按设计共享；私聊工作区按 mao 用户隔离（leaf 内嵌 userId） | `channel-workspace.ts:13` 注释、`container-mount-planner.ts:156-167` |
| 总览范围 | `WorkspaceOverviewService.listOverview` 只枚举 `{workspaceRoot}/{userId}` 一级目录 + `projects/*` | `workspace-overview.service.ts`（本方案前） |
| 用户可见性 | 通道会话只在左侧会话栏出现（按会话维度），「我的工作区」页签明确排除通道工作区 | 2026-10-29 方案 D2 |

### 1.2 问题

飞书 / 钉钉是主要的使用入口之一：群里的会话、私聊的会话持续在 `feishu-chat` / `dingtalk-chat` 下积累文件，但「我的工作区」这块资产面板完全看不到它们——用户想浏览群工作区的文件、以某个群工作区开新任务，都没有入口；磁盘占用也同样不可感知。

### 1.3 关键事实（设计建立在其上）

- 通道工作区的创建与路径生成全在服务端内部完成（入站消息上下文直接调 `SessionService`，不经 HTTP），目录名经 `encodeURIComponent` 落盘。
- `session.workspace` 存绝对路径；`listWorkspacesByUser(userId)`（容器挂载清单用）已能一次取到本人全部会话的工作区去重集合，是「参与性」判定的现成数据源。
- 群工作区被多用户会话共享：按 `user_id` 过滤的聚合会少计同群其他用户的会话；活跃引用检查同理。
- 既有删除是物理 `rm -rf` 且不可恢复；群工作区被删会断掉全群所有用户历史会话的文件浏览与 Git 面板。

## 2. 需求描述

### 2.1 要做的

1. **总览收录通道工作区**：`GET /v1/files/workspace-overview` 在本人根枚举之外，追加枚举两个通道根下 `{accountId}/{leaf}` 二级目录，条目 `kind: 'channel'`，附带 `channel: 'feishu' | 'dingtalk'`、`chatType: 'group' | 'private'`、`accountId`。
2. **可见性口径**：私聊 leaf 只列本人的（leaf 内 userId 比对）；群 leaf 只列本人有未删除会话（含归档）参与过的。未参与的群、他人的私聊一律不出现。
3. **跨用户计数**：通道条目的「关联会话 / 最近使用」走不带 `user_id` 过滤的聚合（群目录多人共享，按用户过滤会少计）。
4. **管理操作**：通道条目开放「文件管理」（浏览 / 读写走受管口径守卫）与「新任务」（建会话守卫放行受管通道工作区）；群条目的「删除」按钮禁用。
5. **前端展示**：名称列对通道条目用与左侧会话栏同源的合成标签（`formatCloudGroupLabel`：飞书群{botId}·{chatId} / 飞书私聊 / 钉钉群… / 钉钉私聊）；类别列新增「机器人通道」；顶部提示文案更新。

### 2.2 不做的

- **不做**群工作区删除（共享目录，物理删除波及全群用户；私聊工作区保留删除，走既有确认输入 + 活跃引用检查）。
- **不做**成员白名单表（`feishu_chat_member` / `dingtalk_chat_member`）驱动的可见性：以「本人有会话」为参与判定，会话全删后该群自然从列表消失，语义自洽且无需新查询。
- **不做**飞书群真实群名的实时拉取（`getFeishuChatTitle` 仅建会话时调用过）；名称用路径合成标签，与左栏一致。
- **不做**admin 端通道工作区视图、`mao` CLI 子命令、新权限码（登录态即可，与总览既有端点同口径）。
- **不新增**迁移。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 落选项与理由 |
|---|---|---|---|
| D1 | 收录范围 | 飞书 + 钉钉都做 | `channelWorkspaceRoots()` 本就同时覆盖两个根，代码路径完全同构，分两次做只会二费 |
| D2 | 群工作区可见性 | 本人有会话（含归档）参与过才可见 | 数据源用现成 `listWorkspacesByUser`；天然防越权看到别人的群；「全员可见」在多用户部署下泄露群存在性 |
| D3 | 私聊可见性 | leaf 内 userId === 当前用户 | 与 `container-mount-planner.ts:162` 归属校验同一正则同一口径 |
| D4 | 群工作区删除 | 不提供（前端禁用 + 后端 `shared` 错误硬拒） | 物理 `rm -rf` 不可恢复且目录多人共享；私聊可删（仅本人 leaf） |
| D5 | 计数口径 | 通道条目跨用户聚合，个人条目仍按 userId | 群目录共享是设计语义；新增 `aggregateWorkspaceUsageAnyUser(prefixes)`，既有 `aggregateWorkspaceUsage` 不动 |
| D6 | 守卫分层 | 删除口径（`resolveDeletablePath`，群拒）与受管口径（`resolveManagedPath`，群按参与性放行）拆分，文件管理 / 引用清单 / 刷新用受管口径 | 「看得见删不得」正是 2026-10-29 D2 担忧的歧义，用两套显式口径消除；`refresh` 保持旧版「只校验 scope 不校验存在」 |
| D7 | 建会话放行 | `assertOwnedSessionWorkspace` 扩展：私聊 leaf 必须本人；群 leaf 需参与性通过（判定函数缺省时拒绝，fail-closed） | 与容器挂载侧同口径的第二道防御；「新任务」预填通道工作区要能真正建会话 |
| D8 | 枚举安全 | 通道根 / 账号级 / leaf 三级逐个 `readdirSync(withFileTypes)`，符号链接与非目录逐级跳过 | 复用总览既有防御范式；`parseChannelWorkspace` 的 depth≥2 硬约束保证只出现具体工作区 |

## 4. 落地变更

| 层 | 文件 | 变更 |
|---|---|---|
| contracts | `shared/contracts/src/workspace.ts`（新增）+ `index.ts` | `WorkspaceKind` 扩展 `'channel'`（从后端 service 与 desktop types 两处并行字面量上收为单一来源）；新增 `WorkspaceChannel` / `WorkspaceChatType` |
| 后端 | `harness/container/channel-workspace.ts` | 新增纯函数 `parseChannelWorkspace(workspace, root)`：depth≥2 + 私聊 leaf 正则，返回 `{ channel, accountId, leaf, chatType, ownerUserId }`；`isChannelWorkspace` 改基于它实现 |
| 后端 | `harness/container/container-mount-planner.ts` | `planSessionWorkspace` 复用 `parseChannelWorkspace`（行为与三条报错文案不变） |
| 后端 | `session/session.repository.ts` | 新增 `aggregateWorkspaceUsageAnyUser(prefixes)`（跨用户、按前缀 OR、空前缀不查库）与 `existsSessionUnderWorkspace(userId, path)`（参与性 EXISTS） |
| 后端 | `file/workspace-overview.service.ts` | `listOverview` 追加通道枚举与可见性过滤；条目扩展 `channel / chatType / accountId`；守卫拆分 `resolveDeletablePath`（群→`shared`）/ `resolveManagedPath`（群按参与性）；`refresh` 走受管 scope 且不校验存在 |
| 后端 | `file/file.routes.ts` | `requireWriteWorkspace` / `resolveOwnedWorkspace` / references 路由改 `resolveManagedPath`（文件管理对通道工作区可用）；DELETE 路由沿用 `resolveDeletablePath`（群路径落 400 `shared`） |
| 后端 | `session/session.routes.ts` | `assertOwnedSessionWorkspace` 改 async 并放行受管通道工作区；`SessionRouteDeps` 新增可选 `existsSessionUnderWorkspace`（缺省拒绝群工作区）；`app-routes.ts` 接上 `sessionRepo` 方法 |
| desktop | `types/workspace-overview.ts` | 枚举改 import `@mao/contracts`；条目新增三个可选字段 |
| desktop | `components/workspace/WorkspaceOverviewPanel.vue` | `KIND_LABELS` / `kindTag` 补 channel；名称列合成标签；群条目删除禁用（title 说明）；提示文案更新 |
| 测试 | `workspace-overview.service.spec.ts`、`channel-workspace.spec.ts`、`session.routes.spec.ts`、`WorkspaceOverviewPanel.channel.test.ts`（新增） | 见 §7 |

## 5. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 通道工作区被误删 / 越权删 | 删除口径群一律 `shared` 拒绝；私聊按 leaf userId；个人目录守卫逐字节不变（既有 spec 全绿） |
| 未参与群 / 他人私聊的信息泄露 | 列表可见性（参与性 + leaf 归属）+ 受管口径守卫双重收口；建会话侧 fail-closed |
| 群计数少计 | 跨用户聚合专方法；SQL 形状单测断言不含 `user_id` |
| 符号链接逃逸 | 通道枚举三级逐级跳过链接；`parseChannelWorkspace` 只认 depth≥2 具体工作区 |
| 左栏分组回归 | 后端 `feishuGroupKey` 按 workspace 派生分组键，用户自建会话（无 channel projectKey）与通道会话同组，已在设计内确认 |
| 挂载行为回归 | `planSessionWorkspace` 仅重构复用解析函数，`container-mount-planner.spec.ts` 不改动保持全绿 |

## 6. 测试要点

1. 枚举：飞书 / 钉钉的群与本人私聊出条目且字段正确（channel / chatType / accountId / name=leaf）；他人私聊、未参与群不出现；账号级 / leaf 级符号链接不跟随。
2. 计数：群条目聚合跨用户 mock 数据；无可见通道目录时不发起跨用户查询。
3. 守卫：删除口径——群→`shared`、本人私聊放行、他人私聊→out-of-scope；受管口径——参与群放行、未参与群 / 他人私聊拒绝、个人目录现行为不回退。
4. 建会话：POST `/v1/sessions` 带参与群 / 本人私聊放行，未参与群 / 他人私聊 / 无关路径拒绝（200 信封 + PARAM_INVALID）。
5. 仓库 SQL：`aggregateWorkspaceUsageAnyUser` 每前缀一对参数、无 `user_id`、空前缀不查库；`existsSessionUnderWorkspace` `LIMIT 1` + 通配符转义。
6. 桌面：通道条目名称合成与「机器人通道」类别；群条目删除禁用、私聊 / 个人目录可删；temp 仍被过滤；`vue-tsc -b` 全量构建验证 `KIND_LABELS` 穷尽。
