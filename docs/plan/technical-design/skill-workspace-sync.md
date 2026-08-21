# Skills 工作区同步方案

## 1. 背景与问题

当前 Skill 文件存放在服务端外部目录（`app.harness.skills-dir`），由 `SkillLoader` 扫描加载。System prompt 中注入的是**服务端绝对路径**。

- **CLOUD 模式**：`read_file` 在服务端执行，可以正常读取。但路径是服务端绝对路径，耦合了部署环境。
- **LOCAL 模式**：`read_file` 通过 WebSocket 转发到客户端执行，客户端本地不存在这些文件，读取必然失败。

## 2. 核心思路

**统一路径模型**：Skills 同步到工作区的 `.skills/` 隐藏目录下，system prompt 注入**相对路径**（`.skills/<name>/SKILL.md`）。两种模式下 `read_file` 都读取工作区内的文件。

```
<workspace>/
  .skills/
    bigdata-cli/
      SKILL.md
      bin/bigdata-cli.js
      lib/...
      reference/...
    another-skill/
      SKILL.md
      ...
  <用户项目文件>
```

## 3. CLOUD 模式

### 3.1 流程

```
用户发送消息
  → StreamingWsHandler.handleSendMessage()
    → agentExecutor.submit(() -> {
        // 新增：同步 Skills 到工作区
        skillSyncService.syncToWorkspace(agent, workspace)
        // 原有逻辑
        harnessService.executeFromEvent(...)
      })
```

### 3.2 SkillSyncService（新增）

```java
@Component
public class SkillSyncService {

    // 从 app.harness.skills-dir 读取源 Skills
    // 按 agent.skillNames 过滤（为空则同步全部）
    // 逐个拷贝到 <workspace>/.skills/<skillName>/
    // 增量同步：对比目录最后修改时间，跳过未变化的
    public void syncToWorkspace(Agent agent, String workspace) { ... }

    // 将指定 Skills 打包为 zip 流（供 LOCAL 模式 REST 接口使用）
    public void writeSyncZip(Agent agent, OutputStream out) { ... }

    // 获取需要删除的 Skill 名称列表
    public List<String> getRemovedSkillNames(Agent agent, String workspace) { ... }

    // 会话结束或 Agent 切换时清理
    public void cleanWorkspace(String workspace) { ... }
}
```

### 3.3 PromptEngine 变更

```java
// 改前：注入服务端绝对路径
sb.append("  File: `").append(doc.getFilePath()).append("`");

// 改后：注入相对路径
sb.append("  File: `.skills/").append(doc.getName()).append("/SKILL.md`");
sb.append("  Folder: `.skills/").append(doc.getName()).append("`");
```

### 3.4 PathSandbox

无需改动。`.skills/` 在 workspace 内部，`PathSandbox.resolve()` 天然允许访问。

## 4. LOCAL 模式

### 4.1 流程

```
客户端发送 send_message（streaming WS）
  → StreamingWsHandler.handleSendMessage()
    → [新增] 通知客户端同步 Skills：
        1. 服务端通过 streaming WS 发送 skill_sync_required 事件
        2. 客户端 POST /v1/skills/sync-package?sessionId=X 下载 zip
        3. 客户端解压到 .skills/ 目录
        4. 客户端通过 streaming WS 发送 skill_sync_done
        5. 服务端收到确认后继续
    → agentExecutor.submit(() -> {
        harnessService.executeFromEvent(...)
      })
```

### 4.2 REST 接口：`POST /v1/skills/sync-package`

**Controller**：`SkillSyncController`（新增）

```java
@RestController
@RequestMapping("/v1/skills")
@RequiredArgsConstructor
public class SkillSyncController {

    private final SkillSyncService skillSyncService;
    private final SessionService sessionService;

    @PostMapping(value = "/sync-package", produces = "application/zip")
    public void downloadSyncPackage(
            @RequestParam Long sessionId,
            HttpServletResponse response) {
        Session session = sessionService.getSession(sessionId);
        Agent agent = agentService.getAgent(session.getAgentId());

        response.setStatus(HttpStatus.OK.value());
        response.setHeader("Content-Disposition",
            "attachment; filename=\"skills.zip\"");

        skillSyncService.writeSyncZip(agent, response.getOutputStream());
    }
}
```

**zip 包结构**：

```
skills.zip
  ├── .sync-manifest.json       ← 同步元信息（见 4.5）
  ├── bigdata-cli/
  │   ├── SKILL.md
  │   ├── bin/bigdata-cli.js
  │   ├── lib/...
  │   └── reference/...
  └── another-skill/
      ├── SKILL.md
      └── ...
```

### 4.3 WebSocket 消息协议

**服务端 → 客户端**（`skill_sync_required` 事件，通过 streaming WS）：

