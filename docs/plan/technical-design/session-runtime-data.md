# 会话运行时数据目录（Session Runtime）技术方案

> 版本：v1.0 | 日期：2026-07-06 | 状态：已实现

## 1. 背景与问题

### 1.1 现状

当前平台在**用户工作区**（`Session.workspace` 指向的项目目录）内写入隐藏目录 `.mao/`，主要包括：

| 子目录 / 文件 | 写入方 | 用途 |
|--------------|--------|------|
| `.mao/skills/` | `SkillSyncService`（CLOUD）、Electron `skill-sync`（LOCAL） | Agent 技能同步副本，供 `read_file` 读取 `SKILL.md` |
| `.mao/shellOutput/` | `ShellSessionManager`（CLOUD）、Electron shell 工具（LOCAL） | Shell 超长输出落盘 |
| `.mao/git-askpass.sh` | `ShellSessionManager`（CLOUD，有 Git 凭证时） | Git HTTPS 认证辅助脚本 |

相关代码：

- `backend/.../harness/skill/SkillSyncService.java` — `SKILLS_DIR_NAME = ".mao/skills"`
- `backend/.../harness/shell/ShellSessionManager.java` — `OUTPUT_DIR = ".mao/shellOutput"`
- `backend/.../harness/core/PromptEngine.java` — Prompt 注入 `.mao/skills/...` 相对路径
- `desktop/electron/main.cjs` — LOCAL 模式 skill 解压与 shell 输出落盘

### 1.2 问题

1. **污染用户项目**：LOCAL 模式下工作区往往是真实 Git 仓库，`.mao` 会出现在文件树中，可能被 `git status` 看到。
2. **职责混淆**：Skills 源文件已在 `${app.root-dir}/data/skills` 与 `${app.root-dir}/data/userskills` 维护；工作区内的 `.mao/skills` 只是运行时副本，不应与项目代码混放。
3. **与平台数据目录不一致**：日志、上传、工作区根目录等已统一在 `app.root-dir`（默认 `/opt/mao` 或 `~/.mao`）下分层，`.mao` 进项目目录是历史遗留设计。

### 1.3 目标

将 **skills 同步副本、shell 输出、git-askpass 脚本** 从用户工作区迁出，放入按**会话**隔离的平台运行时目录（Session Runtime），使用户项目目录只保留业务代码。

---

## 2. 核心设计

### 2.1 隔离粒度：按会话（session.id）

本方案中的「工作区」在隔离语义上指**会话**，即使用 `Session.id` 作为 runtime 路径的关键段。

- 每个会话拥有独立的 `skills/`、`shellOutput/` 目录。
- 同一云端共享项目（`projects/{slug}`）下的多个会话，各自维护一份 skills 副本（接受一定磁盘冗余，换取实现简单与会话级隔离）。
- 子会话（`SUBAGENT`、`SIDE_TASK`）使用**自身**的 `session.id`，不复用父会话 runtime。

### 2.2 Skills 的管理维度 vs 运行维度

| 维度 | 说明 |
|------|------|
| **管理维护** | 按 Agent 配置（`agent.skillNames`）+ 用户个人 Skills（`user-skills-dir`） |
| **运行隔离** | 按会话：同步结果写入该会话的 runtime 目录；换 Agent 时通过移除逻辑清理不再需要的 skill |

同步状态键由 `agentId:workspace`（绝对路径）改为 **`agentId:sessionId`**。

### 2.3 目录布局

#### CLOUD（服务端）

```text
${app.harness.runtime-dir}/{userId}/{sessionId}/
├── skills/
│   ├── {skillName}/
│   │   └── SKILL.md
│   └── .sync-manifest.json
├── shellOutput/
│   └── {shellSessionId}_{seq}.out
└── git-askpass.sh          # 按需生成
```

示例：

```text
/opt/mao/data/runtime/1/123/skills/bigdata-cli/SKILL.md
/opt/mao/data/runtime/1/123/shellOutput/sh-123-1700000000000_1.out
/opt/mao/data/runtime/1/123/git-askpass.sh
```

#### LOCAL（桌面端 Electron）

固定根目录，**不做可配置项**：

