# Git 管理器「历史」图谱技术方案

- 状态：已实现（实现偏差见 §9）
- 日期：2026-11-24
- 一句话：中央 Git 管理器「历史」页在每行左侧画出提交图谱（分支线、合并线），默认只看当前分支，可切「全部分支」；合并提交的标题简化为「A → B」并弱化显示。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 视图：`desktop/src/components/git/GitHistoryView.vue`；状态与分页：`desktop/src/composables/useGitManager.ts` 的 `loadLog` / `setLogFilters`；多仓库包装：`desktop/src/components/git/GitManagerPanel.vue` 的 `statusProviderRef`
  - 数据：CLOUD `backend-ts/src/file/workspace-git.service.ts` 的 `getLog` + `parseLogLine`（`LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%D'`），路由 `backend-ts/src/file/file.routes.ts` 的 `GET /v1/files/workspace-git-log`；LOCAL `desktop/electron/gitStatus.cjs` 的 `getGitLog`（同一格式串），IPC `git-log`
  - 类型：`desktop/src/types/git.ts` 的 `GitLogEntry`、`desktop/src/types/electron.d.ts`；Provider：`desktop/src/composables/workspace-git-provider.ts`
- 关联方案：[2026-10-28 Git 管理器](../2026-10/2026-10-28-git-manager-tab-technical-design.md)、[2026-11-03 文件查看与 Git 体验打磨](./2026-11-03-file-viewer-and-git-ux-polish-technical-design.md)（路径 / 关键词筛选的来源）。

## 1. 现状与问题

「历史」页是一张扁平列表：每行依次是展开箭头、短哈希、标题、ref 标签、作者、相对时间，点开看文件清单。看不出提交之间谁是谁的父提交，也就看不出分支在哪分叉、在哪合并。

数据层有三处缺口：

1. **没有父提交**。格式串里没有 `%P`，前端拿不到连接关系，这是画图谱的唯一硬缺口。
2. **顺序不保证拓扑**。用的是 git 默认顺序（按提交时间倒序）。提交时间有偏差时，父提交可能排在子提交前面，连线会倒着走。
3. **只有 HEAD**。没有办法看其他分支的历史。

另有一个现成的展示 bug：ref 标签多的行（如截图第一行 `master`、tag、`origin/master`、`origin/HEAD`）会把相对时间挤成竖排的「18 / 小时 / 前」。原因是 `.git-log-meta` 限 `max-width: 50%`，而 `.git-log-date` 没有 `white-space: nowrap`。

典型仓库（截图里的 release 流程）大半提交是 `Merge branch 'feature/…' into 'release_prod_…'` 和 `Merge branch 'release_prod_…' into 'master'`，标题长、信息量低，抢走了真正的业务提交的注意力。

## 2. 目标与非目标

### 2.1 目标

1. 历史列表每行左侧画出图谱：提交圆点、分支竖线、分叉与合并弯线，按列着色，亮暗主题都可读。
2. 默认只看当前分支（HEAD 可达的提交），筛选栏提供「全部分支」开关。
3. 合并提交的标题识别常见格式后显示为「A → B」，弱化颜色；原文保留在悬浮提示里。
4. CLOUD 与 LOCAL 两端数据口径一致；界面只通过 `WorkspaceGitProvider` 取数。
5. 现有能力不退化：展开文件清单、复制哈希、添加到对话、路径 / 关键词筛选、加载更多。

### 2.2 非目标