```json
{
  "type": "skill_sync_required",
  "sessionId": 123,
  "data": {
    "syncUrl": "/api/v1/skills/sync-package?sessionId=123",
    "removed": ["old-skill-name"]
  }
}
```

**客户端 → 服务端**（确认消息，通过 streaming WS）：

```json
{
  "type": "skill_sync_done",
  "sessionId": 123
}
```

### 4.4 服务端实现

`StreamingWsHandler.handleSendMessage()` 中，agentExecutor.submit 之前增加同步步骤：

```java
private void handleSendMessage(Long userId, JsonNode root) {
    // ... 原有校验逻辑 ...

    // 新增：LOCAL 模式下同步 Skills
    if ("LOCAL".equals(session.getExecutionMode())) {
        boolean synced = syncSkillsToClient(userId, sessionId, session);
        if (!synced) {
            registry.send(userId, WsEvent.of("error", sessionId,
                Map.of("message", "Skill sync failed")));
            return;
        }
    }

    // 原有逻辑：提交到线程池执行
    agentExecutor.submit(() -> { ... });
}

private boolean syncSkillsToClient(Long userId, Long sessionId, Session session) {
    // 1. 发送 skill_sync_required 事件，告知客户端下载地址
    String syncUrl = "/api/v1/skills/sync-package?sessionId=" + sessionId;
    List<String> removed = skillSyncService.getRemovedSkillNames(
        session.getAgentId(), session.getWorkspace());

    CompletableFuture<Void> syncFuture = new CompletableFuture<>();
    pendingSkillSyncs.put(sessionId, syncFuture);
    registry.send(userId, WsEvent.of("skill_sync_required", sessionId,
        Map.of("syncUrl", syncUrl, "removed", removed)));

    // 2. 等待客户端确认（超时 60 秒，zip 下载 + 解压需要时间）
    try {
        syncFuture.get(60, TimeUnit.SECONDS);
        return true;
    } catch (Exception e) {
        log.warn("Skill sync timeout for session {}", sessionId);
        return false;
    } finally {
        pendingSkillSyncs.remove(sessionId);
    }
}
```

收到客户端 `skill_sync_done` 时：

```java
case "skill_sync_done" -> {
    CompletableFuture<Void> future = pendingSkillSyncs.get(sessionId);
    if (future != null) future.complete(null);
}
```

### 4.5 客户端实现（Electron main.cjs）

在 `ws.on('message')` 处理中新增 `skill_sync_required` 类型：

```javascript
case 'skill_sync_required': {
  const { syncUrl, removed } = msg.data
  const sessionId = msg.sessionId

  // 异步执行：下载 zip → 解压 → 确认
  handleSkillSync(sessionId, syncUrl, removed).catch(err => {
    console.error('Skill sync failed:', err)
  })
  break
}
```

新增 `handleSkillSync` 函数：

```javascript
async function handleSkillSync(sessionId, syncUrl, removed) {
  const skillsDir = path.join(currentWorkspace, '.skills')

  // 1. 删除已移除的 Skills
  for (const name of (removed || [])) {
    const dir = path.join(skillsDir, name)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
  }

  // 2. 下载 zip 包
  const baseUrl = getApiBaseUrl()  // 复用项目的 API 基础地址
  const token = getAuthToken()     // 从 store 或 localStorage 获取 JWT
  const response = await fetch(`${baseUrl}${syncUrl}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })

  if (!response.ok) {
    throw new Error(`Skill sync download failed: ${response.status}`)
  }

  // 3. 解压到 .skills/ 目录
  const zipBuffer = Buffer.from(await response.arrayBuffer())
  await extractZip(zipBuffer, skillsDir)

  // 4. 通知服务端同步完成
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({
      type: 'skill_sync_done',
      sessionId
    }))
  }
}
```

新增 `extractZip` 函数（使用 `adm-zip`，Electron 项目已有 Node 环境）：

```javascript
const AdmZip = require('adm-zip')

