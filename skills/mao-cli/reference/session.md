# 会话模块（session）

## 模块职责

管理会话**元数据**：创建 LOCAL/CLOUD 会话、查询、分组分页、更新标题/摘要/权限/模型、置顶/收藏/归档/已读、看板、云端项目、边路任务与子智能体列表。管理员检索全站会话见 [admin-session.md](admin-session.md)。

## 明确不包含

不提供发送消息、queue 写操作、edit_and_resend、WebSocket 运行。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列表 | `session list` |
| 分组预览 | `session groups` |
| 分组分页 | `session list --group-key ...` |
| 详情 | `session get` |
| 创建 | `session create` |
| 更新元数据 | `session update` |
| 删除 | `session delete` |
| 标记已读 | `session mark-read` |
| 切换置顶 | `session pin` |
| 切换收藏 | `session favorite` |
| 归档 | `session archive` |
| 看板 | `session dashboard` |
| 云端项目列表 | `session cloud-projects` |
| 边路任务 | `session side-tasks` |
| 子智能体 | `session subagents` |

---

## 命令：mao session list

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 标题等关键词 → `keyword` |
| `--status` | 否 | 字符串 | 会话状态过滤 → `status` |
| `--group-key` | 否 | 字符串 | 分组 key；提供后返回该分组分页 |
| `--offset` | 否 | 数字 | 分组分页偏移，仅 `--group-key` 时有效 |
| `--limit` | 否 | 数字 | 分组分页条数，仅 `--group-key` 时有效 |

### 示例

```bash
mao session list --keyword 重构 --json
mao session list --group-key project:demo --offset 0 --limit 20
```

---

## 命令：mao session groups

### 用途

获取桌面端任务侧栏使用的会话分组预览。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 标题等关键词 |
| `--status` | 否 | 字符串 | 会话状态过滤 |
| `--preview-limit` | 否 | 数字 | 每组预览条数，服务端默认 5 |

### 示例

```bash
mao session groups --preview-limit 8 --json
```

---

## 命令：mao session get

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session get --id 12
```

---

## 命令：mao session create

### 用途

创建会话。`executionMode` 决定工作区参数约束。

### 参数说明

| 参数 | 必填 | 类型 | 取值/格式 | 含义 |
|------|------|------|-----------|------|
| `--agent-id` | 是 | 数字 | — | Agent ID → `agentId` |
| `--execution-mode` | 是 | 字符串 | `LOCAL` \| `CLOUD` | 执行模式 → `executionMode` |
| `--title` | 否 | 字符串 | — | 标题 → `title` |
| `--workspace` | 条件必填 | 字符串 | 本地绝对路径 | LOCAL 必填工作区路径 → `workspace` |
| `--permission-level` | 否 | 字符串 | `READ_ONLY` \| `READ_WRITE` \| `SMART` \| `FULL` | 权限级别 → `permissionLevel` |
| `--model-id` | 否 | 数字 | 模型主键 | → `modelId` |
| `--workspace-mode` | 条件必填 | 字符串 | `new` \| `existing` \| `git` | CLOUD 必填 → `workspaceMode` |
| `--cloud-project-key` | 条件必填 | 字符串 | — | `existing` 时必填 → `cloudProjectKey` |
| `--git-clone-url` | 条件必填 | 字符串 | Git URL | `git` 时必填 → `gitCloneUrl` |
| `--git-branch` | 否 | 字符串 | — | Git 分支 → `gitBranch` |
| `--is-git` | 否 | 布尔 | `true/false` | 是否 Git 仓库 → `isGit` |
| `--platform` | 否 | 字符串 | — | 客户端平台 → `platform` |
| `--shell` | 否 | 字符串 | — | Shell 路径 → `shell` |
| `--os-version` | 否 | 字符串 | — | 系统版本 → `osVersion` |

### 参数约束

- `LOCAL`：必须 `--workspace`
- `CLOUD`：必须 `--workspace-mode`
  - `existing` → 必须 `--cloud-project-key`（可先 `session cloud-projects`）
  - `git` → 必须 `--git-clone-url`
  - `new` → 新建云端项目，无需上述两项

### 示例

```bash
# LOCAL
mao session create --agent-id 1 --execution-mode LOCAL --workspace /Users/me/proj --permission-level READ_WRITE

# CLOUD existing
mao session create --agent-id 1 --execution-mode CLOUD --workspace-mode existing --cloud-project-key demo

# CLOUD git
mao session create --agent-id 1 --execution-mode CLOUD --workspace-mode git \
  --git-clone-url https://git.example.com/a/b.git --git-branch main
```

---

## 命令：mao session update

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |
| `--title` | 否 | 字符串 | 新标题 |
| `--summary` | 否 | 字符串 | 摘要 |
| `--project-key` | 否 | 字符串 | 项目 key → `projectKey` |
| `--permission-level` | 否 | 字符串 | 权限级别枚举同上 |
| `--model-id` | 否 | 数字 | 模型主键 |

至少提供一个可选更新字段。

### 示例

```bash
mao session update --id 12 --title '新标题' --permission-level SMART
```

---

## 命令：mao session delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session delete --id 12
```

---

## 命令：mao session mark-read / pin / favorite / archive

### 用途

- `mark-read`：标记已读（`PUT /sessions/{id}/read`）
- `pin`：切换置顶（`PUT /sessions/{id}/pin`）
- `favorite`：切换收藏（`PUT /sessions/{id}/favorite`）
- `archive`：归档（`PUT /sessions/{id}/archive`）

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 会话 ID |

### 示例

```bash
mao session pin --id 12
mao session favorite --id 12
mao session archive --id 12
mao session mark-read --id 12
```

---

## 命令：mao session dashboard

### 用途

获取看板分组会话，通常含 `running` 与 `recent`。

### 参数说明

无。

### 示例

```bash
mao session dashboard --json
```

---

## 命令：mao session cloud-projects

### 用途

列出当前用户云端项目目录，供 `workspace-mode=existing` 使用。

### 返回结果

数组元素：`name`、`path`、`git`（是否含 `.git`）。

### 示例

```bash
mao session cloud-projects
```

---

## 命令：mao session side-tasks

### 用途

列出某父会话下的并行子任务会话摘要。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 父会话 ID |

### 返回结果

元素含 `id`、`title`、`modelId`、`phase`、`createdAt`。

### 示例

```bash
mao session side-tasks --id 12
```

---

## 命令：mao session subagents

### 用途

列出某父会话下由 `delegate` 产生的子智能体会话摘要与执行审计信息。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 父会话 ID |

### 返回结果

元素含 `id`、`title`、`phase`、`createdAt`、`agentType`、`taskDescription`。

### 示例

```bash
mao session subagents --id 12 --json
```