```text
~/.mao/runtime/{sessionId}/
├── skills/
├── shellOutput/
└── git-askpass.sh          # 若 LOCAL 后续支持 Git 凭证则同理
```

示例：

```text
~/.mao/runtime/123/skills/bigdata-cli/SKILL.md
~/.mao/runtime/123/shellOutput/sh-123-1700000000000_1.out
```

> LOCAL 路径不含 `userId` 前缀：桌面端默认单 OS 用户，与 `~/.mao/logs` 等现有约定一致。

### 2.4 与用户工作区的关系

```text
Session.workspace          → 用户项目目录（代码、Git 仓库），工具 cwd 仍在此
Session Runtime（本方案）  → 平台内部数据，按 session.id 隔离，不在项目树内

CLOUD 示例：
  workspace:  /opt/mao/data/workspace/1/projects/my-app
  runtime:    /opt/mao/data/runtime/1/123/

LOCAL 示例：
  workspace:  /Users/dev/my-repo
  runtime:    ~/.mao/runtime/123/
```

---

## 3. 配置

### 3.1 新增配置项（仅服务端）

```yaml
app:
  harness:
    runtime-dir: ${RUNTIME_DIR:${app.root-dir}/data/runtime}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `app.harness.runtime-dir` | `${app.root-dir}/data/runtime` | CLOUD 模式会话运行时数据根目录 |

LOCAL 端固定为 `path.join(os.homedir(), '.mao', 'runtime')`，不读取 Spring 配置。

### 3.2 与现有目录的关系

```text
${app.root-dir}/
├── data/
│   ├── workspace/      # 用户项目文件（已有）
│   ├── skills/         # 系统 Skills 源（已有）
│   ├── userskills/     # 用户 Skills 源（已有）
│   ├── uploads/        # 上传文件（已有）
│   └── runtime/        # 本会话运行时数据（新增）
└── logs/
```

---

## 4. 路径解析与访问控制

### 4.1 RuntimeDataResolver（新增）

统一封装 runtime 路径计算，供 `SkillSyncService`、`ShellSessionManager`、`PromptEngine` 等调用：

```java
public final class RuntimeDataResolver {

    /** CLOUD: {runtime-dir}/{userId}/{sessionId} */
    public Path resolveSessionRuntimeDir(Long userId, Long sessionId);

    public Path resolveSkillsDir(Long userId, Long sessionId);
    public Path resolveShellOutputDir(Long userId, Long sessionId);
    public Path resolveGitAskpassScript(Long userId, Long sessionId);

    /** LOCAL Prompt 用：~/.mao/runtime/{sessionId}/skills/... */
    public String formatLocalSkillsPath(Long sessionId, String skillName);

