# Skills「运行依赖」抽象化技术方案

- 状态：已评审（可行，补充见 §10；2026-11-24 二次评审补充见 §11，实施以 §11 为准）；待开发
- 日期：2026-11-23
- 一句话：把管理后台 Skills 列表里为 browser-use 特设的「浏览器依赖」列，泛化为数据驱动的「运行依赖」列；后端从单技能服务改为 provider 注册表，新增依赖型内置技能（lark-cli、dingtalk-cli、office-use…）时前端零改动。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 后端现状：`backend-ts/src/browser-deps/browser-deps.service.ts`（505 行；`BROWSER_DEPS_SKILL_NAME` :29、setting key :30、`ensureForSkills` :360）、`backend-ts/src/browser-deps/browser-deps.routes.ts`（`/v1/admin/browser-deps/{status,install}`）、`backend-ts/src/app-routes.ts:229`（类型）/`:736`（非空才注册）、`backend-ts/src/create-app.ts:426`（晚绑定 forward）/`:696`（装配）/`:702`（赋值）/`:1105`（注入）、`backend-ts/src/agent/agent.service.ts:25`（`AgentBrowserDepsEnsurer`）/`:121`、`:167`（保存钩子）、迁移 `backend-ts/db/migration/V200__browser_deps_status_setting.sql`
  - 前端现状：`admin/src/views/skill/SkillListView.vue`（列 :167-176、安装按钮 :186-197、移动端卡片 :292-302、状态与轮询 :379-432）
  - 文档现状：`skills/mao-cli/reference/deploy.md:83`（写明列名「浏览器依赖」）、`skills/bundled/README.md` 末行
- 关联方案：[2026-11-20 浏览器直播与 browser-live-pip](../2026-11/2026-11-20-browser-live-pip-technical-design.md)（D7 v2 修订：依赖按需化）、[2026-11-21 browser-use Windows LOCAL 支持](../2026-11/2026-11-21-browser-use-windows-local-technical-design.md)、[2026-11-20 内置技能](../2026-11/2026-11-20-builtin-skills-technical-design.md)（bundled 子目录即内置技能）。

## 1. 现状与问题

「浏览器依赖」列把 `browser-use` 焊死在四个地方：service 的 `BROWSER_DEPS_SKILL_NAME`（browser-deps.service.ts:29）、setting key `browser_deps.status`（:30）、端点 `/admin/browser-deps/*`（browser-deps.routes.ts）、前端渲染条件 `row.name === 'browser-use'`（SkillListView.vue:170、187、292、301）。

这引出一个更根本的窄化：**现状把"依赖"等同于"可安装的二进制"**。考察几个候选内置技能的真实依赖形态：

- `browser-use`：CLOUD 服务器需要 Chrome + `@playwright/cli`，可安装 → install 类。
- `lark-cli` / `dingtalk-cli`：依赖不只是安装，还有**凭证与开关**。按现状硬加会得到"依赖未安装 + 安装按钮"的荒谬组合。**更正（§11.1）**：lark-cli 已接入 CLOUD shell，凭证来自 ECP 配置 `auth.ecp.config.larkAppId` + 用户 ECP 会话换出的 user_access_token（`auth/lark-uat-injector.ts`、`shell-session-tool` 注入 `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_APP_ID`），**不读 `feishu_bot`**；且服务器上的 lark-cli 二进制没有任何脚本负责安装。它是 install + config 的**混合**形态，不是纯 config。
- `office-use`：未必零服务器依赖——若产出 docx/xlsx/pdf 的转换或预览要落 LibreOffice / pandoc，它就还是 install 类。此处不作为"零依赖"样板，按实际实现评估。

结论：值得抽象的不是安装实现（各家安装链形态迥异，browser 是 npm/apt/winget/镜像重建，computer-use 甚至可能只在 LOCAL、依赖在用户机上），而是**契约：状态词表、按技能的寻址、安装/配置两种动作、前端一列数据驱动渲染**。本方案落地后，新增依赖型技能的增量是"注册一个 provider"，前后端零改动。

## 2. 目标与非目标

### 2.1 目标

1. 后端把 browser-use 的依赖服务收拢为 provider 注册表：`skill name → provider`，统一 status 聚合与 install 派发；安装链内部逻辑零改动。
2. 依赖条目支持两种 kind：`install`（可安装，四态状态机原样保留）与 `config`（配置态，读既有配置推导状态，动作为前端跳转「去配置」，无安装流程）。
3. 端点泛化：`GET /v1/admin/skill-deps/status` + `POST /v1/admin/skill-deps/:skill/install`，替换 `/admin/browser-deps/*`。
4. 管理后台 Skills 列表列名改「运行依赖」，渲染条件从技能名硬编码改为"status map 里有该技能"；browser-use 的展示与今天一致（tag 文案、tooltip、安装确认、2.5s 轮询语义不变）。
5. Agent 勾选技能保存时的自动 ensure 机制保留（接口更名，策略不变）。
6. 沉淀一份"新增依赖型技能"操作手册（§9），lark-cli / dingtalk-cli / office-use 落地时按清单执行即可。

### 2.2 非目标

