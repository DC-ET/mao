# Git 提交、拉取与推送技术方案

## 1. 文档信息

- 文档状态：已确认方案
- 适用项目：Mao
- 覆盖端：桌面/Web/安卓共用前端、桌面 Electron、本地模式、云端模式、Java 后端
- 目标位置：任务页右侧检查器的 Git Tab，“变更”工具栏右侧
- 对应组件：`desktop/src/components/task/GitChangeList.vue`
- 方案范围：提交代码、拉取代码、推送代码三个图标及完整执行链路

## 2. 需求背景

当前任务页右侧 Git Tab 已支持以下只读能力：

- 发现工作区根仓库或一级子目录中的多个 Git 仓库；
- 查看当前分支、文件变更数量和增删行数；
- 查看变更文件树和文件 diff；
- 手动刷新 Git 状态。

现有工具栏只有刷新按钮。用户在移动端、Web 或桌面端查看代码变更后，仍需通过终端执行提交、拉取和推送，操作链路不完整。尤其在移动端和 CLOUD 模式下，用户缺少便捷的终端入口。

本需求在“变更”工具栏增加三个图标，为当前选中仓库提供提交、拉取和推送能力。其中提交信息不由用户输入，而是由当前工作区所属主会话模型根据仓库变更自动生成，生成成功后直接完成提交。

## 3. 需求描述

### 3.1 工具栏

Git 工具栏按以下固定顺序展示：

1. 提交：`Check` 图标；
2. 拉取：`Download` 图标；
3. 推送：`Upload` 图标；
4. 刷新：保留现有 `Refresh` 图标。

按钮统一使用 28×28 像素点击区域，提供 `title`、tooltip 和 `aria-label`。操作执行期间，仅当前按钮显示旋转加载状态，不展示阶段文案，不使用全屏遮罩。

三个操作同时支持：

- CLOUD：Web、安卓、Electron 中的云端任务；
- LOCAL：Electron 中的本地任务。

用户主动点击 Git 图标属于显式 UI 操作，不受会话 `READ_ONLY`、`READ_WRITE`、`SMART` 等 Agent 工具权限等级限制，也不进入 Agent 工具审批流。服务端仍必须校验用户会话归属、工作区路径和仓库路径。

### 3.2 自动提交

点击提交图标后，系统执行以下固定流程：

1. 获取当前选中仓库全部变更，包括已暂存、未暂存、已跟踪和未跟踪文件；
2. 生成用于模型分析的受限 diff；
3. 使用工作区所属主会话模型生成提交信息；
4. 校验提交信息格式；
5. 执行 `git add -A`；
6. 执行 `git commit --no-verify`；
7. 返回短提交哈希和标题并刷新 Git 状态。

生成后不展示确认框，不允许用户编辑，直接提交。

提交信息采用 Conventional Commits 中文格式：

```text
<type>(<scope>): <中文描述>

- <中文改动要点>
- <中文改动要点>
```

约束如下：

- `type` 和 `scope` 使用英文；
- 描述和正文使用简体中文；
- 正文必须为 `- ` 开头的无序列表；
- 标题不设置字符数上限；
- 不提供近期 Git 历史或聊天上下文给模型；
- 模型首次输出不合规时，将校验错误反馈给同一模型并重试一次；
- 第二次仍不合规、模型调用失败或超时，终止提交；
- 生成失败时不执行 `git add`，不使用固定文案或规则模板降级提交。

提交使用工作区所属主会话的模型。即使当前右侧面板正在查看边路任务或子代理，也不使用子会话模型。

提交信息生成是独立后台 LLM 调用：

- 不创建用户消息或助手消息；
- 不写入聊天记录；
- 不占用后续 Agent 对话上下文；
- 记录实际模型调用用量。

若仓库未配置 `user.name` 或 `user.email`，仅为本次提交注入：

```text
Mao Agent <mao@etarch.cn>
```

不得修改仓库级或全局 Git 配置。

提交成功提示格式：

```text
提交成功 <shortHash>：<commit title>
```

提交失败时保留 `git add -A` 已产生的暂存状态，不执行 `git reset`，也不尝试恢复提交前的暂存/未暂存边界。

### 3.3 Diff 构建与敏感信息过滤

模型输入包含：

- 全量变更文件路径；
- 每个文件的变更类型；
- 每个文件的增删行数；
- 普通文本文件的受限 diff；
- 是否为二进制、敏感文件或内容被截断的标记。

文本 diff 总上限固定为 200 KB。超限时：

1. 保留全部文件元数据；
2. 为普通文本文件公平分配内容额度，避免前几个大文件占满上限；
3. 对被截断文件显式标记 `truncated=true`；
4. 不因截断而阻止生成。

