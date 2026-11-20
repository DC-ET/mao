# 仓库内置技能随部署进入系统 Skills

- 状态：待评审（本文只做方案，不含实现）
- 日期：2026-11-20
- 一句话：仓库里点名的技能和 `skills/bundled/` 下的技能，随 git 发版出现在管理后台「系统 Skills」里；后台上传的技能仍留在数据目录，两套目录不互相覆盖。
- 关联代码（撰写时已核实的现状，全部为当前 `main`）：
  - 系统技能只扫一个目录：`backend-ts/src/harness/skill/skill-loader.ts:68-100`（`refreshCache`），目录来自 `SKILLS_DIR`（`backend-ts/config/application.yml:73`，默认 `./skills`）
  - 装配点：`backend-ts/src/create-app.ts:619-634`（`SkillLoader` → `SkillSyncService` / `UserSkillService` / `SkillDocService` / `SkillBundleService`）
  - 列表与删除：`backend-ts/src/skill/skill-doc.service.ts:11-18`、`:92-107`；删除成功后还会从全部 Agent 摘掉这个名字（`backend-ts/src/skill/skill.routes.ts:190-206`）
  - 个人技能按 frontmatter 名拒绝覆盖系统技能：`backend-ts/src/skill/user-skill.service.ts:208-226`（`SystemSkillNames.getAllNames()`）
  - 会话挂载：`backend-ts/src/harness/skill/skill-sync-service.ts:41-79`（`getSkillFolder` → `ensureView` → 软链指向视图）
  - 视图指纹：`backend-ts/src/harness/skill/skill-view.service.ts:94-102`、`:243-251`（`maxMtimeMs-fileCount-totalBytes`）
  - 提示词里的技能路径是会话运行时路径，不是源目录：`backend-ts/src/harness/core/prompt-engine.ts:715-747`
  - 管理后台可删系统技能：`admin/src/views/skill/SkillListView.vue:168-180`（手机卡片同样有删除，约 `:263-271`）
  - 桌面端系统技能只读：`desktop/src/components/skill/SkillManager.vue:32-35`
  - Agent 勾选来自同一列表，默认不勾：`admin/src/views/agent/AgentFormDialog.vue:391`、`:722`
- 既有设计：[技能视图](./2026-11-03-skill-view-container-isolation-technical-design.md)（源目录只在宿主物化，容器只挂只读视图）。本方案不改视图、不改挂载。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 内置技能 | 随仓库发布、只读的系统技能。来源是白名单目录，或 `skills/bundled/` 下的子目录 |
| 上传的系统技能 | 管理后台 / `skill-docs upload` / bundle 导入写进 `SKILLS_DIR` 的技能。可覆盖、可删除 |
| 技能身份 | `SKILL.md` frontmatter 的 `name`。列表、Agent 的 `skillNames`、会话目录名、同名判重都用它 |
| 白名单 | `skills/builtin.json` 里的目录名。只用来点名「已经住在 `skills/<name>/` 的技能」，例如 `mao-cli` |
| 可变技能根 | `SKILLS_DIR`，生产是 `/opt/mao-data/skills`。上传、删除、bundle 导入只写这里 |

## 1. 现状与问题

管理后台「系统 Skills」等于 `SKILLS_DIR` 里带 `SKILL.md` 的子目录。`SkillLoader` 启动时只 `mkdir` 这个目录并扫描，没有把仓库里的技能拷进去。

按 `skills/mao-cli/reference/deploy.md` 做全新部署时，`/opt/mao-data/skills` 是空目录。仓库里的 `skills/mao-cli` 在 git 检出（`/opt/mao/skills/mao-cli`），和运行时技能源不是一条路径。文档站、CLI、`AGENTS.md` 都引用这个位置，它不能为了「进系统技能」再搬一次家。`skills/playwright` 也在检出里，但是一份待封装的素材，不进入系统 Skills。

现有生产机用仓库外的 `deploy-mao.sh` 把 `skills/mao-cli` rsync 到 `/opt/mao-data/skills/mao-cli`。这是第二份副本：漏跑就没有技能；`--delete` 会扫掉后台后传的技能；rsync 不保留 mtime 时，技能视图会把所有用户的副本全量重拷（技能视图方案 §4.2、§8 已写明）。