- 不为尚不存在的 lark-cli / dingtalk-cli / office-use 写 provider——契约与手册先行，provider 随技能交付。
- 不统一安装实现：各家 install 链自治，registry 只定义接口。
- 不用 SKILL.md frontmatter 声明依赖：frontmatter 是给 LLM 的提示词，不是机器契约。注意 provider 与内置技能**没有编译期关联**——内置技能有两个来源（`skills/builtin.json` 白名单当前只有 `mao-cli`；`skills/bundled/` 目录扫描才有 `browser-use`，见 `builtin-skill-catalog.ts`），所以靠 D16 的启动期一致性断言防漂移，不靠"同源"。
- 不做桌面端 / LOCAL 依赖展示：LOCAL 依赖在用户机上，属桌面端 UI，另案。
- 不做依赖版本管理、自动升级、健康巡检（只装 latest + 读取时检测，现状语义）。
- 不动 browser-use 安装链本身（host/docker/win32 分支、单飞、30min 孤儿降级），不动 V200 迁移。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 抽象边界 | provider 注册表统一契约（状态词表 / 寻址 / 动作），安装实现各家自治 | 安装链形态差异是本质的：apt/winget/镜像重建 vs 读一张配置表。强行统一只会得到一个大而空的状态机加一堆特例分支 |
| D2 | 模块布局 | 新增 `backend-ts/src/skill-deps/`（service + routes + providers + specs）；`browser-deps/` 保留为 browser-use 的 install provider 实现，内部逻辑零改动，删除 `browser-deps.routes.ts` | 安装链 505 行、跨三分支且有完整单测，原样保留风险最低；注册表是新概念，独立成域 |
| D3 | 端点 | `GET /v1/admin/skill-deps/status`（skill:read，返回按技能名键控的聚合状态）+ `POST /v1/admin/skill-deps/:skill/install`（skill:write）。旧端点删除不留 | 前后端同仓同时发布，无外部消费方；AGENTS.md 初版不保存量兼容。按技能寻址后无需每技能一对端点 |
| D4 | 与技能列表的关系 | 不动 `/v1/skill-docs` 与 `SkillDocService`；前端按 `row.name` 从 status map 取该技能条目合并展示 | 今天前端本就是两次 fetch（列表 + browser-deps status），合并逻辑从 `row.name === 'browser-use'` 改为 map 查找即消除硬编码，后端列表 API 不受依赖概念污染 |
| D5 | 依赖种类 | `kind: 'install' \| 'config'`。install 复用四态（not_installed/installing/ready/failed）；config 只产生 ready / not_installed，动作是 `action: { label:'去配置', route, permission? }`（见 D15），无 install（被调用返回 409） | lark-cli 类技能的阻塞点是凭证不是二进制；config provider 直接读既有 bot 仓库，零新存储，还避免技能页与渠道页状态漂移。"就绪"的判定口径留待 lark-cli 方案定：`feishu_bot` 是多行软删表（`enabled` + `deleted`），"至少一个未删且启用"与"技能实际引用的那一个 bot"是两种口径，现在写死会猜错 |
| D6 | 存储 | provider 自持：browser-use 继续用 `browser_deps.status`（V200 不动），registry 不引入统一 key | 各 install 状态机形态不同（browser 有 chrome/cli 双检测、docker 镜像重建），统一 key 只会逼出嵌套 JSON schema 与迁移，收益为零 |
| D7 | Agent ensure | `AgentBrowserDepsEnsurer` 更名 `AgentSkillDepsEnsurer`，**方法名 `ensureForSkills(skillNames)` 不变**；registry 把完整名单透传给每个 provider，由 provider 按自己的 `skillName` 自过滤（browser 现有的 `includes('browser-use')` 判断原样保留） | 保存路径的"哪些技能要 ensure"是产品策略，保持显式列举；provider 自过滤即今天的口径，registry 不掺合策略。方法名与签名不变 → `browser-deps.service.spec.ts:342` 的 ensure 用例与 `agent.service.spec.ts:347` 的结构性 mock 用例零改动 |
| D8 | 前端展示 | 列名「浏览器依赖」→「运行依赖」；渲染条件改为 status map 存在该技能；tag 文案用 phase 四态通用映射（依赖未安装/依赖安装中/依赖安装失败/依赖就绪），chromium 等细节进 tooltip；item 可带 `text` 覆盖文案（config 的 not_installed 显示「未配置」而非「依赖未安装」） | 今天 frontend 里最后一处 browser 特判是 `chrome.kind === 'chromium'` 的「（chromium）」后缀（SkillListView.vue:397），收进 provider 的 detail 后前端完全通用 |
| D9 | 安装入口 | install kind 且未就绪且非 installing → popconfirm「安装依赖」，确认文案优先取 item.`installConfirm`（browser-use 原样保留今天的文案），缺省 `将在服务器上自动安装${label}，可能需要数分钟，确认开始？`；config kind 未就绪 → 「去配置」文字链跳 `action.route`；一个技能多个 items 时安装按钮取第一个可安装项（当前无此场景，契约先行） | 确认文案含具体组件清单时有信息量，但不能让前端按技能名拼文案——交给 provider 给全文 |
| D10 | 并发 | provider 内单飞不变（browser 的 `inFlight`）；不同技能允许并行安装；registry 不加全局锁；install 对 installing / ready 返回 `started:false` | 安装是低频管理操作，跨技能并行的资源争用以各 provider 单飞 + apt/npm 幂等兜底，与现状一致 |
| D11 | 名称校验与未知技能 | **复用 `isValidSkillName()`**（`harness/skill/skill-md.ts:14`，`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`），不另写正则；status 聚合只含已注册技能（未注册技能自然不出现在 map 里，列表对应行该列空白）；install 未知技能 404 | 另写小写版 `^[a-z0-9]...` 会与技能装载器口径分叉：`SkillMd` 允许大写开头（`isValidSkillName` 是唯一权威），providers 注册一个合法大写名后 install 恒 400。写死两份正则就是下一个漂移点 |
| D12 | 轮询 | 2.5s 轮询保留，数据源换 `/admin/skill-deps/status`；任一 item 处于 installing 续轮，终态停轮并刷新技能列表（现状 SkillListView.vue:416-422 逻辑保留），**新增重入门闩**：上一次 status 未返回则跳过本次 tick | 管理后台无 WS 通道，轮询是既有口径。`setInterval` 不等待上一次返回，聚合后单次请求可能因 docker 探测慢到十几秒，无闩会堆叠请求并成倍起一次性探测容器 |
| D13 | 跨端类型归属 | `SkillDepsKind` / `SkillDepsPhase` / `SkillDepsItem` / `SkillDepsStatusMap` 下沉 `shared/contracts/src/skill-deps.ts`，backend-ts 侧 re-export；`SkillDepsProvider` 留在后端 | AGENTS.md 明文：跨端枚举一律走 `@mao/contracts`，禁止前端内联手写联合类型与后端并行（先例 `LlmCallScene`、`SignalCompareMode`）。phase 正是前端要穷尽映射文案的枚举，放后端等于把今天的隐患再造一遍 |
| D14 | 聚合容错与并发 | `getStatusMap()` 用 `Promise.allSettled` **并发**、逐 provider 隔离异常：某 provider 抛错/超时 → 该技能降级为单项 `failed`（detail 写摘要），其余技能照常返回，绝不整体 500；单个 provider 探测加超时上限，整体响应须落在前端 30s axios 超时内 | browser provider 的 status 在 host 模式要串行探 4 个 chrome 候选（各 8s）、docker 模式要 `docker run` 一次性容器（20s）。串行 for-await 加多 provider 必然突破 30s；一个 provider 挂掉让整列消失比不显示更糟 |
| D15 | config 的权限可见性 | `SkillDepsItem.action` 增加可选 `permission`（如 `feishu-bot:read`）；前端仅在 `authStore.hasPermission(action.permission)` 时渲染可点「去配置」，否则渲染不可点文本 + tooltip「无该配置页权限」 | Skills 页只要 `skill:read`，渠道配置页要 `feishu-bot:read` / `dingtalk-bot:read`（`admin/src/router/index.ts:163,169`）。只有技能权限的角色点链接会被路由守卫弹回，表现为「按钮坏了」而非「没权限」 |
| D16 | 与内置技能的一致性 | `SkillDepsService` 构造时校验每个 `provider.skillName`：名字非法或重复 → 抛错（编码错误，与 `BuiltinSkillCatalog` 对白名单的严格性一致）；技能目录里找不到 → **只 warn 不抛**（部署时 skills 目录未同步属运维态，不该让后端起不来），该断言放单测强校验 | provider 与技能目录无编译期关联（见 §2.2）：技能改名/删目录后 provider 变死代码，前端永远不渲染它，且没有任何测试会红。但"起不来"与"这一列空着"的代价不对等，分开处理 |