二进制文件只发送路径和变更类型，不发送内容。

敏感文件采用代码内固定规则，不增加设置页面或仓库配置文件。至少覆盖：

- `.env`、`.env.*`；
- `*.pem`、`*.key`、`*.p12`、`*.pfx`；
- `id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519` 及对应私钥命名；
- 文件名包含 `credential`、`credentials`、`secret`、`secrets`、`token` 的常见凭据文件。

命中敏感规则后：

- 文件仍属于“全部当前变更”，会被提交；
- 文件路径和变更类型会发送给模型；
- 文件 diff 内容不得发送给后端生成服务、模型服务、日志或活动记录。

LOCAL 模式允许将经过上述过滤和 200 KB 限制后的 diff 上传到 Mao 后端，再由后端调用主会话模型。原始未过滤 diff 不上传。

### 3.4 拉取

点击拉取图标后直接执行，不弹确认框。拉取采用 merge 模式，使用等价命令：

```bash
git pull --no-edit
```

允许 Git 在分支分叉时生成 merge commit，合并提交信息使用 Git 默认内容，不调用 AI。

工作区存在已跟踪或未跟踪变更时，执行以下流程：

1. 创建带唯一 Mao 标识的 stash，包含已跟踪和未跟踪文件，不包含 ignored 文件；
2. 记录本次 stash 的对象 ID，不依赖可能变化的 `stash@{0}`；
3. 执行 `git pull --no-edit`；
4. pull 成功且未产生冲突时，恢复本次 stash；
5. pull 非冲突失败时，立即尝试恢复本次 stash；
6. pull 已进入合并冲突时，不恢复 stash，保留冲突现场和带 Mao 标识的 stash，并在错误信息中提示 stash 引用；
7. stash 恢复产生冲突时，保留 Git 冲突现场并明确提示，不自动 reset、abort 或覆盖文件。

自动 stash 等价于：

```bash
git stash push --include-untracked -m "mao-auto-pull-<operationId>"
```

不得使用 `--all`，不得 stash ignored 文件。

### 3.5 推送

点击推送图标后直接执行，不弹确认框。工作区存在未提交变更时仍允许推送已有提交。

已配置 upstream 时执行普通：

```bash
git push
```

未配置 upstream 时：

1. 获取当前分支和 remote 列表；
2. 存在 `origin` 时，执行 `git push --set-upstream origin <branch>`；
3. 不存在 `origin` 且仅有一个 remote 时，使用该 remote；
4. 不存在 `origin` 且有多个 remote 时终止并提示用户先配置 upstream；
5. 没有 remote 时按钮禁用。

推送永不使用 `--force` 或 `--force-with-lease`。出现 non-fast-forward 时失败并提示用户先拉取处理。

### 3.6 状态与禁用规则

- 没有待提交变更：提交按钮禁用，tooltip 显示“没有待提交的变更”；
- 没有 remote：拉取和推送按钮禁用，tooltip 显示“仓库未配置远端”；
- detached HEAD：允许提交，禁用拉取和推送，并提示先切换分支；
- 当前仓库 Git 状态不可用：三个写操作均禁用；
- 同一仓库已有 Git 写操作执行中：拒绝新的提交、拉取或推送请求，立即提示“Git 操作进行中”；
- Agent 主任务或边路任务运行期间：三个 Git 操作仍保持可用；
- 自动生成提交信息期间工作区继续变化：不做快照一致性校验，最终 `git add -A` 会提交当时的最新全部变更；
- 每次操作完成后刷新仓库发现结果、当前仓库状态和文件变更列表。

## 4. 明确不做

本需求明确不实现以下内容：

1. 不提供提交信息输入框、确认弹窗或编辑能力；
2. 不提供文件勾选、部分提交、逐文件暂存、取消暂存或暂存区管理；
3. 不在提交前自动运行测试、构建或由 AI 选择检查命令；
4. 提交固定使用 `--no-verify`，不执行 `pre-commit`、`prepare-commit-msg`、`commit-msg` 等 Git hooks；
5. 不在提交后自动 push；
6. push 前不弹确认框；
7. pull 前不弹确认框；
8. 不提供强制推送；
9. 不提供 rebase pull 或 fast-forward-only pull；
10. 不在 pull merge commit 时生成 AI 提交信息；
11. 不新增 Git 作者设置页面；
12. 不修改用户仓库级或全局 Git 身份配置；
13. 不新增 LOCAL Git 凭证管理，不把 CLOUD Token 下发到 Electron；
14. 不新增本地模型配置；
15. 不提供敏感文件规则的用户配置或仓库配置；
16. 不把提交信息生成写入聊天记录；
17. 不向模型发送聊天上下文或近期 Git 提交历史；
18. 不对生成期间的工作区变更做快照一致性校验；
19. 不因 Agent 正在运行而禁用 Git 操作；
20. 不自动解决 merge、stash pop 或 push 冲突；
21. 不自动删除冲突场景下保留的 Mao stash；
22. 不支持工作区一级子目录以外的任意 `repoPath`。

