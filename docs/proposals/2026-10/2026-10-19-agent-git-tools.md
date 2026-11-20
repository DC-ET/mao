# 提案：Agent 结构化 Git 工具链 —— 把人用的 Git 面板能力，开放给干活的那个 Agent

- 状态：**已否决**（2026-10-19 评审：不做，存档勿再评审）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

今天平台上有两套 Git 能力，一套给人用，一套给 Agent 用，中间隔着一堵墙：

**人的一侧已经很完整。** `backend-ts/src/file/` 域有一套成熟的 Git 服务层，桌面端「任务」面板的 Git Tab（`desktop/src/components/task/TaskInspector.vue` 的 GitChangeList）经 `/v1/files/workspace-git-*` 路由（`backend-ts/src/file/file.routes.ts:192-219`）消费它：

- `WorkspaceGitService`（`workspace-git.service.ts`）：多仓库发现（`listRepos`）、结构化状态（`getStatus`：分支 / ahead-behind / 变更文件及增删行）、单文件 diff（`getFileDiff`）。
- `GitWriteOperationService`（`git-write-operation.service.ts`）：commit / pull / push / refresh，带**按仓库互斥锁**（`withRepoLock`）、Git 凭据注入（`credentialEnv`，经 `GitCredentialLookup`）、敏感文件过滤（`SENSITIVE_NAME`）、凭据 URL 清洗（`CREDENTIAL_URL`）、操作留痕（`recordLocalActivity` → 活动流）。
- `GitCommitMessageService`（`git-commit-message.service.ts`）：基于 staged diff 的 LLM 提交信息生成，走 `LlmCallScene.git_commit_message` 单独计量（`shared/contracts/src/usage.ts:20`）。

**Agent 一侧是零。** `createDefaultToolRegistry`（`harness/tool/tool-registry.ts`）注册的 35 个内置工具里没有一个与 Git 相关；harness 与 agent-cli 全仓对 `git_status|git_diff|git_commit` 零命中。Agent 要操作版本库只有一条路：`shell` 工具裸跑 `git` 命令字符串。后果：

1. **输出是非结构化文本**。`git status --porcelain` 的解析全凭模型自觉，错一个空格就误判；桌面端给人看的结构化状态/diff，Agent 拿不到。
2. **没有安全边界**。shell 里的 `git push --force`、`git reset --hard` 与 `ls` 走同一条审批通道（`SHELL_PREFIX` 规则前缀匹配），git 写操作没有自己的规则类型与审计口径；凭据虽经 `GitCredentialLookup` 注入环境变量，但 shell 输出里 `echo $GIT_TOKEN_xxx` 即可回显，工具层无清洗。
3. **平台自相矛盾的三个信号**：`LlmCallScene` 为「生成提交信息」单设了计量场景；`reviewer` 子代理的定位是「只读检查未提交改动」（`harness/delegate/agent-definition-registry.ts:74-77`）却只能用 shell 拼 `git diff`；桌面端人点一下「提交」就有 LLM 起草 + 留痕，Agent 改完代码却要模型自己 `git commit -m "..."` 手打。

对一个以「工作区即上下文」为核心形态的 Agent 平台，**干活的角色没有称手的工具，看着干的角色工具齐全**——这是当前最重的一块能力短板。

相邻方向的边界：

- **不是替代桌面 Git 面板**：两端消费同一套 file 域服务，本提案只加「Agent 侧工具入口」，不改人的界面与路由。
- **不是 GitHub/GitLab 集成**（PR / Issue / Review 评论）：P1 只做本地版本库操作；托管平台 API 类工具列为开放问题，不在本提案范围内。
- **不是分支管理套件**：create/switch/merge/rebase 这类结构性操作 P1 不做（见非目标），shell 仍是逃生门。
- **不是代码审查产品**：reviewer 子代理的职责不变，只是把它的「眼睛」从 shell 换成结构化工具。

## 2. 目标 / 非目标

**目标**