## 4. 行为契约

### 4.1 类型

前四组（`SkillDepsKind` / `SkillDepsPhase` / `SkillDepsItem` / `SkillDepsStatusMap`）落 `shared/contracts/src/skill-deps.ts` 并从 `contracts/src/index.ts` 导出（D13）；`SkillDepsProvider` 依赖 `Promise`、属后端接口，留 `skill-deps.types.ts`。

```ts
// shared/contracts/src/skill-deps.ts —— 前后端共用
type SkillDepsKind = 'install' | 'config';
type SkillDepsPhase = 'not_installed' | 'installing' | 'ready' | 'failed';

interface SkillDepsItem {
  id: string;            // provider 内稳定 id，同一技能下唯一（前端 :key、日志定位）
  label: string;         // 依赖组名，如 '浏览器依赖' / '钉钉机器人'
  kind: SkillDepsKind;
  phase: SkillDepsPhase;
  detail: string | null; // tooltip 里的实况细节（版本号、缺什么、为什么）；禁止回显凭证
  text?: string;         // 覆盖 phase 默认文案（config 的 not_installed → '未配置'）
  action?: { label: string; route: string; permission?: string }; // config：去配置跳转（permission 见 D15）
  installConfirm?: string;                                        // install：确认弹窗全文
}

/** GET /v1/admin/skill-deps/status 的 data；键为技能名，未注册技能不出现 */
type SkillDepsStatusMap = Record<string, { items: SkillDepsItem[] }>;

// backend-ts/src/skill-deps/skill-deps.types.ts —— 仅后端
interface SkillDepsProvider {
  readonly skillName: string;                 // 必须等于内置技能 frontmatter name（D16 校验）
  status(): Promise<SkillDepsItem[]>;         // 只读、可重复调用；异常由 registry 隔离（D14）
  install?(): Promise<{ started: boolean }>;  // install kind 必有；返回值只需 started，status 由前端重取
  ensureForSkills?(skillNames: readonly string[] | null | undefined): void; // Agent 勾选保存触发，自吞异常
}
```

约定：`config` provider 只产出 `ready` / `not_installed`（类型不收窄——前端按 phase 通用渲染，provider 若吐出 other 态也会被正确显示而非崩溃）；`install` 包装层返回 `{ started }`，不透传 browser 的 `status` 字段（前端收到 `started:false` 后重拉聚合即可，避免两套状态形态）。

### 4.2 status 聚合

`GET /v1/admin/skill-deps/status` 并发遍历 registry（`Promise.allSettled`），返回 `{ skills: SkillDepsStatusMap }`。未注册技能不出现在 map 里（前端对应行该列空白，与今天 mao-cli 等行一致）。

