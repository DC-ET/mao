# Skills「运行依赖」抽象化技术方案

- 状态：待评审
- 日期：2026-11-23
- 一句话：把管理后台 Skills 列表里为 browser-use 特设的「浏览器依赖」列，泛化为数据驱动的「运行依赖」列；后端从单技能服务改为 provider 注册表，新增依赖型内置技能（lark-cli、dingtalk-cli、office-use…）时前端零改动。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 后端现状：`backend-ts/src/browser-deps/browser-deps.service.ts`（`BROWSER_DEPS_SKILL_NAME` :28、setting key :29、`ensureForSkills` :301）、`backend-ts/src/browser-deps/browser-deps.routes.ts`（`/v1/admin/browser-deps/{status,install}`）、`backend-ts/src/app-routes.ts:735`（非空才注册）、`backend-ts/src/create-app.ts:419`（晚绑定 forward）/`:689`（装配）/`:1098`（注入）、`backend-ts/src/agent/agent.service.ts:25`（`AgentBrowserDepsEnsurer`）/`:121`、`:167`（保存钩子）、迁移 `backend-ts/db/migration/V200__browser_deps_status_setting.sql`
  - 前端现状：`admin/src/views/skill/SkillListView.vue`（列 :167-176、安装按钮 :186-197、移动端卡片 :292-302、状态与轮询 :379-432）
  - 文档现状：`skills/mao-cli/reference/deploy.md:83`（写明列名「浏览器依赖」）、`skills/bundled/README.md` 末行
- 关联方案：[2026-11-20 浏览器直播与 browser-live-pip](../2026-11/2026-11-20-browser-live-pip-technical-design.md)（D7 v2 修订：依赖按需化）、[2026-11-21 browser-use Windows LOCAL 支持](../2026-11/2026-11-21-browser-use-windows-local-technical-design.md)、[2026-11-20 内置技能](../2026-11/2026-11-20-builtin-skills-technical-design.md)（bundled 子目录即内置技能）。

## 1. 现状与问题

「浏览器依赖」列把 `browser-use` 焊死在四个地方：service 的 `BROWSER_DEPS_SKILL_NAME`（browser-deps.service.ts:28）、setting key `browser_deps.status`（:29）、端点 `/admin/browser-deps/*`（browser-deps.routes.ts）、前端渲染条件 `row.name === 'browser-use'`（SkillListView.vue:170、187、292、301）。

这引出一个更根本的窄化：**现状把"依赖"等同于"可安装的二进制"**。考察几个候选内置技能的真实依赖形态：