async function extractZip(zipBuffer, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const zip = new AdmZip(zipBuffer)
  zip.extractAllTo(targetDir, true)  // true = overwrite
}
```

> 注：`adm-zip` 需加入 `desktop/package.json` 的 dependencies。也可选用 `yauzl`（流式解压，内存更友好），但 `adm-zip` API 更简单。

### 4.6 同步元信息（.sync-manifest.json）

zip 包内包含 `.sync-manifest.json`，记录本次同步的元信息：

```json
{
  "syncedAt": "2026-05-31T10:00:00Z",
  "agentId": 42,
  "skills": [
    { "name": "bigdata-cli", "version": "20260531-100000" },
    { "name": "another-skill", "version": "20260531-100000" }
  ]
}
```

用途：
- 客户端可读取此文件判断当前 Skills 版本
- 后续支持增量同步时，客户端可将此版本号回传服务端做对比

### 4.7 路径解析

客户端 `resolveWorkspacePath()` 已有逻辑：相对路径拼接 `currentWorkspace`。`.skills/bigdata-cli/SKILL.md` 会被正确解析为 `<workspace>/.skills/bigdata-cli/SKILL.md`。

## 5. 增量同步策略

### 5.1 服务端判断

`SkillSyncService` 维护每个 workspace 的同步状态：

```java
// "agentId:workspace" → (skillName → lastSyncTime)
private final Map<String, Map<String, Long>> syncState = new ConcurrentHashMap<>();
```

对比源目录的 `lastModified` 与上次同步时间：
- 新增：源目录存在但上次未同步 → 包含在 zip 中
- 更新：源目录 lastModified > lastSyncTime → 包含在 zip 中
- 删除：上次同步过但源目录已不存在 → 加入 `removed` 列表
- 未变：跳过，不包含在 zip 中

### 5.2 首次同步

首次同步发送全部文件，无增量逻辑。

## 6. System Prompt 注入变更

`PromptEngine.buildSystemPrompt()` 中，skill catalog 改为使用相对路径：

```java
sb.append("- **").append(doc.getName()).append("**: ");
sb.append(doc.getDescription());
sb.append("\n  Folder: `.skills/").append(doc.getName()).append("`");
sb.append("\n  File: `.skills/").append(doc.getName()).append("/SKILL.md`");
sb.append("\n  To learn more, read: `.skills/").append(doc.getName()).append("/SKILL.md`");
```

Agent 通过 `read_file` 读取 `.skills/<name>/SKILL.md` 获取完整内容，以及 `.skills/<name>/reference/*.md` 等附属文件。

## 7. SkillLoader 变更

`SkillLoader` 的职责保持不变（扫描源目录、解析 SKILL.md、缓存）。新增方法供 `SkillSyncService` 使用：

```java
/**
 * 获取指定 Skill 的文件夹路径。
 */
public Path getSkillFolder(String skillName) { ... }

/**
 * 获取所有已加载 Skill 的名称集合。
 */