## 5. 现有架构与技术选型

### 5.1 前端

技术栈：Vue 3 Composition API、TypeScript、Element Plus。

复用现有：

- `desktop/src/components/task/GitChangeList.vue`：Git 工具栏和变更树；
- `desktop/src/components/task/TaskInspector.vue`：仓库选择、Git 状态和刷新编排；
- `desktop/src/composables/workspace-git-provider.ts`：CLOUD/LOCAL provider 抽象；
- `desktop/src/composables/useGitStatus.ts`：当前仓库状态；
- `desktop/src/composables/useGitRepos.ts`：多仓库发现和当前仓库选择；
- `desktop/src/types/git.ts`：Git DTO 类型。

选择在 `WorkspaceGitProvider` 增加统一写操作，确保 UI 不感知 CLOUD/LOCAL 的实现差异。

### 5.2 LOCAL

技术栈：Electron IPC、Node.js `child_process`、参数数组执行 Git。

复用现有：

- `desktop/electron/gitStatus.cjs` 的 `resolveRepoDir()`、Git 状态和 diff 解析；
- `desktop/electron/main.cjs` 的 Git IPC 注册；
- `desktop/electron/preload.cjs` 的安全 API 暴露；
- `desktop/src/types/electron.d.ts` 的 Electron API 声明。

LOCAL 拉取和推送沿用本机 Git 的 credential helper、SSH Agent 或系统凭证。不得把后端保存的 Access Token下发到 Electron。

### 5.3 CLOUD

技术栈：Spring Boot、Java 17、REST API、`ProcessBuilder`、MyBatis-Plus、Flyway。

复用现有：

- `FileController.requireOwnedSession()` 的会话归属校验；
- `WorkspaceGitService` 的工作区解析、仓库解析、状态和 diff 能力；
- `PathSandbox` 的路径沙箱；
- `GitCredentialService` 和现有 askpass 机制的 HTTPS Token；
- `ActivityService` 的会话活动记录。

CLOUD 远程操作使用当前用户在 Mao 中配置的 HTTPS Access Token。Token 只通过进程环境变量和受限 askpass 脚本提供，不拼接到命令参数、远端 URL、接口响应或日志。

### 5.4 LLM

复用现有：

- `LlmAdapter.chat()` 同步非流式调用；
- `ChatRequest`、`ChatResponse`、`ChatUsage`；
- `HarnessService.resolveModel()` 的“指定模型，缺失时默认模型”规则；
- `LlmModel` 到 `LlmModelConfig` 的配置映射方式。

提交信息生成使用非流式请求，不提供工具定义，模型只返回文本。请求由后端统一执行，LOCAL 前端仅上传脱敏后的模型输入，不接触模型 API Key。

## 6. 总体架构

```text
GitChangeList
  └─ emit(commit / pull / push)
      └─ TaskInspector
          └─ WorkspaceGitProvider
              ├─ CLOUD provider
              │   └─ REST /v1/files/workspace-git-*
              │       ├─ WorkspaceGitService
              │       ├─ GitCommitMessageService → LlmAdapter
              │       ├─ GitCredentialService / askpass
              │       └─ ActivityService / LLM usage
              └─ LOCAL provider
                  ├─ Electron IPC 读取状态、构建脱敏 diff、执行 Git
                  └─ REST generate-commit-message
                      ├─ 会话归属和主模型解析
                      ├─ GitCommitMessageService → LlmAdapter
                      └─ LLM usage
```

CLOUD 自动提交由服务端完成 diff 构建、模型生成和 Git 提交。

LOCAL 自动提交分两段完成：

1. Electron 在本机仓库构建经过敏感过滤和大小限制的模型输入；
2. 前端将模型输入提交给后端生成接口；
3. 生成成功后前端把提交信息传回 Electron；
4. Electron 对本机仓库执行 `git add -A` 和 `git commit --no-verify`。

后端不得接受 LOCAL 客户端上传的任意工作区路径并在服务器执行 Git；LOCAL 生成接口只处理结构化 diff 数据和会话模型解析。

## 7. 数据结构设计

