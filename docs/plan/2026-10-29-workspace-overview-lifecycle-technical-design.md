# 工作区总览与生命周期管理技术方案

- 状态：待评审（2026-10-29 依据提案 [2026-10-29-workspace-overview-lifecycle.md](../proposals/2026-10-29-workspace-overview-lifecycle.md) 细化；11 项决策已定案见 §3，不再开放）
- 日期：2026-10-29
- 能力底座：
  - [2026-10-09-workspace-file-manager-technical-design.md](2026-10-09-workspace-file-manager-technical-design.md)（文件直管 0.0.281：`WorkspaceWriteService` 沙箱与写锁协同、「物理删除 + 强确认、不做回收站」先例）
  - [2026-10-28-git-manager-tab-technical-design.md](2026-10-28-git-manager-tab-technical-design.md)（中央大 Tab 的注册方式：`useCenterTabs` Tab 联合 + 单例 id + `CenterTabBar` 图标分支 + `CenterTabContainer` 渲染分支）
  - `workspace-browse.service.ts` 既有符号链接防御范式（`lstatSync` + `isSymbolicLink` 跳过，L115 / L173-177 / L215）
- 本方案定位：给「我的所有工作区」补一块资产面板——总览（大小 / 会话关联 / 最近使用）+ 用户手动删除（强守卫）。**纯增量，零迁移，不碰既有 cloud-projects 端点。**

## 1. 需求背景

### 1.1 现状

| 能力 | 现状 | 证据 |
|---|---|---|
| 列出工作区 | `GET /v1/sessions/cloud-projects`：同步 `readdirSync` 平铺 `{userRoot}/projects/*`，只返回 `name / path / isGit` | `session.routes.ts:166-188` |
| 目录布局 | 临时工作区 = `{userRoot}/{sessionId}`（建会话时自动创建）；项目工作区 = `{userRoot}/projects/{slug}` | `session.service.ts:260`、`cloud-workspace-resolver.ts:40` |
| 通道工作区 | `{workspaceRoot}/feishu-chat\|dingtalk-chat/…`，在**全局根**下、按机器人聚合，不入用户根 | `session.routes.ts:640-648` 注释、`dingtalk/workspace.ts:6-12` |
| 占用大小 | 无任何端点 | — |
| 会话关联 | `session.workspace` 存绝对路径，无反向聚合查询 | `session.repository.ts` |
| 删除 | 无端点；文件直管删除仅限会话工作区**内部**条目（需先有会话上下文） | `file.routes.ts:411` |
| 中央页签注册 | Tab 类型联合 + 单例 id + 图标 / 渲染分支，git tab 为最新先例 | `useCenterTabs.ts:23,400-411`、`CenterTabBar.vue:21` |
| 文件树缺目录表现 | `FileManagerPanel.vue:93-95` 渲染后端返回的 `error` 字符串 | `FileManagerPanel.vue` |

### 1.2 问题

1. 磁盘只进不出：每个 CLOUD 会话的临时工作区（以会话 id 命名的目录）、每次 git clone 的项目目录都常驻服务器，用户零感知、零手段，清理只能靠管理员 ssh `du` + `rm`。
2. 新建任务的「复用已有工作区」下拉按字典序平铺，工作区一多就靠记忆挑，哪个活跃、哪个是半年前的实验无从判断。
3. 手动清理后归档会话的文件树 / Git 面板静默变空，无任何提示。

### 1.3 关键事实（设计建立在其上）

- 用户根 `{workspaceRoot}/{userId}` 下一级目录仅两类有效内容：数字命名的临时工作区目录、`projects/` 容器（其子目录才是项目工作区）；其余一级目录（若存在）均为历史遗留或用户经 API 建的自定义目录。
- 活跃相位判定已有统一口径 `isActivePhase`（`session-group-key.ts` 导出，与 fillTreeSignals / 桌面 ACTIVE_PHASES 同源）。
- `file.routes.ts:446` 已有 `resolve(pathSandbox.getWorkspaceRoot(), String(userId))` 的 userRoot 取用先例。

## 2. 需求描述

### 2.1 要做的

