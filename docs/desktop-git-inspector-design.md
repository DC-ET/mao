# 桌面端右侧栏 Git 状态与变更预览 — 技术方案

> 版本：v1.0 | 日期：2026-07-21 | 状态：待评审  
> 范围确认：LOCAL + CLOUD；相对 HEAD 全量变更；只读；中心 Diff Tab 预览；手动刷新 + 进入 Tab / 切会话时刷新

---

## 1. 需求背景

桌面端任务页右侧栏（`TaskInspector`）当前只有「任务」「文件」两个 Tab。「工作区」模块仅展示 Agent 名与路径，无法看到仓库分支与改动量。用户在 Agent 改文件后，需要离开客户端去终端/`git status`/`git diff` 才能确认变更，链路割裂。

仓库已有能力可复用：

| 已有能力 | 位置 | 可复用点 |
|---------|------|---------|
| `isGit` 探测 | Electron `isGitWorkspace`、会话字段 `Session.isGit` | 决定是否展示 Git Tab |
| 云端文件浏览 | `WorkspaceBrowseService` + `/files/workspace-*` | CLOUD 侧路径沙箱与会话归属校验模式 |
| 中心 Diff 预览 | `FileDiffViewer` + `useCenterTabs.openDiffTab` | SNAPSHOT 模式展示 before/after |
| 文件变更面板 | `FileChangePanel` → `openDiffTab` | 点击打开 Diff Tab 的交互范式 |

`docs/desktop-phased-tech-plan.md` Phase 4 曾规划 Inspector `GitPanel`（读 `git status -sb`），本需求将其落地为只读查看能力，并补齐 CLOUD 与文件级 diff。

---

## 2. 需求描述

### 2.1 要做的

1. **任务 Tab → 工作区模块：Git 摘要**
   - 当工作区是 Git 仓库时，在「工作区」路径下方展示：
     - 当前分支名
     - 相对 `HEAD` 的行数变化汇总：`+N / -M`
   - 非 Git 仓库不展示该摘要行。

2. **新增「Git」Tab**
   - 在「任务」「文件」之外，**仅当工作区是 Git 仓库时**显示第三个 Tab「Git」。
   - Tab 内列出相对 `HEAD` 的全部待提交变更文件（已暂存 + 未暂存 + 未跟踪，合并为每个路径一条）。
   - 每条展示：路径、变更类型、该文件 `+n / -m`（能算则算）。
   - 提供手动刷新按钮。
   - 点击文件 → 在中心区打开 Diff Tab，用 Monaco 并排预览相对 `HEAD` 的内容变化。

3. **双模式**
   - **LOCAL（Electron）**：主进程在工作区执行 `git`，经 IPC 返回。
   - **CLOUD**：后端在会话 workspace 内执行 `git`，经 REST 返回。
   - 前端用统一 Provider 抽象，UI 不感知模式差异。

4. **刷新时机**
   - 进入「Git」Tab 时拉取。
   - 切换会话时重新拉取（若新会话是 Git）。
   - 用户点击刷新按钮。
   - 工作区摘要与 Git Tab 列表共用同一套 status 数据源，避免两套状态。

### 2.2 不做的（本阶段明确排除）

| 不做 | 说明 |
|------|------|
| 暂存 / 取消暂存 / 提交 / 改写 commit | 无写操作 UI 与 API |
| 切换 / 创建 / 删除分支 | 仅展示当前分支名 |
| pull / push / fetch / remote 管理 | — |
| stash / conflict 解决 UI | 冲突文件按普通变更列出；不提供合并编辑器 |
| 定时轮询 / 文件系统 watch / Agent 工具结束后自动刷新 | 仅 2.1 约定的三种时机 |
| 右侧栏内嵌 diff | 预览只走中心 Diff Tab |
| 管理后台 Git UI | 仅 desktop |
| LOCAL 浏览器纯 Web 模式跑本机 git | 无 Electron IPC 时 LOCAL 不展示 Git 摘要与 Git Tab |
| 将 Git 摘要写入 Prompt / 上报给 Agent | 仅 UI 展示 |
| 子模块、worktree 切换、LFS 专项处理 | 按普通 `git` 结果展示；异常则提示失败 |