要加一个跟着本系统走的技能（例如定制的浏览器技能包）时，没有一个「放进仓库、发版就出现在系统 Skills」的位置。另建技能仓库或 hub 再让人下载上传，和「技能是产品的一部分」相反。

## 2. 目标与非目标

### 2.1 目标

1. 克隆仓库并按现有文档启动后，白名单和 `skills/bundled/` 里的技能出现在「系统 Skills」，无需再拷贝或上传。
2. 之后发版就是 `git pull` 加后端重启。文件内容变了，下一次该用户该 Agent 开会话时，技能视图按现有指纹重建。提示词里的会话路径不变。
3. `skills/mao-cli` 仍是文档、CLI、技能正文的唯一目录。白名单只点名它，不复制到 `skills/bundled/`。
4. 后台继续可以上传、覆盖、删除**上传的**系统技能。这些写操作只落在 `SKILLS_DIR`。
5. 内置技能不能通过后台、`skill-docs` API 或 bundle 导入被删除或覆盖。删库、改文件的途径是改仓库再发版。
6. 个人技能仍然不能使用内置技能的 frontmatter 名（现有 409）。

### 2.2 非目标

- 不把整个 `skills/` 都当成系统技能。白名单没点名、也不在 `skills/bundled/` 下的目录保持原样（文档、脚本可以继续放在 `skills/` 旁边）。
- 不点名 `skills/playwright`，本方案也不创建 `browser-use`。`playwright` 留在原地当素材。封装完成后放到 `skills/bundled/browser-use/`，frontmatter `name` 为 `browser-use`，那时不用改白名单就会进入系统 Skills。
- 不自动勾选到已有或新建 Agent。`skillNames` 为空时今天就不加载系统技能（`harness-service.spec.ts` 的 `buildContextDoesNotLoadSystemSkillsWhenAgentSkillNamesNull`）。内置技能只是出现在可选列表里。
- 不改技能视图、容器挂载、会话软链的路径规则。
- 不把 `/opt/mao-data/skills` 里同名的旧副本自动删掉。
- 不做「在后台停用某个内置技能」的开关。不需要它时，从白名单或 `skills/bundled/` 去掉再发版。
- 不改 `deploy-mao.sh`（不在本仓库）。文档说明：白名单里的技能不必再 rsync。

## 3. 技术选型

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 内置技能放哪 | **留在 git 检出里，加载时和 `SKILLS_DIR` 合并** | 发版即更新。拷进数据目录会再出现第二份副本，也会和后台上传共用一个可写根 |
| D2 | `mao-cli` 怎么进列表 | **`skills/builtin.json` 只点名 `skills/mao-cli`** | 这个目录同时被文档站和 CLI 引用。再复制到 `skills/bundled/mao-cli` 会两处漂移。`playwright` 不点名 |
| D3 | 新的定制技能放哪 | **`skills/bundled/<目录名>/`，有 `SKILL.md` 即内置** | 这些技能没有第二用途，不需要逐个登记。白名单只服务「已经住在别处」的目录。封装后的浏览器技能走这条：`skills/bundled/browser-use/` |
| D4 | 同名谁赢 | **内置赢。可变根里的同名 frontmatter 不进入目录，并打一条警告** | 否则后台或旧 rsync 副本会挡住发版更新。个人技能覆盖系统技能的现有禁令继续生效 |
| D5 | 写保护 | **上传 / 删除 / bundle 导入只碰可变根；内置名 409；删除前再确认目标在可变根内** | `deleteSkill` 今天按 `getSkillFolder` 做 `rmSync`。内置技能的 folder 在仓库里，漏判会删掉 git 检出 |
| D6 | 何时读到新内容 | **新进程扫描仓库；视图仍按源指纹在下次 `syncToSession` 重建** | 蓝绿重启已经换进程。不重启时，目录缓存最长 `skillsCacheSeconds`（默认 300）后重新读盘 |
| D7 | 找不到仓库技能根 | **启动失败** | 静默当成「没有内置技能」会让新部署的系统 Skills 又空掉，和本方案要修的问题一样 |
| D8 | 名单或内置目录不合法 | **启动失败** | 白名单写错、点名的目录没有 `SKILL.md`、两个内置技能 frontmatter 同名，都是发版错误，不能带着残缺目录对外服务 |
| D9 | 可变根里的同名残留 | **忽略，不删除，启动不失败** | 那是运维数据。删掉会丢可能还没合回仓库的本地修改 |