1. **P1 总览端点**：`GET /v1/files/workspace-overview`（仅登录态，无会话上下文）返回用户根下全部工作区的资产视图：`{ name, path, kind: 'temp' | 'project' | 'other', isGit, sizeBytes, sizeState: 'ready' | 'pending' | 'timeout' | 'failed', activeSessions, archivedSessions, lastUsedAt }`。`projects/` 容器本身**不作为条目返回**（其子目录按 `kind: 'project'` 逐个返回）。
2. **P1 大小统计**：后台异步计算 + 进程内缓存（TTL 10 分钟）+ 行内手动刷新；单目录上限（深度 24 / 条目 20 万 / 30 秒超时，超限即停并标 `timeout`）、目录间并发 4；符号链接一律 `lstat` 识别、**永不跟随**（复用 workspace-browse 同款防御）。首屏未命中的目录返回 `pending`，前端 3 秒后重查一次，仍未就绪显示「统计超时，可点行内刷新」。
3. **P1 桌面「我的工作区」中央页签**：全局单例 Tab（id `'workspace'`，type `'workspace_overview'`），注册方式与 git tab 完全一致（含持久化 / 恢复随现有机制，不特判）。表格列：名称 / 类别 / 大小 / 关联会话（进行中 · 归档）/ 最近使用；支持按大小、时间、名称排序；行操作「用于新任务」（预填新建任务的工作区，复用既有「复用已有」数据通道）；顶部「刷新」按钮走强制重算。
4. **P1 新建任务下拉富化**：新建任务的「复用已有工作区」下拉条目加副标题（大小 + 关联会话数），数据源即总览端点；**请求失败时回落现状纯目录名列表**（cloud-projects 端点原样保留、行为逐字节不变）。
5. **P2 删除**：`DELETE /v1/files/workspace-overview`（body `{ path }`）——守卫全过（§3 D4）后物理删除；桌面删除弹层列出关联会话计数并要求**输入目录名**确认；删除后刷新总览。
6. **P2 文件树兜底文案**：会话工作区根目录不存在时，目录列举端点返回明确错误「工作区目录不存在（可能已被删除）」；`FileManagerPanel` / `FileTree` 已渲染 error 字符串，**桌面零改动**。

### 2.2 不做的

- **不做**通道工作区（`{workspaceRoot}/feishu-chat|dingtalk-chat/…`）的总览与清理：它们在全局根下、按机器人聚合（多个用户共享一个 bot 目录树），归属模型与「本人工作区根」不同，需要独立的治理视角，另立提案。
- **不做**工作区环境模板 / 快照（2026-10-11 已否决）、自动清理策略与保留期（2026-10-09 数据保留已否决）、实例备份恢复（同日否决）——删除永远由用户对本人的目录显式触发。
- **不做**重命名 / 移动工作区：`session.workspace` 存绝对路径，改名会断全部历史会话引用。
- **不做**存储配额与限额。
- **不做**删除前的交互终端 cwd 校验：终端从属于会话，运行中会话已被活跃相位守卫拦下；空闲会话的残留 shell 在目录删除后自然报错，属可接受边缘（LOCAL 模式与本方案无关，不涉及）。
- **不做**实例级「允许用户删除工作区」开关：与文件直管同权限口径（登录用户本人目录），不设新开关。
- **不做**`mao` CLI 的 `workspace list / rm` 子命令。
- **不新增**迁移、不新增收件箱 kind、不新增权限码（登录态即可，与文件域既有端点同口径）。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 落选项与理由 |
|---|---|---|---|
| D1 | 入口位置 | 中央页签「我的工作区」，全局单例 id `'workspace'` | 与 git 管理器同层、注册机制现成；设置页内嵌会被系统设置噪音淹没 |
| D2 | 总览范围 | 仅 `{userRoot}` 一级目录（临时 / 项目 / 其他三类），通道工作区排除 | 通道目录在全局根、按 bot 聚合，混进本人总览会产生「看得见删不得（或不该删）」的歧义 |
| D3 | 大小统计时机 | 首次请求触发后台计算 + TTL 缓存 + 一次 3s 重查 + 行内强制刷新 | 同步全量 `du` 会阻塞请求（git 仓库动辄数十万条目）；WS 推送为一次性需求引入常驻通道不值得 |
| D4 | 删除守卫 | ① 路径必须解析后严格位于本人根内且为一级目录或 `projects/*` 子目录；② 不得为 `projects` 容器本身；③ 不存在 `workspace === path` 或 `workspace` 以 `path + sep` 开头且 `isActivePhase(phase)` 为真的会话（命中拒绝删除；引用会话清单由确认弹层打开时调 `GET /v1/files/workspace-overview/references?path=` 获取展示——失败信封 `fail()` 无 data 字段、desktop axios 拦截器在 `code !== 0` 时只取 message 丢弃 body，409 无法携带结构化清单）；④ 输入目录名确认 | 归档会话引用**允许删**（弹层明示后果，文件树见 §2.1-6 兜底文案）；「仅允许无任何引用」会让临时工作区永远删不掉 |
| D5 | 归属校验复用 | 与 `assertOwnedSessionWorkspace` 同口径的 userRoot 前缀判断（`session.routes.ts:652-660` 逻辑内联为服务私有函数，不导出复用——该函数是建会话路由的语义，删除是反向操作） | 防「抽公共函数顺手改了建会话语义」的耦合风险 |
| D6 | 删除实现 | `fs.rm(path, { recursive: true, force: false })`，进程内 per-path 互斥（防双击并发删） | 复用文件直管「物理删除 + 强确认、无回收站」先例；不做软删除 |
| D7 | 会话关联聚合 | 新增 repository 方法一条 SQL：`SELECT workspace, COUNT(*) total, SUM(isActivePhase 集合) active, MAX(updated_at) lastUsed FROM session WHERE user_id = ? AND workspace IS NOT NULL GROUP BY workspace`，JS 侧按目录前缀归并 | 一次查询无 N+1；`isActivePhase` 的相位集合在 SQL 内展开为 `phase IN (...)` 字面量 |
| D8 | VO 契约 | VO 本体后端 DTO + desktop types 各自定义（同 `SessionVO` 先例——SessionVO 确在 backend-ts 定义、desktop 本地镜像，不进 `@mao/contracts`）；但 `kind` / `sizeState` 两个跨端联合**下沉 `@mao/contracts`**（新增 `workspace.ts` 导出 `WorkspaceKind` / `SizeState`），desktop 类别 / 状态文案表用 `Record<WorkspaceKind, string>` 声明吃编译期穷尽 | AGENTS.md 跨端枚举收口规范：需要前端穷尽文案表的联合必须走 contracts（与 `SignalWatcherStatus` 同范式），VO 大字段本地镜像不受影响 |
| D9 | 失败降级 | 总览端点枚举失败返回空数组 + 错误字段；大小超时标 `timeout` 不重试；新建任务下拉请求总览失败回落现状 | 任何新链路失败都不影响既有功能可用性 |
| D10 | `cloud-projects` 端点 | 原样保留零改动 | 新建任务下拉回归面为零；富化数据走新端点并行叠加 |
| D11 | 排序与默认态 | 默认按最近使用降序，可切大小 / 名称 | 「最近在用的在上面」符合清理场景的排查顺序 |