1. **只读双工具（P1）**：`git_status`（当前分支、ahead/behind、变更文件列表含增删行与变更类型）与 `git_diff`（指定文件或全量 diff，带大小截断），参数支持多仓库工作区的 `repo_path` 选择。零审批、零写操作，模型可自由调用。
2. **写操作三工具（P2）**：`git_commit`（暂存并提交；提交信息可由模型提供，或触发现有 `GitCommitMessageService` 生成）、`git_pull`、`git_push`。三者一律走工具审批门（LOCAL 会话按权限级；CLOUD 会话按现有工具审批策略），复用 `GitWriteOperationService` 的仓库锁、凭据注入、活动留痕——**不新写一行 git 进程逻辑**。
3. **reviewer 子代理换装**：`reviewer` 角色的 systemPromptOverride 改为优先使用 `git_status` / `git_diff` 做「未提交改动审查」，shell 仅作兜底；审查结论的文件定位直接来自结构化输出。
4. **全链路可观测（按仓库规范）**：新工具同步补齐 `harness/tool/impl/` 实现、`backend-ts/src/session/util/tool-result-summarizer.ts` 结果摘要、`desktop/src/utils/toolDisplay.ts` 中文名与参数预览、成功/失败/缺参回归测试——不重蹈「只注册不展示」的覆辙。
5. **输出脱敏**：工具结果统一经既有清洗口径（禁绝 `GIT_TOKEN_*` 环境变量值、remote URL 内嵌凭据回显），与 `GitWriteOperationService` 的 `CREDENTIAL_URL` 清洗对齐。

**非目标**

- 不做分支 / 标签 / 暂存区细粒度操作（`git add <file>` 选择性暂存、`git checkout -b`、`git merge`、`git rebase`、`git stash`）——P1/P2 的 commit 是 stage-all 语义，细粒度暂存继续用 shell。
- 不做 git 历史检索工具（`git log` 查询）——轨迹与消息已覆盖「过去发生了什么」。
- 不做托管平台集成（建 PR、查 CI、贴 Review 评论）——列为 P3 开放问题。
- 不改桌面端 Git 面板的行为与路由——它已是这些服务的正当消费者。
- 不做 `--force` 类危险操作（force push、reset --hard、clean -fd）——明确不在工具面内，模型需要时应引导用户人工执行。

## 3. 方案要点

### 3.1 工具形态与依赖注入

新增 `harness/tool/impl/git-tools.ts`，工具经 `harness/deps.ts` 既有依赖通道构造（该模式已被 `scheduled-task-tools.ts` 使用：构造参数直接注入领域服务）。依赖：

- `WorkspaceGitService` / `GitWriteOperationService` / `GitCommitMessageService`（file 域，纯复用）。harness → file 域的依赖已存在先例（`harness/shell/shell-session-manager.ts:7` 与 `harness/terminal/terminal-manager.ts:6` 均 import `git-write-operation.service.ts` 的 `ASKPASS`），不构成新的反向依赖。
- 工具执行走 `BaseTool.executeWithSession(argumentsJson, sessionId, workspace)`（`harness/tool/tool.ts:71`）拿会话上下文；file 域服务签名要的是 `Session`，经 deps 里的 `SessionService` 按 sessionId 装载（与 `scheduled-task-tools` 取会话同款）。**待确认点**：file 域服务目前只被 HTTP 请求上下文驱动，装载的 `Session` 行需包含 workspace / executionMode / git 凭据解析所需字段——预评时跑通一条 CLOUD 只读路径即可验证。

### 3.2 审批与权限

- `git_status` / `git_diff`：只读，免审（对齐 `read_file` / `grep_search`）。
- `git_commit` / `git_pull` / `git_push`：写操作，走 `ToolDispatcher` 既有审批判定；LOCAL 会话按 READ_ONLY/READ_WRITE/SMART 权限级分流（对齐 MCP 工作集只读注解免审的新口径，`harness/tool/tool-dispatcher` 附近）。
- 审批规则域（`approval-rule`）现支持 `SHELL_PREFIX|SHELL_EXACT|MCP_TOOL` 三类；本提案 P3 评估新增 `GIT_OP` 类型（按 `git_push` 等操作名 + 仓库匹配），P1/P2 阶段 git 写操作按「默认需批、无规则匹配」处理，不阻塞主路径。

### 3.3 多仓库与参数

工作区可能是多仓库（`listRepos` 已支持）。工具参数统一为 `repo_path?: string`（省略时：仅一个仓库则用唯一仓库，多个仓库时返回错误并要求模型指定——把选择权显式化，避免猜错仓库提交）。

### 3.4 提交信息生成（P2）

`git_commit` 提供两种模式：模型在参数里直接给 `message`；或省略 `message` 由后端调 `GitCommitMessageService` 生成（`scene=git_commit_message` 计量照常）。生成结果在审批弹窗中展示给用户确认后再执行——与人点「提交」时看到的 LLM 起草体验一致。

### 3.5 结果结构与截断