- 不折叠 ref 标签（不做「+N」），不加作者头像，不高亮 HEAD 行。只修第 1 节的时间列换行 bug。
- 不做图谱上的交互操作（右键 checkout / cherry-pick / reset / 新建分支），图谱只读。
- 不改成按游标翻页，继续用 `--skip`（第 7 节说明代价）。
- 不加到右侧边栏 Git 页，只做中央 Tab。
- 不给 Agent 加工具，不加 mao-cli 命令（「历史」今天也没有对应 CLI）。
- 零数据库迁移、零新依赖、不加权限码、不改 admin、不改安卓壳。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 父提交字段 | 格式串**末尾**追加 `%x00%P`，DTO / `GitLogEntry` 增加 `parents: string[]`（空格切分，根提交为空数组） | 追加在末尾，`parseLogLine` 前 6 个字段的下标不变；`%D` 不会含 NUL，切分安全 |
| D2 | 排序 | `git log` 一律加 `--date-order` | 保证子提交出现在所有父提交之前，分道算法才能单遍完成；与默认顺序的差别只在时间偏差时出现，列表观感基本不变。不用 `--topo-order`：它会把一条分支整段排在一起，长分支会把主线最近的提交压到很后面 |
| D3 | 全部分支 | 新参数 `allBranches`（布尔）。为真时加 `--branches --remotes --tags HEAD`，**不用 `--all`** | `--all` 会把 `refs/stash` 拉进来，stash 提交带一个索引父提交，在图上是一团噪声；也会带上 `refs/notes`。加上 `HEAD` 保证游离 HEAD 时当前提交仍在 |
| D4 | 筛选时的图谱 | 路径或关键词任一非空时**不画图谱**，退回现在的扁平列表；筛选栏下方一行灰字「筛选中不显示图谱」 | 按路径或关键词过滤后，相邻两行之间不一定是父子关系，画出来的线是假的。`--parents` 的父提交改写只对路径限定有效，对 `--grep` 无效，统一不画更简单 |
| D5 | 分道算法放哪 | 前端纯函数 `desktop/src/utils/git-graph.ts`，对**已加载的全部条目**整体重算，结果用 `computed` 缓存 | 已加载条数是 50 × 页数，几千行内单遍 O(行数 × 列数) 计算是亚毫秒到数毫秒级。整体重算不需要跨页携带状态，翻页、刷新、筛选切换都不会出现状态不同步 |
| D6 | 列是否压缩 | 列一旦分配，直到释放前**不左移**；释放后留空，新分支优先复用最左的空列 | 列平移会在中间行产生大量斜线，读起来比多占一列更累。复用空列能把宽度控制住 |
| D7 | 最大列数 | 可见列上限 `MAX_LANES = 10`（单列 14px，图谱区最宽 140px）。列号 ≥ 10 的线与圆点画在第 10 列位置，圆点改为空心并在 `title` 写「另有 N 条分支线未展开」 | 「全部分支」在远端分支多的仓库可能拉出十几列，不设上限会把标题挤没。只看 HEAD 的典型 release 流程是 2–3 列 |
| D8 | 渲染方式 | 每行一个独立的内联 SVG（高度等于行高），不做整列大 SVG 叠加 | 行可以展开文件清单、高度不固定，整列叠加要实时测量每行位置；逐行 SVG 天然跟着行走。展开区左侧另画一段「穿行竖线」，保证图谱不断开 |
| D9 | 合并标题 | 只在 `parents.length > 1` **且**命中下列格式时简化，否则原样显示 | 普通提交的标题哪怕以 `Merge` 开头也不动，避免误伤 |
| D10 | 不引入第三方图谱库 | 自己实现 | `@gitgraph/js` 已归档，而且面向手写示意图，不适合渲染真实 log；VS Code「Git Graph」扩展的许可证不允许复用代码 |

## 4. 行为契约

### 4.1 数据

格式串改为 `%H%x00%h%x00%s%x00%an%x00%aI%x00%D%x00%P`，两端同改。`parseLogLine` 要求至少 7 段；第 7 段 `trim` 后按空白切分为 `parents`，空串得到 `[]`。

参数组装顺序（两端相同）：

```
log --format=… --date-order -n <limit> --skip <offset>
    [--branches --remotes --tags HEAD]           # allBranches 为真
    [--grep=<kw> --fixed-strings -i]             # 既有
    [-- <path>]                                  # 既有，必须最后
```