**容错（D14）**：单个 provider 的 `status()` 抛错或超时，只把该技能降级为单项 `{ id:'status', label:'依赖状态', kind:'install', phase:'failed', detail:'读取依赖状态失败：<摘要>' }`，其余技能照常返回；聚合整体不 500。逐 provider 探测设超时上限（browser 的 `getStatus` 内部 docker 探测已有 20s exec 超时，registry 侧再兜一层 `Promise.race`，保证整请求在 25s 内返回，留出前端 30s axios 余量）。**不要写成串行 `for-await`**：browser 在 host 模式要依次探 4 个 chrome 候选（各 8s）再探 cli（8s），串行叠加多 provider 必然撞超时。

browser-use provider 的映射：`phase ← getStatus().phase`；`detail ← stored detail ?? 实况拼装（chrome 版本 / cli 版本，chromium 降级时标注）`；`label = '浏览器依赖'`；`installConfirm` 保留今天弹窗原文（"将在服务器上自动安装浏览器依赖（Chrome/chromium + playwright-cli，可能需要数分钟），确认开始？"）。

### 4.3 install 派发

`POST /v1/admin/skill-deps/:skill/install` → `isValidSkillName(:skill)` 不通过 → 400；查 provider 无 → 404；`provider.install == null` → 409（文案说明该依赖无需安装、应去配置，即 config 类）；否则调 `provider.install()`，`started:false` 时前端保持当前展示（installing 中或已就绪）。

派发粒度是 **provider**、不是 item：`kind` 只在 item 上，`install` 方法只有 provider 有——一个 provider 若返回多个 install-kind item（如"Chrome"+"playwright-cli"），一次 `install()` 负责全部；混合 kind 的 provider 仍可安装（前端只按 item.kind 决定渲染按钮还是「去配置」链接，点下去调的是同一个 provider 的 install）。当前无混合场景，契约先行。

### 4.4 ensure

`registry.ensureForSkills(names)`：names 为 null/空直接返回；否则把**完整名单**透传给每个 provider 的 `ensureForSkills`（存在该方法的），由 provider 按自身 `skillName` 过滤——browser provider 现有的 `if (!skillNames?.includes('browser-use')) return` 原样保留。全程 fire-and-forget，异常自吞（harnessLog warn）。调用点不变：agent.service.ts 创建（:121）与更新（:167）路径、create-app.ts:426 forward 晚绑定。config provider **不实现** `ensureForSkills`：凭证无法自动安装，实现了也只能 no-op，留着是误导。

### 4.5 前端合并与轮询

系统 Skills 表每行：`deps = status.skills[row.name]`（响应是 `Result<{ skills }>`，前端 `const { data } = await api.get(...)` 后取 `data?.skills ?? {}`）；存在则渲染该行单元格（每个 item 一个 tag，tooltip 为 `detail`——**不要拼 label**，browser 的 detail 已自带"就绪：系统 Chrome + playwright-cli"，拼上「浏览器依赖」会重复），否则留空。安装中（任一 item `phase === 'installing'`）以 2.5s 续轮 status，终态停轮并重新拉 `/skill-docs`（保留现状；严格说按钮可见性现在由 status map 决定、刷新列表可省，但留着无害且与今天一致）；重入门闩：`polling` 为 true 时跳过本 tick（D12）。个人 Skills 表不涉及（依赖是系统级概念）。

config 的「去配置」：`action.permission` 存在时要求 `authStore.hasPermission(action.permission)`，否则渲染为不可点的灰文本 + tooltip「无该配置页的访问权限」，绝不让用户点进路由守卫的 403（D15）。

## 5. 改动面

### 5.1 后端

新增 `shared/contracts/src/skill-deps.ts`：§4.1 前四组类型（D13），并在 `contracts/src/index.ts` 加 `export type { SkillDepsKind, SkillDepsPhase, SkillDepsItem, SkillDepsStatusMap } from './skill-deps'`。

新增 `backend-ts/src/skill-deps/`：

- `skill-deps.types.ts`：`SkillDepsProvider` 接口，其余共用类型从 `@mao/contracts` re-export（保持后端既有 import 路径习惯）。
- `skill-deps.service.ts`：`SkillDepsService`，构造接收 `providers: SkillDepsProvider[]`（构造时做 D16 校验：非法名/重名抛错，技能目录缺失只 warn），提供 `getStatusMap()`（并发 + 隔离，见 §4.2）、`install(skillName)`（§4.3）、`ensureForSkills(names)`（§4.4）。自身不做探测、不碰存储，探测与状态机全在 provider。
- `skill-deps.routes.ts`：两个端点，权限码与审计口径同今天（`/v1/admin` 前缀自动进审计拦截器）。
- `skill-deps/providers/browser-deps.provider.ts`：把现有 `BrowserDepsService` 包成 provider（status 映射见 §4.2；`install` 裁成 `{ started }`、`ensureForSkills` 原样直通）。

修改：

- `browser-deps/browser-deps.service.ts`：**零改动**（D7 方法名不变，provider 包装层直通其 `ensureForSkills` / `install` / `getStatus`）。
- 删除 `browser-deps/browser-deps.routes.ts`；`app-routes.ts:171` 的 import 一并删除。
- `app-routes.ts`：`browserDeps?: BrowserDepsService`（:229）→ `skillDeps?: SkillDepsService`，:378 的解构与 :735-736 的注册一起吃，换成 `registerSkillDepsRoutes`。
- `create-app.ts`：:696 构造处改为"构造 BrowserDepsService → 包 provider → 构造 SkillDepsService([browserProvider])"，:426 的 forward target 类型与 :702 赋值、:1105 注入一并换；forward 的目标类型注释更新（"浏览器依赖服务" → "技能依赖服务"）。D16 的技能名一致性校验直接复用 :633 已加载的 `builtinSkills`（`builtinSkills.map(s => s.name)`），**不要再 load 一次** `BuiltinSkillCatalog`——那会在启动期重复扫描目录并重复打日志。
- `agent/agent.service.ts`：接口名 `AgentBrowserDepsEnsurer` → `AgentSkillDepsEnsurer`（:25 接口、:35 构造参数、注释同步），调用点（:121、:167）不动。
- 注释同步（端点改名后过期）：`admin/src/views/settings/SystemSettingsView.vue:431`、`admin/src/views/settings/integrationGroupWiring.spec.ts:82` 都写着 `/admin/browser-deps`，改成 `/admin/skill-deps`。