- `browser-use`：CLOUD 服务器需要 Chrome + `@playwright/cli`，可安装 → install 类。
- `lark-cli` / `dingtalk-cli`：依赖不是安装而是**凭证与开关**——平台已有 `admin/src/views/dingtalk-bot/`、`feishu-bot/` 配置页和 `feishu_bots` 表（`backend-ts/src/feishu-client.ts:30-34`：appId + 加密 appSecret + enabled）。未就绪的真实原因是"没配 bot / bot 停用"，正确动作是「去配置」跳转，不是「安装依赖」。按现状硬加会得到"依赖未安装 + 安装按钮"的荒谬组合，且与渠道页两处状态漂移。
- `office-use`：大概率零服务器依赖（LLM + 脚本直接产文件），本就不该出现这一列。

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
- 不用 SKILL.md frontmatter 声明依赖：frontmatter 是给 LLM 的提示词，不是机器契约；provider 注册在代码里，与 builtin 白名单同源。
- 不做桌面端 / LOCAL 依赖展示：LOCAL 依赖在用户机上，属桌面端 UI，另案。
- 不做依赖版本管理、自动升级、健康巡检（只装 latest + 读取时检测，现状语义）。
- 不动 browser-use 安装链本身（host/docker/win32 分支、单飞、30min 孤儿降级），不动 V200 迁移。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 抽象边界 | provider 注册表统一契约（状态词表 / 寻址 / 动作），安装实现各家自治 | 安装链形态差异是本质的：apt/winget/镜像重建 vs 读一张配置表。强行统一只会得到一个大而空的状态机加一堆特例分支 |
| D2 | 模块布局 | 新增 `backend-ts/src/skill-deps/`（types + service + routes + specs）；`browser-deps/` 保留为 browser-use 的 install provider 实现，内部逻辑零改动，删除 `browser-deps.routes.ts` | 安装链 446 行、跨三分支且有完整单测，原样保留风险最低；注册表是新概念，独立成域 |
| D3 | 端点 | `GET /v1/admin/skill-deps/status`（skill:read，返回按技能名键控的聚合状态）+ `POST /v1/admin/skill-deps/:skill/install`（skill:write）。旧端点删除不留 | 前后端同仓同时发布，无外部消费方；AGENTS.md 初版不保存量兼容。按技能寻址后无需每技能一对端点 |
| D4 | 与技能列表的关系 | 不动 `/v1/skill-docs` 与 `SkillDocService`；前端按 `row.name` 从 status map 取该技能条目合并展示 | 今天前端本就是两次 fetch（列表 + browser-deps status），合并逻辑从 `row.name === 'browser-use'` 改为 map 查找即消除硬编码，后端列表 API 不受依赖概念污染 |
| D5 | 依赖种类 | `kind: 'install' \| 'config'`。install 复用四态（not_installed/installing/ready/failed）；config 只产生 ready / not_installed，动作是 `action: { label:'去配置', route }`，无 install（被调用返回 409） | lark-cli 类技能的阻塞点是凭证不是二进制；config provider 直接读既有 bot 仓库，零新存储，还避免技能页与渠道页状态漂移 |
| D6 | 存储 | provider 自持：browser-use 继续用 `browser_deps.status`（V200 不动），registry 不引入统一 key | 各 install 状态机形态不同（browser 有 chrome/cli 双检测、docker 镜像重建），统一 key 只会逼出嵌套 JSON schema 与迁移，收益为零 |
| D7 | Agent ensure | `AgentBrowserDepsEnsurer` 更名 `AgentSkillDepsEnsurer`，**方法名 `ensureForSkills(skillNames)` 不变**；registry 把完整名单透传给每个 provider，由 provider 按自己的 `skillName` 自过滤（browser 现有的 `includes('browser-use')` 判断原样保留） | 保存路径的"哪些技能要 ensure"是产品策略，保持显式列举；provider 自过滤即今天的口径，registry 不掺合策略。方法名与签名不变 → `browser-deps.service.spec.ts:262` 的 ensure 用例与 `agent.service.spec.ts` V200 用例（结构性 mock）零改动 |
| D8 | 前端展示 | 列名「浏览器依赖」→「运行依赖」；渲染条件改为 status map 存在该技能；tag 文案用 phase 四态通用映射（依赖未安装/依赖安装中/依赖安装失败/依赖就绪），chromium 等细节进 tooltip；item 可带 `text` 覆盖文案（config 的 not_installed 显示「未配置」而非「依赖未安装」） | 今天 frontend 里最后一处 browser 特判是 `chrome.kind === 'chromium'` 的「（chromium）」后缀（SkillListView.vue:397），收进 provider 的 detail 后前端完全通用 |
| D9 | 安装入口 | install kind 且未就绪且非 installing → popconfirm「安装依赖」，确认文案优先取 item.`installConfirm`（browser-use 原样保留今天的文案），缺省 `将在服务器上自动安装${label}，可能需要数分钟，确认开始？`；config kind 未就绪 → 「去配置」文字链跳 `action.route`；一个技能多个 items 时安装按钮取第一个可安装项（当前无此场景，契约先行） | 确认文案含具体组件清单时有信息量，但不能让前端按技能名拼文案——交给 provider 给全文 |
| D10 | 并发 | provider 内单飞不变（browser 的 `inFlight`）；不同技能允许并行安装；registry 不加全局锁；install 对 installing / ready 返回 `started:false` | 安装是低频管理操作，跨技能并行的资源争用以各 provider 单飞 + apt/npm 幂等兜底，与现状一致 |
| D11 | 名称校验与未知技能 | skill 名校验 `^[a-z0-9][a-z0-9_-]{0,63}$`（与现有内置命名一致：browser-use、mao-cli、a1-plugin-builder、access-cli）；status 对未知技能静默忽略（列表页只渲染已注册的）；install 未知技能 404 | provider 按名精确匹配、name 不进入任何 exec 参数；404 避免把注册表当成探测面 |
| D12 | 轮询 | 2.5s 轮询保留，数据源换 `/admin/skill-deps/status`；任一 item 处于 installing 续轮，终态停轮并刷新技能列表（现状 SkillListView.vue:416-422 逻辑原样） | 管理后台无 WS 通道，轮询是既有口径 |

## 4. 行为契约

### 4.1 类型

