# 云端模式可选工作区（项目空间）设计方案

> 版本：v1.0 | 日期：2026-07-01 | 状态：待评审

## 1. 背景与问题

### 1.1 现状

| 执行模式 | 工作区来源 | 路径规则 | 多会话共享 |
|---------|-----------|---------|-----------|
| **LOCAL** | 用户通过 Electron 目录选择器指定 | 客户端本地绝对路径 | ✅ 同一路径可创建多个会话 |
| **CLOUD** | 后端自动生成，客户端不可指定 | `{workspace-root}/{userId}/{sessionId}` | ❌ 每个会话独立目录 |

当前云端模式的设计初衷是**会话级隔离**：每个任务拥有独立沙箱，避免文件互相污染。实际上线后发现，用户经常在同一项目下开展多个任务（修 bug、写文档、代码审查等），每次都生成全新工作区导致：

- 无法复用已 clone 的代码仓库、已安装的依赖
- 无法在多个会话间共享项目上下文（文件、配置、`.mao/skills` 同步结果）
- 左侧任务列表所有云端会话堆在「云端工作区」单一分组下，缺乏项目维度组织

### 1.2 目标

在**避免大逻辑改动**的前提下，为云端模式增加**可选**的项目工作区能力：

1. **默认行为不变**：不指定项目时，仍为每会话自动生成隔离目录
2. **可选共享**：用户可指定项目名称，多个会话复用同一服务端目录
3. **复用现有链路**：`Session.workspace` 字段、工具执行、Skill 同步、文件引用等逻辑尽量不改
4. **安全可控**：项目目录严格限制在用户沙箱内，防止路径穿越


---

## 2. 现状代码分析（可复用能力）

好消息：**后端核心链路已支持按 `Session.workspace` 执行**，缺口主要在「云端自动隔离策略」和「前端未暴露选项」。

### 2.1 已有能力

```text
Session.workspace (VARCHAR 512)
    ↓
SessionService.createSession()
    → CLOUD 且 workspace 为空 → 自动生成 {root}/{userId}/{sessionId}
    → CLOUD 且 workspace 非空 → 直接使用（当前无校验！）
    ↓
PathSandbox.resolve(userPath, sessionWorkspace)
ToolDispatcher / ReadFile / Shell / SkillSyncService
    → 均以 session.workspace 为根目录
```

关键代码位置：

| 模块 | 文件 | 说明 |
|------|------|------|
| 会话创建 | `SessionService.java:105-115` | 仅 workspace 为空时自动生成 |
| 路径沙箱 | `PathSandbox.java` | 以 session workspace 为 root 解析相对路径 |
| Skill 同步 | `SkillSyncService.java` | 同步到 `{workspace}/.mao/skills/` |
| 文件列表 | `FileController.workspace-list` | 按 sessionId 推导 workspace |
| 前端创建 | `session.ts:createSession()` | 已传 `workspace` 字段 |
| 任务分组 | `TaskIndexPanel.vue:266-278` | CLOUD 全部归入 `key='CLOUD'` 单组 |

### 2.2 当前缺口

| 缺口 | 影响 |
|------|------|
| 前端 CLOUD 模式隐藏工作区选择 | 用户无法指定项目 |
| `TaskIndexPanel.onGroupNewTask` 刻意不传 CLOUD workspace | 分组内新建任务无法继承项目 |
| CLOUD 指定 workspace 时无服务端校验 | 存在安全隐患（可传入任意路径） |
| 任务列表 CLOUD 不按 workspace 分组 | 多项目时组织混乱 |

---

## 3. 核心设计：云端项目（Cloud Project）

### 3.1 概念模型

引入用户可理解的 **项目标识（project slug）**，由后端解析为服务端目录：

```text
workspace-root/                    # 配置项 app.harness.workspace-root
  └── {userId}/                    # 用户沙箱边界
        ├── {sessionId}/           # 默认：会话隔离目录（现有行为）
        └── projects/
              └── {slug}/          # 可选：命名项目目录（多个会话共享）
                    ├── .mao/skills/
                    └── <项目文件>
```

**路径规则**：

| 场景 | 客户端传入 | 服务端解析后的 `Session.workspace` |
|------|-----------|-----------------------------------|
| 默认（不指定项目） | 无 / 空 | `{root}/{userId}/{sessionId}` |
| 指定项目 | `cloudProjectKey: "my-app"` | `{root}/{userId}/projects/my-app` |

使用 `projects/` 子目录的原因：

- 避免项目 slug 与 `sessionId`（自增数字）路径冲突
- 一眼区分「隔离会话目录」与「命名项目目录」
- 现有已创建的 `{userId}/{sessionId}` 目录无需迁移