## 4. 目录与名单

```
/opt/mao/skills/                         # git 检出，本方案的内置根
├── builtin.json                         # 白名单。本方案只点名 mao-cli
├── mao-cli/                             # 仍在这里。文档站、CLI、技能正文同一份
├── playwright/                          # 不点名，不进系统 Skills。留作 browser-use 的素材
└── bundled/                             # 定制技能。每个直接子目录一份技能
    ├── README.md                        # 说明放法，自身不是技能
    └── browser-use/                     # 后续封装再添加，本方案不创建
        └── SKILL.md                     # frontmatter name: browser-use

/opt/mao-data/skills/                    # SKILLS_DIR，只放后台上传的系统技能
└── team-skill/
```

`skills/builtin.json`：

```json
{
  "skills": ["mao-cli"]
}
```

规则：

- `skills` 是字符串数组。每一项是单个路径段：匹配 `isValidSkillName`（字母或数字开头，只含字母、数字、`-`、`_`，最长 64）。拒绝空串、`..`、绝对路径、带 `/` 的值。
- 解析为 `<内置根>/<name>/`，且该目录必须有 `SKILL.md`，frontmatter 能解析出合法 `name`。
- `bundled` 这个名字不能写进白名单。`skills/bundled/` 是自动扫描的容器，不是一份技能。
- `skills/bundled/` 只把**直接子目录**且含 `SKILL.md` 的当作技能。`README.md`、没有 `SKILL.md` 的目录跳过并打警告，不因此启动失败。
- 内置技能之间 frontmatter 名必须唯一。目录名和 frontmatter 名可以不同（与今天的 `SkillLoader` 一致），对外身份仍是 frontmatter 名。
- 初始名单只有 `mao-cli`。`skills/playwright` 虽然已有 `SKILL.md`，故意不写入名单。以后新增「已经住在 `skills/<name>/`」的技能才改这个文件；放进 `skills/bundled/` 的不用改。`browser-use` 封装完成后放 `skills/bundled/browser-use/`，目录名与 frontmatter 名都是 `browser-use`。

内置根的定位：从本文件的 `import.meta.url` 向上找，第一份同时存在 `skills/builtin.json` 的目录就是仓库根。源码在 `backend-ts/src/...`、编译产物在 `backend-ts/dist/...` 时都能找到 `/opt/mao` 或本地克隆根。最多向上 8 层。测试传入明确的根目录，不依赖这段查找。不设环境变量开关：漏配环境变量会悄悄退回「没有内置技能」。

## 5. 加载与合并

新增 `BuiltinSkillCatalog`（建议 `backend-ts/src/harness/skill/builtin-skill-catalog.ts`）：

- `load(root)`：读名单、扫 `bundled/`、校验 §4，失败抛错，错误信息带路径。
- 成功则给出内置技能列表：frontmatter 名、源目录绝对路径、`builtin: true`。
- `create-app` 在 `listen` 之前调用。抛错则进程起不来，日志里能看到哪一项不合法。

`SkillLoader` 增加可选的内置目录参数。不传时行为与今天相同（现有单测不用改构造）。`create-app` 传入 catalog。

`refreshCache` 的合并顺序：

1. 放入全部内置技能（身份 = frontmatter 名，`folderPath` = 仓库里的源目录）。
2. 再扫可变根。frontmatter 名已经在内置集合里的，丢弃这一条，打一条 warn（含两边路径）。同一轮刷新里同一名字只打一次。
3. 可变根内部沿用今天的规则：后扫到的同名覆盖先扫到的，并沿用现有警告。

`getAllNames()` / `hasSkill()` / `getSkillFolder()` / `getAllDocuments()` 都看合并后的结果。因此：

- 个人技能上传的 409 自动覆盖内置名，不用再维护一份名字表。
- `SkillSyncService` 继续 `getSkillFolder(name)`。内置技能拿到的是仓库路径，交给现有 `ensureView`。视图拷贝、软链、失败降级都不改。
- 提示词继续写会话运行时路径（`formatCloudSkillsPath` / `formatLocalSkillsPath`）。不要把仓库路径写进提示词：容器里没有 `/opt/mao/skills`，Agent 也没被授权去翻技能源。
- 每个内置源目录仍 `pathSandbox.addAllowedRoot`，与今天扫到的技能目录相同。会话实际读的是视图路径。