### 2.3 验收标准

- Git 仓库会话：工作区可见分支与 `+N/-M`；可见「Git」Tab；列表与 `git status`/`git diff HEAD` 语义一致。
- 非 Git 会话：无摘要、无「Git」Tab，不影响现有「任务」「文件」。
- 点击变更文件：中心出现 Diff Tab，左右分别为 `HEAD` 版本与工作区当前内容（新建/未跟踪左侧空；删除右侧空）。
- CLOUD 与 LOCAL（Electron）行为一致；越权访问其他会话 workspace 被拒绝。
- 只读：客户端与新增 API 均不能执行 `git add`/`commit`/`checkout` 等写命令。

---

## 3. 技术选型

### 3.1 决策结论

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 变更范围 | 相对 `HEAD` 的工作区全量 | 与「待提交」心智一致；一条列表即可 |
| 预览形态 | 中心 `openDiffTab` + `FileDiffViewer` SNAPSHOT | 已有 Monaco Diff，零新预览组件 |
| LOCAL 数据源 | Electron `child_process` 调系统 `git` | 与现有 `isGitWorkspace` 同进程；无需引入 isomorphic-git |
| CLOUD 数据源 | 后端 `ProcessBuilder` 调 `git` + `PathSandbox` | 对齐云端文件浏览安全模型 |
| 前端抽象 | `WorkspaceGitProvider`（仿 `WorkspaceFileProvider`） | 一处 UI，双模式实现 |
| 是否扩展现有 FileChange 工具事件 | 不混用工具变更事件 | Git diff 独立构造 `FileChange` 传入 `openDiffTab` |
| 包管理 | Electron 壳改动后 `desktop/package.json` version +1 | 仓库规范 |

### 3.2 备选方案与否决

| 方案 | 否决原因 |
|------|----------|
| 前端 isomorphic-git 读 `.git` | CLOUD 无法直接读服务端磁盘；LOCAL 大仓性能与兼容性差 |
| 复用 Agent Shell 会话跑 git | 副作用大、权限与会话生命周期耦合，不适合常驻面板 |
| 仅 PATCH 文本预览 | 用户已选中心并排 Diff；SNAPSHOT 体验更好 |
| 后端统一代理 LOCAL git | LOCAL 文件在用户机器，后端不可达 |

### 3.3 Git 命令约定（LOCAL / CLOUD 共用语义）

在**仓库根**（含向上找到的 `.git` 所在目录）执行，超时建议 10s，stdout 上限建议 2 MiB（超出截断并标记）。

| 用途 | 命令 | 解析 |
|------|------|------|
| 是否 Git / 根目录 | `git rev-parse --show-toplevel` | 非 0 → 非 Git |
| 当前分支 | `git rev-parse --abbrev-ref HEAD` | `HEAD` 表示 detached，原样展示 |
| 文件列表（相对 HEAD） | `git diff --name-status HEAD` + `git ls-files --others --exclude-standard` | 见下表映射 |
| 行数汇总 / 单文件行数 | `git diff --numstat HEAD`；未跟踪文件按「全文为新增」计行（二进制计 `0/0` 并标 binary） | 汇总 `insertions`/`deletions` |
| 单文件 before | `git show HEAD:"path"`（新文件/未跟踪无对象 → 空） | 文本；二进制拒绝 |
| 单文件 after | 读工作区文件内容（删除 → 空） | 与 `local-read-file` / `workspace-read` 同沙箱规则 |

**name-status → UI 类型映射**