### 3.2 与 LOCAL 模式的字段语义区分

复用 `Session.workspace` 存储**服务端绝对路径**（与现有一致），通过执行模式区分入参语义：

| 模式 | 创建会话时 `workspace` 请求字段含义 | 存储值 |
|------|-----------------------------------|--------|
| LOCAL | 客户端本地绝对路径 | 原样存储，工具转发到 Electron |
| CLOUD | **不通过 workspace 字段传入**（避免混淆） | 由 `cloudProjectKey` 解析生成 |

建议新增专用请求字段 `cloudProjectKey`（可选），而不是让前端拼接服务端绝对路径。

### 3.3 projectKey 字段

`Session.projectKey` 已存在，当前由 `deriveProjectKey(workspace)` 取路径最后一段生成。

| workspace 路径 | projectKey |
|---------------|------------|
| `.../1/42`（隔离） | `42` |
| `.../1/projects/my-app`（共享） | `my-app` |

共享项目场景下，`projectKey` 自然成为项目展示名，可直接用于任务列表分组标签。

---

## 4. 接口设计

### 4.1 创建会话（变更）

`POST /api/v1/sessions`

在现有 `CreateSessionRequest` 上**新增可选字段**：

```json
{
  "agentId": 1,
  "executionMode": "CLOUD",
  "cloudProjectKey": "agent-workbench-mimo",
  "modelId": 2
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cloudProjectKey` | String | 否 | 云端项目名称，仅 `executionMode=CLOUD` 时生效 |
| `workspace` | String | 否 | **LOCAL 模式**使用；CLOUD 模式忽略此字段 |

**服务端解析逻辑**（`SessionService.createSession` 改造）：

```java
if ("CLOUD".equals(executionMode)) {
    if (cloudProjectKey != null && !cloudProjectKey.isBlank()) {
        String slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
        String path = pathSandbox.getWorkspaceRoot()
            .resolve(String.valueOf(userId))
            .resolve("projects")
            .resolve(slug)
            .toString();
        new File(path).mkdirs();
        session.setWorkspace(path);
        session.setProjectKey(slug);
    } else if (workspace == null || workspace.isBlank()) {
        // 保持现有逻辑：{userId}/{sessionId}
        ...
    }
}
```

### 4.2 路径校验（新增）

新增 `CloudWorkspaceResolver`（或扩展 `PathSandbox`）：

```java
public final class CloudWorkspaceResolver {
    private static final Pattern SLUG_PATTERN =
        Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$");

  // 保留字，避免与目录结构冲突
    private static final Set<String> RESERVED = Set.of("projects", "sessions");

    public static String normalizeAndValidate(String raw) { ... }

    public static void assertUnderUserSandbox(PathSandbox sandbox, Long userId, String workspace) {
        Path expectedPrefix = sandbox.getWorkspaceRoot().resolve(String.valueOf(userId));
        Path resolved = Paths.get(workspace).toAbsolutePath().normalize();
        if (!resolved.startsWith(expectedPrefix)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "工作区路径非法");
        }
    }
}
```

**slug 规则**：

- 长度 1–64
- 字符集：`[a-zA-Z0-9_-]`，首字符必须为字母或数字
- 不允许纯 `.` / `..`
- 保留字：`projects`、`sessions`（可扩展）

---

## 5. 前端设计

### 5.1 新建任务 UI（`ChatInput.vue`）

云端模式下，在模式选择器旁增加**可选**「项目」输入，而非本地目录选择器：

```text
┌─────────────────────────────────────────────────────────┐
│ [Agent 选择器]                                            │
│ (●) 云端模式  ( ) 本地模式    [项目: my-app ▼]  ← 可选   │
│                              留空 = 独立工作区             │
├─────────────────────────────────────────────────────────┤
│ 输入消息...                                               │
└─────────────────────────────────────────────────────────┘
```

交互说明：

| 元素 | 行为 |
|------|------|
| 项目输入框 | 可选填；留空则行为与现在完全一致 |
| 下拉建议 | 从 `sessionStore.sessions` 客户端聚合历史 `cloudProjectKey` |
| 新建项目 | 直接输入新 slug，首条消息发送时创建目录 |
| 本地模式 | 仍显示目录选择器，逻辑不变 |

**与 LOCAL 的区别**：云端选的是**项目名**，不是文件夹路径；不需要 Electron `selectDirectory`。

### 5.2 发送逻辑（`useChat.ts` / `session.ts`）

```typescript
await sessionStore.createSession(agentId, executionMode, workspace, env, modelId, permissionLevel, cloudProjectKey)
```