public Set<String> getAllNames() { ... }
```

`SkillSyncService` 直接读取文件系统打包 zip，不需要 `SkillLoader` 额外提供文件内容读取方法。

## 8. 清理机制

| 触发时机 | 动作 |
|---------|------|
| Session 删除 | `SkillSyncService.cleanWorkspace(workspace)` 删除 `.skills/` 目录 |
| Agent 切换（同一 workspace） | 增量同步自动处理：删除旧 Skill、添加新 Skill |
| 服务端重启 | CLOUD 模式下次 execute 时重新同步；LOCAL 模式客户端保留文件，下次消息时增量更新 |

## 9. 改动文件清单

### 新增
| 文件 | 说明 |
|------|------|
| `backend/.../harness/skill/SkillSyncService.java` | Skills 工作区同步核心逻辑（CLOUD 拷贝 + LOCAL zip 打包） |
| `backend/.../skill/controller/SkillSyncController.java` | REST 接口 `POST /v1/skills/sync-package` |

### 修改
| 文件 | 改动 |
|------|------|
| `backend/.../harness/skill/SkillLoader.java` | 新增 `getSkillFolder()` 方法 |
| `backend/.../harness/core/PromptEngine.java` | skill catalog 改用相对路径 |
| `backend/.../session/ws/StreamingWsHandler.java` | LOCAL 模式下发送 `skill_sync_required`、接收 `skill_sync_done` |
| `desktop/electron/main.cjs` | 新增 `skill_sync_required` 处理：下载 zip → 解压 → 确认 |
| `desktop/package.json` | 新增 `adm-zip` 依赖 |

## 10. 限制与注意事项

1. **zip 包大小**：流式打包，不落盘，内存占用可控。单个 Skill 目录建议 < 50MB（含 node_modules 等）。
2. **二进制文件**：zip 天然支持二进制，无限制。
3. **并发安全**：同一 workspace 可能有多个 session 并发同步。CLOUD 模式通过文件系统原子写入保证一致；LOCAL 模式 zip 解压是覆盖写入，后写入者生效。
4. **超时处理**：客户端 60 秒未完成下载 + 解压 + 确认，服务端中止本次执行并报错。
5. **认证**：REST 接口需复用现有 JWT 认证机制，客户端请求时携带 `Authorization` header。

> 注：本文档描述的 `.skills/` 工作区路径为早期方案。当前实现改为使用会话运行时目录
> （CLOUD：`{runtime-dir}/{userId}/{sessionId}/skills/`；LOCAL：`~/.mao/runtime/{sessionId}/skills/`），
> 详见 `RuntimeDataResolver` 与 `PromptEngine.buildSkillCatalog()`。整体同步流程（`skill_sync_required`/`skill_sync_done`）保持一致。

## 11. LOCAL 模式：本地未上传 Skill 直接可用（无需上传）

### 11.1 背景

桌面端「技能管理」抽屉的「本地未上传」Tab 会扫描 `~/.agents/skills` 下的 Skill 目录，但此前必须先上传到服务端（写入 `user-skills-dir`）才能被 Agent 使用——即便是 LOCAL 模式任务，工具执行本就委托给桌面端 Electron 执行，理论上完全可以直接读取本地文件，无需先上传一份到服务端。

### 11.2 方案

LOCAL 模式下，`read_file` 等工具本就通过 `LocalToolExecutor` 委托给桌面端执行，路径解析（`resolveWorkspacePath`）支持任意 `~` 前缀的绝对路径。因此只需：

1. 桌面端在 LOCAL 模式下发送 `send_message` / `edit_and_resend` 时，附带当前扫描到的本地未上传 Skill 列表（`{name, description, folderName}`），随消息一起上报。
2. 服务端 `LocalSkillRegistry`（内存态，按 `sessionId` 存储）接收上报，`HarnessService.buildContext()` 将其与系统 Skill、已上传的用户 Skill 合并（系统/已上传优先，避免同名冲突）。
3. `PromptEngine.buildSkillCatalog()` 对这些「本地未同步」Skill 使用桌面端本机路径 `~/.agents/skills/{folderName}/SKILL.md`（而不是 runtime 目录路径），并在描述中注明「本地未同步，仅本次本地任务可用」。
4. Agent 调用 `read_file` 读取该路径时，桌面端 Electron 直接从 `~/.agents/skills/{folderName}/SKILL.md` 读取，无需任何服务端同步（不生成 `.sync-manifest.json`、不打包 zip）。

若用户希望在 **CLOUD 模式**任务中使用这些 Skill，仍需按原流程上传（`POST /user-skills/upload`），因为 CLOUD 模式下工具在服务端执行，服务端磁盘上必须存在对应文件。

### 11.3 关键改动

| 文件 | 改动 |
|------|------|
| `backend/.../harness/skill/LocalSkillRef.java`（新增） | 本地未上传 Skill 的引用 POJO：`name`/`description`/`folderName` |
| `backend/.../harness/skill/LocalSkillRegistry.java`（新增） | 内存态会话级登记表，按 `sessionId` 存储桌面端上报的本地 Skill 列表 |
| `backend/.../harness/runtime/RuntimeDataResolver.java` | 新增 `formatLocalUnsyncedSkillsDir/Path()`，格式化 `~/.agents/skills/{folderName}` 路径 |
| `backend/.../harness/core/AgentExecutionContext.java` | 新增 `localUnsyncedSkills` 字段 |
| `backend/.../harness/core/HarnessService.java` | `buildContext()` 合并本地未同步 Skill（不覆盖系统/已上传同名 Skill） |
| `backend/.../harness/core/PromptEngine.java` | Skill catalog 对本地未同步 Skill 使用本机路径并附加提示；`${skill}$` 标记识别新增本地未同步 Skill |
| `backend/.../session/ws/StreamingWsHandler.java` | `send_message`/`edit_and_resend`/`create_side_session` 解析 `data.localSkills`，写入 `LocalSkillRegistry`（按各自的 `sessionId`，Side Task 用其子会话 ID）；执行结束后清理 |
| `desktop/src/composables/useStreamWS.ts` | `sendMessage`/`sendEditMessage`/`createSideSession` 新增可选 `localSkills` 参数 |
| `desktop/src/utils/localSkills.ts`（新增） | `collectLocalUnsyncedSkills()` 共享工具函数，供主聊天与 Side Task 共用 |
| `desktop/src/composables/useChat.ts` | LOCAL 模式发送/编辑消息前调用共享工具收集本地未上传 Skill 并随消息上报 |
| `desktop/src/components/chat/SideChatPanel.vue` | Side Task 首条消息（`createSideSession`）与后续消息（`sendMessage`）均收集并上报本地未上传 Skill |
| `desktop/src/components/chat/ChatInput.vue` | 快捷指令面板（`/`）合并本地未上传 Skill，便于插入 `${skill}$` 标记 |
| `desktop/src/components/skill/SkillDrawer.vue` | 「本地未上传」Tab 提示文案，说明可直接用于本地任务 |

### 11.4 限制

- 仅覆盖 `send_message` / `edit_and_resend` / `create_side_session` 三个消息发送路径；消息队列自动消费（`enqueue_message` 自动出队）复用会话上一次上报的快照，不会重新扫描。
- 本地未同步 Skill 的上报为内存态、按 `sessionId` 覆盖式存储，服务重启后丢失（与现有 `SkillSyncService.syncState` 一致的设计取舍）。
- Side Task 创建时（`handleCreateSideSession`）新增 LOCAL 模式桌面端连接性校验：未连接直接返回错误、不创建子会话，避免创建后才发现无法执行工具。