### 7.1 前端统一类型

在 `desktop/src/types/git.ts` 增加：

```ts
export type GitOperationType = 'commit' | 'pull' | 'push'

export interface GitRemoteState {
  remotes: string[]
  hasRemote: boolean
  detachedHead: boolean
  upstream?: string
}

export interface GitOperationResult {
  success: boolean
  operation: GitOperationType
  message?: string
  error?: string
  branch?: string
  commitHash?: string
  commitTitle?: string
  stashRef?: string
  conflict?: boolean
}

export interface GitCommitGenerationInput {
  files: Array<{
    path: string
    changeType: string
    insertions: number
    deletions: number
    binary: boolean
    sensitive: boolean
    truncated: boolean
    diff?: string
  }>
  truncated: boolean
  diffBytes: number
}
```

`GitStatusResult` 增加远端和 HEAD 状态，供按钮禁用判断使用。

### 7.2 Provider 接口

`WorkspaceGitProvider` 增加：

```ts
commit(): Promise<GitOperationResult>
pull(): Promise<GitOperationResult>
push(): Promise<GitOperationResult>
```

多仓库模式下由 `TaskInspector` 的包装 provider 固定当前 `selectedRepoPath`，与现有 `getStatus()` 和 `getFileDiff()` 行为一致。

### 7.3 LLM 用量表

新增 Flyway 迁移 `V073__llm_usage.sql`，建立统一后台 LLM 调用用量表，字段至少包括：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT | 自增主键 |
| `user_id` | BIGINT | 发起用户 |
| `session_id` | BIGINT | 主会话 |
| `model_id` | BIGINT | 实际调用模型 |
| `scene` | VARCHAR(64) | 本场景固定 `git_commit_message` |
| `prompt_tokens` | INT | 输入 token |
| `completion_tokens` | INT | 输出 token |
| `total_tokens` | INT | 总 token |
| `success` | TINYINT | 调用是否成功 |
| `created_at` | DATETIME | 创建时间 |

增加实体、Mapper 和 Service。提交信息格式重试发生两次模型调用时，两次均分别记录实际用量。统计服务按模型汇总消息用量与该表后台调用用量，不创建隐藏消息。

### 7.4 活动记录

通过 `ActivityService` 写入以下活动类型：

- `GIT_COMMIT`；
- `GIT_PULL`；
- `GIT_PUSH`。

记录内容包括：

- 主会话 ID；
- 仓库相对路径；
- 操作类型；
- 成功或失败；
- 分支；
- 提交短哈希和标题；
- stash 引用或冲突标记；
- 耗时；
- 脱敏后的简短错误。

不得记录：

- Access Token、SSH 密钥或 credential helper 输出；
- 完整 diff；
- 敏感文件内容；
- 带凭证的远端 URL；
- 完整模型 prompt。

LOCAL 操作结果由前端回传后端活动接口，后端校验会话归属并只接受结构化摘要，不能接受任意活动类型或未限制长度的日志文本。

## 8. API 设计

所有接口前缀为 `/api/v1`，下列路径基于控制器 `/v1/files` 描述。

### 8.1 CLOUD 提交

```http
POST /v1/files/workspace-git-commit
Content-Type: application/json
```

请求：

```json
{
  "sessionId": 123,
  "repoPath": "project-a"
}
```

服务端从主会话读取 `modelId`，完成 diff 构建、生成和提交。客户端不得指定模型 ID或提交信息。

### 8.2 CLOUD 拉取

```http
POST /v1/files/workspace-git-pull
```

请求必须包含 `sessionId`；工作区根仓库不传 `repoPath`，多仓库模式必须传当前选中仓库的一级子目录 `repoPath`。

### 8.3 CLOUD 推送

```http
POST /v1/files/workspace-git-push
```

请求必须包含 `sessionId`；工作区根仓库不传 `repoPath`，多仓库模式必须传当前选中仓库的一级子目录 `repoPath`。

### 8.4 LOCAL 提交信息生成

```http
POST /v1/files/git-commit-message
```

请求：

```json
{
  "sessionId": 123,
  "changes": {
    "files": [],
    "truncated": false,
    "diffBytes": 0
  }
}
```

服务端必须：

- 校验会话属于当前用户；
- 使用主会话 `modelId`；
- 再次校验结构、文件数量、单字段长度和请求体 200 KB 级边界；
- 拒绝客户端提供模型 API Key、任意 system prompt 或模型 ID；
- 返回校验通过的提交标题和正文。

### 8.5 LOCAL 活动记录

```http
POST /v1/files/workspace-git-activity
```