空仓库（无 HEAD）：`allBranches` 为假时与现在一样返回 `[]`。为真时若 `HEAD` 不可解析，git 会报 `ambiguous argument 'HEAD'`，同样被 `runGitOk` 吞成 `null` 返回 `[]`；但「有远端分支、本地还没提交」的仓库会因此看不到远端历史，所以 `allBranches` 时先用 `rev-parse --verify -q HEAD` 判定，不存在就不加 `HEAD` 这一项。

### 4.2 分道算法（`computeGitGraph`）

输入：按 `--date-order` 排好的 `GitLogEntry[]`。输出：与输入等长的 `GitGraphRow[]`，外加 `maxLane`。

```ts
interface GitGraphSegment { from: number; to: number; color: number }
interface GitGraphRow {
  lane: number                 // 本提交圆点所在列
  color: number                // 圆点颜色序号
  isMerge: boolean             // parents.length > 1
  top: GitGraphSegment[]       // 行上半段：从上边沿到圆点 / 下边沿的线
  bottom: GitGraphSegment[]    // 行下半段：从圆点 / 上边沿到下边沿的线
  passLanes: number[]          // 下边沿仍然活跃的列（展开区画穿行竖线用）
}
```

逐行维护 `lanes: (string | null)[]`（每列正在等待的提交哈希）与 `laneColor: number[]`：

1. **定列**：找出所有 `lanes[i] === hash` 的列。有则取最左一列为 `lane`，其余列在本行汇入（`top` 加 `i → lane` 斜线，随后这些列置 `null`）。没有（分支末梢或第一行）则取最左空列，没有空列就追加一列，并分配新颜色。
2. **穿行**：其它非空列在 `top` 和 `bottom` 各加一段 `i → i` 竖线。
3. **接父提交**：
   - 第一个父提交：若它已在别的列等待，`bottom` 加 `lane → 该列` 斜线，`lane` 列释放；否则 `lanes[lane] = parents[0]`，`bottom` 加 `lane → lane` 竖线，颜色沿用。
   - 其余父提交：已在某列等待就连过去；否则取最左空列（不能是 `lane`）或追加一列，分配新颜色，`bottom` 加 `lane → 新列` 斜线。
   - 没有父提交（根提交）：`lane` 列释放，`bottom` 不画该列。
4. 去掉 `lanes` 末尾的 `null`，记录 `passLanes`。

颜色序号按 8 色循环；同一条线在列内保持颜色，直到释放。

父提交不在已加载范围内（还没翻到那页、浅克隆、或「全部分支」之外）时，这条线一直画到最后一行的下边沿。列表到底（`exhausted`）后仍悬空的线在最后一行用渐隐收尾，表示「父提交不在当前视图中」。

### 4.3 合并标题

识别以下格式（大小写敏感、整行匹配，`A`、`B` 是捕获的名字）：

| 原文 | 显示 |
|---|---|
| `Merge branch 'A' into 'B'` / `Merge branch 'A' into B` | `A → B` |
| `Merge branch 'A' of <url> into B` | `A → B` |
| `Merge branch 'A'` | `A → (当前)` |
| `Merge remote-tracking branch 'A' [into B]` | `A → B` 或 `A → (当前)` |
| `Merge pull request #N from A` | `#N A` |

显示时在标题前加一个合并图标，文字用 `--aw-ink-muted-64`。`title` 属性仍是完整原文。复制、「添加到对话」用的仍是原文（`entry.title`）。不命中的合并提交只弱化颜色、不改文字。

### 4.4 「全部分支」开关

- 筛选栏右侧一个紧凑开关，文案「全部分支」，`aria-label` 同文案。默认关闭；状态只存在 `useGitManager` 内存里，切换仓库或关掉 Tab 后回到关闭。
- 切换后立即 `loadLog(true)`（不走 300ms 防抖），展开的提交收起。
- 与路径 / 关键词筛选可以同时生效（此时按 D4 不画图谱，但搜索范围是全部分支）。

## 5. 接口与改动面

### 5.1 CLOUD

`GET /v1/files/workspace-git-log` 增加查询参数 `allBranches`（`'1'` / `'true'` 为真，其余为假）。`WorkspaceGitService.getLog` 的 `opts` 增加 `allBranches?: boolean`。返回项增加 `parents: string[]`。

