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
客户端发送 send_message
  → StreamingWsHandler.handleSendMessage()
    → [新增] 同步 Skills 到客户端工作区：
        1. 服务端发送 skill_sync 事件（含文件内容）到 streaming WS
        2. 客户端写入 .skills/ 目录
        3. 客户端发送 skill_sync_done 确认
        4. 服务端收到确认后继续
    → agentExecutor.submit(() -> {
        harnessService.executeFromEvent(...)
      })
```

### 4.2 WebSocket 消息协议

**服务端 → 客户端**（`skill_sync` 事件）：

```json
{
  "type": "skill_sync",
  "sessionId": 123,
  "data": {
    "skills": [
      {
        "name": "bigdata-cli",
        "files": [
          {
            "path": "SKILL.md",
            "content": "---\nname: bigdata-cli\n..."
          },
          {
            "path": "bin/bigdata-cli.js",
            "content": "#!/usr/bin/env node\n..."
          },
          {
            "path": "reference/meta.md",
            "content": "# 元数据操作..."
          }
        ]
      }
    ],
    "removed": ["old-skill-name"]
  }
}
```

**客户端 → 服务端**（确认消息，通过 streaming WS 发送）：

```json
{
  "type": "skill_sync_done",
  "sessionId": 123
}
```

### 4.3 服务端实现

在 `StreamingWsHandler.handleSendMessage()` 中，agentExecutor.submit 之前增加同步步骤：

```java
private void handleSendMessage(Long userId, JsonNode root) {
    // ... 原有校验逻辑 ...

    // 新增：LOCAL 模式下同步 Skills
    if ("LOCAL".equals(session.getExecutionMode())) {
        boolean synced = syncSkillsToClient(userId, sessionId, agent);
        if (!synced) {
            registry.send(userId, WsEvent.of("error", sessionId,
                Map.of("message", "Skill sync failed")));
            return;
        }
    }

    // 原有逻辑：提交到线程池执行
    agentExecutor.submit(() -> { ... });
}

private boolean syncSkillsToClient(Long userId, Long sessionId, Agent agent) {
    // 1. 收集需要同步的 Skills（文件内容）
    List<SkillSyncData> skills = skillSyncService.collectSkills(agent);
    List<String> removed = skillSyncService.getRemovedSkillNames(agent, sessionId);

    // 2. 通过 streaming WS 发送 skill_sync 事件
    CompletableFuture<Void> syncFuture = new CompletableFuture<>();
    pendingSkillSyncs.put(sessionId, syncFuture);
    registry.send(userId, WsEvent.of("skill_sync", sessionId,
        Map.of("skills", skills, "removed", removed)));

    // 3. 等待客户端确认（超时 30 秒）
    try {
        syncFuture.get(30, TimeUnit.SECONDS);
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

### 4.4 客户端实现（Electron main.cjs）

在 `ws.on('message')` 处理中新增 `skill_sync` 类型：

```javascript
case 'skill_sync': {
  const { skills, removed } = msg.data
  const skillsDir = path.join(currentWorkspace, '.skills')

  // 删除已移除的 Skills
  for (const name of (removed || [])) {
    const dir = path.join(skillsDir, name)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
  }

  // 写入 Skill 文件
  for (const skill of (skills || [])) {
    const skillDir = path.join(skillsDir, skill.name)
    fs.mkdirSync(skillDir, { recursive: true })
    for (const file of skill.files) {
      const filePath = path.join(skillDir, file.path)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, file.content, 'utf-8')
    }
  }

  // 确认完成
  wsClient.send(JSON.stringify({
    type: 'skill_sync_done',
    sessionId: msg.sessionId
  }))
  break
}
```

### 4.5 路径解析

客户端 `resolveWorkspacePath()` 已有逻辑：相对路径拼接 `currentWorkspace`。`.skills/bigdata-cli/SKILL.md` 会被正确解析为 `<workspace>/.skills/bigdata-cli/SKILL.md`。

## 5. 增量同步策略

### 5.1 服务端判断

`SkillSyncService` 维护每个 workspace 的同步状态：

```java
// sessionId → (skillName → lastSyncTime)
private final Map<Long, Map<String, Long>> syncState = new ConcurrentHashMap<>();
```

对比源目录的 `lastModified` 与上次同步时间：
- 新增：源目录存在但上次未同步 → 发送全部文件
- 更新：源目录 lastModified > lastSyncTime → 发送全部文件（简单策略，不做文件级 diff）
- 删除：上次同步过但源目录已不存在 → 加入 `removed` 列表
- 未变：跳过，不发送

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

`SkillLoader` 的职责保持不变（扫描源目录、解析 SKILL.md、缓存）。新增一个方法供 `SkillSyncService` 使用：

```java
/**
 * 读取指定 Skill 文件夹下的所有文件（递归），返回 path → content 映射。
 * 跳过隐藏文件（.DS_Store 等）和 node_modules。
 */
public Map<String, String> readSkillFiles(String skillName) { ... }
```

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
| `backend/.../harness/skill/SkillSyncService.java` | Skills 工作区同步核心逻辑 |

### 修改
| 文件 | 改动 |
|------|------|
| `backend/.../harness/skill/SkillLoader.java` | 新增 `readSkillFiles()` 方法 |
| `backend/.../harness/core/PromptEngine.java` | skill catalog 改用相对路径 |
| `backend/.../session/ws/StreamingWsHandler.java` | LOCAL 模式下发送 `skill_sync`、接收 `skill_sync_done` |
| `desktop/electron/main.cjs` | 新增 `skill_sync` 消息处理，写入 `.skills/` |

## 10. 限制与注意事项

1. **文件大小**：通过 WebSocket JSON 传输，单个 Skill 文件不宜过大（建议 < 1MB）。当前 bigdata-cli 的 JS/MD 文件均满足。
2. **二进制文件**：暂不支持 Skill 目录中的二进制文件（如图片、编译产物）。如后续需要，可改为 Base64 编码传输。
3. **并发安全**：同一 workspace 可能有多个 session 并发同步。通过文件系统的原子写入（先写临时文件再 rename）保证一致性。
4. **超时处理**：客户端 30 秒未确认 `skill_sync_done`，服务端中止本次执行并报错。