仅用于记录 Electron 已执行的结构化 Git 结果。请求字段使用枚举和长度上限，服务端校验会话归属。

### 8.6 响应

统一使用项目 `Result<T>`。Git 操作数据结构与 `GitOperationResult` 对齐。业务失败返回可读错误，不把原始进程环境或完整 stderr 直接返回。

## 9. 后端实现设计

### 9.1 服务拆分

保留 `WorkspaceGitService` 负责仓库路径解析、状态、diff 和 Git 进程基础执行；新增：

- `GitCommitMessageService`：模型输入校验、prompt 构建、模型解析、格式校验、一次纠错重试、用量记录；
- `GitWriteOperationService`：CLOUD commit/pull/push、互斥锁、凭证环境、stash 生命周期和活动记录；
- `LlmUsageService`：统一后台模型用量落库。

不把写操作继续堆入只读 DTO 解析逻辑，避免 `WorkspaceGitService` 同时承担模型、凭证、活动和状态职责。

### 9.2 Git 执行器

写操作统一使用 `ProcessBuilder(List<String>)`，严禁拼接 shell 命令。每条操作统一 60 秒超时，超时后强制终止进程并释放仓库锁。

Git 环境至少设置：

```text
GIT_TERMINAL_PROMPT=0
```

CLOUD 远程操作同时配置当前用户的 `GIT_ASKPASS` 和域名 Token 环境变量。进程 stdout/stderr 设置总大小上限，错误输出先脱敏再返回。

### 9.3 仓库锁

按规范化仓库根路径建立进程内互斥锁：

- commit、pull、push 共用同一把仓库写锁；
- 获取失败立即返回“Git 操作进行中”，不排队；
- 所有成功、异常、超时路径均在 `finally` 释放；
- 锁 Map 在无持有者后移除，避免长期增长。

Electron 主进程使用同样的按仓库根路径互斥策略。

### 9.4 提交信息 Prompt

System prompt 固定声明：

- 只生成提交信息，不解释；
- 标题必须符合 Conventional Commits；
- type/scope 英文、描述和正文简体中文；
- 标题后空一行；
- 正文至少一条 `- ` 列表；
- 不臆测未在 diff 或元数据中体现的改动；
- 敏感/二进制/截断文件只能依据元数据概括；
- 输出不得包含 Markdown 代码围栏。

User prompt 只包含结构化变更摘要和受限 diff，不包含聊天历史。

格式校验至少验证：

```regex
^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: .+
```

标题后必须存在空行，正文每个非空行必须以 `- ` 开头。标题不做长度限制。

首次校验失败时，用同一模型再次请求，并附上具体校验错误和首次输出；第二次失败抛出业务错误。

### 9.5 CLOUD Commit

固定步骤：

1. 校验会话归属；
2. 解析工作区和 `repoPath`；
3. 获取仓库写锁；
4. 检查存在变更；
5. 构建过滤后的 200 KB 模型输入；
6. 调用主会话模型生成提交信息；
7. 执行 `git add -A`；
8. 检测 Git 作者身份；缺失时为本次 commit 增加 `-c user.name=Mao Agent -c user.email=mao@etarch.cn`；
9. 使用临时消息文件或多个 `-m` 参数执行 `git commit --no-verify`，不得经 shell 展开；
10. 获取 `git rev-parse --short HEAD`；
11. 记录活动并返回；
12. 释放锁。

模型生成后不重新校验工作区快照。步骤 7 会纳入生成期间出现的最新全部变更。

### 9.6 CLOUD Pull

固定步骤：

1. 校验仓库、分支和 remote；
2. 获取写锁；
3. 检测工作区是否有变更；
4. 有变更则创建唯一 Mao stash 并记录对象 ID；
5. 使用凭证环境执行 `git pull --no-edit`；
6. 根据退出状态和 Git 冲突状态判断是否恢复 stash；
7. 无 pull 冲突时，按对象 ID恢复本次 stash；
8. pull 冲突时保留 stash 和冲突现场；
9. 记录活动、返回状态并释放锁。

恢复时不得简单执行无参数 `git stash pop`。应使用记录的对象 ID，并在成功应用后只删除对应 stash；若应用冲突，保留 stash 记录和冲突文件。

### 9.7 CLOUD Push

固定步骤：

1. 校验当前不是 detached HEAD；
2. 获取 remote 和 upstream；
3. 获取写锁；
4. 有 upstream 时执行普通 push；
5. 无 upstream 时按 `origin` 优先规则选择 remote 并执行 `--set-upstream`；
6. non-fast-forward 直接失败；
7. 记录活动并释放锁。

## 10. Electron 实现设计