- `executionMode === 'LOCAL'` → 传 `workspace`（本地路径）
- `executionMode === 'CLOUD'` → 传 `cloudProjectKey`（可选），不传 `workspace`

### 5.3 任务列表分组（`TaskIndexPanel.vue`）

将 CLOUD 分组逻辑与 LOCAL 对齐：

```typescript
// 改造前
if (s.executionMode === 'CLOUD') {
  key = 'CLOUD'
}

// 改造后
if (s.executionMode === 'CLOUD') {
  if (s.workspace?.includes('/projects/')) {
    key = `CLOUD:${s.workspace}`
  } else {
    key = 'CLOUD:独立工作区'  // 或未指定项目的会话
  }
}
```

`formatGroupLabel`：

- `CLOUD:独立工作区` → 「云端 · 独立工作区」
- `CLOUD:/data/.../projects/my-app` → 「云端 · my-app」

### 5.4 分组内新建任务（`onGroupNewTask`）

```typescript
// 改造前：CLOUD 不传 workspace
workspace: last.executionMode === 'LOCAL' ? last.workspace : undefined,

// 改造后：继承 cloudProjectKey
cloudProjectKey: last.executionMode === 'CLOUD' && isSharedCloudProject(last)
  ? last.projectKey
  : undefined,
workspace: last.executionMode === 'LOCAL' ? last.workspace : undefined,
```

辅助函数 `isSharedCloudProject(session)`：`workspace` 包含 `/projects/` 即为共享项目。

### 5.5 工具栏工作区指示器（`ChatInput.vue`）

云端模式当前固定显示「云端工作区」，建议细化为：

- 独立工作区：「云端 · 独立」
- 共享项目：「云端 · {projectKey}」

---

## 6. 要做

### 6.1 后端

| 文件 | 改动 |
|------|------|
| `CloudWorkspaceResolver.java`（新增） | slug 校验 + 用户沙箱边界断言 |
| `SessionService.java` | 解析 `cloudProjectKey` → `{userId}/projects/{slug}`；未指定时保持 `{userId}/{sessionId}` |
| `SessionController.java` | `CreateSessionRequest` 增加可选字段 `cloudProjectKey` |

### 6.2 前端

| 文件 | 改动 |
|------|------|
| `ChatInput.vue` | CLOUD 模式增加可选项目输入/下拉；工具栏指示器区分「独立」与「{projectKey}」 |
| `session.ts` | `createSession` 增加 `cloudProjectKey` 参数并传给 API |
| `useChat.ts` | LOCAL 传 `workspace`，CLOUD 传 `cloudProjectKey`（可选） |
| `TaskIndexPanel.vue` | CLOUD 按项目分组；`onGroupNewTask` 继承共享项目的 `projectKey` |

历史项目下拉建议：从 `sessionStore.sessions` 客户端聚合（`workspace` 含 `/projects/` 的 distinct `projectKey`），无需新增 API。

### 6.3 行为与约束（一并交付）

- 默认不填项目名 → 行为与现网完全一致（per-session 隔离目录）
- 填写项目名 → 多会话共享 `{userId}/projects/{slug}`
- slug 非法或越界 → 400
- 删除会话不删除 workspace 目录（与现状一致）
- 数据库无需迁移；旧客户端不传 `cloudProjectKey` 不受影响

### 6.4 测试验收

1. CLOUD 不传 `cloudProjectKey` → workspace = `{userId}/{sessionId}`
2. 传 `cloudProjectKey` → workspace = `{userId}/projects/{slug}`，目录自动创建
3. 两个会话同一 `cloudProjectKey` → `workspace` 相同，文件可共享
4. 非法 slug（`../etc`、`a/b`、超长、保留字）→ 400
5. 跨用户目录隔离
6. ReadFile / WriteFile / Shell / Skill 同步在项目目录内正常
7. 任务列表分组正确；分组内新建继承项目
8. 旧客户端兼容

---

## 7. 不做

### 7.1 产品能力

| 项 | 说明 |
|----|------|
| 云端工作区映射本地目录 | LOCAL 模式职责 |
| 跨用户共享项目空间 | 沙箱按 `userId` 隔离 |
| 项目管理 CRUD | 无独立项目实体；无创建/删除/重命名项目 API |
| 删除会话时清理 workspace 目录 | 与现状一致，目录保留 |
| 项目目录清理/归档运维工具 | 超出本次范围 |
| 云端文件浏览器 | 见 `workspace-file-browser-design.md`，V2 范围 |
| 管理后台展示云端项目路径 | admin 无改动 |
| CLOUD 模式客户端传绝对路径 | 统一由 `cloudProjectKey` 解析，禁止直传 `workspace` |