| git | UI `changeType` |
|-----|-----------------|
| `A` | `CREATED` |
| `M` | `MODIFIED` |
| `D` | `DELETED` |
| `R*` | `RENAMED`（展示新路径；旧路径可放副标题） |
| `C*` | `COPIED` |
| untracked | `CREATED`（来源标记 `untracked: true`） |

不单独拆 Staged/Unstaged 分组（需求 2A）。

---

## 4. 架构设计

### 4.1 总体数据流

```text
TaskInspector
  ├─ 工作区摘要 ← useGitStatus().summary
  └─ GitTab (变更列表) ← useGitStatus().files
           │ click
           ▼
  WorkspaceGitProvider.getFileDiff(path)
           │
           ▼
  构造 FileChange { diffMode: 'SNAPSHOT', beforeContent, afterContent, ... }
           │
           ▼
  useCenterTabs.openDiffTab(...) → FileDiffViewer
```

```text
LOCAL (Electron)                         CLOUD
renderer → preload IPC                   renderer → REST
  → main.cjs runGit(cwd)                   → WorkspaceGitService
                                             → Session 归属校验
                                             → PathSandbox + ProcessBuilder git
```

### 4.2 前端模块

| 模块 | 职责 |
|------|------|
| `desktop/src/composables/workspace-git-provider.ts` | `createLocalGitProvider` / `createCloudGitProvider` / `useWorkspaceGitProvider` |
| `desktop/src/composables/useGitStatus.ts` | 缓存 summary+files；loading/error；`refresh()`；监听 session/workspace/tab 可见性 |
| `desktop/src/components/task/GitChangeList.vue` | Git Tab：列表、类型徽章、行数、空态、错误、刷新 |
| `desktop/src/components/task/TaskInspector.vue` | Tab 扩展为 `workspace \| filetree \| git`；工作区摘要行；`showGitTab` |
| `desktop/src/views/task/TaskView.vue` | 注入 provider；`open-git-diff` → `openDiffTab` |
| `desktop/electron/main.cjs` + `preload.cjs` | `git-status`、`git-file-diff` IPC；version +1 |
| `desktop/src/types/git.ts` | `GitStatusSummary`、`GitChangedFile`、`GitFileDiff` |

### 4.3 后端模块

| 模块 | 职责 |
|------|------|
| `file/service/WorkspaceGitService.java` | 解析 git 根、执行只读命令、组装 DTO |
| `file/controller/FileController.java`（或独立 `WorkspaceGitController`） | REST 入口，校验 session 归属 |
| 单测 | 临时 git 仓库 fixture：分支、改文件、未跟踪、删除、diff 截断 |

建议挂在 `/v1/files` 下，与云端文件浏览同一权限叙事：

- `GET /v1/files/workspace-git-status?sessionId=`
- `GET /v1/files/workspace-git-diff?sessionId=&path=`

权限：登录用户 + `session.userId` 匹配；workspace 取自会话，禁止客户端传任意绝对路径。

### 4.4 数据结构

```ts
interface GitStatusSummary {
  isGit: boolean
  repoRoot?: string
  branch?: string          // 含 "HEAD" detached
  insertions: number       // +N
  deletions: number        // -M
  changedFileCount: number
}

interface GitChangedFile {
  path: string             // 相对 repoRoot，正斜杠
  oldPath?: string         // rename/copy
  changeType: 'CREATED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED'
  untracked?: boolean
  insertions: number
  deletions: number
  binary?: boolean
}

interface GitFileDiff {
  path: string
  changeType: GitChangedFile['changeType']
  beforeContent: string
  afterContent: string
  truncated?: boolean
  binary?: boolean
  unavailableReason?: string
}
```

打开中心 Tab 时映射：

```ts
openDiffTab({
  path: diff.path,
  type: diff.changeType,
  linesAdded: file.insertions,
  linesDeleted: file.deletions,
  diffMode: diff.binary ? 'UNSUPPORTED' : 'SNAPSHOT',
  beforeContent: diff.beforeContent,
  afterContent: diff.afterContent,
  diffUnavailableReason: diff.unavailableReason,
}, `${fileName} (Git)`)
```