### 10.1 IPC

新增 IPC：

- `git-commit-input`：本机生成经过过滤的模型输入；
- `git-commit`：接收后端已校验的提交信息并执行 add/commit；
- `git-pull`；
- `git-push`。

在 `preload.cjs` 暴露对应方法，并在 `electron.d.ts` 补齐类型。

提交信息由后端返回后，Electron 仍执行最小结构校验和长度限制，再作为参数传给 Git；不得使用 `exec` 或 shell 字符串。

### 10.2 LOCAL 自动提交编排

LOCAL provider 内部执行：

1. IPC 获取本机受限 diff；
2. 调用后端 `/files/git-commit-message`；
3. IPC 执行本机提交；
4. 调用后端活动记录接口；
5. 返回统一结果。

若步骤 2 失败，不调用步骤 3。若步骤 3 在 add 后失败，保留暂存状态。

### 10.3 LOCAL 凭证

pull/push 直接继承 Electron 主进程可用的本机 Git 环境，支持用户已配置的：

- Git credential helper；
- SSH Agent；
- 系统密钥链；
- Git 配置中的其他本机认证方式。

设置 `GIT_TERMINAL_PROMPT=0`，避免无终端 IPC 请求挂起。认证缺失时在 60 秒内失败并提示用户在本机配置 Git 凭证。

## 11. 前端实现设计

### 11.1 GitChangeList

`GitChangeList.vue` 增加 props：

- `hasRemote`；
- `detachedHead`；
- `operation`；
- `operationLoading`。

增加 emits：

- `commit`；
- `pull`；
- `push`。

按钮只负责展示、禁用和触发，不直接调用 API。

### 11.2 TaskInspector

`TaskInspector.vue` 负责：

- 调用当前 `WorkspaceGitProvider`；
- 维护当前 UI 操作状态；
- 使用 `ElMessage` 展示成功和错误；
- 操作完成后调用现有 `refreshAll()`；
- 在多仓库模式下确保操作目标为当前 `selectedRepoPath`；
- 将主会话 ID而不是当前子会话 ID用于模型生成和活动记录。

前端按钮禁用只改善体验，不能替代服务端/Electron 的仓库锁和状态校验。

### 11.3 用户反馈

- 提交成功：展示短哈希和标题；
- 拉取成功：展示当前分支已更新；
- 推送成功：展示当前分支已推送；
- 远端无更新也视为成功并提示“已是最新状态”；
- 失败：展示经过分类的中文错误；
- stash 被保留：错误中必须展示 Mao stash 标识或可定位引用；
- 操作结束后停止按钮旋转，无论成功或失败都刷新 Git 状态。

## 12. 错误分类

至少识别并转换以下错误：

- 当前工作区不是 Git 仓库；
- 没有待提交变更；
- 提交信息生成超时或失败；
- 提交信息格式连续两次不合规；
- Git 操作进行中；
- Git index lock 被外部进程占用；
- 仓库没有 remote；
- detached HEAD 无法拉取或推送；
- 多 remote 且无 `origin`，无法自动选择 upstream；
- 认证失败或凭证缺失；
- 远端不可达或网络超时；
- push non-fast-forward；
- pull merge conflict；
- stash 创建失败；
- stash 恢复冲突或失败；
- Git 子进程 60 秒超时；
- 非法 `repoPath` 或越权会话。

错误转换不得把带凭证 URL 或进程环境输出给客户端。

## 13. 安全设计

1. 所有 Git 命令通过参数数组执行，禁止 shell 拼接；
2. CLOUD 接口先校验 `sessionId` 属于当前用户；
3. `repoPath` 继续只允许工作区一级子目录，并通过 `PathSandbox`；
4. LOCAL Electron 继续通过 `resolveRepoDir()` 限定目标目录；
5. 提交信息作为独立参数或临时文件传入，不参与命令解析；
6. 临时提交信息文件使用仅当前用户可读权限并在 `finally` 删除；
7. Token 仅进入受控进程环境和 askpass，不进入命令参数；
8. 模型输入在 LOCAL 端先过滤，后端再做结构和大小校验；
9. 敏感文件 diff 不进入模型、日志、活动或错误；
10. Git 输出设置字节上限，防止大输出占满内存；
11. 同一仓库写操作互斥；
12. 不支持 force push、reset hard 或自动冲突覆盖；
13. 活动记录接口字段使用枚举、长度限制和服务端生成时间；
14. LLM 用量表不保存 prompt 或 diff。

## 14. 性能与超时