### 5.2 LOCAL

`gitStatus.cjs` 的 `getGitLog` 的 `options` 增加 `allBranches`，格式串与参数组装与 §4.1 一致（两边各写一份，与现有 log 一样不抽公共包）。IPC 通道 `git-log` 不变；`electron.d.ts` 的 `GitLogEntry` 与 `gitLog` 的 `options` 同步。

### 5.3 前端

- `types/git.ts`：`GitLogEntry` 增加 `parents: string[]`。CLOUD 与 LOCAL 的 provider 对缺失字段兜底为 `[]`，保证前端先于后端升级时不崩，只是画不出线。
- `WorkspaceGitProvider.getLog` 的 `opts` 增加 `allBranches?: boolean`，CLOUD 透传为查询参数，LOCAL 透传给 IPC。多仓库包装 `getLog: (opts) => p.getLog(opts, repoPath)` 原样透传 `opts`，无需改。
- `useGitManager`：新增 `logAllBranches` ref 与 `setLogAllBranches(v)`；`loadLog` 带上它。
- 新增 `utils/git-graph.ts`：`computeGitGraph(entries)` 与 `parseMergeTitle(title)`，均为纯函数。
- 新增 `components/git/GitGraphCell.vue`：按 `GitGraphRow` 画一行的 SVG；另一个模式（`passOnly`）只画 `passLanes` 的竖线，供展开区使用。
- `GitHistoryView.vue`：新增 prop `allBranches` 与事件 `update:allBranches`；`graphRows = computed(() => graphEnabled ? computeGitGraph(entries) : null)`，`graphEnabled = !pathFilter && !keyword`；行内在展开箭头之后插入 `GitGraphCell`；合并标题按 §4.3 渲染；`.git-log-date` 加 `white-space: nowrap`。

## 6. 界面

```
[按文件路径筛选……] [按提交信息搜索……] [◯ 全部分支]
 ›  ●─┐   99bb839f  ⑂ release_prod_20261123161847 → master   master  tag  origin/master   sre  18 小时前
 ›  │ ●   22eccd44  ⑂ feature/20261123/pb_so_warehouseTime → release_prod_…            sre  18 小时前
 ›  │ ●   1ce950dc  PB履约单直发单入仓时间限制调整                                  tutiankun  18 小时前
 ›  ●─┘   bb4f3d3f  ⑂ release_prod_20261118151014 → master                              sre  5 天前
```

- 图谱区宽度 = `(maxLane + 1) × 14px`（上限 140px），整页统一宽度，不随行变化，保证哈希列对齐。
- 圆点：普通提交实心 4px 半径；合并提交空心，描边同色。
- 颜色：8 色调色板走 CSS 变量 `--git-graph-0` … `--git-graph-7`，在 `GitHistoryView` 的样式里分别给亮色和 `[data-theme="dark"]` 定义，饱和度在暗色下降低一档。
- 弯线用三次贝塞尔，在行内上半段或下半段完成转折，不跨行。
- 展开某行后，文件清单左侧留出同宽的槽位，画该行 `passLanes` 的竖线；文件清单原有的 `padding-left: 30px` 改为「槽位宽度 + 16px」。

## 7. 风险与取舍

1. **翻页错位**：两次翻页之间仓库有新提交（Agent 正在提交、或刚 fetch 过且开着「全部分支」）时，`--skip` 会错位，表现为重复一行或少一行，图谱上可能出现一小段断线。现在的扁平列表也有同样问题，只是不明显。缓解：「刷新」按钮与写操作成功后的刷新都会 `loadLog(true)`，重置即可恢复。彻底解决要改成按游标翻页（`<上一页最后一个 hash>^@` 之类），接口语义变化较大，本期不做。
2. **超大仓库性能**：`--date-order` 需要先遍历可达历史再输出。仓库有 commit-graph 文件（`git gc` / `fetch` 默认会写）时很快；没有时十万级提交的仓库每页可能多出几百毫秒。本仓库约 2160 个提交，实测默认顺序、`--date-order`、`--topo-order` 在 `--skip 2000` 时都在 20ms 左右。现有 60s 命令超时足够。
3. **「全部分支」的宽度**：远端分支多的仓库在顶部几十行会出现很多列。D7 的上限能保住标题宽度，代价是超出部分的线叠在最后一列上，只能靠悬浮提示知道有几条。
4. **前后端版本不一致**：前端先上线、后端没升级时，`parents` 缺失，兜底为 `[]`，每行只画一个孤立圆点，不报错。后端先上线时旧前端忽略多出的字段。