```ts
type SkillDepsKind = 'install' | 'config';
type SkillDepsPhase = 'not_installed' | 'installing' | 'ready' | 'failed';

interface SkillDepsItem {
  id: string;            // provider 内稳定 id，如 'browser'
  label: string;         // 依赖组名，如 '浏览器依赖' / '钉钉机器人'
  kind: SkillDepsKind;
  phase: SkillDepsPhase;
  detail: string | null; // tooltip 里的实况细节（版本号、缺什么、为什么）
  text?: string;         // 覆盖 phase 默认文案（config 的 not_installed → '未配置'）
  action?: { label: string; route: string };              // config：去配置跳转
  installConfirm?: string;                                  // install：确认弹窗全文
}

interface SkillDepsProvider {
  readonly skillName: string;                 // 对应内置技能 frontmatter name
  status(): Promise<SkillDepsItem[]>;         // 只读、可重复调用
  install?(): Promise<{ started: boolean }>;  // install kind 必有
  ensureForSkills?(skillNames: readonly string[] | null | undefined): void; // Agent 勾选保存触发，自吞异常
}
```

### 4.2 status 聚合

`GET /v1/admin/skill-deps/status` 遍历 registry，返回 `{ skills: Record<skillName, { items: SkillDepsItem[] }> }`。未注册技能不出现在 map 里（前端对应行该列空白，与今天 mao-cli 等行一致）。

browser-use provider 的映射：`phase ← getStatus().phase`；`detail ← stored detail ?? 实况拼装（chrome 版本 / cli 版本，chromium 降级时标注）`；`label = '浏览器依赖'`；`installConfirm` 保留今天弹窗原文（"将在服务器上自动安装浏览器依赖（Chrome/chromium + playwright-cli，可能需要数分钟），确认开始？"）。

### 4.3 install 派发

`POST /v1/admin/skill-deps/:skill/install` → 查 provider：无 → 404；`install` 缺省或 kind 为 config → 409（文案说明该依赖无需安装、应去配置）；否则调 `provider.install()`，`started:false` 时前端保持当前展示（installing 中或已就绪）。

### 4.4 ensure

`registry.ensureForSkills(names)`：names 为 null/空直接返回；否则把**完整名单**透传给每个 provider 的 `ensureForSkills`（存在该方法的），由 provider 按自身 `skillName` 过滤——browser provider 现有的 `if (!skillNames?.includes('browser-use')) return` 原样保留。全程 fire-and-forget，异常自吞（harnessLog warn）。调用点不变：agent.service.ts 创建（:121）与更新（:167）路径、create-app.ts forward 晚绑定。

### 4.5 前端合并与轮询

系统 Skills 表每行：`deps = status.skills[row.name]`；存在则渲染该行单元格（每个 item 一个 tag，tooltip 为 `label + detail`），否则留空。安装中（任一 item `phase === 'installing'`）以 2.5s 续轮 status，终态停轮并重新拉 `/skill-docs`。个人 Skills 表不涉及（依赖是系统级概念）。

## 5. 改动面

### 5.1 后端

新增 `backend-ts/src/skill-deps/`：

- `skill-deps.types.ts`：§4.1 类型。
- `skill-deps.service.ts`：`SkillDepsService`，构造接收 `providers: SkillDepsProvider[]`，提供 `getStatusMap()`、`install(skillName)`、`ensureForSkills(names)`。无 IO、无设置依赖，纯分发。
- `skill-deps.routes.ts`：两个端点，权限码与审计口径同今天（`/v1/admin` 前缀自动进审计拦截器）。
- `skill-deps/providers/browser-deps.provider.ts`：把现有 `BrowserDepsService` 包成 provider（status 映射见 §4.2；`install` 与 `ensureForSkills` 原样直通，无逻辑）。

修改：

- `browser-deps/browser-deps.service.ts`：**零改动**（D7 方法名不变，provider 包装层直通其 `ensureForSkills` / `install` / `getStatus`）。
- 删除 `browser-deps/browser-deps.routes.ts`。
- `app-routes.ts`：`browserDeps?: BrowserDepsService` → `skillDeps?: SkillDepsService`，:735 的注册换成 `registerSkillDepsRoutes`。
- `create-app.ts`：:689 构造处改为"构造 BrowserDepsService → 包 provider → 构造 SkillDepsService([browserProvider])"，:695 forward target 与 :1098 注入换类型；forward 的目标类型注释更新。
- `agent/agent.service.ts`：接口名 `AgentBrowserDepsEnsurer` → `AgentSkillDepsEnsurer`（注释同步），调用点不动。

### 5.2 前端（`admin/src/views/skill/SkillListView.vue`）

- 列定义：`label="浏览器依赖"` → `label="运行依赖"`；`:170` 条件 `row.name === 'browser-use' && browserDepsTag` → `depsFor(row.name)`；单元格遍历 items 渲染 tag（`item.text ?? phaseText(item.phase)`）。
- 安装按钮：`v-if` 改为"存在 install kind 且 `phase !== 'ready' && !== 'installing'` 的 item"；确认标题取 `item.installConfirm`；`handleInstallBrowserDeps` → `handleInstallDeps(row.name)`。
- config kind 未就绪：渲染 `<el-button link>` 「去配置」，`router.push(item.action.route)`；不出现安装按钮。
- 移动端卡片（:292-302）同口径，label「运行依赖」。
- 状态管理（:379-432）：`browserDeps` ref → `skillDepsStatus` ref（`Record<string, { items }>`）；fetch/poll 逻辑换端点，其余不变。
- 删除 `browserDepsTag` computed 及 `chrome.kind === 'chromium'` 分支。