- 模型输入文本 diff：最多 200 KB；
- 模型生成：60 秒；
- commit：60 秒；
- pull：60 秒；
- push：60 秒；
- Git stdout/stderr：沿用现有 2 MB 级总输出上限，错误响应进一步裁剪；
- 同一仓库不排队；
- 不同仓库可并行操作；
- 操作完成后只刷新仓库发现和当前仓库状态，不轮询操作进度。

## 15. 实现步骤

### 阶段一：公共类型和只读状态扩展

1. 扩展 Git 状态 DTO，返回 remote、upstream 和 detached HEAD；
2. 扩展 `types/git.ts`；
3. 扩展 `WorkspaceGitProvider`；
4. 确保单仓库和多仓库模式都能获得同一状态字段。

### 阶段二：提交信息生成服务

1. 新增固定敏感文件规则；
2. 实现公平截断的 200 KB diff 构建器，Java 和 Electron 使用同一组规则及测试样例；
3. 新增 `GitCommitMessageService`；
4. 实现主会话模型解析、非流式 LLM 调用、格式校验和一次纠错；
5. 新增统一 LLM 用量表、实体、Mapper、Service 和统计汇总；
6. 新增 LOCAL 生成接口。

### 阶段三：CLOUD 写操作

1. 新增仓库写锁；
2. 实现 commit；
3. 接入仅本次生效的 Mao 默认作者；
4. 实现自动 stash + merge pull + 精确恢复；
5. 实现普通 push 和 upstream 自动设置；
6. 接入 HTTPS Token askpass；
7. 写入脱敏活动记录；
8. 增加三个 REST 接口。

### 阶段四：LOCAL 写操作

1. 扩展 `gitStatus.cjs` 或拆出 Git 写操作模块；
2. 实现 Electron 仓库写锁；
3. 实现本地受限 diff 构建；
4. 实现 commit、pull、push；
5. 注册 IPC 并更新 preload 和类型；
6. 接入后端模型生成和活动记录。

### 阶段五：前端交互

1. 在 `GitChangeList.vue` 增加三个图标；
2. 实现 tooltip、ARIA、加载和禁用规则；
3. 在 `TaskInspector.vue` 接入统一 provider；
4. 实现成功/失败 toast；
5. 操作后刷新 Git 状态；
6. 验证窄屏和安卓布局不溢出。

### 阶段六：测试与发版说明

1. 增加后端单元测试；
2. 增加 Electron Git 模块测试；
3. 增加前端单元测试；
4. 执行后端测试和前端 build；
5. 更新根 `CHANGELOG.md` 当前版本的“后端”“前端（桌面 / Web / 安卓）”“桌面 Electron”；
6. 不自动重启 Mao 后端，由用户自行重启。

## 16. 测试方案

### 16.1 提交信息生成

- 普通多文件变更生成合法标题和列表正文；
- type/scope 英文，描述和正文中文；
- 标题无长度限制；
- 首次格式错误，第二次纠正成功；
- 两次格式错误后终止；
- 模型失败或 60 秒超时后不执行 add/commit；
- 敏感文件只进入元数据；
- 二进制文件只进入元数据；
- 超过 200 KB 时公平截断且保留全部文件元数据；
- 不包含聊天历史和 Git 历史；
- 两次模型调用均正确记录用量。

### 16.2 Commit

- 提交全部 tracked/untracked/staged/unstaged 变更；
- 无变更时拒绝且不调用模型；
- 已配置身份时沿用用户身份；
- 缺失身份时仅本次使用 `Mao Agent <mao@etarch.cn>`；
- 仓库 Git config 和 global config 不被修改；
- 验证 hooks 确实被 `--no-verify` 跳过；
- commit 失败后保留暂存状态；
- 生成期间新增文件会被最终 `add -A` 纳入；
- 返回短哈希和标题；
- detached HEAD 可以提交。

### 16.3 Pull

- 干净工作区普通 pull；
- 分叉时以 Git 默认信息创建 merge commit；
- 脏工作区自动 stash tracked 和 untracked；
- ignored 文件不进入 stash；
- pull 成功后精确恢复本次 stash；
- 非冲突失败后恢复 stash；
- pull 冲突时保留冲突现场和 Mao stash；
- stash pop 冲突时保留冲突状态和 stash；
- 60 秒超时后释放锁；
- detached HEAD 和无 remote 时拒绝。

### 16.4 Push

- upstream 已配置时普通 push；
- 无 upstream 且有 origin 时自动设置；
- 无 origin 且只有一个 remote 时自动设置；
- 无 origin 且多个 remote 时拒绝；
- 工作区有未提交变更时仍可推送已有提交；
- non-fast-forward 失败且不强推；
- detached HEAD 和无 remote 时拒绝；
- HTTPS Token 不出现在命令、日志和响应。