### 7.2 接口与模块

| 项 | 说明 |
|----|------|
| `GET /sessions/cloud-projects` | 历史项目由前端从会话列表聚合 |
| `cloud_project` 数据表 | 复用 `session.workspace` / `session.project_key` |
| Flyway 迁移 | 无 schema 变更 |
| `NewTaskDialog.vue` | 已废弃，新建流程走 `ChatInput`，不改动 |
| `PathSandbox.resolve()` 额外边界校验 | `CloudWorkspaceResolver` 创建时已校验，防御纵深非必须 |

### 7.3 已有模块（保持不动）

以下模块已按 `Session.workspace` 工作，**无需修改**：

- `ToolDispatcher` / 各 Tool 实现
- `SkillSyncService`
- `ShellSessionManager`
- `StreamingWsHandler`
- `FileController.workspace-list`
- `PromptEngine`

---

## 8. 安全与隔离

### 8.1 用户沙箱边界

```text
合法路径必须满足：
  normalize(workspace).startsWith(normalize(workspace-root / userId /))
```

禁止：

- 客户端直接传入绝对路径指定 CLOUD workspace（统一由 `cloudProjectKey` 解析）
- slug 包含 `..`、`/`、`\`
- 访问其他 `userId` 目录

### 8.2 并发会话同项目

多个 CLOUD 会话共享同一 `projects/{slug}` 时：

| 风险 | 应对 |
|------|------|
| 同时写同一文件 | 与 LOCAL 多会话同目录一致，接受最终一致性；可在文档中提示用户避免并行修改同一文件 |
| Shell 会话 cwd 冲突 | 各会话 Shell 独立（`ShellSessionManager` 按 sessionId 隔离），cwd 默认均为同一 workspace root，行为合理 |
| Skill 同步竞争 | `SkillSyncService` 按 `agentId:workspace` 维护 syncState，同 workspace 共享状态，反而减少重复同步 |

### 8.3 删除会话

删除会话不删除 workspace 目录（与现状一致，见 §7 不做）。

---

## 9. 兼容性与迁移

| 项 | 说明 |
|----|------|
| 数据库 | **无需迁移**，复用 `workspace`、`project_key` 字段 |
| 存量会话 | 路径仍为 `{userId}/{sessionId}`，行为不变 |
| API 兼容 | `cloudProjectKey` 为新增可选字段，旧客户端不传则走原逻辑 |
| 配置 | 无新增配置项 |

---

## 10. 用户流程示例

### 10.1 首次围绕项目开展工作

```text
1. 新建任务 → 云端模式 → 项目填 "agent-workbench-mimo" → 发送首条消息
2. 后端创建 workspace: /opt/mao/data/workspace/1/projects/agent-workbench-mimo
3. Agent 在该目录执行 clone、读写文件、shell 等
4. Skill 同步到 .../agent-workbench-mimo/.mao/skills/
```

### 10.2 同项目第二个任务

```text
1. 左侧分组「云端 · agent-workbench-mimo」→ 点击分组内「新建」
2. 自动继承 cloudProjectKey = "agent-workbench-mimo"
3. 新会话复用同一目录，共享代码与配置
```

### 10.3 一次性临时任务（默认）

```text
1. 新建任务 → 云端模式 → 项目留空 → 发送
2. 后端创建 .../1/43（sessionId=43），与其他会话隔离
```

---

## 11. 方案对比（为何选此方案）

| 方案 | 改动量 | 优点 | 缺点 |
|------|--------|------|------|
| **A. cloudProjectKey → projects/{slug}（推荐）** | 小 | 语义清晰、安全、兼容好 | 需新增一个 API 字段 |
| B. 复用 workspace 传服务端绝对路径 | 最小 | 后端几乎不改 | 前端需知服务端路径，不安全、体验差 |
| C. 新建 cloud_project 表 | 大 | 完整项目管理 | 过度设计，与「避免大改」目标不符 |
| D. 取消自动隔离，全部改为必选项目 | 中 | 模型简单 | 破坏现有默认体验，强迫用户每次命名 |

---

## 12. 总结

本方案的核心思路是：**不改变「workspace 驱动工具执行」的现有架构**，仅在会话创建时增加一条可选分支——将用户输入的项目名解析为 `{userId}/projects/{slug}` 目录。默认仍为 per-session 隔离，指定项目后才进入共享模式。

整体改动见 §6 要做；§7 列出的能力与模块均不在本次范围内。核心执行路径（工具链、Skill 同步、WebSocket 等）无需重构。