- `git_status`：`{ branch, ahead, behind, repos?, changes: [{ path, status, additions, deletions }] }`（直接映射 `GitStatusDTO` / `GitChangedFileDTO`，不发明新结构）。
- `git_diff`：`{ repo, files: [{ path, diff }] , truncated }`，diff 总字符超限（对齐 `GitCommitMessageService.MAX_DIFF_BYTES` 的量级）时截断并标 `truncated`，提示模型改用 `read_file` 看全文。
- 失败路径统一 `{ error }` 形态（对齐 `normalizeToolResult` 的 error 判定，`harness/tool/tool-result.ts`），使失败在摘要/轨迹里可见（对齐 0.0.308 起的「工具结果摘要可见失败态」口径）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | `git_status` + `git_diff` 只读工具（多仓库选择、截断、脱敏）+ reviewer 角色提示词换装 + summarizer/toolDisplay/回归测试 | 中 |
| P2 | `git_commit`（LLM 起草模式 + 审批确认）+ `git_pull` / `git_push`（审批门）+ 活动留痕复用 | 中 |
| P3 | `GIT_OP` 审批规则类型 + 管理后台「Agent git 操作」统计（复用运行轨迹聚合模式）+ 托管平台集成评估（开放问题） | 小~中 |

## 5. 风险与开放问题

- **写操作安全**：commit/push 会改变远端状态。缓解：一律审批；复用 `GitWriteOperationService` 的仓库锁与凭据注入；不做 force 语义；审批弹窗展示完整提交信息与变更文件清单（不展示 diff 全文，避免弹窗过载——开放问题：大变更是否给「查看 diff」二级入口）。
- **LOCAL 模式的执行位置**：CLOUD 会话 git 操作在服务端工作区执行，天然复用 file 域服务；LOCAL 会话的工作区在桌面本机，工具需经 WS 委托桌面执行（对齐 `LocalToolExecutor` 的 MCP 委托模式）。**这是本提案最大的技术不确定点**——P1 只读工具可先只在 CLOUD 会话注册（LOCAL 会话继续用 shell），P2 再评估 LOCAL 委托；若委托复杂，LOCAL 保持 shell 兜底也是可接受的降级（桌面端人本来就有 Git 面板）。
- **diff 体积**：大仓库全量 diff 可达数 MB。缓解：默认只给未提交变更的文件清单 + 统计，模型按需取单文件 diff；总量截断 + `truncated` 标记。
- **前缀缓存稳定性**：内置工具清单是 prompt 前缀的一部分（`prompt-prefix-monitor` 按 tools hash 观测）。新增 5 个工具会导致一次全局前缀指纹变化（一次性成本，之后稳定）；工具描述文案定稿后不再频繁改动。
- **凭据泄露面**：shell 时代 `echo $GIT_TOKEN_x` 可回显凭据，工具化后模型仍可能用 shell 探测。缓解：工具结果清洗只治标；`GIT_TOKEN_*` 注入范围收窄到 git 子进程（`ASKPASS` 机制本就是为这个设计的）列为安全评审项。
- **开放问题**：是否需要「提交后自动 push」的复合参数——建议不做，保持原子操作，模型可连续调用两次。
- **开放问题**：子代理（worker）默认给 git 写工具还是只读？建议与主代理一致（走审批），不额外收权，避免 worker 改完代码无法自提交。

## 6. 测试要点

- 工具面：`git_status` 单/多仓库（省略 repo_path 的行为）、detached HEAD、无仓库工作区报错；`git_diff` 单文件 / 全量、超限截断、二进制文件、重命名文件（对齐 `workspace-git-rename-numstat` 既有口径）。
- 写操作：commit 成功路径（message 直给 / LLM 生成两条路）、无变更时 commit 报错、pull/push 的 behind/ahead 边界、并发双工具同仓库互斥（仓库锁生效）；审批门在 READ_ONLY / READ_WRITE / SMART 三档下的放行/拦截矩阵。
- 脱敏：含内嵌凭据的 remote URL、`GIT_TOKEN_*` 字样不出现在工具结果与轨迹里。
- 展示链路：summarizer 摘要（成功显示「提交 abc1234: xxx」/ 失败显示 error）、toolDisplay 中文名与参数预览、桌面工具卡片渲染。
- 回归：shell 工具的 git 用法不受影响；`llm_call` 计量新增 `git_commit_message` 场景的调用被正确归因；运行轨迹中 git 工具调用可正常聚合。
- reviewer 子代理：提示词换装后对同一未提交改动的审查结论质量不劣于 shell 版（可用既有 spec  fixtures 对比）。