## 4. 实现步骤

### 4.1 P1 后端（backend-ts，file 域）

1. 新增 `file/workspace-overview.service.ts`：
   - `listOverview(userId)`：`readdirSync(userRoot)` + `lstatSync` 过滤目录与符号链接；数字名 → `kind: 'temp'`；`projects` 目录展开其子目录 → `kind: 'project'`；其余 → `kind: 'other'`；`isGit = existsSync(join(dir, '.git'))`；合并缓存中的大小与 repository 聚合的会话计数，组 VO。
   - `scheduleSizeCompute(userId, paths)`：并发 4、单目录 walk（`fs.promises` 递归，深度 24 / 条目 20 万 / 30s 上限，符号链接 `lstat` 跳过），结果写缓存 `Map<`${userId}:${path}`, { bytes, state, at }>`，TTL 10 分钟；计算队列按最近使用降序入队（与 D11 默认排序一致，优先填用户正看到的行）；`invalidate(userId, path?)` 供刷新与删除调用。
   - `deleteWorkspace(userId, path)`：§3 D4 全部守卫 → per-path 互斥 → `fs.rm` → 缓存失效。
2. 新增 `session.repository.ts` 方法 `aggregateWorkspaceUsage(userId)`（§3 D7 的 SQL）。
3. `file.routes.ts` 增四个端点（登录态，无会话上下文）：
   - `GET /v1/files/workspace-overview`：列表 + 对无缓存的目录触发后台计算；
   - `GET /v1/files/workspace-overview/references?path=`：返回引用该目录的活跃会话清单 `[{ id, title, phase }]`（供删除确认弹层展示，D4 ③）；
   - `POST /v1/files/workspace-overview/refresh`：全量失效重算（body 可选 `{ path }` 单目录刷新）；
   - `DELETE /v1/files/workspace-overview`：守卫失败 409（message 说明原因，清单由弹层预先调 references 端点展示）或 400（路径越界 / 容器目录），成功返回 ok。
4. `workspace-browse.service.ts` 目录列举入口：会话工作区根 `existsSync` 为假时抛 `BusinessException(NOT_FOUND, '工作区目录不存在（可能已被删除）')`（目前为裸 ENOENT 500）。

### 4.2 P1 桌面（desktop）