标题加 `(Git)`，与工具变更 `(变更)` 区分。

### 4.5 展示与可见性规则

```text
showGitTab =
  工作区可解析
  AND 运行时判定为 Git（优先实时 rev-parse；会话 isGit 仅作乐观提示）
  AND (
    executionMode === 'CLOUD'
    OR (executionMode === 'LOCAL' AND window.electronAPI 存在)
  )
```

- Tab 栏：有「文件」或「Git」任一可见时显示 Tab 条（现逻辑是仅 `showFileTreeTab` 时显示，需改为「多 Tab 时显示」）。
- 非 Git / LOCAL 无 Electron：不渲染「Git」Tab，工作区不渲染摘要。
- `git` 二进制不存在或命令失败：摘要与列表展示错误文案 + 重试，不崩溃整栏。

### 4.6 UI 要点

**工作区摘要（任务 Tab）**

- 一行：分支图标/文字 + 分支名 + `+N`（绿）` -M`（红）。
- `changedFileCount === 0`：仍显示分支，行数显示 `+0 / -0` 或「工作区干净」。
- loading：小 spinner 或不占位闪烁；失败：灰色「Git 状态不可用」。

**Git Tab**

- 顶栏：标题「变更」+ 数量 + 刷新按钮。
- 列表：相对路径（可截断）、类型标签、`+n -m`。
- 空态：「没有待提交的变更」。
- 点击整行打开 Diff；二进制/过大：打开 Tab 但 `UNSUPPORTED` + 原因。

### 4.7 内容与安全限制

| 项 | 限制 |
|----|------|
| 单文件文本 | 与现有预览对齐：最多约 5000 行或 512 KiB（前后各计）；超出 `truncated: true`，Diff 仍可看截断内容并提示 |
| 二进制 | 不返回 base64；`binary: true`，Diff 不可用 |
| 路径 | 必须落在 `repoRoot` 且（CLOUD）在 session workspace 沙箱内 |
| 命令 | 白名单：仅 `rev-parse` / `diff` / `show` / `ls-files`；禁止用户拼接任意 git 参数 |
| CLOUD | 不经过用户交互式 shell，无 credential 提示需求（只读本地对象） |

---

## 5. 实现步骤

### Phase 1 — 契约与 Provider（无 UI）

1. 新增 `types/git.ts` 与 `WorkspaceGitProvider` 接口。
2. Electron：`runGit(cwd, args)` 辅助函数；IPC `git-status`、`git-file-diff`；preload 暴露；`package.json` version +1。
3. 后端：`WorkspaceGitService` + 两个 GET API + 会话校验；单元测试覆盖干净仓 / 修改 / 未跟踪 / 删除。
4. 前端 cloud/local provider 实现，可用临时页面或单测脚本验证。

### Phase 2 — 任务 Tab 摘要 + Git Tab 列表

1. `useGitStatus`：进入 Git Tab、切会话、手动 refresh。
2. `TaskInspector`：工作区摘要；`inspectorActiveTab` 增加 `git`；`GitChangeList`。
3. Tab 可见性与「非 Git 时退回任务 Tab」的 watch。
4. 空态 / loading / error。

### Phase 3 — Diff 预览打通

1. `GitChangeList` emit `open-git-diff`。
2. `TaskView` 调 provider.`getFileDiff` → `openDiffTab`。
3. 覆盖：修改、新建、未跟踪、删除、二进制、截断。
4. 确认与工具变更 Diff Tab 可并存（不同 title / 可同 path 复用现有 `diff:` id 策略：后打开覆盖同 path 的 diff tab，可接受；若需隔离可将 id 改为 `git-diff:` + path）。