### 5.2 前端

新增 `admin/src/utils/skillDeps.ts`（纯函数，可单测，见 §8）：`depsFor(map, name)`、`phaseText(phase)`（`Record<SkillDepsPhase, string>` 全量映射，吃编译期穷尽）、`phaseTagType(phase)`、`primaryInstallable(items)`（返回第一个可安装项，无则 null）、`configAction(items, can)`（`can` 是 `(code: string) => boolean` 注入，返回第一个 action 存在且权限可用的项，无则 null）、`hasInstalling(map)`。权限判断用注入而非在 utils 里引 store，保持纯函数可测。

修改 `admin/src/views/skill/SkillListView.vue`：

- 列定义：`label="浏览器依赖"` → `label="运行依赖"`；宽度 130 → **160**（单 tag 130 够用，但契约允许多 item，多 tag 需要一行放两个；若嫌宽可改 `min-width` 交给表格自适应）、单元格按 `depsFor(row.name)` 遍历 items 渲染 tag（`item.text ?? phaseText(item.phase)`，`:type="phaseTagType(item.phase)"`）。
- 安装按钮：`v-if` 改为 `primaryInstallable(depsFor(row.name)?.items)` 非空；确认标题取该项 `installConfirm`（缺省按 D9 的通用文案）；`handleInstallBrowserDeps` → `handleInstallDeps(row.name)`。
- config kind 未就绪：渲染 `<el-button link>` 「去配置」，`router.push(item.action.route)`；`configAction` 判权限失败时渲染不可点灰文本 + tooltip（见 §4.5）；不出现安装按钮。
- 移动端卡片（:292-302）同口径，label「运行依赖」。
- 状态管理（:379-432）：`browserDeps` ref → `skillDepsStatus` ref（`SkillDepsStatusMap`）；fetch 换 `api.get('/admin/skill-deps/status')`、install 换 `api.post('/admin/skill-deps/${name}/install')`（`api` 的 baseURL 是 `/api/v1`，与现状 `'/admin/browser-deps/status'` 同一写法）+ 加重入门闩（D12），其余不变。
- 删除 `browserDepsTag` computed 及 `chrome.kind === 'chromium'` 分支（chromium 后缀已进 provider 的 `detail`）。

## 6. 界面

- 系统 Skills 表格新增/改造一列「运行依赖」（宽度 130 → 160，容纳多 tag 时换行由 tooltip 兜底）。browser-use 行展示与今天一致：未安装「依赖未安装」、安装中「依赖安装中」、失败「依赖安装失败」、就绪「依赖就绪」，hover 出 detail（chromium 降级时 tooltip 里带后缀）。
- 「安装依赖」按钮位置与 popconfirm 交互不变（仅数据来源变化）；「去配置」为普通文字链，无确认框。
- 其余技能行该列空白（与今天一致）；个人 Skills 表无此列。

## 7. 安全

- 权限码不变：status `skill:read`、install `skill:write`；`/v1/admin` 前缀继续自动进审计拦截器。
- skill 名复用 `isValidSkillName` 白名单式校验（D11）；name 只用于 provider map 精确查找，不进入任何 exec 参数——安装链的命令构造全部在既有 provider 内，本次不改。
- config kind 无安装入口即无命令执行面；`action.route` 仅作前端跳转，不参与后端任何 IO。
- **detail 不得回显凭证**：config provider 的 `detail` 只写「已配置 / 未配置 / 机器人名称 / 启用状态」，禁止带 appSecret（哪怕是前几位）、token、完整 webhook。status 是 `skill:read` 可读的，比渠道配置页要求的 `feishu-bot:read` 更宽。
- 安装确认弹窗保留破坏性操作确认模式；安装过程日志口径不变。

## 8. 测试与文档

后端（`cd backend-ts && npm test`）：

- 新增 `skill-deps.service.spec.ts`：status map 只含已注册技能；未知技能 install 抛 404；非法名 400；无 `install` 方法的 provider 被 install 拒绝（409）；`ensureForSkills` 把完整名单透传给各 provider、null/空名单 no-op；多 provider 并行 install 互不阻塞；**provider.status 抛错时该项降级 failed、其余技能仍在返回里**（D14）；**两个 provider 的 status 是并发而非串行**（用可控 promise 断言交错）；构造期拒绝重复 `skillName` 与非法名、但技能名不在内置目录时只 warn 不抛（D16）；大写技能名（`MySkill`）能通过校验并被派发（D11）。
- 新增 `skill-deps.routes.spec.ts`：status 需 `skill:read`、install 需 `skill:write`；聚合结构符合 §4.2；未知技能 404；config 技能 install 409。
- `browser-deps.service.spec.ts`：**零改动**（D7 后该方法签名与文件均不变，:342 `describe('BrowserDepsService ensureForSkills')` 原样通过；注意方案早先写的 :262 是 docker 探测用例，不是 ensure）。
- `agent.service.spec.ts`：**零改动**（:347 注入的是结构性 mock `{ ensureForSkills: vi.fn() }`，接口改名不影响；已核实）。

前端（`cd admin && npm test && npm run build`）：