### 16.5 多仓库和并发

- 操作只作用于当前 `selectedRepoPath`；
- 非法、绝对、多级和越界 `repoPath` 被拒绝；
- 同一仓库并发操作立即拒绝；
- 不同仓库可并行；
- 主任务或边路任务运行时按钮仍可用；
- 子代理视图仍使用主会话模型。

### 16.6 前端

- 图标顺序为 Check、Download、Upload、Refresh；
- 每个按钮有 tooltip 和 aria-label；
- 无变更禁用提交；
- 无 remote 禁用拉取和推送；
- detached HEAD 仅提交可用；
- 仅当前操作按钮旋转；
- 不出现确认框、输入框和阶段文案；
- 提交成功提示包含短哈希和标题；
- 操作完成后刷新；
- 移动端宽度下工具栏不换行、不遮挡计数。

### 16.7 验证命令

```bash
cd backend && mvn test
cd desktop && npm run test:unit
cd desktop && npm run build
```

Electron Git 模块若采用 Node 内置测试框架，应增加对应 npm script 并纳入 `npm run test:unit` 或 CI 独立步骤。

## 17. 落地清单

### 后端

- [ ] 扩展 CLOUD Git 状态的 remote/upstream/detached 字段
- [ ] 新增 `GitCommitMessageService`
- [ ] 新增固定敏感文件识别与 200 KB diff 构建器
- [ ] 新增提交信息格式校验和一次纠错
- [ ] 新增 `V073__llm_usage.sql`
- [ ] 新增 LLM 用量实体、Mapper、Service 和统计汇总
- [ ] 新增仓库级写操作互斥锁
- [ ] 新增 CLOUD commit/pull/push 服务
- [ ] 为远程操作接入用户 HTTPS Token askpass
- [ ] 新增 Git 操作活动类型和脱敏记录
- [ ] 新增四个 Git REST 接口及 LOCAL 活动记录接口
- [ ] 增加服务与控制器测试

### 桌面 Electron

- [ ] 扩展本地 Git 状态字段
- [ ] 实现本地敏感过滤和受限 diff
- [ ] 实现本地仓库写锁
- [ ] 实现本地 commit/pull/push
- [ ] 实现精确 stash 恢复和冲突保留
- [ ] 新增 IPC handlers
- [ ] 更新 `preload.cjs`
- [ ] 更新 `electron.d.ts`
- [ ] 增加 Git 模块测试

### 前端（桌面/Web/安卓）

- [ ] 扩展 `types/git.ts`
- [ ] 扩展 `WorkspaceGitProvider`
- [ ] 实现 CLOUD provider
- [ ] 实现 LOCAL provider 编排
- [ ] 在 Git 工具栏增加 Check/Download/Upload
- [ ] 实现按钮禁用、加载、tooltip 和 ARIA
- [ ] 实现 toast 和操作后刷新
- [ ] 覆盖单仓库、多仓库和移动端布局测试

### 文档与发版

- [ ] 更新根 `CHANGELOG.md` 的“后端”
- [ ] 更新根 `CHANGELOG.md` 的“前端（桌面 / Web / 安卓）”
- [ ] 更新根 `CHANGELOG.md` 的“桌面 Electron”
- [ ] 执行后端测试、前端单测和构建
- [ ] 由用户自行重启后端服务

## 18. 验收标准

1. Git Tab 工具栏固定展示提交、拉取、推送、刷新四个图标，移动端不溢出；
2. CLOUD 与 LOCAL 均能完成三个操作；
3. 点击提交后无需输入或确认，AI 成功生成信息后直接提交全部当前变更；
4. 提交信息符合 Conventional Commits 中文标题加列表正文；
5. 敏感文件和二进制内容不会发送给模型；
6. LOCAL 上传模型输入不超过 200 KB 文本 diff，且不包含敏感内容；
7. 生成失败或格式两次不合规时不执行 add/commit；
8. 提交执行 `--no-verify`，缺失作者时仅本次注入 Mao 默认身份；
9. pull 对脏工作区自动 stash tracked/untracked，按既定冲突策略恢复或保留；
10. push 无 upstream 时按 origin 优先规则自动建立，永不强推；
11. 同一仓库写操作互斥，所有操作 60 秒超时；
12. 操作结果写入脱敏活动记录，模型用量写入统一用量表；
13. 不写入聊天消息，不改变 Agent 会话上下文；
14. 所有路径、会话归属和命令参数均通过安全校验；
15. 后端测试、前端单测和前端构建通过。