**建议**：`openDiffTab` 对 Git 使用 `id = 'git-diff:' + path`，避免与工具 `diff:` 互相覆盖。需小改 `useCenterTabs`（本需求范围内允许）。

### Phase 4 — 打磨与回归

1. CLOUD `workspaceMode=git` clone 仓与临时非 Git 仓对照。
2. LOCAL Electron 与纯浏览器 LOCAL（应隐藏 Git）对照。
3. detached HEAD、中文路径、rename 展示。
4. 文档与本方案对齐；必要时补 E2E 冒烟（可选，非必须进 CI）。

---

## 6. 落地清单

### 6.1 后端

- [ ] `WorkspaceGitService`：只读 git 封装、超时、输出上限、DTO 组装
- [ ] `GET /v1/files/workspace-git-status`
- [ ] `GET /v1/files/workspace-git-diff`
- [ ] Session 归属 + `PathSandbox`；非 Git 返回 `isGit: false`（status）或明确错误码（diff）
- [ ] `backend/src/test/.../WorkspaceGitServiceTest`（或同类）

### 6.2 Electron

- [ ] `main.cjs`：`git-status` / `git-file-diff`（基于工作区路径向上找 repo root）
- [ ] `preload.cjs`：`gitStatus` / `gitFileDiff`
- [ ] `desktop/package.json` version 小版本 +1

### 6.3 Desktop 前端

- [ ] `types/git.ts`
- [ ] `workspace-git-provider.ts`
- [ ] `useGitStatus.ts`
- [ ] `GitChangeList.vue`
- [ ] `TaskInspector.vue`：摘要 + Git Tab
- [ ] `TaskView.vue`：接线 + 打开 Diff
- [ ] `useCenterTabs.ts`：Git diff tab id 隔离（`git-diff:`）
- [ ] 非 Electron LOCAL / 非 Git 隐藏逻辑

### 6.4 测试与验收

- [ ] 后端单测：命令解析与边界
- [ ] 手工：LOCAL Electron 改几个文件 → 摘要与列表 → 点开 Diff
- [ ] 手工：CLOUD git 项目同样路径
- [ ] 手工：非 Git、干净工作区、删除文件、未跟踪文件
- [ ] 手工：纯浏览器打开 LOCAL 会话 → 无 Git Tab

### 6.5 文档

- [ ] 本方案评审通过后按实现回写「实现备注」（若有命令/字段微调）
- [ ] 不更新用户手册以外的营销文案（无独立产品文档要求则跳过）

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 大仓库 `git diff HEAD` 慢 | 10s 超时；列表阶段不读文件内容；Diff 按需单文件 |
| 未安装 git | 明确错误「未检测到 git 命令」 |
| `isGit` 会话字段过期 | 展示以实时 `rev-parse` 为准 |
| 中文/特殊路径 | `git -c core.quotepath=false`；路径参数小心引号 |
| 与工具 Diff Tab 冲突 | 使用 `git-diff:` tab id |
| CLOUD 工作区非 git（`new` 临时目录） | `isGit: false`，不展示 Tab |

---

## 8. 工作量粗估

| 端 | 人日 |
|----|------|
| Electron IPC + git 解析 | 1～1.5 |
| 后端 WorkspaceGitService + API + 单测 | 1.5～2 |
| 前端 Provider + Inspector UI + Diff 接线 | 2～2.5 |
| 联调与边界 | 1 |
| **合计** | **约 5.5～7 人日** |

---

## 9. 需求确认记录

| 项 | 结论 |
|----|------|
| 模式范围 | LOCAL + CLOUD（1B） |
| 变更集合 | 相对 HEAD 全量：staged + unstaged + untracked（2A） |
| 写操作 | 本阶段不做，只读（3） |
| 预览位置 | 中心 Diff Tab，复用 FileDiffViewer（4A） |
| 刷新 | 手动 + 进入 Git Tab + 切换会话（5A）；不做轮询与工具结束后自动刷新 |