- 新增 `admin/src/utils/skillDeps.spec.ts`（纯逻辑）：`phaseText` 四态全覆盖、`phaseTagType` 映射、`primaryInstallable` 跳过 ready/installing 与 config 项、多 item 取第一个可装、`configAction` 在 `action.permission` 缺失 / `can` 返回 true / 返回 false 三种情况下的结果、`hasInstalling` 对空 map 与混合 map 的判定、`depsFor` 对未注册技能返回 undefined。
- **不写 `SkillListView.spec.ts` 组件测试**：`admin/vitest.config.ts` 明文「只覆盖纯逻辑（如 utils/embedContext），不引入组件测试框架」，且 `admin/package.json` 无 `@vue/test-utils`。为这一列引入组件测试基建是另一个量级的改动，与既有约定冲突。把渲染判定抽进 `utils/skillDeps.ts` 后，组件里只剩模板绑定，风险由 `npm run build` 的 vue-tsc 校验兜住。
- 构建验证必须 `npm run build`（vue-tsc -b + vite build），不以 `npx vue-tsc --noEmit` 替代。

文档（同任务）：

- `changelog/unreleased/2026-11-23-skill-runtime-deps.md`：`### 管理后台`（Skills 列表「浏览器依赖」列改「运行依赖」，按技能展示，配置类依赖提供「去配置」入口）+ `### 后端`（依赖端点泛化为 `/admin/skill-deps/*`，内部重构无行为变化）两节。
- `skills/mao-cli/reference/deploy.md:83`：列名改「运行依赖」，补一句"按技能展示，未注册依赖的技能该列为空"。
- `skills/bundled/README.md` 末行同步列名。
- 不加 Playwright（已核实现有用例不断言该列）。

## 9. 新增一个带依赖的内置技能（操作手册）

以后 lark-cli / dingtalk-cli / office-use 落地时：

1. `skills/bundled/<name>/SKILL.md`（既有内置技能流程，见 2026-11-20 方案）。
2. 评估依赖形态：确认无服务器依赖（纯 LLM + 脚本直接产文件）→ 到此为止，Skills 页该列为空，正确行为。若转换/预览要落 LibreOffice、pandoc 之类二进制，按 install 类处理。
3. 有依赖 → `backend-ts/src/skill-deps/providers/<name>.ts` 实现 `SkillDepsProvider`：
   - install 类：自持存储（参照 `browser_deps.status` 加一条 `system_setting` 种子迁移）、四态状态机、install 链、`ensureForSkills`；
   - config 类：读既有平台配置（如 `feishu_bot` / `dingtalk_bot` 仓库）推导 ready / not_installed，`action.route` 指向既有配置页、`action.permission` 填该页路由守卫要的权限码，不新增存储，不实现 `install` / `ensureForSkills`。
4. `create-app.ts` 注册进 `SkillDepsService` 的 providers（需要晚装配的走既有 forward 模式）。
5. 补 provider 单测 + 在 `skill-deps.routes.spec.ts` 加一条"该技能出现在 status map"；确认技能名同时存在于 `skills/bundled/` 或 `builtin.json`（D16 的构造期校验会兜，但测试里显式断言更早暴露）。
6. **admin 前端零改动**——列按 status map 渲染；如安装类需要"Agent 勾选即装"，在 `provider.ensureForSkills()` 内实现，保存钩子已通用。

## 10. 评审结论（2026-11-23）

**需求可行，方案可行。** 改动面是"新增一个薄 registry + 包一层 provider + 前端一列数据驱动"，不动安装链、不动 V200、不加迁移，回归风险集中在管理后台这一列。正文已按评审结果修正，摘要如下。

### 10.1 已修正的硬问题（原方案会导致实施不下去）

1. **D11 的正则与技能装载器分叉**：原文写 `^[a-z0-9][a-z0-9_-]{0,63}$`，而 `isValidSkillName`（`harness/skill/skill-md.ts:14`）允许大写开头。provider 注册一个合法大写名后，前端每次点安装都 400。已改为复用 `isValidSkillName`。
2. **类型只放 backend-ts，违反跨端枚举规范**：`SkillDepsPhase` 正是前端要穷尽映射文案的枚举，按 AGENTS.md 必须下沉 `@mao/contracts`（先例 `LlmCallScene` / `SignalCompareMode`），否则前端又内联手写一份联合类型。已加 D13 并改 §4.1 / §5.1。
3. **前端测试方案没有基建**：`admin/vitest.config.ts` 明文"只覆盖纯逻辑，不引入组件测试框架"，`admin/package.json` 没有 `@vue/test-utils`。原 §8 的 `SkillListView.spec.ts`（断言 tag/tooltip/轮询/按钮）写不出来。已改为抽 `utils/skillDeps.ts` 纯函数 + 纯逻辑 spec，组件只留模板绑定（见 §5.2 / §8）。

### 10.2 已补充的遗漏