## 6. 界面

- 系统 Skills 表格新增/改造一列「运行依赖」（宽度 130 → 140，容纳多 tag 时换行由 tooltip 兜底）。browser-use 行展示与今天逐像素一致：未安装「依赖未安装」、安装中「依赖安装中」、失败「依赖安装失败」、就绪「依赖就绪」，hover 出 detail。
- 「安装依赖」按钮位置与 popconfirm 交互不变（仅数据来源变化）；「去配置」为普通文字链，无确认框。
- 其余技能行该列空白（与今天一致）；个人 Skills 表无此列。

## 7. 安全

- 权限码不变：status `skill:read`、install `skill:write`；`/v1/admin` 前缀继续自动进审计拦截器。
- skill 名按 §3 D11 白名单式校验；name 只用于 provider map 精确查找，不进入任何 exec 参数——安装链的命令构造全部在既有 provider 内，本次不改。
- config kind 无安装入口即无命令执行面；`action.route` 仅作前端跳转，不参与后端任何 IO。
- 安装确认弹窗保留破坏性操作确认模式；安装过程日志口径不变。

## 8. 测试与文档

后端（`cd backend-ts && npm test`）：

- 新增 `skill-deps.service.spec.ts`：status map 只含已注册技能；未知技能 install 抛 404；config kind install 拒绝；`ensureForSkills` 把完整名单透传给各 provider、null/空名单 no-op；多 provider 并行 install 互不阻塞。
- 新增 `skill-deps.routes.spec.ts`：status 需 `skill:read`、install 需 `skill:write`；聚合结构符合 §4.2；未知技能 404；config 技能 install 409。
- `browser-deps.service.spec.ts`：**零改动**（D7 后该方法签名与文件均不变，:262 的 ensureForSkills 用例原样通过）。
- `agent.service.spec.ts`：**零改动**（V200 用例注入的是结构性 mock、方法名未变；已核实）。

前端（`cd admin && npm test && npm run build`）：

- 新增 `SkillListView.spec.ts`：未注册技能行不渲染该列单元格；browser-use 行按 status map 渲染四态 tag 与 tooltip；installing 时启动轮询、终态停轮并刷新列表；config kind 渲染「去配置」且无安装按钮；安装确认发出正确 skill 名。
- 构建验证必须 `npm run build`（vue-tsc -b + vite build），不以 `npx vue-tsc --noEmit` 替代。

文档（同任务）：

- `changelog/unreleased/2026-11-23-skill-runtime-deps.md`：`### 管理后台`（Skills 列表「浏览器依赖」列改「运行依赖」，按技能展示，配置类依赖提供「去配置」入口）+ `### 后端`（依赖端点泛化为 `/admin/skill-deps/*`，内部重构无行为变化）两节。
- `skills/mao-cli/reference/deploy.md:83`：列名改「运行依赖」，补一句"按技能展示，未注册依赖的技能该列为空"。
- `skills/bundled/README.md` 末行同步列名。
- 不加 Playwright（已核实现有用例不断言该列）。

## 9. 新增一个带依赖的内置技能（操作手册）

以后 lark-cli / dingtalk-cli / office-use 落地时：

1. `skills/bundled/<name>/SKILL.md`（既有内置技能流程，见 2026-11-20 方案）。
2. 评估依赖形态：无服务器依赖（如纯脚本产文件的 office-use）→ 到此为止，Skills 页该列为空，正确行为。
3. 有依赖 → `backend-ts/src/skill-deps/providers/<name>.ts` 实现 `SkillDepsProvider`：
   - install 类：自持存储（参照 `browser_deps.status` 加一条 `system_setting` 种子迁移）、四态状态机、install 链、`ensure`；
   - config 类：读既有平台配置（如 bot 仓库）推导 ready / not_installed，`action.route` 指向既有配置页，不新增存储。
4. `create-app.ts` 注册进 `SkillDepsService` 的 providers（需要晚装配的走既有 forward 模式）。
5. 补 provider 单测 + 在 `skill-deps.routes.spec.ts` 加一条"该技能出现在 status map"。
6. **admin 前端零改动**——列按 status map 渲染；如安装类需要"Agent 勾选即装"，在 `provider.ensure()` 内实现，保存钩子已通用。