1. `useCenterTabs.ts`：Tab 联合加 `type: 'workspace_overview'`；`openWorkspaceOverviewTab()`（单例 id `'workspace'`，已存在则激活），入口按钮放中央页签栏（与 Git 管理器入口同区域）。
2. `CenterTabBar.vue`：`tab.type === 'workspace_overview'` 图标分支（FolderOpened）；`CenterTabContainer.vue` 渲染分支 → `WorkspaceOverviewPanel.vue`。
3. 新增 `components/workspace/WorkspaceOverviewPanel.vue`：表格（§2.1-3 列）、排序切换、顶部刷新、行内刷新（仅 timeout / failed 行显示）、`pending` 一次性 3s 重查、行操作「用于新任务」（emit 给 TaskView 预填新建任务工作区，与现有深层组件→视图事件通道同范式）、删除按钮（P2）。
4. 新增 `types/workspace-overview.ts`（desktop 侧 VO）+ `api/index.ts` 三个调用。
5. TaskView 新建任务下拉富化：请求总览成功时给「复用已有」条目加副标题（大小 + 会话数），失败静默回落现状。

### 4.3 P2 桌面删除流

1. `WorkspaceOverviewPanel.vue` 删除按钮 → 确认弹层：展示目录名、大小、关联会话计数（进行中 / 归档分列，写明「归档会话的文件浏览与 Git 面板将不再可用」）+ 活跃引用清单（弹层打开时调 references 端点获取；有活跃引用则确认按钮禁用并内联展示清单）+ 输入目录名启用确认按钮 → DELETE → 成功后刷新列表 + toast。
2. 409 响应：message toast / 内联展示（结构化清单已在弹层内），确认按钮保持禁用。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `file/workspace-overview.service.ts`（新增）、`file.routes.ts`（四端点：overview / references / refresh / delete）、`session.repository.ts`（聚合查询）、`workspace-browse.service.ts`（缺根文案） |
| desktop | `useCenterTabs.ts`、`CenterTabBar.vue`、`CenterTabContainer.vue`、`components/workspace/WorkspaceOverviewPanel.vue`（新增）、`types/workspace-overview.ts`（新增）、`api/index.ts`、TaskView 下拉富化 |
| contracts | 新增 `workspace.ts`：`WorkspaceKind` / `SizeState` 两个联合（见 D8） |
| admin / android / agent-cli / mao-cli | 无（安卓随 Web 获得页签，响应式布局无需分支） |
| 测试 | 后端：overview 枚举三类 kind + 符号链接跳过 + 大小上限 / 超时降级 + 聚合 SQL 前缀归并 + 删除守卫四类（越界 400 / 容器 400 / 活跃引用 409 / 成功）+ 并发删除互斥 + cloud-projects 既有 spec 不动即回归；桌面：`vue-tsc -b` + 面板单测（pending 重查一次、删除确认门控、409 内联展示） |
| 文档 | 根 `CHANGELOG.md`「后端」「前端（桌面 / Web / 安卓）」两节；`skills/mao-cli/reference/desktop.md` 补「我的工作区」页签与删除说明；`USER_GUIDE.md` 工作区一节同步 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 大小统计打爆磁盘 IO | 单目录三重上限（深度 / 条目 / 超时）+ 目录间并发 4 + TTL 缓存 + 后台执行不阻塞请求；统计失败只影响该行展示 |
| 删错目录（路径逃逸 / 误删容器） | 解析后严格前缀校验 + 一级 / `projects/*` 白名单 + `projects` 容器硬拒 + 输入目录名确认 + per-path 互斥 |
| 删掉运行中任务的工作区 | `isActivePhase` 引用守卫 409 + 清单；相位口径与 fillTreeSignals / 桌面 ACTIVE_PHASES 同源，无第二套标准 |
| 删除后归档会话「变空」引发困惑 | 确认弹层强制展示会话计数；目录列举对缺根返回明确文案（§4.1-4），桌面既有 error 渲染直接生效 |
| 新建任务下拉回归 | `cloud-projects` 端点零改动；富化失败静默回落纯目录名 |
| 通道工作区被误认为遗漏 | 文档与页签空态注明「机器人通道工作区不在本人目录内，不在本页签范围」 |

## 7. 测试要点

1. 枚举：混合数字目录 / `projects` 子目录 / 其他目录 / 符号链接（指向根外），kind 判定正确、链接不跟随、`projects` 容器不出现在条目中。
2. 大小：常规目录累计正确；构造超深 / 超条目目录命中上限标 `timeout`；TTL 内二次请求命中缓存；`refresh` 后强制重算。
3. 聚合：同目录多会话（活跃 / 归档混合）计数正确；无引用目录计数为 0；`lastUsedAt` 取 max(updated_at)。
4. 删除：越界路径 400、`projects` 容器 400、活跃引用拒绝（references 端点返回清单、DELETE 返回 409）、仅归档引用确认后删除成功且缓存失效；双击并发只删一次。
5. 缺根文案：删除工作区后打开原会话文件树，错误信息为「工作区目录不存在（可能已被删除）」而非 500。
6. 回归：`GET /v1/sessions/cloud-projects` 响应结构与改动前逐字段一致；新建任务不传富化数据时行为不变。