- **D14 聚合容错与并发**：原 §4.2 只说"遍历 registry"。串行 for-await 叠上 browser 的 4 候选 chrome 探测（各 8s）+ docker 一次性容器（20s）会直接撞前端 30s 超时；任一 provider 抛错还会让整列 500。已定 `Promise.allSettled` + 逐 provider 降级 failed + 整体 25s 上限。
- **D12 轮询重入门闩**：`setInterval` 不等待上一次返回，聚合后单次可能十几秒，无闩会堆叠请求并成倍起探测容器。
- **D15 「去配置」的权限错配**：Skills 页只要 `skill:read`，渠道页要 `feishu-bot:read` / `dingtalk-bot:read`。已给 `action` 加可选 `permission`，无权限时渲染灰文本而非可点链接。
- **D16 provider 与内置技能的一致性**：provider 与技能目录无编译期关联（`builtin.json` 白名单只有 `mao-cli`，`browser-use` 来自 `skills/bundled/` 扫描）。技能改名/删目录后 provider 变死代码且无测试会红。已加构造期校验：非法名/重名抛错、目录缺失只 warn（不让运维态拖垮启动），强断言放单测。
- **§7 凭证泄露面**：status 是 `skill:read` 可读，能配 `feishu-bot:read` 的人反而更少；已明确 `detail` 禁止回显 appSecret / token / webhook。
- **§4.3 派发粒度澄清**：`kind` 在 item 上、`install` 在 provider 上，混合 kind 的 provider 仍可安装，避免实现时把 409 判定写成"看 item.kind"。
- **事实修正**：`browser-deps.service.ts` 是 505 行（非 446）；ensure 用例在 spec:342（非 :262）；`create-app.ts` 锚点 426 / 696 / 702 / 1105（非 419 / 689 / 1098）；表名是 `feishu_bot`（单数，多行软删）；tooltip 只取 `detail`（拼 label 会与"就绪：…"重复）；列宽取 160（130 放单 tag 够、多 item 会折行）。
- **注释同步**：`SystemSettingsView.vue:431`、`integrationGroupWiring.spec.ts:82` 两处写着 `/admin/browser-deps`，随端点改名一起改（原 §8 漏了）。

### 10.3 需求层面的不确定（不阻塞本方案，但别写死）

1. **当前零消费者**：`skills/bundled/` 只有 `browser-use`，`builtin.json` 只有 `mao-cli`。这是典型的"为 0 个现存消费者建抽象"。方案自己已声明契约先行、不为不存在的技能写 provider，这个边界要守住——尤其**不要**现在就去猜 lark-cli 的 config 语义。
2. **"lark-cli 卡在没配 bot"这个前提没有被验证**：`feishu_bot` 多行软删，技能运行时到底用哪个 bot 的凭证、还是走 user_access_token，直接决定 config provider 是"至少一个启用即 ready"还是"必须引用某个具体 bot"。若 lark-cli 根本不依赖 bot 配置，这条 config 链路就该整条删掉。§4.1 的 `action` / §4.3 的 409 语义已按最小化处理，改起来只影响一个 provider。
3. **office-use 未必零依赖**：若产出 docx/xlsx/pdf 的转换或预览要落 LibreOffice / pandoc，它就是 install 类。已把原文"大概率零依赖"改成按实际实现评估。

### 10.4 建议实施顺序

后端（contracts 类型 → service + 容错 → routes → browser provider 包装 → app-routes/create-app 装配 → agent 接口改名）→ 后端 spec → 前端 `utils/skillDeps.ts` + spec → 视图改造 → `npm run build` → 文档与 changelog 碎片。删除旧路由放在 provider 包装跑通之后一步，保证任一中间态都能编译。

## 11. 二次评审补充（2026-11-24）

**结论不变：需求可行，方案可行。** 但 §10 之后工作区已合入「角色技能授权」（2026-11-24 role-skill-grant 方案），导致正文改动面漏了一个 ensure 调用方、行号整体漂移；另有 lark-cli 前提事实错误、降级态会打断轮询两处设计缺口。以下条目与正文冲突时以本节为准。

### 11.1 事实更正：lark-cli 不依赖 `feishu_bot`

已核实：lark-cli 已经在 CLOUD shell 可用，凭证链是 ECP 配置 `auth.ecp.config` 的 `larkAppId`（`auth/ecp.config.ts:20`，非空才注入）+ 用户 ECP 会话换出的 user_access_token（`auth/lark-uat-injector.ts`，由 `create-app.ts` 的 `createLarkUatInjector` 装配），shell 注入 `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_APP_ID`（`shell-session-tool.spec.ts:454-459`）。仓库内没有任何脚本/Dockerfile 安装 lark-cli 二进制。

影响：

1. §10.3-2 的疑问已有答案——**"lark-cli 卡在没配 bot"不成立**，config provider 不该读 `feishu_bot`。lark-cli 的依赖是三层：
   - 服务器二进制（install 类，系统级，可在本列展示）；
   - ECP 启用 + `larkAppId` 非空（config 类，系统级，可在本列展示，去配置页是「系统设置」，权限 `settings:read`）；
   - 用户本人 ECP 登录态（**按用户**，管理后台系统级列表无法表达，不进本列，由运行时报错指引兜底）。
2. 因此 §4.3 的"混合 kind provider"不再是"契约先行"，而是 lark-cli 落地时的**首个真实场景**；本方案契约（item 级 kind、provider 级 install）已能承载，无需改。
3. D5、D15、§7、§9 中以 `feishu_bot` / `feishu-bot:read` 为例的文字只当示例，lark-cli provider 实际按上面三层设计；dingtalk-cli 的凭证来源待其方案核实，同样不要预设是 `dingtalk_bot`。
4. §9 补一条：**按用户的依赖（个人登录态、个人 token）不进本列**——本列只表达系统级依赖，否则管理员看到的"就绪"对具体用户是假的。

### 11.2 漏掉的 ensure 调用方：`RoleSkillGrantService`

角色技能授权已复用同一个 ensurer：`permission/role-skill-grant.service.ts:1` 导入 `AgentBrowserDepsEnsurer`、`:27` 构造参数 `browserDepsEnsurer`、`:52` 在 `replaceForRole` 后 `ensureForSkills(names)`；装配在 `create-app.ts:658`，同样走 `browserDepsForward` 晚绑定。

补充改动面（§5.1 / D7 / §4.4"调用点不变"列表一并适用）：