    /** CLOUD Prompt 用：绝对路径 */
    public String formatCloudSkillsPath(Long userId, Long sessionId, String skillName);
}
```

Electron 侧实现等价函数（`resolveLocalRuntimeDir(sessionId)` 等）。

### 4.2 PathSandbox 扩展

runtime 目录在用户工作区**之外**，`read_file` / `write_file` 等工具需能访问：

1. 会话开始或首次写入 runtime 时，对该会话的 runtime 根目录调用 `pathSandbox.addAllowedRoot(runtimeDir)`。
2. `resolve()` 对已注册的 `allowedRoots` 保持现有放行逻辑。

### 4.3 Prompt 路径策略

| 模式 | Prompt 中 skills 路径格式 | 说明 |
|------|---------------------------|------|
| **CLOUD** | 服务端绝对路径 | 例：`/opt/mao/data/runtime/1/123/skills/foo/SKILL.md` |
| **LOCAL** | `~` 前缀路径 | 例：`~/.mao/runtime/123/skills/foo/SKILL.md`；Electron `read_file` 须展开 `~` |

Shell 截断返回的 `output_file` 与上述规则一致：

- CLOUD：服务端绝对路径
- LOCAL：`~/.mao/runtime/{sessionId}/shellOutput/{file}`

> LOCAL 不使用服务端绝对路径的原因：Prompt 在服务端生成，无法获知客户端 OS 用户名与家目录。

### 4.4 read_file 工具变更

**服务端（CLOUD）**

- `ReadFileTool` 在 `pathSandbox.resolve()` 前，对以 `~` 开头的路径不做处理（仅 LOCAL 委托场景不涉及服务端读文件）。
- 绝对路径落在已注册的 runtime `allowedRoot` 内则允许读取。

**客户端（LOCAL）**

- `resolveWorkspacePath()` 或 read 工具入口：若路径以 `~` 开头，替换为 `os.homedir()` 后再访问。
- 绝对路径若落在 `~/.mao/runtime/{sessionId}/` 下则允许（不再要求位于 `Session.workspace` 内）。

---

## 5. 各模块改造要点

### 5.1 SkillSyncService

| 项目 | 改前 | 改后 |
|------|------|------|
| 同步目标 | `{workspace}/.mao/skills/` | `{runtime-dir}/{userId}/{sessionId}/skills/` |
| 方法签名 | `syncToWorkspace(agent, workspace, userId)` | 增加 `sessionId` 参数，或传入 `Session` 对象 |
| 状态键 | `agentId:workspace` | `agentId:sessionId` |
| `cleanWorkspace` | 删除工作区内 `.mao/skills` | 重命名为 `cleanSessionRuntime(sessionId)` 或暂不实现（见 §7） |

LOCAL 模式仍通过 `writeSyncZip` 打包；Electron 解压目标改为 `~/.mao/runtime/{sessionId}/skills/`。

### 5.2 ShellSessionManager

| 项目 | 改前 | 改后 |
|------|------|------|
| 输出目录 | `{workspace}/.mao/shellOutput/` | `{runtime-dir}/{userId}/{sessionId}/shellOutput/` |
| git-askpass | `{workspace}/.mao/git-askpass.sh` | `{runtime-dir}/{userId}/{sessionId}/git-askpass.sh` |
| Shell cwd | `Session.workspace` | **不变**，仍在用户项目目录执行命令 |

`createSession` 需增加 `userId`、`sessionId` 参数以定位 runtime 目录。

### 5.3 PromptEngine

- 删除「技能会同步到工作区的 `.mao/skills/`」表述。
- `buildRelativeSkillCatalog` 改为 `buildSkillCatalog`，按执行模式注入绝对路径或 `~` 路径（见 §4.3）。
- 需从 `AgentExecutionContext` 获取 `sessionId`、`userId`、`executionMode`。

### 5.4 StreamingWsHandler

skill 同步调用处传入 `session.getId()`；LOCAL 的 `skill_sync_required` 事件需让客户端知晓 `sessionId`（通常 WS 已绑定 session，IPC 沿用现有 `sessionId` 参数）。

### 5.5 desktop/electron/main.cjs

| 位置 | 改动 |
|------|------|
| `skill-sync` IPC | 解压到 `~/.mao/runtime/{sessionId}/skills/` |
| `truncateAndSave` | 输出写入 `~/.mao/runtime/{sessionId}/shellOutput/` |
| `read_file` 等工具 | 支持 `~` 展开与 runtime 绝对路径 |

### 5.6 配置示例文件

在 `application-example.yml`、`application-acg.yml` 等 profile 中补充：

```yaml
app:
  harness:
    runtime-dir: ${RUNTIME_DIR:${app.root-dir}/data/runtime}
```

---

## 6. 数据流示意

### 6.1 CLOUD — Skills 同步

```text
用户发送消息
  → StreamingWsHandler
    → skillSyncService.syncToSession(agent, userId, sessionId)
      → 拷贝到 /opt/mao/data/runtime/{userId}/{sessionId}/skills/
      → pathSandbox.addAllowedRoot(runtimeDir)
    → PromptEngine 注入 /opt/mao/data/runtime/.../SKILL.md
    → Agent 调用 read_file(绝对路径) → PathSandbox 放行
```

### 6.2 LOCAL — Skills 同步

```text
用户发送消息
  → StreamingWsHandler 触发 skill_sync_required
    → Electron skill-sync(sessionId, ...)
      → 下载 zip → 解压到 ~/.mao/runtime/{sessionId}/skills/
    → PromptEngine 注入 ~/.mao/runtime/{sessionId}/skills/.../SKILL.md
    → Agent 调用 read_file → Electron 展开 ~ 后读取