目录缓存仍是 `skillsCacheSeconds`（默认 300）。上传、删除成功后的 `invalidateCache()` 保持。发版走蓝绿，新进程的第一次扫描读到新文件。

## 6. 写路径

可变根仍是 `SkillLoader.getSkillsDir()`，也就是今天的 `SKILLS_DIR`。内置源目录不提供写方法。

| 操作 | 行为 |
|---|---|
| `POST /skill-docs/upload` | 任一文件组的 `SKILL.md` frontmatter 名属于内置技能：整请求 409，一个文件都不写。文案与个人技能一致：「与系统技能同名，禁止上传」。其余组仍写入可变根 |
| `DELETE /skill-docs/:name` | 该名是内置技能：409，`内置技能随版本发布，不能在后台删除`。不调用 `removeSkillNameFromAll`。不是内置时，删除目标还必须落在可变根内，否则 500 且不删除 |
| bundle 导入 | 已存在且是内置：保持 `exists-skip`，说明改为「内置技能随版本发布，不能用导入覆盖」。已存在且是上传的系统技能：维持今天的 exists-skip |
| 个人技能上传 / `installUserSkillFiles` | 继续用 `getAllNames()`。内置名 409，逻辑不改 |

409 在任何 `writeFile` / `rmSync` 之前返回。删除的「必须在可变根内」是第二道：即使名册判断漏了，也不能 `rm` 仓库。

管理后台「系统 Skills」：

- 列表项增加 `builtin: boolean`。旧客户端忽略未知字段。
- `builtin === true` 时名称旁显示「内置」标签，删除按钮不渲染。电脑表格和手机卡片都一样。
- 查看正文不变。路径列显示仓库里的真实目录，便于和数据目录里的上传技能区分。

桌面「系统技能」今天已经不能删除。卡片上对 `builtin === true` 再标「内置」，上传产生的系统技能仍标「系统」。提示文案改为：内置技能随版本更新；系统技能仅可查看，增删在管理后台。

Agent 表单的 Skills 多选继续拉 `GET /skill-docs`。内置技能会出现在选项里。新建表单的 `skillNames` 仍是 `[]`，编辑时仍只回显已保存的名字。管理员要这个技能生效，就在 Agent 上勾选一次。

## 7. 发版后技能如何换新

```
git pull（/opt/mao，含 skills/）
  → restart.sh 新进程
       → BuiltinSkillCatalog.load 失败则新进程起不来，旧进程继续接流量
       → 成功则「系统 Skills」列出新内容
  → 用户下次执行会话
       → syncToSession → ensureView(仓库源目录)
            → 指纹变化则原子替换视图（路径不变）
            → 会话软链仍指向视图
```

指纹是 `mtime + 文件数 + 总字节`。`git checkout` 会更新改动文件的 mtime，换内容、增删文件都能对上。同大小且 mtime 碰巧不变的替换，技能视图方案已接受，不在这里改指纹算法。

`copySkillTree` 排除 `.git`，不排除 `node_modules`。内置技能位于 git 检出内，不要在 `skills/mao-cli` 或 `skills/bundled/...` 里执行 `npm install`，否则每个用户的技能视图都会拷进依赖。`mao-cli` 的安装仍按它自己的 `SKILL.md`：在会话副本里安装。

存量 `/opt/mao-data/skills/mao-cli` 在第一次启动后不再作为该技能的源。目录留在磁盘上，刷新日志里有一条「已被内置技能覆盖」的警告。上线前若这份额外副本有未提交的修改，先 diff 回仓库再发版。确认运行的是仓库版本之后，可以手动删掉数据目录里的这份副本。不写进启动逻辑。数据目录里若已有 `playwright`，本方案不认它为内置，也不接管、不删除；它是否仍由 `SKILLS_DIR` 扫出来，跟今天一样。

若现场 `deploy-mao.sh` 仍会 rsync 这些目录，rsync 的结果会被忽略，只增加一次无用的拷贝。白名单中的技能以 git 检出为准，脚本里对应的 rsync 可以去掉。脚本不在本仓库，实施时只改 `skills/mao-cli/reference/deploy.md` 的说明。

## 8. 改动清单