- `role-skill-grant.service.ts`：import 与类型改 `AgentSkillDepsEnsurer`，字段 `browserDepsEnsurer` → `skillDepsEnsurer`（与 agent.service 同步改名，避免一处叫 browser 一处叫 skill）。
- `create-app.ts`：`browserDepsForward` 更名 `skillDepsForward`、target 类型改 `SkillDepsService`，**两处**转发（AgentService 构造 :431、RoleSkillGrantService 构造 :658）一起换。漏改 :658 编译能过（结构类型），但会继续直连 `BrowserDepsService`，config/其他 install provider 永远收不到角色授权触发的 ensure。
- `role-skill-grant.service.spec.ts`：零改动（`:24-32` 注入结构性 mock `{ ensureForSkills }`），但应在 `skill-deps.service.spec.ts` 里明确断言"registry 透传完整名单"，覆盖角色授权传 `['browser-use','git']` 这类混合名单。

### 11.3 降级态会打断安装轮询（D14 缺口）

D14 把 provider `status()` 抛错/超时降级为 `phase:'failed'`。安装进行中若某次探测超时（docker 模式安装中虽跳过镜像探测，但 runtime mode 解析、setting 读库仍可能慢/失败），前端会：判定"无 installing"→ 停轮询 → 显示「依赖安装失败」+ 安装按钮，而后台安装仍在跑。用户看到的是假失败，且要手动刷新才能看到最终结果。

补充定案：

- `SkillDepsService` 按 provider 在内存保存**最近一次成功**的 `status()` 结果。本次抛错/超时时：有缓存 → 返回缓存，每个 item 的 `detail` 追加「（本次状态读取失败，显示上次结果）」；无缓存（进程刚启动）→ 才用 D14 的降级项。缓存只做容错回退，不做命中加速（每次请求仍实时探测，保持"读取时检测"语义）。
- 降级项补 `text: '状态读取失败'`，与真实「依赖安装失败」区分。
- `Promise.race` 超时不会取消底层探测；前端重入门闩（D12）已防止请求堆叠，registry 侧再加**按 provider 的进行中去重**：上一次 `status()` 未结束时，新请求直接复用同一个 promise，避免多个管理员同时开页面时并发起多个 docker 一次性容器。
- 测试补：`status()` 首次成功（installing）、第二次超时 → 返回仍为 installing 且 detail 带回退提示；无缓存超时 → 降级项 `text` 为「状态读取失败」；并发两次 `getStatusMap()` 只调用一次 provider `status()`。

### 11.4 「去配置」权限码不要由后端硬编码（D15 改进）

D15 让 provider 在 `action.permission` 里写前端路由守卫要的权限码，等于后端同时硬编码 admin 的路由路径和路由权限，多一个漂移点。admin 路由 `meta.permission` 已是唯一来源（`admin/src/router/index.ts`，如 `feishu-bots` → `feishu-bot:read`、`settings` → `settings:read`）。

改为：`SkillDepsItem.action` 去掉 `permission`，只留 `{ label, route }`；前端用 `router.resolve(route).meta.permission` 取权限码再 `authStore.hasPermission`；`resolve` 不到路由（`matched` 为空）按无权限处理并渲染灰文本（tooltip「配置页不存在」），防止后端写错路径时用户点进 404。`utils/skillDeps.ts` 的 `configAction(items, can)` 签名不变，`can` 的实现改为"route → meta.permission → hasPermission"，仍可在单测中注入。

### 11.5 安装反馈按 `started` 区分

今天 `handleInstallBrowserDeps` 不论结果都提示"安装已启动"。包装层只回 `{ started }` 后，前端应在 `started:false` 时提示「依赖已在安装中或已就绪」并立即重拉 status，避免误以为又起了一次安装。成功文案通用化为 `${item.label}安装已启动，完成后状态会自动刷新`。

### 11.6 文档与 changelog 遗漏

- `skills/mao-cli/reference/admin.md:98` 也写着 browser-use 行的「浏览器依赖」列，正文 §8 漏列，同步改「运行依赖」。
- `skills/bundled/README.md` 末行**并不含列名**（§8"同步列名"不成立）；该行实际过期的是"CLOUD 服务器需预装系统 Chrome 与全局 `@playwright/cli`"，应改为"服务器依赖按需安装，状态见管理后台 Skills 页「运行依赖」列"。
- `changelog/unreleased/` 下两条**尚未发版**的碎片仍引用旧端点：`2026-11-23-browser-deps-docker-probe.md`（`GET/POST /admin/browser-deps/*`）、`2026-11-23-settings-page-render-fixes.md`（`/admin/browser-deps` 专用端点）。它们与本次改动会进同一个版本，若不改，发版说明会描述一个已经删除的端点：同任务把端点名改成 `/admin/skill-deps/*`（未发版碎片可改，月份归档文件不动）。
- `admin/src/views/skill/SkillListView.vue` 里 `handleTabChange`、`onMounted`、`onActivated`、`onDeactivated`、`onUnmounted` 共 5 处调用 `fetchBrowserDeps` / `stopBrowserDepsPoll`，改名时一起换（keep-alive 失活停轮询的语义保留）。

### 11.7 行号漂移

角色技能授权合入后，正文和文首"关联代码"里的行号已过期，实施时按符号定位，不要信行号。当前值：`create-app.ts` forward 428、AgentService 注入 431、RoleSkillGrantService 注入 658、`builtinSkills` 638、构造 713、赋值 719、路由注入 1122；`app-routes.ts` import 172-173、类型 230、解构 380、注册 738-739；`agent.service.ts` 调用点 127 / 173；`agent.service.spec.ts` ensure 用例 357；`SkillListView.vue` 列 167-176、安装按钮 196-208、移动端 303-322、状态与轮询 417-470。