```

### 6.3 Shell 输出落盘

```text
Shell 命令输出超长
  → 预览 + truncated: true
  → output_file: {runtime}/shellOutput/{shellSessionId}_{seq}.out
  → Agent 可用 read_file 读取完整输出
```

---

## 7. 范围外（本期不做）

| 项 | 说明 |
|----|------|
| **runtime 目录清理** | 会话删除或归档时不级联删除 runtime；后续可加 TTL 或手动清理 |
| **历史 `.mao` 迁移** | 不自动搬迁工作区内已有 `.mao`；新会话走新路径，旧目录可手动删除 |
| **LOCAL git-askpass** | 若 LOCAL 尚无 Git 凭证注入，本期可不改；架构上预留同路径 |

---

## 8. 实现清单

| 序号 | 任务 | 文件 / 模块 |
|------|------|-------------|
| 1 | 新增 `RuntimeDataResolver` | `backend/.../harness/runtime/` |
| 2 | 配置项 `app.harness.runtime-dir` | `application-*.yml` |
| 3 | 改造 Skill 同步与状态键 | `SkillSyncService` |
| 4 | 改造 Shell 输出与 git-askpass | `ShellSessionManager` |
| 5 | 改造 Prompt 技能路径 | `PromptEngine`、`AgentExecutionContext` |
| 6 | 注册 runtime allowedRoot | `StreamingWsHandler` 或会话执行入口 |
| 7 | PathSandbox / ReadFile 绝对路径 | `PathSandbox`、`ReadFileTool` |
| 8 | Electron runtime 路径与 `~` 展开 | `desktop/electron/main.cjs` |
| 9 | 更新相关设计文档交叉引用 | `skill-workspace-sync.md` 等（注明被本方案替代） |

---

## 9. 风险与注意事项

| 风险 | 缓解 |
|------|------|
| 同项目多会话重复同步 Skills | 接受冗余；后续可按需做共享缓存 |
| LOCAL `~` 路径在 Prompt 中不够「绝对」 | 文档与工具层统一约定；Electron 必须实现 `~` 展开 |
| 子会话 runtime 独立 | 子 Agent 需单独 skill 同步；与现有子会话模型一致 |
| 工作区文件浏览器不展示 skills | 预期行为；skills 非项目文件 |

---

## 10. 相关文档

- [Skills 工作区同步方案](./skill-workspace-sync.md) — 旧方案（`.skills/` / `.mao/skills` 在工作区内），**由本文档替代**；其第 11 节记录了下方「本地未同步 Skill」的详细实现
- [Shell 会话系统技术方案](../shell-session-design.md) — shellOutput 落盘机制
- [用户 Git 凭证设计](../design/user-git-credential-design.md) — git-askpass 脚本（路径将迁至 runtime）
- [云端模式可选工作区](../cloud-workspace-project-design.md) — `Session.workspace` 与项目共享

---

## 11. 后续演进：LOCAL 模式本地未同步 Skill

在上述 runtime 目录方案基础上，LOCAL 模式进一步支持**无需同步/上传**即可使用桌面端本地 Skill：

- 桌面端「技能管理」抽屉扫描到的 `~/.agents/skills` 下未上传 Skill，会在 LOCAL 模式发送消息时随 WS 消息一并上报（`LocalSkillRegistry`，内存态、按 `sessionId`）。
- `PromptEngine` 为这些 Skill 注入桌面端本机路径（`~/.agents/skills/{folderName}/SKILL.md`），而非本节的 runtime 副本路径；`read_file` 由 `LocalToolExecutor` 委托 Electron 直接读取本机文件，不经过 `SkillSyncService` 的 CLOUD 拷贝 / LOCAL zip 下发流程。
- CLOUD 模式不受影响：仍要求 Skill 已上传（写入 `user-skills-dir`）才能参与 `SkillSyncService.syncToSession`。

详见 [Skills 工作区同步方案 §11](./skill-workspace-sync.md#11-local-模式本地未上传-skill-直接可用无需上传)。