| 路径 | 改动 |
|---|---|
| `skills/builtin.json` | 新增，只含 `mao-cli` |
| `skills/bundled/README.md` | 新增，说明子目录即内置技能、不要复制 `mao-cli`、`playwright` 不在此列；`browser-use` 以后再放入 |
| `backend-ts/src/harness/skill/builtin-skill-catalog.ts` | 定位仓库根、读名单、扫 `bundled/`、校验 |
| `backend-ts/src/harness/skill/skill-loader.ts` | 合并内置与可变根；同名丢弃可变根；`isBuiltin(name)` |
| `backend-ts/src/create-app.ts` | 启动时 `load`，失败则进程退出；把 catalog 交给 `SkillLoader` |
| `backend-ts/src/skill/skill-doc.service.ts` | 上传 409、删除 409、删除目标必须在可变根内；列表带 `builtin` |
| `backend-ts/src/skill/user-skill.service.ts` | `SkillDocVO` 增加 `builtin?: boolean`。个人技能逻辑不改 |
| `backend-ts/src/skill/skill-bundle.service.ts` | 内置名的 exists-skip 说明改为不能覆盖 |
| `admin/src/views/skill/SkillListView.vue` | 「内置」标签；内置行不显示删除（表格与手机卡片） |
| `desktop/src/components/skill/SkillManager.vue` | 内置标签与提示文案 |
| `skills/mao-cli/reference/skill-docs.md` | 列表字段加 `builtin`；写明内置技能不能上传覆盖、不能删除 |
| `skills/mao-cli/reference/admin.md` | 「系统 Skills」补内置与上传两类 |
| `skills/mao-cli/reference/deploy.md` | 首次部署说明内置技能来自仓库；白名单技能不必 rsync 到 `SKILLS_DIR` |
| `changelog/unreleased/` | 实施时补一条后端、一条管理后台、一条前端 |

不改 Flyway。不改 `SKILLS_DIR` 的含义。不改 Agent 保存接口。

## 9. 测试

后端（`cd backend-ts && npm test`），用临时目录，不读真实仓库：

1. 名单合法、`bundled/` 有一份技能、可变根另有一份：`getAllNames()` 含三者，`isBuiltin` 只对前两份为真。
2. 可变根里放一个与内置 frontmatter 同名的目录：目录里只有内置那份，`getSkillFolder` 指向仓库侧临时目录。
3. 名单含 `../`、绝对路径、缺 `SKILL.md`、两个内置 frontmatter 同名、JSON 损坏：`load` 抛错。
4. `bundled/` 里一个没有 `SKILL.md` 的目录：跳过，其余技能仍在，`load` 成功。
5. 上传 frontmatter 为内置名：409，可变根无新文件。
6. 删除内置名：409，源目录还在，且没有调用摘除 Agent `skillNames` 的副作用（路由级用例）。
7. 删除上传的技能：只删除可变根内的目录。构造一个 folder 落在可变根之外的内置项，断言不删除。
8. 个人技能上传内置名：仍 409。
9. bundle 导入内置名：`exists-skip`，可变根没有这份目录。
10. 不传内置根的 `SkillLoader`：只扫可变根，与现有用例一致。

管理后台与桌面：`SkillListView` / `SkillManager` 若已有组件测试，补「`builtin: true` 不渲染删除」。没有现成测试则在实现时用现有页面测试风格补一条，不新开 Playwright（CI 不跑 Playwright）。

## 10. 风险

| 风险 | 处理 |
|---|---|
| 数据目录里的 `mao-cli` 有未提交修改，发版后运行的变成仓库版本 | §7：上线前 diff；启动不删数据目录 |
| 在 git 检出里 `npm install`，视图被 `node_modules` 撑大 | §7 写进 `skills/bundled/README.md` 和 `mao-cli` 的部署说明。不改 `copySkillTree` 的排除规则，避免别的技能真把依赖放在目录内时被漏拷 |
| 蓝绿窗口内旧进程仍按旧源物化视图 | 与今天发版相同：旧进程服务旧代码，切流后新进程按新源重建。指纹不一致就换视图 |
| 管理员以为内置技能会自动挂上所有 Agent | 列表里看得到，Agent 未勾选则会话里没有。`admin.md` 写明要勾选 |
| 白名单漏写 `mao-cli` | 启动不失败（文件合法），但新环境没有这份技能。初始文件只写 `mao-cli`。`skills/playwright` 有 `SKILL.md` 也保持在名单之外 |