## 8. 测试与文档

后端 `workspace-git.service.spec.ts`（真实临时仓库）：

- 线性历史：每条的 `parents` 是上一条的哈希，根提交 `parents` 为 `[]`。
- 制造一个非快进合并：合并提交 `parents` 长度为 2，顺序为「当前分支、被合并分支」。
- 父提交时间晚于子提交（用 `GIT_COMMITTER_DATE` 伪造）：返回顺序里子提交仍在父提交前面（验证 `--date-order`）。
- `allBranches`：另一个本地分支上的独有提交，默认不出现，打开后出现；`refs/stash` 上的提交在打开后也不出现。
- `allBranches` 与 `keyword`、`path` 组合仍然生效。
- 空仓库打开 `allBranches` 返回 `[]`，不报错。

Electron `gitStatus.test.cjs` 覆盖同一组里的：`parents` 解析、合并提交、`allBranches` 不含 stash。

前端：

- `git-graph.test.ts`：线性历史只占一列；一次分叉 + 合并占两列且合并后释放；章鱼合并（3 个父提交）；两个分支末梢汇入同一提交；父提交未加载时线画到底；根提交释放列；释放的列被新分支复用（D6）；超过 `MAX_LANES` 的列号被钳到最后一列（D7）。
- `parseMergeTitle`：§4.3 每种格式各一例；非合并提交、不认识的合并格式原样返回。
- `GitHistoryView`：有路径或关键词时不渲染 `GitGraphCell`，并显示「筛选中不显示图谱」；切换「全部分支」触发 `update:allBranches`。
- `useGitManager`：`setLogAllBranches` 立即重载第一页并把参数传给 `provider.getLog`。
- `workspace-git-provider`：CLOUD 带上 `allBranches` 查询参数；缺 `parents` 的返回项被兜底为 `[]`。

文档：同任务新增 `changelog/unreleased/2026-11-24-git-history-graph.md`（后端、前端（桌面 / Web / 安卓）、桌面 Electron 三节），并改 `skills/mao-cli/reference/desktop.md` 里 Git 管理器「历史」那一条。不改 `README.md` / `DEPLOY.md`。不加 Playwright。

## 9. 实现偏差

- **图谱放在展开箭头之前**（§5.3 原写在之后）：这样展开区的穿行竖线只需左缩进与行相同的 12px 即可对齐，不用再算箭头宽度。
- **连线层纵向拉伸、圆点用 HTML 叠加**：行高随字号与展开区变化，SVG 用 `preserveAspectRatio="none"` 铺满行高，线宽靠 `vector-effect: non-scaling-stroke` 保持不变；圆点若画在 SVG 里会被拉成椭圆，所以改用绝对定位的 `span`。
- **行上下 padding 归零、改 `min-height: 32px`**：图谱需撑满行高，相邻行的线才能首尾相接；开图谱时去掉行间分隔线（1px 边框会把线截断）。筛选时（无图谱）保留分隔线。
- **超出 10 列时**：叠在最后一列的那一行圆点改为空心并带「另有 N 条分支线未展开」悬浮提示（与合并提交共用空心样式）。
- **到底后悬空的父提交线**画成半透明虚线，而不是渐隐。
- **首父已在别列等待时**，合并提交自身的列会立刻空出并被第二父复用（单测「释放的列被后来的分支复用」）。本期不另做「首父优先保列」，截图里的 release 流程实测观感正常。
